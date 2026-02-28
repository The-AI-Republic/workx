/**
 * Unit tests for PlanningTool (V2 — command-based persistent task management)
 *
 * Tests all 5 commands, validation rules, _taskEvent emission, and session ID injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanningTool } from '../PlanningTool';
import { TaskStore } from '../../core/taskmanager/TaskStore';
import type { StorageProvider } from '../../core/storage/StorageProvider';

/**
 * Create a minimal mock StorageProvider backed by an in-memory Map
 */
function createMockStorage(): StorageProvider {
  const store = new Map<string, any>();

  return {
    get: vi.fn(async (_collection: string, key: string) => store.get(key) ?? null),
    set: vi.fn(async (_collection: string, key: string, value: any) => { store.set(key, value); }),
    delete: vi.fn(async (_collection: string, key: string) => { store.delete(key); }),
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

const SESSION_ID = 'test-session';
const withSession = { metadata: { sessionId: SESSION_ID } };

describe('PlanningTool', () => {
  let tool: PlanningTool;
  let taskStore: TaskStore;

  beforeEach(() => {
    const storage = createMockStorage();
    taskStore = new TaskStore(storage);
    tool = new PlanningTool(taskStore);
  });

  // ── Tool definition ─────────────────────────────────────────────────

  describe('getDefinition()', () => {
    it('returns a function tool with name planning_tool', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
      if (def.type === 'function') {
        expect(def.function.name).toBe('planning_tool');
      }
    });

    it('requires command parameter', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        expect(def.function.parameters.required).toContain('command');
      }
    });

    it('has version 2.0.0', () => {
      const def = tool.getDefinition() as any;
      expect(def.version).toBe('2.0.0');
    });
  });

  // ── No session context ──────────────────────────────────────────────

  describe('missing session context', () => {
    it('returns error when no sessionId in metadata', async () => {
      const result = await tool.execute({ command: 'list' });
      expect(result.success).toBe(true); // BaseTool wraps
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('No session context');
    });
  });

  // ── Invalid command ─────────────────────────────────────────────────

  describe('invalid command', () => {
    it('returns error for unknown command', async () => {
      const result = await tool.execute({ command: 'invalid_cmd' }, withSession);
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain("Invalid command 'invalid_cmd'");
    });
  });

  // ── plan command ────────────────────────────────────────────────────

  describe('plan command', () => {
    it('creates tasks and returns taskIds', async () => {
      const result = await tool.execute(
        {
          command: 'plan',
          plan_summary: 'Test plan',
          plan_detail: 'Strategy here',
          tasks: [
            { subject: 'Task A', task_description: 'Do A', activeForm: 'Doing A' },
            { subject: 'Task B', task_description: 'Do B' },
          ],
        },
        withSession,
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.taskIds).toEqual(['1', '2']);
      expect(result.data.tasks).toHaveLength(2);
      expect(result.data.message).toContain('2 tasks');
    });

    it('includes _taskEvent for TurnManager', async () => {
      const result = await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'Task', task_description: 'Desc' }],
        },
        withSession,
      );

      expect(result.data._taskEvent).toBeDefined();
      expect(result.data._taskEvent.eventType).toBe('plan_created');
      expect(result.data._taskEvent.allTasks).toHaveLength(1);
    });

    it('rejects empty tasks array', async () => {
      const result = await tool.execute(
        { command: 'plan', tasks: [] },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('non-empty tasks array');
    });

    it('rejects missing tasks', async () => {
      const result = await tool.execute(
        { command: 'plan' },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('non-empty tasks array');
    });

    it('rejects task with missing subject', async () => {
      const result = await tool.execute(
        {
          command: 'plan',
          tasks: [{ task_description: 'Desc' }],
        },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('subject');
    });

    it('rejects task with missing task_description', async () => {
      const result = await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'Task' }],
        },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('task_description');
    });
  });

  // ── update command ──────────────────────────────────────────────────

  describe('update command', () => {
    beforeEach(async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [
            { subject: 'Task A', task_description: 'Do A' },
            { subject: 'Task B', task_description: 'Do B' },
          ],
        },
        withSession,
      );
    });

    it('updates task status', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '1', status: 'in_progress' },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data.taskId).toBe('1');
      expect(result.data.status).toBe('in_progress');
    });

    it('includes _taskEvent with eventType "updated"', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '1', status: 'in_progress' },
        withSession,
      );

      expect(result.data._taskEvent).toBeDefined();
      expect(result.data._taskEvent.eventType).toBe('updated');
      expect(result.data._taskEvent.task.id).toBe('1');
    });

    it('sets eventType to "completed" when status becomes completed', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '1', status: 'completed' },
        withSession,
      );

      expect(result.data._taskEvent.eventType).toBe('completed');
    });

    it('sets eventType to "deleted" when status becomes deleted', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '1', status: 'deleted' },
        withSession,
      );

      expect(result.data._taskEvent.eventType).toBe('deleted');
    });

    it('rejects missing taskId', async () => {
      const result = await tool.execute(
        { command: 'update', status: 'completed' },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('taskId');
    });

    it('returns error for non-existent task', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '999', status: 'completed' },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('Task not found');
    });
  });

  // ── list command ────────────────────────────────────────────────────

  describe('list command', () => {
    it('returns all tasks', async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [
            { subject: 'A', task_description: 'Do A' },
            { subject: 'B', task_description: 'Do B' },
          ],
        },
        withSession,
      );

      const result = await tool.execute(
        { command: 'list' },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data.tasks).toHaveLength(2);
    });

    it('does NOT include _taskEvent (read-only)', async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'A', task_description: 'Do A' }],
        },
        withSession,
      );

      const result = await tool.execute(
        { command: 'list' },
        withSession,
      );

      expect(result.data._taskEvent).toBeUndefined();
    });

    it('returns empty for empty session', async () => {
      const result = await tool.execute(
        { command: 'list' },
        withSession,
      );

      expect(result.data.tasks).toEqual([]);
    });
  });

  // ── get command ─────────────────────────────────────────────────────

  describe('get command', () => {
    beforeEach(async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'My Task', task_description: 'Detailed desc', activeForm: 'Doing' }],
        },
        withSession,
      );
    });

    it('returns full task details', async () => {
      const result = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data.id).toBe('1');
      expect(result.data.subject).toBe('My Task');
      expect(result.data.task_description).toBe('Detailed desc');
      expect(result.data.activeForm).toBe('Doing');
    });

    it('does NOT include _taskEvent (read-only)', async () => {
      const result = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );

      expect(result.data._taskEvent).toBeUndefined();
    });

    it('rejects missing taskId', async () => {
      const result = await tool.execute(
        { command: 'get' },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('taskId');
    });

    it('returns error for non-existent task', async () => {
      const result = await tool.execute(
        { command: 'get', taskId: '999' },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('Task not found');
    });
  });

  // ── update command (validation) ─────────────────────────────────────

  describe('update command (validation)', () => {
    beforeEach(async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'Task A', task_description: 'Do A' }],
        },
        withSession,
      );
    });

    it('rejects invalid status value', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '1', status: 'bogus' },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain("Invalid status 'bogus'");
    });

    it('rejects task with empty-string subject in plan', async () => {
      const result = await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: '', task_description: 'Desc' }],
        },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('subject');
    });

    it('rejects task with empty-string task_description in plan', async () => {
      const result = await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'Task', task_description: '' }],
        },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('task_description');
    });
  });

  // ── get command (deleted task) ────────────────────────────────────

  describe('get command (deleted task)', () => {
    it('returns not found for deleted task', async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'Task', task_description: 'Desc' }],
        },
        withSession,
      );

      await tool.execute(
        { command: 'update', taskId: '1', status: 'deleted' },
        withSession,
      );

      const result = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('Task not found');
    });
  });

  // ── update command (field changes) ──────────────────────────────────

  describe('update command (field changes)', () => {
    beforeEach(async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [
            { subject: 'Task A', task_description: 'Do A', activeForm: 'Doing A' },
            { subject: 'Task B', task_description: 'Do B' },
          ],
        },
        withSession,
      );
    });

    it('updates subject through the tool', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '1', subject: 'Renamed task' },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data.subject).toBe('Renamed task');

      // Verify persisted via get
      const get = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );
      expect(get.data.subject).toBe('Renamed task');
    });

    it('updates task_description through the tool', async () => {
      await tool.execute(
        { command: 'update', taskId: '1', task_description: 'New description' },
        withSession,
      );

      const get = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );
      expect(get.data.task_description).toBe('New description');
    });

    it('updates activeForm through the tool', async () => {
      await tool.execute(
        { command: 'update', taskId: '1', activeForm: 'Processing items' },
        withSession,
      );

      const get = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );
      expect(get.data.activeForm).toBe('Processing items');
    });

    it('updates owner through the tool', async () => {
      await tool.execute(
        { command: 'update', taskId: '1', owner: 'agent-pi' },
        withSession,
      );

      const get = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );
      expect(get.data.owner).toBe('agent-pi');
    });

    it('merges metadata through the tool', async () => {
      await tool.execute(
        { command: 'update', taskId: '1', metadata: { priority: 'high', label: 'ui' } },
        withSession,
      );

      // Merge: delete label, add deadline
      await tool.execute(
        { command: 'update', taskId: '1', metadata: { label: null, deadline: 'friday' } },
        withSession,
      );

      const get = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );
      expect(get.data.metadata).toEqual({ priority: 'high', deadline: 'friday' });
    });
  });

  // ── update command (dependencies) ─────────────────────────────────

  describe('update command (dependencies)', () => {
    beforeEach(async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [
            { subject: 'Task A', task_description: 'Do A' },
            { subject: 'Task B', task_description: 'Do B' },
            { subject: 'Task C', task_description: 'Do C' },
          ],
        },
        withSession,
      );
    });

    it('adds addBlockedBy dependency', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '2', addBlockedBy: ['1'] },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data._taskEvent.task.blockedBy).toContain('1');

      // Verify reverse edge
      const getA = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );
      expect(getA.data.blocks).toContain('2');
    });

    it('adds addBlocks dependency', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '1', addBlocks: ['3'] },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data._taskEvent.task.blocks).toContain('3');

      // Verify reverse edge
      const getC = await tool.execute(
        { command: 'get', taskId: '3' },
        withSession,
      );
      expect(getC.data.blockedBy).toContain('1');
    });

    it('returns error for cycle detection', async () => {
      // A blocks B
      await tool.execute(
        { command: 'update', taskId: '2', addBlockedBy: ['1'] },
        withSession,
      );
      // B blocks C
      await tool.execute(
        { command: 'update', taskId: '3', addBlockedBy: ['2'] },
        withSession,
      );

      // C blocks A → cycle
      const result = await tool.execute(
        { command: 'update', taskId: '1', addBlockedBy: ['3'] },
        withSession,
      );

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('Cycle detected');
    });

    it('_taskEvent.allTasks includes accurate dependency info', async () => {
      const result = await tool.execute(
        { command: 'update', taskId: '3', addBlockedBy: ['1', '2'] },
        withSession,
      );

      const allTasks = result.data._taskEvent.allTasks;
      expect(allTasks).toHaveLength(3);

      const taskC = allTasks.find((t: any) => t.id === '3');
      expect(taskC.blockedBy).toEqual(['1', '2']);
    });
  });

  // ── update command (_taskEvent.allTasks) ───────────────────────────

  describe('update command (_taskEvent.allTasks)', () => {
    it('allTasks reflects current state after update', async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [
            { subject: 'A', task_description: 'Do A' },
            { subject: 'B', task_description: 'Do B' },
          ],
        },
        withSession,
      );

      // Complete task A
      const result = await tool.execute(
        { command: 'update', taskId: '1', status: 'completed' },
        withSession,
      );

      const allTasks = result.data._taskEvent.allTasks;
      expect(allTasks).toHaveLength(2);
      expect(allTasks.find((t: any) => t.id === '1').status).toBe('completed');
      expect(allTasks.find((t: any) => t.id === '2').status).toBe('pending');
    });

    it('allTasks excludes deleted tasks', async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [
            { subject: 'A', task_description: 'Do A' },
            { subject: 'B', task_description: 'Do B' },
            { subject: 'C', task_description: 'Do C' },
          ],
        },
        withSession,
      );

      const result = await tool.execute(
        { command: 'update', taskId: '2', status: 'deleted' },
        withSession,
      );

      const allTasks = result.data._taskEvent.allTasks;
      expect(allTasks).toHaveLength(2);
      expect(allTasks.map((t: any) => t.id)).toEqual(['1', '3']);
    });
  });

  // ── plan command (replacement) ────────────────────────────────────

  describe('plan command (replacement)', () => {
    it('replaces existing plan with new tasks', async () => {
      await tool.execute(
        {
          command: 'plan',
          plan_summary: 'Old plan',
          tasks: [
            { subject: 'Old A', task_description: 'Do old A' },
            { subject: 'Old B', task_description: 'Do old B' },
          ],
        },
        withSession,
      );

      const result = await tool.execute(
        {
          command: 'plan',
          plan_summary: 'New plan',
          tasks: [{ subject: 'New X', task_description: 'Do new X' }],
        },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data.tasks).toHaveLength(1);
      // IDs continue from where old plan left off
      expect(result.data.taskIds).toEqual(['3']);
    });

    it('old tasks are no longer accessible after replacement', async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'Old', task_description: 'Old desc' }],
        },
        withSession,
      );

      await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'New', task_description: 'New desc' }],
        },
        withSession,
      );

      // Old task ID 1 should not be found
      const get = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );
      expect(get.data.success).toBe(false);
      expect(get.data.error).toContain('Task not found');
    });

    it('get_plan reflects updated plan_summary after replacement', async () => {
      await tool.execute(
        {
          command: 'plan',
          plan_summary: 'First plan',
          plan_detail: 'First strategy',
          tasks: [{ subject: 'A', task_description: 'Do A' }],
        },
        withSession,
      );

      await tool.execute(
        {
          command: 'plan',
          plan_summary: 'Second plan',
          plan_detail: 'Second strategy',
          tasks: [{ subject: 'B', task_description: 'Do B' }],
        },
        withSession,
      );

      const plan = await tool.execute(
        { command: 'get_plan' },
        withSession,
      );

      expect(plan.data.plan_summary).toBe('Second plan');
      expect(plan.data.plan_detail).toBe('Second strategy');
      expect(plan.data.tasks).toHaveLength(1);
      expect(plan.data.tasks[0].subject).toBe('B');
    });
  });

  // ── list command (shape and filtering) ────────────────────────────

  describe('list command (shape and filtering)', () => {
    beforeEach(async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [
            { subject: 'Task A', task_description: 'Do A' },
            { subject: 'Task B', task_description: 'Do B' },
            { subject: 'Task C', task_description: 'Do C' },
          ],
        },
        withSession,
      );
    });

    it('summaries contain expected fields', async () => {
      await tool.execute(
        { command: 'update', taskId: '1', status: 'in_progress', owner: 'agent-1' },
        withSession,
      );

      const result = await tool.execute(
        { command: 'list' },
        withSession,
      );

      const taskA = result.data.tasks.find((t: any) => t.id === '1');
      expect(taskA).toEqual({
        id: '1',
        subject: 'Task A',
        status: 'in_progress',
        owner: 'agent-1',
        blockedBy: [],
      });
    });

    it('excludes deleted tasks', async () => {
      await tool.execute(
        { command: 'update', taskId: '2', status: 'deleted' },
        withSession,
      );

      const result = await tool.execute(
        { command: 'list' },
        withSession,
      );

      expect(result.data.tasks).toHaveLength(2);
      expect(result.data.tasks.map((t: any) => t.id)).toEqual(['1', '3']);
    });

    it('blockedBy in summary only shows open blockers', async () => {
      // C blocked by A and B
      await tool.execute(
        { command: 'update', taskId: '3', addBlockedBy: ['1', '2'] },
        withSession,
      );

      // Complete A
      await tool.execute(
        { command: 'update', taskId: '1', status: 'completed' },
        withSession,
      );

      const result = await tool.execute(
        { command: 'list' },
        withSession,
      );

      const taskC = result.data.tasks.find((t: any) => t.id === '3');
      // Only B remains as open blocker
      expect(taskC.blockedBy).toEqual(['2']);
    });
  });

  // ── get_plan command ────────────────────────────────────────────────

  describe('get_plan command', () => {
    it('returns plan summary, detail, and tasks', async () => {
      await tool.execute(
        {
          command: 'plan',
          plan_summary: 'My plan summary',
          plan_detail: 'My strategy detail',
          tasks: [
            { subject: 'A', task_description: 'Do A' },
            { subject: 'B', task_description: 'Do B' },
          ],
        },
        withSession,
      );

      const result = await tool.execute(
        { command: 'get_plan' },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data.plan_summary).toBe('My plan summary');
      expect(result.data.plan_detail).toBe('My strategy detail');
      expect(result.data.tasks).toHaveLength(2);
    });

    it('does NOT include _taskEvent (read-only)', async () => {
      await tool.execute(
        {
          command: 'plan',
          tasks: [{ subject: 'A', task_description: 'Do A' }],
        },
        withSession,
      );

      const result = await tool.execute(
        { command: 'get_plan' },
        withSession,
      );

      expect(result.data._taskEvent).toBeUndefined();
    });

    it('returns empty for session with no plan', async () => {
      const result = await tool.execute(
        { command: 'get_plan' },
        withSession,
      );

      expect(result.data.success).toBe(true);
      expect(result.data.plan_summary).toBeUndefined();
      expect(result.data.plan_detail).toBeUndefined();
      expect(result.data.tasks).toEqual([]);
    });
  });

  // ── End-to-end workflow ───────────────────────────────────────────

  describe('end-to-end workflow', () => {
    it('plan → in_progress → completed → list lifecycle', async () => {
      // 1. Create plan
      const plan = await tool.execute(
        {
          command: 'plan',
          plan_summary: 'Build feature X',
          tasks: [
            { subject: 'Research', task_description: 'Research options', activeForm: 'Researching' },
            { subject: 'Implement', task_description: 'Write the code', activeForm: 'Implementing' },
            { subject: 'Test', task_description: 'Write tests', activeForm: 'Testing' },
          ],
        },
        withSession,
      );
      expect(plan.data.taskIds).toEqual(['1', '2', '3']);

      // 2. Start task 1
      const start1 = await tool.execute(
        { command: 'update', taskId: '1', status: 'in_progress' },
        withSession,
      );
      expect(start1.data._taskEvent.eventType).toBe('updated');
      expect(start1.data.status).toBe('in_progress');

      // 3. Complete task 1
      const done1 = await tool.execute(
        { command: 'update', taskId: '1', status: 'completed' },
        withSession,
      );
      expect(done1.data._taskEvent.eventType).toBe('completed');

      // 4. Start and complete task 2
      await tool.execute(
        { command: 'update', taskId: '2', status: 'in_progress' },
        withSession,
      );
      await tool.execute(
        { command: 'update', taskId: '2', status: 'completed' },
        withSession,
      );

      // 5. Start task 3
      await tool.execute(
        { command: 'update', taskId: '3', status: 'in_progress' },
        withSession,
      );

      // 6. List — should show accurate statuses
      const list = await tool.execute(
        { command: 'list' },
        withSession,
      );
      const tasks = list.data.tasks;
      expect(tasks).toHaveLength(3);
      expect(tasks[0].status).toBe('completed');
      expect(tasks[1].status).toBe('completed');
      expect(tasks[2].status).toBe('in_progress');

      // 7. get_plan — should still have summary
      const getPlan = await tool.execute(
        { command: 'get_plan' },
        withSession,
      );
      expect(getPlan.data.plan_summary).toBe('Build feature X');
    });

    it('plan → add dependencies → complete blocker → verify unblock', async () => {
      // 1. Create plan
      await tool.execute(
        {
          command: 'plan',
          tasks: [
            { subject: 'Setup DB', task_description: 'Create schema' },
            { subject: 'Build API', task_description: 'REST endpoints' },
            { subject: 'Build UI', task_description: 'Frontend components' },
          ],
        },
        withSession,
      );

      // 2. API and UI depend on DB setup
      await tool.execute(
        { command: 'update', taskId: '2', addBlockedBy: ['1'] },
        withSession,
      );
      await tool.execute(
        { command: 'update', taskId: '3', addBlockedBy: ['1'] },
        withSession,
      );

      // 3. Verify both are blocked
      let list = await tool.execute({ command: 'list' }, withSession);
      expect(list.data.tasks.find((t: any) => t.id === '2').blockedBy).toEqual(['1']);
      expect(list.data.tasks.find((t: any) => t.id === '3').blockedBy).toEqual(['1']);

      // 4. Complete DB setup
      await tool.execute(
        { command: 'update', taskId: '1', status: 'completed' },
        withSession,
      );

      // 5. Both should now be unblocked
      list = await tool.execute({ command: 'list' }, withSession);
      expect(list.data.tasks.find((t: any) => t.id === '2').blockedBy).toEqual([]);
      expect(list.data.tasks.find((t: any) => t.id === '3').blockedBy).toEqual([]);
    });

    it('plan replacement mid-workflow starts fresh', async () => {
      // Create first plan and start working
      await tool.execute(
        {
          command: 'plan',
          plan_summary: 'Plan A',
          tasks: [
            { subject: 'Step 1', task_description: 'First step' },
            { subject: 'Step 2', task_description: 'Second step' },
          ],
        },
        withSession,
      );

      await tool.execute(
        { command: 'update', taskId: '1', status: 'completed' },
        withSession,
      );

      // Replace with new plan mid-workflow
      const newPlan = await tool.execute(
        {
          command: 'plan',
          plan_summary: 'Plan B',
          tasks: [
            { subject: 'New step 1', task_description: 'New first' },
            { subject: 'New step 2', task_description: 'New second' },
            { subject: 'New step 3', task_description: 'New third' },
          ],
        },
        withSession,
      );

      // New IDs continue (3, 4, 5)
      expect(newPlan.data.taskIds).toEqual(['3', '4', '5']);

      // All new tasks are pending
      const list = await tool.execute({ command: 'list' }, withSession);
      expect(list.data.tasks).toHaveLength(3);
      expect(list.data.tasks.every((t: any) => t.status === 'pending')).toBe(true);

      // Old tasks are gone
      const old = await tool.execute(
        { command: 'get', taskId: '1' },
        withSession,
      );
      expect(old.data.success).toBe(false);
    });
  });
});
