/**
 * Integration Tests: Error Handling and Retry Logic
 *
 * Tests error handling and retry mechanisms based on quickstart scenarios.
 * Covers various error conditions, retry strategies, and recovery patterns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOMTool, DOMToolRequest } from '@/tools/DOMTool';

// Mock Chrome APIs
const mockChrome = {
  tabs: {
    get: vi.fn(),
    query: vi.fn(),
    sendMessage: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(),
  },
  permissions: {
    contains: vi.fn(),
  },
  runtime: {
    lastError: null,
    onMessage: {
      addListener: vi.fn(),
    },
  },
};

// Setup global chrome mock
Object.defineProperty(global, 'chrome', {
  value: mockChrome,
  writable: true,
});

// Mock DOM elements for testing
const mockUnstableElement = {
  tagName: 'BUTTON',
  id: 'unstable-button',
  className: 'dynamic-btn',
  textContent: 'Unstable Button',
  innerHTML: '<span>Unstable Button</span>',
  outerHTML: '<button id="unstable-button" class="dynamic-btn">Unstable Button</button>',
  attributes: { id: 'unstable-button', class: 'dynamic-btn', type: 'button' },
  boundingBox: { x: 100, y: 200, width: 120, height: 40, top: 200, left: 100, bottom: 240, right: 220 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockLoadingElement = {
  tagName: 'DIV',
  id: 'content-loader',
  className: 'loading-spinner',
  textContent: 'Loading...',
  innerHTML: '<div class="spinner"></div> Loading...',
  outerHTML: '<div id="content-loader" class="loading-spinner">Loading...</div>',
  attributes: { id: 'content-loader', class: 'loading-spinner' },
  boundingBox: { x: 200, y: 300, width: 100, height: 50, top: 300, left: 200, bottom: 350, right: 300 },
  visible: true,
  enabled: true,
  focused: false,
};

// Error codes from the quickstart guide
const DOM_ERROR_CODES = {
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  ELEMENT_NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
  ELEMENT_NOT_INTERACTABLE: 'ELEMENT_NOT_INTERACTABLE',
  TIMEOUT: 'TIMEOUT',
  CONTENT_SCRIPT_ERROR: 'CONTENT_SCRIPT_ERROR',
  CROSS_ORIGIN_BLOCKED: 'CROSS_ORIGIN_BLOCKED',
};

describe('Error Handling and Retry Logic Integration Tests', () => {
  let domTool: DOMTool;
  let mockTab: chrome.tabs.Tab;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create DOMTool instance
    domTool = new DOMTool();

    // Setup mock tab
    mockTab = {
      id: 555,
      url: 'https://unstable.example.com/test',
      title: 'Unstable Test Page',
      active: true,
      windowId: 1,
      index: 0,
      pinned: false,
      highlighted: false,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    };

    // Setup Chrome API mocks
    mockChrome.tabs.get.mockResolvedValue(mockTab);
    mockChrome.tabs.query.mockResolvedValue([mockTab]);
    mockChrome.permissions.contains.mockResolvedValue(true);
    mockChrome.scripting.executeScript.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Common Error Scenarios', () => {
    it('should handle ELEMENT_NOT_FOUND error', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'click') {
              callback({
                success: false,
                error: 'Element does not exist',
                code: DOM_ERROR_CODES.ELEMENT_NOT_FOUND,
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '.non-existent'
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Element does not exist');
    });

    it('should handle ELEMENT_NOT_VISIBLE error', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'click') {
              callback({
                success: false,
                error: 'Element is hidden',
                code: DOM_ERROR_CODES.ELEMENT_NOT_VISIBLE,
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#hidden-button'
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Element is hidden');
    });

    it('should handle ELEMENT_NOT_INTERACTABLE error', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'click') {
              callback({
                success: false,
                error: 'Element cannot be clicked',
                code: DOM_ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#disabled-button'
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Element cannot be clicked');
    });

    it('should handle TIMEOUT error', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          // Don't call callback to simulate timeout
          // The DOMTool should timeout after the specified time
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#slow-button',
        options: {
          timeout: 100 // Very short timeout
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });

  describe('Retry Logic Implementation', () => {
    it('should implement retry logic for recoverable errors', async () => {
      let attemptCount = 0;
      const maxRetries = 3;

      const executeWithRetry = async (request: DOMToolRequest, maxRetries: number = 3): Promise<any> => {
        let lastError: any;

        for (let i = 0; i < maxRetries; i++) {
          try {
            const result = await domTool.execute(request);
            if (result.success) {
              return result;
            }
            throw new Error(result.error);
          } catch (error: any) {
            lastError = error;
            if (error.message.includes('TIMEOUT') || error.message.includes('Element does not exist')) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }
            throw error; // Don't retry other errors
          }
        }

        throw lastError;
      };

      // Mock progressive success (fail first two attempts, succeed on third)
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            attemptCount++;

            if (attemptCount < 3) {
              callback({
                success: false,
                error: 'Element does not exist',
                code: DOM_ERROR_CODES.ELEMENT_NOT_FOUND,
                requestId: message.requestId,
              });
            } else {
              callback({
                success: true,
                data: {
                  element: mockUnstableElement,
                  success: true,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '.eventually-appears'
      };

      const result = await executeWithRetry(request, maxRetries);

      expect(result.success).toBe(true);
      expect(attemptCount).toBe(3);
    });

    it('should not retry non-recoverable errors', async () => {
      let attemptCount = 0;

      const executeWithRetry = async (request: DOMToolRequest, maxRetries: number = 3): Promise<any> => {
        let lastError: any;

        for (let i = 0; i < maxRetries; i++) {
          try {
            const result = await domTool.execute(request);
            if (result.success) {
              return result;
            }

            // Check if error is retryable
            const isRetryable = result.error?.includes('TIMEOUT') ||
                               result.error?.includes('Element does not exist');

            if (!isRetryable) {
              throw new Error(result.error);
            }

            lastError = new Error(result.error);
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error: any) {
            throw error; // Don't retry other errors
          }
        }

        throw lastError;
      };

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            attemptCount++;
            callback({
              success: false,
              error: 'Element cannot be clicked',
              code: DOM_ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
              requestId: message.requestId,
            });
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#permanently-disabled'
      };

      try {
        await executeWithRetry(request, 3);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('Element cannot be clicked');
        expect(attemptCount).toBe(1); // Should not retry
      }
    });

    it('should implement exponential backoff for retries', async () => {
      const retryTimes: number[] = [];
      let attemptCount = 0;

      const executeWithExponentialBackoff = async (request: DOMToolRequest, maxRetries: number = 3): Promise<any> => {
        let lastError: any;

        for (let i = 0; i < maxRetries; i++) {
          const startTime = Date.now();

          try {
            const result = await domTool.execute(request);
            if (result.success) {
              return result;
            }
            throw new Error(result.error);
          } catch (error: any) {
            lastError = error;

            if (i < maxRetries - 1) {
              const delay = Math.pow(2, i) * 100; // 100ms, 200ms, 400ms
              retryTimes.push(Date.now() - startTime);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }

        throw lastError;
      };

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            attemptCount++;
            if (attemptCount === 3) {
              callback({
                success: true,
                data: { element: mockUnstableElement, success: true },
                requestId: message.requestId,
              });
            } else {
              callback({
                success: false,
                error: 'Temporary failure',
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#retry-element'
      };

      const result = await executeWithExponentialBackoff(request, 3);

      expect(result.success).toBe(true);
      expect(attemptCount).toBe(3);
      expect(retryTimes).toHaveLength(2); // Two retry delays
    });
  });

  describe('Content Script Communication Errors', () => {
    it('should handle content script injection failure', async () => {
      mockChrome.scripting.executeScript.mockRejectedValue(
        new Error('Failed to inject script: Extension context invalidated')
      );

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#any-button'
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to inject content script');
    });

    it('should handle content script communication timeout', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        if (message.type === 'PING') {
          // Content script responds to ping
          callback({ type: 'PONG' });
        } else {
          // Don't respond to action messages (simulate hang)
        }
      });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#hanging-element',
        options: {
          timeout: 200 // Short timeout
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should handle tab communication failure', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        mockChrome.runtime.lastError = new Error('Could not establish connection');
        callback(null);
      });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#any-element'
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content script communication failed');

      // Reset lastError
      mockChrome.runtime.lastError = null;
    });

    it('should handle invalid tab ID', async () => {
      mockChrome.tabs.get.mockRejectedValue(new Error('No tab with id: 999'));

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#button',
        tabId: 999 // Invalid tab ID
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid tab ID');
    });
  });

  describe('Network and Loading Errors', () => {
    it('should handle page navigation during operation', async () => {
      let navigationOccurred = false;

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (!navigationOccurred) {
              navigationOccurred = true;
              mockChrome.runtime.lastError = new Error('The tab was closed');
              callback(null);
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#navigation-trigger'
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content script communication failed');

      // Reset lastError
      mockChrome.runtime.lastError = null;
    });

    it('should handle slow page loading', async () => {
      let pageLoaded = false;

      // Simulate page loading after delay
      setTimeout(() => {
        pageLoaded = true;
      }, 300);

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (!pageLoaded) {
              callback({
                success: false,
                error: 'Page still loading',
                code: 'PAGE_LOADING',
                requestId: message.requestId,
              });
            } else {
              callback({
                success: true,
                data: { element: mockLoadingElement, success: true },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      // First attempt fails due to loading
      const request: DOMToolRequest = {
        action: 'click',
        selector: '#load-dependent-element'
      };

      const firstResult = await domTool.execute(request);
      expect(firstResult.success).toBe(false);
      expect(firstResult.error).toContain('Page still loading');

      // Wait for page to load
      await new Promise(resolve => setTimeout(resolve, 350));

      // Second attempt succeeds
      const secondResult = await domTool.execute(request);
      expect(secondResult.success).toBe(true);
    });
  });

  describe('Resource and Memory Errors', () => {
    it('should handle memory pressure gracefully', async () => {
      let memoryPressure = true;

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (memoryPressure) {
              callback({
                success: false,
                error: 'Insufficient memory to complete operation',
                code: 'MEMORY_ERROR',
                requestId: message.requestId,
              });
              memoryPressure = false; // Memory freed after first attempt
            } else {
              callback({
                success: true,
                data: { element: mockUnstableElement, success: true },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'query',
        selector: '.memory-intensive',
        options: { multiple: true }
      };

      // First attempt fails due to memory
      const firstResult = await domTool.execute(request);
      expect(firstResult.success).toBe(false);
      expect(firstResult.error).toContain('Insufficient memory');

      // Second attempt succeeds after memory is freed
      const secondResult = await domTool.execute(request);
      expect(secondResult.success).toBe(true);
    });

    it('should handle extension context invalidation', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        mockChrome.runtime.lastError = new Error('Extension context invalidated');
        callback(null);
      });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#any-button'
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Extension context invalidated');

      // Reset lastError
      mockChrome.runtime.lastError = null;
    });
  });

  describe('Complex Error Recovery Scenarios', () => {
    it('should handle cascading failure recovery', async () => {
      let phase = 'initial-failure';
      let attemptCount = 0;

      const recoverFromCascadingFailure = async (): Promise<any> => {
        const maxAttempts = 5;

        for (let i = 0; i < maxAttempts; i++) {
          try {
            const request: DOMToolRequest = {
              action: 'click',
              selector: '#recovery-element',
              options: { timeout: 1000 }
            };

            const result = await domTool.execute(request);

            if (result.success) {
              return result;
            }

            // Implement recovery strategy based on error type
            if (result.error?.includes('not found')) {
              // Wait for element to appear
              await new Promise(resolve => setTimeout(resolve, 200));
            } else if (result.error?.includes('not visible')) {
              // Try scrolling into view
              phase = 'scroll-attempt';
            } else if (result.error?.includes('timed out')) {
              // Increase timeout for next attempt
              await new Promise(resolve => setTimeout(resolve, 500));
            }

            throw new Error(result.error);
          } catch (error) {
            if (i === maxAttempts - 1) {
              throw error;
            }
          }
        }
      };

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            attemptCount++;

            switch (phase) {
              case 'initial-failure':
                callback({
                  success: false,
                  error: 'Element does not exist',
                  code: DOM_ERROR_CODES.ELEMENT_NOT_FOUND,
                  requestId: message.requestId,
                });
                if (attemptCount === 2) phase = 'visibility-issue';
                break;
              case 'visibility-issue':
                callback({
                  success: false,
                  error: 'Element is hidden',
                  code: DOM_ERROR_CODES.ELEMENT_NOT_VISIBLE,
                  requestId: message.requestId,
                });
                if (attemptCount === 4) phase = 'success';
                break;
              case 'success':
                callback({
                  success: true,
                  data: { element: mockUnstableElement, success: true },
                  requestId: message.requestId,
                });
                break;
            }
          }, 10);
        });

      const result = await recoverFromCascadingFailure();

      expect(result.success).toBe(true);
      expect(attemptCount).toBeGreaterThanOrEqual(3);
      expect(phase).toBe('success');
    });

    it('should implement circuit breaker pattern', async () => {
      let failureCount = 0;
      let circuitOpen = false;
      const failureThreshold = 3;
      const resetTimeout = 1000;

      const executeWithCircuitBreaker = async (request: DOMToolRequest): Promise<any> => {
        if (circuitOpen) {
          throw new Error('Circuit breaker is open - service unavailable');
        }

        try {
          const result = await domTool.execute(request);

          if (result.success) {
            // Reset failure count on success
            failureCount = 0;
            return result;
          } else {
            throw new Error(result.error);
          }
        } catch (error) {
          failureCount++;

          if (failureCount >= failureThreshold) {
            circuitOpen = true;
            setTimeout(() => {
              circuitOpen = false;
              failureCount = 0;
            }, resetTimeout);
          }

          throw error;
        }
      };

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            // Always fail to trigger circuit breaker
            callback({
              success: false,
              error: 'Service unavailable',
              requestId: message.requestId,
            });
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#failing-service'
      };

      // Trigger failures to open circuit breaker
      for (let i = 0; i < failureThreshold; i++) {
        try {
          await executeWithCircuitBreaker(request);
        } catch (error) {
          // Expected failures
        }
      }

      expect(circuitOpen).toBe(true);

      // Next call should fail immediately due to open circuit
      try {
        await executeWithCircuitBreaker(request);
        expect.fail('Should have thrown circuit breaker error');
      } catch (error: any) {
        expect(error.message).toContain('Circuit breaker is open');
      }

      // Wait for circuit to reset
      await new Promise(resolve => setTimeout(resolve, resetTimeout + 100));

      expect(circuitOpen).toBe(false);
      expect(failureCount).toBe(0);
    });
  });
});