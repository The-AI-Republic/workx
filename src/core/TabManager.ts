/**
 * TabManager - Manages tab-to-session bindings
 *
 * Responsibilities:
 * - Track bidirectional mappings between sessions and tabs
 * - Enforce one-tab-per-session constraint
 * - Handle tab lifecycle events (closure, crashes)
 * - Validate tab existence before operations
 */

import type { TabBindingState, TabValidationState, TabInfo } from '../types/session';
import { TabInvalidReason } from '../types/session';

/**
 * Callback type for tab closure events (when tab is actually closed)
 */
export type TabClosedCallback = (sessionId: string, tabId: number) => void;

/**
 * Callback type for tab unbinding events (when session loses tab, but tab is still open)
 */
export type TabUnboundCallback = (sessionId: string, oldTabId: number, reason: 'rebind' | 'manual') => void;

/**
 * TabManager singleton class
 */
export class TabManager {
  private static instance: TabManager | null = null;

  // In-memory registries for fast lookups (T006)
  private tabToSession: Map<number, string> = new Map(); // tabId -> sessionId
  private sessionToTab: Map<string, number> = new Map(); // sessionId -> tabId
  private bindings: Map<number, TabBindingState> = new Map(); // tabId -> full binding info

  // Tab group management (merged from TabGroupManager - T014)
  private groupId: number | null = null;
  private readonly groupTitle = 'browserx';
  private readonly groupColor: chrome.tabGroups.ColorEnum = 'blue';

  // Event listeners
  private tabClosedCallbacks: TabClosedCallback[] = [];
  private tabUnboundCallbacks: TabUnboundCallback[] = [];
  private initialized: boolean = false;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get singleton instance
   */
  static getInstance(): TabManager {
    if (!TabManager.instance) {
      const newInstance = new TabManager();
      newInstance.initialize();
      TabManager.instance = newInstance;
    }
    return TabManager.instance;
  }

  /**
   * T015: Initialize binding manager
   * Sets up event listeners for tab lifecycle
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // T016: Register chrome.tabs.onRemoved event listener
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));

    // T017: Register chrome.tabs.onUpdated event listener (for crash detection)
    chrome.tabs.onUpdated.addListener(this.handleTabUpdated.bind(this));

    // T020: Initialize tab group (find or prepare to create "browserx" group)
    await this.ensureBrowserXGroup();

    this.initialized = true;
  }

  /**
   * T007: Bind a tab to a session (last-write-wins logic)
   * T085: Notify previous session when it loses tab binding
   * @param options.silent - If true, suppress unbind notifications (used for context-based tab switching)
   */
  async bindTabToSession(
    sessionId: string,
    tabId: number,
    tabInfo: Pick<TabInfo, 'title' | 'url'>,
    options?: { silent?: boolean }
  ): Promise<{ previousTabId?: number; switchedFromTab: boolean }> {
    const silent = options?.silent ?? false;

    // Check if tab already bound to a different session
    const existingSessionId = this.tabToSession.get(tabId);
    if (existingSessionId && existingSessionId !== sessionId) {
      // Last-write-wins: unbind previous session's tab
      // T085: Notify the previous session that it lost its tab binding (tab is still open, just reassigned)
      await this.unbindTab(tabId, 'rebind', silent);
      console.log(`[TabManager] Tab ${tabId} rebound from session ${existingSessionId} to ${sessionId}`);
    }

    // Unbind session's previous tab if any
    const existingTabId = this.sessionToTab.get(sessionId);
    const switchedFromTab = existingTabId !== undefined && existingTabId !== tabId;

    if (switchedFromTab) {
      // Reuse unbindTab to clean up the old tab binding
      // Notify that the session is switching to a different tab
      await this.unbindTab(existingTabId, 'manual', silent);
    }

    // Establish new binding
    const binding: TabBindingState = {
      tabId,
      sessionId,
      boundAt: Date.now(),
      tabTitle: tabInfo.title || 'Untitled',
      tabUrl: tabInfo.url || '',
    };

    this.tabToSession.set(tabId, sessionId);
    this.sessionToTab.set(sessionId, tabId);
    this.bindings.set(tabId, binding);

    // T021: Add tab to BrowserX group after binding
    await this.addTabToGroup(tabId);

    // Return information about whether this was a tab switch
    return {
      previousTabId: switchedFromTab ? existingTabId : undefined,
      switchedFromTab,
    };
  }

