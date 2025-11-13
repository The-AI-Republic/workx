/**
 * Unit Test: TabManager Event Handlers
 *
 * Purpose: Validates TabManager event handling logic
 *
 * Test Coverage:
 * - Tab removal event handling
 * - Tab update event handling (crash detection)
 * - Callback registration and invocation
 * - Event listener cleanup
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TabManager } from '../../src/core/TabManager';

describe('TabManager Event Handlers Unit Tests', () => {
  let chromeMock: any;
  let manager: TabManager;

  beforeEach(async () => {
    // Reset singleton
    (TabManager as any).instance = null;

    // Mock chrome APIs
    chromeMock = {
      tabs: {
        get: vi.fn(),
        onRemoved: {
          addListener: vi.fn(),
        },
        onUpdated: {
          addListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
    global.chrome = chromeMock as any;

    manager = TabManager.getInstance();
    await manager.initialize();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Event Listener Registration', () => {
    it('should register onRemoved listener on initialization', () => {
      expect(chromeMock.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
      expect(chromeMock.tabs.onRemoved.addListener).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it('should register onUpdated listener on initialization', () => {
      expect(chromeMock.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
      expect(chromeMock.tabs.onUpdated.addListener).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it('should allow registering multiple closure callbacks', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      manager.onTabClosed(callback1);
      manager.onTabClosed(callback2);
      manager.onTabClosed(callback3);

      // All callbacks should be registered (tested via invocation later)
      expect(() => {
        manager.onTabClosed(callback1);
        manager.onTabClosed(callback2);
        manager.onTabClosed(callback3);
      }).not.toThrow();
    });
  });

  describe('onRemoved Event Handler', () => {
    it('should unbind tab when onRemoved fires for bound tab', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Get the onRemoved handler
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];

      // Trigger the event
      onRemovedHandler(tabId, { isWindowClosing: false });

      // Verify unbinding
      expect(manager.getTabForSession(sessionId)).toBe(-1);
      expect(manager.getSessionForTab(tabId)).toBeUndefined();
    });

    it('should not throw when onRemoved fires for unbound tab', () => {
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];

      // Should not throw for unbound tab
      expect(() => {
        onRemovedHandler(999, {});
      }).not.toThrow();
    });

    it('should invoke registered callbacks when bound tab is removed', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      const callback = vi.fn();
      manager.onTabClosed(callback);

      // Get and trigger onRemoved handler
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // Verify callback was invoked
      expect(callback).toHaveBeenCalledWith(sessionId, tabId);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should not invoke callbacks when unbound tab is removed', () => {
      const callback = vi.fn();
      manager.onTabClosed(callback);

      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(999, {});

      // Callback should not be invoked for unbound tab
      expect(callback).not.toHaveBeenCalled();
    });

    it('should persist changes after tab removal', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Clear previous storage calls
      chromeMock.storage.local.set.mockClear();

      // Trigger removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // Verify persistence was attempted (async, so give it a moment)
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(chromeMock.storage.local.set).toHaveBeenCalled();
    });
  });

  describe('onUpdated Event Handler', () => {
    it('should detect crashed tab via status=unloaded', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      const callback = vi.fn();
      manager.onTabClosed(callback);

      // Get onUpdated handler
      const onUpdatedHandler = chromeMock.tabs.onUpdated.addListener.mock.calls[0][0];

      // Simulate tab crash
      onUpdatedHandler(
        tabId,
        { status: 'loading' },
        { ...mockTab, status: 'unloaded' }
      );

      // Verify crash detection
      expect(callback).toHaveBeenCalledWith(sessionId, tabId);
      expect(manager.getTabForSession(sessionId)).toBe(-1);
    });

    it('should not trigger on normal status updates', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      const callback = vi.fn();
      manager.onTabClosed(callback);

      const onUpdatedHandler = chromeMock.tabs.onUpdated.addListener.mock.calls[0][0];

      // Normal updates
      onUpdatedHandler(tabId, { status: 'loading' }, { ...mockTab, status: 'loading' });
      onUpdatedHandler(tabId, { status: 'complete' }, { ...mockTab, status: 'complete' });
      onUpdatedHandler(tabId, { title: 'New Title' }, { ...mockTab, title: 'New Title' });

      // Callback should not be invoked
      expect(callback).not.toHaveBeenCalled();
      expect(manager.getTabForSession(sessionId)).toBe(tabId);
    });

    it('should not trigger for unbound tab updates', () => {
      const callback = vi.fn();
      manager.onTabClosed(callback);

      const onUpdatedHandler = chromeMock.tabs.onUpdated.addListener.mock.calls[0][0];

      // Update for unbound tab
      onUpdatedHandler(
        999,
        { status: 'loading' },
        { id: 999, status: 'unloaded' }
      );

      // Should not trigger callback
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Callback Error Handling', () => {
    it('should handle errors in callbacks gracefully', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Register callback that throws error
      const faultyCallback = vi.fn(() => {
        throw new Error('Callback error');
      });

      // Register normal callback after faulty one
      const normalCallback = vi.fn();

      manager.onTabClosed(faultyCallback);
      manager.onTabClosed(normalCallback);

      // Trigger removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];

      // Should not throw despite faulty callback
      expect(() => {
        onRemovedHandler(tabId, {});
      }).not.toThrow();

      // Both callbacks should have been invoked
      expect(faultyCallback).toHaveBeenCalled();
      expect(normalCallback).toHaveBeenCalled();
    });

    it('should continue processing after callback error', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      const faultyCallback = vi.fn(() => {
        throw new Error('Callback error');
      });

      manager.onTabClosed(faultyCallback);

      // Trigger removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // Tab should still be unbound despite callback error
      expect(manager.getTabForSession(sessionId)).toBe(-1);
    });
  });

  describe('Multiple Callbacks', () => {
    it('should invoke all registered callbacks in order', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      const invocationOrder: number[] = [];

      const callback1 = vi.fn(() => invocationOrder.push(1));
      const callback2 = vi.fn(() => invocationOrder.push(2));
      const callback3 = vi.fn(() => invocationOrder.push(3));

      manager.onTabClosed(callback1);
      manager.onTabClosed(callback2);
      manager.onTabClosed(callback3);

      // Trigger removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // All callbacks invoked
      expect(callback1).toHaveBeenCalledWith(sessionId, tabId);
      expect(callback2).toHaveBeenCalledWith(sessionId, tabId);
      expect(callback3).toHaveBeenCalledWith(sessionId, tabId);

      // In registration order
      expect(invocationOrder).toEqual([1, 2, 3]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid successive tab removals', async () => {
      const session1Id = 'session-1';
      const session2Id = 'session-2';
      const tab1Id = 123;
      const tab2Id = 456;

      const mockTab1 = {
        id: tab1Id,
        url: 'https://example1.com',
        title: 'Example 1',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      const mockTab2 = {
        id: tab2Id,
        url: 'https://example2.com',
        title: 'Example 2',
        active: false,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 1,
      };

      chromeMock.tabs.get.mockImplementation((id: number) => {
        if (id === tab1Id) return Promise.resolve(mockTab1);
        if (id === tab2Id) return Promise.resolve(mockTab2);
        return Promise.reject(new Error(`No tab with id: ${id}`));
      });

      await manager.bindTabToSession(session1Id, tab1Id, mockTab1 as any);
      await manager.bindTabToSession(session2Id, tab2Id, mockTab2 as any);

      const callback = vi.fn();
      manager.onTabClosed(callback);

      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];

      // Remove both tabs rapidly
      onRemovedHandler(tab1Id, {});
      onRemovedHandler(tab2Id, {});

      // Both should be unbound
      expect(manager.getTabForSession(session1Id)).toBe(-1);
      expect(manager.getTabForSession(session2Id)).toBe(-1);

      // Callback invoked for both
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenNthCalledWith(1, session1Id, tab1Id);
      expect(callback).toHaveBeenNthCalledWith(2, session2Id, tab2Id);
    });

    it('should handle window closing scenario', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await manager.bindTabToSession(sessionId, tabId, mockTab as any);

      const callback = vi.fn();
      manager.onTabClosed(callback);

      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];

      // Window closing (all tabs in window being closed)
      onRemovedHandler(tabId, { isWindowClosing: true });

      // Should still unbind and notify
      expect(callback).toHaveBeenCalledWith(sessionId, tabId);
      expect(manager.getTabForSession(sessionId)).toBe(-1);
    });
  });
});
