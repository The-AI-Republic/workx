/**
 * Contract Test: TabManager
 *
 * Purpose: Validates that TabManager implementation conforms to the contract
 * defined in specs/001-session-tab-binding/contracts/TabManager.contract.ts
 *
 * This test verifies:
 * - Interface compliance (all methods exist with correct signatures)
 * - Postconditions (e.g., after bindTabToSession, getTabForSession returns tabId)
 * - Contract Invariants:
 *   1. Referential Integrity (bidirectional consistency)
 *   2. Uniqueness (one tab per session, one session per tab)
 *   3. Atomicity (no partial states, last-write-wins)
 *   4. Persistence (bindings survive restarts)
 *   5. Validation (correct tab state detection)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TabManager } from '../../src/core/TabManager';
import { TabInvalidReason } from '../../src/types/session';
import type { TabInfo } from '../../src/types/session';

describe('TabManager Contract Tests', () => {
  let manager: TabManager;
  let chromeMock: any;

  beforeEach(async () => {
    // Reset singleton instance for each test
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
    // Clean up
    vi.clearAllMocks();
  });

  describe('Interface Compliance', () => {
    it('should implement all required methods', () => {
      expect(manager).toHaveProperty('bindTabToSession');
      expect(manager).toHaveProperty('unbindTab');
      expect(manager).toHaveProperty('unbindSession');
      expect(manager).toHaveProperty('getSessionForTab');
      expect(manager).toHaveProperty('getTabForSession');
      expect(manager).toHaveProperty('getBinding');
      expect(manager).toHaveProperty('validateTab');
      expect(manager).toHaveProperty('initialize');
      expect(manager).toHaveProperty('onTabClosed');
    });

    it('should have correct method signatures', () => {
      expect(typeof manager.bindTabToSession).toBe('function');
      expect(typeof manager.unbindTab).toBe('function');
      expect(typeof manager.unbindSession).toBe('function');
      expect(typeof manager.getSessionForTab).toBe('function');
      expect(typeof manager.getTabForSession).toBe('function');
      expect(typeof manager.getBinding).toBe('function');
      expect(typeof manager.validateTab).toBe('function');
      expect(typeof manager.initialize).toBe('function');
      expect(typeof manager.onTabClosed).toBe('function');
    });
  });

  describe('Postconditions: bindTabToSession', () => {
    const sessionId = 'session-1';
    const tabId = 123;
    const tabInfo: TabInfo = {
      id: tabId,
      url: 'https://example.com',
      title: 'Example Page',
      active: true,
      pinned: false,
      windowId: 1,
      status: 'complete',
      index: 0,
    };

    beforeEach(() => {
      chromeMock.tabs.get.mockResolvedValue({
        id: tabId,
        url: 'https://example.com',
        title: 'Example Page',
      });
    });

    it('should establish bidirectional binding', async () => {
      await manager.bindTabToSession(sessionId, tabId, tabInfo);

      // Postcondition: getTabForSession(sessionId) === tabId
      expect(manager.getTabForSession(sessionId)).toBe(tabId);

      // Postcondition: getSessionForTab(tabId) === sessionId
      expect(manager.getSessionForTab(tabId)).toBe(sessionId);
    });

    it('should create full binding information', async () => {
      await manager.bindTabToSession(sessionId, tabId, tabInfo);

      const binding = manager.getBinding(tabId);
      expect(binding).toBeDefined();
      expect(binding?.tabId).toBe(tabId);
      expect(binding?.sessionId).toBe(sessionId);
      expect(binding?.tabTitle).toBe('Example Page');
      expect(binding?.tabUrl).toBe('https://example.com');
      expect(binding?.boundAt).toBeGreaterThan(0);
    });

    it('should persist binding to storage', async () => {
      await manager.bindTabToSession(sessionId, tabId, tabInfo);

      expect(chromeMock.storage.local.set).toHaveBeenCalled();
      const lastCall = chromeMock.storage.local.set.mock.calls[
        chromeMock.storage.local.set.mock.calls.length - 1
      ][0];
      expect(lastCall).toHaveProperty('tabBindings');
    });
  });

  describe('Postconditions: unbindTab', () => {
    const sessionId = 'session-1';
    const tabId = 123;
    const tabInfo: TabInfo = {
      id: tabId,
      url: 'https://example.com',
      title: 'Example Page',
      active: true,
      pinned: false,
      windowId: 1,
      status: 'complete',
      index: 0,
    };

    beforeEach(async () => {
      chromeMock.tabs.get.mockResolvedValue({ id: tabId });
      await manager.bindTabToSession(sessionId, tabId, tabInfo);
    });

    it('should remove tab-to-session mapping', async () => {
      await manager.unbindTab(tabId);

      // Postcondition: getSessionForTab(tabId) === undefined
      expect(manager.getSessionForTab(tabId)).toBeUndefined();
    });

    it('should remove session-to-tab mapping', async () => {
      await manager.unbindTab(tabId);

      // Postcondition: getTabForSession returns -1 for unbound session
      expect(manager.getTabForSession(sessionId)).toBe(-1);
    });

    it('should persist unbinding to storage', async () => {
      await manager.unbindTab(tabId);

      expect(chromeMock.storage.local.set).toHaveBeenCalled();
    });
  });

  describe('Postconditions: unbindSession', () => {
    const sessionId = 'session-1';
    const tabId = 123;
    const tabInfo: TabInfo = {
      id: tabId,
      url: 'https://example.com',
      title: 'Example Page',
      active: true,
      pinned: false,
      windowId: 1,
      status: 'complete',
      index: 0,
    };

    beforeEach(async () => {
      chromeMock.tabs.get.mockResolvedValue({ id: tabId });
      await manager.bindTabToSession(sessionId, tabId, tabInfo);
    });

    it('should remove session-to-tab mapping', async () => {
      await manager.unbindSession(sessionId);

      // Postcondition: getTabForSession(sessionId) === -1
      expect(manager.getTabForSession(sessionId)).toBe(-1);
    });

    it('should remove tab-to-session mapping', async () => {
      await manager.unbindSession(sessionId);

      // Postcondition: getSessionForTab returns undefined
      expect(manager.getSessionForTab(tabId)).toBeUndefined();
    });
  });

  describe('Invariant 1: Referential Integrity', () => {
    it('should maintain bidirectional consistency after binding', async () => {
      const sessionId = 'session-1';
      const tabId = 123;
      const tabInfo: TabInfo = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue({ id: tabId });
      await manager.bindTabToSession(sessionId, tabId, tabInfo);

      // Verify referential integrity: tabId -> sessionId -> tabId
      const retrievedSessionId = manager.getSessionForTab(tabId);
      expect(retrievedSessionId).toBe(sessionId);

      const retrievedTabId = manager.getTabForSession(sessionId);
      expect(retrievedTabId).toBe(tabId);
    });

    it('should maintain referential integrity after unbinding', async () => {
      const sessionId = 'session-1';
      const tabId = 123;
      const tabInfo: TabInfo = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue({ id: tabId });
      await manager.bindTabToSession(sessionId, tabId, tabInfo);
      await manager.unbindTab(tabId);

      // Both directions should return "not bound"
      expect(manager.getSessionForTab(tabId)).toBeUndefined();
      expect(manager.getTabForSession(sessionId)).toBe(-1);
    });
  });

  describe('Invariant 2: Uniqueness', () => {
    it('should enforce one tab per session', async () => {
      const sessionId = 'session-1';
      const tabId1 = 123;
      const tabId2 = 456;
      const tabInfo1: TabInfo = {
        id: tabId1,
        url: 'https://example.com',
        title: 'Example 1',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };
      const tabInfo2: TabInfo = {
        id: tabId2,
        url: 'https://example2.com',
        title: 'Example 2',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 1,
      };

      chromeMock.tabs.get.mockResolvedValue({ id: tabId1 });
      await manager.bindTabToSession(sessionId, tabId1, tabInfo1);

      chromeMock.tabs.get.mockResolvedValue({ id: tabId2 });
      await manager.bindTabToSession(sessionId, tabId2, tabInfo2);

      // Session should now be bound to tabId2, not tabId1
      expect(manager.getTabForSession(sessionId)).toBe(tabId2);
      expect(manager.getSessionForTab(tabId1)).toBeUndefined();
      expect(manager.getSessionForTab(tabId2)).toBe(sessionId);
    });

    it('should enforce one session per tab (last-write-wins)', async () => {
      const sessionId1 = 'session-1';
      const sessionId2 = 'session-2';
      const tabId = 123;
      const tabInfo: TabInfo = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue({ id: tabId });
      await manager.bindTabToSession(sessionId1, tabId, tabInfo);
      await manager.bindTabToSession(sessionId2, tabId, tabInfo);

      // Tab should now be bound to sessionId2, not sessionId1
      expect(manager.getSessionForTab(tabId)).toBe(sessionId2);
      expect(manager.getTabForSession(sessionId1)).toBe(-1);
      expect(manager.getTabForSession(sessionId2)).toBe(tabId);
    });
  });

  describe('Invariant 3: Atomicity (Last-Write-Wins)', () => {
    it('should handle concurrent bindings with last-write-wins', async () => {
      const sessionId1 = 'session-1';
      const sessionId2 = 'session-2';
      const tabId = 123;
      const tabInfo: TabInfo = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue({ id: tabId });

      // Simulate concurrent bindings
      await Promise.all([
        manager.bindTabToSession(sessionId1, tabId, tabInfo),
        manager.bindTabToSession(sessionId2, tabId, tabInfo),
      ]);

      // One of them should win (last write)
      const winningSession = manager.getSessionForTab(tabId);
      expect([sessionId1, sessionId2]).toContain(winningSession);

      // The other session should not be bound to this tab
      const losingSession = winningSession === sessionId1 ? sessionId2 : sessionId1;
      expect(manager.getTabForSession(losingSession)).toBe(-1);
    });
  });

  describe('Invariant 4: Persistence', () => {
    it('should persist bindings to chrome.storage.local', async () => {
      const sessionId = 'session-1';
      const tabId = 123;
      const tabInfo: TabInfo = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue({ id: tabId });
      await manager.bindTabToSession(sessionId, tabId, tabInfo);

      expect(chromeMock.storage.local.set).toHaveBeenCalled();
      const setCall = chromeMock.storage.local.set.mock.calls[
        chromeMock.storage.local.set.mock.calls.length - 1
      ][0];
      expect(setCall.tabBindings).toBeDefined();
      expect(setCall.tabBindings[tabId]).toBeDefined();
      expect(setCall.tabBindings[tabId].sessionId).toBe(sessionId);
    });

    it('should restore bindings from storage on initialize', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      // Mock storage with existing binding
      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          [tabId]: {
            tabId,
            sessionId,
            boundAt: Date.now(),
            tabTitle: 'Example',
            tabUrl: 'https://example.com',
          },
        },
      });

      // Mock tab validation
      chromeMock.tabs.get.mockResolvedValue({ id: tabId });

      // Create new manager instance
      (TabManager as any).instance = null;
      const newManager = TabManager.getInstance();
      await newManager.initialize();

      // Should restore binding from storage
      expect(newManager.getSessionForTab(tabId)).toBe(sessionId);
      expect(newManager.getTabForSession(sessionId)).toBe(tabId);
    });

    it('should remove stale bindings on initialize', async () => {
      const sessionId = 'session-1';
      const tabId = 123;

      // Mock storage with existing binding
      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          [tabId]: {
            tabId,
            sessionId,
            boundAt: Date.now(),
            tabTitle: 'Example',
            tabUrl: 'https://example.com',
          },
        },
      });

      // Mock tab validation failure (tab no longer exists)
      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 123'));

      // Create new manager instance
      (TabManager as any).instance = null;
      const newManager = TabManager.getInstance();
      await newManager.initialize();

      // Should NOT restore binding (tab is invalid)
      expect(newManager.getSessionForTab(tabId)).toBeUndefined();
      expect(newManager.getTabForSession(sessionId)).toBe(-1);
    });
  });

  describe('Invariant 5: Validation', () => {
    it('should return valid state when tab exists', async () => {
      const tabId = 123;
      const mockTab = { id: tabId, url: 'https://example.com' };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      const result = await manager.validateTab(tabId);

      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.tab).toEqual(mockTab);
      }
    });

    it('should return invalid state when tab does not exist', async () => {
      const tabId = 123;

      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 123'));

      const result = await manager.validateTab(tabId);

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect([TabInvalidReason.NOT_FOUND, TabInvalidReason.CLOSED]).toContain(
          result.reason
        );
      }
    });

    it('should return invalid state for tabId = -1', async () => {
      const result = await manager.validateTab(-1);

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe(TabInvalidReason.NOT_FOUND);
      }
    });

    it('should detect permission errors', async () => {
      const tabId = 123;

      chromeMock.tabs.get.mockRejectedValue(new Error('permission denied'));

      const result = await manager.validateTab(tabId);

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe(TabInvalidReason.PERMISSION_DENIED);
      }
    });
  });

  describe('Event Listeners', () => {
    it('should register chrome.tabs.onRemoved listener on initialize', async () => {
      expect(chromeMock.tabs.onRemoved.addListener).toHaveBeenCalled();
    });

    it('should register chrome.tabs.onUpdated listener on initialize', async () => {
      expect(chromeMock.tabs.onUpdated.addListener).toHaveBeenCalled();
    });

    it('should notify listeners when tab is closed', async () => {
      const sessionId = 'session-1';
      const tabId = 123;
      const tabInfo: TabInfo = {
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue({ id: tabId });
      await manager.bindTabToSession(sessionId, tabId, tabInfo);

      const listener = vi.fn();
      manager.onTabClosed(listener);

      // Simulate tab removal
      const onRemovedHandler = chromeMock.tabs.onRemoved.addListener.mock.calls[0][0];
      onRemovedHandler(tabId, {});

      expect(listener).toHaveBeenCalledWith(sessionId, tabId);
    });
  });

  describe('Edge Cases', () => {
    it('should handle unbinding non-existent tab gracefully', async () => {
      await manager.unbindTab(999);
      // Should not throw
      expect(manager.getSessionForTab(999)).toBeUndefined();
    });

    it('should handle unbinding non-existent session gracefully', async () => {
      await manager.unbindSession('non-existent');
      // Should not throw
      expect(manager.getTabForSession('non-existent')).toBe(-1);
    });

    it('should handle getBinding for unbound tab', () => {
      const binding = manager.getBinding(999);
      expect(binding).toBeUndefined();
    });
  });
});
