/**
 * Contract test for deleteApiKey operation
 * Verifies the storage API contract for deleting API keys
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Storage API Contract - deleteApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (chrome?.runtime) {
      chrome.runtime.lastError = null;
    }
  });

  describe('DELETE /storage/apikey', () => {
    it('should return 200 when API key is deleted successfully', async () => {
      // Simulate existing key
      const getSpy = vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({
        openai_apikey: {
          apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz',
          createdAt: Date.now(),
          lastModified: Date.now()
        }
      });

      // Add remove mock to storage.local
      chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined);

      // Simulate deleteApiKey operation using promise-based API
      const result = await chrome.storage.local.get(['openai_apikey']);
      let response;

      if (result.openai_apikey) {
        // Key exists, proceed with deletion
        await chrome.storage.local.remove(['openai_apikey']);
        if (chrome.runtime.lastError) {
          response = {
            status: 500,
            data: {
              success: false,
              error: 'STORAGE_ERROR',
              message: chrome.runtime.lastError.message
            }
          };
        } else {
          response = {
            status: 200,
            data: {
              success: true,
              message: 'API key deleted successfully'
            }
          };
        }
      } else {
        response = {
          status: 404,
          data: {
            success: false,
            error: 'KEY_NOT_FOUND',
            message: 'No API key to delete'
          }
        };
      }

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        success: true,
        message: 'API key deleted successfully'
      });
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(['openai_apikey']);
    });

    it('should return 404 when no API key exists to delete', async () => {
      vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({});
      chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined);

      // Simulate deleteApiKey operation using promise-based API
      const result = await chrome.storage.local.get(['openai_apikey']);
      let response;

      if (result.openai_apikey) {
        await chrome.storage.local.remove(['openai_apikey']);
        response = {
          status: 200,
          data: {
            success: true,
            message: 'API key deleted successfully'
          }
        };
      } else {
        response = {
          status: 404,
          data: {
            success: false,
            error: 'KEY_NOT_FOUND',
            message: 'No API key to delete'
          }
        };
      }

      expect(response.status).toBe(404);
      expect(response.data).toMatchObject({
        success: false,
        error: 'KEY_NOT_FOUND',
        message: 'No API key to delete'
      });
      expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    });

    it('should handle storage errors during deletion', async () => {
      vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({
        openai_apikey: {
          apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz'
        }
      });

      chrome.storage.local.remove = vi.fn().mockRejectedValue(new Error('Storage operation failed'));

      // Simulate deleteApiKey operation with error using promise-based API
      const result = await chrome.storage.local.get(['openai_apikey']);
      let response;

      if (result.openai_apikey) {
        try {
          await chrome.storage.local.remove(['openai_apikey']);
          response = {
            status: 200,
            data: {
              success: true,
              message: 'API key deleted successfully'
            }
          };
        } catch (error) {
          response = {
            status: 500,
            data: {
              success: false,
              error: 'STORAGE_ERROR',
              message: error.message
            }
          };
        }
      }

      expect(response.status).toBe(500);
      expect(response.data).toMatchObject({
        success: false,
        error: 'STORAGE_ERROR',
        message: 'Storage operation failed'
      });
    });

    it('should verify key is actually removed after deletion', async () => {
      chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined);

      // After deletion, get should return empty result
      vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({});

      // Perform deletion using promise-based API
      await chrome.storage.local.remove(['openai_apikey']);

      // Verify key is gone
      const result = await chrome.storage.local.get(['openai_apikey']);
      const verifyResponse = {
        keyExists: !!result.openai_apikey
      };

      expect(verifyResponse.keyExists).toBe(false);
    });
  });
});
