import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT, NODE_TYPE_DOCUMENT, NODE_TYPE_DOCUMENT_FRAGMENT } from '../types';
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
 * Integration Test: Combined Shadow DOM and Iframe Support (User Story 3)
 *
 * Goal: Verify CDP can handle pages with both shadow DOM and iframe elements
 *
 * Setup:
 * - Main page with both shadow DOM and iframe elements
 * - Shadow DOM inside iframes
 * - Iframes inside shadow DOM
 *
 * Expected behavior:
 * - Both boundary types should be captured correctly
 * - Elements should be accessible and actionable
 * - Depth limits should be respected
 */

describe('Integration: Combined Shadow DOM and Iframe', () => {
  let mockTabId: number;
  let mockChrome: any;

  beforeEach(() => {
    mockTabId = 999;

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
          url: 'https://combined-test.example.com',
          title: 'Combined Test Page',
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

  it('should capture both shadow DOM and iframe on same page', async () => {
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
                nodeName: 'BODY',
                children: [
                  // Shadow DOM component
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'MY-COMPONENT',
                    localName: 'my-component',
                    shadowRoots: [
                      {
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                        nodeName: '#document-fragment',
                        shadowRootType: 'open',
                        children: [
                          {
                            nodeId: 5,
                            backendNodeId: 5,
                            nodeType: NODE_TYPE_ELEMENT,
                            nodeName: 'BUTTON',
                            localName: 'button',
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
                  },
                  // Iframe element
                  {
                    nodeId: 7,
                    backendNodeId: 7,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'IFRAME',
                    localName: 'iframe',
                    contentDocument: {
                      nodeId: 8,
                      backendNodeId: 8,
                      nodeType: NODE_TYPE_DOCUMENT,
                      nodeName: '#document',
                      children: [
                        {
                          nodeId: 9,
                          backendNodeId: 9,
                          nodeType: NODE_TYPE_ELEMENT,
                          nodeName: 'HTML',
                          children: [
                            {
                              nodeId: 10,
                              backendNodeId: 10,
                              nodeType: NODE_TYPE_ELEMENT,
                              nodeName: 'BODY',
                              children: [
                                {
                                  nodeId: 11,
                                  backendNodeId: 11,
                                  nodeType: NODE_TYPE_ELEMENT,
                                  nodeName: 'INPUT',
                                  localName: 'input',
                                  attributes: ['type', 'text']
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
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
            },
            {
              backendDOMNodeId: 11,
              role: { value: 'textbox' },
              name: { value: 'Iframe Input' }
            }
          ]
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    const stats = snapshot.getStats();
    expect(stats.totalNodes).toBe(11); // All nodes
    expect(stats.shadowRootCount).toBe(1); // One shadow root
    expect(stats.interactiveNodes).toBe(2); // Button + input

    const serialized = snapshot.serialize();
    const nodes = flattenNodes(serialized.page.body);

    // Shadow button should be present
    const shadowButton = nodes.find(n => n.aria_label === 'Shadow Button');
    expect(shadowButton).toBeDefined();
    expect(shadowButton?.tag).toBe('button');

    // Iframe input should be present
    const iframeInput = nodes.find(n => n.aria_label === 'Iframe Input');
    expect(iframeInput).toBeDefined();
    expect(iframeInput?.tag).toBe('input');
  });

  it('should capture shadow DOM inside iframe', async () => {
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
                nodeName: 'BODY',
                children: [
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'IFRAME',
                    localName: 'iframe',
                    contentDocument: {
                      nodeId: 4,
                      backendNodeId: 4,
                      nodeType: NODE_TYPE_DOCUMENT,
                      nodeName: '#document',
                      children: [
                        {
                          nodeId: 5,
                          backendNodeId: 5,
                          nodeType: NODE_TYPE_ELEMENT,
                          nodeName: 'HTML',
                          children: [
                            {
                              nodeId: 6,
                              backendNodeId: 6,
                              nodeType: NODE_TYPE_ELEMENT,
                              nodeName: 'BODY',
                              children: [
                                // Shadow DOM component inside iframe
                                {
                                  nodeId: 7,
                                  backendNodeId: 7,
                                  nodeType: NODE_TYPE_ELEMENT,
                                  nodeName: 'NESTED-COMPONENT',
                                  localName: 'nested-component',
                                  shadowRoots: [
                                    {
                                      nodeId: 8,
                                      backendNodeId: 8,
                                      nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                                      nodeName: '#document-fragment',
                                      shadowRootType: 'open',
                                      children: [
                                        {
                                          nodeId: 9,
                                          backendNodeId: 9,
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
                          ]
                        }
                      ]
                    }
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
              backendDOMNodeId: 9,
              role: { value: 'button' },
              name: { value: 'Nested Shadow Button' }
            }
          ]
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    const stats = snapshot.getStats();
    expect(stats.shadowRootCount).toBe(1); // One shadow root inside iframe
    expect(stats.interactiveNodes).toBe(1);

    const serialized = snapshot.serialize();
    const nodes = flattenNodes(serialized.page.body);

    // Button inside shadow DOM inside iframe should be present
    const nestedButton = nodes.find(n => n.aria_label === 'Nested Shadow Button');
    expect(nestedButton).toBeDefined();
    expect(nestedButton?.tag).toBe('button');
  });

  it('should handle iframe inside shadow DOM', async () => {
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
                nodeName: 'BODY',
                children: [
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'WIDGET-COMPONENT',
                    localName: 'widget-component',
                    shadowRoots: [
                      {
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                        nodeName: '#document-fragment',
                        shadowRootType: 'open',
                        children: [
                          // Iframe inside shadow DOM
                          {
                            nodeId: 5,
                            backendNodeId: 5,
                            nodeType: NODE_TYPE_ELEMENT,
                            nodeName: 'IFRAME',
                            localName: 'iframe',
                            contentDocument: {
                              nodeId: 6,
                              backendNodeId: 6,
                              nodeType: NODE_TYPE_DOCUMENT,
                              nodeName: '#document',
                              children: [
                                {
                                  nodeId: 7,
                                  backendNodeId: 7,
                                  nodeType: NODE_TYPE_ELEMENT,
                                  nodeName: 'HTML',
                                  children: [
                                    {
                                      nodeId: 8,
                                      backendNodeId: 8,
                                      nodeType: NODE_TYPE_ELEMENT,
                                      nodeName: 'BODY',
                                      children: [
                                        {
                                          nodeId: 9,
                                          backendNodeId: 9,
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
              backendDOMNodeId: 9,
              role: { value: 'textbox' },
              name: { value: 'Email in Iframe' }
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

    // Input inside iframe inside shadow DOM should be present
    const nestedInput = nodes.find(n => n.aria_label === 'Email in Iframe');
    expect(nestedInput).toBeDefined();
    expect(nestedInput?.tag).toBe('input');
  });

  it('should silently skip nested iframes beyond depth 1', async () => {
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
                nodeName: 'BODY',
                children: [
                  // First level iframe
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'IFRAME',
                    localName: 'iframe',
                    contentDocument: {
                      nodeId: 4,
                      backendNodeId: 4,
                      nodeType: NODE_TYPE_DOCUMENT,
                      nodeName: '#document',
                      children: [
                        {
                          nodeId: 5,
                          backendNodeId: 5,
                          nodeType: NODE_TYPE_ELEMENT,
                          nodeName: 'HTML',
                          children: [
                            {
                              nodeId: 6,
                              backendNodeId: 6,
                              nodeType: NODE_TYPE_ELEMENT,
                              nodeName: 'BODY',
                              children: [
                                // First level button (should be captured)
                                {
                                  nodeId: 7,
                                  backendNodeId: 7,
                                  nodeType: NODE_TYPE_ELEMENT,
                                  nodeName: 'BUTTON',
                                  localName: 'button'
                                },
                                // Nested iframe (layer 2 - should still be captured with pierce:true)
                                {
                                  nodeId: 8,
                                  backendNodeId: 8,
                                  nodeType: NODE_TYPE_ELEMENT,
                                  nodeName: 'IFRAME',
                                  localName: 'iframe',
                                  contentDocument: {
                                    nodeId: 9,
                                    backendNodeId: 9,
                                    nodeType: NODE_TYPE_DOCUMENT,
                                    nodeName: '#document',
                                    children: [
                                      {
                                        nodeId: 10,
                                        backendNodeId: 10,
                                        nodeType: NODE_TYPE_ELEMENT,
                                        nodeName: 'HTML',
                                        children: [
                                          {
                                            nodeId: 11,
                                            backendNodeId: 11,
                                            nodeType: NODE_TYPE_ELEMENT,
                                            nodeName: 'BODY',
                                            children: [
                                              // Nested button (layer 2)
                                              {
                                                nodeId: 12,
                                                backendNodeId: 12,
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
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
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
              backendDOMNodeId: 7,
              role: { value: 'button' },
              name: { value: 'First Level Button' }
            },
            {
              backendDOMNodeId: 12,
              role: { value: 'button' },
              name: { value: 'Nested Level Button' }
            }
          ]
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    const snapshot = await domService.buildSnapshot();

    // Nested iframes beyond depth 1 are skipped:
    // Main frame: HTML(1), BODY(2), IFRAME(3) = 3 nodes
    // First iframe: #document(4), HTML(5), BODY(6), BUTTON(7), IFRAME(8) = 5 nodes
    // Nested iframe (depth 2) is skipped entirely
    const stats = snapshot.getStats();
    expect(stats.totalNodes).toBe(8);
    expect(stats.interactiveNodes).toBe(1); // Only button in first iframe

    const serialized = snapshot.serialize();
    const nodes = flattenNodes(serialized.page.body);

    // First level button should be present
    const firstButton = nodes.find(n => n.aria_label === 'First Level Button');
    expect(firstButton).toBeDefined();

    // Nested button in depth-2 iframe is skipped (iframeDepth > 1)
    const nestedButton = nodes.find(n => n.aria_label === 'Nested Level Button');
    expect(nestedButton).toBeUndefined();
  });

  it('should handle CDP failures gracefully for shadow/iframe data', async () => {
    let callCount = 0;

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string, params: any) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        callCount++;
        // First call returns normal data without shadow/iframe content
        // (simulating CDP not returning expected data)
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
                    // Element that should have shadow root but CDP doesn't return it
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'MY-COMPONENT',
                    localName: 'my-component'
                    // No shadowRoots - CDP failed to pierce
                  },
                  {
                    // Iframe with no contentDocument
                    nodeId: 4,
                    backendNodeId: 4,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'IFRAME',
                    localName: 'iframe'
                    // No contentDocument - cross-origin blocked
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

    // Should not throw
    const snapshot = await domService.buildSnapshot();

    const stats = snapshot.getStats();
    expect(stats.totalNodes).toBe(4); // Only main page nodes
    expect(stats.shadowRootCount).toBe(0); // No shadow roots captured
    expect(stats.interactiveNodes).toBe(0); // No interactive elements

    // Serialization should work
    const serialized = snapshot.serialize();
    expect(serialized.page.body).toBeDefined();
  });

  it('should click element in combined scenario', async () => {
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
                nodeName: 'BODY',
                children: [
                  // Shadow DOM with button
                  {
                    nodeId: 3,
                    backendNodeId: 3,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'MY-COMPONENT',
                    shadowRoots: [
                      {
                        nodeId: 4,
                        backendNodeId: 4,
                        nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                        nodeName: '#document-fragment',
                        shadowRootType: 'open',
                        children: [
                          {
                            nodeId: 5,
                            backendNodeId: 600, // Target button
                            nodeType: NODE_TYPE_ELEMENT,
                            nodeName: 'BUTTON',
                            localName: 'button'
                          }
                        ]
                      }
                    ]
                  },
                  // Iframe with input
                  {
                    nodeId: 6,
                    backendNodeId: 6,
                    nodeType: NODE_TYPE_ELEMENT,
                    nodeName: 'IFRAME',
                    localName: 'iframe',
                    contentDocument: {
                      nodeId: 7,
                      backendNodeId: 7,
                      nodeType: NODE_TYPE_DOCUMENT,
                      nodeName: '#document',
                      children: [
                        {
                          nodeId: 8,
                          backendNodeId: 8,
                          nodeType: NODE_TYPE_ELEMENT,
                          nodeName: 'HTML',
                          children: [
                            {
                              nodeId: 9,
                              backendNodeId: 9,
                              nodeType: NODE_TYPE_ELEMENT,
                              nodeName: 'BODY',
                              children: [
                                {
                                  nodeId: 10,
                                  backendNodeId: 700, // Target input
                                  nodeType: NODE_TYPE_ELEMENT,
                                  nodeName: 'INPUT',
                                  localName: 'input'
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
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
              backendDOMNodeId: 600,
              role: { value: 'button' },
              name: { value: 'Combined Shadow Button' }
            },
            {
              backendDOMNodeId: 700,
              role: { value: 'textbox' },
              name: { value: 'Combined Iframe Input' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        return {
          model: {
            content: [100, 100, 150, 100, 150, 130, 100, 130]
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

    // Click shadow button
    const shadowResult = await domService.click(600);
    expect(shadowResult.success).toBe(true);

    // Build new snapshot for iframe click
    await domService.buildSnapshot();

    // Click iframe input (focus)
    const iframeResult = await domService.click(700);
    expect(iframeResult.success).toBe(true);
  });
});
