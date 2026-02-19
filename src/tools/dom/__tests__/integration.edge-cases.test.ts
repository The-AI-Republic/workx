import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DomService } from '../DomService';
import type { VirtualNode } from '../types';

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

// Helper for Runtime.evaluate mocks
function mockRuntimeEvaluate(params: any) {
  if (params?.expression === 'document.readyState') {
    return { result: { value: 'complete' } };
  }
  if (params?.expression?.includes('buttons')) {
    return { result: { value: { interactiveCount: 10, textLength: 500, hasLoadingIndicator: false, isStillLoading: false } } };
  }
  return { result: { value: { url: 'https://example.com', title: 'Example', width: 1920, height: 1080, scrollX: 0, scrollY: 0, pageWidth: 1920, pageHeight: 1080, devicePixelRatio: 1, visualViewportScale: 1 } } };
}

describe('DomService Edge Cases', () => {
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
          title: 'Example',
          width: 1920,
          height: 1080
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined)
      }
    } as any;
  });

  afterEach(async () => {
    try {
      const instances = (DomService as any).instances;
      for (const [tabId, service] of instances.entries()) {
        await service.detach().catch(() => {});
      }
      instances.clear();
    } catch (error) {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  describe('X-Frame-Options DENY Detection', () => {
    it('should detect and report X-Frame-Options DENY errors', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        if (method === 'DOM.getDocument') {
          throw new Error('Frame with origin "https://blocked.com" not found');
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        return {};
      });

      const service = await DomService.forTab(mockTabId);

      await expect(service.buildSnapshot()).rejects.toThrow();
    });
  });

  describe('Pathological Iframe Nesting', () => {
    it('should stop traversal at depth limit', async () => {
      // Create deeply nested iframe structure (101 levels)
      const createNestedIframes = (depth: number): any => {
        if (depth > 101) return null;

        return {
          nodeId: depth,
          backendNodeId: depth + 1000,
          nodeType: 1,
          nodeName: 'HTML',
          localName: 'html',
          children: depth < 101 ? [
            {
              nodeId: depth * 10,
              backendNodeId: depth * 10 + 1000,
              nodeType: 1,
              nodeName: 'IFRAME',
              localName: 'iframe',
              children: [createNestedIframes(depth + 1)]
            }
          ] : []
        };
      };

      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return { root: createNestedIframes(1) };
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      const snapshot = await service.buildSnapshot();

      // Should have built tree but stopped at depth limit
      expect(snapshot).toBeDefined();
      // Total nodes should be less than 101 * 2 (each level has html + iframe)
      expect(snapshot.getStats().totalNodes).toBeLessThan(200);
    });
  });

  describe('CDP Connection Loss', () => {
    it('should handle debugger detach gracefully', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);

      // Simulate debugger detach via onDetach listener
      const detachCalls = (global.chrome.debugger.onDetach.addListener as any).mock.calls;
      if (detachCalls.length > 0) {
        const detachHandler = detachCalls[0][0];
        detachHandler({ tabId: mockTabId }, 'target_closed');
      }

      // Service should fail on subsequent operations
      const result = await service.click(100);
      expect(result.success).toBe(false);
    });
  });

  describe('Element Visibility Verification', () => {
    it('should reject clicks on zero-size elements', async () => {
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
              name: { value: 'Test' }
            }]
          };
        }
        if (method === 'DOM.getBoxModel') {
          return {
            model: {
              content: [0, 0, 0, 0, 0, 0, 0, 0] // Zero width and height
            }
          };
        }
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      const result = await service.click(100);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ELEMENT_NOT_VISIBLE');
    });
  });

  describe('Debugger Conflict Detection', () => {
    it('should detect when DevTools is already attached', async () => {
      (global.chrome.debugger.attach as any).mockRejectedValue(
        new Error('Cannot attach to this target because it already attached')
      );

      try {
        await DomService.forTab(mockTabId);
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('ALREADY_ATTACHED');
        expect(error.message).toContain('DevTools is open');
      }
    });
  });

  describe('Snapshot Timeout', () => {
    it('should timeout on slow DOM fetches', async () => {
      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        if (method === 'DOM.getDocument') {
          return new Promise(resolve => setTimeout(resolve, 15000)); // Never resolves in time
        }
        return {};
      });

      const service = await DomService.forTab(mockTabId, { snapshotTimeout: 100 });

      await expect(service.buildSnapshot()).rejects.toThrow('SNAPSHOT_TIMEOUT');
    });
  });

  describe('SVG Click Handling', () => {
    it('should handle SVG element click errors', async () => {
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
              nodeName: 'svg',
              localName: 'svg'
            }
          };
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'DOM.getBoxModel') {
          throw new Error('Could not compute box model');
        }
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      const result = await service.click(100);

      expect(result.success).toBe(false);
      // Error could be about box model or SVG support
      expect(result.error).toBeDefined();
    });
  });

  describe('Memory Pressure Detection', () => {
    it('should warn on pages with >50k nodes', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Create a large tree structure
      const createLargeTree = (nodeCount: number): any => {
        const nodes: any[] = [];
        for (let i = 0; i < nodeCount; i++) {
          nodes.push({
            nodeId: i,
            backendNodeId: i + 10000,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div'
          });
        }

        return {
          nodeId: 1,
          backendNodeId: 100,
          nodeType: 1,
          nodeName: 'HTML',
          localName: 'html',
          children: nodes
        };
      };

      (global.chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string, params: any) => {
        if (method === 'DOM.enable') return {};
        if (method === 'Accessibility.enable') return {};
        if (method === 'Page.enable') return {};
        if (method === 'DOM.getDocument') {
          return { root: createLargeTree(51000) };
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'Runtime.evaluate') return mockRuntimeEvaluate(params);
        return {};
      });

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MEMORY_PRESSURE')
      );

      consoleWarnSpy.mockRestore();
    });
  });
});
