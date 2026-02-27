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
  });
});
