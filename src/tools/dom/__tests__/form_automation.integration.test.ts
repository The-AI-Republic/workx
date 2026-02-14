/**
 * Integration Tests: Form Automation
 *
 * Tests form filling and submission flow based on quickstart scenarios.
 * Includes comprehensive testing of form operations, validation, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOMTool, DOMToolRequest, DOMToolResponse } from '@/tools/DOMTool';

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
const mockFormElement = {
  tagName: 'FORM',
  id: 'signup-form',
  className: 'registration-form',
  textContent: '',
  innerHTML: '<input name="username"><input name="email"><input name="password">',
  outerHTML: '<form id="signup-form">...</form>',
  attributes: { id: 'signup-form', method: 'post', action: '/signup' },
  boundingBox: { x: 100, y: 200, width: 400, height: 300, top: 200, left: 100, bottom: 500, right: 500 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockInputElement = {
  tagName: 'INPUT',
  id: 'username',
  className: 'form-control',
  textContent: '',
  innerHTML: '',
  outerHTML: '<input type="text" name="username" id="username" class="form-control">',
  attributes: { type: 'text', name: 'username', id: 'username', class: 'form-control' },
  boundingBox: { x: 110, y: 220, width: 200, height: 30, top: 220, left: 110, bottom: 250, right: 310 },
  visible: true,
  enabled: true,
  focused: false,
};

describe('Form Automation Integration Tests', () => {
  let domTool: DOMTool;
  let mockTab: chrome.tabs.Tab;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create DOMTool instance
    domTool = new DOMTool();

    // Setup mock tab
    mockTab = {
      id: 123,
      url: 'https://example.com/signup',
      title: 'Sign Up',
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

  describe('Form Filling Operations', () => {
    it('should fill entire form with data', async () => {
      // Mock content script response for fillForm
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.action === 'fillForm') {
            callback({
              success: true,
              data: {
                success: true,
                fieldsSet: 3,
                formElement: mockFormElement,
              },
              requestId: message.requestId,
            });
          }
        }, 10);
      });

      const formData = {
        username: 'john.doe',
        email: 'john@example.com',
        password: 'secure123'
      };

      const result = await domTool.fillForm(mockTab.id!, formData, '#signup-form');

      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          type: 'DOM_ACTION',
          action: 'fillForm',
          data: {
            formData,
            formSelector: '#signup-form',
          },
        }),
        expect.any(Function)
      );
    });

    it('should handle individual field filling', async () => {
      // Mock ping response first (content script check)
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'type') {
              callback({
                success: true,
                data: {
                  element: mockInputElement,
                  success: true,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'type',
        tabId: mockTab.id,
        selector: 'input[name="username"]',
        text: 'john.doe@example.com',
        options: {
          clear: true,
          delay: 50,
        },
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.element.id).toBe('username');
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          action: 'type',
          data: {
            selector: 'input[name="username"]',
            text: 'john.doe@example.com',
            options: { clear: true, delay: 50 },
          },
        }),
        expect.any(Function)
      );
    });

    it('should clear field before typing when clear option is true', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            callback({
              success: true,
              data: {
                element: { ...mockInputElement, textContent: 'chrome extension' },
                success: true,
              },
              requestId: message.requestId,
            });
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'type',
        selector: '#search-box',
        text: 'chrome extension',
        options: {
          clear: true,
          delay: 50,
        },
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          data: expect.objectContaining({
            options: expect.objectContaining({
              clear: true,
              delay: 50,
            }),
          }),
        }),
        expect.any(Function)
      );
    });
  });

  describe('Form Submission', () => {
    it('should submit form successfully', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'submit') {
              callback({
                success: true,
                data: {
                  element: mockFormElement,
                  success: true,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'submit',
        selector: '#signup-form',
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          action: 'submit',
          data: {
            selector: '#signup-form',
            options: undefined,
          },
        }),
        expect.any(Function)
      );
    });

    it('should handle form submission with scroll into view', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            callback({
              success: true,
              data: {
                element: mockFormElement,
                success: true,
              },
              requestId: message.requestId,
            });
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'submit',
        selector: 'form#login',
        options: {
          scrollIntoView: true,
        },
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          data: expect.objectContaining({
            options: { scrollIntoView: true },
          }),
        }),
        expect.any(Function)
      );
    });
  });

  describe('Complete Form Workflow', () => {
    it('should complete full signup form workflow', async () => {
      // Mock content script responses for the complete workflow
      let callCount = 0;
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          callCount++;

          if (message.type === 'PING') {
            callback({ type: 'PONG' });
            return;
          }

          switch (message.action) {
            case 'fillForm':
              callback({
                success: true,
                data: { success: true, fieldsSet: 3 },
                requestId: message.requestId,
              });
              break;
            case 'submit':
              callback({
                success: true,
                data: { element: mockFormElement, success: true },
                requestId: message.requestId,
              });
              break;
            case 'query':
              // Simulate success message appearing after submission
              if (callCount > 2) {
                callback({
                  success: true,
                  data: {
                    elements: [{
                      tagName: 'DIV',
                      className: 'success-message',
                      textContent: 'Registration successful!',
                      visible: true,
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
              break;
            default:
              callback({
                success: true,
                data: {},
                requestId: message.requestId,
              });
          }
        }, 10);
      });

      // Step 1: Fill form
      const formData = {
        email: 'test@example.com',
        password: 'test123'
      };

      const fillResult = await domTool.fillForm(mockTab.id!, formData);
      expect(fillResult.success).toBe(true);
      expect(fillResult.count).toBe(3);

      // Step 2: Submit form
      const submitRequest: DOMToolRequest = {
        action: 'submit',
        selector: 'form#login',
      };

      const submitResult = await domTool.execute(submitRequest);
      expect(submitResult.success).toBe(true);

      // Step 3: Wait for success message
      const successElement = await domTool.waitForElement(
        mockTab.id!,
        '.success-message',
        5000
      );

      expect(successElement).toBeTruthy();
      expect(successElement?.textContent).toBe('Registration successful!');
    });

    it('should handle form validation errors gracefully', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          } else if (message.action === 'fillForm') {
            callback({
              success: false,
              error: 'Invalid email format',
              requestId: message.requestId,
            });
          }
        }, 10);
      });

      const formData = {
        email: 'invalid-email',
        password: 'test123'
      };

      try {
        await domTool.fillForm(mockTab.id!, formData);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).toContain('Invalid email format');
      }
    });
  });

  describe('Form Field Interactions', () => {
    it('should focus on form fields before typing', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'focus') {
              callback({
                success: true,
                data: {
                  element: { ...mockInputElement, focused: true },
                  success: true,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'focus',
        selector: 'input[name="username"]',
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.element.focused).toBe(true);
    });

    it('should get form field values', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'getAttribute') {
              callback({
                success: true,
                data: {
                  value: 'john.doe@example.com',
                  element: mockInputElement,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'getAttribute',
        selector: 'input[name="email"]',
        attribute: 'value',
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.attribute).toBe('john.doe@example.com');
    });

    it('should handle form field scroll into view', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          setTimeout(() => {
            if (message.action === 'scroll') {
              callback({
                success: true,
                data: {
                  element: mockInputElement,
                  success: true,
                },
                requestId: message.requestId,
              });
            }
          }, 10);
        });

      const request: DOMToolRequest = {
        action: 'scroll',
        selector: 'input[name="email"]',
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing required fields', async () => {
      const request: DOMToolRequest = {
        action: 'type',
        // Missing required selector
        text: 'test value',
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Selector is required');
    });

    it('should handle content script communication errors', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          // Simulate communication error
          mockChrome.runtime.lastError = new Error('Tab not found');
          callback(null);
        });

      const request: DOMToolRequest = {
        action: 'type',
        selector: 'input[name="username"]',
        text: 'test',
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content script communication failed');

      // Reset lastError
      mockChrome.runtime.lastError = null;
    });

    it('should handle form submission timeout', async () => {
      mockChrome.tabs.sendMessage
        .mockImplementationOnce((tabId, message, callback) => {
          if (message.type === 'PING') {
            callback({ type: 'PONG' });
          }
        })
        .mockImplementation((tabId, message, callback) => {
          // Don't call callback to simulate timeout
        });

      const request: DOMToolRequest = {
        action: 'submit',
        selector: '#slow-form',
        options: {
          timeout: 100, // Very short timeout
        },
      };

      const result = await domTool.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });
});