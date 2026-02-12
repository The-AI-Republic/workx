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

/**
 * Edge Case Integration Tests
 *
 * Tests for edge cases and error scenarios:
 * - X-Frame-Options DENY detection
 * - Deeply nested iframe protection
 * - CDP connection loss handling
 * - Element visibility verification
 * - Debugger conflict detection
 * - Slow-loading iframe timeout
 * - SVG element click handling
 * - Memory pressure detection
 */

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
    // Clean up instances
    try {
      const instances = (DomService as any).instances;
      if (instances.has(mockTabId)) {
        const service = instances.get(mockTabId);
        await service.detach();
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('X-Frame-Options DENY Detection', () => {
    it('should detect and report X-Frame-Options DENY errors', async () => {
      const sendCommand = vi.fn()
        .mockResolvedValueOnce(undefined) // DOM.enable (in attach)
        .mockResolvedValueOnce(undefined) // Accessibility.enable (in attach)
        .mockRejectedValueOnce(new Error('Frame with origin "https://blocked.com" not found')) // DOM.getDocument fails
        .mockResolvedValueOnce(null) // Accessibility.getFullAXTree (ignored)
        .mockRejectedValueOnce(new Error('Frame with origin "https://blocked.com" not found')) // DOM.getDocument fails (second call)
        .mockResolvedValueOnce(null); // Accessibility.getFullAXTree (ignored, second call)

      (global.chrome.debugger.sendCommand as any) = sendCommand;

      const service = await DomService.forTab(mockTabId);

      await expect(service.buildSnapshot()).rejects.toThrow('FRAME_DENIED');
      await expect(service.buildSnapshot()).rejects.toThrow('X-Frame-Options DENY');
    });
  });

  describe('Pathological Iframe Nesting', () => {
    it('should stop traversal at 100+ nested iframes', async () => {
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

      const sendCommand = vi.fn()
        .mockResolvedValueOnce(undefined) // DOM.enable
        .mockResolvedValueOnce(undefined) // Accessibility.enable
        .mockResolvedValueOnce({ root: createNestedIframes(1) }) // DOM.getDocument
        .mockResolvedValueOnce(null); // Accessibility.getFullAXTree

      (global.chrome.debugger.sendCommand as any) = sendCommand;

      const service = await DomService.forTab(mockTabId);
      const snapshot = await service.buildSnapshot();

      // Should have built tree but stopped at depth limit
      expect(snapshot).toBeDefined();
      // Total nodes should be less than 101 * 2 (each level has html + iframe)
      expect(snapshot.stats.totalNodes).toBeLessThan(200);
    });
  });

  describe('CDP Connection Loss', () => {
    it('should handle debugger detach gracefully', async () => {
      const service = await DomService.forTab(mockTabId);

      // Simulate debugger detach
      const detachHandler = (global.chrome.debugger.onDetach.addListener as any).mock.calls[0][0];
      detachHandler({ tabId: mockTabId }, 'target_closed');

      // Service should mark as not attached
      await expect(service.buildSnapshot()).rejects.toThrow('NOT_ATTACHED');
    });

    it('should warn on unexpected detach', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = await DomService.forTab(mockTabId);

      // Simulate unexpected detach
      const detachHandler = (global.chrome.debugger.onDetach.addListener as any).mock.calls[0][0];
      detachHandler({ tabId: mockTabId }, 'unknown_reason');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected debugger detach')
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Element Visibility Verification', () => {
    it('should reject clicks on zero-size elements', async () => {
      const mockSnapshot = {
        root: {
          nodeId: 1,
          backendNodeId: 100,
          nodeType: 1,
          nodeName: 'BUTTON',
          localName: 'button'
        }
      };

      const sendCommand = vi.fn()
        .mockResolvedValueOnce(undefined) // DOM.enable
        .mockResolvedValueOnce(undefined) // Accessibility.enable
        .mockResolvedValueOnce({ root: mockSnapshot.root }) // DOM.getDocument
        .mockResolvedValueOnce(null) // Accessibility.getFullAXTree
        .mockResolvedValueOnce({ // DOM.getBoxModel with zero size
          model: {
            content: [0, 0, 0, 0, 0, 0, 0, 0] // Zero width and height
          }
        });

      (global.chrome.debugger.sendCommand as any) = sendCommand;

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      const result = await service.click(100); // Use backendNodeId

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
      const sendCommand = vi.fn()
        .mockResolvedValueOnce(undefined) // DOM.enable
        .mockResolvedValueOnce(undefined) // Accessibility.enable
        .mockImplementationOnce(() =>
          new Promise(resolve => setTimeout(resolve, 15000)) // Never resolves in time
        );

      (global.chrome.debugger.sendCommand as any) = sendCommand;

      const service = await DomService.forTab(mockTabId, { snapshotTimeout: 100 });

      await expect(service.buildSnapshot()).rejects.toThrow('SNAPSHOT_TIMEOUT');
    });
  });

  describe('SVG Click Handling', () => {
    it('should detect SVG elements and provide clear error', async () => {
      const mockSnapshot = {
        root: {
          nodeId: 1,
          backendNodeId: 100,
          nodeType: 1,
          nodeName: 'svg',
          localName: 'svg'
        }
      };

      const sendCommand = vi.fn()
        .mockResolvedValueOnce(undefined) // DOM.enable
        .mockResolvedValueOnce(undefined) // Accessibility.enable
        .mockResolvedValueOnce({ root: mockSnapshot.root }) // DOM.getDocument
        .mockResolvedValueOnce(null) // Accessibility.getFullAXTree
        .mockRejectedValueOnce(new Error('Could not compute box model')); // SVG box model fails

      (global.chrome.debugger.sendCommand as any) = sendCommand;

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      const result = await service.click(100); // Use backendNodeId

      expect(result.success).toBe(false);
      expect(result.error).toContain('SVG_CLICK_NOT_SUPPORTED');
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

      const sendCommand = vi.fn()
        .mockResolvedValueOnce(undefined) // DOM.enable
        .mockResolvedValueOnce(undefined) // Accessibility.enable
        .mockResolvedValueOnce({ root: createLargeTree(51000) }) // DOM.getDocument with 51k nodes
        .mockResolvedValueOnce(null); // Accessibility.getFullAXTree

      (global.chrome.debugger.sendCommand as any) = sendCommand;

      const service = await DomService.forTab(mockTabId);
      await service.buildSnapshot();

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MEMORY_PRESSURE')
      );

      consoleWarnSpy.mockRestore();
    });
  });
});