  /**
   * T008: Unbind a tab from its session
   * @param reason - Reason for unbinding (used for notification callbacks)
   * @param silent - If true, suppress unbind notifications
   */
  async unbindTab(tabId: number, reason?: 'rebind' | 'manual', silent: boolean = false): Promise<void> {
    const sessionId = this.tabToSession.get(tabId);
    if (sessionId) {
      this.tabToSession.delete(tabId);
      this.sessionToTab.delete(sessionId);
      this.bindings.delete(tabId);

      // Remove tab from BrowserX group to maintain consistency with bound tabs
      await this.removeTabFromGroup(tabId);

      // Notify listeners if reason provided and not silent
      if (reason && !silent) {
        this.notifyTabUnbind(sessionId, tabId, reason);
      }
    }
  }

  /**
   * T009: Unbind a session from its tab
   * @param reason - Reason for unbinding (used for notification callbacks)
   * @param silent - If true, suppress unbind notifications
   */
  async unbindSession(sessionId: string, reason?: 'rebind' | 'manual', silent: boolean = false): Promise<void> {
    const tabId = this.sessionToTab.get(sessionId);
    if (tabId !== undefined) {
      this.tabToSession.delete(tabId);
      this.sessionToTab.delete(sessionId);
      this.bindings.delete(tabId);

      // Remove tab from BrowserX group to maintain consistency with bound tabs
      await this.removeTabFromGroup(tabId);

      // Notify listeners if reason provided and not silent
      if (reason && !silent) {
        this.notifyTabUnbind(sessionId, tabId, reason);
      }
    }
  }

  /**
   * T010: Get the session bound to a tab
   */
  getSessionForTab(tabId: number): string | undefined {
    return this.tabToSession.get(tabId);
  }

  /**
   * T011: Get the tab bound to a session
   */
  getTabForSession(sessionId: string): number {
    return this.sessionToTab.get(sessionId) ?? -1;
  }

  /**
   * T012: Get full binding information for a tab
   */
  getBinding(tabId: number): TabBindingState | undefined {
    return this.bindings.get(tabId);
  }

  /**
   * T013: Validate that a tab exists and is accessible
   * Performance requirement: <100ms
   */
  async validateTab(tabId: number): Promise<TabValidationState> {
    if (tabId === -1) {
      return {
        status: 'invalid',
        reason: TabInvalidReason.NOT_FOUND,
      };
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      return {
        status: 'valid',
        tab,
      };
    } catch (error: any) {
      // Determine reason based on error message
      let reason = TabInvalidReason.NOT_FOUND;
      if (error.message?.includes('permission')) {
        reason = TabInvalidReason.PERMISSION_DENIED;
      } else if (error.message?.includes('No tab')) {
        reason = TabInvalidReason.CLOSED;
      }

      return {
        status: 'invalid',
        reason,
      };
    }
  }

  /**
   * T018: Register a callback for tab closure events (when tab is actually closed)
   */
  onTabClosed(callback: TabClosedCallback): void {
    this.tabClosedCallbacks.push(callback);
  }

  /**
   * Register a callback for tab unbinding events (when session loses tab, but tab is still open)
   */
  onTabUnbound(callback: TabUnboundCallback): void {
    this.tabUnboundCallbacks.push(callback);
  }

  /**
   * T016: Handle tab removed event
   */
  private handleTabRemoved(tabId: number, removeInfo: chrome.tabs.TabRemoveInfo): void {
    const sessionId = this.tabToSession.get(tabId);
    if (sessionId) {
      console.log(`[TabManager] Tab ${tabId} closed for session ${sessionId}`);

      // Unbind synchronously
      this.tabToSession.delete(tabId);
      this.sessionToTab.delete(sessionId);
      this.bindings.delete(tabId);

      // Notify listeners
      this.notifyTabClosed(sessionId, tabId);
    }
  }

