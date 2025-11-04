import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT, NODE_TYPE_DOCUMENT_FRAGMENT } from '../types';
import { DomService } from '../DomService';

/**
 * Action Reliability Tests (User Story 4)
 *
 * Goals:
 * - Verify all actions follow closed-loop "Observe-Act-Invalidate" pattern
 * - Verify actions use backendNodeId (not stale CSS selectors)
 * - Verify error handling and recovery
 * - Verify retry logic for transient failures
 * - Verify visual effects sent (non-blocking)
 */

describe('Action Reliability: Click', () => {
  let mockTabId: number;
  let mockChrome: any;

  beforeEach(() => {
    mockTabId = 100;

    mockChrome = {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn(),
        onEvent: {
          addListener: vi.fn()
        },
        onDetach: {
          addListener: vi.fn()
        }
      },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: mockTabId,
          url: 'https://example.com',
          title: 'Test',
          width: 1920,
          height: 1080
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined) // Visual effects
      }
    };

    // @ts-ignore
    global.chrome = mockChrome;
  });

  afterEach(async () => {
    const instances = (DomService as any).instances;
    for (const [tabId, service] of instances.entries()) {
      await service.detach().catch(() => {});
    }
    instances.clear();
    vi.clearAllMocks();
  });

  it('should follow closed-loop pattern: click → invalidate snapshot', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 100,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BUTTON',
                localName: 'button'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 100,
              role: { value: 'button' },
              name: { value: 'Click Me' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        return {
          model: {
            content: [10, 20, 110, 20, 110, 60, 10, 60]
          }
        };
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'Input.dispatchMouseEvent') return {};

      // Mock viewport dimensions check
      if (method === 'Runtime.evaluate' && params?.expression?.includes('window.innerWidth')) {
        return {
          result: {
            value: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 }
          }
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot1 = domService.getCurrentSnapshot();
    expect(snapshot1).not.toBeNull();

    const backendNodeId = 100;  // Use backendNodeId from serialized output
    const result = await domService.click(backendNodeId);

    expect(result.success).toBe(true);
    expect(result.actionType).toBe('click');
    expect(result.nodeId).toBe(backendNodeId);

    // Verify snapshot was invalidated (closed-loop)
    const snapshot2 = domService.getCurrentSnapshot();
    expect(snapshot2).toBeNull();
  });

  it('should use backendNodeId (not CSS selector)', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 200,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BUTTON',
                localName: 'button',
                attributes: ['id', 'submit-btn'] // Has ID, but we use backendNodeId
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 200,
              role: { value: 'button' },
              name: { value: 'Submit' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        // Verify backendNodeId is used (not selector)
        expect(params.backendNodeId).toBe(200);
        expect(params.selector).toBeUndefined();

        return {
          model: {
            content: [50, 100, 150, 100, 150, 140, 50, 140]
          }
        };
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') {
        // Also verify backendNodeId
        expect(params.backendNodeId).toBe(200);
        return {};
      }

      if (method === 'Input.dispatchMouseEvent') return {};

      // Mock viewport dimensions check
      if (method === 'Runtime.evaluate' && params?.expression?.includes('window.innerWidth')) {
        return {
          result: {
            value: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 }
          }
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 200;  // Use backendNodeId from serialized output

    await domService.click(backendNodeId);

    // Verify backendNodeId was used (assertions in mock above)
  });

  it('should scroll element into view before clicking', async () => {
    let scrollCalled = false;

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 300,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BUTTON',
                localName: 'button'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 300,
              role: { value: 'button' },
              name: { value: 'Below Fold' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        // Return coordinates that are off-screen on first call, then on-screen after scroll
        if (scrollCalled) {
          // After scroll - element is now visible
          return {
            model: {
              content: [100, 500, 200, 500, 200, 550, 100, 550]
            }
          };
        } else {
          // Before scroll - element is below viewport
          return {
            model: {
              content: [100, 2000, 200, 2000, 200, 2050, 100, 2050]
            }
          };
        }
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') {
        scrollCalled = true;
        expect(params.backendNodeId).toBe(300);
        return {};
      }

      if (method === 'Input.dispatchMouseEvent') {
        // Should only be called after scroll
        expect(scrollCalled).toBe(true);
        return {};
      }

      // Mock viewport dimensions check - element at y=2000 is below viewport (height=1080)
      if (method === 'Runtime.evaluate' && params?.expression?.includes('window.innerWidth')) {
        return {
          result: {
            value: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 }
          }
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 300;  // Use backendNodeId from serialized output

    await domService.click(backendNodeId);

    expect(scrollCalled).toBe(true);
  });

  it('should calculate center coordinates correctly', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 400,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BUTTON',
                localName: 'button'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 400,
              role: { value: 'button' },
              name: { value: 'Test' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        // Box: top-left (20, 30), top-right (80, 30), bottom-right (80, 70), bottom-left (20, 70)
        return {
          model: {
            content: [20, 30, 80, 30, 80, 70, 20, 70]
          }
        };
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') return {};

      if (method === 'Input.dispatchMouseEvent') {
        const expectedX = (20 + 80) / 2; // 50
        const expectedY = (30 + 70) / 2; // 50

        expect(params.x).toBe(expectedX);
        expect(params.y).toBe(expectedY);

        return {};
      }

      // Mock viewport dimensions check
      if (method === 'Runtime.evaluate' && params?.expression?.includes('window.innerWidth')) {
        return {
          result: {
            value: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 }
          }
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 400;  // Use backendNodeId from serialized output

    await domService.click(backendNodeId);
  });

  it('should trigger CDP Runtime.evaluate visual effect', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 500,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BUTTON',
                localName: 'button'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 500,
              role: { value: 'button' },
              name: { value: 'Visual Test' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        return {
          model: {
            content: [100, 200, 200, 200, 200, 250, 100, 250]
          }
        };
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'Input.dispatchMouseEvent') return {};

      // Mock viewport dimensions check
      if (method === 'Runtime.evaluate' && params?.expression?.includes('window.innerWidth')) {
        return {
          result: {
            value: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 }
          }
        };
      }

      // Mock visual effect Runtime.evaluate calls
      if (method === 'Runtime.evaluate') return { result: { value: { success: true } } };

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 500;  // Use backendNodeId from serialized output

    const result = await domService.click(backendNodeId);

    // CDP MIGRATION: Verify Runtime.evaluate triggers visual effect (CSP-safe, synchronous)
    const runtimeCalls = (mockChrome.debugger.sendCommand as any).mock.calls.filter(
      (call: any[]) => call[1] === 'Runtime.evaluate'
    );

    expect(runtimeCalls.length).toBeGreaterThan(0);

    // Verify the expression dispatches the custom event for ripple effect
    const runtimeCall = runtimeCalls.find((call: any[]) =>
      call[2].expression.includes('browserx:show-visual-effect') &&
      call[2].expression.includes('"ripple"')
    );

    expect(runtimeCall).toBeDefined();
    expect(runtimeCall[2].expression).toContain('x: 150'); // Center X
    expect(runtimeCall[2].expression).toContain('y: 225'); // Center Y

    expect(result.success).toBe(true);
    expect(result.actionType).toBe('click');
  });

  it('should handle click error and still invalidate snapshot', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 600,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BUTTON',
                localName: 'button'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 600,
              role: { value: 'button' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        // Simulate element detached from DOM
        throw new Error('Node not found');
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot1 = domService.getCurrentSnapshot();
    expect(snapshot1).not.toBeNull();

    const backendNodeId = 600;  // Use backendNodeId from serialized output
    const result = await domService.click(backendNodeId);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Node not found');
    expect(result.actionType).toBe('click');

    // Snapshot must be invalidated even on error (closed-loop)
    expect(domService.getCurrentSnapshot()).toBeNull();
  });

  it('should handle NODE_NOT_FOUND for invalid nodeId', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML'
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [] };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    // Attempt click with non-existent backendNodeId
    const result = await domService.click(999);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.actionType).toBe('click');
  });

  it('should NOT send visual effect when disabled in config', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 700,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BUTTON',
                localName: 'button'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 700,
              role: { value: 'button' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        return {
          model: {
            content: [10, 10, 50, 10, 50, 40, 10, 40]
          }
        };
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'Input.dispatchMouseEvent') return {};

      // Mock viewport dimensions check
      if (method === 'Runtime.evaluate' && params?.expression?.includes('window.innerWidth')) {
        return {
          result: {
            value: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 }
          }
        };
      }

      return {};
    });

    // Create service with visual effects disabled
    const domService = await DomService.forTab(mockTabId, { enableVisualEffects: false });
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 700;  // Use backendNodeId from serialized output

    const result = await domService.click(backendNodeId);

    expect(result.success).toBe(true);

    // CDP MIGRATION: Runtime.evaluate should NOT be called for visual effects when disabled
    const runtimeCalls = (mockChrome.debugger.sendCommand as any).mock.calls.filter(
      (call: any[]) => call[1] === 'Runtime.evaluate'
    );
    expect(runtimeCalls.length).toBe(0);
  });
});

