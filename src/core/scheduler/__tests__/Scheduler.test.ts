/**
 * Comprehensive unit tests for Scheduler
 *
 * Tests the main orchestrator for scheduled task execution:
 * - Constructor and initialization
 * - Task lifecycle (create, schedule, trigger, execute, complete, fail, cancel)
 * - Queue processing
 * - Alarm handling
 * - Missed task detection
 * - AgentRegistry integration (Feature 015)
 * - Chrome API interactions (notifications, tabs)
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scheduler } from '@/core/scheduler/Scheduler';
import type { SchedulerTaskRecord, SchedulerState, TaskResultRecord } from '@/core/models/types/Scheduler';
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

function createMockTask(overrides: Partial<SchedulerTaskRecord> = {}): SchedulerTaskRecord {
  return {
    id: 'task-1',
    input: 'Test task input',
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
    currentTaskId: null,
    lastProcessedTime: 0,
    ...overrides,
  };
}

function createMockResult(): TaskResultRecord {
  return {
    summary: 'Task completed successfully',
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    duration: 5000,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockStorage(): ISchedulerStorage & {
  getTaskCounts: ReturnType<typeof vi.fn>;
} {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    getDraftTasks: vi.fn(),
    getScheduledTasks: vi.fn(),
    getMissedTasks: vi.fn(),
    getSchedulerTaskQueueTasks: vi.fn(),
    getArchivedTasks: vi.fn(),
    getNextTaskInSchedulerTaskQueue: vi.fn(),
    getOverdueScheduledTasks: vi.fn(),
    getSchedulerState: vi.fn(),
    setSchedulerState: vi.fn(),
    // SchedulerStorage-specific method accessed via cast
    getTaskCounts: vi.fn(),
  };
}

function createMockAlarms(): ISchedulerAlarms {
  return {
    createTaskAlarm: vi.fn(),
    clearTaskAlarm: vi.fn(),
    hasTaskAlarm: vi.fn(),
    startSchedulerTaskQueueProcessor: vi.fn(),
    stopSchedulerTaskQueueProcessor: vi.fn(),
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
    vi.mocked(storage.getTaskCounts).mockResolvedValue({
      draftCount: 0,
      scheduledCount: 0,
      missedCount: 0,
      waitingCount: 0,
      runningCount: 0,
    });

    scheduler = new Scheduler(storage, alarms);
    scheduler.setEventEmitter(emitter);
    scheduler.setRegistry(registry as any);

    // Add chrome.notifications mock (not present in global setup)
    (globalThis as any).chrome.notifications = {
      create: vi.fn().mockResolvedValue(undefined),
    };

    // Ensure chrome.runtime.getURL is available
    (globalThis as any).chrome.runtime.getURL = vi.fn(
      (path: string) => `chrome-extension://test-extension-id/${path}`
    );

    // Ensure chrome.tabs.create is available
    (globalThis as any).chrome.tabs.create = vi.fn().mockResolvedValue({ id: 1 });

    // Default: online
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
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

    it('should have empty taskSessions map', () => {
      const s = new Scheduler(storage, alarms);
      expect((s as any).taskSessions.size).toBe(0);
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
  // createDraftTask
  // =========================================================================

  describe('createDraftTask', () => {
    it('should create a draft task and return its id', async () => {
      const task = createMockTask({ id: 'draft-1' });
      vi.mocked(storage.createTask).mockResolvedValue(task);

      const id = await scheduler.createDraftTask('Write a report');
      expect(id).toBe('draft-1');
      expect(storage.createTask).toHaveBeenCalledWith('Write a report');
    });

    it('should not set an alarm for draft tasks', async () => {
      vi.mocked(storage.createTask).mockResolvedValue(createMockTask());
      await scheduler.createDraftTask('Draft task');
      expect(alarms.createTaskAlarm).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // scheduleTask
  // =========================================================================

  describe('scheduleTask', () => {
    it('should create a task with a scheduled time', async () => {
      const futureTime = Date.now() + 60000;
      const task = createMockTask({ id: 'sched-1', scheduledTime: futureTime, status: 'scheduled' });
      vi.mocked(storage.createTask).mockResolvedValue(task);

      const id = await scheduler.scheduleTask('Run analysis', futureTime);
      expect(id).toBe('sched-1');
      expect(storage.createTask).toHaveBeenCalledWith('Run analysis', futureTime);
    });

    it('should create an alarm for the scheduled task', async () => {
      const futureTime = Date.now() + 60000;
      const task = createMockTask({ id: 'sched-2', scheduledTime: futureTime });
      vi.mocked(storage.createTask).mockResolvedValue(task);

      await scheduler.scheduleTask('Scheduled task', futureTime);
      expect(alarms.createTaskAlarm).toHaveBeenCalledWith('sched-2', futureTime);
    });

    it('should throw if scheduled time is in the past', async () => {
      const pastTime = Date.now() - 1000;
      await expect(scheduler.scheduleTask('Late task', pastTime)).rejects.toThrow(
        'Scheduled time must be in the future'
      );
    });

    it('should throw if scheduled time is equal to now', async () => {
      const now = Date.now();
      // scheduledTime <= now should throw
      await expect(scheduler.scheduleTask('Now task', now)).rejects.toThrow(
        'Scheduled time must be in the future'
      );
    });

    it('should not create an alarm if time validation fails', async () => {
      const pastTime = Date.now() - 5000;
      await expect(scheduler.scheduleTask('Fail', pastTime)).rejects.toThrow();
      expect(alarms.createTaskAlarm).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // scheduleExistingTask
  // =========================================================================

  describe('scheduleExistingTask', () => {
    it('should schedule a draft task', async () => {
      const futureTime = Date.now() + 60000;
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'draft' }));

      await scheduler.scheduleExistingTask('task-1', futureTime);

      expect(storage.updateTask).toHaveBeenCalledWith('task-1', {
        scheduledTime: futureTime,
        status: 'scheduled',
      });
      expect(alarms.createTaskAlarm).toHaveBeenCalledWith('task-1', futureTime);
    });

    it('should emit a status change event (draft -> scheduled)', async () => {
      const futureTime = Date.now() + 60000;
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'draft' }));

      await scheduler.scheduleExistingTask('task-1', futureTime);

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          previousStatus: 'draft',
          newStatus: 'scheduled',
        })
      );
    });

    it('should throw if task is not found', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(null);
      await expect(scheduler.scheduleExistingTask('missing', Date.now() + 60000)).rejects.toThrow(
        'Task not found: missing'
      );
    });

    it('should throw if task is not in draft status', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'running' }));
      await expect(scheduler.scheduleExistingTask('task-1', Date.now() + 60000)).rejects.toThrow(
        'Cannot schedule task in running status'
      );
    });

    it('should throw if scheduled time is in the past', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'draft' }));
      await expect(scheduler.scheduleExistingTask('task-1', Date.now() - 1000)).rejects.toThrow(
        'Scheduled time must be in the future'
      );
    });
  });

  // =========================================================================
  // triggerTask
  // =========================================================================

  describe('triggerTask', () => {
    it('should throw if task not found', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(null);
      await expect(scheduler.triggerTask('missing')).rejects.toThrow('Task not found: missing');
    });

    it('should throw if task status does not allow triggering', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'running' }));
      await expect(scheduler.triggerTask('task-1')).rejects.toThrow(
        'Cannot trigger task in running status'
      );
    });

    it('should throw for completed tasks', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'completed' }));
      await expect(scheduler.triggerTask('task-1')).rejects.toThrow(
        'Cannot trigger task in completed status'
      );
    });

    it('should throw for failed tasks', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'failed' }));
      await expect(scheduler.triggerTask('task-1')).rejects.toThrow(
        'Cannot trigger task in failed status'
      );
    });

    it('should throw for cancelled tasks', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'cancelled' }));
      await expect(scheduler.triggerTask('task-1')).rejects.toThrow(
        'Cannot trigger task in cancelled status'
      );
    });

    it('should clear alarm if task was scheduled', async () => {
      const task = createMockTask({ id: 'task-1', status: 'scheduled' });
      vi.mocked(storage.getTask).mockResolvedValue(task);
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentTaskId: null }));

      await scheduler.triggerTask('task-1');
      expect(alarms.clearTaskAlarm).toHaveBeenCalledWith('task-1');
    });

    it('should not clear alarm if task was a draft', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'draft' }));
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentTaskId: null }));

      await scheduler.triggerTask('task-1');
      expect(alarms.clearTaskAlarm).not.toHaveBeenCalled();
    });

    it('should queue task as waiting if another task is running', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-2', status: 'draft' }));
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentTaskId: 'task-1' }));

      await scheduler.triggerTask('task-2');

      expect(storage.updateTask).toHaveBeenCalledWith('task-2', { status: 'waiting' });
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-2',
          previousStatus: 'draft',
          newStatus: 'waiting',
        })
      );
    });

    it('should execute immediately if no task is running', async () => {
      const task = createMockTask({ id: 'task-1', status: 'draft' });
      vi.mocked(storage.getTask)
        .mockResolvedValueOnce(task) // triggerTask lookup
        .mockResolvedValueOnce(task); // executeTask lookup
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentTaskId: null }));

      await scheduler.triggerTask('task-1');

      // executeTask should update status to running
      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should allow triggering missed tasks', async () => {
      const task = createMockTask({ id: 'task-m', status: 'missed' });
      vi.mocked(storage.getTask)
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(task);
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentTaskId: null }));

      await scheduler.triggerTask('task-m');

      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-m',
        expect.objectContaining({ status: 'running' })
      );
    });
  });

  // =========================================================================
  // executeTask
  // =========================================================================

  describe('executeTask', () => {
    it('should throw if task not found', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(null);
      await expect(scheduler.executeTask('missing')).rejects.toThrow('Task not found: missing');
    });

    it('should create an AgentSession via registry when available', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1' }));

      await scheduler.executeTask('task-1');

      expect(registry.createSession).toHaveBeenCalledWith({
        type: 'scheduled',
        scheduledTaskId: 'task-1',
      });
    });

    it('should store task-session mapping on success', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1' }));

      await scheduler.executeTask('task-1');

      expect((scheduler as any).taskSessions.get('task-1')).toBe('agent-session-1');
    });

    it('should use legacy session ID when registry.createSession fails', async () => {
      registry.createSession.mockRejectedValue(new Error('Session creation failed'));
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1' }));

      await scheduler.executeTask('task-1');

      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'running', sessionId: 'session_mock-uuid-1234' })
      );
    });

    it('should use legacy session ID when registry is null', async () => {
      const s = new Scheduler(storage, alarms);
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1' }));

      await s.executeTask('task-1');

      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ sessionId: 'session_mock-uuid-1234' })
      );
    });

    it('should use legacy session ID when canCreateSession returns false', async () => {
      registry.canCreateSession.mockReturnValue(false);
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1' }));

      await scheduler.executeTask('task-1');

      expect(registry.createSession).not.toHaveBeenCalled();
      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ sessionId: 'session_mock-uuid-1234' })
      );
    });

    it('should update task status to running', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1' }));

      await scheduler.executeTask('task-1');

      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should set scheduler state with currentTaskId', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1' }));

      await scheduler.executeTask('task-1');

      expect(storage.setSchedulerState).toHaveBeenCalledWith(
        expect.objectContaining({ currentTaskId: 'task-1' })
      );
    });

    it('should emit task status change and state change events', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'draft' }));

      await scheduler.executeTask('task-1');

      // Status change: draft -> running
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          previousStatus: 'draft',
          newStatus: 'running',
        })
      );
      // State change
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ isPaused: false, currentTaskId: null })
      );
    });

    it('should show a browser notification', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', input: 'Hello world' }));

      await scheduler.executeTask('task-1');

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        'scheduler-task-task-1',
        expect.objectContaining({
          type: 'basic',
          title: 'Scheduled Task Starting',
          message: 'Hello world',
        })
      );
    });

    it('should open a new browser tab', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1' }));

      await scheduler.executeTask('task-1');

      expect(chrome.tabs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
          url: expect.stringContaining('scheduledTask=task-1'),
        })
      );
    });
  });

  // =========================================================================
  // showTaskStartNotification (private)
  // =========================================================================

  describe('showTaskStartNotification (private)', () => {
    it('should truncate long input to 50 chars with ellipsis', async () => {
      const longInput = 'A'.repeat(80);
      const task = createMockTask({ input: longInput });

      await (scheduler as any).showTaskStartNotification(task);

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          message: 'A'.repeat(50) + '...',
        })
      );
    });

    it('should not truncate short input', async () => {
      const task = createMockTask({ input: 'Short task' });

      await (scheduler as any).showTaskStartNotification(task);

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          message: 'Short task',
        })
      );
    });

    it('should not throw when notification creation fails', async () => {
      (chrome.notifications.create as any).mockRejectedValue(new Error('No permission'));
      const task = createMockTask();

      await expect(
        (scheduler as any).showTaskStartNotification(task)
      ).resolves.toBeUndefined();
    });

    it('should use the correct notification ID format', async () => {
      const task = createMockTask({ id: 'abc-123' });

      await (scheduler as any).showTaskStartNotification(task);

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        'scheduler-task-abc-123',
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // openSchedulerTaskTab (private)
  // =========================================================================

  describe('openSchedulerTaskTab (private)', () => {
    it('should create a tab with the correct URL parameters', async () => {
      await (scheduler as any).openSchedulerTaskTab('task-42', 'session-99');

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: expect.stringContaining('scheduledTask=task-42&sessionId=session-99'),
        active: true,
      });
    });

    it('should use chrome.runtime.getURL to build the URL', async () => {
      await (scheduler as any).openSchedulerTaskTab('t1', 's1');

      expect(chrome.runtime.getURL).toHaveBeenCalledWith(
        'sidepanel/index.html?scheduledTask=t1&sessionId=s1'
      );
    });
  });

  // =========================================================================
  // completeTask
  // =========================================================================

  describe('completeTask', () => {
    const result = createMockResult();

    it('should throw if task not found', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(null);
      await expect(scheduler.completeTask('missing', result)).rejects.toThrow(
        'Task not found: missing'
      );
    });

    it('should throw if task is not in running status', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'draft' }));
      await expect(scheduler.completeTask('task-1', result)).rejects.toThrow(
        'Cannot complete task in draft status'
      );
    });

    it('should clean up the agent session', async () => {
      const task = createMockTask({ id: 'task-1', status: 'running' });
      vi.mocked(storage.getTask).mockResolvedValue(task);
      (scheduler as any).taskSessions.set('task-1', 'session-x');

      await scheduler.completeTask('task-1', result);

      expect(registry.removeSession).toHaveBeenCalledWith('session-x');
    });

    it('should update task with completed status and result', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));

      await scheduler.completeTask('task-1', result);

      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: 'completed',
          completedAt: expect.any(Number),
          result,
        })
      );
    });

    it('should clear currentTaskId from scheduler state', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));

      await scheduler.completeTask('task-1', result);

      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentTaskId: null });
    });

    it('should emit status change (running -> completed)', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));

      await scheduler.completeTask('task-1', result);

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          previousStatus: 'running',
          newStatus: 'completed',
        })
      );
    });

    it('should process the queue after completion', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(null);

      await scheduler.completeTask('task-1', result);

      // processSchedulerTaskQueue should be called, which calls getSchedulerState
      expect(storage.getSchedulerState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // failTask
  // =========================================================================

  describe('failTask', () => {
    it('should throw if task not found', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(null);
      await expect(scheduler.failTask('missing', 'err')).rejects.toThrow('Task not found: missing');
    });

    it('should throw if task is not running', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'scheduled' }));
      await expect(scheduler.failTask('task-1', 'err')).rejects.toThrow(
        'Cannot fail task in scheduled status'
      );
    });

    it('should clean up the agent session', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));
      (scheduler as any).taskSessions.set('task-1', 'session-y');

      await scheduler.failTask('task-1', 'Something broke');

      expect(registry.removeSession).toHaveBeenCalledWith('session-y');
    });

    it('should update task with failed status and error', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));

      await scheduler.failTask('task-1', 'Timeout exceeded');

      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: 'failed',
          completedAt: expect.any(Number),
          error: 'Timeout exceeded',
        })
      );
    });

    it('should clear currentTaskId from scheduler state', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));

      await scheduler.failTask('task-1', 'err');

      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentTaskId: null });
    });

    it('should emit status change (running -> failed)', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));

      await scheduler.failTask('task-1', 'err');

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          previousStatus: 'running',
          newStatus: 'failed',
        })
      );
    });

    it('should process the queue after failure', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(null);

      await scheduler.failTask('task-1', 'err');

      expect(storage.getSchedulerState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // cancelTask
  // =========================================================================

  describe('cancelTask', () => {
    it('should throw if task not found', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(null);
      await expect(scheduler.cancelTask('missing')).rejects.toThrow('Task not found: missing');
    });

    it('should throw if task is already completed', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'completed' }));
      await expect(scheduler.cancelTask('task-1')).rejects.toThrow(
        'Cannot cancel task in completed status'
      );
    });

    it('should throw if task is already failed', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'failed' }));
      await expect(scheduler.cancelTask('task-1')).rejects.toThrow(
        'Cannot cancel task in failed status'
      );
    });

    it('should throw if task is already cancelled', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'cancelled' }));
      await expect(scheduler.cancelTask('task-1')).rejects.toThrow(
        'Cannot cancel task in cancelled status'
      );
    });

    it('should clear alarm when cancelling a scheduled task', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'scheduled' }));

      await scheduler.cancelTask('task-1');

      expect(alarms.clearTaskAlarm).toHaveBeenCalledWith('task-1');
    });

    it('should not clear alarm for non-scheduled tasks', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ status: 'draft' }));

      await scheduler.cancelTask('task-1');

      expect(alarms.clearTaskAlarm).not.toHaveBeenCalled();
    });

    it('should clean up session and clear state when cancelling a running task', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));
      (scheduler as any).taskSessions.set('task-1', 'session-z');

      await scheduler.cancelTask('task-1');

      expect(registry.removeSession).toHaveBeenCalledWith('session-z');
      expect(storage.setSchedulerState).toHaveBeenCalledWith({ currentTaskId: null });
    });

    it('should update task status to cancelled with completedAt', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'draft' }));

      await scheduler.cancelTask('task-1');

      expect(storage.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: 'cancelled',
          completedAt: expect.any(Number),
        })
      );
    });

    it('should emit status change event', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'waiting' }));

      await scheduler.cancelTask('task-1');

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          previousStatus: 'waiting',
          newStatus: 'cancelled',
        })
      );
    });

    it('should process queue after cancelling a running task', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'running' }));
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(null);

      await scheduler.cancelTask('task-1');

      // processSchedulerTaskQueue should have been called
      // It calls getSchedulerState at least once for the emitStateChange in cancelTask,
      // and once more for processSchedulerTaskQueue
      expect(storage.getSchedulerState).toHaveBeenCalled();
    });

    it('should not process queue after cancelling a non-running task', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-1', status: 'draft' }));
      // Reset to track only calls after cancel
      vi.mocked(storage.getSchedulerState).mockClear();

      await scheduler.cancelTask('task-1');

      // getSchedulerState should NOT be called for processSchedulerTaskQueue
      // (it may be called for emitStateChange, but only if status was running)
      expect(storage.getNextTaskInSchedulerTaskQueue).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // processSchedulerTaskQueue
  // =========================================================================

  describe('processSchedulerTaskQueue', () => {
    it('should not process when paused', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ isPaused: true }));

      await scheduler.processSchedulerTaskQueue();

      expect(storage.getNextTaskInSchedulerTaskQueue).not.toHaveBeenCalled();
    });

    it('should not process when offline', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());

      await scheduler.processSchedulerTaskQueue();

      expect(storage.getNextTaskInSchedulerTaskQueue).not.toHaveBeenCalled();
    });

    it('should not process when a task is already running', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentTaskId: 'task-x' }));

      await scheduler.processSchedulerTaskQueue();

      expect(storage.getNextTaskInSchedulerTaskQueue).not.toHaveBeenCalled();
    });

    it('should execute next task from queue', async () => {
      const nextTask = createMockTask({ id: 'queued-1', status: 'waiting' });
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(nextTask);
      vi.mocked(storage.getTask).mockResolvedValue(nextTask);

      await scheduler.processSchedulerTaskQueue();

      expect(storage.updateTask).toHaveBeenCalledWith(
        'queued-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should do nothing when queue is empty', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(null);

      await scheduler.processSchedulerTaskQueue();

      expect(storage.updateTask).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // isOnline
  // =========================================================================

  describe('isOnline', () => {
    it('should return true when navigator.onLine is true', () => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      expect(scheduler.isOnline()).toBe(true);
    });

    it('should return false when navigator.onLine is false', () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      expect(scheduler.isOnline()).toBe(false);
    });
  });

  // =========================================================================
  // pauseSchedulerTaskQueue
  // =========================================================================

  describe('pauseSchedulerTaskQueue', () => {
    it('should set isPaused to true in storage', async () => {
      await scheduler.pauseSchedulerTaskQueue();
      expect(storage.setSchedulerState).toHaveBeenCalledWith({ isPaused: true });
    });

    it('should stop the queue processor alarm', async () => {
      await scheduler.pauseSchedulerTaskQueue();
      expect(alarms.stopSchedulerTaskQueueProcessor).toHaveBeenCalled();
    });

    it('should emit a state change event', async () => {
      await scheduler.pauseSchedulerTaskQueue();
      expect(emitter).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // resumeSchedulerTaskQueue
  // =========================================================================

  describe('resumeSchedulerTaskQueue', () => {
    it('should set isPaused to false in storage', async () => {
      await scheduler.resumeSchedulerTaskQueue();
      expect(storage.setSchedulerState).toHaveBeenCalledWith({ isPaused: false });
    });

    it('should start the queue processor alarm', async () => {
      await scheduler.resumeSchedulerTaskQueue();
      expect(alarms.startSchedulerTaskQueueProcessor).toHaveBeenCalled();
    });

    it('should emit a state change event', async () => {
      await scheduler.resumeSchedulerTaskQueue();
      expect(emitter).toHaveBeenCalled();
    });

    it('should immediately process the queue after resuming', async () => {
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(null);

      await scheduler.resumeSchedulerTaskQueue();

      // processSchedulerTaskQueue was called => getSchedulerState was called
      expect(storage.getSchedulerState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleAlarm
  // =========================================================================

  describe('handleAlarm', () => {
    it('should ignore unrecognized alarm names', async () => {
      await scheduler.handleAlarm('some-other-alarm');
      expect(storage.getTask).not.toHaveBeenCalled();
    });

    it('should trigger a scheduled task when task alarm fires', async () => {
      const task = createMockTask({ id: 'task-abc', status: 'scheduled' });
      vi.mocked(storage.getTask)
        .mockResolvedValueOnce(task) // handleAlarm lookup
        .mockResolvedValueOnce(task) // triggerTask lookup
        .mockResolvedValueOnce(task); // executeTask lookup
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentTaskId: null }));

      await scheduler.handleAlarm('scheduler-task-task-abc');

      // triggerTask should clear alarm for scheduled tasks
      expect(alarms.clearTaskAlarm).toHaveBeenCalledWith('task-abc');
    });

    it('should not trigger if task is not in scheduled status', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(createMockTask({ id: 'task-abc', status: 'completed' }));

      await scheduler.handleAlarm('scheduler-task-task-abc');

      // Should not attempt to trigger
      expect(alarms.clearTaskAlarm).not.toHaveBeenCalled();
    });

    it('should not trigger if task is not found', async () => {
      vi.mocked(storage.getTask).mockResolvedValue(null);

      await scheduler.handleAlarm('scheduler-task-task-abc');

      expect(alarms.clearTaskAlarm).not.toHaveBeenCalled();
    });

    it('should process queue when queue processor alarm fires', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState());
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(null);

      await scheduler.handleAlarm('scheduler-task-queue-processor');

      expect(storage.getSchedulerState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // detectMissedTasks
  // =========================================================================

  describe('detectMissedTasks', () => {
    it('should return empty array when no overdue tasks', async () => {
      vi.mocked(storage.getOverdueScheduledTasks).mockResolvedValue([]);

      const missed = await scheduler.detectMissedTasks();

      expect(missed).toEqual([]);
    });

    it('should mark overdue tasks as missed', async () => {
      const overdue = [
        createMockTask({ id: 't1', status: 'scheduled' }),
        createMockTask({ id: 't2', status: 'scheduled' }),
      ];
      vi.mocked(storage.getOverdueScheduledTasks).mockResolvedValue(overdue);

      await scheduler.detectMissedTasks();

      expect(storage.updateTask).toHaveBeenCalledWith('t1', { status: 'missed' });
      expect(storage.updateTask).toHaveBeenCalledWith('t2', { status: 'missed' });
    });

    it('should clear alarms for overdue tasks', async () => {
      const overdue = [createMockTask({ id: 't1', status: 'scheduled' })];
      vi.mocked(storage.getOverdueScheduledTasks).mockResolvedValue(overdue);

      await scheduler.detectMissedTasks();

      expect(alarms.clearTaskAlarm).toHaveBeenCalledWith('t1');
    });

    it('should emit status change events for each missed task', async () => {
      const overdue = [
        createMockTask({ id: 't1', status: 'scheduled' }),
        createMockTask({ id: 't2', status: 'scheduled' }),
      ];
      vi.mocked(storage.getOverdueScheduledTasks).mockResolvedValue(overdue);

      await scheduler.detectMissedTasks();

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't1', previousStatus: 'scheduled', newStatus: 'missed' })
      );
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't2', previousStatus: 'scheduled', newStatus: 'missed' })
      );
    });

    it('should return the list of overdue tasks', async () => {
      const overdue = [createMockTask({ id: 't1' })];
      vi.mocked(storage.getOverdueScheduledTasks).mockResolvedValue(overdue);

      const result = await scheduler.detectMissedTasks();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('t1');
    });
  });

  // =========================================================================
  // getSchedulerState
  // =========================================================================

  describe('getSchedulerState', () => {
    it('should return combined state and counts', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ isPaused: true, currentTaskId: null }));
      vi.mocked(storage.getTaskCounts).mockResolvedValue({
        draftCount: 2,
        scheduledCount: 3,
        missedCount: 1,
        waitingCount: 4,
        runningCount: 0,
      });

      const response = await scheduler.getSchedulerState();

      expect(response).toEqual({
        isPaused: true,
        currentTaskId: null,
        draftCount: 2,
        scheduledCount: 3,
        missedCount: 1,
        schedulerTaskQueueCount: 4,
        runningTask: null,
      });
    });

    it('should include running task summary when a task is running', async () => {
      const runningTask = createMockTask({
        id: 'running-1',
        input: 'Do something big',
        status: 'running',
        scheduledTime: 5000,
        createdAt: 1000,
      });
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentTaskId: 'running-1' })
      );
      vi.mocked(storage.getTask).mockResolvedValue(runningTask);
      vi.mocked(storage.getTaskCounts).mockResolvedValue({
        draftCount: 0,
        scheduledCount: 0,
        missedCount: 0,
        waitingCount: 0,
        runningCount: 1,
      });

      const response = await scheduler.getSchedulerState();

      expect(response.runningTask).toEqual({
        id: 'running-1',
        input: 'Do something big',
        scheduledTime: 5000,
        status: 'running',
        createdAt: 1000,
      });
    });

    it('should return null runningTask when current task not found', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ currentTaskId: 'orphan-task' })
      );
      vi.mocked(storage.getTask).mockResolvedValue(null);
      vi.mocked(storage.getTaskCounts).mockResolvedValue({
        draftCount: 0,
        scheduledCount: 0,
        missedCount: 0,
        waitingCount: 0,
        runningCount: 0,
      });

      const response = await scheduler.getSchedulerState();

      expect(response.runningTask).toBeNull();
    });
  });

  // =========================================================================
  // toTaskSummary (private)
  // =========================================================================

  describe('toTaskSummary (private)', () => {
    it('should truncate input to 100 characters', () => {
      const task = createMockTask({ input: 'X'.repeat(200) });
      const summary = (scheduler as any).toTaskSummary(task);
      expect(summary.input).toBe('X'.repeat(100));
    });

    it('should not truncate short input', () => {
      const task = createMockTask({ input: 'Short' });
      const summary = (scheduler as any).toTaskSummary(task);
      expect(summary.input).toBe('Short');
    });

    it('should include id, scheduledTime, status, and createdAt', () => {
      const task = createMockTask({
        id: 'sum-1',
        scheduledTime: 99999,
        status: 'scheduled',
        createdAt: 12345,
      });
      const summary = (scheduler as any).toTaskSummary(task);
      expect(summary).toEqual({
        id: 'sum-1',
        input: 'Test task input',
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
      (scheduler as any).emitStatusChange('task-1', 'draft', 'running');

      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
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
    it('should emit state with isPaused and currentTaskId', async () => {
      vi.mocked(storage.getSchedulerState).mockResolvedValue(
        createMockState({ isPaused: true, currentTaskId: 'task-x' })
      );

      await (scheduler as any).emitStateChange();

      expect(emitter).toHaveBeenCalledWith({
        isPaused: true,
        currentTaskId: 'task-x',
      });
    });

    it('should not throw when emitter is null', async () => {
      const s = new Scheduler(storage, alarms);
      await expect((s as any).emitStateChange()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // cleanupTaskSession (private)
  // =========================================================================

  describe('cleanupTaskSession (private)', () => {
    it('should remove session from registry and taskSessions map', async () => {
      (scheduler as any).taskSessions.set('task-1', 'session-abc');

      await (scheduler as any).cleanupTaskSession('task-1');

      expect(registry.removeSession).toHaveBeenCalledWith('session-abc');
      expect((scheduler as any).taskSessions.has('task-1')).toBe(false);
    });

    it('should do nothing if no session mapping exists', async () => {
      await (scheduler as any).cleanupTaskSession('task-nonexistent');
      expect(registry.removeSession).not.toHaveBeenCalled();
    });

    it('should do nothing if registry is null', async () => {
      const s = new Scheduler(storage, alarms);
      (s as any).taskSessions.set('task-1', 'session-abc');

      await (s as any).cleanupTaskSession('task-1');

      // No registry, so removeSession should not be called
      expect(registry.removeSession).not.toHaveBeenCalled();
    });

    it('should not throw if removeSession fails', async () => {
      (scheduler as any).taskSessions.set('task-1', 'session-err');
      registry.removeSession.mockRejectedValue(new Error('Cleanup failed'));

      await expect(
        (scheduler as any).cleanupTaskSession('task-1')
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Integration-like scenarios
  // =========================================================================

  describe('end-to-end scenarios', () => {
    it('should handle full task lifecycle: schedule -> execute -> complete', async () => {
      const futureTime = Date.now() + 60000;
      const task = createMockTask({ id: 'lifecycle-1', status: 'scheduled', scheduledTime: futureTime });

      // Schedule
      vi.mocked(storage.createTask).mockResolvedValue(task);
      const id = await scheduler.scheduleTask('Full lifecycle', futureTime);
      expect(id).toBe('lifecycle-1');

      // Alarm fires -> triggerTask
      vi.mocked(storage.getTask).mockResolvedValue(task);
      vi.mocked(storage.getSchedulerState).mockResolvedValue(createMockState({ currentTaskId: null }));

      // triggerTask -> executeTask chain: getTask is called twice
      vi.mocked(storage.getTask)
        .mockResolvedValueOnce(task) // handleAlarm -> triggerTask lookup
        .mockResolvedValueOnce(task); // triggerTask -> executeTask lookup

      await scheduler.handleAlarm('scheduler-task-lifecycle-1');

      // Complete
      const runningTask = { ...task, status: 'running' as const };
      vi.mocked(storage.getTask).mockResolvedValue(runningTask);
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(null);

      await scheduler.completeTask('lifecycle-1', createMockResult());

      expect(storage.updateTask).toHaveBeenCalledWith(
        'lifecycle-1',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('should handle queue draining: complete first -> execute second', async () => {
      // First task running, second in queue
      const task1 = createMockTask({ id: 't1', status: 'running' });
      const task2 = createMockTask({ id: 't2', status: 'waiting' });

      // Complete task 1
      vi.mocked(storage.getTask).mockResolvedValueOnce(task1); // completeTask lookup
      vi.mocked(storage.getNextTaskInSchedulerTaskQueue).mockResolvedValue(task2);

      // After clearing current task, processQueue finds task2
      vi.mocked(storage.getSchedulerState)
        .mockResolvedValueOnce(createMockState()) // emitStateChange in completeTask
        .mockResolvedValueOnce(createMockState({ currentTaskId: null })); // processSchedulerTaskQueue

      // executeTask will call getTask for task2
      vi.mocked(storage.getTask).mockResolvedValueOnce(task2);

      await scheduler.completeTask('t1', createMockResult());

      // Task 2 should have been started
      expect(storage.updateTask).toHaveBeenCalledWith(
        't2',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should handle cancelling a scheduled task and scheduling a new one', async () => {
      const scheduledTask = createMockTask({ id: 'sched-1', status: 'scheduled' });
      vi.mocked(storage.getTask).mockResolvedValue(scheduledTask);

      // Cancel
      await scheduler.cancelTask('sched-1');
      expect(alarms.clearTaskAlarm).toHaveBeenCalledWith('sched-1');
      expect(storage.updateTask).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ status: 'cancelled' })
      );

      // Schedule a new one
      const futureTime = Date.now() + 120000;
      const newTask = createMockTask({ id: 'sched-2' });
      vi.mocked(storage.createTask).mockResolvedValue(newTask);

      await scheduler.scheduleTask('New scheduled task', futureTime);
      expect(alarms.createTaskAlarm).toHaveBeenCalledWith('sched-2', futureTime);
    });
  });
});
