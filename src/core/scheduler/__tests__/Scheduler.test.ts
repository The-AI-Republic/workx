/**
 * Tests for Scheduler (Facade)
 *
 * Tests the main orchestrator that delegates to ScheduleManager + JobExecutor.
 * New constructor: (scheduleManager, jobExecutor, alarms)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scheduler } from '@/core/scheduler/Scheduler';
import type { ISchedulerAlarms } from '@/core/models/types/SchedulerContracts';
import type { ScheduleEvent } from '@/core/models/types/ScheduleEvent';

// Mock rruleAdapter
const mockRecurrenceRuleToRRule = vi.hoisted(() => vi.fn());
vi.mock('../rruleAdapter', () => ({
  recurrenceRuleToRRule: mockRecurrenceRuleToRRule,
}));

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockScheduleManager() {
  return {
    createEvent: vi.fn().mockResolvedValue({ id: 'evt-1', input: 'Test', scheduledTime: Date.now() + 3600000, rrule: null, enabled: true, exdates: [], createdAt: Date.now(), updatedAt: Date.now() }),
    editSeries: vi.fn(),
    deleteEvent: vi.fn(),
    setEnabled: vi.fn(),
    getEvent: vi.fn().mockResolvedValue(null),
    getAllEvents: vi.fn().mockResolvedValue([]),
    getScheduledEvents: vi.fn().mockResolvedValue([]),
    getMissedInstances: vi.fn().mockResolvedValue([]),
    getInstancesInRange: vi.fn().mockResolvedValue([]),
    handleAlarmFired: vi.fn(),
    restoreAlarms: vi.fn(),
    armNextAlarm: vi.fn(),
    setAlarmFiredHandler: vi.fn(),
  };
}

function createMockJobExecutor() {
  return {
    execute: vi.fn().mockResolvedValue('exec-1'),
    completeExecution: vi.fn(),
    failExecution: vi.fn(),
    cancelExecution: vi.fn(),
    processQueue: vi.fn(),
    recoverStaleExecutions: vi.fn(),
    getExecutionHistory: vi.fn().mockResolvedValue([]),
    isOnline: vi.fn().mockReturnValue(true),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    getPauseState: vi.fn().mockReturnValue(false),
    setRegistry: vi.fn(),
    setEventEmitter: vi.fn(),
    setNotificationHandler: vi.fn(),
    setJobLauncher: vi.fn(),
    setConnectivityCheck: vi.fn(),
    setExecutionCompleteHandler: vi.fn(),
    executionStorage: {
      getExecutionsByStatus: vi.fn().mockResolvedValue([]),
      getRunningExecutions: vi.fn().mockResolvedValue([]),
      getExecution: vi.fn().mockResolvedValue(null),
      getArchivedExecutions: vi.fn().mockResolvedValue([]),
      getArchivedExecutionsCount: vi.fn().mockResolvedValue(0),
    },
  };
}

function createMockAlarms(): ISchedulerAlarms {
  return {
    createJobAlarm: vi.fn(),
    clearJobAlarm: vi.fn(),
    hasJobAlarm: vi.fn(),
    startJobQueueProcessor: vi.fn(),
    stopJobQueueProcessor: vi.fn(),
    getAllAlarms: vi.fn().mockResolvedValue([]),
  };
}

function createTestEvent(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: 'evt-1',
    input: 'Test event input',
    scheduledTime: Date.now() + 3600000,
    rrule: null,
    enabled: true,
    exdates: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let scheduleManager: ReturnType<typeof createMockScheduleManager>;
  let jobExecutor: ReturnType<typeof createMockJobExecutor>;
  let alarms: ReturnType<typeof createMockAlarms>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecurrenceRuleToRRule.mockReturnValue('FREQ=DAILY;INTERVAL=1');
    scheduleManager = createMockScheduleManager();
    jobExecutor = createMockJobExecutor();
    alarms = createMockAlarms();
    scheduler = new Scheduler(scheduleManager as any, jobExecutor as any, alarms);
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should wire alarm fired handler from ScheduleManager to JobExecutor', () => {
      expect(scheduleManager.setAlarmFiredHandler).toHaveBeenCalledOnce();
    });

    it('should wire execution complete handler from JobExecutor to ScheduleManager', () => {
      expect(jobExecutor.setExecutionCompleteHandler).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // Accessors
  // ==========================================================================

  describe('accessors', () => {
    it('should return ScheduleManager', () => {
      expect(scheduler.getScheduleManager()).toBe(scheduleManager);
    });

    it('should return JobExecutor', () => {
      expect(scheduler.getJobExecutor()).toBe(jobExecutor);
    });
  });

  // ==========================================================================
  // scheduleJob
  // ==========================================================================

  describe('scheduleJob', () => {
    it('should create a ScheduleEvent via ScheduleManager', async () => {
      const jobId = await scheduler.scheduleJob('Test job', Date.now() + 3600000);
      expect(jobId).toBe('evt-1');
      expect(scheduleManager.createEvent).toHaveBeenCalledWith(
        'Test job',
        expect.any(Number),
        null,
      );
    });

    it('should convert RecurrenceRule to RRULE string', async () => {
      const recurrence = { mode: 'daily' as const, endCondition: 'never' as const };
      await scheduler.scheduleJob('Daily task', Date.now() + 3600000, recurrence);
      expect(scheduleManager.createEvent).toHaveBeenCalledWith(
        'Daily task',
        expect.any(Number),
        'FREQ=DAILY;INTERVAL=1',
      );
    });
  });

  // ==========================================================================
  // triggerJob
  // ==========================================================================

  describe('triggerJob', () => {
    it('should find event and execute immediately', async () => {
      const event = createTestEvent();
      scheduleManager.getEvent.mockResolvedValue(event);

      await scheduler.triggerJob('evt-1');

      expect(scheduleManager.getEvent).toHaveBeenCalledWith('evt-1');
      expect(jobExecutor.execute).toHaveBeenCalledWith('evt-1', expect.any(Number), event.input);
    });

    it('should throw for non-existent event', async () => {
      scheduleManager.getEvent.mockResolvedValue(null);

      await expect(scheduler.triggerJob('nope')).rejects.toThrow('Schedule event not found');
    });
  });

  // ==========================================================================
  // cancelJob
  // ==========================================================================

  describe('cancelJob', () => {
    it('should try cancelling as execution first', async () => {
      jobExecutor.cancelExecution.mockResolvedValue(undefined);

      await scheduler.cancelJob('exec-1');

      expect(jobExecutor.cancelExecution).toHaveBeenCalledWith('exec-1');
    });

    it('should fall back to disabling schedule event', async () => {
      jobExecutor.cancelExecution.mockRejectedValue(new Error('not found'));
      const event = createTestEvent();
      scheduleManager.getEvent.mockResolvedValue(event);

      await scheduler.cancelJob('evt-1');

      expect(scheduleManager.setEnabled).toHaveBeenCalledWith('evt-1', false);
      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('evt-1');
    });

    it('should throw when neither execution nor event found', async () => {
      jobExecutor.cancelExecution.mockRejectedValue(new Error('not found'));
      scheduleManager.getEvent.mockResolvedValue(null);

      await expect(scheduler.cancelJob('unknown')).rejects.toThrow('Not found');
    });
  });

  // ==========================================================================
  // completeJob / failJob
  // ==========================================================================

  describe('completeJob', () => {
    it('should delegate to JobExecutor', async () => {
      const result = { summary: 'Done', tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, duration: 100 };
      await scheduler.completeJob('exec-1', result);
      expect(jobExecutor.completeExecution).toHaveBeenCalledWith('exec-1', result);
    });
  });

  describe('failJob', () => {
    it('should delegate to JobExecutor', async () => {
      await scheduler.failJob('exec-1', 'Something broke');
      expect(jobExecutor.failExecution).toHaveBeenCalledWith('exec-1', 'Something broke');
    });
  });

  // ==========================================================================
  // rescheduleJob
  // ==========================================================================

  describe('rescheduleJob', () => {
    it('should delegate to ScheduleManager.editSeries', async () => {
      const newTime = Date.now() + 7200000;
      await scheduler.rescheduleJob('evt-1', newTime);
      expect(scheduleManager.editSeries).toHaveBeenCalledWith('evt-1', { scheduledTime: newTime });
    });
  });

  // ==========================================================================
  // handleAlarm
  // ==========================================================================

  describe('handleAlarm', () => {
    it('should route job alarm to ScheduleManager', async () => {
      await scheduler.handleAlarm('scheduler-job-evt-1');
      expect(scheduleManager.handleAlarmFired).toHaveBeenCalledWith('evt-1');
    });

    it('should route queue processor alarm to JobExecutor', async () => {
      await scheduler.handleAlarm('scheduler-job-queue-processor');
      expect(jobExecutor.processQueue).toHaveBeenCalled();
    });

    it('should ignore unknown alarm names', async () => {
      await scheduler.handleAlarm('unrelated-alarm');
      expect(scheduleManager.handleAlarmFired).not.toHaveBeenCalled();
      expect(jobExecutor.processQueue).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Queue Control
  // ==========================================================================

  describe('pauseJobQueue', () => {
    it('should pause executor and stop processor alarm', async () => {
      await scheduler.pauseJobQueue();
      expect(jobExecutor.pauseQueue).toHaveBeenCalled();
      expect(alarms.stopJobQueueProcessor).toHaveBeenCalled();
    });
  });

  describe('resumeJobQueue', () => {
    it('should resume executor, start processor alarm, and process queue', async () => {
      await scheduler.resumeJobQueue();
      expect(jobExecutor.resumeQueue).toHaveBeenCalled();
      expect(alarms.startJobQueueProcessor).toHaveBeenCalled();
      expect(jobExecutor.processQueue).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Startup / Recovery
  // ==========================================================================

  describe('recoverStaleRunningJob', () => {
    it('should delegate to JobExecutor', async () => {
      await scheduler.recoverStaleRunningJob();
      expect(jobExecutor.recoverStaleExecutions).toHaveBeenCalled();
    });
  });

  describe('detectMissedJobs', () => {
    it('should delegate to ScheduleManager', async () => {
      const missed = [{ event: createTestEvent(), instanceTime: Date.now() - 1000 }];
      scheduleManager.getMissedInstances.mockResolvedValue(missed);

      const result = await scheduler.detectMissedJobs();
      expect(result).toEqual(missed);
    });
  });

  describe('restoreScheduleAlarms', () => {
    it('should delegate to ScheduleManager', async () => {
      await scheduler.restoreScheduleAlarms();
      expect(scheduleManager.restoreAlarms).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // State Queries
  // ==========================================================================

  describe('getSchedulerState', () => {
    it('should build state from new model queries', async () => {
      jobExecutor.getPauseState.mockReturnValue(false);
      scheduleManager.getScheduledEvents.mockResolvedValue([createTestEvent()]);
      scheduleManager.getMissedInstances.mockResolvedValue([]);

      const state = await scheduler.getSchedulerState();

      expect(state.isPaused).toBe(false);
      expect(state.draftCount).toBe(0);
      expect(state.scheduledCount).toBe(1);
      expect(state.missedCount).toBe(0);
    });

    it('should include running job info', async () => {
      const running = {
        id: 'exec-1',
        scheduleEventId: 'evt-1',
        instanceTime: Date.now(),
        input: 'Running task',
        sessionId: 'session-1',
        status: 'running',
        result: null,
        error: null,
        startedAt: Date.now(),
        completedAt: null,
      };
      jobExecutor.executionStorage.getRunningExecutions.mockResolvedValue([running]);

      const state = await scheduler.getSchedulerState();

      expect(state.currentJobId).toBe('exec-1');
      expect(state.runningJob).not.toBeNull();
      expect(state.runningJob?.status).toBe('running');
    });
  });

  describe('getScheduledJobs', () => {
    it('should return scheduled events as job summaries', async () => {
      scheduleManager.getScheduledEvents.mockResolvedValue([createTestEvent()]);

      const jobs = await scheduler.getScheduledJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('scheduled');
      expect(jobs[0].id).toBe('evt-1');
    });
  });

  describe('getMissedJobs', () => {
    it('should return missed instances as job summaries', async () => {
      scheduleManager.getMissedInstances.mockResolvedValue([
        { event: createTestEvent(), instanceTime: Date.now() - 1000 },
      ]);

      const jobs = await scheduler.getMissedJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('missed');
    });
  });

  describe('getJobQueue', () => {
    it('should return pending executions as job summaries', async () => {
      jobExecutor.executionStorage.getExecutionsByStatus.mockResolvedValue([
        { id: 'exec-1', input: 'Queued task', instanceTime: Date.now(), status: 'pending' },
      ]);

      const jobs = await scheduler.getJobQueue();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('waiting');
    });
  });

  describe('getArchivedJobs', () => {
    it('should return archived executions with pagination', async () => {
      jobExecutor.executionStorage.getArchivedExecutions.mockResolvedValue([
        { id: 'exec-1', input: 'Done', instanceTime: Date.now(), status: 'completed', completedAt: Date.now(), sessionId: null, error: null },
      ]);
      jobExecutor.executionStorage.getArchivedExecutionsCount.mockResolvedValue(1);

      const result = await scheduler.getArchivedJobs(50, 0);

      expect(result.jobs).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('getJobDetails', () => {
    it('should return schedule event details', async () => {
      scheduleManager.getEvent.mockResolvedValue(createTestEvent());

      const details = await scheduler.getJobDetails('evt-1');

      expect(details).not.toBeNull();
      expect((details as any).status).toBe('scheduled');
    });

    it('should return execution details if not a schedule event', async () => {
      scheduleManager.getEvent.mockResolvedValue(null);
      jobExecutor.executionStorage.getExecution.mockResolvedValue({
        id: 'exec-1',
        input: 'Test',
        instanceTime: Date.now(),
        status: 'completed',
        sessionId: 'session-1',
        completedAt: Date.now(),
        error: null,
      });

      const details = await scheduler.getJobDetails('exec-1');

      expect(details).not.toBeNull();
      expect((details as any).status).toBe('completed');
    });

    it('should return null when nothing found', async () => {
      scheduleManager.getEvent.mockResolvedValue(null);
      jobExecutor.executionStorage.getExecution.mockResolvedValue(null);

      const details = await scheduler.getJobDetails('nope');
      expect(details).toBeNull();
    });
  });

  describe('getAllJobsInRange', () => {
    it('should return calendar instances as summaries', async () => {
      scheduleManager.getInstancesInRange.mockResolvedValue([
        { scheduleEventId: 'evt-1', instanceTime: Date.now(), input: 'Test', status: 'upcoming' },
      ]);

      const jobs = await scheduler.getAllJobsInRange(Date.now() - 86400000, Date.now() + 86400000);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('upcoming');
    });
  });

  // ==========================================================================
  // Configuration setters
  // ==========================================================================

  describe('setters', () => {
    it('should pass registry to JobExecutor', () => {
      const registry = {} as any;
      scheduler.setRegistry(registry);
      expect(jobExecutor.setRegistry).toHaveBeenCalledWith(registry);
    });

    it('should wire event emitter to JobExecutor', () => {
      const emitter = vi.fn();
      scheduler.setEventEmitter(emitter);
      expect(jobExecutor.setEventEmitter).toHaveBeenCalledOnce();
    });

    it('should wire notification handler to JobExecutor', () => {
      const handler = vi.fn();
      scheduler.setNotificationHandler(handler);
      expect(jobExecutor.setNotificationHandler).toHaveBeenCalledOnce();
    });

    it('should wire job launcher to JobExecutor', () => {
      const launcher = vi.fn();
      scheduler.setJobLauncher(launcher);
      expect(jobExecutor.setJobLauncher).toHaveBeenCalledOnce();
    });

    it('should wire connectivity check to JobExecutor', () => {
      const check = () => true;
      scheduler.setConnectivityCheck(check);
      expect(jobExecutor.setConnectivityCheck).toHaveBeenCalledWith(check);
    });
  });
});
