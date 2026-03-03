/**
 * Scheduler Handler Tests
 *
 * Tests for WebSocket method handlers in server/handlers/scheduler.ts.
 * Mocks the Scheduler and ISchedulerStorage dependencies, then exercises
 * each handler via the captured handler functions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture registered handlers so we can call them directly
const handlerMap = new Map<string, Function>();
vi.mock('@pi/ws-server', () => ({
  registerMethodHandler: (name: string, handler: Function) => {
    handlerMap.set(name, handler);
  },
  invalidRequest: (msg: string) => {
    const err = new Error(msg);
    (err as any).code = 'INVALID_REQUEST';
    return err;
  },
  notFound: (msg: string) => {
    const err = new Error(msg);
    (err as any).code = 'NOT_FOUND';
    return err;
  },
}));

import { registerSchedulerHandlers } from '../scheduler';

// ─────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────

function createMockScheduler() {
  return {
    createDraftTask: vi.fn().mockResolvedValue('draft-1'),
    scheduleTask: vi.fn().mockResolvedValue('sched-1'),
    scheduleExistingTask: vi.fn().mockResolvedValue(undefined),
    triggerTask: vi.fn().mockResolvedValue(undefined),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    completeTask: vi.fn().mockResolvedValue(undefined),
    failTask: vi.fn().mockResolvedValue(undefined),
    pauseSchedulerTaskQueue: vi.fn().mockResolvedValue(undefined),
    resumeSchedulerTaskQueue: vi.fn().mockResolvedValue(undefined),
    getSchedulerState: vi.fn().mockResolvedValue({
      isPaused: false,
      currentTaskId: null,
      draftCount: 0,
      scheduledCount: 0,
      missedCount: 0,
      waitingCount: 0,
      runningCount: 0,
      runningTask: null,
    }),
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    input: 'Test task input that is reasonably short',
    scheduledTime: Date.now() + 60000,
    status: 'draft',
    createdAt: Date.now(),
    completedAt: null,
    sessionId: null,
    error: null,
    result: null,
    ...overrides,
  };
}

function createMockStorage() {
  return {
    createTask: vi.fn(),
    getTask: vi.fn().mockResolvedValue(makeTask()),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    getDraftTasks: vi.fn().mockResolvedValue([makeTask()]),
    getScheduledTasks: vi.fn().mockResolvedValue([makeTask({ status: 'scheduled' })]),
    getMissedTasks: vi.fn().mockResolvedValue([makeTask({ status: 'missed' })]),
    getSchedulerTaskQueueTasks: vi.fn().mockResolvedValue([makeTask({ status: 'waiting' })]),
    getArchivedTasks: vi.fn().mockResolvedValue([
      makeTask({ status: 'completed', completedAt: 1000 }),
    ]),
    getNextTaskInSchedulerTaskQueue: vi.fn(),
    getOverdueScheduledTasks: vi.fn(),
    getSchedulerState: vi.fn(),
    setSchedulerState: vi.fn(),
    getTaskCounts: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const dummyCtx = {} as any;

function callHandler(name: string, params?: Record<string, unknown>) {
  const handler = handlerMap.get(name);
  if (!handler) throw new Error(`Handler "${name}" not registered`);
  return handler(params, dummyCtx);
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('Scheduler WebSocket handlers', () => {
  let scheduler: ReturnType<typeof createMockScheduler>;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    handlerMap.clear();
    scheduler = createMockScheduler();
    storage = createMockStorage();
    registerSchedulerHandlers({ scheduler, storage } as any);
  });

  it('should register all 15 handlers', () => {
    expect(handlerMap.size).toBe(15);
    expect(handlerMap.has('scheduler.createDraft')).toBe(true);
    expect(handlerMap.has('scheduler.schedule')).toBe(true);
    expect(handlerMap.has('scheduler.trigger')).toBe(true);
    expect(handlerMap.has('scheduler.cancel')).toBe(true);
    expect(handlerMap.has('scheduler.complete')).toBe(true);
    expect(handlerMap.has('scheduler.fail')).toBe(true);
    expect(handlerMap.has('scheduler.pauseQueue')).toBe(true);
    expect(handlerMap.has('scheduler.resumeQueue')).toBe(true);
    expect(handlerMap.has('scheduler.getDraftTasks')).toBe(true);
    expect(handlerMap.has('scheduler.getScheduledTasks')).toBe(true);
    expect(handlerMap.has('scheduler.getMissedTasks')).toBe(true);
    expect(handlerMap.has('scheduler.getQueue')).toBe(true);
    expect(handlerMap.has('scheduler.getArchivedTasks')).toBe(true);
    expect(handlerMap.has('scheduler.getState')).toBe(true);
    expect(handlerMap.has('scheduler.getTaskDetails')).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.createDraft
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.createDraft', () => {
    it('should create a draft task and return taskId', async () => {
      const result = await callHandler('scheduler.createDraft', { input: 'hello' });
      expect(scheduler.createDraftTask).toHaveBeenCalledWith('hello');
      expect(result).toEqual({ success: true, taskId: 'draft-1' });
    });

    it('should throw when input is missing', async () => {
      await expect(callHandler('scheduler.createDraft', {})).rejects.toThrow('"input" is required');
    });

    it('should throw when params is undefined', async () => {
      await expect(callHandler('scheduler.createDraft', undefined)).rejects.toThrow('"input" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.schedule
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.schedule', () => {
    it('should schedule a new task with input', async () => {
      const result = await callHandler('scheduler.schedule', {
        input: 'new task',
        scheduledTime: 9999999,
      });
      expect(scheduler.scheduleTask).toHaveBeenCalledWith('new task', 9999999);
      expect(result).toEqual({ success: true, taskId: 'sched-1' });
    });

    it('should schedule an existing task by taskId', async () => {
      const result = await callHandler('scheduler.schedule', {
        taskId: 'existing-1',
        scheduledTime: 9999999,
      });
      expect(scheduler.scheduleExistingTask).toHaveBeenCalledWith('existing-1', 9999999);
      expect(result).toEqual({ success: true, taskId: 'existing-1' });
    });

    it('should throw when scheduledTime is missing', async () => {
      await expect(
        callHandler('scheduler.schedule', { input: 'hello' })
      ).rejects.toThrow('"scheduledTime" is required');
    });

    it('should throw when neither input nor taskId provided', async () => {
      await expect(
        callHandler('scheduler.schedule', { scheduledTime: 9999999 })
      ).rejects.toThrow('Either "input" or "taskId" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.trigger
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.trigger', () => {
    it('should trigger a task', async () => {
      const result = await callHandler('scheduler.trigger', { taskId: 'task-1' });
      expect(scheduler.triggerTask).toHaveBeenCalledWith('task-1');
      expect(result).toEqual({ success: true });
    });

    it('should throw when taskId is missing', async () => {
      await expect(callHandler('scheduler.trigger', {})).rejects.toThrow('"taskId" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.cancel
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.cancel', () => {
    it('should cancel a task', async () => {
      const result = await callHandler('scheduler.cancel', { taskId: 'task-1' });
      expect(scheduler.cancelTask).toHaveBeenCalledWith('task-1');
      expect(result).toEqual({ success: true });
    });

    it('should throw when taskId is missing', async () => {
      await expect(callHandler('scheduler.cancel', {})).rejects.toThrow('"taskId" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.complete
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.complete', () => {
    it('should complete a task with result', async () => {
      const taskResult = { summary: 'done' };
      const result = await callHandler('scheduler.complete', {
        taskId: 'task-1',
        result: taskResult,
      });
      expect(scheduler.completeTask).toHaveBeenCalledWith('task-1', taskResult);
      expect(result).toEqual({ success: true });
    });

    it('should throw when taskId is missing', async () => {
      await expect(
        callHandler('scheduler.complete', { result: {} })
      ).rejects.toThrow('"taskId" is required');
    });

    it('should throw when result is missing', async () => {
      await expect(
        callHandler('scheduler.complete', { taskId: 'task-1' })
      ).rejects.toThrow('"result" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.fail
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.fail', () => {
    it('should fail a task with error message', async () => {
      const result = await callHandler('scheduler.fail', {
        taskId: 'task-1',
        error: 'something broke',
      });
      expect(scheduler.failTask).toHaveBeenCalledWith('task-1', 'something broke');
      expect(result).toEqual({ success: true });
    });

    it('should throw when taskId is missing', async () => {
      await expect(
        callHandler('scheduler.fail', { error: 'err' })
      ).rejects.toThrow('"taskId" is required');
    });

    it('should throw when error is missing', async () => {
      await expect(
        callHandler('scheduler.fail', { taskId: 'task-1' })
      ).rejects.toThrow('"error" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.pauseQueue / resumeQueue
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.pauseQueue', () => {
    it('should pause the scheduler queue', async () => {
      const result = await callHandler('scheduler.pauseQueue');
      expect(scheduler.pauseSchedulerTaskQueue).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('scheduler.resumeQueue', () => {
    it('should resume the scheduler queue', async () => {
      const result = await callHandler('scheduler.resumeQueue');
      expect(scheduler.resumeSchedulerTaskQueue).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Query handlers
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.getDraftTasks', () => {
    it('should return draft tasks as summaries', async () => {
      const result = await callHandler('scheduler.getDraftTasks');
      expect(storage.getDraftTasks).toHaveBeenCalled();
      const tasks = (result as any).tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('task-1');
      expect(tasks[0].status).toBe('draft');
    });

    it('should truncate long input to 100 chars', async () => {
      const longInput = 'x'.repeat(200);
      storage.getDraftTasks.mockResolvedValue([makeTask({ input: longInput })]);
      const result = await callHandler('scheduler.getDraftTasks');
      const tasks = (result as any).tasks;
      expect(tasks[0].input).toHaveLength(100);
    });
  });

  describe('scheduler.getScheduledTasks', () => {
    it('should return scheduled tasks', async () => {
      const result = await callHandler('scheduler.getScheduledTasks');
      expect(storage.getScheduledTasks).toHaveBeenCalled();
      expect((result as any).tasks).toHaveLength(1);
    });
  });

  describe('scheduler.getMissedTasks', () => {
    it('should return missed tasks', async () => {
      const result = await callHandler('scheduler.getMissedTasks');
      expect(storage.getMissedTasks).toHaveBeenCalled();
      expect((result as any).tasks).toHaveLength(1);
    });
  });

  describe('scheduler.getQueue', () => {
    it('should return waiting tasks', async () => {
      const result = await callHandler('scheduler.getQueue');
      expect(storage.getSchedulerTaskQueueTasks).toHaveBeenCalled();
      expect((result as any).tasks).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.getArchivedTasks
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.getArchivedTasks', () => {
    it('should return archived tasks with default pagination', async () => {
      const result = await callHandler('scheduler.getArchivedTasks');
      expect(storage.getArchivedTasks).toHaveBeenCalledWith(50, 0);
      const data = result as any;
      expect(data.tasks).toHaveLength(1);
      expect(data.total).toBe(1);
      expect(data.hasMore).toBe(false);
    });

    it('should pass custom limit and offset', async () => {
      await callHandler('scheduler.getArchivedTasks', { limit: 10, offset: 5 });
      expect(storage.getArchivedTasks).toHaveBeenCalledWith(10, 5);
    });

    it('should set hasMore=true when result length equals limit', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) =>
        makeTask({ id: `t-${i}`, status: 'completed', completedAt: i })
      );
      storage.getArchivedTasks.mockResolvedValue(tasks);
      const result = await callHandler('scheduler.getArchivedTasks', { limit: 10 });
      expect((result as any).hasMore).toBe(true);
    });

    it('should include sessionId and error in archived output', async () => {
      storage.getArchivedTasks.mockResolvedValue([
        makeTask({ status: 'failed', error: 'timeout', sessionId: 's-1', completedAt: 1000 }),
      ]);
      const result = await callHandler('scheduler.getArchivedTasks');
      const task = (result as any).tasks[0];
      expect(task.sessionId).toBe('s-1');
      expect(task.error).toBe('timeout');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.getState
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.getState', () => {
    it('should return scheduler state', async () => {
      const result = await callHandler('scheduler.getState');
      expect(scheduler.getSchedulerState).toHaveBeenCalled();
      expect((result as any).isPaused).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.getTaskDetails
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.getTaskDetails', () => {
    it('should return task details', async () => {
      const result = await callHandler('scheduler.getTaskDetails', { taskId: 'task-1' });
      expect(storage.getTask).toHaveBeenCalledWith('task-1');
      expect((result as any).task.id).toBe('task-1');
    });

    it('should throw when taskId is missing', async () => {
      await expect(callHandler('scheduler.getTaskDetails', {})).rejects.toThrow(
        '"taskId" is required'
      );
    });

    it('should return null task when not found', async () => {
      storage.getTask.mockResolvedValue(null);
      const result = await callHandler('scheduler.getTaskDetails', { taskId: 'nope' });
      expect((result as any).task).toBeNull();
    });
  });
});
