import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setConfigStorage, type ConfigStorageProvider } from '../../../../core/storage/ConfigStorageProvider';

vi.mock('../types', async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    SCREENSHOT_CACHE_KEY: 'screenshot_cache',
    MAX_SCREENSHOT_SIZE_MB: 5,
  };
});

import { ScreenshotFileManager } from '../ScreenshotFileManager';

/** Create a Map-backed ConfigStorageProvider mock */
function createMockStorage(): ConfigStorageProvider {
  const store = new Map<string, any>();
  return {
    get: vi.fn(async <T>(key: string): Promise<T | null> => {
      return (store.get(key) as T) ?? null;
    }),
    set: vi.fn(async (key: string, value: any): Promise<void> => {
      store.set(key, value);
    }),
    remove: vi.fn(async (key: string): Promise<void> => {
      store.delete(key);
    }),
    getMany: vi.fn(async <T>(keys: string[]): Promise<Record<string, T | null>> => {
      const result: Record<string, T | null> = {};
      for (const key of keys) {
        result[key] = (store.get(key) as T) ?? null;
      }
      return result;
    }),
    setMany: vi.fn(async (items: Record<string, any>): Promise<void> => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    }),
    removeMany: vi.fn(async (keys: string[]): Promise<void> => {
      for (const key of keys) {
        store.delete(key);
      }
    }),
    getAll: vi.fn(async (): Promise<Record<string, any>> => {
      return Object.fromEntries(store.entries());
    }),
    clear: vi.fn(async (): Promise<void> => {
      store.clear();
    }),
    getBytesInUse: vi.fn(async (): Promise<number> => 0),
    _store: store, // expose for test seeding
  } as ConfigStorageProvider & { _store: Map<string, any> };
}

