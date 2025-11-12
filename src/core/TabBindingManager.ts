/**
 * TabBindingManager - Manages tab-to-session bindings
 *
 * Responsibilities:
 * - Track bidirectional mappings between sessions and tabs
 * - Enforce one-tab-per-session constraint
 * - Handle tab lifecycle events (closure, crashes)
 * - Validate tab existence before operations
 */

import type { TabBindingState, TabValidationState, TabInvalidReason, TabInfo } from '../types/session';

/**
 * Callback type for tab closure events
 */
export type TabClosedCallback = (sessionId: string, tabId: number) => void;

/**
 * TabBindingManager singleton class
 */
export class TabBindingManager {
  private static instance: TabBindingManager | null = null;

  // In-memory registries for fast lookups (T006)
  private tabToSession: Map<number, string> = new Map(); // tabId -> sessionId
  private sessionToTab: Map<string, number> = new Map(); // sessionId -> tabId
  private bindings: Map<number, TabBindingState> = new Map(); // tabId -> full binding info

  // Event listeners
  private tabClosedCallbacks: TabClosedCallback[] = [];
  private initialized: boolean = false;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get singleton instance
   */
  static getInstance(): TabBindingManager {
    if (!TabBindingManager.instance) {
      const newInstance = new TabBindingManager();
      newInstance.initialize();
      TabBindingManager.instance = newInstance;
    }
    return TabBindingManager.instance;
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

    this.initialized = true;
  }

  /**
   * T007: Bind a tab to a session (last-write-wins logic)
   * T085: Notify previous session when it loses tab binding
   */
  async bindTabToSession(sessionId: string, tabId: number, tabInfo: TabInfo): Promise<void> {
    // Check if tab already bound to a different session
    const existingSessionId = this.tabToSession.get(tabId);
    if (existingSessionId && existingSessionId !== sessionId) {
      // Last-write-wins: unbind previous session
      this.sessionToTab.delete(existingSessionId);
      console.log(`[TabBindingManager] Tab ${tabId} rebound from session ${existingSessionId} to ${sessionId}`);

      // T085: Notify the previous session that it lost its tab binding
      this.notifyTabClosed(existingSessionId, tabId);
    }

    // Unbind session's previous tab if any
    const existingTabId = this.sessionToTab.get(sessionId);
    if (existingTabId && existingTabId !== tabId) {
      this.tabToSession.delete(existingTabId);
      this.bindings.delete(existingTabId);
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
  }

  /**
   * T008: Unbind a tab from its session
   */
  unbindTab(tabId: number): void {
    const sessionId = this.tabToSession.get(tabId);
    if (sessionId) {
      this.tabToSession.delete(tabId);
      this.sessionToTab.delete(sessionId);
      this.bindings.delete(tabId);
    }
  }

  /**
   * T009: Unbind a session from its tab
   */
  unbindSession(sessionId: string): void {
    const tabId = this.sessionToTab.get(sessionId);
    if (tabId !== undefined) {
      this.tabToSession.delete(tabId);
      this.sessionToTab.delete(sessionId);
      this.bindings.delete(tabId);
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
   * T018: Register a callback for tab closure events
   */
  onTabClosed(callback: TabClosedCallback): void {
    this.tabClosedCallbacks.push(callback);
  }

  /**
   * T016: Handle tab removed event
   */
  private handleTabRemoved(tabId: number, removeInfo: chrome.tabs.TabRemoveInfo): void {
    const sessionId = this.tabToSession.get(tabId);
    if (sessionId) {
      console.log(`[TabBindingManager] Tab ${tabId} closed for session ${sessionId}`);

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
        console.log(`[TabBindingManager] Tab ${tabId} crashed for session ${sessionId}`);

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
        console.error('[TabBindingManager] Error in tab closed callback:', error);
      }
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
