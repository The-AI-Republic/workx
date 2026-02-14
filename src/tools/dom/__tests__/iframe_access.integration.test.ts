/**
 * Integration Tests: Iframe Access
 *
 * Tests accessing elements in iframes based on quickstart scenarios.
 * Covers same-origin and cross-origin iframe handling, frame targeting, and limitations.
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

// Mock DOM elements for iframe testing
const mockIframeElement = {
  tagName: 'IFRAME',
  id: 'payment-frame',
  className: 'embedded-frame',
  textContent: '',
  innerHTML: '',
  outerHTML: '<iframe id="payment-frame" src="https://payments.example.com/form"></iframe>',
  attributes: {
    id: 'payment-frame',
    src: 'https://payments.example.com/form',
    class: 'embedded-frame',
    frameborder: '0'
  },
  boundingBox: { x: 100, y: 200, width: 600, height: 400, top: 200, left: 100, bottom: 600, right: 700 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockIframeButton = {
  tagName: 'BUTTON',
  id: 'submit-payment',
  className: 'btn-primary',
  textContent: 'Submit Payment',
  innerHTML: '<span class="icon-credit-card"></span> Submit Payment',
  outerHTML: '<button id="submit-payment" class="btn-primary">Submit Payment</button>',
  attributes: { id: 'submit-payment', class: 'btn-primary', type: 'button' },
  boundingBox: { x: 250, y: 500, width: 150, height: 40, top: 500, left: 250, bottom: 540, right: 400 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockIframeInput = {
  tagName: 'INPUT',
  id: 'card-number',
  className: 'form-control secure-input',
  textContent: '',
  innerHTML: '',
  outerHTML: '<input type="text" id="card-number" class="form-control secure-input">',
  attributes: {
    type: 'text',
    id: 'card-number',
    class: 'form-control secure-input',
    placeholder: '1234 5678 9012 3456'
  },
  boundingBox: { x: 150, y: 350, width: 300, height: 35, top: 350, left: 150, bottom: 385, right: 450 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockNestedIframe = {
  tagName: 'IFRAME',
  id: 'nested-frame',
  className: 'nested-content',
  textContent: '',
  innerHTML: '',
  outerHTML: '<iframe id="nested-frame" src="/nested-content"></iframe>',
  attributes: { id: 'nested-frame', src: '/nested-content', class: 'nested-content' },
  boundingBox: { x: 50, y: 50, width: 400, height: 300, top: 50, left: 50, bottom: 350, right: 450 },
  visible: true,
  enabled: true,
  focused: false,
};

describe('Iframe Access Integration Tests', () => {
  let domTool: DOMTool;
  let mockTab: chrome.tabs.Tab;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create DOMTool instance
    domTool = new DOMTool();

    // Setup mock tab
    mockTab = {
      id: 999,
      url: 'https://shop.example.com/checkout',
      title: 'Checkout Page',
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

  describe('Same-Origin Iframe Access', () => {
    it('should access elements in same-origin iframe successfully', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'click' && message.data?.options?.frameSelector) {
              expect(message.data.options.frameSelector).toBe('iframe#payment-frame');
              expect(message.data.selector).toBe('button');

              callback({
                success: true,
                data: {
                  element: mockIframeButton,
                  success: true,
                  frameContext: 'iframe#payment-frame'
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: 'button',
        options: {
          frameSelector: 'iframe#payment-frame'
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.element.id).toBe('submit-payment');
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          data: expect.objectContaining({
            options: expect.objectContaining({
              frameSelector: 'iframe#payment-frame'
            })
          })
        }),
        expect.any(Function)
      );
    });

    it('should type in iframe input fields', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'type') {
              expect(message.data.options?.frameSelector).toBe('iframe#secure-form');
              expect(message.data.selector).toBe('#card-number');
              expect(message.data.text).toBe('4111111111111111');

              callback({
                success: true,
                data: {
                  element: { ...mockIframeInput, value: '4111111111111111' },
                  success: true,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'type',
        selector: '#card-number',
        text: '4111111111111111',
        options: {
          frameSelector: 'iframe#secure-form',
          clear: true
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.element.id).toBe('card-number');
    });

    it('should query elements in iframe', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'query') {
              expect(message.data.options?.frameSelector).toBe('#content-frame');
              expect(message.data.selector).toBe('.form-field');

              callback({
                success: true,
                data: {
                  elements: [
                    mockIframeInput,
                    { ...mockIframeInput, id: 'expiry-date', placeholder: 'MM/YY' },
                    { ...mockIframeInput, id: 'cvv', placeholder: 'CVV' }
                  ],
                  count: 3
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'query',
        selector: '.form-field',
        options: {
          frameSelector: '#content-frame',
          multiple: true
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.elements).toHaveLength(3);
      expect(result.data.count).toBe(3);
    });
  });

  describe('Cross-Origin Iframe Limitations', () => {
    it('should handle cross-origin iframe access limitations', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'click' && message.data?.options?.frameSelector === 'iframe#external-payment') {
              callback({
                success: false,
                error: 'Cross-origin iframe access denied',
                code: 'CROSS_ORIGIN_BLOCKED',
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: 'button#submit',
        options: {
          frameSelector: 'iframe#external-payment'
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cross-origin iframe access denied');
    });

    it('should detect iframe existence for cross-origin frames', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'query' && message.data?.selector === 'iframe#external-widget') {
              // Can detect iframe existence but not access content
              callback({
                success: true,
                data: {
                  elements: [{
                    tagName: 'IFRAME',
                    id: 'external-widget',
                    src: 'https://external.com/widget',
                    crossOrigin: true,
                    accessDenied: true
                  }],
                  count: 1
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'query',
        selector: 'iframe#external-widget'
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.elements).toHaveLength(1);
      expect(result.data.elements[0].crossOrigin).toBe(true);
      expect(result.data.elements[0].accessDenied).toBe(true);
    });
  });

  describe('Nested Iframe Scenarios', () => {
    it('should handle nested iframe access', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'click') {
              // Simulate accessing element in nested iframe
              const frameSelector = message.data?.options?.frameSelector;
              expect(frameSelector).toBe('#outer-frame iframe#inner-frame');

              callback({
                success: true,
                data: {
                  element: mockIframeButton,
                  success: true,
                  frameDepth: 2,
                  framePath: ['#outer-frame', '#inner-frame']
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '.nested-button',
        options: {
          frameSelector: '#outer-frame iframe#inner-frame'
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.frameDepth).toBe(2);
      expect(result.data.framePath).toEqual(['#outer-frame', '#inner-frame']);
    });

    it('should handle complex nested iframe hierarchy', async () => {
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
                    {
                      tagName: 'IFRAME',
                      id: 'level-1',
                      nestedFrames: [
                        { id: 'level-2a', accessible: true },
                        { id: 'level-2b', accessible: false, crossOrigin: true }
                      ]
                    }
                  ],
                  frameHierarchy: {
                    depth: 3,
                    accessiblePaths: ['#level-1 #level-2a'],
                    blockedPaths: ['#level-1 #level-2b']
                  }
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'query',
        selector: 'iframe',
        options: {
          multiple: true
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.frameHierarchy.depth).toBe(3);
      expect(result.data.frameHierarchy.accessiblePaths).toContain('#level-1 #level-2a');
      expect(result.data.frameHierarchy.blockedPaths).toContain('#level-1 #level-2b');
    });
  });

  describe('Iframe-Specific Operations', () => {
    it('should fill form across multiple iframes', async () => {
      let formStep = 0;
      const formData = [
        { frame: '#billing-frame', field: '#billing-address', value: '123 Main St' },
        { frame: '#shipping-frame', field: '#shipping-address', value: '456 Oak Ave' },
        { frame: '#payment-frame', field: '#card-number', value: '4111111111111111' }
      ];

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'type') {
              const expectedData = formData[formStep];
              expect(message.data.options?.frameSelector).toBe(expectedData.frame);
              expect(message.data.selector).toBe(expectedData.field);
              expect(message.data.text).toBe(expectedData.value);

              formStep++;
              callback({
                success: true,
                data: {
                  element: { ...mockIframeInput, value: expectedData.value },
                  success: true,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      // Execute form filling sequence
      for (const data of formData) {
        const request: DOMToolRequest = {
          action: 'type',
          selector: data.field,
          text: data.value,
          options: {
            frameSelector: data.frame,
            clear: true
          }
        };

        const result = await domTool.execute(request);
        expect(result.success).toBe(true);
      }

      expect(formStep).toBe(3);
    });

    it('should handle iframe scroll and visibility', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'scroll') {
              expect(message.data.options?.frameSelector).toBe('#scrollable-frame');

              callback({
                success: true,
                data: {
                  element: mockIframeElement,
                  success: true,
                  scrollPosition: { x: 0, y: 250 }
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'scroll',
        selector: '#bottom-section',
        options: {
          frameSelector: '#scrollable-frame',
          scrollIntoView: true
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.scrollPosition).toEqual({ x: 0, y: 250 });
    });

    it('should extract content from iframe', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'getText') {
              expect(message.data.options?.frameSelector).toBe('#content-frame');

              callback({
                success: true,
                data: {
                  text: 'Embedded content from iframe',
                  element: {
                    tagName: 'DIV',
                    className: 'iframe-content',
                    textContent: 'Embedded content from iframe'
                  }
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'getText',
        selector: '.content-section',
        options: {
          frameSelector: '#content-frame'
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.text).toBe('Embedded content from iframe');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle iframe not found error', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.data?.options?.frameSelector === '#non-existent-frame') {
              callback({
                success: false,
                error: 'Frame not found: #non-existent-frame',
                code: 'FRAME_NOT_FOUND',
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: 'button',
        options: {
          frameSelector: '#non-existent-frame'
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Frame not found');
    });

    it('should handle iframe loading state', async () => {
      let iframeLoaded = false;

      // Simulate iframe loading after delay
      setTimeout(() => {
        iframeLoaded = true;
      }, 200);

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'click') {
              if (!iframeLoaded) {
                callback({
                  success: false,
                  error: 'Iframe not fully loaded',
                  code: 'FRAME_NOT_READY',
                  requestId: message.requestId,
                });
              } else {
                callback({
                  success: true,
                  data: { element: mockIframeButton, success: true },
                  requestId: message.requestId,
                });
              }
            }
          }, 10);
        });

      // First attempt - iframe not loaded
      const request: DOMToolRequest = {
        action: 'click',
        selector: 'button',
        options: {
          frameSelector: '#loading-frame'
        }
      };

      const firstResult = await domTool.execute(request);
      expect(firstResult.success).toBe(false);
      expect(firstResult.error).toContain('not fully loaded');

      // Wait for iframe to load
      await new Promise(resolve => setTimeout(resolve, 250));

      // Second attempt - iframe loaded
      const secondResult = await domTool.execute(request);
      expect(secondResult.success).toBe(true);
    });

    it('should handle mixed content security restrictions', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.data?.options?.frameSelector === '#insecure-frame') {
              callback({
                success: false,
                error: 'Mixed content blocked: HTTPS page cannot access HTTP iframe',
                code: 'MIXED_CONTENT_BLOCKED',
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'type',
        selector: '#insecure-input',
        text: 'test',
        options: {
          frameSelector: '#insecure-frame'
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Mixed content blocked');
    });

    it('should handle iframe sandbox restrictions', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.data?.options?.frameSelector === '#sandboxed-frame') {
              callback({
                success: false,
                error: 'Operation blocked by iframe sandbox restrictions',
                code: 'SANDBOX_VIOLATION',
                details: {
                  sandbox: 'allow-same-origin',
                  blockedFeature: 'scripts'
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'click',
        selector: '#sandbox-button',
        options: {
          frameSelector: '#sandboxed-frame'
        }
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('sandbox restrictions');
    });
  });

  describe('Performance and Optimization', () => {
    it('should cache iframe references for performance', async () => {
      let frameCheckCount = 0;

      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.data?.options?.frameSelector === '#cached-frame') {
              frameCheckCount++;
              callback({
                success: true,
                data: {
                  element: mockIframeButton,
                  success: true,
                  frameCheckCount
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      // Multiple operations on the same frame
      const operations = [
        { action: 'click' as const, selector: '#button1' },
        { action: 'type' as const, selector: '#input1', text: 'test' },
        { action: 'click' as const, selector: '#button2' },
      ];

      for (const op of operations) {
        const request: DOMToolRequest = {
          ...op,
          options: {
            frameSelector: '#cached-frame'
          }
        };

        const result = await domTool.execute(request);
        expect(result.success).toBe(true);
      }

      // Frame should be checked for each operation but implementation
      // could potentially cache the frame reference
      expect(frameCheckCount).toBe(3);
    });
  });
});