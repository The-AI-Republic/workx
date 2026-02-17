/**
 * Unit tests for UserNotifier
 *
 * Tests verify:
 * - Constructor initialization with and without config
 * - notify() creates notifications of all types and priorities
 * - dismissNotification() removes active notifications
 * - updateProgress() modifies progress on existing notifications
 * - Callback subscription via onNotification / offNotification
 * - processEvent() dispatches to the correct notification type
 * - History management: getHistory, clearHistory, addToHistory overflow
 * - Active notification tracking: getActiveNotifications, clearAll
 * - Helper methods: getAutoDismissDelay, convertPriorityToChrome
 * - Convenience methods: notifyError, notifySuccess, notifyInfo, notifyWarning, notifyProgress
 * - showApprovalRequest builds correct approval notifications
 * - notifyAgentTurnComplete with and without external command
 * - Error handling in callbacks and Chrome API failures
 * - getNotification / hasNotification accessors
 * - onAction handler registration and invocation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  UserNotifier,
  type NotificationCallback,
  type UserNotification,
} from '@/core/UserNotifier';
import type { Event } from '@/core/protocol/events';

// ---------------------------------------------------------------------------
// Chrome notifications mock — the global setup.ts does not provide
// chrome.notifications, so we extend the global chrome mock for these tests.
// ---------------------------------------------------------------------------

function installChromeNotificationsMock() {
  const notifMock = {
    create: vi.fn((_id: string, _opts: any, cb?: (id: string) => void) => {
      cb?.(_id);
    }),
    update: vi.fn(),
    clear: vi.fn(),
    onClicked: { addListener: vi.fn() },
    onButtonClicked: { addListener: vi.fn() },
    onClosed: { addListener: vi.fn() },
  };

  // Patch onto the existing global chrome mock
  (globalThis as any).chrome = {
    ...(globalThis as any).chrome,
    notifications: notifMock,
  };

  // Ensure sendMessage still returns a Promise after spreading
  ensureSendMessageReturnsPromise();

  return notifMock;
}

function removeChromeNotificationsMock() {
  const chrome = (globalThis as any).chrome;
  if (chrome) {
    delete chrome.notifications;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: string, data?: any): Event {
  return {
    id: `evt-${Date.now()}`,
    msg: { type, data } as any,
  };
}

// ---------------------------------------------------------------------------
// Ensure chrome.runtime.sendMessage returns a Promise so that the
// `.catch()` in showFallbackNotification does not blow up.
// ---------------------------------------------------------------------------

function ensureSendMessageReturnsPromise() {
  const chrome = (globalThis as any).chrome;
  if (chrome?.runtime) {
    chrome.runtime.sendMessage = vi.fn().mockReturnValue(Promise.resolve());
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UserNotifier', () => {
  beforeEach(() => {
    ensureSendMessageReturnsPromise();
  });

  // -----------------------------------------------------------------------
  // 1. Constructor and initialization
  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('should create an instance with default config', () => {
      removeChromeNotificationsMock();
      const notifier = new UserNotifier();
      expect(notifier).toBeDefined();
      expect(notifier.getActiveNotifications()).toEqual([]);
      expect(notifier.getHistory()).toEqual([]);
    });

    it('should accept an externalCommand config option', () => {
      removeChromeNotificationsMock();
      const notifier = new UserNotifier({ externalCommand: 'my-app' });
      expect(notifier).toBeDefined();
    });

    it('should accept fallbackToConsole config option', () => {
      removeChromeNotificationsMock();
      const notifier = new UserNotifier({ fallbackToConsole: false });
      expect(notifier).toBeDefined();
    });

    it('should detect Chrome notification support when chrome.notifications is available', () => {
      installChromeNotificationsMock();
      const notifier = new UserNotifier();
      // Chrome notification listeners should have been set up
      const chrome = (globalThis as any).chrome;
      expect(chrome.notifications.onClicked.addListener).toHaveBeenCalled();
      expect(chrome.notifications.onButtonClicked.addListener).toHaveBeenCalled();
      expect(chrome.notifications.onClosed.addListener).toHaveBeenCalled();
    });

    it('should not throw when chrome.notifications is absent', () => {
      removeChromeNotificationsMock();
      expect(() => new UserNotifier()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // 2. notify() — various types and priorities
  // -----------------------------------------------------------------------
  describe('notify()', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should return a unique notification ID', async () => {
      const id1 = await notifier.notify('info', 'Title', 'Message');
      const id2 = await notifier.notify('info', 'Title2', 'Message2');
      expect(id1).toMatch(/^notif_/);
      expect(id2).toMatch(/^notif_/);
      expect(id1).not.toBe(id2);
    });

    it('should store the notification as active', async () => {
      const id = await notifier.notify('info', 'Hello', 'World');
      expect(notifier.hasNotification(id)).toBe(true);
      const n = notifier.getNotification(id);
      expect(n).toBeDefined();
      expect(n!.title).toBe('Hello');
      expect(n!.message).toBe('World');
      expect(n!.type).toBe('info');
    });

    it('should add notification to history', async () => {
      await notifier.notify('info', 'T', 'M');
      expect(notifier.getHistory()).toHaveLength(1);
    });

    it('should default priority to "normal"', async () => {
      const id = await notifier.notify('info', 'T', 'M');
      expect(notifier.getNotification(id)!.priority).toBe('normal');
    });

    it('should respect custom priority', async () => {
      const id = await notifier.notify('info', 'T', 'M', { priority: 'urgent' });
      expect(notifier.getNotification(id)!.priority).toBe('urgent');
    });

    it('should default persistent to false', async () => {
      const id = await notifier.notify('info', 'T', 'M');
      expect(notifier.getNotification(id)!.persistent).toBe(false);
    });

    it('should support persistent option', async () => {
      const id = await notifier.notify('info', 'T', 'M', { persistent: true });
      expect(notifier.getNotification(id)!.persistent).toBe(true);
    });

    it('should store actions when provided', async () => {
      const actions = [{ id: 'ok', label: 'OK', style: 'primary' as const }];
      const id = await notifier.notify('info', 'T', 'M', { actions });
      expect(notifier.getNotification(id)!.actions).toEqual(actions);
    });

    it('should store metadata when provided', async () => {
      const meta = { foo: 'bar' };
      const id = await notifier.notify('info', 'T', 'M', { metadata: meta });
      expect(notifier.getNotification(id)!.metadata).toEqual(meta);
    });

    it('should store progress when provided', async () => {
      const id = await notifier.notify('progress', 'T', 'M', {
        progress: { current: 5, total: 10 },
      });
      expect(notifier.getNotification(id)!.progress).toEqual({ current: 5, total: 10 });
    });

    it('should invoke notification callbacks', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.notify('success', 'Done', 'All good');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].title).toBe('Done');
    });

    it('should use Chrome notifications API when available', async () => {
      const notifMock = installChromeNotificationsMock();
      const chromeNotifier = new UserNotifier();
      await chromeNotifier.notify('info', 'Chrome', 'Test');
      expect(notifMock.create).toHaveBeenCalled();
    });

    it('should use console fallback when Chrome notifications are not available', async () => {
      removeChromeNotificationsMock();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fallbackNotifier = new UserNotifier({ fallbackToConsole: true });
      await fallbackNotifier.notify('info', 'Fallback', 'Test');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle Chrome notifications API failure and fallback to console', async () => {
      const notifMock = installChromeNotificationsMock();
      // Make create call the callback with lastError
      notifMock.create.mockImplementation((_id: string, _opts: any, cb?: (id: string) => void) => {
        (globalThis as any).chrome.runtime.lastError = { message: 'test error' };
        cb?.(_id);
        (globalThis as any).chrome.runtime.lastError = null;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const chromeNotifier = new UserNotifier({ fallbackToConsole: true });
      // Should not throw even when Chrome API fails
      await expect(chromeNotifier.notify('error', 'Err', 'Fail')).resolves.toBeDefined();

      consoleSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // 3. dismissNotification()
  // -----------------------------------------------------------------------
  describe('dismissNotification()', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should remove an existing notification', async () => {
      const id = await notifier.notify('info', 'T', 'M', { persistent: true });
      expect(notifier.hasNotification(id)).toBe(true);
      await notifier.dismissNotification(id);
      expect(notifier.hasNotification(id)).toBe(false);
    });

    it('should do nothing for a non-existing notification ID', async () => {
      await expect(notifier.dismissNotification('nonexistent')).resolves.toBeUndefined();
    });

    it('should clear Chrome notification when chrome support is available', async () => {
      const notifMock = installChromeNotificationsMock();
      const chromeNotifier = new UserNotifier();
      const id = await chromeNotifier.notify('info', 'T', 'M', { persistent: true });
      await chromeNotifier.dismissNotification(id);
      expect(notifMock.clear).toHaveBeenCalledWith(id);
    });

    it('should not appear in getActiveNotifications after dismiss', async () => {
      const id = await notifier.notify('info', 'T', 'M', { persistent: true });
      await notifier.dismissNotification(id);
      const active = notifier.getActiveNotifications();
      expect(active.find(n => n.id === id)).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 4. updateProgress()
  // -----------------------------------------------------------------------
  describe('updateProgress()', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should update progress on an existing notification', async () => {
      const id = await notifier.notify('progress', 'Loading', '...', {
        progress: { current: 0, total: 100 },
        persistent: true,
      });
      await notifier.updateProgress(id, 50, 100);
      const n = notifier.getNotification(id);
      expect(n!.progress).toEqual({ current: 50, total: 100 });
    });

    it('should do nothing for a non-existing notification', async () => {
      await expect(notifier.updateProgress('nonexistent', 50, 100)).resolves.toBeUndefined();
    });

    it('should invoke callbacks after progress update', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      const id = await notifier.notify('progress', 'Loading', '...', {
        progress: { current: 0, total: 100 },
        persistent: true,
      });
      cb.mockClear();
      await notifier.updateProgress(id, 75, 100);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].progress).toEqual({ current: 75, total: 100 });
    });

    it('should call chrome.notifications.update when Chrome support is available', async () => {
      const notifMock = installChromeNotificationsMock();
      const chromeNotifier = new UserNotifier();
      const id = await chromeNotifier.notify('progress', 'T', 'M', {
        progress: { current: 0, total: 100 },
        persistent: true,
      });
      await chromeNotifier.updateProgress(id, 60, 100);
      expect(notifMock.update).toHaveBeenCalledWith(id, { progress: 60 });
    });
  });

  // -----------------------------------------------------------------------
  // 5. Event subscription: onNotification / offNotification
  // -----------------------------------------------------------------------
  describe('onNotification / offNotification', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should register a callback that receives notifications', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.notify('info', 'T', 'M');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('should support multiple simultaneous callbacks', async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      notifier.onNotification(cb1);
      notifier.onNotification(cb2);
      await notifier.notify('info', 'T', 'M');
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('should unregister a callback so it no longer fires', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      notifier.offNotification(cb);
      await notifier.notify('info', 'T', 'M');
      expect(cb).not.toHaveBeenCalled();
    });

    it('should not throw when removing a callback that was never added', () => {
      const cb = vi.fn();
      expect(() => notifier.offNotification(cb)).not.toThrow();
    });

    it('should catch and log callback errors without breaking other callbacks', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const badCb: NotificationCallback = () => { throw new Error('boom'); };
      const goodCb = vi.fn();
      notifier.onNotification(badCb);
      notifier.onNotification(goodCb);
      await notifier.notify('info', 'T', 'M');
      expect(goodCb).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // 6. processEvent()
  // -----------------------------------------------------------------------
  describe('processEvent()', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should handle Error events', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.processEvent(makeEvent('Error', { message: 'Something went wrong' }));
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].type).toBe('error');
      expect(cb.mock.calls[0][0].message).toBe('Something went wrong');
    });

    it('should handle ExecApprovalRequest events', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.processEvent(
        makeEvent('ExecApprovalRequest', { id: 'a1', command: 'rm -rf /' })
      );
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].type).toBe('approval');
      expect(cb.mock.calls[0][0].message).toContain('rm -rf /');
    });

    it('should handle ApplyPatchApprovalRequest events', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.processEvent(
        makeEvent('ApplyPatchApprovalRequest', { id: 'p1', path: '/foo/bar.ts' })
      );
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].type).toBe('approval');
      expect(cb.mock.calls[0][0].message).toContain('/foo/bar.ts');
    });

    it('should handle TaskFailed events', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.processEvent(makeEvent('TaskFailed', { reason: 'timeout' }));
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].type).toBe('error');
      expect(cb.mock.calls[0][0].message).toBe('timeout');
    });

    it('should silently handle unknown event types', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.processEvent(makeEvent('SomeUnknownType', {}));
      expect(cb).not.toHaveBeenCalled();
    });

    it('should handle null/undefined event gracefully', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(notifier.processEvent(null as any)).resolves.toBeUndefined();
      await expect(notifier.processEvent({ id: 'x', msg: undefined } as any)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('should handle Error event with missing data.message', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.processEvent(makeEvent('Error', {}));
      // No notification should be created since data.message is falsy
      expect(cb).not.toHaveBeenCalled();
    });

    it('should handle TaskFailed event with missing data.reason', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.processEvent(makeEvent('TaskFailed', {}));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 7. History management
  // -----------------------------------------------------------------------
  describe('getHistory / clearHistory', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should return empty history initially', () => {
      expect(notifier.getHistory()).toEqual([]);
    });

    it('should accumulate notifications in history', async () => {
      await notifier.notify('info', 'A', 'a');
      await notifier.notify('warning', 'B', 'b');
      await notifier.notify('error', 'C', 'c');
      expect(notifier.getHistory()).toHaveLength(3);
    });

    it('should return a copy of history (not a reference)', async () => {
      await notifier.notify('info', 'A', 'a');
      const history1 = notifier.getHistory();
      const history2 = notifier.getHistory();
      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
    });

    it('should clear history', async () => {
      await notifier.notify('info', 'A', 'a');
      await notifier.notify('info', 'B', 'b');
      notifier.clearHistory();
      expect(notifier.getHistory()).toEqual([]);
    });

    it('should limit history to maxNotifications (100)', async () => {
      // Create 105 notifications — history should cap at 100
      for (let i = 0; i < 105; i++) {
        await notifier.notify('info', `N${i}`, `msg ${i}`, { persistent: true });
      }
      const history = notifier.getHistory();
      expect(history.length).toBeLessThanOrEqual(100);
      // The first 5 notifications should have been evicted
      expect(history[0].title).toBe('N5');
    });
  });

  // -----------------------------------------------------------------------
  // 8. Active notifications: getActiveNotifications / clearAll
  // -----------------------------------------------------------------------
  describe('getActiveNotifications / clearAll', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should return all currently active notifications', async () => {
      await notifier.notify('info', 'A', 'a', { persistent: true });
      await notifier.notify('warning', 'B', 'b', { persistent: true });
      const active = notifier.getActiveNotifications();
      expect(active).toHaveLength(2);
    });

    it('should clear all notifications', async () => {
      await notifier.notify('info', 'A', 'a', { persistent: true });
      await notifier.notify('warning', 'B', 'b', { persistent: true });
      await notifier.clearAll();
      expect(notifier.getActiveNotifications()).toHaveLength(0);
    });

    it('clearAll should work when there are no active notifications', async () => {
      await expect(notifier.clearAll()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 9. Helper methods (tested indirectly through notify behavior)
  // -----------------------------------------------------------------------
  describe('getAutoDismissDelay (tested indirectly)', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      vi.useFakeTimers();
      notifier = new UserNotifier();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should auto-dismiss non-persistent info notification after 5000ms', async () => {
      const id = await notifier.notify('info', 'T', 'M');
      expect(notifier.hasNotification(id)).toBe(true);
      vi.advanceTimersByTime(5001);
      expect(notifier.hasNotification(id)).toBe(false);
    });

    it('should auto-dismiss success notification after 4000ms', async () => {
      const id = await notifier.notify('success', 'T', 'M');
      expect(notifier.hasNotification(id)).toBe(true);
      vi.advanceTimersByTime(4001);
      expect(notifier.hasNotification(id)).toBe(false);
    });

    it('should auto-dismiss warning notification after 6000ms', async () => {
      // warning type without explicit priority uses type-based delay
      // but notifyWarning sets priority to 'high', so we test raw notify with type warning
      const id = await notifier.notify('warning', 'T', 'M');
      expect(notifier.hasNotification(id)).toBe(true);
      vi.advanceTimersByTime(6001);
      expect(notifier.hasNotification(id)).toBe(false);
    });

    it('should auto-dismiss error notification after 8000ms', async () => {
      const id = await notifier.notify('error', 'T', 'M');
      expect(notifier.hasNotification(id)).toBe(true);
      vi.advanceTimersByTime(8001);
      expect(notifier.hasNotification(id)).toBe(false);
    });

    it('should use 10000ms for urgent priority', async () => {
      const id = await notifier.notify('info', 'T', 'M', { priority: 'urgent' });
      expect(notifier.hasNotification(id)).toBe(true);
      vi.advanceTimersByTime(9999);
      expect(notifier.hasNotification(id)).toBe(true);
      vi.advanceTimersByTime(2);
      expect(notifier.hasNotification(id)).toBe(false);
    });

    it('should use 7000ms for high priority', async () => {
      const id = await notifier.notify('info', 'T', 'M', { priority: 'high' });
      expect(notifier.hasNotification(id)).toBe(true);
      vi.advanceTimersByTime(7001);
      expect(notifier.hasNotification(id)).toBe(false);
    });

    it('should NOT auto-dismiss persistent notifications', async () => {
      const id = await notifier.notify('info', 'T', 'M', { persistent: true });
      vi.advanceTimersByTime(30000);
      expect(notifier.hasNotification(id)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Convenience methods
  // -----------------------------------------------------------------------
  describe('convenience methods', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('notifyError should create an error notification with high priority', async () => {
      const id = await notifier.notifyError('Oops', 'Something broke');
      const n = notifier.getNotification(id);
      expect(n).toBeDefined();
      expect(n!.type).toBe('error');
      expect(n!.priority).toBe('high');
    });

    it('notifySuccess should create a success notification', async () => {
      const id = await notifier.notifySuccess('Done', 'All set');
      const n = notifier.getNotification(id);
      expect(n!.type).toBe('success');
      expect(n!.priority).toBe('normal');
    });

    it('notifyInfo should create an info notification', async () => {
      const id = await notifier.notifyInfo('FYI', 'Just so you know');
      const n = notifier.getNotification(id);
      expect(n!.type).toBe('info');
      expect(n!.priority).toBe('normal');
    });

    it('notifyWarning should create a warning notification with high priority', async () => {
      const id = await notifier.notifyWarning('Careful', 'Watch out');
      const n = notifier.getNotification(id);
      expect(n!.type).toBe('warning');
      expect(n!.priority).toBe('high');
    });

    it('notifyProgress should create a persistent progress notification', async () => {
      const id = await notifier.notifyProgress('Loading', 'Please wait', 25, 100);
      const n = notifier.getNotification(id);
      expect(n!.type).toBe('progress');
      expect(n!.persistent).toBe(true);
      expect(n!.progress).toEqual({ current: 25, total: 100 });
    });
  });

  // -----------------------------------------------------------------------
  // 11. showApprovalRequest
  // -----------------------------------------------------------------------
  describe('showApprovalRequest()', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should create an approval notification with approve/reject actions', async () => {
      const id = await notifier.showApprovalRequest('Review', 'Please approve', 'apr-1');
      const n = notifier.getNotification(id);
      expect(n!.type).toBe('approval');
      expect(n!.priority).toBe('high');
      expect(n!.persistent).toBe(true);
      expect(n!.actions).toHaveLength(2);
      expect(n!.actions![0].id).toBe('approve');
      expect(n!.actions![1].id).toBe('reject');
      expect(n!.metadata).toEqual({ approvalId: 'apr-1' });
    });
  });

  // -----------------------------------------------------------------------
  // 12. notifyAgentTurnComplete
  // -----------------------------------------------------------------------
  describe('notifyAgentTurnComplete()', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should create a success notification with turn metadata', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.notifyAgentTurnComplete('turn-1', ['hello'], 'Result');
      expect(cb).toHaveBeenCalledTimes(1);
      const n = cb.mock.calls[0][0] as UserNotification;
      expect(n.type).toBe('success');
      expect(n.title).toBe('Agent Turn Complete');
      expect(n.metadata['turn-id']).toBe('turn-1');
    });

    it('should truncate long assistant messages in the notification body', async () => {
      const longMsg = 'A'.repeat(200);
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.notifyAgentTurnComplete('t2', [], longMsg);
      const n = cb.mock.calls[0][0] as UserNotification;
      expect(n.message).toContain('...');
      expect(n.message.length).toBeLessThan(200);
    });

    it('should use fallback message when no assistant message is provided', async () => {
      const cb = vi.fn();
      notifier.onNotification(cb);
      await notifier.notifyAgentTurnComplete('t3', []);
      const n = cb.mock.calls[0][0] as UserNotification;
      expect(n.message).toBe('Agent turn completed successfully');
    });
  });

  // -----------------------------------------------------------------------
  // 13. getNotification / hasNotification
  // -----------------------------------------------------------------------
  describe('getNotification / hasNotification', () => {
    let notifier: UserNotifier;

    beforeEach(() => {
      removeChromeNotificationsMock();
      notifier = new UserNotifier();
    });

    it('should return the notification by ID', async () => {
      const id = await notifier.notify('info', 'T', 'M', { persistent: true });
      const n = notifier.getNotification(id);
      expect(n).toBeDefined();
      expect(n!.id).toBe(id);
    });

    it('should return undefined for unknown ID', () => {
      expect(notifier.getNotification('unknown')).toBeUndefined();
    });

    it('hasNotification should return true for existing, false for missing', async () => {
      const id = await notifier.notify('info', 'T', 'M', { persistent: true });
      expect(notifier.hasNotification(id)).toBe(true);
      expect(notifier.hasNotification('nope')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 14. onAction handler
  // -----------------------------------------------------------------------
  describe('onAction()', () => {
    it('should register an action handler for a notification', async () => {
      removeChromeNotificationsMock();
      const notifMock = installChromeNotificationsMock();
      const notifier = new UserNotifier();

      const id = await notifier.notify('info', 'T', 'M', {
        persistent: true,
        actions: [
          { id: 'act1', label: 'Do It' },
          { id: 'act2', label: 'Cancel' },
        ],
      });

      const handler = vi.fn();
      notifier.onAction(id, handler);

      // Simulate a button click through the Chrome listener
      // The constructor should have set up onButtonClicked.addListener
      const buttonClickCallback = notifMock.onButtonClicked.addListener.mock.calls[0][0];
      buttonClickCallback(id, 0);

      expect(handler).toHaveBeenCalledWith(id, 'act1');
    });
  });

  // -----------------------------------------------------------------------
  // 15. Chrome notification event handlers
  // -----------------------------------------------------------------------
  describe('Chrome notification event handlers', () => {
    it('should dismiss notification on click when no actions are present', async () => {
      removeChromeNotificationsMock();
      const notifMock = installChromeNotificationsMock();
      const notifier = new UserNotifier();

      const id = await notifier.notify('info', 'T', 'M', { persistent: true });
      expect(notifier.hasNotification(id)).toBe(true);

      // Simulate click
      const clickCallback = notifMock.onClicked.addListener.mock.calls[0][0];
      clickCallback(id);

      expect(notifier.hasNotification(id)).toBe(false);
    });

    it('should not dismiss on click when notification has actions', async () => {
      removeChromeNotificationsMock();
      const notifMock = installChromeNotificationsMock();
      const notifier = new UserNotifier();

      const id = await notifier.notify('info', 'T', 'M', {
        persistent: true,
        actions: [{ id: 'ok', label: 'OK' }],
      });

      const clickCallback = notifMock.onClicked.addListener.mock.calls[0][0];
      clickCallback(id);

      // Should still be present because it has actions
      expect(notifier.hasNotification(id)).toBe(true);
    });

    it('should remove notification when Chrome close event fires', async () => {
      removeChromeNotificationsMock();
      const notifMock = installChromeNotificationsMock();
      const notifier = new UserNotifier();

      const id = await notifier.notify('info', 'T', 'M', { persistent: true });
      expect(notifier.hasNotification(id)).toBe(true);

      const closeCallback = notifMock.onClosed.addListener.mock.calls[0][0];
      closeCallback(id);

      expect(notifier.hasNotification(id)).toBe(false);
    });
  });
});
