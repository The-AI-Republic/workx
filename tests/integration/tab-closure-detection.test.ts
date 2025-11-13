/**
 * Integration Test: Tab Closure Detection
 *
 * Purpose: Validates that the system detects tab closure/crash and stops execution
 *
 * Test Scenarios:
 * 1. Tab closed by user during execution - task stops immediately
 * 2. Tab crashes during execution - treated as closure
 * 3. Notification displayed when tab closed
 * 4. Session tabId reset to -1 after closure
 * 5. Browser operations fail gracefully after tab closure
 *
 * User Story: US2 - Tab Closure Detection and Session Termination
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TabManager } from '../../src/core/TabManager';
import { Session } from '../../src/core/Session';
import type { SessionServices } from '../../src/core/Session';

describe('Tab Closure Detection Integration Tests', () => {
  let chromeMock: any;
  let bindingManager: TabManager;
  let mockServices: SessionServices;

  beforeEach(async () => {
    // Reset singleton
    (TabManager as any).instance = null;

    // Mock chrome APIs
    chromeMock = {
      tabs: {
        get: vi.fn(),
        create: vi.fn(),
        query: vi.fn(),
        remove: vi.fn(),
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
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      runtime: {
        sendMessage: vi.fn(),
        onMessage: {
          addListener: vi.fn(),
        },
      },
    };
    global.chrome = chromeMock as any;

    // Initialize TabManager
    bindingManager = TabManager.getInstance();
    await bindingManager.initialize();

    mockServices = {} as SessionServices;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('T051: Tab Closure Detection', () => {
    it('should detect when tab is closed by user', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      // Create and bind tab
      const mockTab = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example Page',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Verify binding exists
      expect(bindingManager.getTabForSession(sessionId)).toBe(tabId);

      // Register callback to track closure events
      const closureCallback = vi.fn();
      bindingManager.onTabClosed(closureCallback);

      // Simulate tab removal (user closes tab)
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, { isWindowClosing: false });

      // Verify closure was detected and callback invoked
      expect(closureCallback).toHaveBeenCalledWith(sessionId, tabId);

      // Verify binding was removed
      expect(bindingManager.getTabForSession(sessionId)).toBe(-1);
      expect(bindingManager.getSessionForTab(tabId)).toBeUndefined();
    });

    it('should detect closure within 1 second (SC-002)', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      const closureCallback = vi.fn();
      bindingManager.onTabClosed(closureCallback);

      const startTime = Date.now();

      // Simulate tab removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      const detectionTime = Date.now() - startTime;

      // Verify closure detected
      expect(closureCallback).toHaveBeenCalled();

      // SC-002: Detection should occur within 1 second
      expect(detectionTime).toBeLessThan(1000);
    });

    it('should unbind tab when closure detected', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Simulate tab removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // Verify session tabId reset to -1
      expect(bindingManager.getTabForSession(sessionId)).toBe(-1);

      // Verify tab no longer bound to any session
      expect(bindingManager.getSessionForTab(tabId)).toBeUndefined();

      // Verify binding info removed
      expect(bindingManager.getBinding(tabId)).toBeUndefined();
    });

    it('should persist unbinding to storage', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Clear previous storage calls
      chromeMock.storage.local.set.mockClear();

      // Simulate tab removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // Verify storage was updated (binding removed)
      expect(chromeMock.storage.local.set).toHaveBeenCalled();
    });

    it('should handle closure of unbound tab gracefully', async () => {
      const unboundTabId = 999;

      // Simulate removal of tab that wasn't bound to any session
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];

      // Should not throw
      expect(() => {
        onRemovedHandler(unboundTabId, {});
      }).not.toThrow();
    });

    it('should notify all registered listeners of tab closure', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Register multiple callbacks
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      bindingManager.onTabClosed(callback1);
      bindingManager.onTabClosed(callback2);
      bindingManager.onTabClosed(callback3);

      // Simulate tab removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // All callbacks should be invoked
      expect(callback1).toHaveBeenCalledWith(sessionId, tabId);
      expect(callback2).toHaveBeenCalledWith(sessionId, tabId);
      expect(callback3).toHaveBeenCalledWith(sessionId, tabId);
    });
  });

  describe('T052: Tab Crash Detection', () => {
    it('should detect when tab crashes', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      const closureCallback = vi.fn();
      bindingManager.onTabClosed(closureCallback);

      // Simulate tab crash via onUpdated event
      const onUpdatedHandler = chromeMock.tabs.onUpdated.addListener.mock.calls[0][0];

      // Tab status changes to 'unloaded' when crashed
      onUpdatedHandler(
        tabId,
        { status: 'loading' },
        { ...mockTab, status: 'unloaded' }
      );

      // Verify crash was detected and treated as closure
      expect(closureCallback).toHaveBeenCalledWith(sessionId, tabId);

      // Verify binding removed
      expect(bindingManager.getTabForSession(sessionId)).toBe(-1);
    });

    it('should treat unresponsive tab as closure', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      const closureCallback = vi.fn();
      bindingManager.onTabClosed(closureCallback);

      // Simulate unresponsive tab
      const onUpdatedHandler = chromeMock.tabs.onUpdated.addListener.mock.calls[0][0];
      onUpdatedHandler(
        tabId,
        { status: 'loading' },
        { ...mockTab, status: 'unloaded' }
      );

      // Should be treated as closure
      expect(closureCallback).toHaveBeenCalledWith(sessionId, tabId);
      expect(bindingManager.getTabForSession(sessionId)).toBe(-1);
    });

    it('should not trigger on normal tab updates', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      const closureCallback = vi.fn();
      bindingManager.onTabClosed(closureCallback);

      // Simulate normal tab updates
      const onUpdatedHandler = chromeMock.tabs.onUpdated.addListener.mock.calls[0][0];

      // Title change
      onUpdatedHandler(
        tabId,
        { title: 'New Title' },
        { ...mockTab, title: 'New Title' }
      );

      // URL change
      onUpdatedHandler(
        tabId,
        { url: 'https://example.com/new' },
        { ...mockTab, url: 'https://example.com/new' }
      );

      // Loading to complete
      onUpdatedHandler(
        tabId,
        { status: 'complete' },
        { ...mockTab, status: 'complete' }
      );

      // Callback should NOT be invoked for normal updates
      expect(closureCallback).not.toHaveBeenCalled();

      // Binding should still exist
      expect(bindingManager.getTabForSession(sessionId)).toBe(tabId);
    });
  });

  describe('Tab Validation After Closure', () => {
    it('should return invalid state for closed tab', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Close the tab
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // Mock chrome.tabs.get to reject (tab no longer exists)
      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 123'));

      // Validate the closed tab
      const validation = await bindingManager.validateTab(tabId);

      expect(validation.status).toBe('invalid');
      if (validation.status === 'invalid') {
        expect(['closed', 'not_found']).toContain(validation.reason);
      }
    });

    it('should prevent operations on closed tab', async () => {
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
      await bindingManager.bindTabToSession(sessionId, tabId, mockTab as any);

      // Close the tab
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      // Session should no longer have tab attached
      expect(bindingManager.getTabForSession(sessionId)).toBe(-1);

      // Attempting to validate should fail
      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 123'));
      const validation = await bindingManager.validateTab(tabId);
      expect(validation.status).toBe('invalid');
    });
  });

  describe('Multiple Sessions and Tab Closure', () => {
    it('should only affect the session bound to closed tab', async () => {
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

      await bindingManager.bindTabToSession(session1Id, tab1Id, mockTab1 as any);
      await bindingManager.bindTabToSession(session2Id, tab2Id, mockTab2 as any);

      // Close tab1
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tab1Id, {});

      // Session 1 should be unbound
      expect(bindingManager.getTabForSession(session1Id)).toBe(-1);

      // Session 2 should still be bound
      expect(bindingManager.getTabForSession(session2Id)).toBe(tab2Id);
    });
  });
});