describe('Action Reliability: Type', () => {
  let mockTabId: number;
  let mockChrome: any;

  beforeEach(() => {
    mockTabId = 200;

    mockChrome = {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn(),
        onEvent: {
          addListener: vi.fn()
        },
        onDetach: {
          addListener: vi.fn()
        }
      },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: mockTabId,
          url: 'https://example.com',
          title: 'Test',
          width: 1920,
          height: 1080
        }),
        sendMessage: vi.fn()
      }
    };

    // @ts-ignore
    global.chrome = mockChrome;
  });

  afterEach(async () => {
    const instances = (DomService as any).instances;
    for (const [tabId, service] of instances.entries()) {
      await service.detach().catch(() => {});
    }
    instances.clear();
    vi.clearAllMocks();
  });

  it('should follow closed-loop pattern: type → invalidate snapshot', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 100,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'INPUT',
                localName: 'input'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 100,
              role: { value: 'textbox' },
              name: { value: 'Email' }
            }
          ]
        };
      }

      if (method === 'DOM.focus') return {};
      if (method === 'Input.dispatchKeyEvent') return {};
      if (method === 'Input.insertText') return {};

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot1 = domService.getCurrentSnapshot();
    expect(snapshot1).not.toBeNull();

    const backendNodeId = 100;  // Use backendNodeId from serialized output
    const result = await domService.type(backendNodeId, 'test@example.com');

    expect(result.success).toBe(true);
    expect(result.actionType).toBe('type');

    // Verify snapshot invalidated
    expect(domService.getCurrentSnapshot()).toBeNull();
  });

  it('should focus element before typing', async () => {
    let focusCalled = false;

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 200,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'INPUT',
                localName: 'input'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 200,
              role: { value: 'textbox' }
            }
          ]
        };
      }

      if (method === 'DOM.focus') {
        focusCalled = true;
        expect(params.backendNodeId).toBe(200);
        return {};
      }

      if (method === 'Input.dispatchKeyEvent') {
        // Should only be called after focus
        expect(focusCalled).toBe(true);
        return {};
      }

      if (method === 'Input.insertText') {
        expect(focusCalled).toBe(true);
        return {};
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 200;  // Use backendNodeId from serialized output

    await domService.type(backendNodeId, 'hello');

    expect(focusCalled).toBe(true);
  });

  it('should clear existing value before typing (Ctrl+A, Backspace)', async () => {
    const keyEvents: any[] = [];

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 300,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'INPUT',
                localName: 'input'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 300,
              role: { value: 'textbox' }
            }
          ]
        };
      }

      if (method === 'DOM.focus') return {};

      if (method === 'Input.dispatchKeyEvent') {
        keyEvents.push(params);
        return {};
      }

      if (method === 'Input.insertText') return {};

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 300;  // Use backendNodeId from serialized output

    await domService.type(backendNodeId, 'new value');

    // Verify Ctrl+A was sent
    const ctrlA = keyEvents.find(e => e.key === 'a' && e.modifiers === 2);
    expect(ctrlA).toBeDefined();
    expect(ctrlA.type).toBe('keyDown');

    // Verify Backspace was sent
    const backspace = keyEvents.find(e => e.key === 'Backspace');
    expect(backspace).toBeDefined();
  });

  it('should insert text exactly as provided', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 400,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'TEXTAREA',
                localName: 'textarea'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 400,
              role: { value: 'textbox' }
            }
          ]
        };
      }

      if (method === 'DOM.focus') return {};
      if (method === 'Input.dispatchKeyEvent') return {};

      if (method === 'Input.insertText') {
        expect(params.text).toBe('Hello, World! 🎉');
        return {};
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 400;  // Use backendNodeId from serialized output

    await domService.type(backendNodeId, 'Hello, World! 🎉');
  });

  it('should press Enter if text ends with newline', async () => {
    const keyEvents: any[] = [];

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 500,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'INPUT',
                localName: 'input'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 500,
              role: { value: 'searchbox' }
            }
          ]
        };
      }

      if (method === 'DOM.focus') return {};

      if (method === 'Input.dispatchKeyEvent') {
        keyEvents.push(params);
        return {};
      }

      if (method === 'Input.insertText') return {};

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 500;  // Use backendNodeId from serialized output

    await domService.type(backendNodeId, 'search query\n');

    // Verify Enter was pressed after text insertion
    const enterKey = keyEvents.find(e => e.key === 'Enter');
    expect(enterKey).toBeDefined();
    expect(enterKey.type).toBe('keyDown');
  });

  it('should handle type error and invalidate snapshot', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            children: [
              {
                nodeId: 2,
                backendNodeId: 600,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'INPUT',
                localName: 'input'
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              backendDOMNodeId: 600,
              role: { value: 'textbox' }
            }
          ]
        };
      }

      if (method === 'DOM.focus') {
        throw new Error('CDP_ERROR: Element not focusable');
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot1 = domService.getCurrentSnapshot();
    const backendNodeId = 600;  // Use backendNodeId from serialized output

    const result = await domService.type(backendNodeId, 'test');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not focusable');
    expect(result.actionType).toBe('type');

    // Snapshot must be invalidated on error
    expect(domService.getCurrentSnapshot()).toBeNull();
  });
});

