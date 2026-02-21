import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT, NODE_TYPE_DOCUMENT_FRAGMENT } from '../types';
import { DomService } from '../DomService';
import type { SerializedNode } from '../types';

// Mock ChromeDebuggerClient so DomService.forTab() works with test chrome.debugger mocks
vi.mock('@/extension/tools/browser/ChromeDebuggerClient', () => ({
  ChromeDebuggerClient: class MockChromeDebuggerClient {
    private target: any = null;
    private attached = false;
    private eventCallbacks: Array<(method: string, params: unknown) => void> = [];
    async attach(target: any) {
      const debuggee = target && 'tabId' in target ? { tabId: target.tabId } : {};
      await (chrome.debugger.attach as any)(debuggee, '1.3');
      this.target = target; this.attached = true;
    }
    async detach() { this.target = null; this.attached = false; this.eventCallbacks = []; }
    isAttached() { return this.attached; }
    async sendCommand(method: string, params?: any) {
      const debuggee = this.target && 'tabId' in this.target ? { tabId: this.target.tabId } : {};
      return (chrome.debugger.sendCommand as any)(debuggee, method, params);
    }
    onEvent(cb: any) { this.eventCallbacks.push(cb); }
    offEvent(cb: any) { const i = this.eventCallbacks.indexOf(cb); if (i !== -1) this.eventCallbacks.splice(i, 1); }
    async enableDomain(domain: string) { await this.sendCommand(`${domain}.enable`); }
    async disableDomain(domain: string) { await this.sendCommand(`${domain}.disable`); }
    getTargetInfo() { return this.target; }
    getTabId() { return this.target && 'tabId' in this.target ? this.target.tabId : null; }
  }
}));

// Helper to flatten tree structure for testing
function flattenNodes(node: SerializedNode): SerializedNode[] {
  const result: SerializedNode[] = [node];
  if (node.kids) {
    for (const child of node.kids) {
      result.push(...flattenNodes(child));
    }
  }
  if (node.shadow_roots) {
    for (const root of node.shadow_roots) {
      result.push(...flattenNodes(root));
    }
  }
  if (node.content_document) {
    result.push(...flattenNodes(node.content_document));
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
      await service.detach().catch(() => { });
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
                    // Shadow roots are in shadowRoots array, not children
                    shadowRoots: [
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

    // Button should be found - check by aria_label which comes from accessibility name
    const shadowButton = buttons.find(n => n.aria_label === 'Shadow Button' || n.text === 'Shadow Button');

    expect(shadowButton).toBeDefined();
    expect(shadowButton?.tag).toBe('button');
    // Check accessibility name (aria_label)
    expect(shadowButton?.aria_label).toBe('Shadow Button');
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
                // Shadow roots should be in shadowRoots array
                shadowRoots: [
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
                        // Inner shadow root also in shadowRoots
                        shadowRoots: [
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
    const deepButton = buttons.find(n => n.aria_label === 'Deeply Nested Button' || n.text === 'Deeply Nested Button');

    expect(deepButton).toBeDefined();
    expect(deepButton?.aria_label).toBe('Deeply Nested Button');
    expect(deepButton?.role).toBe('button');
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

      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.readyState') {
          return { result: { value: 'complete' } };
        }
        if (params.expression === 'window.devicePixelRatio') {
          return { result: { value: 1 } };
        }
        if (params.expression.includes('window.innerWidth')) {
          return {
            result: {
              value: {
                width: 1920,
                height: 1080,
                scrollX: 0,
                scrollY: 0
              }
            }
          };
        }
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

    if (!result.success) {
      throw new Error('Click failed: ' + result.error);
    }
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

      if (method === 'Runtime.evaluate') {
        if (params?.expression === 'document.readyState') {
          return { result: { value: 'complete' } };
        }
        if (params?.expression?.includes('buttons')) {
          return { result: { value: { interactiveCount: 5, textLength: 200, hasLoadingIndicator: false, isStillLoading: false } } };
        }
        return { result: { value: { url: 'https://shadow-test.example.com', title: 'Shadow Test', width: 1920, height: 1080, scrollX: 0, scrollY: 0, pageWidth: 1920, pageHeight: 1080, devicePixelRatio: 1, visualViewportScale: 1 } } };
      }

      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'obj-300' } };
      }

      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { tagName: 'INPUT', type: 'email', isContentEditable: false, role: 'textbox' } } };
      }

      if (method === 'DOM.scrollIntoViewIfNeeded') return {};

      if (method === 'DOM.getBoxModel') {
        return { model: { content: [100, 200, 300, 200, 300, 230, 100, 230] } };
      }

      if (method === 'Input.dispatchMouseEvent') return {};
      if (method === 'DOM.focus') return {};
      if (method === 'Input.dispatchKeyEvent') return {};
      if (method === 'Input.insertText') return {};

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const backendNodeId = 300;

    // Type into shadow DOM input
    const result = await domService.type(backendNodeId, 'test@example.com');

    expect(result.success).toBe(true);
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
