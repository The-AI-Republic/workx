import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TabManager } from '@/core/TabManager';
import { TabInvalidReason } from '@/types/session';

/**
 * Helper to create a TabManager instance and wait for async initialization to complete.
 * getInstance() calls initialize() but does NOT await it, so we need to flush microtasks.
 */
async function createInitializedTabManager(): Promise<TabManager> {
  const tm = TabManager.getInstance();
  // Flush microtasks so that the async initialize() (which calls await reset())
  // completes and setupChromeEventListeners() registers its listeners.
  await vi.waitFor(() => {
    expect((chrome.tabs.onRemoved.addListener as any).mock.calls.length).toBeGreaterThan(0);
  });
  return tm;
}

describe('TabManager', () => {
  beforeEach(() => {
    // Reset singleton between tests
    (TabManager as any).instance = null;

    // Add missing chrome APIs for TabManager tests.
    // setup.ts provides a basic chrome mock but TabManager needs richer mocks.
    (chrome as any).tabs = {
      ...chrome.tabs,
      get: vi.fn(),
      create: vi.fn(),
      group: vi.fn(),
      ungroup: vi.fn(),
      move: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (chrome as any).tabGroups = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      get: vi.fn(),
      TAB_GROUP_ID_NONE: -1,
    };
    (chrome as any).windows = {
      get: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Singleton pattern ───────────────────────────────────────────────

  describe('Singleton pattern', () => {
    it('should create an instance via getInstance()', async () => {
      const instance = await createInitializedTabManager();
      expect(instance).toBeInstanceOf(TabManager);
    });

    it('should return the same instance on subsequent calls', async () => {
      const first = await createInitializedTabManager();
      const second = TabManager.getInstance();
      expect(first).toBe(second);
    });

    it('should create a new instance after resetting the singleton', async () => {
      const first = await createInitializedTabManager();
      (TabManager as any).instance = null;
      const second = await createInitializedTabManager();
      expect(first).not.toBe(second);
    });
  });

  // ─── initialize() ───────────────────────────────────────────────────

  describe('initialize()', () => {
    it('should set up Chrome event listeners on first call', async () => {
      await createInitializedTabManager();
      expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
      expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent - second call does not add duplicate listeners', async () => {
      const tm = await createInitializedTabManager();
      // call initialize() again explicitly
      await tm.initialize();
      expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
      expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    });

    it('should call reset() during initialization to clean up existing groups', async () => {
      await createInitializedTabManager();
      // reset() queries for collapsed and expanded pi groups
      expect(chrome.tabGroups.query).toHaveBeenCalledWith({ title: 'browserx', collapsed: true });
      expect(chrome.tabGroups.query).toHaveBeenCalledWith({ title: 'browserx', collapsed: false });
    });
  });

  // ─── onTabClosure ───────────────────────────────────────────────────

  describe('onTabClosure()', () => {
    it('should register a callback and return an unsubscribe function', async () => {
      const tm = await createInitializedTabManager();
      const callback = vi.fn();
      const unsubscribe = tm.onTabClosure(callback);
      expect(typeof unsubscribe).toBe('function');
    });

    it('should invoke registered callback when a tab is closed via onRemoved', async () => {
      const tm = await createInitializedTabManager();
      const callback = vi.fn();
      tm.onTabClosure(callback);

      // Get the onRemoved listener that was registered during initialize
      const onRemovedListener = (chrome.tabs.onRemoved.addListener as any).mock.calls[0][0];
      // Simulate tab removal
      onRemovedListener(42, { windowId: 1, isWindowClosing: false });

      expect(callback).toHaveBeenCalledWith(42);
    });

    it('should invoke multiple registered callbacks', async () => {
      const tm = await createInitializedTabManager();
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      tm.onTabClosure(callback1);
      tm.onTabClosure(callback2);

      const onRemovedListener = (chrome.tabs.onRemoved.addListener as any).mock.calls[0][0];
      onRemovedListener(10, { windowId: 1, isWindowClosing: false });

      expect(callback1).toHaveBeenCalledWith(10);
      expect(callback2).toHaveBeenCalledWith(10);
    });

    it('should not invoke callback after unsubscribe', async () => {
      const tm = await createInitializedTabManager();
      const callback = vi.fn();
      const unsubscribe = tm.onTabClosure(callback);

      unsubscribe();

      const onRemovedListener = (chrome.tabs.onRemoved.addListener as any).mock.calls[0][0];
      onRemovedListener(42, { windowId: 1, isWindowClosing: false });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle unsubscribe called multiple times gracefully', async () => {
      const tm = await createInitializedTabManager();
      const callback = vi.fn();
      const unsubscribe = tm.onTabClosure(callback);

      unsubscribe();
      unsubscribe(); // second call should not throw

      const onRemovedListener = (chrome.tabs.onRemoved.addListener as any).mock.calls[0][0];
      onRemovedListener(42, { windowId: 1, isWindowClosing: false });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ─── notifyTabClosure (via Chrome event listeners) ──────────────────

  describe('notifyTabClosure (private, via listeners)', () => {
    it('should notify on tab crash (status=loading, tab.status=unloaded)', async () => {
      const tm = await createInitializedTabManager();
      const callback = vi.fn();
      tm.onTabClosure(callback);

      const onUpdatedListener = (chrome.tabs.onUpdated.addListener as any).mock.calls[0][0];
      onUpdatedListener(
        99,
        { status: 'loading' },
        { id: 99, status: 'unloaded' } as chrome.tabs.Tab,
      );

      expect(callback).toHaveBeenCalledWith(99);
    });

    it('should NOT notify for normal tab status updates', async () => {
      const tm = await createInitializedTabManager();
      const callback = vi.fn();
      tm.onTabClosure(callback);

      const onUpdatedListener = (chrome.tabs.onUpdated.addListener as any).mock.calls[0][0];
      // Normal loading state is not a crash
      onUpdatedListener(
        99,
        { status: 'loading' },
        { id: 99, status: 'loading' } as chrome.tabs.Tab,
      );

      expect(callback).not.toHaveBeenCalled();
    });

    it('should NOT notify when changeInfo.status is complete', async () => {
      const tm = await createInitializedTabManager();
      const callback = vi.fn();
      tm.onTabClosure(callback);

      const onUpdatedListener = (chrome.tabs.onUpdated.addListener as any).mock.calls[0][0];
      onUpdatedListener(
        99,
        { status: 'complete' },
        { id: 99, status: 'complete' } as chrome.tabs.Tab,
      );

      expect(callback).not.toHaveBeenCalled();
    });

    it('should catch sync errors in callbacks without breaking other callbacks', async () => {
      const tm = await createInitializedTabManager();
      const errorCallback = vi.fn(() => { throw new Error('sync error'); });
      const goodCallback = vi.fn();
      tm.onTabClosure(errorCallback);
      tm.onTabClosure(goodCallback);

      const onRemovedListener = (chrome.tabs.onRemoved.addListener as any).mock.calls[0][0];
      // Should not throw
      expect(() => onRemovedListener(7, { windowId: 1, isWindowClosing: false })).not.toThrow();
      expect(goodCallback).toHaveBeenCalledWith(7);
    });

    it('should handle async callback rejection gracefully', async () => {
      const tm = await createInitializedTabManager();
      const asyncCallback = vi.fn().mockRejectedValue(new Error('async error'));
      tm.onTabClosure(asyncCallback);

      const onRemovedListener = (chrome.tabs.onRemoved.addListener as any).mock.calls[0][0];
      // Should not throw
      expect(() => onRemovedListener(8, { windowId: 1, isWindowClosing: false })).not.toThrow();
      expect(asyncCallback).toHaveBeenCalledWith(8);
    });
  });

  // ─── validateTab ────────────────────────────────────────────────────

  describe('validateTab()', () => {
    it('should return invalid with NOT_FOUND for tabId -1', async () => {
      const tm = await createInitializedTabManager();
      const result = await tm.validateTab(-1);
      expect(result).toEqual({
        status: 'invalid',
        reason: TabInvalidReason.NOT_FOUND,
      });
      // chrome.tabs.get should not be called for -1
      expect(chrome.tabs.get).not.toHaveBeenCalled();
    });

    it('should return valid with tab object for existing tab', async () => {
      const mockTab = { id: 5, url: 'https://example.com', status: 'complete' } as chrome.tabs.Tab;
      (chrome.tabs.get as any).mockResolvedValue(mockTab);

      const tm = await createInitializedTabManager();
      const result = await tm.validateTab(5);
      expect(result).toEqual({
        status: 'valid',
        tab: mockTab,
      });
      expect(chrome.tabs.get).toHaveBeenCalledWith(5);
    });

    it('should return invalid with PERMISSION_DENIED when error mentions permission', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockRejectedValue(new Error('No permission to access tab'));

      const result = await tm.validateTab(100);
      expect(result).toEqual({
        status: 'invalid',
        reason: TabInvalidReason.PERMISSION_DENIED,
      });
    });

    it('should return invalid with CLOSED when error mentions "No tab"', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockRejectedValue(new Error('No tab with id: 200'));

      const result = await tm.validateTab(200);
      expect(result).toEqual({
        status: 'invalid',
        reason: TabInvalidReason.CLOSED,
      });
    });

    it('should return invalid with NOT_FOUND for generic errors', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockRejectedValue(new Error('Unknown error'));

      const result = await tm.validateTab(300);
      expect(result).toEqual({
        status: 'invalid',
        reason: TabInvalidReason.NOT_FOUND,
      });
    });
  });

  // ─── createTab ──────────────────────────────────────────────────────

  describe('createTab()', () => {
    it('should create a tab and return its ID on success', async () => {
      (chrome.tabs.create as any).mockResolvedValue({ id: 42, url: 'about:blank' });

      const tm = await createInitializedTabManager();
      const tabId = await tm.createTab();
      expect(tabId).toBe(42);
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'about:blank',
        active: false,
        pinned: false,
        windowId: undefined,
      });
    });

    it('should pass custom options through to chrome.tabs.create', async () => {
      (chrome.tabs.create as any).mockResolvedValue({ id: 55, url: 'https://example.com' });

      const tm = await createInitializedTabManager();
      const tabId = await tm.createTab({
        url: 'https://example.com',
        active: true,
        pinned: true,
        windowId: 10,
      });
      expect(tabId).toBe(55);
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'https://example.com',
        active: true,
        pinned: true,
        windowId: 10,
      });
    });

    it('should return null when created tab has no ID', async () => {
      (chrome.tabs.create as any).mockResolvedValue({ url: 'about:blank' }); // no id

      const tm = await createInitializedTabManager();
      const tabId = await tm.createTab();
      expect(tabId).toBeNull();
    });

    it('should return null when chrome.tabs.create throws', async () => {
      (chrome.tabs.create as any).mockRejectedValue(new Error('Cannot create tab'));

      const tm = await createInitializedTabManager();
      const tabId = await tm.createTab();
      expect(tabId).toBeNull();
    });

    it('should default url to about:blank when not provided', async () => {
      (chrome.tabs.create as any).mockResolvedValue({ id: 60 });

      const tm = await createInitializedTabManager();
      await tm.createTab({});
      expect(chrome.tabs.create).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'about:blank' }),
      );
    });
  });

  // ─── addTabToGroup ──────────────────────────────────────────────────

  describe('addTabToGroup()', () => {
    it('should return null when tabGroups API is unavailable', async () => {
      const tm = await createInitializedTabManager();
      delete (chrome as any).tabGroups;

      const result = await tm.addTabToGroup(1);
      expect(result).toBeNull();
    });

    it('should return null when tab is not found', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockResolvedValue(null);

      const result = await tm.addTabToGroup(999);
      expect(result).toBeNull();
    });

    it('should create a new group when no group exists and tab is in normal window', async () => {
      const tm = await createInitializedTabManager();

      const mockTab = { id: 10, windowId: 1 } as chrome.tabs.Tab;
      (chrome.tabs.get as any).mockResolvedValue(mockTab);
      (chrome.windows.get as any).mockResolvedValue({ id: 1, type: 'normal' });
      (chrome.tabs.group as any).mockResolvedValue(77);
      (chrome.tabGroups.update as any).mockResolvedValue({});

      const result = await tm.addTabToGroup(10);
      // createBrowserXGroup should have been called, setting groupId
      expect(result).toBe(77);
      expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: 10 });
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(77, {
        title: 'browserx',
        color: 'blue',
        collapsed: false,
      });
    });

    it('should add tab to existing group', async () => {
      const tm = await createInitializedTabManager();

      const mockTab = { id: 20, windowId: 1 } as chrome.tabs.Tab;
      (chrome.tabs.get as any).mockResolvedValue(mockTab);
      (chrome.windows.get as any).mockResolvedValue({ id: 1, type: 'normal' });
      (chrome.tabGroups.get as any).mockResolvedValue({ id: 77, windowId: 1 });
      (chrome.tabs.group as any).mockResolvedValue(77);
      (chrome.tabGroups.update as any).mockResolvedValue({});

      // Manually set groupId as if a group already exists
      (tm as any).groupId = 77;

      const result = await tm.addTabToGroup(20);
      expect(result).toBe(77);
      expect(chrome.tabs.group).toHaveBeenCalledWith({
        tabIds: 20,
        groupId: 77,
      });
    });

    it('should create a new group when previous group no longer exists', async () => {
      const tm = await createInitializedTabManager();

      const mockTab = { id: 30, windowId: 1 } as chrome.tabs.Tab;
      (chrome.tabs.get as any).mockResolvedValue(mockTab);
      (chrome.windows.get as any).mockResolvedValue({ id: 1, type: 'normal' });
      // tabGroups.get throws (group no longer exists)
      (chrome.tabGroups.get as any).mockRejectedValue(new Error('Group not found'));
      (chrome.tabs.group as any).mockResolvedValue(88);
      (chrome.tabGroups.update as any).mockResolvedValue({});

      (tm as any).groupId = 50; // stale group ID

      const result = await tm.addTabToGroup(30);
      // Should have reset groupId and created a new group
      expect(result).toBe(88);
    });

    it('should return null when chrome.tabs.get throws', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockRejectedValue(new Error('Something went wrong'));

      const result = await tm.addTabToGroup(1);
      expect(result).toBeNull();
    });

    it('should return null when tab cannot be moved to a normal window', async () => {
      const tm = await createInitializedTabManager();

      const mockTab = { id: 40, windowId: 2 } as chrome.tabs.Tab;
      (chrome.tabs.get as any).mockResolvedValue(mockTab);
      // Tab's window is not a normal window (e.g., popup)
      (chrome.windows.get as any).mockResolvedValue({ id: 2, type: 'popup' });
      // No normal windows available
      (chrome.windows.getAll as any).mockResolvedValue([]);
      // Creating a window fails
      (chrome.windows.create as any).mockResolvedValue(null);

      const result = await tm.addTabToGroup(40);
      expect(result).toBeNull();
    });
  });

  // ─── removeTabFromGroup ─────────────────────────────────────────────

  describe('removeTabFromGroup()', () => {
    it('should return early when tabGroups API is unavailable', async () => {
      const tm = await createInitializedTabManager();
      delete (chrome as any).tabGroups;

      await expect(tm.removeTabFromGroup(1)).resolves.toBeUndefined();
      // chrome.tabs.get should not have been called for this removeTabFromGroup call
    });

    it('should return early when tab is not found', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockResolvedValue(null);

      await tm.removeTabFromGroup(999);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
    });

    it('should skip ungrouping when tab is not in any group (TAB_GROUP_ID_NONE)', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockResolvedValue({ id: 5, groupId: -1 });

      await tm.removeTabFromGroup(5);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
    });

    it('should ungroup tab when it belongs to the pi group', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockResolvedValue({ id: 10, groupId: 77 });
      (chrome.tabs.ungroup as any).mockResolvedValue(undefined);
      (tm as any).groupId = 77;

      await tm.removeTabFromGroup(10);
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith(10);
    });

    it('should NOT ungroup tab when it belongs to a different group', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockResolvedValue({ id: 10, groupId: 99 });
      (tm as any).groupId = 77;

      await tm.removeTabFromGroup(10);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully during ungrouping', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockRejectedValue(new Error('Tab error'));

      // Should not throw
      await expect(tm.removeTabFromGroup(10)).resolves.toBeUndefined();
    });

    it('should skip ungrouping when groupId is null even if tab has a groupId', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabs.get as any).mockResolvedValue({ id: 10, groupId: 55 });
      (tm as any).groupId = null;

      await tm.removeTabFromGroup(10);
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
    });
  });

  // ─── reset ──────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('should return early when tabGroups API is unavailable', async () => {
      const tm = await createInitializedTabManager();
      delete (chrome as any).tabGroups;

      await expect(tm.reset()).resolves.toBeUndefined();
    });

    it('should set groupId to null when no pi groups exist', async () => {
      const tm = await createInitializedTabManager();
      (tm as any).groupId = 10;

      // reset() queries return empty
      (chrome.tabGroups.query as any).mockResolvedValue([]);

      await tm.reset();
      expect((tm as any).groupId).toBeNull();
    });

    it('should ungroup tabs from collapsed and expanded groups', async () => {
      const tm = await createInitializedTabManager();

      const collapsedGroup = { id: 1, title: 'browserx', collapsed: true };
      const expandedGroup = { id: 2, title: 'browserx', collapsed: false };

      (chrome.tabGroups.query as any).mockImplementation((params: any) => {
        if (params.collapsed === true) return Promise.resolve([collapsedGroup]);
        if (params.collapsed === false) return Promise.resolve([expandedGroup]);
        return Promise.resolve([]);
      });

      (chrome.tabs.query as any).mockImplementation((params: any) => {
        if (params.groupId === 1) return Promise.resolve([{ id: 10 }, { id: 11 }]);
        if (params.groupId === 2) return Promise.resolve([{ id: 20 }]);
        return Promise.resolve([]);
      });
      (chrome.tabs.ungroup as any).mockResolvedValue(undefined);
      (chrome.tabGroups.update as any).mockResolvedValue({});

      await tm.reset();

      // Collapsed group should be expanded first
      expect(chrome.tabGroups.update).toHaveBeenCalledWith(1, { collapsed: false });
      // Then tabs ungrouped
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith([10, 11]);
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith([20]);
    });

    it('should skip ungrouping for groups with no tabs', async () => {
      const tm = await createInitializedTabManager();

      (chrome.tabGroups.query as any).mockResolvedValue([{ id: 3, title: 'browserx', collapsed: false }]);
      (chrome.tabs.query as any).mockResolvedValue([]); // no tabs in group

      await tm.reset();
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
    });

    it('should handle errors when processing individual groups', async () => {
      const tm = await createInitializedTabManager();

      (chrome.tabGroups.query as any).mockResolvedValue([
        { id: 1, title: 'browserx', collapsed: false },
        { id: 2, title: 'browserx', collapsed: false },
      ]);

      (chrome.tabs.query as any).mockImplementation((params: any) => {
        if (params.groupId === 1) return Promise.reject(new Error('Query failed'));
        if (params.groupId === 2) return Promise.resolve([{ id: 30 }]);
        return Promise.resolve([]);
      });
      (chrome.tabs.ungroup as any).mockResolvedValue(undefined);

      // Should not throw; first group errors, second succeeds
      await expect(tm.reset()).resolves.toBeUndefined();
      // Second group's tab should still be ungrouped
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith([30]);
    });

    it('should filter out tabs with undefined IDs', async () => {
      const tm = await createInitializedTabManager();

      (chrome.tabGroups.query as any).mockResolvedValue([{ id: 5, title: 'browserx', collapsed: false }]);
      (chrome.tabs.query as any).mockResolvedValue([
        { id: 10 },
        { id: undefined },
        { id: 20 },
      ]);
      (chrome.tabs.ungroup as any).mockResolvedValue(undefined);

      await tm.reset();
      // Should only ungroup valid IDs
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith([10, 20]);
    });

    it('should set groupId to null after ungrouping', async () => {
      const tm = await createInitializedTabManager();
      (tm as any).groupId = 42;

      (chrome.tabGroups.query as any).mockResolvedValue([{ id: 42, title: 'browserx', collapsed: false }]);
      (chrome.tabs.query as any).mockResolvedValue([{ id: 1 }]);
      (chrome.tabs.ungroup as any).mockResolvedValue(undefined);

      await tm.reset();
      expect((tm as any).groupId).toBeNull();
    });
  });

  // ─── clearAllTabsFromGroup ──────────────────────────────────────────

  describe('clearAllTabsFromGroup()', () => {
    it('should return early when tabGroups API is unavailable', async () => {
      const tm = await createInitializedTabManager();
      delete (chrome as any).tabGroups;

      await expect(tm.clearAllTabsFromGroup()).resolves.toBeUndefined();
    });

    it('should set groupId to null when no pi groups exist', async () => {
      const tm = await createInitializedTabManager();
      (tm as any).groupId = 5;

      (chrome.tabGroups.query as any).mockResolvedValue([]);
      await tm.clearAllTabsFromGroup();
      expect((tm as any).groupId).toBeNull();
    });

    it('should ungroup tabs from all pi groups', async () => {
      const tm = await createInitializedTabManager();
      (tm as any).groupId = 1;

      (chrome.tabGroups.query as any).mockResolvedValue([
        { id: 1, title: 'browserx' },
        { id: 2, title: 'browserx' },
      ]);
      (chrome.tabs.query as any).mockImplementation((params: any) => {
        if (params.groupId === 1) return Promise.resolve([{ id: 10 }, { id: 11 }]);
        if (params.groupId === 2) return Promise.resolve([{ id: 20 }]);
        return Promise.resolve([]);
      });
      (chrome.tabs.ungroup as any).mockResolvedValue(undefined);

      await tm.clearAllTabsFromGroup();

      expect(chrome.tabs.ungroup).toHaveBeenCalledWith([10, 11]);
      expect(chrome.tabs.ungroup).toHaveBeenCalledWith([20]);
      expect((tm as any).groupId).toBeNull();
    });

    it('should skip groups with no tabs', async () => {
      const tm = await createInitializedTabManager();

      (chrome.tabGroups.query as any).mockResolvedValue([
        { id: 1, title: 'browserx' },
      ]);
      (chrome.tabs.query as any).mockResolvedValue([]);

      await tm.clearAllTabsFromGroup();
      expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
    });

    it('should handle errors when ungrouping individual groups', async () => {
      const tm = await createInitializedTabManager();

      (chrome.tabGroups.query as any).mockResolvedValue([
        { id: 1, title: 'browserx' },
        { id: 2, title: 'browserx' },
      ]);
      (chrome.tabs.query as any).mockImplementation((params: any) => {
        if (params.groupId === 1) return Promise.resolve([{ id: 10 }]);
        if (params.groupId === 2) return Promise.resolve([{ id: 20 }]);
        return Promise.resolve([]);
      });
      (chrome.tabs.ungroup as any)
        .mockRejectedValueOnce(new Error('Ungroup failed'))
        .mockResolvedValueOnce(undefined);

      // Should not throw even though first ungroup fails
      await expect(tm.clearAllTabsFromGroup()).resolves.toBeUndefined();
      // Both groups should have been attempted
      expect(chrome.tabs.ungroup).toHaveBeenCalledTimes(2);
    });

    it('should handle top-level query error gracefully', async () => {
      const tm = await createInitializedTabManager();
      (chrome.tabGroups.query as any).mockRejectedValue(new Error('Query failed'));

      // Should not throw
      await expect(tm.clearAllTabsFromGroup()).resolves.toBeUndefined();
    });

    it('should set groupId to null after clearing', async () => {
      const tm = await createInitializedTabManager();
      (tm as any).groupId = 99;

      (chrome.tabGroups.query as any).mockResolvedValue([{ id: 99, title: 'browserx' }]);
      (chrome.tabs.query as any).mockResolvedValue([{ id: 1 }]);
      (chrome.tabs.ungroup as any).mockResolvedValue(undefined);

      await tm.clearAllTabsFromGroup();
      expect((tm as any).groupId).toBeNull();
    });
  });
});
