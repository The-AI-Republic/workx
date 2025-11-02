/**
 * ScreenshotFileManager - Manage screenshot storage in chrome.storage.local
 *
 * Handles screenshot storage, retrieval, and cleanup using chrome.storage.local
 * with atomic updates at key "screenshot_cache".
 */

import { SCREENSHOT_CACHE_KEY, MAX_SCREENSHOT_SIZE_MB } from './types';

export class ScreenshotFileManager {
  /**
   * Save screenshot to chrome.storage.local
   * Atomically replaces any existing screenshot at the same key
   *
   * @param base64Data - Base64-encoded PNG screenshot data
   * @returns Promise that resolves when screenshot is saved
   * @throws Error if screenshot exceeds size limit or storage fails
   */
  static async saveScreenshot(base64Data: string): Promise<void> {
    try {
      // Validate size (base64 is ~33% larger than binary, so multiply by 0.75 for actual size)
      const sizeInMB = (base64Data.length * 0.75) / (1024 * 1024);
      if (sizeInMB > MAX_SCREENSHOT_SIZE_MB) {
        throw new Error(
          `SIZE_LIMIT_EXCEEDED: Screenshot size ${sizeInMB.toFixed(2)}MB exceeds ${MAX_SCREENSHOT_SIZE_MB}MB limit`
        );
      }

      // Atomic save - automatically replaces old screenshot if present
      await chrome.storage.local.set({
        [SCREENSHOT_CACHE_KEY]: base64Data
      });
    } catch (error: any) {
      console.error('[ScreenshotFileManager] Failed to save screenshot:', error);
      throw new Error(`FILE_STORAGE_ERROR: ${error.message}`);
    }
  }

  /**
   * Get screenshot from chrome.storage.local
   *
   * @returns Base64-encoded PNG screenshot data, or null if not found
   */
  static async getScreenshot(): Promise<string | null> {
    try {
      const result = await chrome.storage.local.get(SCREENSHOT_CACHE_KEY);
      const screenshotData = result[SCREENSHOT_CACHE_KEY];

      if (!screenshotData) {
        console.debug('[ScreenshotFileManager] No screenshot found at key "${SCREENSHOT_CACHE_KEY}"');
        return null;
      }

      return screenshotData;
    } catch (error: any) {
      console.error('[ScreenshotFileManager] Failed to retrieve screenshot:', error);
      throw new Error(`FILE_STORAGE_ERROR: ${error.message}`);
    }
  }

  /**
   * Delete screenshot from chrome.storage.local
   *
   * @returns Promise that resolves when screenshot is deleted
   */
  static async deleteScreenshot(): Promise<void> {
    try {
      await chrome.storage.local.remove(SCREENSHOT_CACHE_KEY);
    } catch (error: any) {
      console.error('[ScreenshotFileManager] Failed to delete screenshot:', error);
      throw new Error(`FILE_STORAGE_ERROR: ${error.message}`);
    }
  }

  /**
   * Check if screenshot exists in storage
   *
   * @returns True if screenshot exists, false otherwise
   */
  static async hasScreenshot(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(SCREENSHOT_CACHE_KEY);
      return !!result[SCREENSHOT_CACHE_KEY];
    } catch (error: any) {
      console.error('[ScreenshotFileManager] Failed to check screenshot existence:', error);
      return false;
    }
  }
}
