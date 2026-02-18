/**
 * Unit tests for SchedulerStorage
 *
 * Tests cover:
 * - Task CRUD operations (create, get, update, delete)
 * - Query methods (getDraftTasks, getScheduledTasks, getMissedTasks, etc.)
 * - Scheduler state management (getSchedulerState, setSchedulerState)
 * - chrome.storage.local fallback when ConfigStorageProvider is not initialized
 * - Error handling and edge cases
 * - Task counting and UI display helpers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STORE_NAMES, INDEX_NAMES } from '@/storage/IndexedDBAdapter';
import type { IndexedDBAdapter } from '@/storage/IndexedDBAdapter';
import type { SchedulerTaskRecord, SchedulerState } from '@/core/models/types/Scheduler';
import { SCHEDULER_STATE_KEY } from '@/core/models/types/SchedulerContracts';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let uuidCounter = 0;
  return {
    uuidv4: vi.fn(() => `test-uuid-${++uuidCounter}`),
    resetUuidCounter: () => { uuidCounter = 0; },
    isConfigStorageInitialized: vi.fn(() => false),
    getConfigStorage: vi.fn(),
  };
});

vi.mock('uuid', () => ({
  v4: mocks.uuidv4,
}));

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: mocks.isConfigStorageInitialized,
  getConfigStorage: mocks.getConfigStorage,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDB(): IndexedDBAdapter {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    getAll: vi.fn().mockResolvedValue([]),
    queryByIndex: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    batchDelete: vi.fn().mockResolvedValue(0),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as IndexedDBAdapter;
}

function makeTask(overrides: Partial<SchedulerTaskRecord> = {}): SchedulerTaskRecord {
  return {
    id: 'task-1',
    input: 'Test task',
    scheduledTime: null,
    createdAt: 1000,
    status: 'draft',
    sessionId: null,
    completedAt: null,
    error: null,
    result: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { SchedulerStorage } = await import('@/core/scheduler/SchedulerStorage');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchedulerStorage', () => {
  let storage: InstanceType<typeof SchedulerStorage>;
  let mockDB: ReturnType<typeof createMockDB>;

  beforeEach(() => {
    mocks.resetUuidCounter();
    mocks.isConfigStorageInitialized.mockReturnValue(false);
    mocks.getConfigStorage.mockImplementation(() => {
      throw new Error('Not initialized');
    });
    mockDB = createMockDB();
    storage = new SchedulerStorage(mockDB);
  });

  // =========================================================================
  // createTask
  // =========================================================================
  describe('createTask()', () => {
    it('should create a draft task when no scheduledTime is provided', async () => {
      const task = await storage.createTask('Write a report');

      expect(task.id).toBe('test-uuid-1');
      expect(task.input).toBe('Write a report');
      expect(task.status).toBe('draft');
      expect(task.scheduledTime).toBeNull();
      expect(task.sessionId).toBeNull();
      expect(task.completedAt).toBeNull();
      expect(task.error).toBeNull();
      expect(task.result).toBeNull();
    });

    it('should create a scheduled task when scheduledTime is provided', async () => {
      const scheduledTime = Date.now() + 60000;
      const task = await storage.createTask('Schedule me', scheduledTime);

      expect(task.id).toBe('test-uuid-1');
      expect(task.input).toBe('Schedule me');
      expect(task.status).toBe('scheduled');
      expect(task.scheduledTime).toBe(scheduledTime);
    });

    it('should persist the task to IndexedDB via db.put', async () => {
      const task = await storage.createTask('Persist me');

      expect(mockDB.put).toHaveBeenCalledTimes(1);
      expect(mockDB.put).toHaveBeenCalledWith(STORE_NAMES.SCHEDULER_TASKS, task);
    });

    it('should generate unique IDs for each task', async () => {
      const task1 = await storage.createTask('Task 1');
      const task2 = await storage.createTask('Task 2');

      expect(task1.id).toBe('test-uuid-1');
      expect(task2.id).toBe('test-uuid-2');
      expect(task1.id).not.toBe(task2.id);
    });

    it('should set createdAt to current timestamp for draft tasks', async () => {
      const before = Date.now();
      const task = await storage.createTask('Timestamped');
      const after = Date.now();

      expect(task.createdAt).toBeGreaterThanOrEqual(before);
      expect(task.createdAt).toBeLessThanOrEqual(after);
    });

    it('should set createdAt to current timestamp for scheduled tasks', async () => {
      const before = Date.now();
      const task = await storage.createTask('Scheduled', Date.now() + 60000);
      const after = Date.now();

      expect(task.createdAt).toBeGreaterThanOrEqual(before);
      expect(task.createdAt).toBeLessThanOrEqual(after);
    });

    it('should propagate IndexedDB errors from db.put', async () => {
      (mockDB.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB write failed'));

      await expect(storage.createTask('Failing')).rejects.toThrow('DB write failed');
    });

    it('should handle empty string input', async () => {
      const task = await storage.createTask('');
      expect(task.input).toBe('');
      expect(task.status).toBe('draft');
    });

    it('should handle very long input strings', async () => {
      const longInput = 'x'.repeat(10000);
      const task = await storage.createTask(longInput);
      expect(task.input).toBe(longInput);
    });
  });

  // =========================================================================
  // getTask
  // =========================================================================
  describe('getTask()', () => {
    it('should return a task when found', async () => {
      const task = makeTask({ id: 'abc-123' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(task);

      const result = await storage.getTask('abc-123');

      expect(result).toEqual(task);
      expect(mockDB.get).toHaveBeenCalledWith(STORE_NAMES.SCHEDULER_TASKS, 'abc-123');
    });

    it('should return null when task not found', async () => {
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await storage.getTask('nonexistent');
      expect(result).toBeNull();
    });

    it('should propagate IndexedDB errors from db.get', async () => {
      (mockDB.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB read failed'));

      await expect(storage.getTask('abc')).rejects.toThrow('DB read failed');
    });
  });

  // =========================================================================
  // updateTask
  // =========================================================================
  describe('updateTask()', () => {
    it('should merge updates into existing task', async () => {
      const existing = makeTask({ id: 'u-1', status: 'draft' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await storage.updateTask('u-1', { status: 'scheduled', scheduledTime: 9999 });

      expect(mockDB.put).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        expect.objectContaining({
          id: 'u-1',
          status: 'scheduled',
          scheduledTime: 9999,
          input: 'Test task',
        })
      );
    });

    it('should preserve the original ID even if updates try to change it', async () => {
      const existing = makeTask({ id: 'original-id' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await storage.updateTask('original-id', { id: 'attempted-new-id' } as any);

      expect(mockDB.put).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        expect.objectContaining({ id: 'original-id' })
      );
    });

    it('should throw when task does not exist', async () => {
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(storage.updateTask('ghost', { status: 'running' }))
        .rejects.toThrow('Task not found: ghost');
    });

    it('should propagate db.put errors', async () => {
      const existing = makeTask({ id: 'u-2' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      (mockDB.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Write error'));

      await expect(storage.updateTask('u-2', { status: 'running' }))
        .rejects.toThrow('Write error');
    });

    it('should allow updating multiple fields at once', async () => {
      const existing = makeTask({ id: 'u-3' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await storage.updateTask('u-3', {
        status: 'completed',
        completedAt: 5000,
        sessionId: 'session-x',
        result: {
          summary: 'Done',
          tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          duration: 1500,
        },
      });

      expect(mockDB.put).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        expect.objectContaining({
          status: 'completed',
          completedAt: 5000,
          sessionId: 'session-x',
          result: expect.objectContaining({ summary: 'Done' }),
        })
      );
    });

    it('should allow updating with an error message', async () => {
      const existing = makeTask({ id: 'u-4' });
      (mockDB.get as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await storage.updateTask('u-4', {
        status: 'failed',
        error: 'Something went wrong',
      });

      expect(mockDB.put).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        expect.objectContaining({
          status: 'failed',
          error: 'Something went wrong',
        })
      );
    });
  });

  // =========================================================================
  // deleteTask
  // =========================================================================
  describe('deleteTask()', () => {
    it('should call db.delete with the correct store and key', async () => {
      await storage.deleteTask('del-1');

      expect(mockDB.delete).toHaveBeenCalledWith(STORE_NAMES.SCHEDULER_TASKS, 'del-1');
    });

    it('should not throw when deleting a nonexistent task', async () => {
      (mockDB.delete as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await expect(storage.deleteTask('nonexistent')).resolves.toBeUndefined();
    });

    it('should propagate db.delete errors', async () => {
      (mockDB.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Delete failed'));

      await expect(storage.deleteTask('del-2')).rejects.toThrow('Delete failed');
    });
  });

  // =========================================================================
  // getDraftTasks
  // =========================================================================
  describe('getDraftTasks()', () => {
    it('should query by status index with "draft"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getDraftTasks();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'draft'
      );
    });

    it('should sort drafts by createdAt ascending', async () => {
      const tasks = [
        makeTask({ id: 'd-3', createdAt: 3000, status: 'draft' }),
        makeTask({ id: 'd-1', createdAt: 1000, status: 'draft' }),
        makeTask({ id: 'd-2', createdAt: 2000, status: 'draft' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getDraftTasks();

      expect(result.map(t => t.id)).toEqual(['d-1', 'd-2', 'd-3']);
    });

    it('should return empty array when no drafts exist', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getDraftTasks();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getScheduledTasks
  // =========================================================================
  describe('getScheduledTasks()', () => {
    it('should query by status index with "scheduled"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getScheduledTasks();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'scheduled'
      );
    });

    it('should sort scheduled tasks by scheduledTime ascending', async () => {
      const tasks = [
        makeTask({ id: 's-3', scheduledTime: 3000, status: 'scheduled' }),
        makeTask({ id: 's-1', scheduledTime: 1000, status: 'scheduled' }),
        makeTask({ id: 's-2', scheduledTime: 2000, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getScheduledTasks();

      expect(result.map(t => t.id)).toEqual(['s-1', 's-2', 's-3']);
    });

    it('should handle tasks with null scheduledTime (treated as 0)', async () => {
      const tasks = [
        makeTask({ id: 's-2', scheduledTime: 2000, status: 'scheduled' }),
        makeTask({ id: 's-null', scheduledTime: null, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getScheduledTasks();

      expect(result[0].id).toBe('s-null');
      expect(result[1].id).toBe('s-2');
    });

    it('should return empty array when none scheduled', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getScheduledTasks();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getMissedTasks
  // =========================================================================
  describe('getMissedTasks()', () => {
    it('should query by status index with "missed"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getMissedTasks();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'missed'
      );
    });

    it('should sort missed tasks by scheduledTime ascending', async () => {
      const tasks = [
        makeTask({ id: 'm-2', scheduledTime: 2000, status: 'missed' }),
        makeTask({ id: 'm-1', scheduledTime: 1000, status: 'missed' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getMissedTasks();

      expect(result.map(t => t.id)).toEqual(['m-1', 'm-2']);
    });

    it('should return empty array when no missed tasks', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getMissedTasks();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getSchedulerTaskQueueTasks
  // =========================================================================
  describe('getSchedulerTaskQueueTasks()', () => {
    it('should query by status index with "waiting"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getSchedulerTaskQueueTasks();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'waiting'
      );
    });

    it('should sort waiting tasks by createdAt (FIFO)', async () => {
      const tasks = [
        makeTask({ id: 'w-3', createdAt: 3000, status: 'waiting' }),
        makeTask({ id: 'w-1', createdAt: 1000, status: 'waiting' }),
        makeTask({ id: 'w-2', createdAt: 2000, status: 'waiting' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getSchedulerTaskQueueTasks();

      expect(result.map(t => t.id)).toEqual(['w-1', 'w-2', 'w-3']);
    });

    it('should return empty array when queue is empty', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getSchedulerTaskQueueTasks();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getArchivedTasks
  // =========================================================================
  describe('getArchivedTasks()', () => {
    it('should query both completed and failed statuses', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getArchivedTasks(10, 0);

      expect(mockDB.queryByIndex).toHaveBeenCalledTimes(2);
      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'completed'
      );
      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'failed'
      );
    });

    it('should sort archived tasks by completedAt descending (most recent first)', async () => {
      const completed = [
        makeTask({ id: 'c-1', status: 'completed', completedAt: 1000 }),
        makeTask({ id: 'c-3', status: 'completed', completedAt: 3000 }),
      ];
      const failed = [
        makeTask({ id: 'f-2', status: 'failed', completedAt: 2000 }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce(failed);

      const result = await storage.getArchivedTasks(10, 0);

      expect(result.map(t => t.id)).toEqual(['c-3', 'f-2', 'c-1']);
    });

    it('should apply pagination with limit and offset', async () => {
      const completed = [
        makeTask({ id: 'c-1', status: 'completed', completedAt: 1000 }),
        makeTask({ id: 'c-2', status: 'completed', completedAt: 2000 }),
        makeTask({ id: 'c-3', status: 'completed', completedAt: 3000 }),
        makeTask({ id: 'c-4', status: 'completed', completedAt: 4000 }),
        makeTask({ id: 'c-5', status: 'completed', completedAt: 5000 }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce([]);

      // offset=1, limit=2 -> skip the first (c-5), take next 2 (c-4, c-3)
      const result = await storage.getArchivedTasks(2, 1);

      expect(result.map(t => t.id)).toEqual(['c-4', 'c-3']);
    });

    it('should return empty array when no archived tasks', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await storage.getArchivedTasks(10, 0);
      expect(result).toEqual([]);
    });

    it('should handle offset beyond available tasks', async () => {
      const completed = [makeTask({ id: 'c-1', status: 'completed', completedAt: 1000 })];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce([]);

      const result = await storage.getArchivedTasks(10, 100);
      expect(result).toEqual([]);
    });

    it('should handle null completedAt values (treated as 0)', async () => {
      const completed = [
        makeTask({ id: 'c-null', status: 'completed', completedAt: null }),
        makeTask({ id: 'c-2', status: 'completed', completedAt: 2000 }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce([]);

      const result = await storage.getArchivedTasks(10, 0);

      // c-2 (2000) comes before c-null (0) in descending order
      expect(result[0].id).toBe('c-2');
      expect(result[1].id).toBe('c-null');
    });
  });

  // =========================================================================
  // getNextTaskInSchedulerTaskQueue
  // =========================================================================
  describe('getNextTaskInSchedulerTaskQueue()', () => {
    it('should return the first task in FIFO order', async () => {
      const tasks = [
        makeTask({ id: 'w-2', createdAt: 2000, status: 'waiting' }),
        makeTask({ id: 'w-1', createdAt: 1000, status: 'waiting' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getNextTaskInSchedulerTaskQueue();

      expect(result).not.toBeNull();
      expect(result!.id).toBe('w-1');
    });

    it('should return null when queue is empty', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getNextTaskInSchedulerTaskQueue();
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // getOverdueScheduledTasks
  // =========================================================================
  describe('getOverdueScheduledTasks()', () => {
    it('should return tasks with scheduledTime in the past', async () => {
      const now = Date.now();
      const tasks = [
        makeTask({ id: 'o-1', scheduledTime: now - 10000, status: 'scheduled' }),
        makeTask({ id: 'o-future', scheduledTime: now + 60000, status: 'scheduled' }),
        makeTask({ id: 'o-2', scheduledTime: now - 5000, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getOverdueScheduledTasks();

      expect(result.map(t => t.id)).toEqual(['o-1', 'o-2']);
    });

    it('should return empty array when no tasks are overdue', async () => {
      const now = Date.now();
      const tasks = [
        makeTask({ id: 's-1', scheduledTime: now + 60000, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getOverdueScheduledTasks();
      expect(result).toEqual([]);
    });

    it('should exclude tasks with null scheduledTime', async () => {
      const tasks = [
        makeTask({ id: 's-null', scheduledTime: null, status: 'scheduled' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getOverdueScheduledTasks();
      expect(result).toEqual([]);
    });

    it('should return empty array when no scheduled tasks exist', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getOverdueScheduledTasks();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getCurrentTask
  // =========================================================================
  describe('getCurrentTask()', () => {
    it('should query by status index with "running"', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getCurrentTask();

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'running'
      );
    });

    it('should return the running task', async () => {
      const runningTask = makeTask({ id: 'r-1', status: 'running' });
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([runningTask]);

      const result = await storage.getCurrentTask();
      expect(result).toEqual(runningTask);
    });

    it('should return null when no running task', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await storage.getCurrentTask();
      expect(result).toBeNull();
    });

    it('should return only the first running task if multiple exist', async () => {
      const tasks = [
        makeTask({ id: 'r-1', status: 'running' }),
        makeTask({ id: 'r-2', status: 'running' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const result = await storage.getCurrentTask();
      expect(result!.id).toBe('r-1');
    });
  });

  // =========================================================================
  // countByStatus
  // =========================================================================
  describe('countByStatus()', () => {
    it('should return count of tasks with the given status', async () => {
      const tasks = [
        makeTask({ id: 'd-1', status: 'draft' }),
        makeTask({ id: 'd-2', status: 'draft' }),
        makeTask({ id: 'd-3', status: 'draft' }),
      ];
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const count = await storage.countByStatus('draft');
      expect(count).toBe(3);
    });

    it('should return 0 when no tasks match', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const count = await storage.countByStatus('running');
      expect(count).toBe(0);
    });

    it('should use the correct store and index', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.countByStatus('waiting');

      expect(mockDB.queryByIndex).toHaveBeenCalledWith(
        STORE_NAMES.SCHEDULER_TASKS,
        INDEX_NAMES.SCHEDULER_BY_STATUS,
        'waiting'
      );
    });
  });

  // =========================================================================
  // getTaskCounts
  // =========================================================================
  describe('getTaskCounts()', () => {
    it('should return counts for all relevant statuses', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([makeTask()])                         // draft
        .mockResolvedValueOnce([makeTask(), makeTask()])             // scheduled
        .mockResolvedValueOnce([])                                   // missed
        .mockResolvedValueOnce([makeTask(), makeTask(), makeTask()]) // waiting
        .mockResolvedValueOnce([makeTask()]);                        // running

      const counts = await storage.getTaskCounts();

      expect(counts).toEqual({
        draftCount: 1,
        scheduledCount: 2,
        missedCount: 0,
        waitingCount: 3,
        runningCount: 1,
      });
    });

    it('should return all zeros when no tasks exist', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const counts = await storage.getTaskCounts();

      expect(counts).toEqual({
        draftCount: 0,
        scheduledCount: 0,
        missedCount: 0,
        waitingCount: 0,
        runningCount: 0,
      });
    });

    it('should query all five statuses in parallel', async () => {
      (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await storage.getTaskCounts();

      expect(mockDB.queryByIndex).toHaveBeenCalledTimes(5);
      const statusArgs = (mockDB.queryByIndex as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: any[]) => c[2]
      );
      expect(statusArgs).toContain('draft');
      expect(statusArgs).toContain('scheduled');
      expect(statusArgs).toContain('missed');
      expect(statusArgs).toContain('waiting');
      expect(statusArgs).toContain('running');
    });
  });

  // =========================================================================
  // getSchedulerState - with chrome.storage.local fallback
  // =========================================================================
  describe('getSchedulerState()', () => {
    it('should return default state when storage is not available', async () => {
      // Make chrome undefined temporarily
      const origChrome = globalThis.chrome;
      (globalThis as any).chrome = undefined;

      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentTaskId: null,
        lastProcessedTime: 0,
      });

      (globalThis as any).chrome = origChrome;
    });

    it('should return default state when ConfigStorageProvider is not initialized and chrome is unavailable', async () => {
      const origChrome = globalThis.chrome;
      (globalThis as any).chrome = undefined;

      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentTaskId: null,
        lastProcessedTime: 0,
      });

      (globalThis as any).chrome = origChrome;
    });

    it('should use chrome.storage.local fallback when ConfigStorageProvider not initialized', async () => {
      // Pre-populate chrome.storage.local with scheduler state
      const customState: SchedulerState = {
        isPaused: true,
        currentTaskId: 'task-abc',
        lastProcessedTime: 12345,
      };
      await chrome.storage.local.set({ [SCHEDULER_STATE_KEY]: customState });

      const state = await storage.getSchedulerState();

      expect(state).toEqual(customState);
    });

    it('should return default state when chrome.storage.local has no data', async () => {
      // chrome.storage.local is empty (setup.ts resets it)
      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentTaskId: null,
        lastProcessedTime: 0,
      });
    });

    it('should use ConfigStorageProvider when initialized', async () => {
      const customState: SchedulerState = {
        isPaused: true,
        currentTaskId: 'task-xyz',
        lastProcessedTime: 99999,
      };
      const mockConfigStorage = {
        get: vi.fn().mockResolvedValue(customState),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        getMany: vi.fn(),
        setMany: vi.fn(),
        removeMany: vi.fn(),
        getAll: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      mocks.isConfigStorageInitialized.mockReturnValue(true);
      mocks.getConfigStorage.mockReturnValue(mockConfigStorage);

      const state = await storage.getSchedulerState();

      expect(state).toEqual(customState);
      expect(mockConfigStorage.get).toHaveBeenCalledWith(SCHEDULER_STATE_KEY);
    });

    it('should return default state when ConfigStorageProvider.get returns null', async () => {
      const mockConfigStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
        remove: vi.fn(),
        getMany: vi.fn(),
        setMany: vi.fn(),
        removeMany: vi.fn(),
        getAll: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      mocks.isConfigStorageInitialized.mockReturnValue(true);
      mocks.getConfigStorage.mockReturnValue(mockConfigStorage);

      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentTaskId: null,
        lastProcessedTime: 0,
      });
    });

    it('should return default state and log warning on storage error', async () => {
      const mockConfigStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage broke')),
        set: vi.fn(),
        remove: vi.fn(),
        getMany: vi.fn(),
        setMany: vi.fn(),
        removeMany: vi.fn(),
        getAll: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      mocks.isConfigStorageInitialized.mockReturnValue(true);
      mocks.getConfigStorage.mockReturnValue(mockConfigStorage);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const state = await storage.getSchedulerState();

      expect(state).toEqual({
        isPaused: false,
        currentTaskId: null,
        lastProcessedTime: 0,
      });
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // setSchedulerState
  // =========================================================================
  describe('setSchedulerState()', () => {
    it('should throw when no storage is available', async () => {
      const origChrome = globalThis.chrome;
      (globalThis as any).chrome = undefined;

      await expect(storage.setSchedulerState({ isPaused: true }))
        .rejects.toThrow('Storage not available');

      (globalThis as any).chrome = origChrome;
    });

    it('should merge partial state with current state using chrome.storage.local', async () => {
      // Pre-populate with existing state
      const existingState: SchedulerState = {
        isPaused: false,
        currentTaskId: 'task-1',
        lastProcessedTime: 100,
      };
      await chrome.storage.local.set({ [SCHEDULER_STATE_KEY]: existingState });

      await storage.setSchedulerState({ isPaused: true });

      // Read back from chrome storage
      const result = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
      expect(result[SCHEDULER_STATE_KEY]).toEqual({
        isPaused: true,
        currentTaskId: 'task-1',
        lastProcessedTime: 100,
      });
    });

    it('should update only the currentTaskId', async () => {
      const existingState: SchedulerState = {
        isPaused: false,
        currentTaskId: null,
        lastProcessedTime: 200,
      };
      await chrome.storage.local.set({ [SCHEDULER_STATE_KEY]: existingState });

      await storage.setSchedulerState({ currentTaskId: 'new-task' });

      const result = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
      expect(result[SCHEDULER_STATE_KEY]).toEqual({
        isPaused: false,
        currentTaskId: 'new-task',
        lastProcessedTime: 200,
      });
    });

    it('should update lastProcessedTime', async () => {
      await storage.setSchedulerState({ lastProcessedTime: 5000 });

      const result = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
      expect(result[SCHEDULER_STATE_KEY]).toEqual(
        expect.objectContaining({ lastProcessedTime: 5000 })
      );
    });

    it('should use ConfigStorageProvider when initialized', async () => {
      const mockConfigStorage = {
        get: vi.fn().mockResolvedValue({
          isPaused: false,
          currentTaskId: null,
          lastProcessedTime: 0,
        }),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        getMany: vi.fn(),
        setMany: vi.fn(),
        removeMany: vi.fn(),
        getAll: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      mocks.isConfigStorageInitialized.mockReturnValue(true);
      mocks.getConfigStorage.mockReturnValue(mockConfigStorage);

      await storage.setSchedulerState({ isPaused: true });

      expect(mockConfigStorage.set).toHaveBeenCalledWith(
        SCHEDULER_STATE_KEY,
        expect.objectContaining({ isPaused: true })
      );
    });

    it('should handle chrome.storage.local.set errors via runtime.lastError', async () => {
      // This exercises the fallback path error handling.
      // The mock storage checks for quota errors, but normally runtime.lastError
      // won't be set for simple operations. We just verify no crash.
      await storage.setSchedulerState({ isPaused: false });

      const result = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
      expect(result[SCHEDULER_STATE_KEY]).toEqual(
        expect.objectContaining({ isPaused: false })
      );
    });
  });

  // =========================================================================
  // getStorage (private) - chrome.storage.local fallback behavior
  // =========================================================================
  describe('getStorage() private method - chrome.storage.local fallback', () => {
    it('should return a ConfigStorageProvider-compatible object from chrome.storage.local', async () => {
      // Access private method
      const storageProvider = await (storage as any).getStorage();

      expect(storageProvider).not.toBeNull();
      expect(typeof storageProvider.get).toBe('function');
      expect(typeof storageProvider.set).toBe('function');
      expect(typeof storageProvider.remove).toBe('function');
      expect(typeof storageProvider.getMany).toBe('function');
      expect(typeof storageProvider.setMany).toBe('function');
      expect(typeof storageProvider.removeMany).toBe('function');
      expect(typeof storageProvider.getAll).toBe('function');
      expect(typeof storageProvider.clear).toBe('function');
      expect(typeof storageProvider.getBytesInUse).toBe('function');
    });

    it('fallback get should return value from chrome.storage.local', async () => {
      await chrome.storage.local.set({ testKey: 'testValue' });

      const storageProvider = await (storage as any).getStorage();
      const value = await storageProvider.get('testKey');

      expect(value).toBe('testValue');
    });

    it('fallback get should return null for missing key', async () => {
      const storageProvider = await (storage as any).getStorage();
      const value = await storageProvider.get('missing');

      expect(value).toBeNull();
    });

    it('fallback set should write to chrome.storage.local', async () => {
      const storageProvider = await (storage as any).getStorage();
      await storageProvider.set('key1', 'value1');

      const result = await chrome.storage.local.get('key1');
      expect(result.key1).toBe('value1');
    });

    it('fallback remove should delete from chrome.storage.local', async () => {
      await chrome.storage.local.set({ removeMe: 'data' });

      const storageProvider = await (storage as any).getStorage();
      await storageProvider.remove('removeMe');

      const result = await chrome.storage.local.get('removeMe');
      expect(result.removeMe).toBeUndefined();
    });

    it('fallback getMany should return multiple values', async () => {
      await chrome.storage.local.set({ a: 1, b: 2, c: 3 });

      const storageProvider = await (storage as any).getStorage();
      const values = await storageProvider.getMany(['a', 'c']);

      expect(values).toEqual({ a: 1, c: 3 });
    });

    it('fallback setMany should write multiple values', async () => {
      const storageProvider = await (storage as any).getStorage();
      await storageProvider.setMany({ x: 10, y: 20 });

      const result = await chrome.storage.local.get(['x', 'y']);
      expect(result).toEqual({ x: 10, y: 20 });
    });

    it('fallback removeMany should delete multiple keys', async () => {
      await chrome.storage.local.set({ r1: 'a', r2: 'b', keep: 'c' });

      const storageProvider = await (storage as any).getStorage();
      await storageProvider.removeMany(['r1', 'r2']);

      const result = await chrome.storage.local.get(['r1', 'r2', 'keep']);
      expect(result.r1).toBeUndefined();
      expect(result.r2).toBeUndefined();
      expect(result.keep).toBe('c');
    });

    it('fallback getAll should return all stored data', async () => {
      await chrome.storage.local.set({ all1: 'x', all2: 'y' });

      const storageProvider = await (storage as any).getStorage();
      const all = await storageProvider.getAll();

      expect(all).toEqual({ all1: 'x', all2: 'y' });
    });

    it('fallback clear should remove all data', async () => {
      await chrome.storage.local.set({ clearMe: 'data' });

      const storageProvider = await (storage as any).getStorage();
      await storageProvider.clear();

      const result = await chrome.storage.local.get(null);
      expect(result).toEqual({});
    });

    it('fallback getBytesInUse should return null', async () => {
      const storageProvider = await (storage as any).getStorage();
      const bytes = await storageProvider.getBytesInUse();

      expect(bytes).toBeNull();
    });

    it('should return null when chrome is undefined', async () => {
      const origChrome = globalThis.chrome;
      (globalThis as any).chrome = undefined;

      const result = await (storage as any).getStorage();
      expect(result).toBeNull();

      (globalThis as any).chrome = origChrome;
    });

    it('should return null when chrome.storage is undefined', async () => {
      const origStorage = chrome.storage;
      (chrome as any).storage = undefined;

      const result = await (storage as any).getStorage();
      expect(result).toBeNull();

      (chrome as any).storage = origStorage;
    });
  });
});
