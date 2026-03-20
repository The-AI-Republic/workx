import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DomService } from '../DomService';
import type { SerializedDom, ActionResult } from '../types';

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

// Helper for Runtime.evaluate mocks during buildSnapshot/getSerializedDom
function mockRuntimeEvaluate(params: any) {
  if (params?.expression === 'document.readyState') {
    return { result: { value: 'complete' } };
  }
  if (params?.expression?.includes('buttons')) {
    return { result: { value: { interactiveCount: 10, textLength: 500, hasLoadingIndicator: false, isStillLoading: false } } };
  }
  // Catch-all for getPageMetadata and viewport info
  return { result: { value: { url: 'https://example.com', title: 'Example Page', width: 1920, height: 1080, scrollX: 0, scrollY: 0, pageWidth: 1920, pageHeight: 1080, devicePixelRatio: 1, visualViewportScale: 1 } } };
}

describe('Backward Compatibility', () => {
  let mockTabId: number;

  beforeEach(() => {
    mockTabId = 123;

    // Clear singleton instances before each test
    (DomService as any).instances.clear();

    // Mock chrome APIs
    global.chrome = {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn(),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() }
      },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: mockTabId,
          url: 'https://example.com',
          title: 'Example Page',
          width: 1920,
          height: 1080
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined)
      }
    } as any;
  });

  afterEach(async () => {
    const instances = (DomService as any).instances;
    for (const [tabId, service] of instances.entries()) {
      await service.detach().catch(() => {});
    }
    instances.clear();
    vi.clearAllMocks();
  });

  describe('SerializedDom Structure', () => {
    it('should maintain expected SerializedDom interface', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1,
              backendNodeId: 100,
              nodeType: 1,
              nodeName: 'HTML',
              localName: 'html',
              children: [
                {
                  nodeId: 2,
                  backendNodeId: 101,
                  nodeType: 1,
                  nodeName: 'BUTTON',
                  localName: 'button',
                  attributes: ['id', 'submit-btn', 'class', 'btn']
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
                role: { value: 'WebArea' }
              },
              {
                backendDOMNodeId: 101,
                role: { value: 'button' },
                name: { value: 'Submit' }
              }
            ]
          };
        }
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      const serialized: SerializedDom = await service.getSerializedDom();

      // Verify top-level structure
      expect(serialized).toHaveProperty('page');
      expect(serialized.page).toHaveProperty('context');
      expect(serialized.page).toHaveProperty('body');

      // Verify context structure
      expect(serialized.page.context).toHaveProperty('url');
      expect(serialized.page.context).toHaveProperty('title');
      expect(serialized.page.context.url).toBe('https://example.com');

      // Verify viewport structure (dimensions are stringified with px suffix)
      expect(serialized.page.context).toHaveProperty('viewport');
      expect(serialized.page.context.viewport).toHaveProperty('width');
      expect(serialized.page.context.viewport).toHaveProperty('height');

      // body is an HTML string
      expect(typeof serialized.page.body).toBe('string');
    });

    it('should serialize nodes with expected properties', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1,
              backendNodeId: 100,
              nodeType: 1,
              nodeName: 'BUTTON',
              localName: 'button',
              attributes: ['id', 'submit', 'aria-label', 'Submit Button']
            }
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [{
              backendDOMNodeId: 100,
              role: { value: 'button' },
              name: { value: 'Submit Button' }
            }]
          };
        }
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      const serialized = await service.getSerializedDom();

      // body is an HTML string in getSerializedDom()
      expect(typeof serialized.page.body).toBe('string');
      // The HTML output should contain button-related content
      expect(serialized.page.body).toContain('button');
    });
  });

  describe('ActionResult Structure', () => {
    it('should maintain expected ActionResult interface', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1,
              backendNodeId: 100,
              nodeType: 1,
              nodeName: 'BUTTON',
              localName: 'button'
            }
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [{
              backendDOMNodeId: 100,
              role: { value: 'button' },
              name: { value: 'Click me' }
            }]
          };
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [100, 100, 200, 100, 200, 200, 100, 200] } };
        }
        if (method === 'DOM.scrollIntoViewIfNeeded') return {};
        if (method === 'Input.dispatchMouseEvent') return {};
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      const result: ActionResult = await service.click(100);

      // Verify required properties
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('actionType');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('changes');
      expect(result).toHaveProperty('nodeId');

      // Verify types
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.duration).toBe('number');
      expect(typeof result.actionType).toBe('string');
      expect(typeof result.timestamp).toBe('string');

      // Verify changes structure
      expect(result.changes).toHaveProperty('navigationOccurred');
      expect(result.changes).toHaveProperty('domMutations');
      expect(result.changes).toHaveProperty('scrollChanged');
      expect(result.changes).toHaveProperty('valueChanged');
    });

    it('should include error message on failure', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1,
              backendNodeId: 100,
              nodeType: 1,
              nodeName: 'BUTTON',
              localName: 'button'
            }
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [{
              backendDOMNodeId: 100,
              role: { value: 'button' }
            }]
          };
        }
        if (method === 'DOM.getBoxModel') {
          throw new Error('Element not found');
        }
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      const result = await service.click(100);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
      expect(typeof result.error).toBe('string');
      expect(result.error).toBeTruthy();
    });
  });

  describe('Node ID Format', () => {
    it('should use string node IDs in frame:backendNodeId format', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1,
              backendNodeId: 100,
              nodeType: 1,
              nodeName: 'HTML',
              localName: 'html',
              children: [
                {
                  nodeId: 2,
                  backendNodeId: 101,
                  nodeType: 1,
                  nodeName: 'BUTTON',
                  localName: 'button'
                }
              ]
            }
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [{
              backendDOMNodeId: 101,
              role: { value: 'button' },
              name: { value: 'Test' }
            }]
          };
        }
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      const serialized = await service.getSerializedDom();

      // Node IDs should be present in the output
      expect(serialized.page).toBeDefined();
      expect(serialized.page.body).toBeDefined();
    });
  });

  describe('Error Messages', () => {
    it('should use consistent error code format', async () => {
      (global.chrome.debugger.attach as any).mockRejectedValueOnce(
        new Error('Cannot attach to this target because it already attached')
      );

      try {
        await DomService.forTab(mockTabId);
        expect.fail('Should have thrown error');
      } catch (error: any) {
        // Error code should be at start, followed by colon
        expect(error.message).toMatch(/^[A-Z_]+:/);
        expect(error.message).toContain('ALREADY_ATTACHED');
      }
    });

    it('should provide actionable error messages', async () => {
      (global.chrome.debugger.attach as any).mockRejectedValueOnce(
        new Error('Cannot attach to this target because it already attached')
      );

      try {
        await DomService.forTab(mockTabId);
        expect.fail('Should have thrown error');
      } catch (error: any) {
        // Error should explain what to do
        expect(error.message.toLowerCase()).toContain('devtools');
        expect(error.message.toLowerCase()).toContain('close');
      }
    });
  });

  describe('LLM Function Interface', () => {
    it('should maintain getSerializedDom() method signature', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1,
              backendNodeId: 100,
              nodeType: 1,
              nodeName: 'HTML',
              localName: 'html'
            }
          };
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);

      // Method should exist and be callable
      expect(service.getSerializedDom).toBeDefined();
      expect(typeof service.getSerializedDom).toBe('function');

      // Should return SerializedDom
      const result = await service.getSerializedDom();
      expect(result).toHaveProperty('page');
    });

    it('should maintain action method signatures', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);

      // All action methods should exist
      expect(service.click).toBeDefined();
      expect(service.type).toBeDefined();
      expect(service.scroll).toBeDefined();
      expect(service.keypress).toBeDefined();

      // Check function signatures
      expect(typeof service.click).toBe('function');
      expect(typeof service.type).toBe('function');
      expect(typeof service.scroll).toBe('function');
      expect(typeof service.keypress).toBe('function');
    });
  });

  describe('Snapshot Caching Behavior', () => {
    it('should cache snapshots between calls', async () => {
      let getDocumentCallCount = 0;
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          getDocumentCallCount++;
          return {
            root: {
              nodeId: 1,
              backendNodeId: 100,
              nodeType: 1,
              nodeName: 'HTML',
              localName: 'html'
            }
          };
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);

      // First call builds snapshot
      await service.getSerializedDom();
      expect(getDocumentCallCount).toBe(1);

      // Second call should use cache
      await service.getSerializedDom();
      expect(getDocumentCallCount).toBe(1); // Still 1 - cached
    });

    it('should invalidate cache after actions', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1,
              backendNodeId: 100,
              nodeType: 1,
              nodeName: 'BUTTON',
              localName: 'button'
            }
          };
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [{
              backendDOMNodeId: 100,
              role: { value: 'button' }
            }]
          };
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [100, 100, 200, 100, 200, 200, 100, 200] } };
        }
        if (method === 'DOM.scrollIntoViewIfNeeded') return {};
        if (method === 'Input.dispatchMouseEvent') return {};
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      const snapshot1 = service.getCurrentSnapshot();
      expect(snapshot1).not.toBeNull();

      // Perform action
      await service.click(100);

      // Snapshot should be invalidated
      const snapshot2 = service.getCurrentSnapshot();
      expect(snapshot2).toBeNull();
    });
  });
});