describe('Action Reliability: Keypress', () => {
  let mockTabId: number;
  let mockChrome: any;

  beforeEach(() => {
    mockTabId = 300;

    mockChrome = {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn(),
        onEvent: {
          addListener: vi.fn()
        },
        onDetach: {
          addListener: vi.fn()
        }
      },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: mockTabId,
          url: 'https://example.com',
          title: 'Test',
          width: 1920,
          height: 1080
        }),
        sendMessage: vi.fn()
      }
    };

    // @ts-ignore
    global.chrome = mockChrome;
  });

  afterEach(async () => {
    const instances = (DomService as any).instances;
    for (const [tabId, service] of instances.entries()) {
      await service.detach().catch(() => {});
    }
    instances.clear();
    vi.clearAllMocks();
  });

  it('should dispatch keyDown and keyUp events', async () => {
    const keyEvents: any[] = [];

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML'
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [] };
      }

      if (method === 'Input.dispatchKeyEvent') {
        keyEvents.push(params);
        return {};
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    await domService.keypress('Enter');

    expect(keyEvents.length).toBe(2); // keyDown + keyUp

    const keyDown = keyEvents.find(e => e.type === 'keyDown');
    const keyUp = keyEvents.find(e => e.type === 'keyUp');

    expect(keyDown).toBeDefined();
    expect(keyDown.key).toBe('Enter');

    expect(keyUp).toBeDefined();
    expect(keyUp.key).toBe('Enter');
  });

  it('should support modifiers (Ctrl, Shift, Alt, Meta)', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML'
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [] };
      }

      if (method === 'Input.dispatchKeyEvent') {
        // Ctrl=2, Shift=8, Alt=1, Meta=4
        // Ctrl+Shift = 2 | 8 = 10
        expect(params.modifiers).toBe(10);
        return {};
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    await domService.keypress('S', ['Ctrl', 'Shift']);
  });

  it('should invalidate snapshot after keypress', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML'
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [] };
      }

      if (method === 'Input.dispatchKeyEvent') return {};

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot1 = domService.getCurrentSnapshot();
    expect(snapshot1).not.toBeNull();

    const result = await domService.keypress('Escape');

    expect(result.success).toBe(true);
    expect(result.actionType).toBe('keypress');

    // Verify invalidation
    expect(domService.getCurrentSnapshot()).toBeNull();
  });
});

