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
    createDraftJob: vi.fn().mockResolvedValue('draft-1'),
    scheduleJob: vi.fn().mockResolvedValue('sched-1'),
    scheduleExistingJob: vi.fn().mockResolvedValue(undefined),
    triggerJob: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    completeJob: vi.fn().mockResolvedValue(undefined),
    failJob: vi.fn().mockResolvedValue(undefined),
    pauseJobQueue: vi.fn().mockResolvedValue(undefined),
    resumeJobQueue: vi.fn().mockResolvedValue(undefined),
    getSchedulerState: vi.fn().mockResolvedValue({
      isPaused: false,
      currentJobId: null,
      draftCount: 0,
      scheduledCount: 0,
      missedCount: 0,
      waitingCount: 0,
      runningCount: 0,
      runningJob: null,
    }),
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    input: 'Test job input that is reasonably short',
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
    createJob: vi.fn(),
    getJob: vi.fn().mockResolvedValue(makeJob()),
    updateJob: vi.fn(),
    deleteJob: vi.fn(),
    getDraftJobs: vi.fn().mockResolvedValue([makeJob()]),
    getScheduledJobs: vi.fn().mockResolvedValue([makeJob({ status: 'scheduled' })]),
    getMissedJobs: vi.fn().mockResolvedValue([makeJob({ status: 'missed' })]),
    getJobQueueJobs: vi.fn().mockResolvedValue([makeJob({ status: 'waiting' })]),
    getArchivedJobs: vi.fn().mockResolvedValue([
      makeJob({ status: 'completed', completedAt: 1000 }),
    ]),
    getArchivedJobsCount: vi.fn().mockResolvedValue(1),
    getNextJobInQueue: vi.fn(),
    getOverdueScheduledJobs: vi.fn(),
    getSchedulerState: vi.fn(),
    setSchedulerState: vi.fn(),
    getJobCounts: vi.fn(),
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

  it('should register all 22 handlers', () => {
    expect(handlerMap.size).toBe(22);
    expect(handlerMap.has('scheduler.createDraft')).toBe(true);
    expect(handlerMap.has('scheduler.schedule')).toBe(true);
    expect(handlerMap.has('scheduler.trigger')).toBe(true);
    expect(handlerMap.has('scheduler.cancel')).toBe(true);
    expect(handlerMap.has('scheduler.complete')).toBe(true);
    expect(handlerMap.has('scheduler.fail')).toBe(true);
    expect(handlerMap.has('scheduler.pauseQueue')).toBe(true);
    expect(handlerMap.has('scheduler.resumeQueue')).toBe(true);
    expect(handlerMap.has('scheduler.getDraftJobs')).toBe(true);
    expect(handlerMap.has('scheduler.getScheduledJobs')).toBe(true);
    expect(handlerMap.has('scheduler.getMissedJobs')).toBe(true);
    expect(handlerMap.has('scheduler.getQueue')).toBe(true);
    expect(handlerMap.has('scheduler.getArchivedJobs')).toBe(true);
    expect(handlerMap.has('scheduler.getState')).toBe(true);
    expect(handlerMap.has('scheduler.getJobDetails')).toBe(true);
    // New schedule event handlers
    expect(handlerMap.has('schedule.createEvent')).toBe(true);
    expect(handlerMap.has('schedule.updateEvent')).toBe(true);
    expect(handlerMap.has('schedule.deleteEvent')).toBe(true);
    expect(handlerMap.has('schedule.getEventsInRange')).toBe(true);
    expect(handlerMap.has('schedule.editInstance')).toBe(true);
    expect(handlerMap.has('schedule.deleteInstance')).toBe(true);
    expect(handlerMap.has('schedule.getExecutionHistory')).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.createDraft
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.createDraft', () => {
    it('should create a draft job and return jobId', async () => {
      const result = await callHandler('scheduler.createDraft', { input: 'hello' });
      expect(scheduler.createDraftJob).toHaveBeenCalledWith('hello');
      expect(result).toEqual({ success: true, jobId: 'draft-1' });
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
    it('should schedule a new job with input', async () => {
      const result = await callHandler('scheduler.schedule', {
        input: 'new job',
        scheduledTime: 9999999,
      });
      expect(scheduler.scheduleJob).toHaveBeenCalledWith('new job', 9999999);
      expect(result).toEqual({ success: true, jobId: 'sched-1' });
    });

    it('should schedule an existing job by jobId', async () => {
      const result = await callHandler('scheduler.schedule', {
        jobId: 'existing-1',
        scheduledTime: 9999999,
      });
      expect(scheduler.scheduleExistingJob).toHaveBeenCalledWith('existing-1', 9999999);
      expect(result).toEqual({ success: true, jobId: 'existing-1' });
    });

    it('should throw when scheduledTime is missing', async () => {
      await expect(
        callHandler('scheduler.schedule', { input: 'hello' })
      ).rejects.toThrow('"scheduledTime" is required');
    });

    it('should throw when neither input nor jobId provided', async () => {
      await expect(
        callHandler('scheduler.schedule', { scheduledTime: 9999999 })
      ).rejects.toThrow('Either "input" or "jobId" is required');
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

  describe('scheduler.getDraftJobs', () => {
    it('should return draft jobs as summaries', async () => {
      const result = await callHandler('scheduler.getDraftJobs');
      expect(storage.getDraftJobs).toHaveBeenCalled();
      const jobs = (result as any).jobs;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('task-1');
      expect(jobs[0].status).toBe('draft');
    });

    it('should truncate long input to 100 chars', async () => {
      const longInput = 'x'.repeat(200);
      storage.getDraftJobs.mockResolvedValue([makeJob({ input: longInput })]);
      const result = await callHandler('scheduler.getDraftJobs');
      const jobs = (result as any).jobs;
      expect(jobs[0].input).toHaveLength(100);
    });
  });

  describe('scheduler.getScheduledJobs', () => {
    it('should return scheduled jobs', async () => {
      const result = await callHandler('scheduler.getScheduledJobs');
      expect(storage.getScheduledJobs).toHaveBeenCalled();
      expect((result as any).jobs).toHaveLength(1);
    });
  });

  describe('scheduler.getMissedJobs', () => {
    it('should return missed jobs', async () => {
      const result = await callHandler('scheduler.getMissedJobs');
      expect(storage.getMissedJobs).toHaveBeenCalled();
      expect((result as any).jobs).toHaveLength(1);
    });
  });

  describe('scheduler.getQueue', () => {
    it('should return waiting jobs', async () => {
      const result = await callHandler('scheduler.getQueue');
      expect(storage.getJobQueueJobs).toHaveBeenCalled();
      expect((result as any).jobs).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // scheduler.getArchivedJobs
  // ───────────────────────────────────────────────────────────────────

  describe('scheduler.getArchivedJobs', () => {
    it('should return archived jobs with default pagination', async () => {
      const result = await callHandler('scheduler.getArchivedJobs');
      expect(storage.getArchivedJobs).toHaveBeenCalledWith(50, 0);
      const data = result as any;
      expect(data.jobs).toHaveLength(1);
      expect(data.total).toBe(1);
      expect(data.hasMore).toBe(false);
    });

    it('should pass custom limit and offset', async () => {
      await callHandler('scheduler.getArchivedJobs', { limit: 10, offset: 5 });
      expect(storage.getArchivedJobs).toHaveBeenCalledWith(10, 5);
    });

    it('should set hasMore=true when total exceeds offset + returned jobs', async () => {
      const jobs = Array.from({ length: 10 }, (_, i) =>
        makeJob({ id: `t-${i}`, status: 'completed', completedAt: i })
      );
      storage.getArchivedJobs.mockResolvedValue(jobs);
      storage.getArchivedJobsCount.mockResolvedValue(20); // 20 total, only 10 returned
      const result = await callHandler('scheduler.getArchivedJobs', { limit: 10 });
      expect((result as any).hasMore).toBe(true);
    });

    it('should include sessionId and error in archived output', async () => {
      storage.getArchivedJobs.mockResolvedValue([
        makeJob({ status: 'failed', error: 'timeout', sessionId: 's-1', completedAt: 1000 }),
      ]);
      const result = await callHandler('scheduler.getArchivedJobs');
      const job = (result as any).jobs[0];
      expect(job.sessionId).toBe('s-1');
      expect(job.error).toBe('timeout');
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
      expect(storage.getJob).toHaveBeenCalledWith('task-1');
      expect((result as any).job.id).toBe('task-1');
    });

    it('should throw when jobId is missing', async () => {
      await expect(callHandler('scheduler.getJobDetails', {})).rejects.toThrow(
        '"jobId" is required'
      );
    });

    it('should return null when job not found', async () => {
      storage.getJob.mockResolvedValue(null);
      const result = await callHandler('scheduler.getJobDetails', { jobId: 'nope' });
      expect((result as any).job).toBeNull();
    });
  });
});
