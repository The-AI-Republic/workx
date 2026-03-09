/**
 * Chrome API Polyfill for Desktop Mode
 *
 * Provides minimal chrome API stubs for desktop mode so that shared components
 * using chrome.tabs, chrome.runtime.getURL, etc. don't crash.
 *
 * Storage is handled by ConfigStorageProvider (not polyfilled here).
 * Message routing is handled by UIChannelClient → TauriTransport (not polyfilled here).
 *
 * @module desktop/polyfills/chromePolyfill
 */

/**
 * Chrome runtime polyfill (non-messaging stubs only)
 */
const runtimePolyfill = {
  lastError: null as Error | null,

  getURL(path: string): string {
    // Return a file URL for desktop mode
    return `file://${path}`;
  },

  id: 'pi-desktop',
};

// Tab event listener registry
type TabRemovedCallback = (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void;
type TabUpdatedCallback = (tabId: number, changeInfo: { status?: string }, tab: unknown) => void;

const tabRemovedListeners: Set<TabRemovedCallback> = new Set();
const tabUpdatedListeners: Set<TabUpdatedCallback> = new Set();

/**
 * Chrome tabs polyfill (limited functionality for desktop)
 * In desktop mode, tabs don't exist in the same way as browser extensions.
 * We provide no-op stubs to prevent crashes when code tries to use these APIs.
 */
const tabsPolyfill = {
  async query(_queryInfo: unknown): Promise<unknown[]> {
    // Desktop doesn't have tabs in the Chrome sense
    return [];
  },

  async get(_tabId: number): Promise<null> {
    // Return null - tab doesn't exist in desktop mode
    return null;
  },

  async create(_options: unknown): Promise<{ id: number }> {
    // Return a fake tab ID for desktop mode
    return { id: -1 };
  },

  async move(_tabId: number, _options: unknown): Promise<null> {
    return null;
  },

  async group(_options: unknown): Promise<number> {
    // Return fake group ID
    return -1;
  },

  async ungroup(_tabIds: number | number[]): Promise<void> {
    // No-op in desktop mode
  },

  // Event listeners
  onRemoved: {
    addListener(callback: TabRemovedCallback): void {
      tabRemovedListeners.add(callback);
    },
    removeListener(callback: TabRemovedCallback): void {
      tabRemovedListeners.delete(callback);
    },
    hasListener(callback: TabRemovedCallback): boolean {
      return tabRemovedListeners.has(callback);
    },
  },

  onUpdated: {
    addListener(callback: TabUpdatedCallback): void {
      tabUpdatedListeners.add(callback);
    },
    removeListener(callback: TabUpdatedCallback): void {
      tabUpdatedListeners.delete(callback);
    },
    hasListener(callback: TabUpdatedCallback): boolean {
      return tabUpdatedListeners.has(callback);
    },
  },
};

/**
 * Chrome tabGroups polyfill (limited functionality for desktop)
 */
const tabGroupsPolyfill = {
  TAB_GROUP_ID_NONE: -1,

  async query(_queryInfo: unknown): Promise<unknown[]> {
    return [];
  },

  async get(_groupId: number): Promise<null> {
    return null;
  },

  async update(_groupId: number, _options: unknown): Promise<null> {
    return null;
  },
};

/**
 * Chrome windows polyfill (limited functionality for desktop)
 */
const windowsPolyfill = {
  async get(_windowId: number): Promise<{ type: string; id: number }> {
    // Return a fake normal window
    return { type: 'normal', id: 1 };
  },

  async getAll(_options?: unknown): Promise<Array<{ type: string; id: number; incognito: boolean }>> {
    // Return single fake window
    return [{ type: 'normal', id: 1, incognito: false }];
  },

  async create(_options?: unknown): Promise<{ id: number }> {
    return { id: 1 };
  },
};

/**
 * The chrome polyfill object
 */
export const chromePolyfill = {
  runtime: runtimePolyfill,
  tabs: tabsPolyfill,
  tabGroups: tabGroupsPolyfill,
  windows: windowsPolyfill,
};

/**
 * Install the chrome polyfill on the global window object.
 *
 * Only installs if chrome is not already defined. On WebView2 (Windows),
 * chrome may be partially defined — specific desktop code paths should use
 * Tauri-native APIs (TauriConfigStorage, etc.) rather than relying on this polyfill.
 */
export function installChromePolyfill(): void {
  if (typeof window !== 'undefined' && !('chrome' in window)) {
    console.log('[chromePolyfill] Installing chrome API polyfill for desktop mode');
    (window as unknown as { chrome: typeof chromePolyfill }).chrome = chromePolyfill;
  }
}
