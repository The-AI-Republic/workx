import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => false),
  getConfigStorage: vi.fn(() => {
    throw new Error('Not initialized');
  }),
}));

vi.mock('../types', async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    SCREENSHOT_CACHE_KEY: 'screenshot_cache',
    MAX_SCREENSHOT_SIZE_MB: 5,
  };
});

import { ScreenshotFileManager } from '../ScreenshotFileManager';

describe('ScreenshotFileManager', () => {
  let storageData: Record<string, any>;

  beforeEach(() => {
    storageData = {};

    // Provide working implementations for chrome.storage.local stubs
    // that the global setup.ts defines as bare vi.fn()
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
      async (keys?: string | string[] | object | null) => {
        if (!keys || keys === null) {
          return { ...storageData };
        }
        if (typeof keys === 'string') {
          const result: Record<string, any> = {};
          if (keys in storageData) {
            result[keys] = storageData[keys];
          }
          return result;
        }
        if (Array.isArray(keys)) {
          const result: Record<string, any> = {};
          keys.forEach((key: string) => {
            if (key in storageData) {
              result[key] = storageData[key];
            }
          });
          return result;
        }
        return {};
      }
    );

    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation(
      async (items: Record<string, any>) => {
        Object.assign(storageData, items);
      }
    );

    // chrome.storage.local.remove is not provided by setup.ts,
    // so define it on the object directly
    (chrome.storage.local as any).remove = vi.fn(
      async (keys: string | string[]) => {
        const keysArray = Array.isArray(keys) ? keys : [keys];
        keysArray.forEach((key) => {
          delete storageData[key];
        });
      }
    );
  });

  describe('saveScreenshot', () => {
    it('should save base64 data to storage', async () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA';

      await ScreenshotFileManager.saveScreenshot(base64Data);

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        screenshot_cache: base64Data,
      });
      expect(storageData['screenshot_cache']).toBe(base64Data);
    });

    it('should throw when data exceeds MAX_SCREENSHOT_SIZE_MB', async () => {
      // MAX_SCREENSHOT_SIZE_MB is mocked to 5
      // Actual size in MB = base64 length * 0.75 / (1024 * 1024)
      // To exceed 5 MB: length > 5 * 1024 * 1024 / 0.75 = 6,990,507
      const oversizedData = 'A'.repeat(7_000_000);

      await expect(
        ScreenshotFileManager.saveScreenshot(oversizedData)
      ).rejects.toThrow('SIZE_LIMIT_EXCEEDED');
    });
  });

  describe('getScreenshot', () => {
    it('should retrieve previously saved screenshot data', async () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA';
      storageData['screenshot_cache'] = base64Data;

      const result = await ScreenshotFileManager.getScreenshot();

      expect(result).toBe(base64Data);
    });

    it('should return null when no screenshot exists', async () => {
      const result = await ScreenshotFileManager.getScreenshot();

      expect(result).toBeNull();
    });
  });

  describe('deleteScreenshot', () => {
    it('should remove the screenshot from storage', async () => {
      storageData['screenshot_cache'] = 'someBase64Data';

      await ScreenshotFileManager.deleteScreenshot();

      expect((chrome.storage.local as any).remove).toHaveBeenCalledWith(
        'screenshot_cache'
      );
      expect(storageData['screenshot_cache']).toBeUndefined();
    });
  });

  describe('hasScreenshot', () => {
    it('should return true when a screenshot exists in storage', async () => {
      storageData['screenshot_cache'] = 'someBase64Data';

      const result = await ScreenshotFileManager.hasScreenshot();

      expect(result).toBe(true);
    });

    it('should return false when no screenshot exists in storage', async () => {
      const result = await ScreenshotFileManager.hasScreenshot();

      expect(result).toBe(false);
    });
  });

  describe('saveScreenshot + getScreenshot roundtrip', () => {
    it('should retrieve the same data that was saved', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      await ScreenshotFileManager.saveScreenshot(base64Data);
      const retrieved = await ScreenshotFileManager.getScreenshot();

      expect(retrieved).toBe(base64Data);
    });
  });
});
