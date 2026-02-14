/**
 * Integration Tests: Action Sequence
 *
 * Tests executing sequences of actions based on quickstart scenarios.
 * Covers complex workflows, batch operations, and performance optimization.
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
const mockMenuButton = {
  tagName: 'BUTTON',
  id: 'open-menu',
  className: 'menu-trigger',
  textContent: 'Open Menu',
  innerHTML: '<span class="icon-menu"></span> Open Menu',
  outerHTML: '<button id="open-menu" class="menu-trigger">...</button>',
  attributes: { id: 'open-menu', class: 'menu-trigger', type: 'button' },
  boundingBox: { x: 10, y: 10, width: 100, height: 40, top: 10, left: 10, bottom: 50, right: 110 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockMenuItems = {
  tagName: 'UL',
  id: 'menu-items',
  className: 'menu-list',
  textContent: 'Item 1 Item 2 Item 3',
  innerHTML: '<li class="menu-item">Item 1</li><li class="menu-item">Item 2</li><li class="menu-item">Item 3</li>',
  outerHTML: '<ul id="menu-items" class="menu-list">...</ul>',
  attributes: { id: 'menu-items', class: 'menu-list' },
  boundingBox: { x: 10, y: 50, width: 200, height: 120, top: 50, left: 10, bottom: 170, right: 210 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockMenuItem = {
  tagName: 'LI',
  className: 'menu-item',
  textContent: 'Item 2',
  innerHTML: 'Item 2',
  outerHTML: '<li class="menu-item">Item 2</li>',
  attributes: { class: 'menu-item' },
  boundingBox: { x: 10, y: 90, width: 200, height: 30, top: 90, left: 10, bottom: 120, right: 210 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockSearchBox = {
  tagName: 'INPUT',
  id: 'search',
  className: 'search-input',
  textContent: '',
  innerHTML: '',
  outerHTML: '<input type="text" id="search" class="search-input">',
  attributes: { type: 'text', id: 'search', class: 'search-input', value: 'test' },
  boundingBox: { x: 10, y: 180, width: 300, height: 35, top: 180, left: 10, bottom: 215, right: 310 },
  visible: true,
  enabled: true,
  focused: false,
};

const mockForm = {
  tagName: 'FORM',
  id: 'search-form',
  className: 'search-form',
  textContent: '',
  innerHTML: '<input type="text" id="search"><button type="submit">Search</button>',
  outerHTML: '<form id="search-form" class="search-form">...</form>',
  attributes: { id: 'search-form', class: 'search-form', method: 'get', action: '/search' },
  boundingBox: { x: 10, y: 170, width: 350, height: 60, top: 170, left: 10, bottom: 230, right: 360 },
  visible: true,
  enabled: true,
  focused: false,
};

describe('Action Sequence Integration Tests', () => {
  let domTool: DOMTool;
  let mockTab: chrome.tabs.Tab;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create DOMTool instance
    domTool = new DOMTool();

    // Setup mock tab
    mockTab = {
      id: 789,
      url: 'https://example.com/app',
      title: 'Test Application',
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

  describe('Basic Action Sequences', () => {
    it('should execute simple action sequence successfully', async () => {
      const actionResults = [];

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          actionResults.push(message.action);

          switch (message.action) {
            case 'click':
              if (message.data?.selector === '#open-menu') {
                callback({
                  success: true,
                  data: { element: mockMenuButton, success: true },
                  requestId: message.requestId,
                });
              } else if (message.data?.selector === '.menu-item:nth-child(2)') {
                callback({
                  success: true,
                  data: { element: mockMenuItem, success: true },
                  requestId: message.requestId,
                });
              }
              break;
            case 'query':
              if (message.data?.selector === '.menu-items') {
                callback({
                  success: true,
                  data: { elements: [mockMenuItems] },
                  requestId: message.requestId,
                });
              }
              break;
            case 'type':
              callback({
                success: true,
                data: { element: mockSearchBox, success: true },
                requestId: message.requestId,
              });
              break;
            case 'submit':
              callback({
                success: true,
                data: { element: mockForm, success: true },
                requestId: message.requestId,
              });
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

      const actions: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#open-menu' },
        { action: 'query', selector: '.menu-items' },
        { action: 'click', selector: '.menu-item:nth-child(2)' },
        { action: 'type', selector: '#search', text: 'test' },
        { action: 'submit', selector: 'form' }
      ];

      const results = await domTool.executeSequence(mockTab.id!, actions);

      expect(results).toHaveLength(5);
      expect(results.every(result => result.success === true)).toBe(true);
      expect(actionResults).toEqual(['click', 'query', 'click', 'type', 'submit']);
    });

    it('should handle partial sequence failure gracefully', async () => {
      let actionCount = 0;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          actionCount++;

          if (actionCount === 3) {
            // Third action fails
            callback({
              success: false,
              error: 'Element not found',
              requestId: message.requestId,
            });
          } else {
            callback({
              success: true,
              data: { success: true },
              requestId: message.requestId,
            });
          }
        }, 10);
      });

      const actions: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#button1' },
        { action: 'click', selector: '#button2' },
        { action: 'click', selector: '#non-existent' }, // This will fail
        { action: 'click', selector: '#button4' },
        { action: 'click', selector: '#button5' }
      ];

      const results = await domTool.executeSequence(mockTab.id!, actions);

      expect(results).toHaveLength(5);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(false);
      expect(results[3].success).toBe(true);
      expect(results[4].success).toBe(true);
    });
  });

  describe('Complex Workflow Sequences', () => {
    it('should execute navigation and form filling workflow', async () => {
      let currentStep = 0;
      const steps = ['menu-click', 'menu-wait', 'item-select', 'form-fill', 'form-submit'];

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          const step = steps[currentStep];
          currentStep++;

          switch (step) {
            case 'menu-click':
              expect(message.action).toBe('click');
              expect(message.data?.selector).toBe('#navigation-menu');
              callback({
                success: true,
                data: { element: mockMenuButton, success: true },
                requestId: message.requestId,
              });
              break;
            case 'menu-wait':
              expect(message.action).toBe('query');
              expect(message.data?.selector).toBe('.dropdown-items');
              callback({
                success: true,
                data: { elements: [mockMenuItems] },
                requestId: message.requestId,
              });
              break;
            case 'item-select':
              expect(message.action).toBe('click');
              expect(message.data?.selector).toBe('.dropdown-item[data-action="search"]');
              callback({
                success: true,
                data: { element: mockMenuItem, success: true },
                requestId: message.requestId,
              });
              break;
            case 'form-fill':
              expect(message.action).toBe('type');
              expect(message.data?.selector).toBe('#search-query');
              expect(message.data?.text).toBe('integration test');
              callback({
                success: true,
                data: { element: mockSearchBox, success: true },
                requestId: message.requestId,
              });
              break;
            case 'form-submit':
              expect(message.action).toBe('submit');
              expect(message.data?.selector).toBe('#search-form');
              callback({
                success: true,
                data: { element: mockForm, success: true },
                requestId: message.requestId,
              });
              break;
            default:
              callback({
                success: false,
                error: 'Unexpected step',
                requestId: message.requestId,
              });
          }
        }, 20);
      });

      const actions: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#navigation-menu' },
        { action: 'query', selector: '.dropdown-items' },
        { action: 'click', selector: '.dropdown-item[data-action="search"]' },
        { action: 'type', selector: '#search-query', text: 'integration test' },
        { action: 'submit', selector: '#search-form' }
      ];

      const results = await domTool.executeSequence(mockTab.id!, actions);

      expect(results).toHaveLength(5);
      expect(results.every(result => result.success === true)).toBe(true);
      expect(currentStep).toBe(5);
    });

    it('should handle multi-step form with validation', async () => {
      let formStep = 1;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          switch (message.action) {
            case 'type':
              callback({
                success: true,
                data: { element: mockSearchBox, success: true },
                requestId: message.requestId,
              });
              break;
            case 'click':
              if (message.data?.selector === '#next-step') {
                formStep++;
                callback({
                  success: true,
                  data: { element: mockMenuButton, success: true },
                  requestId: message.requestId,
                });
              } else {
                callback({
                  success: true,
                  data: { element: mockMenuButton, success: true },
                  requestId: message.requestId,
                });
              }
              break;
            case 'query':
              // Check for validation messages or next step availability
              if (message.data?.selector === '.validation-error') {
                callback({
                  success: true,
                  data: { elements: [] }, // No validation errors
                  requestId: message.requestId,
                });
              } else if (message.data?.selector === '#step-2') {
                callback({
                  success: true,
                  data: {
                    elements: formStep >= 2 ? [mockMenuItems] : []
                  },
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
        }, 15);
      });

      const actions: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'type', selector: '#first-name', text: 'John' },
        { action: 'type', selector: '#last-name', text: 'Doe' },
        { action: 'click', selector: '#next-step' },
        { action: 'query', selector: '.validation-error' },
        { action: 'query', selector: '#step-2' },
        { action: 'type', selector: '#email', text: 'john@example.com' },
        { action: 'click', selector: '#submit' }
      ];

      const results = await domTool.executeSequence(mockTab.id!, actions);

      expect(results).toHaveLength(7);
      expect(results.every(result => result.success === true)).toBe(true);
      expect(formStep).toBe(2);
    });
  });

  describe('Performance and Optimization', () => {
    it('should execute batch operations efficiently', async () => {
      const startTime = Date.now();
      let actionCount = 0;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          actionCount++;
          callback({
            success: true,
            data: { success: true },
            requestId: message.requestId,
          });
        }, 5); // Very fast response to test batching
      });

      // Create a large sequence of actions
      const actions: Omit<DOMToolRequest, 'tabId'>[] = Array.from({ length: 10 }, (_, i) => ({
        action: 'click' as const,
        selector: `#button-${i}`,
      }));

      const results = await domTool.executeSequence(mockTab.id!, actions);
      const elapsed = Date.now() - startTime;

      expect(results).toHaveLength(10);
      expect(results.every(result => result.success === true)).toBe(true);
      expect(actionCount).toBe(10);
      expect(elapsed).toBeLessThan(1000); // Should complete reasonably fast
    });

    it('should handle concurrent action sequences', async () => {
      let sequence1Count = 0;
      let sequence2Count = 0;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          // Track which sequence this belongs to based on selector pattern
          if (message.data?.selector?.includes('seq1')) {
            sequence1Count++;
          } else if (message.data?.selector?.includes('seq2')) {
            sequence2Count++;
          }

          callback({
            success: true,
            data: { success: true },
            requestId: message.requestId,
          });
        }, Math.random() * 50); // Random delay to test concurrency
      });

      const sequence1: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#seq1-btn1' },
        { action: 'click', selector: '#seq1-btn2' },
        { action: 'click', selector: '#seq1-btn3' },
      ];

      const sequence2: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#seq2-btn1' },
        { action: 'click', selector: '#seq2-btn2' },
      ];

      const [results1, results2] = await Promise.all([
        domTool.executeSequence(mockTab.id!, sequence1),
        domTool.executeSequence(mockTab.id!, sequence2),
      ]);

      expect(results1).toHaveLength(3);
      expect(results2).toHaveLength(2);
      expect(results1.every(result => result.success === true)).toBe(true);
      expect(results2.every(result => result.success === true)).toBe(true);
      expect(sequence1Count).toBe(3);
      expect(sequence2Count).toBe(2);
    });
  });

  describe('Advanced Sequence Patterns', () => {
    it('should handle conditional action sequence', async () => {
      let elementExists = false;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          switch (message.action) {
            case 'query':
              if (message.data?.selector === '.conditional-element') {
                callback({
                  success: true,
                  data: {
                    elements: elementExists ? [mockMenuButton] : []
                  },
                  requestId: message.requestId,
                });
              }
              break;
            case 'click':
              if (message.data?.selector === '#trigger') {
                elementExists = true; // Element appears after trigger
              }
              callback({
                success: true,
                data: { element: mockMenuButton, success: true },
                requestId: message.requestId,
              });
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

      // First sequence: check if element exists (it doesn't)
      const checkSequence: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'query', selector: '.conditional-element' },
      ];

      const checkResults = await domTool.executeSequence(mockTab.id!, checkSequence);
      expect(checkResults[0].success).toBe(true);
      expect(checkResults[0].data?.elements).toHaveLength(0);

      // Second sequence: trigger action and check again
      const triggerSequence: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#trigger' },
        { action: 'query', selector: '.conditional-element' },
      ];

      const triggerResults = await domTool.executeSequence(mockTab.id!, triggerSequence);
      expect(triggerResults[0].success).toBe(true);
      expect(triggerResults[1].success).toBe(true);
      expect(triggerResults[1].data?.elements).toHaveLength(1);
    });

    it('should handle sequence with wait operations', async () => {
      let menuOpened = false;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          switch (message.action) {
            case 'click':
              if (message.data?.selector === '#menu-trigger') {
                setTimeout(() => {
                  menuOpened = true;
                }, 100); // Menu opens after delay
              }
              callback({
                success: true,
                data: { element: mockMenuButton, success: true },
                requestId: message.requestId,
              });
              break;
            case 'query':
              if (message.data?.selector === '.menu-content') {
                callback({
                  success: true,
                  data: {
                    elements: menuOpened ? [mockMenuItems] : []
                  },
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

      const actions: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#menu-trigger' },
        // Simulate waitForElement by querying until element appears
        { action: 'query', selector: '.menu-content' },
        { action: 'query', selector: '.menu-content' }, // Retry
        { action: 'click', selector: '.menu-item' },
      ];

      // Execute with delays to simulate waitForElement behavior
      const results = [];
      for (const action of actions) {
        const result = await domTool.execute({ ...action, tabId: mockTab.id });
        results.push(result);

        // Add delay if querying for menu content and it's not found yet
        if (action.action === 'query' && action.selector === '.menu-content' &&
            (!result.data?.elements || result.data.elements.length === 0)) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }

      expect(results).toHaveLength(4);
      expect(results[0].success).toBe(true); // Click
      expect(results[1].success).toBe(true); // First query (empty)
      expect(results[2].success).toBe(true); // Second query (found)
      expect(results[3].success).toBe(true); // Click menu item

      expect(results[1].data?.elements).toHaveLength(0); // First query finds nothing
      expect(results[2].data?.elements).toHaveLength(1); // Second query finds menu
    });
  });

  describe('Error Recovery in Sequences', () => {
    it('should continue sequence execution after recoverable errors', async () => {
      let attemptCount = 0;

      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        setTimeout(() => {
          attemptCount++;

          if (message.action === 'click' && message.data?.selector === '#flaky-element') {
            // Fail first two attempts, succeed on third
            if (attemptCount <= 2) {
              callback({
                success: false,
                error: 'Element temporarily unavailable',
                requestId: message.requestId,
              });
            } else {
              callback({
                success: true,
                data: { element: mockMenuButton, success: true },
                requestId: message.requestId,
              });
            }
          } else {
            callback({
              success: true,
              data: { success: true },
              requestId: message.requestId,
            });
          }
        }, 10);
      });

      const actions: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#stable-element' },
        { action: 'click', selector: '#flaky-element' },
        { action: 'click', selector: '#flaky-element' }, // Retry
        { action: 'click', selector: '#flaky-element' }, // Retry again
        { action: 'click', selector: '#final-element' },
      ];

      const results = await domTool.executeSequence(mockTab.id!, actions);

      expect(results).toHaveLength(5);
      expect(results[0].success).toBe(true);  // Stable element
      expect(results[1].success).toBe(false); // First flaky attempt
      expect(results[2].success).toBe(false); // Second flaky attempt
      expect(results[3].success).toBe(true);  // Third flaky attempt succeeds
      expect(results[4].success).toBe(true);  // Final element
    });

    it('should handle timeout in sequence gracefully', async () => {
      mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
        if (message.data?.selector === '#slow-element') {
          // Don't call callback to simulate timeout
          return;
        }

        setTimeout(() => {
          callback({
            success: true,
            data: { success: true },
            requestId: message.requestId,
          });
        }, 10);
      });

      const actions: Omit<DOMToolRequest, 'tabId'>[] = [
        { action: 'click', selector: '#normal-element' },
        {
          action: 'click',
          selector: '#slow-element',
          options: { timeout: 100 } // Short timeout
        },
        { action: 'click', selector: '#recovery-element' },
      ];

      const results = await domTool.executeSequence(mockTab.id!, actions);

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);   // Normal element
      expect(results[1].success).toBe(false);  // Timeout element
      expect(results[2].success).toBe(true);   // Recovery continues
    });
  });
});