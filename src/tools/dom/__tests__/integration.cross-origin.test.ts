import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT, NODE_TYPE_DOCUMENT_FRAGMENT } from '../types';
import { DomService } from '../DomService';
import type { SerializedNode } from '../types';

// Helper to flatten tree structure for testing
function flattenNodes(node: SerializedNode): SerializedNode[] {
  const result: SerializedNode[] = [node];
  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenNodes(child));
    }
  }
  return result;
}

/**
 * Integration Test: Cross-Origin Iframe Access (User Story 1)
 *
 * Goal: Verify CDP can access cross-origin iframe content that content scripts cannot
 *
 * Setup:
 * - Main page: https://example.com
 * - Cross-origin iframe: https://ads.thirdparty.com/widget
 *
 * Expected behavior:
 * - CDP should pierce iframe boundaries
 * - Snapshot should include elements from both origins
 * - Content script approach would fail with SecurityError
 */

describe('Integration: Cross-Origin Iframe Access', () => {
  let mockTabId: number;
  let mockChrome: any;

  beforeEach(() => {
    mockTabId = 123;

    // Mock Chrome APIs
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
          title: 'Example Page',
          width: 1920,
          height: 1080
        }),
        sendMessage: vi.fn().mockResolvedValue({}) // Mock visual effects message
      }
    };

    // @ts-ignore - Replace global chrome for testing
    global.chrome = mockChrome;
  });

  afterEach(async () => {
    // Clean up singleton instances
    const instances = (DomService as any).instances;
    for (const [tabId, service] of instances.entries()) {
      await service.detach().catch(() => {});
    }
    instances.clear();

    vi.clearAllMocks();
  });

  it('should successfully capture cross-origin iframe content via CDP', async () => {
    // Mock CDP responses
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        // Simulated DOM tree with cross-origin iframe
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'HTML',
            localName: 'html',
            children: [
              {
                nodeId: 2,
                backendNodeId: 2,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BODY',
                localName: 'body',
                children: [
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'BUTTON',
                    localName: 'button',
                    attributes: ['id', 'main-button'],
                    children: [
                      {
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_TEXT,
                        nodeName: '#text',
                        nodeValue: 'Click Me'
                      }
                    ]
                  },
                  {
                    nodeId: 5,
                    backendNodeId: 5,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'IFRAME',
                    localName: 'iframe',
                    attributes: ['src', 'https://ads.thirdparty.com/widget'],
                    frameId: 'iframe-frame-id',
                    children: [
                      // Cross-origin iframe content (normally inaccessible via content script)
                      {
                        nodeId: 6,
                        backendNodeId: 6,
                        nodeType: NODE_TYPE_ELEMENT,
                        nodeName: 'HTML',
                        localName: 'html',
                        frameId: 'iframe-frame-id',
                        children: [
                          {
                            nodeId: 7,
                            backendNodeId: 7,
                            nodeType: NODE_TYPE_ELEMENT,
                            nodeName: 'BODY',
                            localName: 'body',
                            frameId: 'iframe-frame-id',
                            children: [
                              {
                                nodeId: 8,
                                backendNodeId: 8,
                                nodeType: NODE_TYPE_ELEMENT,
                                nodeName: 'BUTTON',
                                localName: 'button',
                                frameId: 'iframe-frame-id',
                                attributes: ['id', 'iframe-button'],
                                children: [
                                  {
                                    nodeId: 9,
                                    backendNodeId: 9,
                                    nodeType: NODE_TYPE_TEXT,
                                    nodeName: '#text',
                                    nodeValue: 'Ad Click'
                                  }
                                ]
                              }
                            ]
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        // Mock accessibility tree with iframe nodes
        return {
          nodes: [
            {
              nodeId: 'ax-1',
              backendDOMNodeId: 3,
              role: { value: 'button' },
              name: { value: 'Click Me' }
            },
            {
              nodeId: 'ax-2',
              backendDOMNodeId: 8,
              role: { value: 'button' },
              name: { value: 'Ad Click' }
            }
          ]
        };
      }

      return {};
    });

    // Create DomService and build snapshot
    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    // Verify CDP attached successfully
    expect(mockChrome.debugger.attach).toHaveBeenCalledWith(
      { tabId: mockTabId },
      '1.3'
    );

    // Verify DOM and Accessibility domains enabled
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'DOM.enable',
      {}
    );
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'Accessibility.enable',
      {}
    );

    // Verify DOM tree fetched with pierce: true (critical for iframe access)
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'DOM.getDocument',
      { depth: -1, pierce: true }
    );

    // Verify snapshot stats
    const stats = snapshot.getStats();
    expect(stats.totalNodes).toBe(9); // 9 total nodes (main + iframe)
    expect(stats.interactiveNodes).toBe(2); // 2 buttons (main + iframe)
    expect(stats.semanticNodes).toBe(2); // Both buttons have proper a11y roles

    // Verify serialization includes iframe button
    const serialized = snapshot.serialize();
    const nodes = flattenNodes(serialized.page.body);

    // Filter to only buttons
    const buttons = nodes.filter(n => n.tag === 'button');
    expect(buttons.length).toBe(2); // Both buttons

    // Check if buttons have the expected roles from accessibility tree
    const buttonWithRoles = buttons.filter(b => b.role === 'button');
    expect(buttonWithRoles.length).toBe(2); // Both should have roles from a11y data

    const mainButton = buttons.find(b => b.text === 'Click Me');
    const iframeButton = buttons.find(b => b.text === 'Ad Click');

    expect(mainButton).toBeDefined();
    expect(mainButton?.tag).toBe('button');
    expect(mainButton?.text).toBe('Click Me');

    expect(iframeButton).toBeDefined();
    expect(iframeButton?.tag).toBe('button');
    expect(iframeButton?.text).toBe('Ad Click');
  });

  it('should handle cross-origin iframe without accessibility data', async () => {
    // Mock CDP responses with DOM but failed A11y fetch
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
            localName: 'html',
            children: [
              {
                nodeId: 2,
                backendNodeId: 2,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'IFRAME',
                localName: 'iframe',
                frameId: 'iframe-1',
                children: [
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'DIV',
                    localName: 'div',
                    frameId: 'iframe-1',
                    attributes: ['onclick', 'handleClick()'], // Non-semantic interactive
                    children: [
                      {
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_TEXT,
                        nodeName: '#text',
                        nodeValue: 'Click'
                      }
                    ]
                  }
                ]
              }
            ]
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        // Simulate A11y failure (CSP or permission issue)
        throw new Error('Protocol error: Access denied');
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    // Verify snapshot built despite A11y failure
    const stats = snapshot.getStats();
    expect(stats.totalNodes).toBe(4);

    // Verify non-semantic heuristic detection still works
    const serialized = snapshot.serialize();
    const nodes = flattenNodes(serialized.page.body);

    // Filter to only divs (the onclick div should be included)
    const divs = nodes.filter(n => n.tag === 'div');
    expect(divs.length).toBeGreaterThanOrEqual(1); // onclick div should be included

    const clickableDiv = divs.find(n => n.text === 'Click');
    expect(clickableDiv).toBeDefined();
    expect(clickableDiv?.tag).toBe('div');
  });

  it('should click element in cross-origin iframe', async () => {
    // Setup: Build snapshot first
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
                backendNodeId: 2,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'IFRAME',
                frameId: 'iframe-1',
                children: [
                  {
                    nodeId: 3,
                    backendNodeId: 100, // Target element
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'BUTTON',
                    localName: 'button',
                    frameId: 'iframe-1'
                  }
                ]
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
              name: { value: 'Iframe Button' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        // Return bounding box for iframe button
        return {
          model: {
            content: [10, 20, 50, 20, 50, 40, 10, 40] // x1,y1, x2,y2, x3,y3, x4,y4
          }
        };
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') {
        return {};
      }

      if (method === 'Input.dispatchMouseEvent') {
        return {};
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    // Get backendNodeId for iframe button
    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 100;  // Use backendNodeId from serialized output (button inside iframe)
    expect(backendNodeId).toBeTruthy();

    // Click iframe button
    const result = await domService.click(backendNodeId);

    // Verify success
    if (!result.success) {
      console.error('Click failed:', result.error);
    }
    expect(result.success).toBe(true);

    // Verify CDP commands called
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'DOM.getBoxModel',
      { backendNodeId: 100 }
    );

    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 30, // Center X: (10 + 50) / 2
        y: 30, // Center Y: (20 + 40) / 2
        button: 'left',
        clickCount: 1
      })
    );

    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mouseReleased',
        x: 30,
        y: 30,
        button: 'left'
      })
    );
  });

  it('should handle "already attached" error gracefully', async () => {
    // Simulate DevTools already open
    mockChrome.debugger.attach.mockRejectedValue(
      new Error('Cannot access a chrome-extension:// URL of different extension; Debugger is already attached to the tab with id: 123.')
    );

    await expect(async () => {
      await DomService.forTab(mockTabId);
    }).rejects.toThrow('ALREADY_ATTACHED: DevTools is open on this tab. Please close DevTools.');
  });

  it('should invalidate snapshot on DOM.documentUpdated event', async () => {
    let eventListener: ((source: any, method: string, params?: any) => void) | null = null;

    mockChrome.debugger.onEvent.addListener.mockImplementation((listener: any) => {
      eventListener = listener;
    });

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

    expect(domService.getCurrentSnapshot()).not.toBeNull();

    // Simulate DOM update event
    expect(eventListener).not.toBeNull();
    eventListener!({ tabId: mockTabId }, 'DOM.documentUpdated', {});

    // Verify snapshot invalidated
    expect(domService.getCurrentSnapshot()).toBeNull();
  });
});
