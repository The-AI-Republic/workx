/**
 * Test setup for model tests
 */

import { beforeEach, vi } from 'vitest';

// Mock Chrome APIs that might be used in model classes
const mockChrome = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      clear: vi.fn(),
    },
    sync: {
      get: vi.fn(),
      set: vi.fn(),
      clear: vi.fn(),
    },
  },
  tabs: {
    query: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
};

// Set up global mocks
beforeEach(() => {
  // Reset all mocks before each test
  vi.clearAllMocks();

  // Mock global chrome object
  Object.defineProperty(globalThis, 'chrome', {
    value: mockChrome,
    writable: true,
  });

  // Mock fetch for API calls
  global.fetch = vi.fn();
});

export { mockChrome };