  /**
   * T017: Handle tab updated event (for crash detection)
   */
  private handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab
  ): void {
    // Detect crashed or unresponsive tabs
    if (changeInfo.status === 'loading' && tab.status === 'unloaded') {
      const sessionId = this.tabToSession.get(tabId);
      if (sessionId) {
        console.log(`[TabManager] Tab ${tabId} crashed for session ${sessionId}`);

        // Treat as closure
        this.tabToSession.delete(tabId);
        this.sessionToTab.delete(sessionId);
        this.bindings.delete(tabId);

        // Notify listeners
        this.notifyTabClosed(sessionId, tabId);
      }
    }
  }

  /**
   * Notify all registered callbacks of tab closure
   */
  private notifyTabClosed(sessionId: string, tabId: number): void {
    for (const callback of this.tabClosedCallbacks) {
      try {
        callback(sessionId, tabId);
      } catch (error) {
        console.error('[TabManager] Error in tab closed callback:', error);
      }
    }
  }

  /**
   * Notify all registered callbacks of tab unbinding (tab lost but still open)
   */
  private notifyTabUnbind(sessionId: string, tabId: number, reason: 'rebind' | 'manual'): void {
    for (const callback of this.tabUnboundCallbacks) {
      try {
        callback(sessionId, tabId, reason);
      } catch (error) {
        console.error('[TabManager] Error in tab unbound callback:', error);
      }
    }
  }

  /**
   * T015: Ensure BrowserX tab group exists (merged from TabGroupManager)
   * Finds or prepares to create the "browserx" tab group
   * T112: Gracefully degrades if chrome.tabGroups API is unavailable
   */
  private async ensureBrowserXGroup(): Promise<void> {
    // T112: Check if tab groups API is available
    if (typeof chrome === 'undefined' || !chrome.tabGroups) {
      console.warn('[TabManager] Tab Groups API not available, grouping disabled');
      this.groupId = null;
      return;
    }

    try {
      // Try to find existing BrowserX group
      const groups = await chrome.tabGroups.query({ title: this.groupTitle });

      if (groups.length > 0) {
        // Use existing group
        this.groupId = groups[0].id;
        console.log(`[TabManager] Found existing BrowserX tab group: ${this.groupId}`);

        // Ensure it has the correct color
        await chrome.tabGroups.update(this.groupId, {
          title: this.groupTitle,
          color: this.groupColor,
        });
      } else {
        console.log('[TabManager] No existing BrowserX tab group found, will create on first tab');
      }
    } catch (error) {
      console.error('[TabManager] Failed to initialize tab group:', error);
      this.groupId = null;
    }
  }

  /**
   * T016: Create BrowserX tab group (merged from TabGroupManager)
   * @param tabId - Initial tab to add to the group
   */
  private async createBrowserXGroup(tabId: number): Promise<void> {
    try {
      // Ensure tab is in a normal window
      let tab = await chrome.tabs.get(tabId);
      if (!tab) {
        console.error(`[TabManager] Unable to create group: tab ${tabId} not found`);
        return;
      }

      const normalizedTab = await this.ensureTabInNormalWindow(tab);
      if (!normalizedTab) {
        console.warn(`[TabManager] Cannot create BrowserX group: tab ${tabId} could not be moved to a normal window`);
        return;
      }
      tab = normalizedTab;
      tabId = tab.id!;

      // Group the tab (this creates a new group)
      const groupId = await chrome.tabs.group({ tabIds: tabId });

      // Configure the group
      await chrome.tabGroups.update(groupId, {
        title: this.groupTitle,
        color: this.groupColor,
        collapsed: false,
      });

      this.groupId = groupId;
      console.log(`[TabManager] Created BrowserX tab group: ${this.groupId}`);
    } catch (error) {
      console.error('[TabManager] Failed to create tab group:', error);
      this.groupId = null;
    }
  }

  /**
   * T017: Check if tab is in a normal window (merged from TabGroupManager)
   */
  private async isTabInNormalWindow(tab: chrome.tabs.Tab): Promise<boolean> {
    if (tab.windowId === undefined || tab.id === undefined) {
      console.warn('[TabManager] Tab is missing window or tab ID, cannot determine group eligibility');
      return false;
    }

    try {
      const windowInfo = await chrome.windows.get(tab.windowId);
      if (!windowInfo || windowInfo.type !== 'normal') {
        console.warn(
          `[TabManager] Window ${tab.windowId} is not groupable (type: ${windowInfo?.type ?? 'unknown'})`,
        );
        return false;
      }
      return true;
    } catch (error) {
      console.warn(`[TabManager] Failed to determine window type for tab ${tab.id}:`, error);
      return false;
    }
  }

  /**
   * T018: Ensure tab is in a normal window (merged from TabGroupManager)
   */
  private async ensureTabInNormalWindow(
    tab: chrome.tabs.Tab,
    targetWindowId?: number,
  ): Promise<chrome.tabs.Tab | null> {
    if (tab.id === undefined) {
      console.warn('[TabManager] Cannot normalize tab without a valid ID');
      return null;
    }

    try {
      if (targetWindowId !== undefined) {
        try {
          const targetWindow = await chrome.windows.get(targetWindowId);
          if (targetWindow?.type === 'normal') {
            if (tab.windowId !== targetWindowId) {
              const moved = await this.moveTabToWindow(tab.id, targetWindowId);
              if (moved) {
                return moved;
              }
              console.warn(`[TabManager] Failed to move tab ${tab.id} to target window ${targetWindowId}`);
              return null;
            }

            if (await this.isTabInNormalWindow(tab)) {
              return tab;
            }
          } else {
            console.warn(
              `[TabManager] Target window ${targetWindowId} is not normal (type: ${targetWindow?.type ?? 'unknown'})`,
            );
            targetWindowId = undefined;
          }
        } catch (error) {
          console.warn(`[TabManager] Unable to retrieve target window ${targetWindowId}:`, error);
          targetWindowId = undefined;
        }
      }

      if (await this.isTabInNormalWindow(tab)) {
        // Already in a normal window and no specific target required
        return tab;
      }

      const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      let candidateWindowId = normalWindows.find(win => !win.incognito)?.id ?? normalWindows[0]?.id;

      if (candidateWindowId === undefined) {
        const newWindow = await chrome.windows.create({ focused: true });
        candidateWindowId = newWindow.id ?? undefined;
      }

      if (candidateWindowId === undefined) {
        console.warn('[TabManager] Unable to find or create a normal window for grouping');
        return null;
      }

      return await this.moveTabToWindow(tab.id, candidateWindowId);
    } catch (error) {
      console.error(`[TabManager] Failed to ensure tab ${tab.id} is in a normal window:`, error);
      return null;
    }
  }

  /**
   * T019: Move tab to window (merged from TabGroupManager)
   */
  private async moveTabToWindow(tabId: number, windowId: number): Promise<chrome.tabs.Tab | null> {
    try {
      const moved = await chrome.tabs.move(tabId, { windowId, index: -1 });
      const movedTab = Array.isArray(moved) ? moved[0] : moved;
      if (movedTab) {
        return movedTab;
      }
      // Fallback: fetch the tab directly
      return await chrome.tabs.get(tabId);
    } catch (error) {
      console.error(`[TabManager] Failed to move tab ${tabId} to window ${windowId}:`, error);
      return null;
    }
  }

  /**
   * T022: Create and bind a new tab to a session
   * @param sessionId - Session ID to bind the tab to
   * @param options - Tab creation options (url, active, etc.)
   * @returns The created tab ID, or null if creation failed
   */
  async createAndBindTab(sessionId: string, options: chrome.tabs.CreateProperties = {}): Promise<number | null> {
    try {
      // Create the tab
      const tab = await chrome.tabs.create({
        url: options.url || 'about:blank',
        active: options.active ?? false,
        pinned: options.pinned ?? false,
        windowId: options.windowId,
      });

      if (!tab.id) {
        console.error('[TabManager] Created tab has no ID');
        return null;
      }

      // Bind tab to session
      await this.bindTabToSession(sessionId, tab.id, {
        title: tab.title || 'Untitled',
        url: tab.url || '',
      });

      console.log(`[TabManager] Created and bound tab ${tab.id} to session ${sessionId}`);
      return tab.id;
    } catch (error) {
      console.error(`[TabManager] Failed to create and bind tab for session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Add tab to BrowserX group (helper for createAndBindTab and bindTabToSession)
   * T112: Gracefully degrades if tab groups API is unavailable
   */
  private async addTabToGroup(tabId: number): Promise<number | null> {
    // T112: Skip grouping if API is unavailable
    if (typeof chrome === 'undefined' || !chrome.tabGroups) {
      console.log('[TabManager] Tab Groups API not available, skipping grouping');
      return null;
    }

    try {
      // Validate tab exists
      let tab = await chrome.tabs.get(tabId);
      if (!tab) {
        console.error(`[TabManager] Tab ${tabId} not found`);
        return null;
      }

      let targetWindowId: number | undefined;

      if (this.groupId !== null) {
        try {
          const groupInfo = await chrome.tabGroups.get(this.groupId);
          targetWindowId = groupInfo.windowId;
        } catch {
          // Group doesn't exist anymore, create a new one
          console.log('[TabManager] Previous group no longer exists, creating new one');
          this.groupId = null;
        }
      }

      const normalizedTab = await this.ensureTabInNormalWindow(tab, targetWindowId);
      if (!normalizedTab) {
        console.warn(`[TabManager] Tab ${tabId} could not be aligned to a normal window; skipping grouping`);
        return null;
      }
      tab = normalizedTab;
      tabId = tab.id!;

      // If we don't have a group yet, create one
      if (this.groupId === null) {
        await this.createBrowserXGroup(tabId);
        return this.groupId;
      }

      // Add tab to existing group
      await chrome.tabs.group({
        tabIds: tabId,
        groupId: this.groupId,
      });

      console.log(`[TabManager] Added tab ${tabId} to BrowserX group ${this.groupId}`);
      return this.groupId;
    } catch (error) {
      console.error(`[TabManager] Failed to add tab ${tabId} to group:`, error);
      return null;
    }
  }

  /**
   * Remove tab from BrowserX group when unbound from session
   * T112: Gracefully degrades if tab groups API is unavailable
   */
  private async removeTabFromGroup(tabId: number): Promise<void> {
    // T112: Skip ungrouping if API is unavailable
    if (typeof chrome === 'undefined' || !chrome.tabGroups) {
      console.log('[TabManager] Tab Groups API not available, skipping ungrouping');
      return;
    }

    try {
      // Validate tab exists
      const tab = await chrome.tabs.get(tabId);
      if (!tab) {
        console.error(`[TabManager] Tab ${tabId} not found`);
        return;
      }

      // Check if tab is in a group
      if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || tab.groupId === -1) {
        console.log(`[TabManager] Tab ${tabId} is not in a group, skipping ungrouping`);
        return;
      }

      // Only remove from our BrowserX group
      if (this.groupId !== null && tab.groupId === this.groupId) {
        await chrome.tabs.ungroup(tabId);
        console.log(`[TabManager] Removed tab ${tabId} from BrowserX group ${this.groupId}`);
      } else {
        console.log(`[TabManager] Tab ${tabId} is in a different group (${tab.groupId}), not removing`);
      }
    } catch (error) {
      console.error(`[TabManager] Failed to remove tab ${tabId} from group:`, error);
    }
  }

  /**
   * Get debug information about current bindings
   */
  getDebugInfo(): {
    bindingCount: number;
    sessions: string[];
    tabs: number[];
  } {
    return {
      bindingCount: this.bindings.size,
      sessions: Array.from(this.sessionToTab.keys()),
      tabs: Array.from(this.tabToSession.keys()),
    };
  }
}
