/**
 * Contract test for saveApiKey operation
 * Verifies the storage API contract for saving API keys
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
    lastError: null,
    getManifest: () => ({ version: '1.0.0' })
  }
};

describe('Storage API Contract - saveApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.runtime.lastError = null;
  });

  describe('POST /storage/apikey', () => {
    it('should return 200 when API key is saved successfully', async () => {
      const apiKeyRequest = {
        apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz123'
      };

      mockStorage.set.mockResolvedValue(undefined);

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

      // Simulate saveApiKey operation
      const response = await new Promise((resolve) => {
        const apiKeyData = {
          apiKey: apiKeyRequest.apiKey,
          createdAt: Date.now(),
          lastModified: Date.now(),
          isValid: true
        };

        chrome.storage.local.set(
          { openai_apikey: apiKeyData },
          () => {
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
                  message: 'API key saved successfully'
                }
              });
            }
          }
        );
      });

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        success: true,
        message: 'API key saved successfully'
      });
      expect(mockStorage.set).toHaveBeenCalledWith(
        expect.objectContaining({
          openai_apikey: expect.objectContaining({
            apiKey: apiKeyRequest.apiKey,
            isValid: true
          })
        }),
        expect.any(Function)
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
      mockStorage.set.mockImplementation((data, callback) => {
        chrome.runtime.lastError = { message: 'QUOTA_EXCEEDED_ERR' };
        callback();
      });

      const apiKeyRequest = {
        apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz123'
      };

      // Simulate saveApiKey operation with quota error
      const response = await new Promise((resolve) => {
        chrome.storage.local.set(
          { openai_apikey: { apiKey: apiKeyRequest.apiKey } },
          () => {
            if (chrome.runtime.lastError) {
              if (chrome.runtime.lastError.message.includes('QUOTA')) {
                resolve({
                  status: 507,
                  data: {
                    success: false,
                    error: 'QUOTA_EXCEEDED',
                    message: 'Storage quota exceeded'
                  }
                });
              } else {
                resolve({
                  status: 500,
                  data: {
                    success: false,
                    error: 'STORAGE_ERROR',
                    message: chrome.runtime.lastError.message
                  }
                });
              }
            }
          }
        );
      });

      expect(response.status).toBe(507);
      expect(response.data).toMatchObject({
        success: false,
        error: 'QUOTA_EXCEEDED'
      });
    });

    it('should update existing API key', async () => {
      // First, simulate existing key
      mockStorage.get.mockResolvedValue({
        openai_apikey: {
          apiKey: 'sk-oldkey1234567890abcdefghijklmnopqrstuvwxyz',
          createdAt: Date.now() - 86400000, // 1 day ago
          lastModified: Date.now() - 3600000 // 1 hour ago
        }
      });

      const newApiKey = {
        apiKey: 'sk-newkey1234567890abcdefghijklmnopqrstuvwxyz'
      };

      mockStorage.set.mockResolvedValue(undefined);

      // Simulate update operation
      const response = await new Promise((resolve) => {
        chrome.storage.local.get(['openai_apikey'], (existing) => {
          const apiKeyData = {
            apiKey: newApiKey.apiKey,
            createdAt: existing.openai_apikey?.createdAt || Date.now(),
            lastModified: Date.now(),
            isValid: true
          };

          chrome.storage.local.set(
            { openai_apikey: apiKeyData },
            () => {
              resolve({
                status: 200,
                data: {
                  success: true,
                  message: 'API key updated successfully'
                }
              });
            }
          );
        });
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });
});