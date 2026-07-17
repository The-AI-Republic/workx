/**
 * Test setup — single source of truth for the global `chrome` mock.
 *
 * This file is referenced by vitest.config.mjs `setupFiles` so it runs
 * before every test file.  It combines the simple stub object that most
 * tests need with the richer MockStorageArea implementation from
 * chrome-storage-mock.ts.
 */

import { beforeEach, vi } from 'vitest';
import { mockChromeStorage, resetChromeStorageMock } from './chrome-storage-mock';
import type {
  BrowserTabDescriptor,
  SessionBrowserResources,
} from '../core/platform/IPlatformAdapter';

// Node >= 22 defines an experimental `localStorage`/`sessionStorage` global
// that evaluates to `undefined` unless Node is started with
// `--localstorage-file`. It shadows jsdom's Web Storage in the vitest
// environment, so code guarded by `typeof localStorage !== 'undefined'`
// sees `undefined` and every test touching Web Storage breaks. Install a
// spec-shaped in-memory replacement so tests behave like a real browser.
function createWebStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => (store.has(String(key)) ? store.get(String(key))! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(String(key));
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
  } as Storage;
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (globalThis[name] === undefined) {
    Object.defineProperty(globalThis, name, {
      value: createWebStorage(),
      writable: true,
      configurable: true,
    });
  }
}

// Unified chrome mock — uses the full MockStorageArea for storage while
// keeping lightweight stubs for runtime / tabs / etc.
const mockChrome = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    lastError: null as any,
    id: 'test-extension-id',
    getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
  },
  storage: mockChromeStorage,
  tabs: {
    query: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
};

function descriptor(tab: chrome.tabs.Tab | null | undefined): BrowserTabDescriptor {
  if (!tab || typeof tab.id !== 'number') throw new Error('Tab not found');
  const url = tab.url ?? '';
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { /* non-web test URL */ }
  return {
    tabId: tab.id,
    url,
    hostname,
    title: tab.title,
    status: tab.status === 'loading' || tab.status === 'complete' ? tab.status : undefined,
  };
}

const testBrowserResources: SessionBrowserResources = {
  sessionId: 'vitest-session',
  async current() {
    const tabs = await globalThis.chrome?.tabs?.query?.({ active: true, currentWindow: true });
    return tabs?.[0] ? descriptor(tabs[0]) : null;
  },
  async listOwned() {
    const tabs = await globalThis.chrome?.tabs?.query?.({});
    return (tabs ?? []).map(descriptor);
  },
  async claimExisting(tabId) {
    return descriptor(await globalThis.chrome.tabs.get(tabId));
  },
  async create(options = {}) {
    return descriptor(await globalThis.chrome.tabs.create({ url: options.url, active: options.active }));
  },
  async getOwned(tabId) {
    return descriptor(await globalThis.chrome.tabs.get(tabId));
  },
  async setCurrent(_tabId) {},
  async navigate(tabId, url) {
    const updated = await globalThis.chrome.tabs.update(tabId, { url });
    return descriptor(updated ?? await globalThis.chrome.tabs.get(tabId));
  },
  async reload(tabId, options) {
    await globalThis.chrome.tabs.reload(tabId, { bypassCache: options?.bypassCache ?? false });
  },
  async close(tabId) {
    await globalThis.chrome.tabs.remove(tabId);
  },
  async captureVisible() {
    return globalThis.chrome.tabs.captureVisibleTab();
  },
  async controller() { return null; },
  async releaseAll() {},
};

Object.defineProperty(globalThis, '__WORKX_TEST_BROWSER_RESOURCES__', {
  value: testBrowserResources,
  writable: false,
  configurable: true,
});

beforeEach(() => {
  // Install chrome on globalThis
  Object.defineProperty(globalThis, 'chrome', {
    value: mockChrome,
    writable: true,
    configurable: true,
  });

  // Reset storage data & runtime.lastError
  resetChromeStorageMock();

  // Mock fetch for API calls
  global.fetch = vi.fn();
});

export { mockChrome };
