/**
 * Integration Test: Session Tab Lifecycle
 *
 * Purpose: Validates the complete session-tab binding lifecycle from initialization to termination
 *
 * Test Scenarios:
 * 1. Session initialization with tabId = -1 (no tab attached)
 * 2. Tab creation and binding on first browser operation
 * 3. Tab validation before operations
 * 4. Session restoration with tab binding
 * 5. Tab binding persistence across restarts
 *
 * User Story: US1 - Session Initiates with Tab Binding
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Session } from '@/core/Session';
import { TabManager } from '@/core/TabManager';
import type { SessionServices } from '@/core/Session';
import { ModelClient } from '@/core/models/ModelClient';

describe('Session Tab Lifecycle Integration Tests', () => {
  let chromeMock: any;
  let session: Session;
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
    const bindingManager = TabManager.getInstance();
    await bindingManager.initialize();

    // Mock services
    mockServices = {
      // Add mock services as needed
    } as SessionServices;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('US1: Session Initialization', () => {
    it('should initialize new session with tabId = -1', async () => {
      session = new Session('session-1', false, mockServices);

      // New session should have no tab attached
      const tabId = session.getTabId();
      expect(tabId).toBe(-1);

      // Should not be bound to any tab
      const bindingManager = TabManager.getInstance();
      expect(bindingManager.getTabForSession('session-1')).toBe(-1);
    });

    it('should not have tab attached initially', () => {
      session = new Session('session-2', false, mockServices);

      // Check via session state
      const hasTab = session.hasTabAttached();
      expect(hasTab).toBe(false);
    });
  });

  describe('US1: Tab Creation and Binding', () => {
    it('should bind tab when created for session', async () => {
      session = new Session('session-1', false, mockServices);
      const bindingManager = TabManager.getInstance();

      const mockTab = {
        id: 123,
        url: 'https://example.com',
        title: 'Example Page',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      chromeMock.tabs.create.mockResolvedValue(mockTab);

      // Simulate tab creation
      await bindingManager.bindTabToSession('session-1', 123, mockTab as any);

      // Session should now have tab attached
      expect(bindingManager.getTabForSession('session-1')).toBe(123);
      expect(bindingManager.getSessionForTab(123)).toBe('session-1');
    });

    it('should prevent creating new tab if session already has tab bound', async () => {
      session = new Session('session-1', false, mockServices);
      const bindingManager = TabManager.getInstance();

      const mockTab = {
        id: 123,
        url: 'https://example.com',
        title: 'Example Page',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Bind first tab
      await bindingManager.bindTabToSession('session-1', 123, mockTab as any);

      // Verify tab is bound
      const tabId = bindingManager.getTabForSession('session-1');
      expect(tabId).toBe(123);

      // Attempting to create/bind another tab should follow last-write-wins
      const mockTab2 = { ...mockTab, id: 456 };
      chromeMock.tabs.get.mockResolvedValue(mockTab2);
      await bindingManager.bindTabToSession('session-1', 456, mockTab2 as any);

      // Session should now be bound to the new tab
      expect(bindingManager.getTabForSession('session-1')).toBe(456);
      expect(bindingManager.getSessionForTab(123)).toBeUndefined();
    });
  });

  describe('US1: Tab Validation', () => {
    it('should validate tab exists before operations', async () => {
      const bindingManager = TabManager.getInstance();
      const mockTab = { id: 123, url: 'https://example.com' };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      const validation = await bindingManager.validateTab(123);

      expect(validation.status).toBe('valid');
      if (validation.status === 'valid') {
        expect(validation.tab.id).toBe(123);
      }
    });

    it('should detect when tab no longer exists', async () => {
      const bindingManager = TabManager.getInstance();

      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 123'));

      const validation = await bindingManager.validateTab(123);

      expect(validation.status).toBe('invalid');
      if (validation.status === 'invalid') {
        expect(validation.reason).toBeDefined();
      }
    });

    it('should return invalid for tabId = -1', async () => {
      const bindingManager = TabManager.getInstance();

      const validation = await bindingManager.validateTab(-1);

      expect(validation.status).toBe('invalid');
      if (validation.status === 'invalid') {
        expect(validation.reason).toBe('not_found');
      }
    });
  });

  describe('US1: Session Persistence and Restoration', () => {
    it('should persist tab binding with session data', async () => {
      session = new Session('session-1', false, mockServices);
      const bindingManager = TabManager.getInstance();

      const mockTab = {
        id: 123,
        url: 'https://example.com',
        title: 'Example Page',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);
      await bindingManager.bindTabToSession('session-1', 123, mockTab as any);

      // Verify binding was persisted
      expect(chromeMock.storage.local.set).toHaveBeenCalled();
      const setCall = chromeMock.storage.local.set.mock.calls.find(
        (call: any) => call[0].tabBindings
      );
      expect(setCall).toBeDefined();
      expect(setCall[0].tabBindings[123]).toBeDefined();
      expect(setCall[0].tabBindings[123].sessionId).toBe('session-1');
    });

    it('should restore tab binding on session import', async () => {
      const bindingManager = TabManager.getInstance();

      // Mock persisted binding
      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          '123': {
            tabId: 123,
            sessionId: 'session-1',
            boundAt: Date.now(),
            tabTitle: 'Example Page',
            tabUrl: 'https://example.com',
          },
        },
      });

      // Mock tab still exists
      chromeMock.tabs.get.mockResolvedValue({ id: 123 });

      // Re-initialize to load from storage
      (TabManager as any).instance = null;
      const newBindingManager = TabManager.getInstance();
      await newBindingManager.initialize();

      // Binding should be restored
      expect(newBindingManager.getTabForSession('session-1')).toBe(123);
      expect(newBindingManager.getSessionForTab(123)).toBe('session-1');
    });

    it('should reset tabId to -1 when restored tab no longer exists', async () => {
      // Mock persisted binding
      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          '123': {
            tabId: 123,
            sessionId: 'session-1',
            boundAt: Date.now(),
            tabTitle: 'Example Page',
            tabUrl: 'https://example.com',
          },
        },
      });

      // Mock tab no longer exists
      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 123'));

      // Re-initialize to load from storage
      (TabManager as any).instance = null;
      const newBindingManager = TabManager.getInstance();
      await newBindingManager.initialize();

      // Binding should NOT be restored (tab is invalid)
      expect(newBindingManager.getTabForSession('session-1')).toBe(-1);
      expect(newBindingManager.getSessionForTab(123)).toBeUndefined();
    });
  });

  describe('US1: Multiple Session Scenarios', () => {
    it('should support multiple sessions with different tabs', async () => {
      const bindingManager = TabManager.getInstance();

      const tab1 = {
        id: 123,
        url: 'https://example1.com',
        title: 'Example 1',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      const tab2 = {
        id: 456,
        url: 'https://example2.com',
        title: 'Example 2',
        active: false,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 1,
      };

      chromeMock.tabs.get.mockImplementation((tabId: number) => {
        if (tabId === 123) return Promise.resolve(tab1);
        if (tabId === 456) return Promise.resolve(tab2);
        return Promise.reject(new Error(`No tab with id: ${tabId}`));
      });

      await bindingManager.bindTabToSession('session-1', 123, tab1 as any);
      await bindingManager.bindTabToSession('session-2', 456, tab2 as any);

      // Both sessions should have their respective tabs
      expect(bindingManager.getTabForSession('session-1')).toBe(123);
      expect(bindingManager.getTabForSession('session-2')).toBe(456);

      // Tabs should be bound to their respective sessions
      expect(bindingManager.getSessionForTab(123)).toBe('session-1');
      expect(bindingManager.getSessionForTab(456)).toBe('session-2');
    });

    it('should handle session without tab (tabId = -1)', async () => {
      const bindingManager = TabManager.getInstance();

      // Session with no tab bound
      const session1 = new Session('session-unbound', false, mockServices);

      expect(bindingManager.getTabForSession('session-unbound')).toBe(-1);
      expect(session1.hasTabAttached()).toBe(false);
    });
  });

  describe('US1: Tab Binding Lifecycle Edge Cases', () => {
    it('should handle rapid rebinding of same tab to different sessions', async () => {
      const bindingManager = TabManager.getInstance();

      const mockTab = {
        id: 123,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Rapidly bind same tab to different sessions
      await bindingManager.bindTabToSession('session-1', 123, mockTab as any);
      await bindingManager.bindTabToSession('session-2', 123, mockTab as any);
      await bindingManager.bindTabToSession('session-3', 123, mockTab as any);

      // Last write wins: tab should be bound to session-3
      expect(bindingManager.getSessionForTab(123)).toBe('session-3');
      expect(bindingManager.getTabForSession('session-3')).toBe(123);

      // Previous sessions should not be bound to this tab
      expect(bindingManager.getTabForSession('session-1')).toBe(-1);
      expect(bindingManager.getTabForSession('session-2')).toBe(-1);
    });

    it('should handle unbinding and rebinding', async () => {
      const bindingManager = TabManager.getInstance();

      const mockTab = {
        id: 123,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Bind
      await bindingManager.bindTabToSession('session-1', 123, mockTab as any);
      expect(bindingManager.getTabForSession('session-1')).toBe(123);

      // Unbind
      await bindingManager.unbindTab(123);
      expect(bindingManager.getTabForSession('session-1')).toBe(-1);
      expect(bindingManager.getSessionForTab(123)).toBeUndefined();

      // Rebind to different session
      await bindingManager.bindTabToSession('session-2', 123, mockTab as any);
      expect(bindingManager.getTabForSession('session-2')).toBe(123);
      expect(bindingManager.getSessionForTab(123)).toBe('session-2');
    });
  });

  describe('US4: Multi-Operation Tab Consistency', () => {
    it('should use same tabId for all operations in a session', async () => {
      const bindingManager = TabManager.getInstance();

      const mockTab = {
        id: 999,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Bind tab to session
      await bindingManager.bindTabToSession('session-multi-op', 999, mockTab as any);

      // Simulate multiple sequential operations
      const operations = [
        'navigate',
        'click_element',
        'fill_form',
        'capture_screenshot',
        'scroll',
      ];

      const tabIdsUsed: number[] = [];

      for (const operation of operations) {
        // Each operation should query the binding
        const tabId = bindingManager.getTabForSession('session-multi-op');
        tabIdsUsed.push(tabId);

        // Validate tab before operation
        const validation = await bindingManager.validateTab(tabId);
        expect(validation.status).toBe('valid');
      }

      // All operations should have used the same tabId
      expect(tabIdsUsed).toEqual([999, 999, 999, 999, 999]);
      expect(new Set(tabIdsUsed).size).toBe(1); // Only one unique tabId

      // Final verification
      expect(bindingManager.getTabForSession('session-multi-op')).toBe(999);
    });

    it('should maintain tab consistency across turn boundaries', async () => {
      const bindingManager = TabManager.getInstance();

      const mockTab = {
        id: 777,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Bind tab
      await bindingManager.bindTabToSession('session-turns', 777, mockTab as any);

      // Simulate multiple turns (conversation turns)
      for (let turn = 1; turn <= 5; turn++) {
        // Start of turn
        const tabIdAtStart = bindingManager.getTabForSession('session-turns');
        expect(tabIdAtStart).toBe(777);

        // Operation during turn
        const validation = await bindingManager.validateTab(tabIdAtStart);
        expect(validation.status).toBe('valid');

        // End of turn - verify tabId hasn't changed
        const tabIdAtEnd = bindingManager.getTabForSession('session-turns');
        expect(tabIdAtEnd).toBe(tabIdAtStart);
      }

      // After all turns, tab should still be the same
      expect(bindingManager.getTabForSession('session-turns')).toBe(777);
    });

    it('should prevent tab proliferation (multiple tabs for one session)', async () => {
      const bindingManager = TabManager.getInstance();

      const tab1 = {
        id: 100,
        url: 'https://example.com',
        title: 'Tab 1',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      const tab2 = {
        id: 200,
        url: 'https://example.com',
        title: 'Tab 2',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 1,
      };

      chromeMock.tabs.get.mockImplementation((tabId: number) => {
        if (tabId === 100) return Promise.resolve(tab1);
        if (tabId === 200) return Promise.resolve(tab2);
        return Promise.reject(new Error(`No tab with id: ${tabId}`));
      });

      // Bind first tab
      await bindingManager.bindTabToSession('session-single-tab', 100, tab1 as any);
      expect(bindingManager.getTabForSession('session-single-tab')).toBe(100);

      // Attempt to bind second tab (last-write-wins)
      await bindingManager.bindTabToSession('session-single-tab', 200, tab2 as any);

      // Session should now be bound to second tab (unbinding first)
      expect(bindingManager.getTabForSession('session-single-tab')).toBe(200);
      expect(bindingManager.getSessionForTab(100)).toBeUndefined();
      expect(bindingManager.getSessionForTab(200)).toBe('session-single-tab');

      // Verify only one tab is bound to the session
      const allBindings = [100, 200].map(tabId =>
        bindingManager.getSessionForTab(tabId)
      ).filter(sessionId => sessionId === 'session-single-tab');

      expect(allBindings.length).toBe(1); // Only one binding
    });

    it('should maintain consistency during rapid operations', async () => {
      const bindingManager = TabManager.getInstance();

      const mockTab = {
        id: 555,
        url: 'https://example.com',
        title: 'Rapid Operations',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Bind tab
      await bindingManager.bindTabToSession('session-rapid', 555, mockTab as any);

      // Simulate rapid concurrent-like operations
      const rapidOps = Array.from({ length: 20 }, (_, i) => i);
      const tabIdPromises = rapidOps.map(async () => {
        const tabId = bindingManager.getTabForSession('session-rapid');
        await bindingManager.validateTab(tabId);
        return tabId;
      });

      const tabIds = await Promise.all(tabIdPromises);

      // All should return the same tabId
      expect(tabIds.every(id => id === 555)).toBe(true);
      expect(new Set(tabIds).size).toBe(1);
    });
  });
});
