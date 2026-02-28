/**
 * Unit tests for TaskStore
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskStore } from '../TaskStore';
import type { StorageProvider } from '../../storage/StorageProvider';

/**
 * Create a minimal mock StorageProvider
 */
function createMockStorage(): StorageProvider {
  const store = new Map<string, any>();

  return {
    get: vi.fn(async (_collection: string, key: string) => {
      return store.get(key) ?? null;
    }),
    set: vi.fn(async (_collection: string, key: string, value: any) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (_collection: string, key: string) => {
      store.delete(key);
    }),
    // Unused methods — stub them
    initialize: vi.fn(),
    close: vi.fn(),
    getMany: vi.fn(),
    setMany: vi.fn(),
    deleteMany: vi.fn(),
    list: vi.fn(),
    query: vi.fn(),
    count: vi.fn(),
    transaction: vi.fn(),
    clear: vi.fn(),
    vacuum: vi.fn(),
  } as unknown as StorageProvider;
}

describe('TaskStore', () => {
  let storage: StorageProvider;
  let taskStore: TaskStore;
  const SESSION_ID = 'test-session-1';

  beforeEach(() => {
    storage = createMockStorage();
    taskStore = new TaskStore(storage);
  });

  // ── createPlan ──────────────────────────────────────────────────────

  describe('createPlan', () => {
    it('creates tasks with auto-increment IDs', async () => {
      const result = await taskStore.createPlan(SESSION_ID, {
        plan_summary: 'Test plan',
        tasks: [
          { subject: 'Task A', task_description: 'Do A' },
          { subject: 'Task B', task_description: 'Do B' },
          { subject: 'Task C', task_description: 'Do C' },
        ],
      });

      expect(result.tasks).toHaveLength(3);
      expect(result.tasks[0].id).toBe('1');
      expect(result.tasks[1].id).toBe('2');
      expect(result.tasks[2].id).toBe('3');
      expect(result.tasks[0].subject).toBe('Task A');
      expect(result.tasks[0].status).toBe('pending');
      expect(result.tasks[0].blocks).toEqual([]);
      expect(result.tasks[0].blockedBy).toEqual([]);
    });

    it('continues counter on plan replacement', async () => {
      // First plan: tasks 1-3
      await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'Old A', task_description: 'Do A' },
          { subject: 'Old B', task_description: 'Do B' },
          { subject: 'Old C', task_description: 'Do C' },
        ],
      });

      // Second plan: tasks 4-5
      const result = await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'New X', task_description: 'Do X' },
          { subject: 'New Y', task_description: 'Do Y' },
        ],
      });

      expect(result.tasks[0].id).toBe('4');
      expect(result.tasks[1].id).toBe('5');
    });

    it('replaces old tasks completely', async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [{ subject: 'Old', task_description: 'Old desc' }],
      });

      const result = await taskStore.createPlan(SESSION_ID, {
        tasks: [{ subject: 'New', task_description: 'New desc' }],
      });

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].subject).toBe('New');

      // Old task should not be found
      const oldTask = await taskStore.get(SESSION_ID, '1');
      expect(oldTask).toBeNull();
    });

    it('stores plan_summary and plan_detail', async () => {
      await taskStore.createPlan(SESSION_ID, {
        plan_summary: 'My summary',
        plan_detail: 'My detailed strategy',
        tasks: [{ subject: 'Task', task_description: 'Desc' }],
      });

      const plan = await taskStore.getPlan(SESSION_ID);
      expect(plan.plan_summary).toBe('My summary');
      expect(plan.plan_detail).toBe('My detailed strategy');
    });

    it('returns allTasks as summaries', async () => {
      const result = await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'A', task_description: 'Do A' },
          { subject: 'B', task_description: 'Do B' },
        ],
      });

      expect(result.allTasks).toHaveLength(2);
      expect(result.allTasks[0]).toEqual({
        id: '1',
        subject: 'A',
        status: 'pending',
        owner: undefined,
        blockedBy: [],
      });
    });

    it('preserves activeForm on tasks', async () => {
      const result = await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'Task', task_description: 'Desc', activeForm: 'Working on task' },
        ],
      });

      expect(result.tasks[0].activeForm).toBe('Working on task');
    });
  });

  // ── get ─────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns task by ID', async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'Task A', task_description: 'Description A' },
          { subject: 'Task B', task_description: 'Description B' },
        ],
      });

      const task = await taskStore.get(SESSION_ID, '2');
      expect(task).not.toBeNull();
      expect(task!.subject).toBe('Task B');
      expect(task!.task_description).toBe('Description B');
    });

    it('returns null for non-existent task', async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [{ subject: 'Task', task_description: 'Desc' }],
      });

      const task = await taskStore.get(SESSION_ID, '999');
      expect(task).toBeNull();
    });

    it('returns null for empty session', async () => {
      const task = await taskStore.get(SESSION_ID, '1');
      expect(task).toBeNull();
    });
  });

  // ── update ──────────────────────────────────────────────────────────

  describe('update', () => {
    beforeEach(async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'Task A', task_description: 'Desc A', activeForm: 'Doing A' },
          { subject: 'Task B', task_description: 'Desc B' },
          { subject: 'Task C', task_description: 'Desc C' },
        ],
      });
    });

    it('updates task status', async () => {
      const result = await taskStore.update(SESSION_ID, '1', {
        status: 'in_progress',
      });

      expect(result.task.status).toBe('in_progress');
      expect(result.task.id).toBe('1');
    });

    it('updates subject and task_description', async () => {
      const result = await taskStore.update(SESSION_ID, '1', {
        subject: 'Updated subject',
        task_description: 'Updated desc',
      });

      expect(result.task.subject).toBe('Updated subject');
      expect(result.task.task_description).toBe('Updated desc');
    });

    it('updates activeForm and owner', async () => {
      const result = await taskStore.update(SESSION_ID, '1', {
        activeForm: 'New form',
        owner: 'agent-1',
      });

      expect(result.task.activeForm).toBe('New form');
      expect(result.task.owner).toBe('agent-1');
    });

    it('merges metadata (null deletes key)', async () => {
      // Set initial metadata
      await taskStore.update(SESSION_ID, '1', {
        metadata: { priority: 'high', assignee: 'bot' },
      });

      // Merge: delete assignee, add deadline
      const result = await taskStore.update(SESSION_ID, '1', {
        metadata: { assignee: null, deadline: 'tomorrow' },
      });

      expect(result.task.metadata).toEqual({
        priority: 'high',
        deadline: 'tomorrow',
      });
    });

    it('throws for non-existent task', async () => {
      await expect(
        taskStore.update(SESSION_ID, '999', { status: 'completed' }),
      ).rejects.toThrow('Task not found: 999');
    });

    it('returns allTasks summaries', async () => {
      const result = await taskStore.update(SESSION_ID, '1', {
        status: 'in_progress',
      });

      expect(result.allTasks).toHaveLength(3);
      expect(result.allTasks[0].status).toBe('in_progress');
    });
  });

  // ── list ────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns all non-deleted tasks as summaries', async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'A', task_description: 'Do A' },
          { subject: 'B', task_description: 'Do B' },
          { subject: 'C', task_description: 'Do C' },
        ],
      });

      await taskStore.update(SESSION_ID, '2', { status: 'deleted' });

      const list = await taskStore.list(SESSION_ID);
      expect(list).toHaveLength(2);
      expect(list.map((t) => t.id)).toEqual(['1', '3']);
    });

    it('filters blockedBy to open tasks only', async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'A', task_description: 'Do A' },
          { subject: 'B', task_description: 'Do B' },
          { subject: 'C', task_description: 'Do C' },
        ],
      });

      // C is blocked by A and B
      await taskStore.update(SESSION_ID, '3', { addBlockedBy: ['1', '2'] });

      // Complete A
      await taskStore.update(SESSION_ID, '1', { status: 'completed' });

      const list = await taskStore.list(SESSION_ID);
      const taskC = list.find((t) => t.id === '3');
      // Only B should remain as blocker (A is completed)
      expect(taskC!.blockedBy).toEqual(['2']);
    });

    it('returns empty array for empty session', async () => {
      const list = await taskStore.list(SESSION_ID);
      expect(list).toEqual([]);
    });
  });

  // ── getPlan ─────────────────────────────────────────────────────────

  describe('getPlan', () => {
    it('returns plan_summary, plan_detail, and tasks', async () => {
      await taskStore.createPlan(SESSION_ID, {
        plan_summary: 'My plan',
        plan_detail: 'My strategy',
        tasks: [
          { subject: 'A', task_description: 'Do A' },
          { subject: 'B', task_description: 'Do B' },
        ],
      });

      const plan = await taskStore.getPlan(SESSION_ID);
      expect(plan.plan_summary).toBe('My plan');
      expect(plan.plan_detail).toBe('My strategy');
      expect(plan.tasks).toHaveLength(2);
    });

    it('returns empty tasks for empty session', async () => {
      const plan = await taskStore.getPlan(SESSION_ID);
      expect(plan.plan_summary).toBeUndefined();
      expect(plan.plan_detail).toBeUndefined();
      expect(plan.tasks).toEqual([]);
    });
  });

  // ── Dependencies ────────────────────────────────────────────────────

  describe('dependencies', () => {
    beforeEach(async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'A', task_description: 'Do A' },
          { subject: 'B', task_description: 'Do B' },
          { subject: 'C', task_description: 'Do C' },
        ],
      });
    });

    it('creates bidirectional edges with addBlockedBy', async () => {
      await taskStore.update(SESSION_ID, '3', { addBlockedBy: ['1'] });

      const taskC = await taskStore.get(SESSION_ID, '3');
      const taskA = await taskStore.get(SESSION_ID, '1');

      expect(taskC!.blockedBy).toContain('1');
      expect(taskA!.blocks).toContain('3');
    });

    it('creates bidirectional edges with addBlocks', async () => {
      await taskStore.update(SESSION_ID, '1', { addBlocks: ['3'] });

      const taskA = await taskStore.get(SESSION_ID, '1');
      const taskC = await taskStore.get(SESSION_ID, '3');

      expect(taskA!.blocks).toContain('3');
      expect(taskC!.blockedBy).toContain('1');
    });

    it('auto-unblocks when blocking task completes', async () => {
      // Set up: C blocked by A
      await taskStore.update(SESSION_ID, '3', { addBlockedBy: ['1'] });

      // Complete A
      await taskStore.update(SESSION_ID, '1', { status: 'completed' });

      const taskC = await taskStore.get(SESSION_ID, '3');
      expect(taskC!.blockedBy).not.toContain('1');
    });

    it('auto-unblocks when blocking task is deleted', async () => {
      await taskStore.update(SESSION_ID, '3', { addBlockedBy: ['1'] });
      await taskStore.update(SESSION_ID, '1', { status: 'deleted' });

      const taskC = await taskStore.get(SESSION_ID, '3');
      expect(taskC!.blockedBy).not.toContain('1');
    });

    it('detects direct cycle (self-loop)', async () => {
      await expect(
        taskStore.update(SESSION_ID, '1', { addBlockedBy: ['1'] }),
      ).rejects.toThrow('Cycle detected');
    });

    it('detects indirect cycle (A→B→C→A)', async () => {
      // A blocks B
      await taskStore.update(SESSION_ID, '2', { addBlockedBy: ['1'] });
      // B blocks C
      await taskStore.update(SESSION_ID, '3', { addBlockedBy: ['2'] });

      // Trying to make C block A should fail (cycle: A→B→C→A)
      await expect(
        taskStore.update(SESSION_ID, '1', { addBlockedBy: ['3'] }),
      ).rejects.toThrow('Cycle detected');
    });

    it('allows non-cyclic dependencies', async () => {
      // A blocks B, A blocks C (diamond is fine)
      await taskStore.update(SESSION_ID, '2', { addBlockedBy: ['1'] });
      await taskStore.update(SESSION_ID, '3', { addBlockedBy: ['1'] });

      const taskA = await taskStore.get(SESSION_ID, '1');
      expect(taskA!.blocks).toContain('2');
      expect(taskA!.blocks).toContain('3');
    });

    it('does not add duplicate edges', async () => {
      await taskStore.update(SESSION_ID, '3', { addBlockedBy: ['1'] });
      await taskStore.update(SESSION_ID, '3', { addBlockedBy: ['1'] });

      const taskC = await taskStore.get(SESSION_ID, '3');
      const taskA = await taskStore.get(SESSION_ID, '1');

      expect(taskC!.blockedBy.filter((id) => id === '1')).toHaveLength(1);
      expect(taskA!.blocks.filter((id) => id === '3')).toHaveLength(1);
    });

    it('throws for non-existent blocker task', async () => {
      await expect(
        taskStore.update(SESSION_ID, '1', { addBlockedBy: ['999'] }),
      ).rejects.toThrow('Task not found: 999');
    });

    it('throws for non-existent blocked task', async () => {
      await expect(
        taskStore.update(SESSION_ID, '1', { addBlocks: ['999'] }),
      ).rejects.toThrow('Task not found: 999');
    });
  });

  // ── get (deleted tasks) ─────────────────────────────────────────────

  describe('get (deleted tasks)', () => {
    it('returns null for deleted task', async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'A', task_description: 'Do A' },
          { subject: 'B', task_description: 'Do B' },
        ],
      });

      await taskStore.update(SESSION_ID, '1', { status: 'deleted' });

      const task = await taskStore.get(SESSION_ID, '1');
      expect(task).toBeNull();
    });
  });

  // ── update (no-op and edge cases) ─────────────────────────────────

  describe('update (edge cases)', () => {
    beforeEach(async () => {
      await taskStore.createPlan(SESSION_ID, {
        tasks: [
          { subject: 'A', task_description: 'Do A' },
          { subject: 'B', task_description: 'Do B' },
        ],
      });
    });

    it('succeeds with empty updates (no-op)', async () => {
      const result = await taskStore.update(SESSION_ID, '1', {});

      expect(result.task.id).toBe('1');
      expect(result.task.subject).toBe('A');
      expect(result.task.status).toBe('pending');
    });

    it('clears completed task blocks array after auto-unblock', async () => {
      // A blocks B
      await taskStore.update(SESSION_ID, '1', { addBlocks: ['2'] });

      const beforeComplete = await taskStore.get(SESSION_ID, '1');
      expect(beforeComplete!.blocks).toContain('2');

      // Complete A — should auto-unblock B and clear A's blocks
      await taskStore.update(SESSION_ID, '1', { status: 'completed' });

      const afterComplete = await taskStore.get(SESSION_ID, '1');
      expect(afterComplete!.blocks).toEqual([]);

      const taskB = await taskStore.get(SESSION_ID, '2');
      expect(taskB!.blockedBy).toEqual([]);
    });
  });

  // ── Multi-session isolation ───────────────────────────────────────

  describe('multi-session isolation', () => {
    it('keeps sessions independent', async () => {
      const SESSION_A = 'session-a';
      const SESSION_B = 'session-b';

      await taskStore.createPlan(SESSION_A, {
        tasks: [{ subject: 'A task', task_description: 'For A' }],
      });

      await taskStore.createPlan(SESSION_B, {
        tasks: [
          { subject: 'B task 1', task_description: 'For B' },
          { subject: 'B task 2', task_description: 'For B' },
        ],
      });

      const listA = await taskStore.list(SESSION_A);
      const listB = await taskStore.list(SESSION_B);

      expect(listA).toHaveLength(1);
      expect(listA[0].subject).toBe('A task');

      expect(listB).toHaveLength(2);
      expect(listB[0].subject).toBe('B task 1');
    });

    it('does not return tasks from other sessions via get()', async () => {
      await taskStore.createPlan('session-x', {
        tasks: [{ subject: 'X task', task_description: 'For X' }],
      });

      // Task ID '1' exists in session-x but not session-y
      const task = await taskStore.get('session-y', '1');
      expect(task).toBeNull();
    });
  });

  // ── Empty session defaults ──────────────────────────────────────────

  describe('empty session', () => {
    it('load returns default blob', async () => {
      const list = await taskStore.list(SESSION_ID);
      expect(list).toEqual([]);

      const plan = await taskStore.getPlan(SESSION_ID);
      expect(plan.tasks).toEqual([]);
    });
  });
});
