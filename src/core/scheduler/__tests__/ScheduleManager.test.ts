/**
 * Tests for ScheduleManager
 *
 * Tests event CRUD, RRULE expansion, exceptions, alarm arming,
 * and instance generation for calendar display.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScheduleManager } from '../ScheduleManager';
import type { IScheduleStorage, IExecutionStorage } from '../../models/types/ScheduleContracts';
import type { ISchedulerAlarms } from '../../models/types/SchedulerContracts';
import type { ScheduleEvent, ExecutionRecord, ScheduleEventException } from '../../models/types/ScheduleEvent';

// Mock uuid
const mockUuid = vi.hoisted(() => vi.fn(() => 'mock-uuid'));
vi.mock('uuid', () => ({ v4: mockUuid }));

function createMockScheduleStorage(): IScheduleStorage {
  return {
    createEvent: vi.fn(),
    getEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    getAllEvents: vi.fn().mockResolvedValue([]),
    getEnabledEvents: vi.fn().mockResolvedValue([]),
    getEventsInRange: vi.fn().mockResolvedValue([]),
    createException: vi.fn(),
    getExceptions: vi.fn().mockResolvedValue([]),
    getException: vi.fn().mockResolvedValue(null),
    deleteException: vi.fn(),
    deleteAllExceptions: vi.fn(),
  };
}

function createMockExecutionStorage(): IExecutionStorage {
  return {
    createExecution: vi.fn(),
    getExecution: vi.fn(),
    updateExecution: vi.fn(),
    deleteExecution: vi.fn(),
    getExecutionsByEvent: vi.fn().mockResolvedValue([]),
    getExecutionByInstance: vi.fn().mockResolvedValue(null),
    getExecutionsByStatus: vi.fn().mockResolvedValue([]),
    getExecutionsInRange: vi.fn().mockResolvedValue([]),
    getLatestExecution: vi.fn().mockResolvedValue(null),
    getRunningExecutions: vi.fn().mockResolvedValue([]),
    getArchivedExecutions: vi.fn().mockResolvedValue([]),
    getArchivedExecutionsCount: vi.fn().mockResolvedValue(0),
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
    id: 'event-1',
    input: 'Test event',
    scheduledTime: Date.now() + 3600000,
    rrule: null,
    enabled: true,
    exdates: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('ScheduleManager', () => {
  let manager: ScheduleManager;
  let scheduleStorage: ReturnType<typeof createMockScheduleStorage>;
  let executionStorage: ReturnType<typeof createMockExecutionStorage>;
  let alarms: ReturnType<typeof createMockAlarms>;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduleStorage = createMockScheduleStorage();
    executionStorage = createMockExecutionStorage();
    alarms = createMockAlarms();
    manager = new ScheduleManager(scheduleStorage, executionStorage, alarms);
    mockUuid.mockReturnValue('mock-uuid');
  });

  describe('createEvent', () => {
    it('should create a one-shot event and arm alarm', async () => {
      const futureTime = Date.now() + 3600000;
      const event = await manager.createEvent('Test input', futureTime);

      expect(scheduleStorage.createEvent).toHaveBeenCalledOnce();
      expect(alarms.createJobAlarm).toHaveBeenCalledWith('mock-uuid', futureTime);
      expect(event.id).toBe('mock-uuid');
      expect(event.rrule).toBeNull();
    });

    it('should create a recurring event with RRULE', async () => {
      const futureTime = Date.now() + 3600000;
      const event = await manager.createEvent('Daily task', futureTime, 'FREQ=DAILY;INTERVAL=1');

      expect(scheduleStorage.createEvent).toHaveBeenCalledOnce();
      const createdEvent = (scheduleStorage.createEvent as any).mock.calls[0][0];
      expect(createdEvent.rrule).toBe('FREQ=DAILY;INTERVAL=1');
    });

    it('should reject past scheduled times', async () => {
      await expect(
        manager.createEvent('Test', Date.now() - 1000)
      ).rejects.toThrow('Scheduled time must be in the future');
    });

    it('should clean up on alarm failure', async () => {
      (alarms.createJobAlarm as any).mockRejectedValue(new Error('Alarm failed'));

      await expect(
        manager.createEvent('Test', Date.now() + 3600000)
      ).rejects.toThrow('Alarm failed');

      expect(scheduleStorage.deleteEvent).toHaveBeenCalledWith('mock-uuid');
    });
  });

  describe('editSeries', () => {
    it('should update event and re-arm alarm when time changes', async () => {
      const event = createTestEvent();
      (scheduleStorage.getEvent as any).mockResolvedValue(event);

      const newTime = Date.now() + 7200000;
      await manager.editSeries('event-1', { scheduledTime: newTime });

      expect(scheduleStorage.updateEvent).toHaveBeenCalled();
      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('event-1');
    });

    it('should throw for non-existent event', async () => {
      (scheduleStorage.getEvent as any).mockResolvedValue(null);

      await expect(
        manager.editSeries('nonexistent', { input: 'New input' })
      ).rejects.toThrow('Schedule event not found');
    });
  });

  describe('editInstance', () => {
    it('should create an exception for a single instance', async () => {
      const event = createTestEvent({ rrule: 'FREQ=DAILY;INTERVAL=1' });
      (scheduleStorage.getEvent as any).mockResolvedValue(event);

      const instanceTime = Date.now() + 86400000;
      await manager.editInstance('event-1', instanceTime, {
        overrideInput: 'Modified task',
      });

      expect(scheduleStorage.deleteException).toHaveBeenCalledWith('event-1', instanceTime);
      expect(scheduleStorage.createException).toHaveBeenCalledWith({
        scheduleEventId: 'event-1',
        instanceTime,
        overrideInput: 'Modified task',
      });
    });
  });

  describe('deleteInstance', () => {
    it('should add exdate to event', async () => {
      const event = createTestEvent({ exdates: [] });
      (scheduleStorage.getEvent as any).mockResolvedValue(event);

      const instanceTime = Date.now() + 86400000;
      await manager.deleteInstance('event-1', instanceTime);

      expect(scheduleStorage.updateEvent).toHaveBeenCalledWith('event-1', {
        exdates: [instanceTime],
        updatedAt: expect.any(Number),
      });
    });
  });

  describe('deleteEvent', () => {
    it('should clear alarms, exceptions, and delete event', async () => {
      await manager.deleteEvent('event-1');

      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('event-1');
      expect(scheduleStorage.deleteAllExceptions).toHaveBeenCalledWith('event-1');
      expect(scheduleStorage.deleteEvent).toHaveBeenCalledWith('event-1');
    });
  });

  describe('setEnabled', () => {
    it('should disable event and clear alarm', async () => {
      await manager.setEnabled('event-1', false);

      expect(scheduleStorage.updateEvent).toHaveBeenCalledWith('event-1', {
        enabled: false,
        updatedAt: expect.any(Number),
      });
      expect(alarms.clearJobAlarm).toHaveBeenCalledWith('event-1');
    });

    it('should enable event and arm alarm', async () => {
      const event = createTestEvent({ enabled: false });
      (scheduleStorage.getEvent as any).mockResolvedValue(event);

      await manager.setEnabled('event-1', true);

      expect(scheduleStorage.updateEvent).toHaveBeenCalledWith('event-1', {
        enabled: true,
        updatedAt: expect.any(Number),
      });
    });
  });

  describe('getInstancesInRange', () => {
    it('should expand one-shot event in range', async () => {
      const futureTime = Date.now() + 3600000;
      const event = createTestEvent({ scheduledTime: futureTime });
      (scheduleStorage.getEventsInRange as any).mockResolvedValue([event]);
      (executionStorage.getExecutionsInRange as any).mockResolvedValue([]);

      const startTime = Date.now();
      const endTime = Date.now() + 86400000;
      const instances = await manager.getInstancesInRange(startTime, endTime);

      expect(instances).toHaveLength(1);
      expect(instances[0].instanceTime).toBe(futureTime);
      expect(instances[0].isVirtual).toBe(true);
      expect(instances[0].status).toBe('upcoming');
    });

    it('should merge execution status into instances', async () => {
      const futureTime = Date.now() + 3600000;
      const event = createTestEvent({ scheduledTime: futureTime });
      (scheduleStorage.getEventsInRange as any).mockResolvedValue([event]);

      const execution: ExecutionRecord = {
        id: 'exec-1',
        scheduleEventId: 'event-1',
        instanceTime: futureTime,
        input: 'Test event',
        sessionId: 'session-1',
        status: 'completed',
        result: null,
        error: null,
        startedAt: futureTime,
        completedAt: futureTime + 5000,
      };
      (executionStorage.getExecutionsInRange as any).mockResolvedValue([execution]);

      const instances = await manager.getInstancesInRange(Date.now(), Date.now() + 86400000);

      expect(instances).toHaveLength(1);
      expect(instances[0].status).toBe('completed');
      expect(instances[0].isVirtual).toBe(false);
      expect(instances[0].executionId).toBe('exec-1');
    });
  });

  describe('handleAlarmFired', () => {
    it('should delegate to alarm fired handler', async () => {
      const handler = vi.fn();
      manager.setAlarmFiredHandler(handler);

      const event = createTestEvent();
      (scheduleStorage.getEvent as any).mockResolvedValue(event);
      (scheduleStorage.getException as any).mockResolvedValue(null);

      await manager.handleAlarmFired('event-1');

      expect(handler).toHaveBeenCalledWith('event-1', expect.any(Number), 'Test event');
    });

    it('should not fire for disabled events', async () => {
      const handler = vi.fn();
      manager.setAlarmFiredHandler(handler);

      (scheduleStorage.getEvent as any).mockResolvedValue(createTestEvent({ enabled: false }));

      await manager.handleAlarmFired('event-1');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getInstancesInRange with recurring events', () => {
    it('should expand recurring event instances', async () => {
      const dtstart = Date.now() + 3600000;
      const event = createTestEvent({
        scheduledTime: dtstart,
        rrule: 'FREQ=DAILY;INTERVAL=1',
      });
      (scheduleStorage.getEventsInRange as any).mockResolvedValue([event]);
      (executionStorage.getExecutionsInRange as any).mockResolvedValue([]);
      (scheduleStorage.getExceptions as any).mockResolvedValue([]);

      const instances = await manager.getInstancesInRange(dtstart, dtstart + 3 * 86400000);

      expect(instances.length).toBeGreaterThanOrEqual(3);
      expect(instances[0].status).toBe('upcoming');
      expect(instances[0].isVirtual).toBe(true);
      expect(instances[0].rruleDescription).toBeDefined();
    });

    it('should apply exception overrides in getInstancesInRange', async () => {
      const dtstart = Date.now() + 3600000;
      const event = createTestEvent({
        scheduledTime: dtstart,
        rrule: 'FREQ=DAILY;INTERVAL=1',
      });
      (scheduleStorage.getEventsInRange as any).mockResolvedValue([event]);
      (executionStorage.getExecutionsInRange as any).mockResolvedValue([]);
      (scheduleStorage.getExceptions as any).mockResolvedValue([
        { scheduleEventId: 'event-1', instanceTime: dtstart, overrideInput: 'Modified task' },
      ]);

      const instances = await manager.getInstancesInRange(dtstart, dtstart + 86400000);

      const firstInstance = instances.find(i => i.instanceTime === dtstart);
      expect(firstInstance).toBeDefined();
      expect(firstInstance!.input).toBe('Modified task');
    });
  });

  describe('editSeries validation', () => {
    it('should reject past scheduledTime', async () => {
      const event = createTestEvent();
      (scheduleStorage.getEvent as any).mockResolvedValue(event);

      await expect(
        manager.editSeries('event-1', { scheduledTime: Date.now() - 1000 })
      ).rejects.toThrow('Scheduled time must be in the future');
    });
  });

  describe('deleteEvent cleanup', () => {
    it('should delete associated execution records', async () => {
      const executions = [
        { id: 'exec-1', scheduleEventId: 'event-1', instanceTime: Date.now(), input: '', sessionId: null, status: 'completed' as const, result: null, error: null, startedAt: null, completedAt: null },
      ];
      (executionStorage.getExecutionsByEvent as any).mockResolvedValue(executions);

      await manager.deleteEvent('event-1');

      expect(executionStorage.deleteExecution).toHaveBeenCalledWith('exec-1');
      expect(scheduleStorage.deleteEvent).toHaveBeenCalledWith('event-1');
    });
  });

  describe('restoreAlarms', () => {
    it('should arm alarms for all enabled events', async () => {
      const event1 = createTestEvent({ id: 'e1' });
      const event2 = createTestEvent({ id: 'e2' });
      (scheduleStorage.getEnabledEvents as any).mockResolvedValue([event1, event2]);
      (scheduleStorage.getEvent as any).mockImplementation(async (id: string) => {
        if (id === 'e1') return event1;
        if (id === 'e2') return event2;
        return null;
      });

      await manager.restoreAlarms();

      expect(alarms.clearJobAlarm).toHaveBeenCalledTimes(2);
      expect(alarms.createJobAlarm).toHaveBeenCalledTimes(2);
    });
  });
});
