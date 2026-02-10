/**
 * Chrome API Polyfill for Desktop Mode
 *
 * Provides a minimal chrome API mock for desktop mode so that shared components
 * that use chrome.runtime.sendMessage, chrome.storage, etc. don't crash.
 *
 * This is a compatibility layer - full functionality should use the TauriChannel
 * and Tauri-native APIs.
 *
 * @module desktop/polyfills/chromePolyfill
 */

type MessageCallback = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void;
type UnlistenFn = () => void;

// Message handlers registry
const messageListeners: Set<MessageCallback> = new Set();

// Pending message responses
const pendingResponses: Map<string, (response: unknown) => void> = new Map();
let messageIdCounter = 0;

// Event listener for Tauri events that should be forwarded as chrome messages
let unlistenBrowserxEvent: UnlistenFn | null = null;

// Tauri API modules (loaded dynamically to handle initialization failures)
let tauriEvent: { emit: (event: string, payload?: unknown) => Promise<void>; listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<UnlistenFn> } | null = null;
let tauriCore: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> } | null = null;

/**
 * Try to load Tauri APIs
 */
async function loadTauriApis(): Promise<void> {
  try {
    tauriEvent = await import('@tauri-apps/api/event');
  } catch (error) {
    console.warn('[chromePolyfill] Tauri event API not available:', error);
  }

  try {
    tauriCore = await import('@tauri-apps/api/core');
  } catch (error) {
    console.warn('[chromePolyfill] Tauri core API not available:', error);
  }
}

/**
 * Initialize the chrome polyfill
 */
async function initPolyfill(): Promise<void> {
  // Load Tauri APIs first
  await loadTauriApis();

  if (!tauriEvent) {
    console.warn('[chromePolyfill] Cannot initialize event listener - Tauri event API not available');
    return;
  }

  // Listen for events from Tauri backend and forward as chrome messages
  try {
    unlistenBrowserxEvent = await tauriEvent.listen<{ id?: string; type: string; payload: unknown }>(
      'browserx:event',
      (event) => {
        const message = event.payload;

        // If this is a response to a pending request
        if (message.id && pendingResponses.has(message.id)) {
          const resolve = pendingResponses.get(message.id)!;
          pendingResponses.delete(message.id);
          resolve(message.payload);
          return;
        }

        // Forward to message listeners
        for (const listener of messageListeners) {
          try {
            listener(
              message,
              { tab: null, id: 'tauri' },
              (response) => {
                if (message.id && tauriEvent) {
                  tauriEvent.emit('browserx:response', { id: message.id, payload: response });
                }
              }
            );
          } catch (error) {
            console.error('[chromePolyfill] Message listener error:', error);
          }
        }
      }
    );
  } catch (error) {
    console.warn('[chromePolyfill] Failed to set up event listener:', error);
  }
}

/**
 * Chrome runtime polyfill
 */
const runtimePolyfill = {
  lastError: null as Error | null,

  sendMessage(
    message: unknown,
    responseCallback?: (response: unknown) => void
  ): void {
    const messageId = `msg_${++messageIdCounter}_${Date.now()}`;
    const msgType = (message as { type?: string })?.type;

    // Handle messages that can be resolved locally without Tauri event system
    // These are compatibility messages from chrome extension code
    if (msgType) {
      switch (msgType) {
        case 'PING':
          responseCallback?.({ success: true, data: { pong: true } });
          return;

        case 'CONFIG_UPDATE':
          // Handle config update - refresh agent's model client
          console.log('[chromePolyfill] CONFIG_UPDATE received (desktop mode)');
          import('../agent/DesktopAgentBootstrap').then(({ getDesktopAgentBootstrap }) => {
            const bootstrap = getDesktopAgentBootstrap();
            bootstrap.handleConfigUpdate().catch((error) => {
              console.error('[chromePolyfill] Failed to handle config update:', error);
            });
          });
          responseCallback?.({ success: true });
          return;

        case 'HEALTH_CHECK':
          // Health check should go through TauriMessageService, but provide fallback
          console.log('[chromePolyfill] HEALTH_CHECK received (desktop mode)');
          responseCallback?.({
            type: 'HEALTH_STATUS',
            ready: true,
            message: 'Desktop mode',
            authMode: 'api_key',
          });
          return;

        case 'GET_STATE':
          // Return empty state for desktop mode compatibility
          responseCallback?.({ tabId: -1, history: [] });
          return;

        case 'SESSION_RESET':
          console.log('[chromePolyfill] SESSION_RESET received (desktop mode)');
          responseCallback?.({ success: true });
          return;
      }
    }

    // For messages that need to go to the Tauri backend,
    // emit to 'browserx:message' (NOT 'browserx:submit' which is for agent submissions)
    const messageWithId = { ...(message as object), id: messageId };

    // Store the callback if provided
    if (responseCallback) {
      pendingResponses.set(messageId, responseCallback);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingResponses.has(messageId)) {
          pendingResponses.delete(messageId);
          console.warn('[chromePolyfill] Message timeout:', messageId);
          // Call callback with empty response
          responseCallback({ success: false, error: 'Timeout' });
        }
      }, 30000);
    }

    // If Tauri event API isn't available, just call the callback with an error
    if (!tauriEvent) {
      console.warn('[chromePolyfill] sendMessage called but Tauri event API not available');
      if (responseCallback) {
        pendingResponses.delete(messageId);
        responseCallback({ success: false, error: 'Tauri API not available' });
      }
      return;
    }

    // Emit to 'browserx:message' for general messages (not agent submissions)
    tauriEvent.emit('browserx:message', messageWithId).catch((error) => {
      console.error('[chromePolyfill] Failed to emit message:', error);
      if (responseCallback) {
        pendingResponses.delete(messageId);
        responseCallback({ success: false, error: (error as Error).message });
      }
    });
  },

  onMessage: {
    addListener(callback: MessageCallback): void {
      messageListeners.add(callback);
    },
    removeListener(callback: MessageCallback): void {
      messageListeners.delete(callback);
    },
    hasListener(callback: MessageCallback): boolean {
      return messageListeners.has(callback);
    },
  },

  getURL(path: string): string {
    // Return a file URL for desktop mode
    return `file://${path}`;
  },

  id: 'browserx-desktop',
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

  sendMessage(
    _tabId: number,
    message: unknown,
    responseCallback?: (response: unknown) => void
  ): void {
    // Forward to runtime.sendMessage for desktop
    runtimePolyfill.sendMessage(message, responseCallback);
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
 * Install the chrome polyfill on the global window object
 */
export function installChromePolyfill(): void {
  if (typeof window !== 'undefined' && !('chrome' in window)) {
    console.log('[chromePolyfill] Installing chrome API polyfill for desktop mode');
    (window as unknown as { chrome: typeof chromePolyfill }).chrome = chromePolyfill;

    // Initialize the polyfill asynchronously
    initPolyfill().catch((error) => {
      console.error('[chromePolyfill] Failed to initialize:', error);
    });
  }
}
