/**
 * Tab Store for Side Panel Multi-Tab Support
 *
 * Manages sidepanel tab UI state using Svelte store.
 * Each tab corresponds to an AgentRegistry session.
 * Persists tab state to chrome.storage.local.
 */

import { writable, derived, get, type Writable } from 'svelte/store';

/**
 * Sidepanel tab representation
 */
export interface SidePanelTab {
  /** Unique tab ID (uuid) */
  id: string;
  /** AgentRegistry session ID */
  sessionId: string;
  /** Display title */
  title: string;
  /** Creation timestamp for ordering */
  createdAt: number;
}

/**
 * Tab store state
 */
export interface TabStoreState {
  tabs: SidePanelTab[];
  activeTabId: string | null;
}

/**
 * Persistence key for chrome.storage.local
 */
const STORAGE_KEY = 'browserx_sidepanel_tabs';

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create the tab store
 */
function createTabStore() {
  const initialState: TabStoreState = {
    tabs: [],
    activeTabId: null,
  };

  const { subscribe, set, update }: Writable<TabStoreState> = writable(initialState);

  return {
    subscribe,

    /**
     * Create a new tab for a session
     * @param sessionId The AgentRegistry session ID
     * @param title Optional initial title (defaults to "New Tab")
     * @returns The created tab
     */
    createTab: (sessionId: string, title: string = 'New Tab'): SidePanelTab => {
      const newTab: SidePanelTab = {
        id: generateUUID(),
        sessionId,
        title,
        createdAt: Date.now(),
      };

      update((state) => ({
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id, // Automatically activate new tab
      }));

      // Persist to storage
      persistTabs();

      return newTab;
    },

    /**
     * Close a tab by ID
     * @param tabId The tab ID to close
     */
    closeTab: (tabId: string): void => {
      update((state) => {
        const tabIndex = state.tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return state;

        const newTabs = state.tabs.filter((t) => t.id !== tabId);

        // If closing the active tab, select another tab
        let newActiveId = state.activeTabId;
        if (state.activeTabId === tabId && newTabs.length > 0) {
          // Select the previous tab, or the first if closing the first tab
          const newIndex = Math.min(tabIndex, newTabs.length - 1);
          newActiveId = newTabs[newIndex]?.id || null;
        } else if (newTabs.length === 0) {
          newActiveId = null;
        }

        return {
          tabs: newTabs,
          activeTabId: newActiveId,
        };
      });

      // Persist to storage
      persistTabs();
    },

    /**
     * Set the active tab
     * @param tabId The tab ID to activate
     */
    setActiveTab: (tabId: string): void => {
      update((state) => {
        // Only update if tab exists
        if (state.tabs.some((t) => t.id === tabId)) {
          return { ...state, activeTabId: tabId };
        }
        return state;
      });

      // Persist to storage
      persistTabs();
    },

    /**
     * Update a tab's title
     * @param tabId The tab ID to update
     * @param title The new title
     */
    updateTabTitle: (tabId: string, title: string): void => {
      update((state) => ({
        ...state,
        tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
      }));

      // Persist to storage
      persistTabs();
    },

    /**
     * Get a tab by its session ID
     * @param sessionId The session ID to find
     * @returns The tab or undefined
     */
    getTabBySessionId: (sessionId: string): SidePanelTab | undefined => {
      const state = get({ subscribe });
      return state.tabs.find((t) => t.sessionId === sessionId);
    },

    /**
     * Get the active tab
     * @returns The active tab or undefined
     */
    getActiveTab: (): SidePanelTab | undefined => {
      const state = get({ subscribe });
      return state.tabs.find((t) => t.id === state.activeTabId);
    },

    /**
     * Remove a tab by session ID (for external session termination)
     * @param sessionId The session ID
     */
    removeTabBySessionId: (sessionId: string): void => {
      const state = get({ subscribe });
      const tab = state.tabs.find((t) => t.sessionId === sessionId);
      if (tab) {
        tabStore.closeTab(tab.id);
      }
    },

    /**
     * Restore tabs from chrome.storage.local
     * @returns Promise that resolves with restored state
     */
    restoreTabs: async (): Promise<TabStoreState> => {
      try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        const stored = result[STORAGE_KEY] as TabStoreState | undefined;

        if (stored && stored.tabs && stored.tabs.length > 0) {
          set(stored);
          return stored;
        }
      } catch (error) {
        console.error('[TabStore] Failed to restore tabs:', error);
      }

      return initialState;
    },

    /**
     * Clear all tabs (for reset)
     */
    clear: (): void => {
      set(initialState);
      persistTabs();
    },

    /**
     * Set the full state (for initialization/restoration)
     */
    setState: (state: TabStoreState): void => {
      set(state);
      persistTabs();
    },
  };
}

/**
 * Persist current tab state to chrome.storage.local
 */
async function persistTabs(): Promise<void> {
  try {
    const state = get(tabStore);
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch (error) {
    console.error('[TabStore] Failed to persist tabs:', error);
  }
}

// Create the store singleton
export const tabStore = createTabStore();

// Derived store for the active tab
export const activeTab = derived(tabStore, ($tabStore) =>
  $tabStore.tabs.find((t) => t.id === $tabStore.activeTabId)
);

// Derived store for tab count
export const tabCount = derived(tabStore, ($tabStore) => $tabStore.tabs.length);
