/**
 * Integration Tests: Wait for Element
 *
 * Tests element visibility and waiting functionality based on quickstart scenarios.
 * Covers dynamic content loading, visibility checks, and timeout handling.
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
const mockDynamicElement = {
  tagName: 'DIV',
  id: 'dynamic-content',
  className: 'loaded-content',
  textContent: 'Content loaded successfully',
  innerHTML: '<p>Dynamic content has appeared</p>',
  outerHTML: '<div id="dynamic-content" class="loaded-content">...</div>',
  attributes: { id: 'dynamic-content', class: 'loaded-content', 'data-loaded': 'true' },
  boundingBox: { x: 50, y: 100, width: 300, height: 200, top: 100, left: 50, bottom: 300, right: 350 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockLoadingElement = {
  tagName: 'DIV',
  id: 'loading-complete',
  className: 'status-indicator',
  textContent: 'Loading complete',
  innerHTML: '<span class="icon-check"></span> Loading complete',
  outerHTML: '<div id="loading-complete" class="status-indicator">...</div>',
  attributes: { id: 'loading-complete', class: 'status-indicator' },
  boundingBox: { x: 10, y: 10, width: 150, height: 30, top: 10, left: 10, bottom: 40, right: 160 },
  visible: true,
  enabled: true,
  focused: false,
};

describe('Wait for Element Integration Tests', () => {
  let domTool: DOMTool;
  let mockTab: chrome.tabs.Tab;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create DOMTool instance
    domTool = new DOMTool();

    // Setup mock tab
    mockTab = {
      id: 456,
      url: 'https://example.com/dynamic',
      title: 'Dynamic Content Page',
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

  describe('Wait for Element to Appear', () => {
    it('should wait for element to appear successfully', async () => {
      let attemptCount = 0;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          attemptCount++;

          if (message.action === 'query' && message.data?.selector === '.dynamic-content') {
            // Element appears after 3 attempts
            if (attemptCount >= 3) {
              callback({
                success: true,
                data: {
                  elements: [mockDynamicElement],
                },
                requestId: message.requestId,
              });
            } else {
              callback({
                success: true,
                data: {
                  elements: [],
                },
                requestId: message.requestId,
              });
            }
          }
        }, 10);
      });

      const element = await domTool.waitForElement(
        mockTab.id!,
        '.dynamic-content',
        5000
      );

      expect(element).toBeTruthy();
      expect(element?.id).toBe('dynamic-content');
      expect(element?.textContent).toBe('Content loaded successfully');
      expect(attemptCount).toBeGreaterThanOrEqual(3);
    });

    it('should timeout when element does not appear', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.action === 'query') {
            callback({
              success: true,
              data: {
                elements: [], // Element never appears
              },
              requestId: message.requestId,
            });
          }
        }, 10);
      });

      const startTime = Date.now();
      const element = await domTool.waitForElement(
        mockTab.id!,
        '.non-existent-element',
        500 // Short timeout for test
      );
      const elapsed = Date.now() - startTime;

      expect(element).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(490); // Allow some tolerance
      expect(elapsed).toBeLessThan(600);
    });

    it('should handle content script errors during wait', async () => {
      let attemptCount = 0;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          attemptCount++;

          if (message.action === 'query') {
            if (attemptCount < 3) {
              // Simulate errors in first few attempts
              callback({
                success: false,
                error: 'Element query failed',
                requestId: message.requestId,
              });
            } else {
              // Success on later attempt
              callback({
                success: true,
                data: {
                  elements: [mockDynamicElement],
                },
                requestId: message.requestId,
              });
            }
          }
        }, 10);
      });

      const element = await domTool.waitForElement(
        mockTab.id!,
        '.eventually-appears',
        2000
      );

      expect(element).toBeTruthy();
      expect(attemptCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Wait for Element to be Visible', () => {
    it('should wait for element to become visible', async () => {
      let attemptCount = 0;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          attemptCount++;

          if (message.action === 'query' && message.data?.selector === '#loading-complete') {
            if (attemptCount >= 2) {
              // Element becomes visible after some attempts
              callback({
                success: true,
                data: {
                  elements: [{ ...mockLoadingElement, visible: true }],
                },
                requestId: message.requestId,
              });
            } else {
              // Element exists but not visible initially
              callback({
                success: true,
                data: {
                  elements: [{ ...mockLoadingElement, visible: false }],
                },
                requestId: message.requestId,
              });
            }
          }
        }, 10);
      });

      const element = await domTool.waitForVisible(
        mockTab.id!,
        '#loading-complete',
        2000
      );

      expect(element).toBeTruthy();
      expect(element?.visible).toBe(true);
      expect(element?.id).toBe('loading-complete');
      expect(attemptCount).toBeGreaterThanOrEqual(2);
    });

    it('should timeout when element never becomes visible', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.action === 'query') {
            callback({
              success: true,
              data: {
                elements: [{ ...mockLoadingElement, visible: false }], // Always hidden
              },
              requestId: message.requestId,
            });
          }
        }, 10);
      });

      const startTime = Date.now();
      const element = await domTool.waitForVisible(
        mockTab.id!,
        '#hidden-element',
        500
      );
      const elapsed = Date.now() - startTime;

      expect(element).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(490);
    });

    it('should return immediately if element is already visible', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.action === 'query') {
            callback({
              success: true,
              data: {
                elements: [{ ...mockDynamicElement, visible: true }],
              },
              requestId: message.requestId,
            });
          }
        }, 10);
      });

      const startTime = Date.now();
      const element = await domTool.waitForVisible(
        mockTab.id!,
        '.already-visible',
        5000
      );
      const elapsed = Date.now() - startTime;

      expect(element).toBeTruthy();
      expect(element?.visible).toBe(true);
      expect(elapsed).toBeLessThan(200); // Should be very fast
    });
  });

  describe('Visibility Checks', () => {
    it('should check element visibility', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'checkVisibility') {
              callback({
                success: true,
                data: {
                  visible: true,
                  element: mockDynamicElement,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'query', // Using query to check visibility through element properties
        selector: '#dynamic-button',
      };

      // Simulate visibility check by querying element and checking visible property
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'query') {
              callback({
                success: true,
                data: {
                  elements: [{ ...mockDynamicElement, visible: true }],
                  count: 1,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.elements[0].visible).toBe(true);
    });

    it('should handle multiple elements visibility check', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'query') {
              callback({
                success: true,
                data: {
                  elements: [
                    { ...mockDynamicElement, visible: true },
                    { ...mockLoadingElement, visible: false },
                    { ...mockDynamicElement, id: 'another-element', visible: true },
                  ],
                  count: 3,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'query',
        selector: '.status-elements',
        options: {
          multiple: true,
        },
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.elements).toHaveLength(3);
      expect(result.data.elements[0].visible).toBe(true);
      expect(result.data.elements[1].visible).toBe(false);
      expect(result.data.elements[2].visible).toBe(true);
    });
  });

  describe('Dynamic Content Scenarios', () => {
    it('should handle progressive loading scenario', async () => {
      let phase = 'loading';

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.action === 'query') {
            switch (phase) {
              case 'loading':
                callback({
                  success: true,
                  data: { elements: [] },
                  requestId: message.requestId,
                });
                setTimeout(() => { phase = 'partial'; }, 100);
                break;
              case 'partial':
                callback({
                  success: true,
                  data: {
                    elements: [{ ...mockLoadingElement, visible: false }],
                  },
                  requestId: message.requestId,
                });
                setTimeout(() => { phase = 'complete'; }, 100);
                break;
              case 'complete':
                callback({
                  success: true,
                  data: {
                    elements: [{ ...mockLoadingElement, visible: true }],
                  },
                  requestId: message.requestId,
                });
                break;
            }
          }
        }, 10);
      });

      const element = await domTool.waitForVisible(
        mockTab.id!,
        '#loading-indicator',
        3000
      );

      expect(element).toBeTruthy();
      expect(element?.visible).toBe(true);
      expect(phase).toBe('complete');
    });

    it('should handle AJAX content loading', async () => {
      let ajaxCompleted = false;

      // Simulate AJAX request completion after delay
      setTimeout(() => {
        ajaxCompleted = true;
      }, 200);

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.action === 'query' && message.data?.selector === '.ajax-content') {
            if (ajaxCompleted) {
              callback({
                success: true,
                data: {
                  elements: [{
                    ...mockDynamicElement,
                    className: 'ajax-content loaded',
                    textContent: 'AJAX content loaded',
                  }],
                },
                requestId: message.requestId,
              });
            } else {
              callback({
                success: true,
                data: { elements: [] },
                requestId: message.requestId,
              });
            }
          }
        }, 10);
      });

      const element = await domTool.waitForElement(
        mockTab.id!,
        '.ajax-content',
        1000
      );

      expect(element).toBeTruthy();
      expect(element?.textContent).toBe('AJAX content loaded');
      expect(ajaxCompleted).toBe(true);
    });

    it('should handle element that appears and disappears', async () => {
      let elementState = 'hidden';

      // Element lifecycle: hidden -> visible -> hidden -> visible
      setTimeout(() => { elementState = 'visible'; }, 100);
      setTimeout(() => { elementState = 'hidden'; }, 300);
      setTimeout(() => { elementState = 'visible'; }, 500);

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.action === 'query') {
            if (elementState === 'visible') {
              callback({
                success: true,
                data: {
                  elements: [{ ...mockDynamicElement, visible: true }],
                },
                requestId: message.requestId,
              });
            } else {
              callback({
                success: true,
                data: { elements: [] },
                requestId: message.requestId,
              });
            }
          }
        }, 10);
      });

      const element = await domTool.waitForElement(
        mockTab.id!,
        '.flickering-element',
        1000
      );

      expect(element).toBeTruthy();
      expect(element?.visible).toBe(true);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle tab communication failure during wait', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        // Simulate communication failure
        mockChrome.runtime.lastError = new Error('Tab communication failed');
        callback(null);
      });

      const element = await domTool.waitForElement(
        mockTab.id!,
        '.any-element',
        500
      );

      expect(element).toBeNull();

      // Reset lastError
      mockChrome.runtime.lastError = null;
    });

    it('should handle very short timeout gracefully', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          callback({
            success: true,
            data: { elements: [] },
            requestId: message.requestId,
          });
        }, 100); // Longer than timeout
      });

      const startTime = Date.now();
      const element = await domTool.waitForElement(
        mockTab.id!,
        '.slow-element',
        50 // Very short timeout
      );
      const elapsed = Date.now() - startTime;

      expect(element).toBeNull();
      expect(elapsed).toBeLessThan(100);
    });

    it('should handle zero timeout', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          callback({
            success: true,
            data: { elements: [] },
            requestId: message.requestId,
          });
        }, 10);
      });

      const element = await domTool.waitForElement(
        mockTab.id!,
        '.any-element',
        0 // Zero timeout
      );

      expect(element).toBeNull();
    });

    it('should handle multiple parallel waits', async () => {
      let elementAAvailable = false;
      let elementBAvailable = false;

      setTimeout(() => { elementAAvailable = true; }, 100);
      setTimeout(() => { elementBAvailable = true; }, 200);

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.action === 'query') {
            const selector = message.data?.selector;
            let elements = [];

            if (selector === '.element-a' && elementAAvailable) {
              elements = [{ ...mockDynamicElement, id: 'element-a' }];
            } else if (selector === '.element-b' && elementBAvailable) {
              elements = [{ ...mockDynamicElement, id: 'element-b' }];
            }

            callback({
              success: true,
              data: { elements },
              requestId: message.requestId,
            });
          }
        }, 10);
      });

      const [elementA, elementB] = await Promise.all([
        domTool.waitForElement(mockTab.id!, '.element-a', 1000),
        domTool.waitForElement(mockTab.id!, '.element-b', 1000),
      ]);

      expect(elementA).toBeTruthy();
      expect(elementA?.id).toBe('element-a');
      expect(elementB).toBeTruthy();
      expect(elementB?.id).toBe('element-b');
    });
  });
});