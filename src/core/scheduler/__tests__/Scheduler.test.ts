/**
 * Comprehensive unit tests for Scheduler
 *
 * Tests the main orchestrator for scheduled job execution:
 * - Constructor and initialization
 * - Job lifecycle (create, schedule, trigger, execute, complete, fail, cancel)
 * - Queue processing
 * - Alarm handling
 * - Missed job detection
 * - AgentRegistry integration (Feature 015)
 * - Chrome API interactions (notifications, tabs)
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scheduler } from '@/core/scheduler/Scheduler';
import type { SchedulerJobRecord, SchedulerState, JobResultRecord } from '@/core/models/types/Scheduler';
import type { ISchedulerStorage, ISchedulerAlarms } from '@/core/models/types/SchedulerContracts';

// ---------------------------------------------------------------------------
// Mock uuid
// ---------------------------------------------------------------------------
const mockUuid = vi.hoisted(() => vi.fn(() => 'mock-uuid-1234'));
vi.mock('uuid', () => ({
  v4: mockUuid,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockJob(overrides: Partial<SchedulerJobRecord> = {}): SchedulerJobRecord {
  return {
    id: 'job-1',
    input: 'Test job input',
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

function createMockState(overrides: Partial<SchedulerState> = {}): SchedulerState {
  return {
    isPaused: false,
    currentJobId: null,
    lastProcessedTime: 0,
    ...overrides,
  };
}

function createMockJobResult(): JobResultRecord {
  return {
    summary: 'Job completed successfully',
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    duration: 5000,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockStorage(): ISchedulerStorage {
  return {
    createJob: vi.fn(),
    getJob: vi.fn(),
    updateJob: vi.fn(),
    deleteJob: vi.fn(),
    getDraftJobs: vi.fn(),
    getScheduledJobs: vi.fn(),
    getMissedJobs: vi.fn(),
    getJobQueueJobs: vi.fn(),
    getArchivedJobs: vi.fn(),
    getArchivedJobsCount: vi.fn(),
    getNextJobInQueue: vi.fn(),
    getOverdueScheduledJobs: vi.fn(),
    getSchedulerState: vi.fn(),
    setSchedulerState: vi.fn(),
    getJobCounts: vi.fn(),
  };
}

function createMockAlarms(): ISchedulerAlarms {
  return {
    createJobAlarm: vi.fn(),
    clearJobAlarm: vi.fn(),
    hasJobAlarm: vi.fn(),
    startJobQueueProcessor: vi.fn(),
    stopJobQueueProcessor: vi.fn(),
    getAllAlarms: vi.fn(),
  };
}

function createMockRegistry() {
  return {
    canCreateSession: vi.fn(() => true),
    createSession: vi.fn(async () => ({ sessionId: 'agent-session-1' })),
    removeSession: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let storage: ReturnType<typeof createMockStorage>;
  let alarms: ReturnType<typeof createMockAlarms>;
  let registry: ReturnType<typeof createMockRegistry>;
  let emitter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = createMockStorage();
    alarms = createMockAlarms();
    registry = createMockRegistry();
    emitter = vi.fn();

    // Default storage state: idle
    vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());
    vi.mocked(storage.getJobCounts).mockResolvedValue({
      draftCount: 0,
      scheduledCount: 0,
      missedCount: 0,
      waitingCount: 0,
      runningCount: 0,
    });

    scheduler = new Scheduler(storage, alarms);
    scheduler.setEventEmitter(emitter);
    scheduler.setRegistry(registry as any);

    // Wire platform callbacks (previously hardcoded Chrome APIs)
    scheduler.setNotificationHandler(vi.fn().mockResolvedValue(undefined));
    scheduler.setJobLauncher(vi.fn().mockResolvedValue(undefined));
    scheduler.setConnectivityCheck(() => true);
  });

  // =========================================================================
  // Constructor & initialization
  // =========================================================================

  describe('constructor and initialization', () => {
    it('should create an instance with storage and alarms', () => {
      const s = new Scheduler(storage, alarms);
      expect(s).toBeInstanceOf(Scheduler);
    });

    it('should have null eventEmitter by default', () => {
      const s = new Scheduler(storage, alarms);
      expect((s as any).eventEmitter).toBeNull();
    });

    it('should have null registry by default', () => {
      const s = new Scheduler(storage, alarms);
      expect((s as any).registry).toBeNull();
    });

    it('should have empty jobSessions map', () => {
      const s = new Scheduler(storage, alarms);
      expect((s as any).jobSessions.size).toBe(0);
    });
  });

  // =========================================================================
  // setRegistry / setEventEmitter
  // =========================================================================

  describe('setRegistry', () => {
    it('should set the registry reference', () => {
      const s = new Scheduler(storage, alarms);
      s.setRegistry(registry as any);
      expect((s as any).registry).toBe(registry);
    });
  });

  describe('setEventEmitter', () => {
    it('should set the event emitter', () => {
      const s = new Scheduler(storage, alarms);
      const fn = vi.fn();
      s.setEventEmitter(fn);
      expect((s as any).eventEmitter).toBe(fn);
    });
  });

  // =========================================================================
  // createDraftJob
  // =========================================================================

  describe('createDraftJob', () => {
    it('should create a draft job and return its id', async () => {
      const job = createMockJob({ id: 'draft-1' });
      vi.mocked(storage.createJob).mockResolvedValue(job);

      const id = await scheduler.createDraftJob('Write a report');
      expect(id).toBe('draft-1');
      expect(storage.createJob).toHaveBeenCalledWith('Write a report');
    });

    it('should not set an alarm for draft jobs', async () => {
      vi.mocked(storage.createJob).mockResolvedValue(createMockJob());
      await scheduler.createDraftJob('Draft job');
      expect(alarms.createJobAlarm).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // scheduleJob
  // =========================================================================

  describe('scheduleJob', () => {
    it('should create a job with a scheduled time', async () => {
      const futureTime = Date.now() + 60000;
      const job = createMockJob({ id: 'sched-1', scheduledTime: futureTime, status: 'scheduled' });
      vi.mocked(storage.createJob).mockResolvedValue(job);

      const id = await scheduler.scheduleJob('Run analysis', futureTime);
      expect(id).toBe('sched-1');
      expect(storage.createJob).toHaveBeenCalledWith('Run analysis', futureTime);
    });

    it('should create an alarm for the scheduled job', async () => {
      const futureTime = Date.now() + 60000;
      const job = createMockJob({ id: 'sched-2', scheduledTime: futureTime });
      vi.mocked(storage.createJob).mockResolvedValue(job);

      await scheduler.scheduleJob('Scheduled job', futureTime);
      expect(alarms.createJobAlarm).toHaveBeenCalledWith('sched-2', futureTime);
    });

    it('should throw if scheduled time is in the past', async () => {
      const pastTime = Date.now() - 1000;
      await expect(scheduler.scheduleJob('Late job', pastTime)).rejects.toThrow(
        'Scheduled time must be in the future'
      );
    });

    it('should throw if scheduled time is equal to now', async () => {
      const now = Date.now();
      // scheduledTime <= now should throw
      await expect(scheduler.scheduleJob('Now job', now)).rejects.toThrow(
        'Scheduled time must be in the future'
      );
    });

    it('should not create an alarm if time validation fails', async () => {
      const pastTime = Date.now() - 5000;
      await expect(scheduler.scheduleJob('Fail', pastTime)).rejects.toThrow();
      expect(alarms.createJobAlarm).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // scheduleExistingJob
  // =========================================================================

  describe('scheduleExistingJob', () => {
    it('should schedule a draft job', async () => {
      const futureTime = Date.now() + 60000;
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'draft' }));

      await scheduler.scheduleExistingJob('job-1', futureTime);

      expect(storage.updateJob).toHaveBeenCalledWith('job-1', {
        scheduledTime: futureTime,
        status: 'scheduled',
      });
      expect(alarms.createJobAlarm).toHaveBeenCalledWith('job-1', futureTime);
    });

    it('should emit a status change event (draft -> scheduled)', async () => {
      const futureTime = Date.now() + 60000;
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'draft' }));

      await scheduler.scheduleExistingJob('job-1', futureTime);

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          previousStatus: 'draft',
          newStatus: 'scheduled',
        })
      );
    });

    it('should throw if job is not found', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(null);
      await expect(scheduler.scheduleExistingJob('missing', Date.now() + 60000)).rejects.toThrow(
        'Job not found: missing'
      );
    });

    it('should throw if job is not in draft status', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'running' }));
      await expect(scheduler.scheduleExistingJob('job-1', Date.now() + 60000)).rejects.toThrow(
        'Cannot schedule job in running status'
      );
    });

    it('should throw if scheduled time is in the past', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'draft' }));
      await expect(scheduler.scheduleExistingJob('job-1', Date.now() - 1000)).rejects.toThrow(
        'Scheduled time must be in the future'
      );
    });
  });

  // =========================================================================
  // triggerJob
  // =========================================================================

  describe('triggerJob', () => {
    it('should throw if job not found', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(null);
      await expect(scheduler.triggerJob('missing')).rejects.toThrow('Job not found: missing');
    });

    it('should throw if job status does not allow triggering', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'running' }));
      await expect(scheduler.triggerJob('job-1')).rejects.toThrow(
        'Cannot trigger job in running status'
      );
    });

    it('should throw for completed jobs', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'completed' }));
      await expect(scheduler.triggerJob('job-1')).rejects.toThrow(
        'Cannot trigger job in completed status'
      );
    });

    it('should throw for failed jobs', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'failed' }));
      await expect(scheduler.triggerJob('job-1')).rejects.toThrow(
        'Cannot trigger job in failed status'
      );
    });

    it('should throw for cancelled jobs', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'cancelled' }));
      await expect(scheduler.triggerJob('job-1')).rejects.toThrow(
        'Cannot trigger job in cancelled status'
      );
    });

    it('should clear alarm if job was scheduled', async () => {
      const job = createMockJob({ id: 'job-1', status: 'scheduled' });
      vi.mocked(storage.getJob).mockResolvedValue(job);
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: null }));

      await scheduler.triggerJob('job-1');
      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('job-1');
    });

    it('should not clear alarm if job was a draft', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'draft' }));
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: null }));

      await scheduler.triggerJob('job-1');
      expect(alarms.clearJobAlarm).not.toHaveBeenCalled();
    });

    it('should queue job as waiting if another job is running', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-2', status: 'draft' }));
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: 'job-1' }));

      await scheduler.triggerJob('job-2');

      expect(storage.updateJob).toHaveBeenCalledWith('job-2', { status: 'waiting' });
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-2',
          previousStatus: 'draft',
          newStatus: 'waiting',
        })
      );
    });

    it('should execute immediately if no job is running', async () => {
      const job = createMockJob({ id: 'job-1', status: 'draft' });
      vi.mocked(storage.getJob)
        .mockResolvedValueOnce(job) // triggerJob lookup
        .mockResolvedValueOnce(job); // executeJob lookup
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: null }));

      await scheduler.triggerJob('job-1');

      // executeJob should update status to running
      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should allow triggering missed jobs', async () => {
      const job = createMockJob({ id: 'job-m', status: 'missed' });
      vi.mocked(storage.getJob)
        .mockResolvedValueOnce(job)
        .mockResolvedValueOnce(job);
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: null }));

      await scheduler.triggerJob('job-m');

      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-m',
        expect.objectContaining({ status: 'running' })
      );
    });
  });

  // =========================================================================
  // executeJob
  // =========================================================================

  describe('executeJob', () => {
    it('should throw if job not found', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(null);
      await expect(scheduler.executeJob('missing')).rejects.toThrow('Job not found: missing');
    });

    it('should create an AgentSession via registry when available', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1' }));

      await scheduler.executeJob('job-1');

      expect(registry.createSession).toHaveBeenCalledWith({
        type: 'scheduled',
      });
    });

    it('should store job-session mapping on success', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1' }));

      await scheduler.executeJob('job-1');

      expect((scheduler as any).jobSessions.get('job-1')).toBe('agent-session-1');
    });

    it('should use legacy session ID when registry.createSession fails', async () => {
      registry.createSession.mockRejectedValue(new Error('Session creation failed'));
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1' }));

      await scheduler.executeJob('job-1');

      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'running', sessionId: 'session_mock-uuid-1234' })
      );
    });

    it('should use legacy session ID when registry is null', async () => {
      const s = new Scheduler(storage, alarms);
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1' }));

      await s.executeJob('job-1');

      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ sessionId: 'session_mock-uuid-1234' })
      );
    });

    it('should use legacy session ID when canCreateSession returns false', async () => {
      registry.canCreateSession.mockReturnValue(false);
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1' }));

      await scheduler.executeJob('job-1');

      expect(registry.createSession).not.toHaveBeenCalled();
      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ sessionId: 'session_mock-uuid-1234' })
      );
    });

    it('should update job status to running', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1' }));

      await scheduler.executeJob('job-1');

      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should set scheduler state with currentJobId', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1' }));

      await scheduler.executeJob('job-1');

      expect(storage.setSchedulerState).toHaveBeenCalledWith(
        expect.objectContaining({ currentJobId: 'job-1' })
      );
    });

    it('should emit job status change and state change events', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'draft' }));

      await scheduler.executeJob('job-1');

      // Status change: draft -> running
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          previousStatus: 'draft',
          newStatus: 'running',
        })
      );
      // State change — currentJobId is now set to the running job
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ isPaused: false, currentJobId: 'job-1' })
      );
    });

    it('should call notification handler', async () => {
      const notifHandler = vi.fn().mockResolvedValue(undefined);
      scheduler.setNotificationHandler(notifHandler);
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', input: 'Hello world' }));

      await scheduler.executeJob('job-1');

      expect(notifHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1', input: 'Hello world' })
      );
    });

    it('should call job launcher', async () => {
      const launcher = vi.fn().mockResolvedValue(undefined);
      scheduler.setJobLauncher(launcher);
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1' }));

      await scheduler.executeJob('job-1');

      expect(launcher).toHaveBeenCalledWith('job-1', expect.any(String));
    });
  });

  describe('executeJob — status guard', () => {
    it('should skip execution for completed jobs', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(
        createMockJob({ id: 'job-1', status: 'completed' })
      );

      await scheduler.executeJob('job-1');

      // Should NOT update to running
      expect(storage.updateJob).not.toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should skip execution for failed jobs', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(
        createMockJob({ id: 'job-1', status: 'failed' })
      );

      await scheduler.executeJob('job-1');

      expect(storage.updateJob).not.toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should skip execution for cancelled jobs', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(
        createMockJob({ id: 'job-1', status: 'cancelled' })
      );

      await scheduler.executeJob('job-1');

      expect(storage.updateJob).not.toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should skip execution for running jobs', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(
        createMockJob({ id: 'job-1', status: 'running' })
      );

      await scheduler.executeJob('job-1');

      // Should not call setSchedulerState (job already running)
      expect(storage.setSchedulerState).not.toHaveBeenCalled();
    });
  });

  describe('executeJob — execution mutex', () => {
    it('should queue job when another executeJob is in progress', async () => {
      // Make the first executeJob slow by making the launcher take time
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      const launcher = vi.fn().mockImplementation(() => firstPromise);
      scheduler.setJobLauncher(launcher);

      const job1 = createMockJob({ id: 'job-1', status: 'draft' });
      const job2 = createMockJob({ id: 'job-2', status: 'draft' });

      vi.mocked(storage.getJob)
        .mockResolvedValueOnce(job1)
        .mockResolvedValueOnce(job2);

      // Start first job (it will hang on the launcher)
      const exec1 = scheduler.executeJob('job-1');
      // Start second job immediately — should be queued
      const exec2 = scheduler.executeJob('job-2');

      // Let first job finish
      resolveFirst!();
      await exec1;
      await exec2;

      // Job 2 should have been set to waiting (mutex blocked it)
      expect(storage.updateJob).toHaveBeenCalledWith('job-2', { status: 'waiting' });
    });

    it('should clear mutex even when executeJob throws', async () => {
      vi.mocked(storage.getJob).mockResolvedValueOnce(null); // Will throw "not found"

      await expect(scheduler.executeJob('missing')).rejects.toThrow();

      // Mutex should be cleared — next executeJob should work
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-2', status: 'draft' }));
      await scheduler.executeJob('job-2');
      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-2',
        expect.objectContaining({ status: 'running' })
      );
    });
  });

  describe('recoverStaleRunningJob — additional coverage', () => {
    it('should emit status change event when failing stale job', async () => {
      const staleJob = createMockJob({ id: 'stale-1', status: 'running' });
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentJobId: 'stale-1' })
      );
      vi.mocked(storage.getJob).mockResolvedValue(staleJob);
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.recoverStaleRunningJob();

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'stale-1',
          previousStatus: 'running',
          newStatus: 'failed',
        })
      );
    });

    it('should emit state change event when clearing currentJobId', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentJobId: 'gone-1' })
      );
      vi.mocked(storage.getJob).mockResolvedValue(null);
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.recoverStaleRunningJob();

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ currentJobId: null })
      );
    });

    it('should not mark job as failed if it is already in a terminal status', async () => {
      const completedJob = createMockJob({ id: 'done-1', status: 'completed' });
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentJobId: 'done-1' })
      );
      vi.mocked(storage.getJob).mockResolvedValue(completedJob);
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.recoverStaleRunningJob();

      // Should NOT update the completed job to failed
      expect(storage.updateJob).not.toHaveBeenCalled();
      // But SHOULD clear the stale currentJobId
      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentJobId: null });
    });
  });

  // =========================================================================
  // showJobStartNotification (private)
  // =========================================================================

  describe('showJobStartNotification (private)', () => {
    it('should delegate to notification handler', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      scheduler.setNotificationHandler(handler);
      const job = createMockJob({ input: 'Hello' });

      await (scheduler as any).showJobStartNotification(job);

      expect(handler).toHaveBeenCalledWith(job);
    });

    it('should not throw when notification handler fails', async () => {
      scheduler.setNotificationHandler(vi.fn().mockRejectedValue(new Error('No permission')));
      const job = createMockJob();

      await expect(
        (scheduler as any).showJobStartNotification(job)
      ).resolves.toBeUndefined();
    });

    it('should be a no-op when no handler is set', async () => {
      // Create scheduler without notification handler
      const s = new Scheduler(storage, alarms);
      const job = createMockJob();

      await expect(
        (s as any).showJobStartNotification(job)
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // launchJob (private)
  // =========================================================================

  describe('launchJob (private)', () => {
    it('should delegate to job launcher callback', async () => {
      const launcher = vi.fn().mockResolvedValue(undefined);
      scheduler.setJobLauncher(launcher);

      await (scheduler as any).launchJob('job-42', 'session-99');

      expect(launcher).toHaveBeenCalledWith('job-42', 'session-99');
    });

    it('should warn when no job launcher is set', async () => {
      const s = new Scheduler(storage, alarms);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await (s as any).launchJob('t1', 's1');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('No job launcher configured')
      );
    });
  });

  // =========================================================================
  // completeJob
  // =========================================================================

  describe('completeJob', () => {
    const result = createMockJobResult();

    it('should throw if job not found', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(null);
      await expect(scheduler.completeJob('missing', result)).rejects.toThrow(
        'Job not found: missing'
      );
    });

    it('should throw if job is not in running status', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'draft' }));
      await expect(scheduler.completeJob('job-1', result)).rejects.toThrow(
        'Cannot complete job in draft status'
      );
    });

    it('should clean up the agent session', async () => {
      const job = createMockJob({ id: 'job-1', status: 'running' });
      vi.mocked(storage.getJob).mockResolvedValue(job);
      (scheduler as any).jobSessions.set('job-1', 'session-x');

      await scheduler.completeJob('job-1', result);

      expect(registry.removeSession).toHaveBeenCalledWith('session-x');
    });

    it('should update job with completed status and result', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));

      await scheduler.completeJob('job-1', result);

      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          status: 'completed',
          completedAt: expect.any(Number),
          result,
        })
      );
    });

    it('should clear currentJobId from scheduler state', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));

      await scheduler.completeJob('job-1', result);

      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentJobId: null });
    });

    it('should emit status change (running -> completed)', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));

      await scheduler.completeJob('job-1', result);

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          previousStatus: 'running',
          newStatus: 'completed',
        })
      );
    });

    it('should process the queue after completion', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.completeJob('job-1', result);

      // processJobQueue should be called, which calls getSchedulerState
      expect(storage.getSchedulerState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // failJob
  // =========================================================================

  describe('failJob', () => {
    it('should throw if job not found', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(null);
      await expect(scheduler.failJob('missing', 'err')).rejects.toThrow('Job not found: missing');
    });

    it('should throw if job is not running', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'scheduled' }));
      await expect(scheduler.failJob('job-1', 'err')).rejects.toThrow(
        'Cannot fail job in scheduled status'
      );
    });

    it('should clean up the agent session', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));
      (scheduler as any).jobSessions.set('job-1', 'session-y');

      await scheduler.failJob('job-1', 'Something broke');

      expect(registry.removeSession).toHaveBeenCalledWith('session-y');
    });

    it('should update job with failed status and error', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));

      await scheduler.failJob('job-1', 'Timeout exceeded');

      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          status: 'failed',
          completedAt: expect.any(Number),
          error: 'Timeout exceeded',
        })
      );
    });

    it('should clear currentJobId from scheduler state', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));

      await scheduler.failJob('job-1', 'err');

      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentJobId: null });
    });

    it('should emit status change (running -> failed)', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));

      await scheduler.failJob('job-1', 'err');

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          previousStatus: 'running',
          newStatus: 'failed',
        })
      );
    });

    it('should process the queue after failure', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.failJob('job-1', 'err');

      expect(storage.getSchedulerState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // cancelJob
  // =========================================================================

  describe('cancelJob', () => {
    it('should throw if job not found', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(null);
      await expect(scheduler.cancelJob('missing')).rejects.toThrow('Job not found: missing');
    });

    it('should throw if job is already completed', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'completed' }));
      await expect(scheduler.cancelJob('job-1')).rejects.toThrow(
        'Cannot cancel job in completed status'
      );
    });

    it('should throw if job is already failed', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'failed' }));
      await expect(scheduler.cancelJob('job-1')).rejects.toThrow(
        'Cannot cancel job in failed status'
      );
    });

    it('should throw if job is already cancelled', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'cancelled' }));
      await expect(scheduler.cancelJob('job-1')).rejects.toThrow(
        'Cannot cancel job in cancelled status'
      );
    });

    it('should clear alarm when cancelling a scheduled job', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'scheduled' }));

      await scheduler.cancelJob('job-1');

      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('job-1');
    });

    it('should not clear alarm for non-scheduled jobs', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ status: 'draft' }));

      await scheduler.cancelJob('job-1');

      expect(alarms.clearJobAlarm).not.toHaveBeenCalled();
    });

    it('should clean up session and clear state when cancelling a running job', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: 'job-1' }));
      (scheduler as any).jobSessions.set('job-1', 'session-z');

      await scheduler.cancelJob('job-1');

      expect(registry.removeSession).toHaveBeenCalledWith('session-z');
      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentJobId: null });
    });

    it('should update job status to cancelled with completedAt', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'draft' }));

      await scheduler.cancelJob('job-1');

      expect(storage.updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          status: 'cancelled',
          completedAt: expect.any(Number),
        })
      );
    });

    it('should emit status change event', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'waiting' }));

      await scheduler.cancelJob('job-1');

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          previousStatus: 'waiting',
          newStatus: 'cancelled',
        })
      );
    });

    it('should process queue after cancelling a running job', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'running' }));
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.cancelJob('job-1');

      // processJobQueue should have been called
      // It calls getSchedulerState at least once for the emitStateChange in cancelJob,
      // and once more for processJobQueue
      expect(storage.getSchedulerState).toHaveBeenCalled();
    });

    it('should not process queue after cancelling a non-running job', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-1', status: 'draft' }));
      // Reset to track only calls after cancel
      vi.mocked(storage.getSchedulerState).mockClear();

      await scheduler.cancelJob('job-1');

      // getSchedulerState should NOT be called for processJobQueue
      // (it may be called for emitStateChange, but only if status was running)
      expect(storage.getNextJobInQueue).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // processJobQueue
  // =========================================================================

  describe('processJobQueue', () => {
    it('should not process when paused', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ isPaused: true }));

      await scheduler.processJobQueue();

      expect(storage.getNextJobInQueue).not.toHaveBeenCalled();
    });

    it('should not process when offline', async () => {
      scheduler.setConnectivityCheck(() => false);
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());

      await scheduler.processJobQueue();

      expect(storage.getNextJobInQueue).not.toHaveBeenCalled();
    });

    it('should not process when a job is already running', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: 'job-x' }));

      await scheduler.processJobQueue();

      expect(storage.getNextJobInQueue).not.toHaveBeenCalled();
    });

    it('should execute next job from queue', async () => {
      const nextJob = createMockJob({ id: 'queued-1', status: 'waiting' });
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(nextJob);
      vi.mocked(storage.getJob).mockResolvedValue(nextJob);

      await scheduler.processJobQueue();

      expect(storage.updateJob).toHaveBeenCalledWith(
        'queued-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should do nothing when queue is empty', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.processJobQueue();

      expect(storage.updateJob).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // isOnline
  // =========================================================================

  describe('isOnline', () => {
    it('should return true when connectivity check returns true', () => {
      scheduler.setConnectivityCheck(() => true);
      expect(scheduler.isOnline()).toBe(true);
    });

    it('should return false when connectivity check returns false', () => {
      scheduler.setConnectivityCheck(() => false);
      expect(scheduler.isOnline()).toBe(false);
    });

    it('should default to true when no connectivity check is set', () => {
      const s = new Scheduler(storage, alarms);
      expect(s.isOnline()).toBe(true);
    });
  });

  // =========================================================================
  // pauseJobQueue
  // =========================================================================

  describe('pauseJobQueue', () => {
    it('should set isPaused to true in storage', async () => {
      await scheduler.pauseJobQueue();
      expect(storage.setSchedulerState).toHaveBeenCalledWith({ isPaused: true });
    });

    it('should stop the queue processor alarm', async () => {
      await scheduler.pauseJobQueue();
      expect(alarms.stopJobQueueProcessor).toHaveBeenCalled();
    });

    it('should emit a state change event', async () => {
      await scheduler.pauseJobQueue();
      expect(emitter).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // resumeJobQueue
  // =========================================================================

  describe('resumeJobQueue', () => {
    it('should set isPaused to false in storage', async () => {
      await scheduler.resumeJobQueue();
      expect(storage.setSchedulerState).toHaveBeenCalledWith({ isPaused: false });
    });

    it('should start the queue processor alarm', async () => {
      await scheduler.resumeJobQueue();
      expect(alarms.startJobQueueProcessor).toHaveBeenCalled();
    });

    it('should emit a state change event', async () => {
      await scheduler.resumeJobQueue();
      expect(emitter).toHaveBeenCalled();
    });

    it('should immediately process the queue after resuming', async () => {
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.resumeJobQueue();

      // processJobQueue was called => getSchedulerState was called
      expect(storage.getSchedulerState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleAlarm
  // =========================================================================

  describe('handleAlarm', () => {
    it('should ignore unrecognized alarm names', async () => {
      await scheduler.handleAlarm('some-other-alarm');
      expect(storage.getJob).not.toHaveBeenCalled();
    });

    it('should trigger a scheduled job when job alarm fires', async () => {
      const job = createMockJob({ id: 'job-abc', status: 'scheduled' });
      vi.mocked(storage.getJob)
        .mockResolvedValueOnce(job) // handleAlarm lookup
        .mockResolvedValueOnce(job) // triggerJob lookup
        .mockResolvedValueOnce(job); // executeJob lookup
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: null }));

      await scheduler.handleAlarm('scheduler-job-job-abc');

      // triggerJob should clear alarm for scheduled jobs
      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('job-abc');
    });

    it('should not trigger if job is not in scheduled status', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(createMockJob({ id: 'job-abc', status: 'completed' }));

      await scheduler.handleAlarm('scheduler-job-job-abc');

      // Should not attempt to trigger
      expect(alarms.clearJobAlarm).not.toHaveBeenCalled();
    });

    it('should not trigger if job is not found', async () => {
      vi.mocked(storage.getJob).mockResolvedValue(null);

      await scheduler.handleAlarm('scheduler-job-job-abc');

      expect(alarms.clearJobAlarm).not.toHaveBeenCalled();
    });

    it('should process queue when queue processor alarm fires', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.handleAlarm('scheduler-job-queue-processor');

      expect(storage.getSchedulerState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // detectMissedJobs
  // =========================================================================

  describe('detectMissedJobs', () => {
    it('should return empty array when no overdue jobs', async () => {
      vi.mocked(storage.getOverdueScheduledJobs).mockResolvedValue([]);

      const missed = await scheduler.detectMissedJobs();

      expect(missed).toEqual([]);
    });

    it('should mark overdue jobs as missed', async () => {
      const overdue = [
        createMockJob({ id: 't1', status: 'scheduled' }),
        createMockJob({ id: 't2', status: 'scheduled' }),
      ];
      vi.mocked(storage.getOverdueScheduledJobs).mockResolvedValue(overdue);

      await scheduler.detectMissedJobs();

      expect(storage.updateJob).toHaveBeenCalledWith('t1', { status: 'missed' });
      expect(storage.updateJob).toHaveBeenCalledWith('t2', { status: 'missed' });
    });

    it('should clear alarms for overdue jobs', async () => {
      const overdue = [createMockJob({ id: 't1', status: 'scheduled' })];
      vi.mocked(storage.getOverdueScheduledJobs).mockResolvedValue(overdue);

      await scheduler.detectMissedJobs();

      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('t1');
    });

    it('should emit status change events for each missed job', async () => {
      const overdue = [
        createMockJob({ id: 't1', status: 'scheduled' }),
        createMockJob({ id: 't2', status: 'scheduled' }),
      ];
      vi.mocked(storage.getOverdueScheduledJobs).mockResolvedValue(overdue);

      await scheduler.detectMissedJobs();

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 't1', previousStatus: 'scheduled', newStatus: 'missed' })
      );
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 't2', previousStatus: 'scheduled', newStatus: 'missed' })
      );
    });

    it('should return the list of overdue jobs', async () => {
      const overdue = [createMockJob({ id: 't1' })];
      vi.mocked(storage.getOverdueScheduledJobs).mockResolvedValue(overdue);

      const result = await scheduler.detectMissedJobs();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('t1');
    });
  });

  // =========================================================================
  // getSchedulerState
  // =========================================================================

  describe('getSchedulerState', () => {
    it('should return combined state and counts', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ isPaused: true, currentJobId: null }));
      vi.mocked(storage.getJobCounts).mockResolvedValue({
        draftCount: 2,
        scheduledCount: 3,
        missedCount: 1,
        waitingCount: 4,
        runningCount: 0,
      });

      const response = await scheduler.getSchedulerState();

      expect(response).toEqual({
        isPaused: true,
        currentJobId: null,
        draftCount: 2,
        scheduledCount: 3,
        missedCount: 1,
        jobQueueCount: 4,
        runningJob: null,
      });
    });

    it('should include running job summary when a job is running', async () => {
      const runningJob = createMockJob({
        id: 'running-1',
        input: 'Do something big',
        status: 'running',
        scheduledTime: 5000,
        createdAt: 1000,
      });
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentJobId: 'running-1' })
      );
      vi.mocked(storage.getJob).mockResolvedValue(runningJob);
      vi.mocked(storage.getJobCounts).mockResolvedValue({
        draftCount: 0,
        scheduledCount: 0,
        missedCount: 0,
        waitingCount: 0,
        runningCount: 1,
      });

      const response = await scheduler.getSchedulerState();

      expect(response.runningJob).toEqual({
        id: 'running-1',
        input: 'Do something big',
        scheduledTime: 5000,
        status: 'running',
        createdAt: 1000,
      });
    });

    it('should return null runningJob when current job not found', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentJobId: 'orphan-task' })
      );
      vi.mocked(storage.getJob).mockResolvedValue(null);
      vi.mocked(storage.getJobCounts).mockResolvedValue({
        draftCount: 0,
        scheduledCount: 0,
        missedCount: 0,
        waitingCount: 0,
        runningCount: 0,
      });

      const response = await scheduler.getSchedulerState();

      expect(response.runningJob).toBeNull();
    });
  });

  // =========================================================================
  // toJobSummary (private)
  // =========================================================================

  describe('toJobSummary (private)', () => {
    it('should truncate input to 100 characters', () => {
      const job = createMockJob({ input: 'X'.repeat(200) });
      const summary = (scheduler as any).toJobSummary(job);
      expect(summary.input).toBe('X'.repeat(100));
    });

    it('should not truncate short input', () => {
      const job = createMockJob({ input: 'Short' });
      const summary = (scheduler as any).toJobSummary(job);
      expect(summary.input).toBe('Short');
    });

    it('should include id, scheduledTime, status, and createdAt', () => {
      const job = createMockJob({
        id: 'sum-1',
        scheduledTime: 99999,
        status: 'scheduled',
        createdAt: 12345,
      });
      const summary = (scheduler as any).toJobSummary(job);
      expect(summary).toEqual({
        id: 'sum-1',
        input: 'Test job input',
        scheduledTime: 99999,
        status: 'scheduled',
        createdAt: 12345,
      });
    });
  });

  // =========================================================================
  // emitStatusChange (private)
  // =========================================================================

  describe('emitStatusChange (private)', () => {
    it('should call emitter with correct event payload', () => {
      (scheduler as any).emitStatusChange('job-1', 'draft', 'running');

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          previousStatus: 'draft',
          newStatus: 'running',
          timestamp: expect.any(Number),
        })
      );
    });

    it('should not throw when emitter is null', () => {
      const s = new Scheduler(storage, alarms);
      // No emitter set
      expect(() => (s as any).emitStatusChange('t', 'draft', 'running')).not.toThrow();
    });
  });

  // =========================================================================
  // emitStateChange (private)
  // =========================================================================

  describe('emitStateChange (private)', () => {
    it('should emit state with isPaused and currentJobId', () => {
      (scheduler as any).emitStateChange({ isPaused: true, currentJobId: 'job-x' });

      expect(emitter).toHaveBeenCalledWith({
        isPaused: true,
        currentJobId: 'job-x',
      });
    });

    it('should not throw when emitter is null', () => {
      const s = new Scheduler(storage, alarms);
      expect(() => (s as any).emitStateChange({ isPaused: false, currentJobId: null })).not.toThrow();
    });

    it('should not emit when no state argument is provided', () => {
      (scheduler as any).emitStateChange();
      expect(emitter).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // cleanupJobSession (private)
  // =========================================================================

  describe('cleanupJobSession (private)', () => {
    it('should remove session from registry and jobSessions map', async () => {
      (scheduler as any).jobSessions.set('job-1', 'session-abc');

      await (scheduler as any).cleanupJobSession('job-1');

      expect(registry.removeSession).toHaveBeenCalledWith('session-abc');
      expect((scheduler as any).jobSessions.has('job-1')).toBe(false);
    });

    it('should do nothing if no session mapping exists', async () => {
      await (scheduler as any).cleanupJobSession('job-nonexistent');
      expect(registry.removeSession).not.toHaveBeenCalled();
    });

    it('should do nothing if registry is null', async () => {
      const s = new Scheduler(storage, alarms);
      (s as any).jobSessions.set('job-1', 'session-abc');

      await (s as any).cleanupJobSession('job-1');

      // No registry, so removeSession should not be called
      expect(registry.removeSession).not.toHaveBeenCalled();
    });

    it('should not throw if removeSession fails', async () => {
      (scheduler as any).jobSessions.set('job-1', 'session-err');
      registry.removeSession.mockRejectedValue(new Error('Cleanup failed'));

      await expect(
        (scheduler as any).cleanupJobSession('job-1')
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Integration-like scenarios
  // =========================================================================

  describe('end-to-end scenarios', () => {
    it('should handle full job lifecycle: schedule -> execute -> complete', async () => {
      const futureTime = Date.now() + 60000;
      const job = createMockJob({ id: 'lifecycle-1', status: 'scheduled', scheduledTime: futureTime });

      // Schedule
      vi.mocked(storage.createJob).mockResolvedValue(job);
      const id = await scheduler.scheduleJob('Full lifecycle', futureTime);
      expect(id).toBe('lifecycle-1');

      // Alarm fires -> triggerJob
      vi.mocked(storage.getJob).mockResolvedValue(job);
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentJobId: null }));

      // triggerJob -> executeJob chain: getJob is called twice
      vi.mocked(storage.getJob)
        .mockResolvedValueOnce(job) // handleAlarm -> triggerJob lookup
        .mockResolvedValueOnce(job); // triggerJob -> executeJob lookup

      await scheduler.handleAlarm('scheduler-job-lifecycle-1');

      // Complete
      const runningJob = { ...job, status: 'running' as const };
      vi.mocked(storage.getJob).mockResolvedValue(runningJob);
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.completeJob('lifecycle-1', createMockJobResult());

      expect(storage.updateJob).toHaveBeenCalledWith(
        'lifecycle-1',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('should handle queue draining: complete first -> execute second', async () => {
      // First job running, second in queue
      const job1 = createMockJob({ id: 't1', status: 'running' });
      const job2 = createMockJob({ id: 't2', status: 'waiting' });

      // Complete job 1
      vi.mocked(storage.getJob).mockResolvedValueOnce(job1); // completeJob lookup
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(job2);

      // After clearing current job, processQueue finds job2
      vi.mocked(storage.getSchedulerState)
        .mockResolvedValueOnce(createMockState()) // emitStateChange in completeJob
        .mockResolvedValueOnce(createMockState({ currentJobId: null })); // processJobQueue

      // executeJob will call getJob for job2
      vi.mocked(storage.getJob).mockResolvedValueOnce(job2);

      await scheduler.completeJob('t1', createMockJobResult());

      // Job 2 should have been started
      expect(storage.updateJob).toHaveBeenCalledWith(
        't2',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should handle cancelling a scheduled job and scheduling a new one', async () => {
      const scheduledJob = createMockJob({ id: 'sched-1', status: 'scheduled' });
      vi.mocked(storage.getJob).mockResolvedValue(scheduledJob);

      // Cancel
      await scheduler.cancelJob('sched-1');
      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('sched-1');
      expect(storage.updateJob).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ status: 'cancelled' })
      );

      // Schedule a new one
      const futureTime = Date.now() + 120000;
      const newJob = createMockJob({ id: 'sched-2' });
      vi.mocked(storage.createJob).mockResolvedValue(newJob);

      await scheduler.scheduleJob('New scheduled job', futureTime);
      expect(alarms.createJobAlarm).toHaveBeenCalledWith('sched-2', futureTime);
    });
  });

  // =========================================================================
  // recoverStaleRunningJob
  // =========================================================================

  describe('recoverStaleRunningJob', () => {
    it('should fail a stale running job and clear currentJobId', async () => {
      const staleJob = createMockJob({ id: 'stale-1', status: 'running' });
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentJobId: 'stale-1' })
      );
      vi.mocked(storage.getJob).mockResolvedValue(staleJob);
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.recoverStaleRunningJob();

      // Should fail the stale job
      expect(storage.updateJob).toHaveBeenCalledWith(
        'stale-1',
        expect.objectContaining({
          status: 'failed',
          error: expect.stringContaining('interrupted'),
        })
      );
      // Should clear currentJobId
      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentJobId: null });
    });

    it('should do nothing when no currentJobId in state', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentJobId: null })
      );

      await scheduler.recoverStaleRunningJob();

      expect(storage.updateJob).not.toHaveBeenCalled();
      expect(storage.setSchedulerState).not.toHaveBeenCalled();
    });

    it('should clear stale currentJobId when job no longer exists', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentJobId: 'gone-1' })
      );
      vi.mocked(storage.getJob).mockResolvedValue(null);
      vi.mocked(storage.getNextJobInQueue).mockResolvedValue(null);

      await scheduler.recoverStaleRunningJob();

      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentJobId: null });
    });

    it('should drain the queue after recovering a stale job', async () => {
      const staleJob = createMockJob({ id: 'stale-2', status: 'running' });
      const waitingJob = createMockJob({ id: 'waiting-1', status: 'waiting' });

      vi.mocked(storage.getSchedulerState)
        .mockResolvedValueOnce(createMockState({ currentJobId: 'stale-2' })) // recoverStaleRunningJob reads state
        .mockResolvedValueOnce(createMockState({ currentJobId: null })); // processJobQueue reads state

      vi.mocked(storage.getJob)
        .mockResolvedValueOnce(staleJob) // recover reads stale job
        .mockResolvedValueOnce(waitingJob); // executeJob reads next job

      vi.mocked(storage.getNextJobInQueue).mockResolvedValueOnce(waitingJob);

      await scheduler.recoverStaleRunningJob();

      // Should have started the waiting job
      expect(storage.updateJob).toHaveBeenCalledWith(
        'waiting-1',
        expect.objectContaining({ status: 'running' })
      );
    });
  });
});