describe('ScreenshotFileManager', () => {
  let mockStorage: ConfigStorageProvider & { _store: Map<string, any> };

  beforeEach(() => {
    mockStorage = createMockStorage() as any;
    setConfigStorage(mockStorage);
  });

  // ==========================================================================
  // saveScreenshot
  // ==========================================================================
  describe('saveScreenshot', () => {
    it('should save base64 data to storage', async () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA';

      await ScreenshotFileManager.saveScreenshot(base64Data);

      expect(mockStorage.set).toHaveBeenCalledWith('screenshot_cache', base64Data);
      expect(mockStorage._store.get('screenshot_cache')).toBe(base64Data);
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

    it('should throw FILE_STORAGE_ERROR wrapping the size limit error', async () => {
      const oversizedData = 'A'.repeat(7_000_000);

      await expect(
        ScreenshotFileManager.saveScreenshot(oversizedData)
      ).rejects.toThrow('FILE_STORAGE_ERROR');
    });

    it('should overwrite previous screenshot atomically', async () => {
      await ScreenshotFileManager.saveScreenshot('firstData');
      await ScreenshotFileManager.saveScreenshot('secondData');

      expect(mockStorage._store.get('screenshot_cache')).toBe('secondData');
    });

    it('should save data just under the size limit', async () => {
      // 5 MB limit => max base64 length = 5 * 1024 * 1024 / 0.75 = 6,990,506.67
      // Use 6,990,000 to be safely under
      const justUnderData = 'A'.repeat(6_990_000);

      await ScreenshotFileManager.saveScreenshot(justUnderData);

      expect(mockStorage._store.get('screenshot_cache')).toBe(justUnderData);
    });

    it('should call storage.set with correct key and value', async () => {
      await ScreenshotFileManager.saveScreenshot('testData');

      expect(mockStorage.set).toHaveBeenCalledWith('screenshot_cache', 'testData');
    });
  });

  // ==========================================================================
  // getScreenshot
  // ==========================================================================
  describe('getScreenshot', () => {
    it('should retrieve previously saved screenshot data', async () => {
      mockStorage._store.set('screenshot_cache', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA');

      const result = await ScreenshotFileManager.getScreenshot();

      expect(result).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA');
    });

    it('should return null when no screenshot exists', async () => {
      const result = await ScreenshotFileManager.getScreenshot();

      expect(result).toBeNull();
    });

    it('should call storage.get with correct key', async () => {
      await ScreenshotFileManager.getScreenshot();

      expect(mockStorage.get).toHaveBeenCalledWith('screenshot_cache');
    });

    it('should throw FILE_STORAGE_ERROR when storage.get throws', async () => {
      (mockStorage.get as any).mockRejectedValue(new Error('Read error'));

      await expect(ScreenshotFileManager.getScreenshot()).rejects.toThrow(
        'FILE_STORAGE_ERROR: Read error'
      );
    });
  });

  // ==========================================================================
  // deleteScreenshot
  // ==========================================================================
  describe('deleteScreenshot', () => {
    it('should remove the screenshot from storage', async () => {
      mockStorage._store.set('screenshot_cache', 'someBase64Data');

      await ScreenshotFileManager.deleteScreenshot();

      expect(mockStorage.remove).toHaveBeenCalledWith('screenshot_cache');
      expect(mockStorage._store.has('screenshot_cache')).toBe(false);
    });

    it('should not throw when no screenshot exists to delete', async () => {
      await expect(ScreenshotFileManager.deleteScreenshot()).resolves.not.toThrow();
    });

    it('should throw FILE_STORAGE_ERROR when storage.remove throws', async () => {
      (mockStorage.remove as any).mockRejectedValue(new Error('Remove failed'));

      await expect(ScreenshotFileManager.deleteScreenshot()).rejects.toThrow(
        'FILE_STORAGE_ERROR: Remove failed'
      );
    });
  });

  // ==========================================================================
  // hasScreenshot
  // ==========================================================================
  describe('hasScreenshot', () => {
    it('should return true when a screenshot exists in storage', async () => {
      mockStorage._store.set('screenshot_cache', 'someBase64Data');

      const result = await ScreenshotFileManager.hasScreenshot();

      expect(result).toBe(true);
    });

    it('should return false when no screenshot exists in storage', async () => {
      const result = await ScreenshotFileManager.hasScreenshot();

      expect(result).toBe(false);
    });

    it('should return false when storage.get throws (swallows error)', async () => {
      (mockStorage.get as any).mockRejectedValue(new Error('Storage error'));

      const result = await ScreenshotFileManager.hasScreenshot();

      expect(result).toBe(false);
    });

    it('should return false for empty string in storage', async () => {
      mockStorage._store.set('screenshot_cache', '');

      const result = await ScreenshotFileManager.hasScreenshot();

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // downloadScreenshot
  // ==========================================================================
  describe('downloadScreenshot', () => {
    beforeEach(() => {
      // Add chrome.downloads mock
      (globalThis as any).chrome = (globalThis as any).chrome || {};
      (globalThis as any).chrome.downloads = {
        download: vi.fn().mockResolvedValue(42),
      };
    });

    it('should download base64 data passed directly', async () => {
      const downloadId = await ScreenshotFileManager.downloadScreenshot('base64ImageData', 'my_screenshot.png');

      expect(chrome.downloads.download).toHaveBeenCalledWith({
        url: 'data:image/png;base64,base64ImageData',
        filename: 'my_screenshot.png',
        saveAs: false,
      });
      expect(downloadId).toBe(42);
    });

    it('should use default filename when not provided', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1234567890);

      await ScreenshotFileManager.downloadScreenshot('base64ImageData');

      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'screenshot_1234567890.png',
        })
      );
    });

    it('should not add data URI prefix if already present', async () => {
      await ScreenshotFileManager.downloadScreenshot(
        'data:image/png;base64,alreadyPrefixed',
        'test.png'
      );

      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'data:image/png;base64,alreadyPrefixed',
        })
      );
    });

    it('should read from storage when first arg is a .png filename', async () => {
      mockStorage._store.set('screenshot_cache', 'storedBase64');

      const downloadId = await ScreenshotFileManager.downloadScreenshot('output.png');

      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'data:image/png;base64,storedBase64',
          filename: 'output.png',
        })
      );
      expect(downloadId).toBe(42);
    });

    it('should read from storage when no args provided', async () => {
      mockStorage._store.set('screenshot_cache', 'storedBase64');
      vi.spyOn(Date, 'now').mockReturnValue(9999);

      const downloadId = await ScreenshotFileManager.downloadScreenshot();

      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'data:image/png;base64,storedBase64',
          filename: 'screenshot_9999.png',
        })
      );
      expect(downloadId).toBe(42);
    });

    it('should throw DOWNLOAD_ERROR when no screenshot in storage and no data provided', async () => {
      // Storage is empty, no args
      await expect(
        ScreenshotFileManager.downloadScreenshot()
      ).rejects.toThrow('DOWNLOAD_ERROR');
    });

    it('should throw DOWNLOAD_ERROR when chrome.downloads.download fails', async () => {
      (chrome.downloads.download as any).mockRejectedValue(new Error('Download API error'));

      await expect(
        ScreenshotFileManager.downloadScreenshot('base64Data', 'test.png')
      ).rejects.toThrow('DOWNLOAD_ERROR: Download API error');
    });

    it('should return the download ID from chrome.downloads.download', async () => {
      (chrome.downloads.download as any).mockResolvedValue(123);

      const result = await ScreenshotFileManager.downloadScreenshot('data', 'file.png');

      expect(result).toBe(123);
    });
  });

  // ==========================================================================
  // downloadScreenshotViaBlob
  // ==========================================================================
  describe('downloadScreenshotViaBlob', () => {
    let mockLink: any;
    let mockCreateObjectURL: ReturnType<typeof vi.fn>;
    let mockRevokeObjectURL: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers();

      mockLink = {
        href: '',
        download: '',
        style: { display: '' },
        click: vi.fn(),
      };
      vi.spyOn(document, 'createElement').mockReturnValue(mockLink as any);
      vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockLink);
      vi.spyOn(document.body, 'removeChild').mockImplementation(() => mockLink);

      mockCreateObjectURL = vi.fn().mockReturnValue('blob:test-url');
      mockRevokeObjectURL = vi.fn();
      (globalThis as any).URL.createObjectURL = mockCreateObjectURL;
      (globalThis as any).URL.revokeObjectURL = mockRevokeObjectURL;
    });

    it('should create a download link and trigger click', () => {
      const base64 = btoa('test image data');

      ScreenshotFileManager.downloadScreenshotViaBlob(base64, 'test.png');

      expect(document.createElement).toHaveBeenCalledWith('a');
      expect(mockLink.href).toBe('blob:test-url');
      expect(mockLink.download).toBe('test.png');
      expect(mockLink.style.display).toBe('none');
      expect(document.body.appendChild).toHaveBeenCalledWith(mockLink);
      expect(mockLink.click).toHaveBeenCalled();
    });

    it('should use default filename when not provided', () => {
      vi.spyOn(Date, 'now').mockReturnValue(5555);
      const base64 = btoa('image');

      ScreenshotFileManager.downloadScreenshotViaBlob(base64);

      expect(mockLink.download).toBe('screenshot_5555.png');
    });

    it('should strip data URI prefix before decoding', () => {
      const rawBase64 = btoa('raw data');
      const dataUri = `data:image/png;base64,${rawBase64}`;

      ScreenshotFileManager.downloadScreenshotViaBlob(dataUri, 'stripped.png');

      expect(mockLink.click).toHaveBeenCalled();
    });

    it('should clean up link and revoke object URL after timeout', () => {
      const base64 = btoa('cleanup test');

      ScreenshotFileManager.downloadScreenshotViaBlob(base64, 'cleanup.png');

      // Before timeout
      expect(document.body.removeChild).not.toHaveBeenCalled();
      expect(mockRevokeObjectURL).not.toHaveBeenCalled();

      // After 100ms
      vi.advanceTimersByTime(100);

      expect(document.body.removeChild).toHaveBeenCalledWith(mockLink);
      expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:test-url');
    });

    it('should create blob with image/png type', () => {
      const base64 = btoa('blob type check');
      let capturedBlob: Blob | undefined;

      mockCreateObjectURL.mockImplementation((blob: Blob) => {
        capturedBlob = blob;
        return 'blob:test-url';
      });

      ScreenshotFileManager.downloadScreenshotViaBlob(base64, 'blob.png');

      expect(capturedBlob).toBeDefined();
      expect(capturedBlob!.type).toBe('image/png');
    });

    it('should throw DOWNLOAD_ERROR when blob creation fails', () => {
      vi.spyOn(globalThis, 'atob').mockImplementation(() => {
        throw new Error('Invalid base64');
      });

      expect(() =>
        ScreenshotFileManager.downloadScreenshotViaBlob('!!!invalid!!!', 'fail.png')
      ).toThrow('DOWNLOAD_ERROR: Invalid base64');
    });

    afterEach(() => {
      vi.useRealTimers();
    });
  });

  // ==========================================================================
  // saveScreenshot + getScreenshot roundtrip
  // ==========================================================================
  describe('saveScreenshot + getScreenshot roundtrip', () => {
    it('should retrieve the same data that was saved', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      await ScreenshotFileManager.saveScreenshot(base64Data);
      const retrieved = await ScreenshotFileManager.getScreenshot();

      expect(retrieved).toBe(base64Data);
    });

    it('save replaces previous, getScreenshot returns latest', async () => {
      await ScreenshotFileManager.saveScreenshot('data1');
      await ScreenshotFileManager.saveScreenshot('data2');

      const result = await ScreenshotFileManager.getScreenshot();
      expect(result).toBe('data2');
    });

    it('delete removes screenshot, getScreenshot returns null', async () => {
      await ScreenshotFileManager.saveScreenshot('data');
      await ScreenshotFileManager.deleteScreenshot();

      const result = await ScreenshotFileManager.getScreenshot();
      expect(result).toBeNull();
    });

    it('hasScreenshot reflects save/delete lifecycle', async () => {
      expect(await ScreenshotFileManager.hasScreenshot()).toBe(false);

      await ScreenshotFileManager.saveScreenshot('data');
      expect(await ScreenshotFileManager.hasScreenshot()).toBe(true);

      await ScreenshotFileManager.deleteScreenshot();
      expect(await ScreenshotFileManager.hasScreenshot()).toBe(false);
    });
  });
});
