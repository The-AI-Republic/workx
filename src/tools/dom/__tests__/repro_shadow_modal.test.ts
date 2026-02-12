import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NODE_TYPE_ELEMENT, NODE_TYPE_DOCUMENT_FRAGMENT } from '../types';
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

describe('Reproduction: Shadow DOM Modal Visibility', () => {
    let mockTabId: number;
    let mockChrome: any;

    beforeEach(() => {
        mockTabId = 789;

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
                    url: 'https://linkedin.example.com',
                    title: 'LinkedIn Test',
                    width: 1920,
                    height: 1080
                }),
                sendMessage: vi.fn().mockResolvedValue({})
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

    it('should capture visible modal inside invisible shadow host', async () => {
        // Setup:
        // 1. Shadow Host (invisible, 0x0)
        // 2. Shadow Root
        // 3. Modal (visible, 500x500)

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
                                        // Shadow Host (Invisible)
                                        nodeId: 3,
                                        backendNodeId: 3,
                                        nodeType: NODE_TYPE_ELEMENT,
                                        nodeName: 'APP-SHELL',
                                        localName: 'app-shell',
                                        shadowRoots: [
                                            {
                                                nodeId: 4,
                                                backendNodeId: 4,
                                                nodeType: NODE_TYPE_DOCUMENT_FRAGMENT,
                                                nodeName: '#document-fragment',
                                                shadowRootType: 'open',
                                                children: [
                                                    {
                                                        // Modal (Visible)
                                                        nodeId: 5,
                                                        backendNodeId: 5,
                                                        nodeType: NODE_TYPE_ELEMENT,
                                                        nodeName: 'DIV',
                                                        localName: 'div',
                                                        attributes: ['class', 'modal'],
                                                        children: [
                                                            {
                                                                nodeId: 6,
                                                                backendNodeId: 6,
                                                                nodeType: NODE_TYPE_ELEMENT,
                                                                nodeName: 'BUTTON',
                                                                localName: 'button',
                                                                attributes: ['id', 'close-modal']
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
                            name: { value: 'Close' }
                        }
                    ]
                };
            }

            if (method === 'DOMSnapshot.captureSnapshot') {
                return {
                    documents: [
                        {
                            documentURL: 'https://linkedin.example.com',
                            nodes: {
                                backendNodeId: [1, 2, 3, 4, 5, 6]
                            },
                            layout: {
                                nodeIndex: [0, 1, 2, 3, 4, 5], // Map all nodes
                                // Bounds: [x, y, width, height]
                                bounds: [
                                    [0, 0, 1920, 1080], // HTML
                                    [0, 0, 1920, 1080], // BODY
                                    [0, 0, 0, 0],       // APP-SHELL (Shadow Host) - INVISIBLE
                                    [0, 0, 0, 0],       // Shadow Root - No layout usually
                                    [100, 100, 500, 500], // Modal - VISIBLE
                                    [150, 150, 100, 50]   // Button - VISIBLE
                                ],
                                styles: []
                            }
                        }
                    ],
                    strings: []
                };
            }

            if (method === 'Runtime.evaluate') {
                if (params.expression.includes('window.innerWidth')) {
                    return {
                        result: {
                            value: {
                                width: 1920,
                                height: 1080,
                                scrollX: 0,
                                scrollY: 0,
                                devicePixelRatio: 1
                            }
                        }
                    };
                }
                return { result: { value: 'complete' } };
            }

            return {};
        });

        const domService = await DomService.forTab(mockTabId);
        const snapshot = await domService.buildSnapshot();
        const serialized = snapshot.serialize();

        // Check if Shadow Host is present (it might be filtered out if not semantic/interactive, but it has shadow root)
        // Check if Modal is present
        const nodes = flattenNodes(serialized.page.body);

        const shadowHost = nodes.find(n => n.tag === 'app-shell');
        const modal = nodes.find(n => n.tag === 'div' && n.bbox && n.bbox[2] === 500);
        const button = nodes.find(n => n.tag === 'button');

        console.log('Shadow Host found:', !!shadowHost);
        console.log('Modal found:', !!modal);
        console.log('Button found:', !!button);

        // The shadow host might be filtered out if it's not visible, BUT its children (shadow root -> modal) are visible.
        // If filterByViewport works correctly, it should keep the shadow host because it has visible content in shadow root.

        expect(modal).toBeDefined();
        expect(button).toBeDefined();
    });
});
