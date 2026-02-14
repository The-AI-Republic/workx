/**
 * Chrome Storage Mock Helper for Testing
 * Provides a mock implementation of chrome.storage API for unit tests
 */
import { vi } from 'vitest';

interface StorageArea {
  get(keys?: string | string[] | object | null, callback?: Function): Promise<any>;
  set(items: object, callback?: Function): Promise<void>;
  remove(keys: string | string[], callback?: Function): Promise<void>;
  clear(callback?: Function): Promise<void>;
  getBytesInUse(keys?: string | string[] | null, callback?: Function): Promise<number>;
}

class MockStorageArea implements StorageArea {
  private data: Record<string, any> = {};
  private quotaBytes: number;
  private bytesPerItem: number;

  constructor(quotaBytes: number = 102400, bytesPerItem: number = 8192) {
    this.quotaBytes = quotaBytes;
    this.bytesPerItem = bytesPerItem;
  }

  async get(keys?: string | string[] | object | null, callback?: Function): Promise<any> {
    let result: Record<string, any> = {};

    if (!keys) {
      result = { ...this.data };
    } else if (typeof keys === 'string') {
      if (keys in this.data) {
        result[keys] = this.data[keys];
      }
    } else if (Array.isArray(keys)) {
      keys.forEach(key => {
        if (key in this.data) {
          result[key] = this.data[key];
        }
      });
    } else if (typeof keys === 'object') {
      Object.keys(keys).forEach(key => {
        result[key] = key in this.data ? this.data[key] : (keys as any)[key];
      });
    }

    if (callback) {
      callback(result);
    }
    return result;
  }

  async set(items: object, callback?: Function): Promise<void> {
    const totalSize = this.calculateSize({ ...this.data, ...items });

    if (totalSize > this.quotaBytes) {
      const error = new Error('Quota exceeded');
      if (callback) {
        callback();
        // Set lastError after callback
        (global as any).chrome.runtime.lastError = { message: error.message };
      }
      throw error;
    }

    Object.entries(items).forEach(([key, value]) => {
      const itemSize = this.calculateSize({ [key]: value });
      if (itemSize > this.bytesPerItem) {
        const error = new Error(`Item ${key} exceeds size limit`);
        if (callback) {
          callback();
          (global as any).chrome.runtime.lastError = { message: error.message };
        }
        throw error;
      }
      this.data[key] = value;
    });

    if (callback) {
      callback();
    }
  }

  async remove(keys: string | string[], callback?: Function): Promise<void> {
    const keysArray = Array.isArray(keys) ? keys : [keys];
    keysArray.forEach(key => {
      delete this.data[key];
    });

    if (callback) {
      callback();
    }
  }

  async clear(callback?: Function): Promise<void> {
    this.data = {};
    if (callback) {
      callback();
    }
  }

  async getBytesInUse(keys?: string | string[] | null, callback?: Function): Promise<number> {
    let dataToMeasure = this.data;

    if (keys) {
      const keysArray = Array.isArray(keys) ? keys : [keys];
      dataToMeasure = {};
      keysArray.forEach(key => {
        if (key in this.data) {
          dataToMeasure[key] = this.data[key];
        }
      });
    }

    const bytes = this.calculateSize(dataToMeasure);

    if (callback) {
      callback(bytes);
    }
    return bytes;
  }

  private calculateSize(obj: any): number {
    return JSON.stringify(obj).length;
  }

  // Test helper methods
  _getAllData(): Record<string, any> {
    return { ...this.data };
  }

  _setData(data: Record<string, any>): void {
    this.data = { ...data };
  }

  _reset(): void {
    this.data = {};
  }
}

// Create mock chrome.storage API
const mockChromeStorage = {
  sync: new MockStorageArea(102400, 8192), // 100KB total, 8KB per item
  local: new MockStorageArea(10485760, Infinity), // 10MB total, no per-item limit
  managed: new MockStorageArea(0, 0), // Read-only
  session: new MockStorageArea(10485760, Infinity), // 10MB total

  onChanged: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn()
  }
};

// Setup global chrome mock
if (typeof global !== 'undefined') {
  (global as any).chrome = {
    ...(global as any).chrome,
    storage: mockChromeStorage,
    runtime: {
      lastError: null,
      id: 'test-extension-id',
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`
    }
  };
}

// Export for use in tests
export { mockChromeStorage, MockStorageArea };

// Helper to reset all storage areas
export function resetChromeStorageMock(): void {
  (mockChromeStorage.sync as any)._reset();
  (mockChromeStorage.local as any)._reset();
  (mockChromeStorage.session as any)._reset();
  if ((global as any).chrome?.runtime) {
    (global as any).chrome.runtime.lastError = null;
  }
}

// Helper to set initial data
export function setChromeStorageData(area: 'sync' | 'local' | 'session', data: Record<string, any>): void {
  (mockChromeStorage[area] as any)._setData(data);
}

// Helper to get all data from an area
export function getChromeStorageData(area: 'sync' | 'local' | 'session'): Record<string, any> {
  return (mockChromeStorage[area] as any)._getAllData();
}

// Auto-reset before each test if using Vitest
if (typeof beforeEach !== 'undefined') {
  beforeEach(() => {
    resetChromeStorageMock();
  });
}