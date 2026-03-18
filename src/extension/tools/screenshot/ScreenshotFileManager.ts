/**
 * ScreenshotFileManager - Manage screenshot storage
 *
 * Handles screenshot storage, retrieval, and cleanup using ConfigStorageProvider
 * with atomic updates at key "screenshot_cache".
 */

import { SCREENSHOT_CACHE_KEY, MAX_SCREENSHOT_SIZE_MB } from './types';
import {
  getConfigStorage,
  type ConfigStorageProvider
} from '../../../core/storage/ConfigStorageProvider';

export class ScreenshotFileManager {
  /**
   * Get storage provider (throws if not initialized).
   */
  private static getStorage(): ConfigStorageProvider {
    return getConfigStorage();
  }

  /**
   * Save screenshot to storage
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

      const storage = this.getStorage();
      // Atomic save - automatically replaces old screenshot if present
      await storage.set(SCREENSHOT_CACHE_KEY, base64Data);
    } catch (error: any) {
      console.error('[ScreenshotFileManager] Failed to save screenshot:', error);
      throw new Error(`FILE_STORAGE_ERROR: ${error.message}`);
    }
  }

  /**
   * Get screenshot from storage
   *
   * @returns Base64-encoded PNG screenshot data, or null if not found
   */
  static async getScreenshot(): Promise<string | null> {
    try {
      const storage = this.getStorage();
      const screenshotData = await storage.get<string>(SCREENSHOT_CACHE_KEY);

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
   * Delete screenshot from storage
   *
   * @returns Promise that resolves when screenshot is deleted
   */
  static async deleteScreenshot(): Promise<void> {
    try {
      const storage = this.getStorage();
      await storage.remove(SCREENSHOT_CACHE_KEY);
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
      const storage = this.getStorage();
      const data = await storage.get<string>(SCREENSHOT_CACHE_KEY);
      return !!data;
    } catch (error: any) {
      console.error('[ScreenshotFileManager] Failed to check screenshot existence:', error);
      return false;
    }
  }

  /**
   * Download screenshot as a file using Chrome downloads API
   * 
   * @param base64DataOrFilename - Base64 screenshot data OR filename (if omitted, reads from storage)
   * @param filename - Optional filename (defaults to screenshot_TIMESTAMP.png)
   * @returns Promise that resolves with the download ID
   * @throws Error if screenshot not found in storage or download fails
   */
  static async downloadScreenshot(base64DataOrFilename?: string, filename?: string): Promise<number> {
    try {
      let base64Data: string | null;
      let downloadFilename: string;

      // Determine if first arg is data or filename
      if (!base64DataOrFilename || base64DataOrFilename.endsWith('.png')) {
        // First arg is filename or missing - read from storage
        base64Data = await this.getScreenshot();
        downloadFilename = base64DataOrFilename || `screenshot_${Date.now()}.png`;

        if (!base64Data) {
          throw new Error('No screenshot found in storage');
        }
      } else {
        // First arg is base64 data
        base64Data = base64DataOrFilename;
        downloadFilename = filename || `screenshot_${Date.now()}.png`;
      }

      // Ensure data has the proper data URI format
      const dataUri = base64Data.startsWith('data:')
        ? base64Data
        : `data:image/png;base64,${base64Data}`;

      // Use chrome.downloads API to trigger download
      const downloadId = await chrome.downloads.download({
        url: dataUri,
        filename: downloadFilename,
        saveAs: false // Set to true if you want the save dialog
      });

      console.log(`[ScreenshotFileManager] Screenshot download initiated: ${downloadFilename} (ID: ${downloadId})`);
      return downloadId;
    } catch (error: any) {
      console.error('[ScreenshotFileManager] Failed to download screenshot:', error);
      throw new Error(`DOWNLOAD_ERROR: ${error.message}`);
    }
  }

  /**
   * Download screenshot using blob URL (fallback method for contexts without chrome.downloads)
   * Works in side panel, popup, or content scripts
   *
   * @param base64Data - Base64-encoded PNG screenshot data
   * @param filename - Optional filename (defaults to screenshot_TIMESTAMP.png)
   */
  static downloadScreenshotViaBlob(base64Data: string, filename?: string): void {
    try {
      const downloadFilename = filename || `screenshot_${Date.now()}.png`;

      // Strip data URI prefix if present
      const base64 = base64Data.replace(/^data:image\/png;base64,/, '');

      // Convert base64 to blob
      const byteCharacters = atob(base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'image/png' });

      // Create download link
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadFilename;
      link.style.display = 'none';

      // Trigger download
      document.body.appendChild(link);
      link.click();

      // Cleanup
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 100);

      console.log(`[ScreenshotFileManager] Screenshot downloaded via blob: ${downloadFilename}`);
    } catch (error: any) {
      console.error('[ScreenshotFileManager] Failed to download screenshot via blob:', error);
      throw new Error(`DOWNLOAD_ERROR: ${error.message}`);
    }
  }
}
