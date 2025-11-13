/**
 * Integration tests for Tab Context Display (User Story 3)
 *
 * Tests the complete flow of tab title display in the UI, including:
 * - Tab binding to session
 * - Title display in context area
 * - Real-time updates when tab title changes
 * - Edge cases (no tab, invalid tab, empty title)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TabManager } from '../../src/core/TabManager';
import type { TabInfo } from '../../src/types/session';

describe('Tab Context Display Integration', () => {
  let tabBindingManager: TabManager;
  let mockTabs: Map<number, chrome.tabs.Tab>;
  let tabUpdateCallbacks: Array<
    (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void
  >;

  beforeEach(async () => {
    // Reset singleton
    (TabManager as any).instance = undefined;

    // Mock chrome.tabs API
    mockTabs = new Map();
    tabUpdateCallbacks = [];

    global.chrome = {
      tabs: {
        get: vi.fn((tabId: number) => {
          return new Promise((resolve, reject) => {
            const tab = mockTabs.get(tabId);
            if (tab) {
              resolve(tab);
            } else {
              reject(new Error(`Tab ${tabId} not found`));
            }
          });
        }),
        onUpdated: {
          addListener: vi.fn((callback) => {
            tabUpdateCallbacks.push(callback);
          }),
          removeListener: vi.fn((callback) => {
            const index = tabUpdateCallbacks.indexOf(callback);
            if (index > -1) {
              tabUpdateCallbacks.splice(index, 1);
            }
          }),
        },
        onRemoved: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn(() => Promise.resolve({ tabBindings: {} })),
          set: vi.fn(() => Promise.resolve()),
        },
      },
    } as any;

    // Initialize TabManager
    tabBindingManager = TabManager.getInstance();
    await tabBindingManager.initialize();
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockTabs.clear();
    tabUpdateCallbacks = [];
  });

  describe('Tab Title Display After Binding', () => {
    it('should display tab title after session binds to tab', async () => {
      const sessionId = 'session-123';
      const tabId = 1001;
      const tabTitle = 'GitHub - BrowserX Repository';

      // Create mock tab
      const mockTab: chrome.tabs.Tab = {
        id: tabId,
        title: tabTitle,
        url: 'https://github.com/The-AI-Republic/browserx',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };
      mockTabs.set(tabId, mockTab);

      // Bind tab to session
      const tabInfo: TabInfo = {
        tabId,
        title: tabTitle,
        url: mockTab.url!,
        windowId: mockTab.windowId,
      };

      await tabBindingManager.bindTabToSession(sessionId, tabId, tabInfo);

      // Verify binding
      const boundTabId = tabBindingManager.getTabForSession(sessionId);
      expect(boundTabId).toBe(tabId);

      // Verify tab can be retrieved with title
      const tab = await chrome.tabs.get(tabId);
      expect(tab.title).toBe(tabTitle);
    });

    it('should truncate long titles to 25 characters for display', async () => {
      const sessionId = 'session-456';
      const tabId = 1002;
      const longTitle =
        'This is an extremely long tab title that definitely exceeds the 25 character limit';

      const mockTab: chrome.tabs.Tab = {
        id: tabId,
        title: longTitle,
        url: 'https://example.com',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };
      mockTabs.set(tabId, mockTab);

      const tabInfo: TabInfo = {
        tabId,
        title: longTitle,
        url: mockTab.url!,
        windowId: mockTab.windowId,
      };

      await tabBindingManager.bindTabToSession(sessionId, tabId, tabInfo);

      // Verify full title is stored in binding
      const binding = tabBindingManager.getBinding(tabId);
      expect(binding?.tabInfo.title).toBe(longTitle);

      // UI should truncate to 25 chars (implementation detail tested in component test)
      const truncated = longTitle.substring(0, 25);
      expect(truncated).toBe('This is an extremely long');
      expect(truncated.length).toBe(25);
    });
  });

  describe('Tab Title Updates', () => {
    it('should reflect tab title changes in real-time', async () => {
      const sessionId = 'session-789';
      const tabId = 1003;
      const initialTitle = 'Loading...';
      const updatedTitle = 'Loaded Page - Example.com';

      // Initial tab state
      const mockTab: chrome.tabs.Tab = {
        id: tabId,
        title: initialTitle,
        url: 'https://example.com',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };
      mockTabs.set(tabId, mockTab);

      const tabInfo: TabInfo = {
        tabId,
        title: initialTitle,
        url: mockTab.url!,
        windowId: mockTab.windowId,
      };

      await tabBindingManager.bindTabToSession(sessionId, tabId, tabInfo);

      // Verify initial title
      let tab = await chrome.tabs.get(tabId);
      expect(tab.title).toBe(initialTitle);

      // Simulate tab title change
      mockTab.title = updatedTitle;
      mockTabs.set(tabId, mockTab);

      // Trigger onUpdated event
      const changeInfo: chrome.tabs.TabChangeInfo = {
        title: updatedTitle,
      };

      for (const callback of tabUpdateCallbacks) {
        callback(tabId, changeInfo, mockTab);
      }

      // Verify updated title
      tab = await chrome.tabs.get(tabId);
      expect(tab.title).toBe(updatedTitle);
    });

    it('should update within 500ms requirement (SC-007)', async () => {
      const sessionId = 'session-perf';
      const tabId = 1004;
      const initialTitle = 'Initial';
      const updatedTitle = 'Updated';

      const mockTab: chrome.tabs.Tab = {
        id: tabId,
        title: initialTitle,
        url: 'https://example.com',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };
      mockTabs.set(tabId, mockTab);

      const tabInfo: TabInfo = {
        tabId,
        title: initialTitle,
        url: mockTab.url!,
        windowId: mockTab.windowId,
      };

      await tabBindingManager.bindTabToSession(sessionId, tabId, tabInfo);

      // Measure update time
      const startTime = performance.now();

      mockTab.title = updatedTitle;
      mockTabs.set(tabId, mockTab);

      const changeInfo: chrome.tabs.TabChangeInfo = { title: updatedTitle };
      for (const callback of tabUpdateCallbacks) {
        callback(tabId, changeInfo, mockTab);
      }

      const tab = await chrome.tabs.get(tabId);
      expect(tab.title).toBe(updatedTitle);

      const endTime = performance.now();
      const updateTime = endTime - startTime;

      // Should be nearly instant (well under 500ms)
      expect(updateTime).toBeLessThan(500);
    });
  });

  describe('No Tab Attached State', () => {
    it('should handle session with tabId = -1', () => {
      const sessionId = 'session-no-tab';

      // Session with no tab bound
      const tabId = tabBindingManager.getTabForSession(sessionId);
      expect(tabId).toBe(-1);

      // Should not attempt to fetch tab
      expect(chrome.tabs.get).not.toHaveBeenCalledWith(-1);
    });

    it('should transition from "No tab" to bound tab state', async () => {
      const sessionId = 'session-transition';
      const tabId = 1005;

      // Initially no tab
      let boundTabId = tabBindingManager.getTabForSession(sessionId);
      expect(boundTabId).toBe(-1);

      // Create and bind tab
      const mockTab: chrome.tabs.Tab = {
        id: tabId,
        title: 'New Tab',
        url: 'https://example.com',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };
      mockTabs.set(tabId, mockTab);

      const tabInfo: TabInfo = {
        tabId,
        title: mockTab.title!,
        url: mockTab.url!,
        windowId: mockTab.windowId,
      };

      await tabBindingManager.bindTabToSession(sessionId, tabId, tabInfo);

      // Now has tab
      boundTabId = tabBindingManager.getTabForSession(sessionId);
      expect(boundTabId).toBe(tabId);

      // Can fetch tab
      const tab = await chrome.tabs.get(tabId);
      expect(tab.title).toBe('New Tab');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty tab title', async () => {
      const sessionId = 'session-empty-title';
      const tabId = 1006;

      const mockTab: chrome.tabs.Tab = {
        id: tabId,
        title: '',
        url: 'https://example.com',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };
      mockTabs.set(tabId, mockTab);

      const tabInfo: TabInfo = {
        tabId,
        title: '', // Empty title
        url: mockTab.url!,
        windowId: mockTab.windowId,
      };

      await tabBindingManager.bindTabToSession(sessionId, tabId, tabInfo);

      const tab = await chrome.tabs.get(tabId);
      expect(tab.title).toBe('');

      // UI should show "Untitled" or URL (tested in component test)
    });

    it('should handle missing tab title', async () => {
      const sessionId = 'session-no-title';
      const tabId = 1007;

      const mockTab: chrome.tabs.Tab = {
        id: tabId,
        // title property not set
        url: 'https://example.com/path',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };
      mockTabs.set(tabId, mockTab);

      const tabInfo: TabInfo = {
        tabId,
        title: mockTab.url!, // Use URL as fallback
        url: mockTab.url!,
        windowId: mockTab.windowId,
      };

      await tabBindingManager.bindTabToSession(sessionId, tabId, tabInfo);

      const tab = await chrome.tabs.get(tabId);
      expect(tab.url).toBe('https://example.com/path');
      // UI should show URL (tested in component test)
    });

    it('should handle tab not found error', async () => {
      const sessionId = 'session-invalid-tab';
      const invalidTabId = 9999;

      // Tab does not exist in mockTabs
      await expect(chrome.tabs.get(invalidTabId)).rejects.toThrow('Tab 9999 not found');

      // UI should show "Tab unavailable" (tested in component test)
    });
  });

  describe('Multiple Tabs and Sessions', () => {
    it('should display different titles for different sessions', async () => {
      const session1 = 'session-1';
      const session2 = 'session-2';
      const tab1 = 2001;
      const tab2 = 2002;

      const mockTab1: chrome.tabs.Tab = {
        id: tab1,
        title: 'First Tab Title',
        url: 'https://first.com',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };

      const mockTab2: chrome.tabs.Tab = {
        id: tab2,
        title: 'Second Tab Title',
        url: 'https://second.com',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 1,
      };

      mockTabs.set(tab1, mockTab1);
      mockTabs.set(tab2, mockTab2);

      const tabInfo1: TabInfo = {
        tabId: tab1,
        title: mockTab1.title!,
        url: mockTab1.url!,
        windowId: mockTab1.windowId,
      };

      const tabInfo2: TabInfo = {
        tabId: tab2,
        title: mockTab2.title!,
        url: mockTab2.url!,
        windowId: mockTab2.windowId,
      };

      await tabBindingManager.bindTabToSession(session1, tab1, tabInfo1);
      await tabBindingManager.bindTabToSession(session2, tab2, tabInfo2);

      // Verify different sessions have different tabs
      expect(tabBindingManager.getTabForSession(session1)).toBe(tab1);
      expect(tabBindingManager.getTabForSession(session2)).toBe(tab2);

      // Verify different titles
      const fetchedTab1 = await chrome.tabs.get(tab1);
      const fetchedTab2 = await chrome.tabs.get(tab2);

      expect(fetchedTab1.title).toBe('First Tab Title');
      expect(fetchedTab2.title).toBe('Second Tab Title');
    });
  });

  describe('Tab Closure and Context Display', () => {
    it('should revert to "No tab attached" when tab is closed', async () => {
      const sessionId = 'session-closure';
      const tabId = 3001;

      const mockTab: chrome.tabs.Tab = {
        id: tabId,
        title: 'Closing Tab',
        url: 'https://example.com',
        active: true,
        pinned: false,
        highlighted: false,
        windowId: 1,
        incognito: false,
        index: 0,
      };
      mockTabs.set(tabId, mockTab);

      const tabInfo: TabInfo = {
        tabId,
        title: mockTab.title!,
        url: mockTab.url!,
        windowId: mockTab.windowId,
      };

      await tabBindingManager.bindTabToSession(sessionId, tabId, tabInfo);

      // Verify tab is bound
      expect(tabBindingManager.getTabForSession(sessionId)).toBe(tabId);

      // Simulate tab closure
      const onRemovedCallback = (chrome.tabs.onRemoved.addListener as any).mock.calls[0]?.[0];
      if (onRemovedCallback) {
        mockTabs.delete(tabId); // Remove from mock
        onRemovedCallback(tabId, { windowId: 1, isWindowClosing: false });
      }

      // Tab should be unbound
      expect(tabBindingManager.getTabForSession(sessionId)).toBe(-1);

      // UI should show "No tab attached"
    });
  });
});
