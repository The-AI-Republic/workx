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
