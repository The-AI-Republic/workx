/**
 * Test utilities for model tests
 */

import { vi } from 'vitest';

/**
 * Creates a mock fetch response
 */
export function createMockResponse(data: any, status = 200, headers = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response);
}

/**
 * Creates a mock streaming response
 */
export function createMockStreamResponse(chunks: string[], status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => {
        controller.enqueue(new TextEncoder().encode(chunk));
      });
      controller.close();
    },
  });

  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: stream,
  } as Response);
}

/**
 * Mock implementation of chrome.storage.local
 */
export const createMockStorage = () => {
  const storage = new Map<string, any>();

  return {
    get: vi.fn((keys: string | string[]) => {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, any> = {};
      keyArray.forEach((key) => {
        if (storage.has(key)) {
          result[key] = storage.get(key);
        }
      });
      return Promise.resolve(result);
    }),

    set: vi.fn((items: Record<string, any>) => {
      Object.entries(items).forEach(([key, value]) => {
        storage.set(key, value);
      });
      return Promise.resolve();
    }),

    clear: vi.fn(() => {
      storage.clear();
      return Promise.resolve();
    }),

    remove: vi.fn((keys: string | string[]) => {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      keyArray.forEach((key) => storage.delete(key));
      return Promise.resolve();
    }),
  };
};

/**
 * Waits for a specified amount of time (useful for async tests)
 */
export function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a mock AbortController for testing request cancellation
 */
export function createMockAbortController() {
  let aborted = false;
  const listeners: Array<() => void> = [];

  return {
    signal: {
      aborted,
      addEventListener: vi.fn((event: string, callback: () => void) => {
        if (event === 'abort') {
          listeners.push(callback);
        }
      }),
      removeEventListener: vi.fn(),
    },
    abort: vi.fn(() => {
      aborted = true;
      listeners.forEach((listener) => listener());
    }),
  };
}

/**
 * Asserts that a promise rejects with a specific error
 */
export async function expectToReject(
  promise: Promise<any>,
  expectedError?: string | RegExp
): Promise<Error> {
  try {
    await promise;
    throw new Error('Expected promise to reject, but it resolved');
  } catch (error) {
    if (expectedError) {
      if (typeof expectedError === 'string') {
        expect((error as Error).message).toContain(expectedError);
      } else {
        expect((error as Error).message).toMatch(expectedError);
      }
    }
    return error as Error;
  }
}