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
