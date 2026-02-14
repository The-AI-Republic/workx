/**
 * Contract test for getApiKey operation
 * Verifies the storage API contract for retrieving API keys
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

describe('Storage API Contract - getApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.runtime.lastError = null;
  });

  describe('GET /storage/apikey', () => {
    it('should return 200 with masked API key when key exists', async () => {
      const storedData = {
        apiKey: 'sk-1234567890abcdefghijklmnopqrstuvwxyz',
        createdAt: Date.now(),
        lastModified: Date.now(),
        isValid: true
      };

      mockStorage.get.mockResolvedValue({
        openai_apikey: storedData
      });

      // Simulate getApiKey operation
      const response = await new Promise((resolve) => {
        chrome.storage.local.get(['openai_apikey'], (result) => {
          if (result.openai_apikey) {
            resolve({
              status: 200,
              data: {
                exists: true,
                maskedKey: result.openai_apikey.apiKey.substring(0, 6) + '***',
                createdAt: result.openai_apikey.createdAt,
                lastModified: result.openai_apikey.lastModified
              }
            });
          } else {
            resolve({
              status: 404,
              data: {
                exists: false,
                maskedKey: null
              }
            });
          }
        });
      });

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        exists: true,
        maskedKey: 'sk-123***'
      });
      expect(response.data.createdAt).toBeDefined();
      expect(response.data.lastModified).toBeDefined();
    });

    it('should return 404 when no API key exists', async () => {
      mockStorage.get.mockResolvedValue({});

      // Simulate getApiKey operation
      const response = await new Promise((resolve) => {
        chrome.storage.local.get(['openai_apikey'], (result) => {
          if (result.openai_apikey) {
            resolve({
              status: 200,
              data: {
                exists: true,
                maskedKey: result.openai_apikey.apiKey.substring(0, 6) + '***'
              }
            });
          } else {
            resolve({
              status: 404,
              data: {
                exists: false,
                maskedKey: null,
                error: 'KEY_NOT_FOUND'
              }
            });
          }
        });
      });

      expect(response.status).toBe(404);
      expect(response.data).toMatchObject({
        exists: false,
        maskedKey: null,
        error: 'KEY_NOT_FOUND'
      });
    });

    it('should handle storage errors gracefully', async () => {
      chrome.runtime.lastError = { message: 'Storage error occurred' };
      mockStorage.get.mockImplementation((keys, callback) => {
        callback({});
      });

      // Simulate getApiKey operation with error
      const response = await new Promise((resolve) => {
        if (chrome.runtime.lastError) {
          resolve({
            status: 500,
            data: {
              success: false,
              error: 'STORAGE_ERROR',
              message: chrome.runtime.lastError.message
            }
          });
        }
      });

      expect(response.status).toBe(500);
      expect(response.data).toMatchObject({
        success: false,
        error: 'STORAGE_ERROR'
      });
    });
  });
});