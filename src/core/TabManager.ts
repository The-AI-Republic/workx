/**
 * TabManager - Chrome Tab API Manager
 *
 * Responsibilities:
 * - Handle all Chrome extension tab API interactions
 * - Validate tab existence before operations
 * - Manage tab group operations
 * - Create new tabs
 * - Listen to tab lifecycle events (closure, crashes)
 *
 * NOTE: TabManager is stateless. It provides callbacks for tab events but doesn't store tab-session mappings.
 *       SessionState is the source of truth for tabId.
 */

import type { TabValidationState, TabInfo } from '../types/session';
import { TabInvalidReason } from '../types/session';

/**
 * Callback type for tab closure events
 * @param tabId - The tab that was closed
 */
export type TabClosureCallback = (tabId: number) => void | Promise<void>;

/**
 * TabManager singleton class
 * Centralizes all Chrome tab API interactions
 */
export class TabManager {
  private static instance: TabManager | null = null;

  // Tab group management (merged from TabGroupManager - T014)
  private groupId: number | null = null;
  private readonly groupTitle = 'browserx';
  private readonly groupColor: chrome.tabGroups.ColorEnum = 'blue';

  // Event callbacks (stateless - just notify about tab events)
  private tabClosureCallbacks: TabClosureCallback[] = [];

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
   * Initialize tab manager
   * Sets up tab group and event listeners
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Clean up all existing pi groups on initialization
    await this.reset();

    // Setup Chrome event listeners
    this.setupChromeEventListeners();

