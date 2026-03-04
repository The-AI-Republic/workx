/**
 * Desktop Scheduler Alarms Tests
 *
 * Tests for hybrid in-process + OS job alarm implementation.
 * OS-level Tauri invoke calls are mocked since tests run in jsdom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DesktopSchedulerAlarms } from '../DesktopSchedulerAlarms';
import { getJobAlarmName, SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM } from '../../../core/models/types/SchedulerContracts';

// Mock Tauri API
const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

describe('DesktopSchedulerAlarms', () => {
  let alarms: DesktopSchedulerAlarms;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    alarms = new DesktopSchedulerAlarms();
  });

  afterEach(() => {
    alarms.dispose();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Hybrid Alarm Creation
  // ─────────────────────────────────────────────────────────────────────

  describe('createJobAlarm', () => {
    it('should create both in-process timer and OS job alarm', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      const scheduledTime = Date.now() + 5000;
      await alarms.createJobAlarm('task-1', scheduledTime);

      // Verify OS job was registered
      expect(mockInvoke).toHaveBeenCalledWith('scheduler_register_os_job', {
        jobId: 'task-1',
        scheduledTime,
      });

      // Verify in-process timer
      expect(await alarms.hasJobAlarm('task-1')).toBe(true);
    });

    it('should fire in-process timer after delay', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.createJobAlarm('task-1', Date.now() + 5000);

      await vi.advanceTimersByTimeAsync(5000);

      expect(handler).toHaveBeenCalledWith(getJobAlarmName('task-1'));
    });

    it('should replace existing timer for same job', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.createJobAlarm('task-1', Date.now() + 5000);
      await alarms.createJobAlarm('task-1', Date.now() + 10000);

      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should continue working if OS job registration fails', async () => {
      mockInvoke.mockRejectedValue(new Error('Tauri unavailable'));
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      // Should not throw
      await alarms.createJobAlarm('task-1', Date.now() + 1000);

      // In-process timer should still work
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Clearing Alarms
  // ─────────────────────────────────────────────────────────────────────

  describe('clearJobAlarm', () => {
    it('should clear both in-process timer and OS job alarm', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.createJobAlarm('task-1', Date.now() + 5000);
      mockInvoke.mockClear();

      await alarms.clearJobAlarm('task-1');

      // OS job should be removed
      expect(mockInvoke).toHaveBeenCalledWith('scheduler_remove_os_job', {
        jobId: 'task-1',
      });

      // In-process timer should be cancelled
      expect(await alarms.hasJobAlarm('task-1')).toBe(false);

      await vi.advanceTimersByTimeAsync(10000);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Queue Processor
  // ─────────────────────────────────────────────────────────────────────

  describe('queue processor', () => {
    it('should be in-process only (no OS job)', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);
      mockInvoke.mockClear();

      await alarms.startJobQueueProcessor();

      // Should not create an OS job for queue processor
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60000);
      expect(handler).toHaveBeenCalledWith(SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM);
    });

    it('should stop when requested', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.startJobQueueProcessor();
      await alarms.stopJobQueueProcessor();

      await vi.advanceTimersByTimeAsync(120000);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getAllAlarms
  // ─────────────────────────────────────────────────────────────────────

  describe('getAllAlarms', () => {
    it('should include job alarms and queue processor', async () => {
      await alarms.createJobAlarm('task-1', Date.now() + 5000);
      await alarms.startJobQueueProcessor();

      const all = await alarms.getAllAlarms();
      expect(all).toHaveLength(2);
      expect(all.find(a => a.name === getJobAlarmName('task-1'))).toBeTruthy();
      expect(all.find(a => a.name === SCHEDULER_JOB_QUEUE_PROCESSOR_ALARM)).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Reconciliation
  // ─────────────────────────────────────────────────────────────────────

  describe('reconcileOnStartup', () => {
    it('should recreate in-process timers for valid jobs', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      const futureTime = Date.now() + 30000;

      // Mock: OS reports task-1 exists
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'scheduler_list_os_jobs') return ['task-1'];
        return undefined;
      });

      await alarms.reconcileOnStartup(async () => [
        { id: 'task-1', scheduledTime: futureTime },
      ]);

      // Should have created in-process timer
      expect(await alarms.hasJobAlarm('task-1')).toBe(true);

      // Timer should fire at correct time
      await vi.advanceTimersByTimeAsync(30000);
      expect(handler).toHaveBeenCalledWith(getJobAlarmName('task-1'));
    });

    it('should clean up stale OS jobs', async () => {
      // Mock: OS reports task-stale exists, but it's not in storage
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'scheduler_list_os_jobs') return ['task-stale'];
        return undefined;
      });

      await alarms.reconcileOnStartup(async () => []);

      // Should have called remove for the stale job
      expect(mockInvoke).toHaveBeenCalledWith('scheduler_remove_os_job', {
        jobId: 'task-stale',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Dispose
  // ─────────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should clear all in-process timers', async () => {
      const handler = vi.fn();
      alarms.setAlarmHandler(handler);

      await alarms.createJobAlarm('task-1', Date.now() + 5000);
      await alarms.startJobQueueProcessor();

      alarms.dispose();

      await vi.advanceTimersByTimeAsync(120000);
      expect(handler).not.toHaveBeenCalled();

      const all = await alarms.getAllAlarms();
      expect(all).toEqual([]);
    });
  });
});
