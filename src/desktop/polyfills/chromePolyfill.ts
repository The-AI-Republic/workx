/**
 * Chrome API Polyfill for Desktop Mode
 *
 * Provides minimal chrome API stubs for desktop mode so that shared components
 * using chrome.storage, chrome.tabs, chrome.runtime.getURL, etc. don't crash.
 *
 * Message routing (chrome.runtime.sendMessage / onMessage) is NOT polyfilled —
 * desktop mode uses UIChannelClient → TauriTransport for all messaging.
 *
 * @module desktop/polyfills/chromePolyfill
 */

// Tauri core API module (loaded dynamically for storage commands)
let tauriCore: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> } | null = null;

/**
 * Load Tauri core API for storage operations
 */
async function loadTauriApis(): Promise<void> {
  try {
    tauriCore = await import('@tauri-apps/api/core');
  } catch (error) {
    console.warn('[chromePolyfill] Tauri core API not available:', error);
  }
}

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

// In-memory storage fallback when Tauri storage isn't available
const memoryStorage: Record<string, unknown> = {};

/**
 * Chrome storage polyfill using Tauri commands or memory fallback
 */
const storagePolyfill = {
  local: {
    async get(keys: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      const keyArray = typeof keys === 'string'
        ? [keys]
        : Array.isArray(keys)
          ? keys
          : keys ? Object.keys(keys) : [];

      const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};

      // If no Tauri core API, use memory storage
      if (!tauriCore) {
        const result: Record<string, unknown> = { ...defaults };
        for (const key of keyArray) {
          if (key in memoryStorage) {
            result[key] = memoryStorage[key];
          }
        }
        return result;
      }

      try {
        // Try to get values from Tauri storage
        const result = await tauriCore.invoke<Record<string, unknown>>('storage_get', { keys: keyArray });
        return { ...defaults, ...result };
      } catch {
        // Return defaults if storage fails
        return defaults || {};
      }
    },

    async set(items: Record<string, unknown>): Promise<void> {
      // If no Tauri core API, use memory storage
      if (!tauriCore) {
        Object.assign(memoryStorage, items);
        return;
      }

      try {
        await tauriCore.invoke('storage_set', { items });
      } catch (error) {
        console.warn('[chromePolyfill] storage.set failed:', error);
        // Fall back to memory storage
        Object.assign(memoryStorage, items);
      }
    },

    async remove(keys: string | string[]): Promise<void> {
      const keyArray = typeof keys === 'string' ? [keys] : keys;

      // If no Tauri core API, use memory storage
      if (!tauriCore) {
        for (const key of keyArray) {
          delete memoryStorage[key];
        }
        return;
      }

      try {
        await tauriCore.invoke('storage_remove', { keys: keyArray });
      } catch (error) {
        console.warn('[chromePolyfill] storage.remove failed:', error);
        // Fall back to memory storage
        for (const key of keyArray) {
          delete memoryStorage[key];
        }
      }
    },

    async clear(): Promise<void> {
      // If no Tauri core API, clear memory storage
      if (!tauriCore) {
        Object.keys(memoryStorage).forEach(key => delete memoryStorage[key]);
        return;
      }

      try {
        await tauriCore.invoke('storage_clear');
      } catch (error) {
        console.warn('[chromePolyfill] storage.clear failed:', error);
        // Fall back to memory storage
        Object.keys(memoryStorage).forEach(key => delete memoryStorage[key]);
      }
    },
  },

  sync: {
    // Sync storage uses same implementation as local for desktop
    async get(keys: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      return storagePolyfill.local.get(keys);
    },
    async set(items: Record<string, unknown>): Promise<void> {
      return storagePolyfill.local.set(items);
    },
    async remove(keys: string | string[]): Promise<void> {
      return storagePolyfill.local.remove(keys);
    },
    async clear(): Promise<void> {
      return storagePolyfill.local.clear();
    },
  },
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
  storage: storagePolyfill,
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

    // Load Tauri APIs for storage operations
    loadTauriApis().catch((error) => {
      console.error('[chromePolyfill] Failed to load Tauri APIs:', error);
    });
  }
}
