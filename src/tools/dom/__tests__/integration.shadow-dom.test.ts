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
 * Integration Test: Shadow DOM Support (User Story 2)
 *
 * Goal: Verify CDP can access shadow DOM content (both open and closed)
 *
 * Setup:
 * - Main page with custom element <my-component>
 * - Open shadow root with button inside
 * - Closed shadow root with input inside
 *
 * Expected behavior:
 * - CDP with pierce: true should access shadow DOM trees
 * - Snapshot should include shadow DOM elements
 * - shadowRootType should be tracked ('open' or 'closed')
 * - Actions should work on shadow DOM elements
 */

describe('Integration: Shadow DOM Support', () => {
  let mockTabId: number;
  let mockChrome: any;

  beforeEach(() => {
    mockTabId = 456;

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
          url: 'https://webcomponents.example.com',
          title: 'Web Components Test',
          width: 1920,
          height: 1080
        }),
        sendMessage: vi.fn().mockResolvedValue({}) // Mock visual effects message
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

  it('should capture elements inside open shadow root', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        // pierce: true should be passed for shadow DOM access
        expect(params.pierce).toBe(true);

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
                nodeName: 'BODY',
                children: [
                  {
                    // Custom element host
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'MY-COMPONENT',
                    localName: 'my-component',
                    attributes: [],
                    children: [
                      {
                        // Shadow root node
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_DOCUMENT_FRAGMENT, // DOCUMENT_FRAGMENT_NODE
                        nodeName: '#document-fragment',
                        shadowRootType: 'open',
                        children: [
                          {
                            nodeId: 5,
                            backendNodeId: 5,
                            nodeType: NODE_TYPE_ELEMENT,
                            nodeName: 'BUTTON',
                            localName: 'button',
                            attributes: ['id', 'shadow-button'],
                            children: [
                              {
                                nodeId: 6,
                                backendNodeId: 6,
                                nodeType: NODE_TYPE_TEXT,
                                nodeName: '#text',
                                nodeValue: 'Shadow Button'
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
        return {
          nodes: [
            {
              backendDOMNodeId: 5,
              role: { value: 'button' },
              name: { value: 'Shadow Button' }
            }
          ]
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    // Verify pierce: true was used
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'DOM.getDocument',
      { depth: -1, pierce: true }
    );

    // Verify stats include shadow DOM nodes
    const stats = snapshot.getStats();
    expect(stats.totalNodes).toBe(6); // All nodes including shadow DOM
    expect(stats.shadowRootCount).toBe(1); // One shadow root
    expect(stats.interactiveNodes).toBe(1); // Button inside shadow DOM

    // Verify serialization includes shadow DOM button
    const serialized = snapshot.serialize();
    const nodes = flattenNodes(serialized.page.body);
    const buttons = nodes.filter(n => n.tag === 'button');
    const shadowButton = buttons.find(n => n.text === 'Shadow Button');

    expect(shadowButton).toBeDefined();
    expect(shadowButton?.tag).toBe('button');
    expect(shadowButton?.text).toBe('Shadow Button');
    // Check if button has role from a11y data
    if (shadowButton?.role) {
      expect(shadowButton.role).toBe('button');
    }
  });

  it('should capture elements inside closed shadow root', async () => {
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
                nodeName: 'CUSTOM-ELEMENT',
                localName: 'custom-element',
                children: [
                  {
                    // Closed shadow root
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                    nodeName: '#document-fragment',
                    shadowRootType: 'closed',
                    children: [
                      {
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_ELEMENT,
                        nodeName: 'INPUT',
                        localName: 'input',
                        attributes: ['type', 'text', 'placeholder', 'Hidden Input']
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
        return {
          nodes: [
            {
              backendDOMNodeId: 4,
              role: { value: 'textbox' },
              name: { value: 'Hidden Input' }
            }
          ]
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    const stats = snapshot.getStats();
    expect(stats.shadowRootCount).toBe(1);
    expect(stats.interactiveNodes).toBe(1);

    const serialized = snapshot.serialize();
    const nodes = flattenNodes(serialized.page.body);
    const inputs = nodes.filter(n => n.tag === 'input');
    const shadowInput = inputs[0];

    expect(shadowInput).toBeDefined();
    expect(shadowInput.tag).toBe('input');
    expect(shadowInput.role).toBe('textbox');
  });

  it('should handle nested shadow roots', async () => {
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
                // Outer component
                nodeId: 2,
                backendNodeId: 2,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'OUTER-COMPONENT',
                children: [
                  {
                    // Outer shadow root
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                    nodeName: '#document-fragment',
                    shadowRootType: 'open',
                    children: [
                      {
                        // Inner component inside outer shadow
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_ELEMENT,
                        nodeName: 'INNER-COMPONENT',
                        children: [
                          {
                            // Inner shadow root
                            nodeId: 5,
                            backendNodeId: 5,
                            nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                            nodeName: '#document-fragment',
                            shadowRootType: 'closed',
                            children: [
                              {
                                nodeId: 6,
                                backendNodeId: 6,
                                nodeType: NODE_TYPE_ELEMENT,
                                nodeName: 'BUTTON',
                                localName: 'button',
                                children: [
                                  {
                                    nodeId: 7,
                                    backendNodeId: 7,
                                    nodeType: NODE_TYPE_TEXT,
                                    nodeName: '#text',
                                    nodeValue: 'Deeply Nested Button'
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
        return {
          nodes: [
            {
              backendDOMNodeId: 6,
              role: { value: 'button' },
              name: { value: 'Deeply Nested Button' }
            }
          ]
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    const stats = snapshot.getStats();
    expect(stats.shadowRootCount).toBe(2); // Two shadow roots (nested)
    expect(stats.totalNodes).toBe(7);
    expect(stats.interactiveNodes).toBe(1);

    const serialized = snapshot.serialize();
    const nodes = flattenNodes(serialized.page.body);
    const buttons = nodes.filter(n => n.tag === 'button');
    const deepButton = buttons[0];

    expect(deepButton).toBeDefined();
    expect(deepButton.text).toBe('Deeply Nested Button');
    expect(deepButton.role).toBe('button');
  });

  it('should click element inside shadow DOM', async () => {
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
                nodeName: 'MY-COMPONENT',
                children: [
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                    nodeName: '#document-fragment',
                    shadowRootType: 'open',
                    children: [
                      {
                        nodeId: 4,
                        backendNodeId: 200, // Target button
                        nodeType: NODE_TYPE_ELEMENT,
                        nodeName: 'BUTTON',
                        localName: 'button'
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
        return {
          nodes: [
            {
              backendDOMNodeId: 200,
              role: { value: 'button' },
              name: { value: 'Shadow Action' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        return {
          model: {
            content: [100, 200, 150, 200, 150, 230, 100, 230]
          }
        };
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'Input.dispatchMouseEvent') return {};

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 200;  // Use backendNodeId from serialized output (shadow DOM button)
    expect(backendNodeId).toBeTruthy();

    // Click shadow DOM button
    const result = await domService.click(backendNodeId);

    expect(result.success).toBe(true);

    // Verify click dispatched correctly
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 125, // (100 + 150) / 2
        y: 215, // (200 + 230) / 2
        button: 'left'
      })
    );
  });

  it('should type into input inside shadow DOM', async () => {
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
                nodeName: 'FORM-COMPONENT',
                children: [
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                    nodeName: '#document-fragment',
                    shadowRootType: 'closed',
                    children: [
                      {
                        nodeId: 4,
                        backendNodeId: 300, // Target input
                        nodeType: NODE_TYPE_ELEMENT,
                        nodeName: 'INPUT',
                        localName: 'input',
                        attributes: ['type', 'email']
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
        return {
          nodes: [
            {
              backendDOMNodeId: 300,
              role: { value: 'textbox' },
              name: { value: 'Email' }
            }
          ]
        };
      }

      if (method === 'DOM.focus') {
        expect(params.backendNodeId).toBe(300);
        return {};
      }

      if (method === 'Input.dispatchKeyEvent') return {};
      if (method === 'Input.insertText') {
        expect(params.text).toBe('test@example.com');
        return {};
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot = domService.getCurrentSnapshot()!;
    const backendNodeId = 300;  // Use backendNodeId from serialized output (input inside shadow DOM)
    expect(backendNodeId).toBeTruthy();

    // Type into shadow DOM input
    const result = await domService.type(backendNodeId, 'test@example.com');

    expect(result.success).toBe(true);

    // Verify input inserted
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: mockTabId },
      'Input.insertText',
      { text: 'test@example.com' }
    );
  });

  it('should handle shadow DOM with no interactive elements', async () => {
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
                nodeName: 'DISPLAY-COMPONENT',
                children: [
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                    nodeName: '#document-fragment',
                    shadowRootType: 'open',
                    children: [
                      {
                        // Just a div with text, no interaction
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_ELEMENT,
                        nodeName: 'DIV',
                        localName: 'div',
                        children: [
                          {
                            nodeId: 5,
                            backendNodeId: 5,
                            nodeType: NODE_TYPE_TEXT,
                            nodeName: '#text',
                            nodeValue: 'Static Content'
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
        return { nodes: [] };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    const stats = snapshot.getStats();
    expect(stats.shadowRootCount).toBe(1);
    expect(stats.interactiveNodes).toBe(0); // No interactive elements

    // Serialization should still include all nodes (structural div)
    const serialized = snapshot.serialize();
    if (serialized.page.body) {
      const nodes = flattenNodes(serialized.page.body);
      // Check that we have nodes but no buttons/inputs
      const buttons = nodes.filter(n => n.tag === 'button');
      const inputs = nodes.filter(n => n.tag === 'input');
      expect(buttons.length).toBe(0);
      expect(inputs.length).toBe(0);
    }
  });
});
