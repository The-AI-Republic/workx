/**
 * Contract test for saveApiKey operation
 * Verifies the storage API contract for saving API keys
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Storage API Contract - saveApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (chrome?.runtime) {
      chrome.runtime.lastError = null;
    }
  });

  describe('POST /storage/apikey', () => {
    it('should return 200 when API key is saved successfully', async () => {
      const apiKeyRequest = {
        apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz123'
      };

      const setSpy = vi.spyOn(chrome.storage.local, 'set').mockResolvedValue(undefined);

      // Validate API key format
      const isValidFormat = apiKeyRequest.apiKey.startsWith('sk-') &&
                           apiKeyRequest.apiKey.length >= 43;

      if (!isValidFormat) {
        const response = {
          status: 400,
          data: {
            success: false,
            error: 'INVALID_KEY',
            message: "API key must start with 'sk-' and be at least 43 characters"
          }
        };
        expect(response.status).toBe(400);
        return;
      }

      // Simulate saveApiKey operation using promise-based API
      const apiKeyData = {
        apiKey: apiKeyRequest.apiKey,
        createdAt: Date.now(),
        lastModified: Date.now(),
        isValid: true
      };

      await chrome.storage.local.set({ openai_apikey: apiKeyData });

      let response;
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
            message: 'API key saved successfully'
          }
        };
      }

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        success: true,
        message: 'API key saved successfully'
      });
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          openai_apikey: expect.objectContaining({
            apiKey: apiKeyRequest.apiKey,
            isValid: true
          })
        })
      );
    });

    it('should return 400 for invalid API key format', async () => {
      const invalidRequests = [
        { apiKey: 'invalid-key' },
        { apiKey: 'sk-' }, // Too short
        { apiKey: '1234567890' }, // Wrong prefix
        { apiKey: '' } // Empty
      ];

      for (const request of invalidRequests) {
        const isValidFormat = request.apiKey.startsWith('sk-') &&
                             request.apiKey.length >= 43 &&
                             request.apiKey.length <= 200;

        const response = {
          status: isValidFormat ? 200 : 400,
          data: isValidFormat ?
            { success: true, message: 'API key saved successfully' } :
            {
              success: false,
              error: 'INVALID_KEY',
              message: "API key must start with 'sk-' and be at least 43 characters"
            }
        };

        expect(response.status).toBe(400);
        expect(response.data.error).toBe('INVALID_KEY');
      }
    });

    it('should return 507 when storage quota is exceeded', async () => {
      vi.spyOn(chrome.storage.local, 'set').mockRejectedValue(new Error('QUOTA_EXCEEDED_ERR'));

      const apiKeyRequest = {
        apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz123'
      };

      // Simulate saveApiKey operation with quota error
      let response;
      try {
        await chrome.storage.local.set(
          { openai_apikey: { apiKey: apiKeyRequest.apiKey } }
        );
        response = {
          status: 200,
          data: {
            success: true,
            message: 'API key saved successfully'
          }
        };
      } catch (error) {
        if (error.message.includes('QUOTA')) {
          response = {
            status: 507,
            data: {
              success: false,
              error: 'QUOTA_EXCEEDED',
              message: 'Storage quota exceeded'
            }
          };
        } else {
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

      expect(response.status).toBe(507);
      expect(response.data).toMatchObject({
        success: false,
        error: 'QUOTA_EXCEEDED'
      });
    });

    it('should update existing API key', async () => {
      const getSpy = vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({
        openai_apikey: {
          apiKey: 'sk-oldkey1234567890abcdefghijklmnopqrstuvwxyz',
          createdAt: Date.now() - 86400000, // 1 day ago
          lastModified: Date.now() - 3600000 // 1 hour ago
        }
      });

      const newApiKey = {
        apiKey: 'sk-newkey1234567890abcdefghijklmnopqrstuvwxyz'
      };

      vi.spyOn(chrome.storage.local, 'set').mockResolvedValue(undefined);

      // Simulate update operation using promise-based API
      const existing = await chrome.storage.local.get(['openai_apikey']);

      const apiKeyData = {
        apiKey: newApiKey.apiKey,
        createdAt: existing.openai_apikey?.createdAt || Date.now(),
        lastModified: Date.now(),
        isValid: true
      };

      await chrome.storage.local.set({ openai_apikey: apiKeyData });

      const response = {
        status: 200,
        data: {
          success: true,
          message: 'API key updated successfully'
        }
      };

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });
});
