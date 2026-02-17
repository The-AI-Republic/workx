import { describe, it, expect, vi } from 'vitest';

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

// Helper to directly inspect / seed the MockStorageArea backing chrome.storage.local
const localStorage = () => chrome.storage.local as any;

describe('ScreenshotFileManager', () => {
  // chrome.storage.local is a full MockStorageArea (from setup.ts)
  // that already handles get/set/remove correctly — no mocking needed.

  describe('saveScreenshot', () => {
    it('should save base64 data to storage', async () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA';

      await ScreenshotFileManager.saveScreenshot(base64Data);

      const allData = localStorage()._getAllData();
      expect(allData['screenshot_cache']).toBe(base64Data);
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
      localStorage()._setData({ screenshot_cache: base64Data });

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
      localStorage()._setData({ screenshot_cache: 'someBase64Data' });

      await ScreenshotFileManager.deleteScreenshot();

      const allData = localStorage()._getAllData();
      expect(allData['screenshot_cache']).toBeUndefined();
    });
  });

  describe('hasScreenshot', () => {
    it('should return true when a screenshot exists in storage', async () => {
      localStorage()._setData({ screenshot_cache: 'someBase64Data' });

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