describe('Action Reliability: Scroll', () => {
  let mockTabId: number;
  let mockChrome: any;

  beforeEach(() => {
    mockTabId = 400;

    mockChrome = {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn(),
        onEvent: {
          addListener: vi.fn()
        },
        onDetach: {
          addListener: vi.fn()
        }
      },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: mockTabId,
          url: 'https://example.com',
          title: 'Test',
          width: 1920,
          height: 1080
        }),
        sendMessage: vi.fn()
      }
    };

    // @ts-ignore
    global.chrome = mockChrome;
  });

  afterEach(async () => {
    const instances = (DomService as any).instances;
    for (const [tabId, service] of instances.entries()) {
      await service.detach().catch(() => {});
    }
    instances.clear();
    vi.clearAllMocks();
  });

  it('should scroll page down', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML'
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [] };
      }

      if (method === 'Input.dispatchMouseEvent') {
        expect(params.type).toBe('mouseWheel');
        expect(params.deltaY).toBe(500); // down
        return {};
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const result = await domService.scroll('window', 'down');

    expect(result.success).toBe(true);
    expect(result.actionType).toBe('scroll');
  });

  it('should scroll page up', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML'
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [] };
      }

      if (method === 'Input.dispatchMouseEvent') {
        expect(params.type).toBe('mouseWheel');
        expect(params.deltaY).toBe(-500); // up
        return {};
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const result = await domService.scroll('window', 'up');

    expect(result.success).toBe(true);
  });

  it('should invalidate snapshot after scroll', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML'
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [] };
      }

      if (method === 'Input.dispatchMouseEvent') return {};

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot1 = domService.getCurrentSnapshot();
    expect(snapshot1).not.toBeNull();

    await domService.scroll('window', 'down');

    // Verify invalidation
    expect(domService.getCurrentSnapshot()).toBeNull();
  });
});
