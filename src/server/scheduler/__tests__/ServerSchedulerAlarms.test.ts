/**
 * Server Scheduler Alarms Tests
 *
 * Tests for Node.js timer-based ISchedulerAlarms implementation.
 * Covers timer creation/clearing, queue processor, alarm handler callback,
 * and shutdown cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerSchedulerAlarms } from '../ServerSchedulerAlarms';
import { getTaskAlarmName, SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM } from '../../../core/models/types/SchedulerContracts';

describe('ServerSchedulerAlarms', () => {
  let alarms: ServerSchedulerAlarms;

  beforeEach(() => {
    vi.useFakeTimers();
    alarms = new ServerSchedulerAlarms();
  });

  afterEach(() => {
    alarms.shutdown();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Task Alarms
  // ─────────────────────────────────────────────────────────────────────

  describe('createTaskAlarm', () => {
    it('should create a timer that fires after delay', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      const scheduledTime = Date.now() + 5000;
      await alarms.createTaskAlarm('task-1', scheduledTime);

      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);

      expect(handler).toHaveBeenCalledWith(getTaskAlarmName('task-1'));
    });

    it('should fire immediately for past scheduledTime', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      const pastTime = Date.now() - 1000;
      await alarms.createTaskAlarm('task-1', pastTime);

      await vi.advanceTimersByTimeAsync(0);

      expect(handler).toHaveBeenCalledWith(getTaskAlarmName('task-1'));
    });

    it('should replace existing timer for same task', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.createTaskAlarm('task-1', Date.now() + 5000);
      await alarms.createTaskAlarm('task-1', Date.now() + 10000);

      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearTaskAlarm', () => {
    it('should cancel a pending timer', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.createTaskAlarm('task-1', Date.now() + 5000);
      await alarms.clearTaskAlarm('task-1');

      await vi.advanceTimersByTimeAsync(10000);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not throw when clearing non-existent timer', async () => {
      await expect(alarms.clearTaskAlarm('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('hasTaskAlarm', () => {
    it('should return true for existing alarm', async () => {
      await alarms.createTaskAlarm('task-1', Date.now() + 5000);
      expect(await alarms.hasTaskAlarm('task-1')).toBe(true);
    });

    it('should return false for non-existent alarm', async () => {
      expect(await alarms.hasTaskAlarm('task-1')).toBe(false);
    });

    it('should return false after alarm fires', async () => {
      alarms.setAlarmHandler(vi.fn());
      await alarms.createTaskAlarm('task-1', Date.now() + 5000);

      await vi.advanceTimersByTimeAsync(5000);

      expect(await alarms.hasTaskAlarm('task-1')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Queue Processor
  // ─────────────────────────────────────────────────────────────────────

  describe('startSchedulerTaskQueueProcessor', () => {
    it('should fire periodically', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.startSchedulerTaskQueueProcessor();

      await vi.advanceTimersByTimeAsync(60000); // 1 minute (default interval)
      expect(handler).toHaveBeenCalledWith(SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM);

      await vi.advanceTimersByTimeAsync(60000);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopSchedulerTaskQueueProcessor', () => {
    it('should stop periodic firing', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.startSchedulerTaskQueueProcessor();
      await alarms.stopSchedulerTaskQueueProcessor();

      await vi.advanceTimersByTimeAsync(120000);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getAllAlarms
  // ─────────────────────────────────────────────────────────────────────

  describe('getAllAlarms', () => {
    it('should return empty array when no alarms', async () => {
      const result = await alarms.getAllAlarms();
      expect(result).toEqual([]);
    });

    it('should return task alarms and queue processor', async () => {
      const scheduledTime = Date.now() + 5000;
      await alarms.createTaskAlarm('task-1', scheduledTime);
      await alarms.startSchedulerTaskQueueProcessor();

      const result = await alarms.getAllAlarms();
      expect(result).toHaveLength(2);
      expect(result.find(a => a.name === getTaskAlarmName('task-1'))).toBeTruthy();
      expect(result.find(a => a.name === SCHEDULER_TASK_QUEUE_PROCESSOR_ALARM)).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Shutdown
  // ─────────────────────────────────────────────────────────────────────

  describe('shutdown', () => {
    it('should clear all timers', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.createTaskAlarm('task-1', Date.now() + 5000);
      await alarms.createTaskAlarm('task-2', Date.now() + 10000);
      await alarms.startSchedulerTaskQueueProcessor();

      alarms.shutdown();

      await vi.advanceTimersByTimeAsync(120000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should result in empty getAllAlarms', async () => {
      await alarms.createTaskAlarm('task-1', Date.now() + 5000);
      alarms.shutdown();

      const result = await alarms.getAllAlarms();
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should not throw when alarm handler errors', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('handler error'));
      alarms.setAlarmHandler(handler);

      await alarms.createTaskAlarm('task-1', Date.now() + 100);

      // Should not throw
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Config
  // ─────────────────────────────────────────────────────────────────────

  describe('config', () => {
    it('should default minScheduleDelay to 0 for server mode', () => {
      const serverAlarms = new ServerSchedulerAlarms();
      // Verify by creating a task alarm with 0 delay — should work without adding extra delay
      const handler = vi.fn();
      serverAlarms.setAlarmHandler(handler);

      serverAlarms.createTaskAlarm('task-1', Date.now());
      vi.advanceTimersByTime(0);

      // Timer should fire immediately since minScheduleDelay is 0
      expect(handler).toHaveBeenCalled();
      serverAlarms.shutdown();
    });
  });
});
