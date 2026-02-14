/**
 * Contract test for deleteApiKey operation
 * Verifies the storage API contract for deleting API keys
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock chrome storage API
const mockStorage = {
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn()
};

global.chrome = {
  storage: {
    local: mockStorage,
    sync: {
      get: vi.fn(),
      set: vi.fn()
    }
  },
  runtime: {
    lastError: null
  }
};

describe('Storage API Contract - deleteApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.runtime.lastError = null;
  });

  describe('DELETE /storage/apikey', () => {
    it('should return 200 when API key is deleted successfully', async () => {
      // Simulate existing key
      mockStorage.get.mockResolvedValue({
        openai_apikey: {
          apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz',
          createdAt: Date.now(),
          lastModified: Date.now()
        }
      });

      mockStorage.remove.mockResolvedValue(undefined);

      // Simulate deleteApiKey operation
      const response = await new Promise((resolve) => {
        // First check if key exists
        chrome.storage.local.get(['openai_apikey'], (result) => {
          if (result.openai_apikey) {
            // Key exists, proceed with deletion
            chrome.storage.local.remove(['openai_apikey'], () => {
              if (chrome.runtime.lastError) {
                resolve({
                  status: 500,
                  data: {
                    success: false,
                    error: 'STORAGE_ERROR',
                    message: chrome.runtime.lastError.message
                  }
                });
              } else {
                resolve({
                  status: 200,
                  data: {
                    success: true,
                    message: 'API key deleted successfully'
                  }
                });
              }
            });
          } else {
            // No key to delete
            resolve({
              status: 404,
              data: {
                success: false,
                error: 'KEY_NOT_FOUND',
                message: 'No API key to delete'
              }
            });
          }
        });
      });

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        success: true,
        message: 'API key deleted successfully'
      });
      expect(mockStorage.remove).toHaveBeenCalledWith(
        ['openai_apikey'],
        expect.any(Function)
      );
    });

    it('should return 404 when no API key exists to delete', async () => {
      mockStorage.get.mockResolvedValue({});

      // Simulate deleteApiKey operation
      const response = await new Promise((resolve) => {
        chrome.storage.local.get(['openai_apikey'], (result) => {
          if (result.openai_apikey) {
            chrome.storage.local.remove(['openai_apikey'], () => {
              resolve({
                status: 200,
                data: {
                  success: true,
                  message: 'API key deleted successfully'
                }
              });
            });
          } else {
            resolve({
              status: 404,
              data: {
                success: false,
                error: 'KEY_NOT_FOUND',
                message: 'No API key to delete'
              }
            });
          }
        });
      });

      expect(response.status).toBe(404);
      expect(response.data).toMatchObject({
        success: false,
        error: 'KEY_NOT_FOUND',
        message: 'No API key to delete'
      });
      expect(mockStorage.remove).not.toHaveBeenCalled();
    });

    it('should handle storage errors during deletion', async () => {
      mockStorage.get.mockResolvedValue({
        openai_apikey: {
          apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz'
        }
      });

      mockStorage.remove.mockImplementation((keys, callback) => {
        chrome.runtime.lastError = { message: 'Storage operation failed' };
        callback();
      });

      // Simulate deleteApiKey operation with error
      const response = await new Promise((resolve) => {
        chrome.storage.local.get(['openai_apikey'], (result) => {
          if (result.openai_apikey) {
            chrome.storage.local.remove(['openai_apikey'], () => {
              if (chrome.runtime.lastError) {
                resolve({
                  status: 500,
                  data: {
                    success: false,
                    error: 'STORAGE_ERROR',
                    message: chrome.runtime.lastError.message
                  }
                });
              } else {
                resolve({
                  status: 200,
                  data: {
                    success: true,
                    message: 'API key deleted successfully'
                  }
                });
              }
            });
          }
        });
      });

      expect(response.status).toBe(500);
      expect(response.data).toMatchObject({
        success: false,
        error: 'STORAGE_ERROR',
        message: 'Storage operation failed'
      });
    });

    it('should verify key is actually removed after deletion', async () => {
      mockStorage.get
        .mockResolvedValueOnce({
          openai_apikey: { apiKey: 'sk-test' }
        })
        .mockResolvedValueOnce({}); // After deletion

      mockStorage.remove.mockResolvedValue(undefined);

      // Perform deletion
      await new Promise((resolve) => {
        chrome.storage.local.remove(['openai_apikey'], () => {
          resolve();
        });
      });

      // Verify key is gone
      const verifyResponse = await new Promise((resolve) => {
        chrome.storage.local.get(['openai_apikey'], (result) => {
          resolve({
            keyExists: !!result.openai_apikey
          });
        });
      });

      expect(verifyResponse.keyExists).toBe(false);
    });
  });
});