    this.initialized = true;
  }

  /**
   * Setup Chrome tab event listeners
   */
  private setupChromeEventListeners(): void {
    // Listen for tab closure
    chrome.tabs.onRemoved.addListener((tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => {
      console.log(`[TabManager] Tab ${tabId} closed`);
      this.notifyTabClosure(tabId);
    });

    // Listen for tab crashes
    chrome.tabs.onUpdated.addListener((
      tabId: number,
      changeInfo: { status?: string; url?: string; pinned?: boolean; audible?: boolean; discarded?: boolean; autoDiscardable?: boolean; groupId?: number; favIconUrl?: string; title?: string },
      tab: chrome.tabs.Tab
    ) => {
      // Detect crashed or unresponsive tabs
      if (changeInfo.status === 'loading' && tab.status === 'unloaded') {
        console.log(`[TabManager] Tab ${tabId} crashed`);
        this.notifyTabClosure(tabId);
      }
    });
  }

  /**
   * Register a callback for tab closure events
   * The callback receives the tabId that was closed/crashed
   * @param callback - Function to call when a tab closes
   * @returns Unsubscribe function to remove the callback
   */
  onTabClosure(callback: TabClosureCallback): () => void {
    this.tabClosureCallbacks.push(callback);
    // Return unsubscribe function
    return () => {
      const index = this.tabClosureCallbacks.indexOf(callback);
      if (index > -1) {
        this.tabClosureCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Notify all registered callbacks about tab closure
   * @param tabId - The tab that was closed
   */
  private notifyTabClosure(tabId: number): void {
    for (const callback of this.tabClosureCallbacks) {
      try {
        const result = callback(tabId);
        // Handle both sync and async callbacks
        if (result instanceof Promise) {
          result.catch(error => {
            console.error('[TabManager] Error in tab closure callback:', error);
          });
        }
      } catch (error) {
        console.error('[TabManager] Error in tab closure callback:', error);
      }
    }
  }


  /**
   * Validate that a tab exists and is accessible
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
   * Ensure Pi tab group exists (merged from TabGroupManager)
   * Finds or prepares to create the "pi" tab group
   * Gracefully degrades if chrome.tabGroups API is unavailable
   */
  private async ensurePiGroup(): Promise<void> {
    // Check if tab groups API is available
    if (typeof chrome === 'undefined' || !chrome.tabGroups) {
      console.warn('[TabManager] Tab Groups API not available, grouping disabled');
      this.groupId = null;
      return;
    }

    try {
      // Try to find existing Pi group
      const groups = await chrome.tabGroups.query({ title: this.groupTitle });

      if (groups.length > 0) {
        // Use existing group
        this.groupId = groups[0].id;
        console.log(`[TabManager] Found existing Pi tab group: ${this.groupId}`);

        // Ensure it has the correct color
        await chrome.tabGroups.update(this.groupId, {
          title: this.groupTitle,
          color: this.groupColor as chrome.tabGroups.Color,
        });
      } else {
        console.log('[TabManager] No existing Pi tab group found, will create on first tab');
      }
    } catch (error) {
      console.error('[TabManager] Failed to initialize tab group:', error);
      this.groupId = null;
    }
  }

  /**
   * Create Pi tab group (merged from TabGroupManager)
   * @param tabId - Initial tab to add to the group
   */
  private async createPiGroup(tabId: number): Promise<void> {
    try {
      // Ensure tab is in a normal window
      let tab = await chrome.tabs.get(tabId);
      if (!tab) {
        console.error(`[TabManager] Unable to create group: tab ${tabId} not found`);
        return;
      }

      const normalizedTab = await this.ensureTabInNormalWindow(tab);
      if (!normalizedTab) {
        console.warn(`[TabManager] Cannot create Pi group: tab ${tabId} could not be moved to a normal window`);
        return;
      }
      tab = normalizedTab;
      tabId = tab.id!;

      // Group the tab (this creates a new group)
      const groupId = await chrome.tabs.group({ tabIds: tabId });

      // Configure the group
      await chrome.tabGroups.update(groupId, {
        title: this.groupTitle,
        color: this.groupColor as chrome.tabGroups.Color,
        collapsed: false,
      });

      this.groupId = groupId;
      console.log(`[TabManager] Created Pi tab group: ${this.groupId}`);
    } catch (error) {
      console.error('[TabManager] Failed to create tab group:', error);
      this.groupId = null;
    }
  }

  /**
   * Check if tab is in a normal window (merged from TabGroupManager)
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
   * Ensure tab is in a normal window (merged from TabGroupManager)
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
        if (!newWindow) {
          console.warn('[TabManager] Failed to create a new window');
          return null;
        }
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
   * Move tab to window (merged from TabGroupManager)
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
   * Create a new tab
   * @param options - Tab creation options (url, active, etc.)
   * @returns The created tab ID, or null if creation failed
   */
  async createTab(options: chrome.tabs.CreateProperties = {}): Promise<number | null> {
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

      console.log(`[TabManager] Created tab ${tab.id}`);
      return tab.id;
    } catch (error) {
      console.error(`[TabManager] Failed to create tab:`, error);
      return null;
    }
  }

  /**
   * Add tab to Pi group
   * Gracefully degrades if tab groups API is unavailable
   * @param tabId - Tab ID to add to group
   * @returns The group ID, or null if grouping failed
   */
  async addTabToGroup(tabId: number): Promise<number | null> {
    // Skip grouping if API is unavailable
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
        await this.createPiGroup(tabId);
        return this.groupId;
      }

      // Add tab to existing group
      await chrome.tabs.group({
        tabIds: tabId,
        groupId: this.groupId,
      });

      console.log(`[TabManager] Added tab ${tabId} to Pi group ${this.groupId}`);
      return this.groupId;
    } catch (error) {
      console.error(`[TabManager] Failed to add tab ${tabId} to group:`, error);
      return null;
    }
  }

  /**
   * Remove tab from Pi group
   * Gracefully degrades if tab groups API is unavailable
   * @param tabId - Tab ID to remove from group
   */
  async removeTabFromGroup(tabId: number): Promise<void> {
    // Skip ungrouping if API is unavailable
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

      // Only remove from our Pi group
      if (this.groupId !== null && tab.groupId === this.groupId) {
        await chrome.tabs.ungroup(tabId);
        console.log(`[TabManager] Removed tab ${tabId} from Pi group ${this.groupId}`);
      } else {
        console.log(`[TabManager] Tab ${tabId} is in a different group (${tab.groupId}), not removing`);
      }
    } catch (error) {
      console.error(`[TabManager] Failed to remove tab ${tabId} from group:`, error);
    }
  }

  /**
   * Reset TabManager by ungrouping all tabs from "pi" groups (tabs stay open)
   * All "pi" groups (both collapsed and expanded) will be deleted after ungrouping their tabs
   * Called during session reset and initialization to clean up all pi groups
   */
  async reset(): Promise<void> {
    // Skip if API is unavailable
    if (typeof chrome === 'undefined' || !chrome.tabGroups) {
      return;
    }

    // Query for both collapsed and non-collapsed pi groups
    const [collapsedGroups, expandedGroups] = await Promise.all([
      chrome.tabGroups.query({ title: this.groupTitle, collapsed: true }),
      chrome.tabGroups.query({ title: this.groupTitle, collapsed: false }),
    ]);

    const allGroups = [...collapsedGroups, ...expandedGroups];

    if (allGroups.length === 0) {
      this.groupId = null;
      return;
    }

    // Ungroup all tabs from each pi group
    for (const group of allGroups) {
      try {
        // First, expand the group if it's collapsed (to ensure we can access all tabs)
        if (group.collapsed) {
          try {
            await chrome.tabGroups.update(group.id, { collapsed: false });
          } catch {
            // Ignore error expanding group
          }
        }

        // Get all tabs in this group
        const tabs = await chrome.tabs.query({ groupId: group.id });
        const tabIds = tabs.map(tab => tab.id).filter((id): id is number => id !== undefined);

        if (tabIds.length > 0) {
          await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
        }
      } catch (error) {
        console.error(`[TabManager] Failed to reset pi group ${group.id}:`, error);
      }
    }

    this.groupId = null;
  }

  /**
   * Remove all tabs from all Pi groups (ungroup without closing)
   * Used when switching tabs to ensure consistency
   */
  async clearAllTabsFromGroup(): Promise<void> {
    // Skip if API is unavailable
    if (typeof chrome === 'undefined' || !chrome.tabGroups) {
      return;
    }

    try {
      // Find all pi groups
      const groups = await chrome.tabGroups.query({ title: this.groupTitle });

      if (groups.length === 0) {
        this.groupId = null;
        return;
      }

      // Ungroup tabs from all pi groups
      for (const group of groups) {
        try {
          const tabs = await chrome.tabs.query({ groupId: group.id });
          const tabIds = tabs.map(tab => tab.id).filter((id): id is number => id !== undefined);

          if (tabIds.length > 0) {
            await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
          }
        } catch (error) {
          console.error(`[TabManager] Failed to ungroup tabs from group ${group.id}:`, error);
        }
      }

      this.groupId = null;
    } catch (error) {
      console.error('[TabManager] Failed to clear tabs from Pi groups:', error);
    }
  }

}
