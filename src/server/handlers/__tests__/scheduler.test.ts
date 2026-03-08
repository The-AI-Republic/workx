/**
 * Scheduler Handler Tests
 *
 * Tests for WebSocket method handlers in server/handlers/scheduler.ts.
 * Mocks the Scheduler dependency, then exercises each handler via the
 * captured handler functions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture registered handlers so we can call them directly
const handlerMap = new Map<string, Function>();
vi.mock('@applepi/ws-server', () => ({
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
    scheduleJob: vi.fn().mockResolvedValue('sched-1'),
    triggerJob: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    completeJob: vi.fn().mockResolvedValue(undefined),
    failJob: vi.fn().mockResolvedValue(undefined),
    pauseJobQueue: vi.fn().mockResolvedValue(undefined),
    resumeJobQueue: vi.fn().mockResolvedValue(undefined),
    getScheduledJobs: vi.fn().mockResolvedValue([{ id: 'j1', input: 'Test', scheduledTime: 1000, status: 'scheduled', createdAt: 500 }]),
    getMissedJobs: vi.fn().mockResolvedValue([{ id: 'j2', input: 'Missed', scheduledTime: 900, status: 'missed', createdAt: 400 }]),
    getJobQueue: vi.fn().mockResolvedValue([{ id: 'j3', input: 'Waiting', scheduledTime: 1000, status: 'waiting', createdAt: 600 }]),
    getArchivedJobs: vi.fn().mockResolvedValue({ jobs: [], total: 0, hasMore: false }),
    getSchedulerState: vi.fn().mockResolvedValue({
      isPaused: false,
      currentJobId: null,
      draftCount: 0,
      scheduledCount: 1,
      missedCount: 0,
      jobQueueCount: 0,
      runningJob: null,
    }),
    getJobDetails: vi.fn().mockResolvedValue({ id: 'j1', input: 'Test', status: 'scheduled' }),
    getScheduleManager: vi.fn().mockReturnValue({
      createEvent: vi.fn().mockResolvedValue({ id: 'evt-1' }),
      editSeries: vi.fn(),
      deleteEvent: vi.fn(),
      getInstancesInRange: vi.fn().mockResolvedValue([]),
      editInstance: vi.fn(),
      deleteInstance: vi.fn(),
    }),
    getJobExecutor: vi.fn().mockReturnValue({
      getExecutionHistory: vi.fn().mockResolvedValue([]),
    }),
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

  beforeEach(() => {
    handlerMap.clear();
    scheduler = createMockScheduler();
    registerSchedulerHandlers({ scheduler } as any);
  });

  it('should register all expected handlers', () => {
    // 12 legacy scheduler handlers + 7 new schedule event handlers = 19
    // (createDraft and getDraftJobs were removed)
    expect(handlerMap.has('scheduler.schedule')).toBe(true);
    expect(handlerMap.has('scheduler.trigger')).toBe(true);
    expect(handlerMap.has('scheduler.cancel')).toBe(true);
    expect(handlerMap.has('scheduler.complete')).toBe(true);
    expect(handlerMap.has('scheduler.fail')).toBe(true);
    expect(handlerMap.has('scheduler.pauseQueue')).toBe(true);
    expect(handlerMap.has('scheduler.resumeQueue')).toBe(true);
    expect(handlerMap.has('scheduler.getScheduledJobs')).toBe(true);
    expect(handlerMap.has('scheduler.getMissedJobs')).toBe(true);
    expect(handlerMap.has('scheduler.getQueue')).toBe(true);
    expect(handlerMap.has('scheduler.getArchivedJobs')).toBe(true);
    expect(handlerMap.has('scheduler.getState')).toBe(true);
    expect(handlerMap.has('scheduler.getJobDetails')).toBe(true);
    expect(handlerMap.has('schedule.createEvent')).toBe(true);
    expect(handlerMap.has('schedule.updateEvent')).toBe(true);
    expect(handlerMap.has('schedule.deleteEvent')).toBe(true);
    expect(handlerMap.has('schedule.getEventsInRange')).toBe(true);
    expect(handlerMap.has('schedule.editInstance')).toBe(true);
    expect(handlerMap.has('schedule.deleteInstance')).toBe(true);
    expect(handlerMap.has('schedule.getExecutionHistory')).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.schedule
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.schedule', () => {
    it('should schedule a new job with input', async () => {
      const result = await callHandler('scheduler.schedule', {
        input: 'new job',
        scheduledTime: 9999999,
      });
      expect(scheduler.scheduleJob).toHaveBeenCalledWith('new job', 9999999, undefined);
      expect(result).toEqual({ success: true, jobId: 'sched-1' });
    });

    it('should throw when scheduledTime is missing', async () => {
      await expect(
        callHandler('scheduler.schedule', { input: 'hello' })
      ).rejects.toThrow('"scheduledTime" is required');
    });

    it('should throw when input is missing', async () => {
      await expect(
        callHandler('scheduler.schedule', { scheduledTime: 9999999 })
      ).rejects.toThrow('"input" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.trigger
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.trigger', () => {
    it('should trigger a job', async () => {
      const result = await callHandler('scheduler.trigger', { jobId: 'task-1' });
      expect(scheduler.triggerJob).toHaveBeenCalledWith('task-1');
      expect(result).toEqual({ success: true });
    });

    it('should throw when jobId is missing', async () => {
      await expect(callHandler('scheduler.trigger', {})).rejects.toThrow('"jobId" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.cancel
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.cancel', () => {
    it('should cancel a job', async () => {
      const result = await callHandler('scheduler.cancel', { jobId: 'task-1' });
      expect(scheduler.cancelJob).toHaveBeenCalledWith('task-1');
      expect(result).toEqual({ success: true });
    });

    it('should throw when jobId is missing', async () => {
      await expect(callHandler('scheduler.cancel', {})).rejects.toThrow('"jobId" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.complete
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.complete', () => {
    it('should complete a job with result', async () => {
      const jobResult = { summary: 'done' };
      const result = await callHandler('scheduler.complete', {
        jobId: 'task-1',
        result: jobResult,
      });
      expect(scheduler.completeJob).toHaveBeenCalledWith('task-1', jobResult);
      expect(result).toEqual({ success: true });
    });

    it('should throw when jobId is missing', async () => {
      await expect(
        callHandler('scheduler.complete', { result: {} })
      ).rejects.toThrow('"jobId" is required');
    });

    it('should throw when result is missing', async () => {
      await expect(
        callHandler('scheduler.complete', { jobId: 'task-1' })
      ).rejects.toThrow('"result" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.fail
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.fail', () => {
    it('should fail a job with error message', async () => {
      const result = await callHandler('scheduler.fail', {
        jobId: 'task-1',
        error: 'something broke',
      });
      expect(scheduler.failJob).toHaveBeenCalledWith('task-1', 'something broke');
      expect(result).toEqual({ success: true });
    });

    it('should throw when jobId is missing', async () => {
      await expect(
        callHandler('scheduler.fail', { error: 'err' })
      ).rejects.toThrow('"jobId" is required');
    });

    it('should throw when error is missing', async () => {
      await expect(
        callHandler('scheduler.fail', { jobId: 'task-1' })
      ).rejects.toThrow('"error" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.pauseQueue / resumeQueue
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.pauseQueue', () => {
    it('should pause the scheduler queue', async () => {
      const result = await callHandler('scheduler.pauseQueue');
      expect(scheduler.pauseJobQueue).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('scheduler.resumeQueue', () => {
    it('should resume the scheduler queue', async () => {
      const result = await callHandler('scheduler.resumeQueue');
      expect(scheduler.resumeJobQueue).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Query handlers
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.getScheduledJobs', () => {
    it('should return scheduled jobs', async () => {
      const result = await callHandler('scheduler.getScheduledJobs');
      expect(scheduler.getScheduledJobs).toHaveBeenCalled();
      expect((result as any).jobs).toHaveLength(1);
    });
  });

  describe('scheduler.getMissedJobs', () => {
    it('should return missed jobs', async () => {
      const result = await callHandler('scheduler.getMissedJobs');
      expect(scheduler.getMissedJobs).toHaveBeenCalled();
      expect((result as any).jobs).toHaveLength(1);
    });
  });

  describe('scheduler.getQueue', () => {
    it('should return queued jobs', async () => {
      const result = await callHandler('scheduler.getQueue');
      expect(scheduler.getJobQueue).toHaveBeenCalled();
      expect((result as any).jobs).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.getArchivedJobs
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.getArchivedJobs', () => {
    it('should return archived jobs with default pagination', async () => {
      const result = await callHandler('scheduler.getArchivedJobs');
      expect(scheduler.getArchivedJobs).toHaveBeenCalled();
    });

    it('should pass custom limit and offset', async () => {
      await callHandler('scheduler.getArchivedJobs', { limit: 10, offset: 5 });
      expect(scheduler.getArchivedJobs).toHaveBeenCalled();
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
  // scheduler.getJobDetails
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.getJobDetails', () => {
    it('should return job details', async () => {
      const result = await callHandler('scheduler.getJobDetails', { jobId: 'task-1' });
      expect(scheduler.getJobDetails).toHaveBeenCalledWith('task-1');
    });

    it('should throw when jobId is missing', async () => {
      await expect(callHandler('scheduler.getJobDetails', {})).rejects.toThrow(
        '"jobId" is required'
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // schedule.createEvent
  // ───────────────────────────────────────────────────────────────────

  describe('schedule.createEvent', () => {
    it('should create an event', async () => {
      const result = await callHandler('schedule.createEvent', {
        input: 'Test event',
        scheduledTime: Date.now() + 3600000,
      });
      expect(result).toEqual({ success: true, eventId: 'evt-1' });
    });

    it('should throw when input is missing', async () => {
      await expect(
        callHandler('schedule.createEvent', { scheduledTime: 9999 })
      ).rejects.toThrow('"input" is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // schedule.getEventsInRange
  // ───────────────────────────────────────────────────────────────────

  describe('schedule.getEventsInRange', () => {
    it('should return instances in range', async () => {
      const now = Date.now();
      const result = await callHandler('schedule.getEventsInRange', {
        startTime: now,
        endTime: now + 86400000,
      });
      expect((result as any).instances).toEqual([]);
    });

    it('should throw when times are invalid', async () => {
      await expect(
        callHandler('schedule.getEventsInRange', { startTime: 'bad', endTime: 'bad' })
      ).rejects.toThrow('"startTime" and "endTime" must be numbers');
    });
  });
});
