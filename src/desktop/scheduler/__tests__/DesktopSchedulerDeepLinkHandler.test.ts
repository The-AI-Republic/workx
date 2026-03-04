/**
 * Desktop Scheduler Deep Link Handler Tests
 *
 * Tests for DesktopSchedulerDeepLinkHandler which processes
 * `airepublic-pi://scheduler/trigger?jobId=xxx` deep link events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DesktopSchedulerDeepLinkHandler } from '../DesktopSchedulerDeepLinkHandler';
import { getJobAlarmName } from '../../../core/models/types/SchedulerContracts';

// ─────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────

let capturedListenCallback: ((event: { payload: string }) => void) | null = null;
const mockUnlisten = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => mockListen(...args),
}));

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

function createMockScheduler() {
  return {
    handleAlarm: vi.fn().mockResolvedValue(undefined),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('DesktopSchedulerDeepLinkHandler', () => {
  let handler: DesktopSchedulerDeepLinkHandler;
  let scheduler: ReturnType<typeof createMockScheduler>;

  beforeEach(() => {
    capturedListenCallback = null;
    mockUnlisten.mockReset();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockReset();
    mockListen.mockImplementation(async (_event: string, callback: Function) => {
      capturedListenCallback = callback as any;
      return mockUnlisten;
    });
    scheduler = createMockScheduler();
    handler = new DesktopSchedulerDeepLinkHandler(scheduler as any);
  });

  afterEach(() => {
    handler.dispose();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('should listen on auth-callback event', async () => {
      await handler.initialize();
      expect(mockListen).toHaveBeenCalledWith('auth-callback', expect.any(Function));
    });

    it('should not throw if Tauri event module fails', async () => {
      mockListen.mockRejectedValueOnce(new Error('Tauri unavailable'));
      await expect(handler.initialize()).resolves.toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Deep Link Processing
  // ─────────────────────────────────────────────────────────────────────

  describe('handleDeepLink', () => {
    beforeEach(async () => {
      await handler.initialize();
    });

    it('should trigger scheduler alarm for valid scheduler URL', () => {
      capturedListenCallback!({
        payload: 'airepublic-pi://scheduler/trigger?jobId=task-42',
      });

      expect(scheduler.handleAlarm).toHaveBeenCalledWith(getJobAlarmName('task-42'));
    });

    it('should remove OS job after triggering', async () => {
      capturedListenCallback!({
        payload: 'airepublic-pi://scheduler/trigger?jobId=task-42',
      });

      // removeOsJob is async — wait a tick
      await vi.waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('scheduler_remove_os_job', {
          jobId: 'task-42',
        });
      });
    });

    it('should ignore non-scheduler deep links', () => {
      capturedListenCallback!({
        payload: 'airepublic-pi://auth/callback?code=abc123',
      });

      expect(scheduler.handleAlarm).not.toHaveBeenCalled();
    });

    it('should ignore URLs without jobId', () => {
      capturedListenCallback!({
        payload: 'airepublic-pi://scheduler/trigger',
      });

      expect(scheduler.handleAlarm).not.toHaveBeenCalled();
    });

    it('should handle malformed URLs without throwing', () => {
      // URL constructor will throw for truly broken strings,
      // but the handler catches all errors
      capturedListenCallback!({
        payload: 'not a valid url at all %%%',
      });

      expect(scheduler.handleAlarm).not.toHaveBeenCalled();
    });

    it('should handle scheduler.handleAlarm rejection gracefully', () => {
      scheduler.handleAlarm.mockRejectedValue(new Error('boom'));

      // Should not throw
      expect(() => {
        capturedListenCallback!({
          payload: 'airepublic-pi://scheduler/trigger?jobId=task-1',
        });
      }).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Dispose
  // ─────────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should call unlisten when initialized', async () => {
      await handler.initialize();
      handler.dispose();
      expect(mockUnlisten).toHaveBeenCalled();
    });

    it('should be safe to call multiple times', async () => {
      await handler.initialize();
      handler.dispose();
      handler.dispose();
      expect(mockUnlisten).toHaveBeenCalledTimes(1);
    });

    it('should be safe to call without initialize', () => {
      expect(() => handler.dispose()).not.toThrow();
    });
  });
});
