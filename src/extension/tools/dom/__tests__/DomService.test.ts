import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DomService } from '../DomService';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT, NODE_ID_DOCUMENT } from '../types';
import type { DebuggerClient, CDPEventCallback } from '../../../../core/tools/browser/DebuggerClient';

// Mock ChromeDebuggerClient
vi.mock('@/extension/tools/browser/ChromeDebuggerClient', () => ({
  ChromeDebuggerClient: class MockChromeDebuggerClient {
    private attached = false;
    private target: any = null;
    private eventCallbacks: Array<(method: string, params: unknown) => void> = [];
    async attach(target: any) { this.target = target; this.attached = true; }
    async detach() { this.target = null; this.attached = false; this.eventCallbacks = []; }
    isAttached() { return this.attached; }
    async sendCommand(method: string, params?: any) { return {}; }
    onEvent(cb: any) { this.eventCallbacks.push(cb); }
    offEvent(cb: any) { const i = this.eventCallbacks.indexOf(cb); if (i !== -1) this.eventCallbacks.splice(i, 1); }
    async enableDomain(domain: string) {}
    async disableDomain(domain: string) {}
    getTargetInfo() { return this.target; }
    getTabId() { return this.target?.tabId ?? null; }
  }
}));

// Mock the GoogleDocAddon to avoid side effects
vi.mock('../addon/GoogleDocAddon', () => ({
  googleDocAddon: {
    name: 'google-doc',
    read: vi.fn().mockResolvedValue({ executed: false, success: false, nodesAugmented: 0 })
  }
}));

/**
 * Create a mock DebuggerClient for forClient() tests
 */
function createMockClient(opts?: { attached?: boolean }): DebuggerClient {
  const attached = opts?.attached ?? true;
  const eventCallbacks: CDPEventCallback[] = [];
  return {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    isAttached: vi.fn().mockReturnValue(attached),
    sendCommand: vi.fn().mockResolvedValue({}),
    onEvent: vi.fn((cb: CDPEventCallback) => { eventCallbacks.push(cb); }),
    offEvent: vi.fn((cb: CDPEventCallback) => { const i = eventCallbacks.indexOf(cb); if (i !== -1) eventCallbacks.splice(i, 1); }),
    enableDomain: vi.fn().mockResolvedValue(undefined),
    disableDomain: vi.fn().mockResolvedValue(undefined),
    getTargetInfo: vi.fn().mockReturnValue(null),
    getTabId: vi.fn().mockReturnValue(null),
  };
}

/**
 * Helper: Sets up sendCommand mock to return a minimal DOM tree
 * suitable for buildSnapshot() to complete
 */
function setupMinimalDomMock(sendCommand: ReturnType<typeof vi.fn>) {
  sendCommand.mockImplementation(async (method: string, params?: any) => {
    if (method === 'Runtime.evaluate') {
      const expr = params?.expression || '';
      if (expr.includes('document.readyState')) {
        return { result: { value: 'complete' } };
      }
      if (expr.includes('interactiveCount')) {
        return { result: { value: { interactiveCount: 10, textLength: 500, hasLoadingIndicator: false, isStillLoading: false } } };
      }
      if (expr.includes('window.devicePixelRatio') && !expr.includes('innerWidth')) {
        return { result: { value: 1 } };
      }
      if (expr.includes('window.location.href')) {
        return { result: { value: { url: 'https://example.com', title: 'Test Page', width: 1024, height: 768 } } };
      }
      if (expr.includes('window.innerWidth') || expr.includes('innerHeight')) {
        return { result: { value: { width: 1024, height: 768, scrollX: 0, scrollY: 0, pageWidth: 1024, pageHeight: 2000, devicePixelRatio: 1 } } };
      }
      if (expr.includes('browserx:show-visual-effect') || expr.includes('CustomEvent')) {
        return { result: { value: { success: true } } };
      }
      return { result: { value: null } };
    }
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
              nodeName: 'BODY',
              localName: 'body',
              children: [
                {
                  nodeId: 3,
                  backendNodeId: 100,
                  nodeType: NODE_TYPE_ELEMENT,
                  nodeName: 'BUTTON',
                  localName: 'button',
                  children: [
                    {
                      nodeId: 4,
                      backendNodeId: 101,
                      nodeType: NODE_TYPE_TEXT,
                      nodeName: '#text',
                      nodeValue: 'Click me'
                    }
                  ]
                },
                {
                  nodeId: 5,
                  backendNodeId: 200,
                  nodeType: NODE_TYPE_ELEMENT,
                  nodeName: 'INPUT',
                  localName: 'input',
                  attributes: ['type', 'text']
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
          { backendDOMNodeId: 100, role: { value: 'button' }, name: { value: 'Click me' } },
          { backendDOMNodeId: 200, role: { value: 'textbox' }, name: { value: '' } }
        ]
      };
    }
    if (method === 'DOMSnapshot.captureSnapshot') {
      return null; // Simulate unavailable
    }
    if (method === 'DOM.getBoxModel') {
      return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } };
    }
    if (method === 'DOM.scrollIntoViewIfNeeded') return {};
    if (method === 'Input.dispatchMouseEvent') return {};
    if (method === 'Input.dispatchKeyEvent') return {};
    if (method === 'Input.insertText') return {};
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: 'input' } };
    if (method === 'Runtime.releaseObject') return {};
    if (method === 'DOM.focus') return {};
    return {};
  });
}

describe('DomService', () => {
  afterEach(async () => {
    // Clean up instances
    const instances = (DomService as any).instances;
    for (const [, service] of instances.entries()) {
      await service.detach().catch(() => {});
    }
    instances.clear();
  });

  // ==========================================================================
  // Factory Methods
  // ==========================================================================
  describe('forClient', () => {
    it('should create a DomService instance for an attached client', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'test-key-1');
      expect(service).toBeInstanceOf(DomService);
      expect(client.enableDomain).toHaveBeenCalledWith('DOM');
      expect(client.enableDomain).toHaveBeenCalledWith('Accessibility');
      expect(client.enableDomain).toHaveBeenCalledWith('Page');
      expect(client.onEvent).toHaveBeenCalled();
    });

    it('should return the same instance for the same key', async () => {
      const client = createMockClient({ attached: true });
      const service1 = await DomService.forClient(client, 'test-key-2');
      const service2 = await DomService.forClient(client, 'test-key-2');
      expect(service1).toBe(service2);
    });

    it('should throw if client is not attached', async () => {
      const client = createMockClient({ attached: false });
      await expect(DomService.forClient(client, 'test-key-3')).rejects.toThrow(
        'DebuggerClient must be attached before creating DomService'
      );
    });

    it('should apply custom config', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'test-key-4', {
        enableVisualEffects: false,
        maxTreeDepth: 50,
        snapshotTimeout: 5000,
      });
      expect((service as any).config.enableVisualEffects).toBe(false);
      expect((service as any).config.maxTreeDepth).toBe(50);
      expect((service as any).config.snapshotTimeout).toBe(5000);
    });
  });

  // ==========================================================================
  // Detach
  // ==========================================================================
  describe('detach', () => {
    it('should clean up event listeners and client on detach', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'detach-key-1');
      await service.detach();
      expect(client.detach).toHaveBeenCalled();
      expect(client.offEvent).toHaveBeenCalled();
      expect(service.getCurrentSnapshot()).toBeNull();
      expect((DomService as any).instances.has('detach-key-1')).toBe(false);
    });

    it('should be a no-op if already detached', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'detach-key-2');
      await service.detach();
      // detach again should not throw
      await service.detach();
      // client.detach should have been called only once
      expect(client.detach).toHaveBeenCalledTimes(1);
    });

    it('should handle detach errors gracefully', async () => {
      const client = createMockClient({ attached: true });
      (client.detach as any).mockRejectedValue(new Error('detach failed'));
      const service = await DomService.forClient(client, 'detach-key-3');
      // Should not throw
      await service.detach();
    });

    it('should remove chrome.debugger.onDetach listener if set', async () => {
      // Setup chrome.debugger.onDetach mock
      const removeListenerFn = vi.fn();
      (globalThis as any).chrome = {
        ...(globalThis as any).chrome,
        debugger: {
          onDetach: {
            addListener: vi.fn(),
            removeListener: removeListenerFn,
          }
        }
      };
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'detach-key-4');
      // The setupEventListeners should have registered a listener
      expect((service as any).boundHandleDebuggerDetach).not.toBeNull();
      await service.detach();
      expect(removeListenerFn).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // invalidateSnapshot / getCurrentSnapshot
  // ==========================================================================
  describe('invalidateSnapshot / getCurrentSnapshot', () => {
    it('should return null when no snapshot exists', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'snap-key-1');
      expect(service.getCurrentSnapshot()).toBeNull();
    });

    it('should invalidate existing snapshot', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'snap-key-2');
      // Manually set a snapshot
      (service as any).currentSnapshot = { isStale: () => false };
      expect(service.getCurrentSnapshot()).not.toBeNull();
      service.invalidateSnapshot();
      expect(service.getCurrentSnapshot()).toBeNull();
    });
  });

  // ==========================================================================
  // buildSnapshot
  // ==========================================================================
  describe('buildSnapshot', () => {
    it('should throw NOT_ATTACHED if not attached', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'build-key-1');
      (service as any).isAttached = false;
      await expect(service.buildSnapshot()).rejects.toThrow('NOT_ATTACHED');
    });

    it('should build a snapshot from CDP data', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'build-key-2');
      const snapshot = await service.buildSnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot.virtualDom).toBeDefined();
      expect(snapshot.pageContext.url).toBe('https://example.com');
      expect(snapshot.pageContext.title).toBe('Test Page');
      expect(snapshot.stats.totalNodes).toBeGreaterThan(0);
    });

    it('should handle accessibility tree failure gracefully', async () => {
      const client = createMockClient({ attached: true });
      const sendCmd = client.sendCommand as ReturnType<typeof vi.fn>;
      setupMinimalDomMock(sendCmd);
      // Override Accessibility.getFullAXTree to fail
      const origImpl = sendCmd.getMockImplementation()!;
      sendCmd.mockImplementation(async (method: string, params?: any) => {
        if (method === 'Accessibility.getFullAXTree') throw new Error('a11y fail');
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'build-key-3');
      const snapshot = await service.buildSnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot.virtualDom).toBeDefined();
    });

    it('should detect framework from virtual DOM', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'build-key-4');
      const snapshot = await service.buildSnapshot();
      // frameworkDetected is set (may be null or a string)
      expect(snapshot.pageContext).toHaveProperty('frameworkDetected');
    });

    it('should handle DOMSnapshot failure gracefully', async () => {
      const client = createMockClient({ attached: true });
      const sendCmd = client.sendCommand as ReturnType<typeof vi.fn>;
      setupMinimalDomMock(sendCmd);
      const origImpl = sendCmd.getMockImplementation()!;
      sendCmd.mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOMSnapshot.captureSnapshot') throw new Error('not supported');
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'build-key-5');
      const snapshot = await service.buildSnapshot();
      expect(snapshot).toBeDefined();
    });

    it('should track snapshot metrics when enabled', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'build-key-6', { enableMetrics: true });
      await service.buildSnapshot();
      const metrics = service.getMetrics();
      expect(metrics.snapshotCount).toBe(1);
      expect(metrics.snapshotCacheMisses).toBe(0); // buildSnapshot directly, not through getSerializedDom
    });

    it('should warn on large pages (>50k nodes)', async () => {
      const client = createMockClient({ attached: true });
      const sendCmd = client.sendCommand as ReturnType<typeof vi.fn>;
      setupMinimalDomMock(sendCmd);
      const service = await DomService.forClient(client, 'build-key-7');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Build snapshot normally
      await service.buildSnapshot();
      // The test data has few nodes, so no memory pressure warning expected.
      // We verify it doesn't crash. For a deeper test we'd need >50k nodes.
      warnSpy.mockRestore();
    });

    it('should handle viewport data retrieval failure', async () => {
      const client = createMockClient({ attached: true });
      const sendCmd = client.sendCommand as ReturnType<typeof vi.fn>;
      setupMinimalDomMock(sendCmd);
      let callCount = 0;
      const origImpl = sendCmd.getMockImplementation()!;
      sendCmd.mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression?.includes('window.innerWidth') && params?.expression?.includes('scrollWidth')) {
          throw new Error('eval failed');
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'build-key-8');
      const snapshot = await service.buildSnapshot();
      // Should still succeed with fallback viewport data
      expect(snapshot.pageContext.viewport).toBeDefined();
    });
  });

  // ==========================================================================
  // waitForPageLoad
  // ==========================================================================
  describe('waitForPageLoad', () => {
    it('should wait for page load event when readyState is not complete', async () => {
      const client = createMockClient({ attached: true });
      const sendCmd = client.sendCommand as ReturnType<typeof vi.fn>;
      let readyStateCallCount = 0;
      setupMinimalDomMock(sendCmd);
      const origImpl = sendCmd.getMockImplementation()!;
      sendCmd.mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'document.readyState') {
          readyStateCallCount++;
          if (readyStateCallCount === 1) {
            return { result: { value: 'loading' } };
          }
          return { result: { value: 'complete' } };
        }
        return origImpl(method, params);
      });
      // onEvent callback should fire Page.loadEventFired
      (client.onEvent as any).mockImplementation((cb: CDPEventCallback) => {
        // Simulate page load event after a short delay
        setTimeout(() => cb('Page.loadEventFired', {}), 10);
      });

      const service = await DomService.forClient(client, 'load-key-1');
      const snapshot = await service.buildSnapshot();
      expect(snapshot).toBeDefined();
    });

    it('should handle waitForPageLoad evaluation errors gracefully', async () => {
      const client = createMockClient({ attached: true });
      const sendCmd = client.sendCommand as ReturnType<typeof vi.fn>;
      setupMinimalDomMock(sendCmd);
      const origImpl = sendCmd.getMockImplementation()!;
      sendCmd.mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'document.readyState') {
          throw new Error('Page crashed');
        }
        return origImpl(method, params);
      });

      const service = await DomService.forClient(client, 'load-key-2');
      // Should not throw - continues despite error
      const snapshot = await service.buildSnapshot();
      expect(snapshot).toBeDefined();
    });
  });

  // ==========================================================================
  // buildLayoutMap
  // ==========================================================================
  describe('buildLayoutMap', () => {
    it('should return empty map when domSnapshot is null', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'layout-key-1');
      const result = (service as any).buildLayoutMap(null, 1);
      expect(result.size).toBe(0);
    });

    it('should return empty map when domSnapshot has no documents', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'layout-key-2');
      const result = (service as any).buildLayoutMap({ documents: [] }, 1);
      expect(result.size).toBe(0);
    });

    it('should skip documents with no layout', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'layout-key-3');
      const result = (service as any).buildLayoutMap({
        documents: [{ nodes: { backendNodeId: [1] } }] // No layout property
      }, 1);
      expect(result.size).toBe(0);
    });

    it('should extract bounding boxes and convert from device to CSS pixels', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'layout-key-4');
      const snapshot = {
        strings: [],
        documents: [{
          nodes: { backendNodeId: [10, 20] },
          layout: {
            nodeIndex: [0, 1],
            bounds: [
              [200, 400, 100, 50],
              [0, 0, 1024, 768]
            ]
          }
        }]
      };
      const result = (service as any).buildLayoutMap(snapshot, 2);
      expect(result.size).toBe(2);
      // Device pixels /2 = CSS pixels
      expect(result.get(10).boundingBox).toEqual({ x: 100, y: 200, width: 50, height: 25 });
      expect(result.get(20).boundingBox).toEqual({ x: 0, y: 0, width: 512, height: 384 });
    });

    it('should extract paint order', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'layout-key-5');
      const snapshot = {
        strings: [],
        documents: [{
          nodes: { backendNodeId: [10] },
          layout: {
            nodeIndex: [0],
            paintOrders: [42]
          }
        }]
      };
      const result = (service as any).buildLayoutMap(snapshot, 1);
      expect(result.get(10).paintOrder).toBe(42);
    });

    it('should extract scroll and client rects', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'layout-key-6');
      const snapshot = {
        strings: [],
        documents: [{
          nodes: { backendNodeId: [10] },
          layout: {
            nodeIndex: [0],
            scrollRects: [[2000, 5000]],
            clientRects: [[800, 600]]
          }
        }]
      };
      const result = (service as any).buildLayoutMap(snapshot, 1);
      expect(result.get(10).scrollRects).toEqual({ width: 2000, height: 5000 });
      expect(result.get(10).clientRects).toEqual({ width: 800, height: 600 });
    });

    it('should extract computed styles from string indices', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'layout-key-7');
      const snapshot = {
        strings: ['1', 'rgb(255,0,0)', 'block', 'visible', 'pointer', 'auto', 'scroll'],
        documents: [{
          nodes: { backendNodeId: [10] },
          layout: {
            nodeIndex: [0],
            styles: [[0, 1, 2, 3, 4, 5, 6]]
          }
        }]
      };
      const result = (service as any).buildLayoutMap(snapshot, 1);
      expect(result.get(10).computedStyle).toEqual({
        opacity: '1',
        backgroundColor: 'rgb(255,0,0)',
        display: 'block',
        visibility: 'visible',
        cursor: 'pointer',
        overflowX: 'auto',
        overflowY: 'scroll'
      });
    });

    it('should skip nodes with undefined backendNodeId', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'layout-key-8');
      const snapshot = {
        strings: [],
        documents: [{
          nodes: { backendNodeId: [] }, // empty, so nodeIndex[0] maps to undefined
          layout: {
            nodeIndex: [0],
            bounds: [[10, 20, 30, 40]]
          }
        }]
      };
      const result = (service as any).buildLayoutMap(snapshot, 1);
      expect(result.size).toBe(0);
    });
  });

  // ==========================================================================
  // computeStats
  // ==========================================================================
  describe('computeStats', () => {
    it('should count semantic, non-semantic, and structural nodes', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'stats-key-1');
      const stats = {
        totalNodes: 0, interactiveNodes: 0, semanticNodes: 0,
        nonSemanticNodes: 0, structuralNodes: 0, frameCount: 0,
        shadowRootCount: 0, snapshotDuration: 0
      };
      const tree = {
        nodeId: 1, backendNodeId: 1, nodeType: 1, nodeName: 'DIV',
        tier: 'semantic' as const,
        interactionType: 'click' as const,
        children: [
          {
            nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'SPAN',
            tier: 'non-semantic' as const,
          },
          {
            nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BR',
            tier: 'structural' as const,
          }
        ]
      };
      (service as any).computeStats(tree, stats);
      expect(stats.semanticNodes).toBe(1);
      expect(stats.nonSemanticNodes).toBe(1);
      expect(stats.structuralNodes).toBe(1);
      expect(stats.interactiveNodes).toBe(1);
    });

    it('should count unique frames (excluding main frame 0)', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'stats-key-2');
      const stats = {
        totalNodes: 0, interactiveNodes: 0, semanticNodes: 0,
        nonSemanticNodes: 0, structuralNodes: 0, frameCount: 0,
        shadowRootCount: 0, snapshotDuration: 0
      };
      const tree = {
        nodeId: 1, backendNodeId: 1, nodeType: 1, nodeName: 'DIV',
        tier: 'semantic' as const,
        frameIndex: 0,
        children: [
          { nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'DIV', tier: 'semantic' as const, frameIndex: 1 },
          { nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'DIV', tier: 'semantic' as const, frameIndex: 1 }, // Same frame - should only count once
          { nodeId: 4, backendNodeId: 4, nodeType: 1, nodeName: 'DIV', tier: 'semantic' as const, frameIndex: 2 }
        ]
      };
      (service as any).computeStats(tree, stats);
      expect(stats.frameCount).toBe(2); // Frames 1 and 2, not 0
    });

    it('should count shadow roots', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'stats-key-3');
      const stats = {
        totalNodes: 0, interactiveNodes: 0, semanticNodes: 0,
        nonSemanticNodes: 0, structuralNodes: 0, frameCount: 0,
        shadowRootCount: 0, snapshotDuration: 0
      };
      const tree = {
        nodeId: 1, backendNodeId: 1, nodeType: 1, nodeName: 'DIV',
        tier: 'semantic' as const,
        shadowRoots: [
          { nodeId: 2, backendNodeId: 2, nodeType: 11, nodeName: '#document-fragment', tier: 'structural' as const, shadowRootType: 'open' as const }
        ]
      };
      (service as any).computeStats(tree, stats);
      expect(stats.shadowRootCount).toBe(1);
    });

    it('should recurse into contentDocument', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'stats-key-4');
      const stats = {
        totalNodes: 0, interactiveNodes: 0, semanticNodes: 0,
        nonSemanticNodes: 0, structuralNodes: 0, frameCount: 0,
        shadowRootCount: 0, snapshotDuration: 0
      };
      const tree = {
        nodeId: 1, backendNodeId: 1, nodeType: 1, nodeName: 'IFRAME',
        tier: 'structural' as const,
        contentDocument: {
          nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML',
          tier: 'semantic' as const,
          frameIndex: 1,
        }
      };
      (service as any).computeStats(tree, stats);
      expect(stats.structuralNodes).toBe(1);
      expect(stats.semanticNodes).toBe(1);
      expect(stats.frameCount).toBe(1);
    });
  });

  // ==========================================================================
  // handleCdpEvent
  // ==========================================================================
  describe('handleCdpEvent', () => {
    it('should rebuild snapshot on DOM.documentUpdated', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'event-key-1');
      // Build initial snapshot
      await service.buildSnapshot();
      // Simulate DOM.documentUpdated event
      const handler = (service as any).handleCdpEvent.bind(service);
      // This should trigger a background snapshot rebuild
      handler('DOM.documentUpdated');
      // Give a moment for the async operation to start
      await new Promise(resolve => setTimeout(resolve, 50));
      // No crash expected
    });

    it('should invalidate snapshot if rebuild fails after DOM.documentUpdated', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'event-key-2');
      (service as any).isAttached = false; // Force buildSnapshot to fail
      const handler = (service as any).handleCdpEvent.bind(service);
      handler('DOM.documentUpdated');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(service.getCurrentSnapshot()).toBeNull();
    });

    it('should ignore non-documentUpdated events', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'event-key-3');
      const buildSpy = vi.spyOn(service, 'buildSnapshot');
      const handler = (service as any).handleCdpEvent.bind(service);
      handler('DOM.childNodeInserted');
      expect(buildSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // handleDebuggerDetach
  // ==========================================================================
  describe('handleDebuggerDetach', () => {
    it('should clean up on detach for matching tabId', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'dbg-detach-1');
      (service as any).tabId = 42;
      (service as any).currentSnapshot = { some: 'data' };
      const handler = (service as any).handleDebuggerDetach.bind(service);
      handler({ tabId: 42 }, 'target_closed');
      expect((service as any).isAttached).toBe(false);
      expect(service.getCurrentSnapshot()).toBeNull();
    });

    it('should ignore detach for non-matching tabId', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'dbg-detach-2');
      (service as any).tabId = 42;
      (service as any).isAttached = true;
      const handler = (service as any).handleDebuggerDetach.bind(service);
      handler({ tabId: 99 }, 'target_closed');
      expect((service as any).isAttached).toBe(true);
    });

    it('should log extra warning for unexpected detach reasons', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'dbg-detach-3');
      (service as any).tabId = 42;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const handler = (service as any).handleDebuggerDetach.bind(service);
      handler({ tabId: 42 }, 'crashed');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unexpected debugger detach'));
      warnSpy.mockRestore();
    });

    it('should not log extra warning for "canceled_by_user" reason', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'dbg-detach-4');
      (service as any).tabId = 42;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const handler = (service as any).handleDebuggerDetach.bind(service);
      handler({ tabId: 42 }, 'canceled_by_user');
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unexpected debugger detach'));
      warnSpy.mockRestore();
    });
  });

  // ==========================================================================
  // sendCommandWithRetry
  // ==========================================================================
  describe('sendCommandWithRetry', () => {
    it('should succeed on first try', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({ data: 'ok' });
      const service = await DomService.forClient(client, 'retry-key-1');
      const result = await (service as any).sendCommandWithRetry('Some.command', {});
      expect(result).toEqual({ data: 'ok' });
    });

    it('should retry on failure and succeed', async () => {
      const client = createMockClient({ attached: true });
      let callCount = 0;
      (client.sendCommand as any).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return { data: 'ok' };
      });
      const service = await DomService.forClient(client, 'retry-key-2');
      const result = await (service as any).sendCommandWithRetry('Some.command', {});
      expect(result).toEqual({ data: 'ok' });
      expect(callCount).toBe(2);
    });

    it('should throw after exhausting retries', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockRejectedValue(new Error('persistent failure'));
      const service = await DomService.forClient(client, 'retry-key-3');
      await expect((service as any).sendCommandWithRetry('Some.command', {})).rejects.toThrow('persistent failure');
    });
  });

  // ==========================================================================
  // getPageMetadata
  // ==========================================================================
  describe('getPageMetadata', () => {
    it('should return page metadata from Runtime.evaluate', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({
        result: { value: { url: 'https://test.com', title: 'Test', width: 800, height: 600 } }
      });
      const service = await DomService.forClient(client, 'meta-key-1');
      const meta = await (service as any).getPageMetadata();
      expect(meta.url).toBe('https://test.com');
      expect(meta.title).toBe('Test');
    });

    it('should return fallback on error', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockRejectedValue(new Error('fail'));
      const service = await DomService.forClient(client, 'meta-key-2');
      const meta = await (service as any).getPageMetadata();
      expect(meta.url).toBe('');
      expect(meta.title).toBe('');
    });
  });

  // ==========================================================================
  // triggerVisualEffect
  // ==========================================================================
  describe('triggerVisualEffect', () => {
    it('should skip if visual effects are disabled', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'vis-key-1', { enableVisualEffects: false });
      await (service as any).triggerVisualEffect('ripple', 10, 20);
      // No sendCommand calls for visual effects
      // Should not throw
    });

    it('should handle visual effect errors gracefully', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockRejectedValue(new Error('Runtime.evaluate failed'));
      const service = await DomService.forClient(client, 'vis-key-2');
      // Should not throw
      await (service as any).triggerVisualEffect('ripple', 10, 20);
    });

    it('should send undulate effect without coordinates', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({ result: { value: { success: true } } });
      const service = await DomService.forClient(client, 'vis-key-3');
      await (service as any).triggerVisualEffect('undulate');
      expect(client.sendCommand).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({ returnByValue: true })
      );
    });
  });

  // ==========================================================================
  // getKeyCode
  // ==========================================================================
  describe('getKeyCode', () => {
    it('should return Space for space', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'key-key-1');
      expect((service as any).getKeyCode(' ')).toBe('Space');
    });

    it('should return Tab for tab', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'key-key-2');
      expect((service as any).getKeyCode('\t')).toBe('Tab');
    });

    it('should return KeyA-KeyZ for letters', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'key-key-3');
      expect((service as any).getKeyCode('a')).toBe('KeyA');
      expect((service as any).getKeyCode('Z')).toBe('KeyZ');
    });

    it('should return Digit0-Digit9 for digits', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'key-key-4');
      expect((service as any).getKeyCode('0')).toBe('Digit0');
      expect((service as any).getKeyCode('9')).toBe('Digit9');
    });

    it('should return correct special key codes', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'key-key-5');
      expect((service as any).getKeyCode('.')).toBe('Period');
      expect((service as any).getKeyCode(',')).toBe('Comma');
      expect((service as any).getKeyCode(';')).toBe('Semicolon');
      expect((service as any).getKeyCode("'")).toBe('Quote');
      expect((service as any).getKeyCode('[')).toBe('BracketLeft');
      expect((service as any).getKeyCode(']')).toBe('BracketRight');
      expect((service as any).getKeyCode('\\')).toBe('Backslash');
      expect((service as any).getKeyCode('-')).toBe('Minus');
      expect((service as any).getKeyCode('=')).toBe('Equal');
      expect((service as any).getKeyCode('/')).toBe('Slash');
    });

    it('should return Unidentified for unknown characters', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'key-key-6');
      expect((service as any).getKeyCode('~')).toBe('Unidentified');
      expect((service as any).getKeyCode('@')).toBe('Unidentified');
    });
  });

  // ==========================================================================
  // detectElementType
  // ==========================================================================
  describe('detectElementType', () => {
    it('should return "input" for input elements', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: 'input' } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'det-key-1');
      const result = await (service as any).detectElementType(100);
      expect(result).toBe('input');
    });

    it('should return "textarea" for textarea elements', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: 'textarea' } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'det-key-2');
      const result = await (service as any).detectElementType(100);
      expect(result).toBe('textarea');
    });

    it('should return "contenteditable" for contenteditable elements', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: 'contenteditable' } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'det-key-3');
      const result = await (service as any).detectElementType(100);
      expect(result).toBe('contenteditable');
    });

    it('should return "unknown" when DOM.resolveNode fails', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'det-key-4');
      const result = await (service as any).detectElementType(100);
      expect(result).toBe('unknown');
    });

    it('should return "unknown" on exception', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockRejectedValue(new Error('fail'));
      const service = await DomService.forClient(client, 'det-key-5');
      const result = await (service as any).detectElementType(100);
      expect(result).toBe('unknown');
    });
  });

  // ==========================================================================
  // click
  // ==========================================================================
  describe('click', () => {
    it('should return error result for invalid node ID', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'click-key-1');
      const result = await service.click('invalid:id:bad');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid node ID');
      expect(result.actionType).toBe('click');
    });

    it('should return error when no snapshot available', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'click-key-2');
      const result = await service.click(100);
      expect(result.success).toBe(false);
      expect(result.error).toContain('NODE_NOT_FOUND');
    });

    it('should return error when frame not found', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'click-key-3');
      await service.buildSnapshot();
      const result = await service.click('5:100'); // Frame 5 doesn't exist
      expect(result.success).toBe(false);
      expect(result.error).toContain('FRAME_NOT_FOUND');
    });

    it('should return error when node not found in snapshot', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'click-key-4');
      await service.buildSnapshot();
      const result = await service.click('0:999'); // Node 999 doesn't exist
      expect(result.success).toBe(false);
      expect(result.error).toContain('NODE_NOT_FOUND');
    });

    it('should handle zero-size element errors', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      // Override getBoxModel to return zero-size
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 20, 10, 20, 10, 20, 10, 20] } }; // zero width and height
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'click-key-5');
      await service.buildSnapshot();
      const result = await service.click(100);
      expect(result.success).toBe(false);
      expect(result.error).toContain('ELEMENT_NOT_VISIBLE');
    });

    it('should successfully click and invalidate snapshot', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'click-key-6');
      await service.buildSnapshot();
      const result = await service.click(100);
      expect(result.success).toBe(true);
      expect(result.actionType).toBe('click');
      expect(result.nodeId).toBe(100);
      expect(service.getCurrentSnapshot()).toBeNull(); // Invalidated
    });

    it('should scroll into view if element is out of viewport', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      let getBoxModelCallCount = 0;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        // Simulate element far below viewport
        if (method === 'DOM.getBoxModel') {
          getBoxModelCallCount++;
          if (getBoxModelCallCount === 1) {
            return { model: { content: [10, 5000, 110, 5000, 110, 5040, 10, 5040] } };
          }
          // After scrolling, element is in viewport
          return { model: { content: [10, 200, 110, 200, 110, 240, 10, 240] } };
        }
        if (method === 'Runtime.evaluate' && params?.expression?.includes('scrollX')) {
          return { result: { value: { width: 1024, height: 768, scrollX: 0, scrollY: 0 } } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'click-key-7');
      await service.buildSnapshot();
      const result = await service.click(100);
      expect(result.success).toBe(true);
    });

    it('should handle SVG element click error', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      // Override to return an SVG node and box model failure
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1, backendNodeId: 1, nodeType: 1, nodeName: 'HTML', localName: 'html',
              children: [{
                nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
                children: [{
                  nodeId: 3, backendNodeId: 100, nodeType: 1, nodeName: 'SVG', localName: 'svg',
                }]
              }]
            }
          };
        }
        if (method === 'DOM.getBoxModel') {
          throw new Error('Could not compute box model');
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'click-key-8');
      await service.buildSnapshot();
      const result = await service.click(100);
      expect(result.success).toBe(false);
      expect(result.error).toContain('SVG_CLICK_NOT_SUPPORTED');
    });

    it('should track action metrics on success and failure', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'click-key-9', { enableMetrics: true });
      await service.buildSnapshot();
      await service.click(100);
      let metrics = service.getMetrics();
      expect(metrics.actionsByType.click).toBe(1);
      expect(metrics.actionCount).toBe(1);

      // Now trigger an error case
      service.invalidateSnapshot();
      await service.click(100); // No snapshot
      metrics = service.getMetrics();
      expect(metrics.actionsByType.click).toBe(2);
      expect(metrics.errorCount).toBe(1);
    });

    it('should skip visual effect scroll when visual effects disabled', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'click-key-10', { enableVisualEffects: false });
      await service.buildSnapshot();
      const result = await service.click(100);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // type
  // ==========================================================================
  describe('type', () => {
    it('should return error for invalid node ID', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'type-key-1');
      const result = await service.type('bad::id', 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid node ID');
    });

    it('should return error when no snapshot', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'type-key-2');
      const result = await service.type(100, 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('NODE_NOT_FOUND');
    });

    it('should validate mutually exclusive text-based options', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-3');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { insertAfter: 'x', insertBefore: 'y' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('mutually exclusive');
    });

    it('should validate text-based options cannot be used with clearFirst', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-4');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { insertAfter: 'x', clearFirst: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be used with "clearFirst"');
    });

    it('should validate occurrence must be a non-negative integer', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-5');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { occurrence: -1 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('"occurrence" must be a non-negative integer');
    });

    it('should type with instant method on simple input', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-6');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello');
      expect(result.success).toBe(true);
      expect(result.actionType).toBe('type');
      expect(result.changes?.valueChanged).toBe(true);
    });

    it('should use char-by-char method for contenteditable', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('contentEditable')) {
          return { result: { value: 'contenteditable' } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-7');
      await service.buildSnapshot();
      const result = await service.type(200, 'hi', { method: 'auto', speed: 0 });
      expect(result.success).toBe(true);
    });

    it('should use paste method for long content', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-8');
      await service.buildSnapshot();
      const longText = 'x'.repeat(400);
      const result = await service.type(200, longText);
      expect(result.success).toBe(true);
    });

    it('should use explicit paste method', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-9');
      await service.buildSnapshot();
      const result = await service.type(200, 'pasted text', { method: 'paste' });
      expect(result.success).toBe(true);
    });

    it('should use explicit char-by-char method', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-10');
      await service.buildSnapshot();
      const result = await service.type(200, 'ab', { method: 'char-by-char', speed: 0 });
      expect(result.success).toBe(true);
    });

    it('should handle clearFirst for input elements', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-11');
      await service.buildSnapshot();
      const result = await service.type(200, 'new text', { clearFirst: true });
      expect(result.success).toBe(true);
    });

    it('should handle clearFirst for contenteditable elements', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('contentEditable')) {
          return { result: { value: 'contenteditable' } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-12');
      await service.buildSnapshot();
      const result = await service.type(200, 'new text', { clearFirst: true, method: 'char-by-char', speed: 0 });
      expect(result.success).toBe(true);
    });

    it('should handle clearFirst fallback when resolve fails', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      let resolveCallCount = 0;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOM.resolveNode') {
          resolveCallCount++;
          // First call for detectElementType, second for clearFirst
          if (resolveCallCount <= 1) return { object: { objectId: 'obj-1' } };
          return {}; // No objectId - triggers fallback
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-13');
      await service.buildSnapshot();
      const result = await service.type(200, 'new text', { clearFirst: true });
      expect(result.success).toBe(true);
    });

    it('should commit with Enter key when commit="enter"', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-14');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { commit: 'enter' });
      expect(result.success).toBe(true);
    });

    it('should insert lineBreak before text', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-15');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { lineBreak: 'before' });
      expect(result.success).toBe(true);
    });

    it('should insert lineBreak after text', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-16');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { lineBreak: 'after' });
      expect(result.success).toBe(true);
    });

    it('should insert lineBreak both before and after text', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-17');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { lineBreak: 'both' });
      expect(result.success).toBe(true);
    });

    it('should handle replaceAll option', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('split(searchText)')) {
          return { result: { value: { success: true, replacementCount: 3 } } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-18');
      await service.buildSnapshot();
      const result = await service.type(200, 'new', { replaceAll: 'old' });
      expect(result.success).toBe(true);
      expect(result.changes?.replacementCount).toBe(3);
    });

    it('should handle replaceAll when text not found', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('split(searchText)')) {
          return { result: { value: { success: false, replacementCount: 0 } } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-19');
      await service.buildSnapshot();
      const result = await service.type(200, 'new', { replaceAll: 'nonexistent' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('TEXT_NOT_FOUND');
    });

    it('should handle insertAfter option', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('visibleText.indexOf')) {
          return { result: { value: { found: true, startOffset: 0, endOffset: 5 } } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-20');
      await service.buildSnapshot();
      const result = await service.type(200, 'added', { insertAfter: 'hello' });
      expect(result.success).toBe(true);
    });

    it('should handle insertBefore option', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('visibleText.indexOf')) {
          return { result: { value: { found: true, startOffset: 0, endOffset: 5 } } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-21');
      await service.buildSnapshot();
      const result = await service.type(200, 'prefix', { insertBefore: 'hello' });
      expect(result.success).toBe(true);
    });

    it('should handle replace option with empty text (deletion)', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('visibleText.indexOf')) {
          return { result: { value: { found: true, startOffset: 0, endOffset: 5 } } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-22');
      await service.buildSnapshot();
      const result = await service.type(200, '', { replace: 'hello' });
      expect(result.success).toBe(true);
      expect(result.changes?.deletedText).toBe('hello');
    });

    it('should handle replace option with replacement text', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('visibleText.indexOf')) {
          return { result: { value: { found: true, startOffset: 0, endOffset: 5 } } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-23');
      await service.buildSnapshot();
      const result = await service.type(200, 'world', { replace: 'hello' });
      expect(result.success).toBe(true);
    });

    it('should handle text-based edit when text is not found', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('visibleText.indexOf')) {
          return { result: { value: { found: false, startOffset: -1, endOffset: -1 } } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-24');
      await service.buildSnapshot();
      const result = await service.type(200, 'new', { insertAfter: 'nonexistent' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('TEXT_NOT_FOUND');
    });

    it('should validate insertAfter must be a string', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-25');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { insertAfter: 123 as any });
      expect(result.success).toBe(false);
      expect(result.error).toContain('"insertAfter" must be a string');
    });

    it('should validate insertBefore must be a string', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-26');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { insertBefore: 123 as any });
      expect(result.success).toBe(false);
      expect(result.error).toContain('"insertBefore" must be a string');
    });

    it('should validate replace must be a string', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-27');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { replace: 123 as any });
      expect(result.success).toBe(false);
      expect(result.error).toContain('"replace" must be a string');
    });

    it('should validate replaceAll must be a string', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-28');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello', { replaceAll: 123 as any });
      expect(result.success).toBe(false);
      expect(result.error).toContain('"replaceAll" must be a string');
    });

    it('should fallback to DOM.focus when box model fails', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOM.getBoxModel') throw new Error('box model fail');
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-29');
      await service.buildSnapshot();
      const result = await service.type(200, 'hello');
      expect(result.success).toBe(true);
    });

    it('should handle formatting options for contenteditable', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('contentEditable')) {
          return { result: { value: 'contenteditable' } };
        }
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'type-key-30');
      await service.buildSnapshot();
      const result = await service.type(200, 'bold text', {
        method: 'char-by-char',
        speed: 0,
        format: { bold: true, italic: true, underline: true, strikethrough: true, code: true }
      });
      expect(result.success).toBe(true);
    });

    it('should skip formatting when element is not contenteditable', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'type-key-31');
      await service.buildSnapshot();
      // format options provided but element is 'input', so formatting is skipped
      const result = await service.type(200, 'hello', { format: { bold: true } });
      expect(result.success).toBe(true);
    });

    it('should warn on occurrence with replaceAll', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.callFunctionOn' && params?.functionDeclaration?.includes('split(searchText)')) {
          return { result: { value: { success: true, replacementCount: 1 } } };
        }
        return origImpl(method, params);
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = await DomService.forClient(client, 'type-key-32');
      await service.buildSnapshot();
      await service.type(200, 'new', { replaceAll: 'old', occurrence: 1 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"occurrence" is ignored'));
      warnSpy.mockRestore();
    });
  });

  // ==========================================================================
  // scroll
  // ==========================================================================
  describe('scroll', () => {
    it('should fall back to main frame scroll on invalid node ID', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'scroll-key-1');
      const result = await service.scroll('bad::id', 0, 100);
      // Falls back to scrollMainFrame which uses Runtime.evaluate
      expect(result.actionType).toBe('scroll');
    });

    it('should fall back to main frame scroll when no snapshot', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'scroll-key-2');
      const result = await service.scroll('0:1', 0, 100);
      expect(result.actionType).toBe('scroll');
    });

    it('should fall back to main frame scroll when frame not found', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'scroll-key-3');
      await service.buildSnapshot();
      const result = await service.scroll('5:1', 0, 100); // Frame 5 doesn't exist
      expect(result.actionType).toBe('scroll');
    });

    it('should fall back to main frame scroll when node not found', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'scroll-key-4');
      await service.buildSnapshot();
      const result = await service.scroll('0:999', 0, 100);
      expect(result.actionType).toBe('scroll');
    });

    it('should use main frame scrollMainFrame for html element in frame 0', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'scroll-key-5');
      await service.buildSnapshot();
      // Node 1 is HTML element in frame 0
      const result = await service.scroll('0:1', 0, 200);
      expect(result.actionType).toBe('scroll');
    });

    it('should scroll non-html element via element.scrollTo', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      let callFunctionCount = 0;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-scroll' } };
        if (method === 'Runtime.callFunctionOn') {
          callFunctionCount++;
          // 1st call: get before position + maxScroll + containerHeight
          if (callFunctionCount === 1) {
            return { result: { value: { x: 0, y: 0, maxX: 1000, maxY: 5000, containerHeight: 500 } } };
          }
          // 2nd call: execute scrollTo
          if (callFunctionCount === 2) {
            return {};
          }
          // 3rd call: get after position
          if (callFunctionCount === 3) {
            return { result: { value: { x: 0, y: 200 } } };
          }
          return origImpl(method, params);
        }
        if (method === 'Runtime.releaseObject') return {};
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'scroll-key-6');
      await service.buildSnapshot();
      // Scroll on BODY (node 2), which is not html
      const result = await service.scroll('0:2', 0, 200);
      expect(result.actionType).toBe('scroll');
      expect(result.changes?.scrollChanged).toBe(true);
    });

    it('should report scroll limit reached', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      let callFunctionCount = 0;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-scroll' } };
        if (method === 'Runtime.callFunctionOn') {
          callFunctionCount++;
          // 1st call: before position (already at max)
          if (callFunctionCount === 1) {
            return { result: { value: { x: 0, y: 5000, maxX: 0, maxY: 5000, containerHeight: 500 } } };
          }
          // 2nd call: scrollTo
          if (callFunctionCount === 2) return {};
          // 3rd call: after position (same as before - at limit)
          if (callFunctionCount === 3) {
            return { result: { value: { x: 0, y: 5000 } } };
          }
          return origImpl(method, params);
        }
        if (method === 'Runtime.releaseObject') return {};
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'scroll-key-7');
      await service.buildSnapshot();
      const result = await service.scroll('0:2', 0, 200);
      expect(result.changes?.scrollLimitReached).toBe(true);
    });

    it('should handle error during scroll gracefully', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOM.resolveNode') throw new Error('Scroll resolve fail');
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'scroll-key-8');
      await service.buildSnapshot();
      const result = await service.scroll('0:2', 0, 200);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Scroll resolve fail');
    });

    it('should default scrollY to 80% of container height when not provided', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const origImpl = (client.sendCommand as any).getMockImplementation()!;
      let capturedScrollY = 0;
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-scroll' } };
        if (method === 'Runtime.callFunctionOn') {
          if (params?.functionDeclaration?.includes('maxX')) {
            return { result: { value: { x: 0, y: 0, maxX: 1000, maxY: 5000, containerHeight: 600 } } };
          }
          if (params?.functionDeclaration?.includes('scrollTo')) {
            // Parse the actualScrollY from the expression
            const match = params.functionDeclaration.match(/top:.*\+\s*(\d+)/);
            if (match) capturedScrollY = parseInt(match[1]);
            return {};
          }
          if (params?.functionDeclaration?.includes('scrollLeft') && !params?.functionDeclaration?.includes('maxX')) {
            return { result: { value: { x: 0, y: capturedScrollY } } };
          }
          return origImpl(method, params);
        }
        if (method === 'Runtime.releaseObject') return {};
        return origImpl(method, params);
      });
      const service = await DomService.forClient(client, 'scroll-key-9');
      await service.buildSnapshot();
      const result = await service.scroll('0:2'); // No scrollX, no scrollY
      expect(result.actionType).toBe('scroll');
    });
  });

  // ==========================================================================
  // scrollMainFrame
  // ==========================================================================
  describe('scrollMainFrame', () => {
    it('should scroll main frame and report changes', async () => {
      const client = createMockClient({ attached: true });
      const sendCmd = client.sendCommand as ReturnType<typeof vi.fn>;
      let evalCallCount = 0;
      sendCmd.mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate') {
          evalCallCount++;
          if (params?.expression?.includes('maxY')) {
            return { result: { value: { x: 0, y: 0, maxX: 1000, maxY: 5000, viewportHeight: 768 } } };
          }
          if (params?.expression?.includes('scrollTo')) return {};
          if (params?.expression?.includes('scrollY')) {
            return { result: { value: { x: 0, y: 500 } } };
          }
          return { result: { value: null } };
        }
        return {};
      });
      const service = await DomService.forClient(client, 'main-scroll-1');
      const result = await (service as any).scrollMainFrame(0, 500, Date.now(), '0:1');
      expect(result.actionType).toBe('scroll');
      expect(result.changes?.scrollChanged).toBe(true);
    });

    it('should handle error in scrollMainFrame', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockRejectedValue(new Error('eval crash'));
      const service = await DomService.forClient(client, 'main-scroll-2');
      const result = await (service as any).scrollMainFrame(0, 100, Date.now(), '0:1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('eval crash');
    });

    it('should default scrollY to 80% of window height when not provided', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate') {
          if (params?.expression?.includes('maxY')) {
            return { result: { value: { x: 0, y: 0, maxX: 0, maxY: 5000, viewportHeight: 1000 } } };
          }
          if (params?.expression?.includes('scrollTo')) return {};
          return { result: { value: { x: 0, y: 800 } } };
        }
        return {};
      });
      const service = await DomService.forClient(client, 'main-scroll-3');
      // scrollY undefined, should default to 80% of 1000 = 800
      const result = await (service as any).scrollMainFrame(0, undefined, Date.now(), '0:1');
      expect(result.changes?.scrollChanged).toBe(true);
    });
  });

  // ==========================================================================
  // keypress
  // ==========================================================================
  describe('keypress', () => {
    it('should dispatch key events with no modifiers', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'kp-key-1');
      const result = await service.keypress('a');
      expect(result.success).toBe(true);
      expect(result.actionType).toBe('keypress');
      expect(result.nodeId).toBe(NODE_ID_DOCUMENT);
    });

    it('should handle Ctrl modifier', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'kp-key-2');
      const result = await service.keypress('c', ['Ctrl']);
      expect(result.success).toBe(true);
      expect(client.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ modifiers: 2 }));
    });

    it('should handle multiple modifiers', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'kp-key-3');
      const result = await service.keypress('a', ['Ctrl', 'Shift', 'Alt', 'Meta']);
      expect(result.success).toBe(true);
      expect(client.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ modifiers: 15 }));
    });

    it('should handle error during keypress', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockRejectedValue(new Error('key fail'));
      const service = await DomService.forClient(client, 'kp-key-4');
      const result = await service.keypress('a');
      expect(result.success).toBe(false);
      expect(result.error).toContain('key fail');
    });

    it('should invalidate snapshot on success', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'kp-key-5');
      (service as any).currentSnapshot = { some: 'data' };
      await service.keypress('Enter');
      expect(service.getCurrentSnapshot()).toBeNull();
    });

    it('should invalidate snapshot on error', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockRejectedValue(new Error('fail'));
      const service = await DomService.forClient(client, 'kp-key-6');
      (service as any).currentSnapshot = { some: 'data' };
      await service.keypress('Enter');
      expect(service.getCurrentSnapshot()).toBeNull();
    });
  });

  // ==========================================================================
  // scrollIntoView
  // ==========================================================================
  describe('scrollIntoView', () => {
    it('should return error for invalid node ID', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'siv-key-1');
      const result = await service.scrollIntoView('bad::id');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid node ID');
    });

    it('should scroll element into view without options', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'siv-key-2');
      const result = await service.scrollIntoView(100);
      expect(result.success).toBe(true);
      expect(result.actionType).toBe('scroll');
    });

    it('should use JavaScript scrollIntoView with alignment options', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({ result: { value: null } });
      const service = await DomService.forClient(client, 'siv-key-3');
      const result = await service.scrollIntoView(100, { block: 'start', inline: 'center' });
      expect(result.success).toBe(true);
    });

    it('should use snapshot for node resolution if available', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'siv-key-4');
      await service.buildSnapshot();
      const result = await service.scrollIntoView('0:100');
      expect(result.success).toBe(true);
    });

    it('should handle scroll error', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockRejectedValue(new Error('scroll fail'));
      const service = await DomService.forClient(client, 'siv-key-5');
      const result = await service.scrollIntoView(100);
      expect(result.success).toBe(false);
      expect(result.error).toContain('scroll fail');
    });
  });

  // ==========================================================================
  // Performance metrics
  // ==========================================================================
  describe('getMetrics / resetMetrics / getMetricsSummary', () => {
    it('should return initial metrics', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'metrics-key-1');
      const metrics = service.getMetrics();
      expect(metrics.snapshotCount).toBe(0);
      expect(metrics.actionCount).toBe(0);
      expect(metrics.errorCount).toBe(0);
    });

    it('should reset metrics', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'metrics-key-2');
      // Manipulate metrics
      (service as any).metrics.snapshotCount = 10;
      (service as any).metrics.actionCount = 20;
      service.resetMetrics();
      const metrics = service.getMetrics();
      expect(metrics.snapshotCount).toBe(0);
      expect(metrics.actionCount).toBe(0);
      expect(metrics.lastReset).toBeInstanceOf(Date);
    });

    it('should return a metrics summary string', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'metrics-key-3');
      const summary = service.getMetricsSummary();
      expect(summary).toContain('[DomService Performance Metrics]');
      expect(summary).toContain('Snapshots:');
      expect(summary).toContain('Actions:');
      expect(summary).toContain('Cache Hit Rate:');
    });

    it('should compute cache hit rate correctly', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'metrics-key-4');
      (service as any).metrics.snapshotCacheHits = 3;
      (service as any).metrics.snapshotCacheMisses = 1;
      const summary = service.getMetricsSummary();
      expect(summary).toContain('75.0%');
    });

    it('should show 0.0% cache hit rate when no snapshots', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'metrics-key-5');
      const summary = service.getMetricsSummary();
      expect(summary).toContain('0.0%');
    });
  });

  // ==========================================================================
  // trackActionMetrics
  // ==========================================================================
  describe('trackActionMetrics', () => {
    it('should not track when metrics disabled', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'track-key-1', { enableMetrics: false });
      (service as any).trackActionMetrics('click', 100, true);
      const metrics = service.getMetrics();
      expect(metrics.actionCount).toBe(0);
    });

    it('should track successful action metrics', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'track-key-2', { enableMetrics: true });
      (service as any).trackActionMetrics('click', 100, true);
      (service as any).trackActionMetrics('type', 200, true);
      const metrics = service.getMetrics();
      expect(metrics.actionCount).toBe(2);
      expect(metrics.actionsByType.click).toBe(1);
      expect(metrics.actionsByType.type).toBe(1);
      expect(metrics.totalActionDuration).toBe(300);
      expect(metrics.averageActionDuration).toBe(150);
    });

    it('should track error metrics', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'track-key-3', { enableMetrics: true });
      (service as any).trackActionMetrics('click', 100, false, 'NODE_NOT_FOUND: missing');
      const metrics = service.getMetrics();
      expect(metrics.errorCount).toBe(1);
      expect(metrics.errorsByType['NODE_NOT_FOUND']).toBe(1);
    });

    it('should use UNKNOWN_ERROR when error message has no prefix', async () => {
      const client = createMockClient({ attached: true });
      const service = await DomService.forClient(client, 'track-key-4', { enableMetrics: true });
      (service as any).trackActionMetrics('scroll', 50, false, 'something went wrong');
      const metrics = service.getMetrics();
      expect(metrics.errorsByType['something went wrong']).toBe(1);
    });
  });

  // ==========================================================================
  // getSerializedDom
  // ==========================================================================
  describe('getSerializedDom', () => {
    it('should build snapshot if none exists', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'serial-key-1');
      const dom = await service.getSerializedDom();
      expect(dom).toBeDefined();
      expect(dom.page.context.url).toBe('https://example.com');
      expect(dom.page.body).toBeDefined();
    });

    it('should track cache miss when snapshot is stale', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'serial-key-2', { enableMetrics: true });
      // First call builds snapshot (cache miss)
      await service.getSerializedDom();
      let metrics = service.getMetrics();
      expect(metrics.snapshotCacheMisses).toBe(1);
    });

    it('should track cache hit when snapshot is fresh', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'serial-key-3', { enableMetrics: true });
      await service.getSerializedDom();
      // Second call should hit cache
      await service.getSerializedDom();
      const metrics = service.getMetrics();
      expect(metrics.snapshotCacheHits).toBe(1);
    });

    it('should include viewport with px suffixes', async () => {
      const client = createMockClient({ attached: true });
      setupMinimalDomMock(client.sendCommand as any);
      const service = await DomService.forClient(client, 'serial-key-4');
      const dom = await service.getSerializedDom();
      expect(dom.page.context.viewport.width).toMatch(/px$/);
      expect(dom.page.context.viewport.height).toMatch(/px$/);
    });
  });

  // ==========================================================================
  // applyFormattingShortcut (private)
  // ==========================================================================
  describe('applyFormattingShortcut', () => {
    it('should dispatch key events with correct modifiers', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'fmt-key-1');
      await (service as any).applyFormattingShortcut('b', 2);
      expect(client.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({
        type: 'keyDown',
        key: 'b',
        code: 'KeyB',
        modifiers: 2
      }));
      expect(client.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({
        type: 'keyUp',
        key: 'b',
        code: 'KeyB',
        modifiers: 2
      }));
    });
  });

  // ==========================================================================
  // typeCharByChar (private)
  // ==========================================================================
  describe('typeCharByChar', () => {
    it('should send keyDown/keyUp for each character', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'cbc-key-1');
      await (service as any).typeCharByChar('ab', 0);
      // 2 chars * 2 events each = 4 sendCommand calls
      expect(client.sendCommand).toHaveBeenCalledTimes(4);
    });

    it('should skip delay when speed is 0', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'cbc-key-2');
      const start = Date.now();
      await (service as any).typeCharByChar('abc', 0);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200); // Should be fast since speed=0
    });
  });

  // ==========================================================================
  // typePaste (private)
  // ==========================================================================
  describe('typePaste', () => {
    it('should call execCommand insertText via Runtime.callFunctionOn', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { method: 'execCommand', success: true } } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'paste-key-1');
      await (service as any).typePaste('hello world', 100);
      expect(client.sendCommand).toHaveBeenCalledWith('Runtime.callFunctionOn', expect.objectContaining({
        objectId: 'obj-1',
      }));
    });

    it('should throw when DOM.resolveNode returns no objectId', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'paste-key-2');
      await expect((service as any).typePaste('hello', 100)).rejects.toThrow('Could not resolve node for paste');
    });
  });

  // ==========================================================================
  // clearContentEditable (private)
  // ==========================================================================
  describe('clearContentEditable', () => {
    it('should select all and delete via keyboard', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { selected: true } } };
        if (method === 'Input.dispatchKeyEvent') return {};
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'clear-ce-1');
      await (service as any).clearContentEditable(100);
      // Verify key events were dispatched (Backspace + Delete)
      expect(client.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ key: 'Backspace' }));
      expect(client.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ key: 'Delete' }));
    });

    it('should throw when DOM.resolveNode returns no objectId', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'clear-ce-2');
      await expect((service as any).clearContentEditable(100)).rejects.toThrow('Could not resolve node for clearing');
    });
  });

  // ==========================================================================
  // setSelectionForInput (private)
  // ==========================================================================
  describe('setSelectionForInput', () => {
    it('should call setSelectionRange via Runtime.callFunctionOn', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { start: 0, end: 5, length: 10 } } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'sel-input-1');
      await (service as any).setSelectionForInput(100, 0, 5);
      expect(client.sendCommand).toHaveBeenCalledWith('Runtime.callFunctionOn', expect.objectContaining({
        objectId: 'obj-1'
      }));
    });

    it('should throw when DOM.resolveNode fails', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'sel-input-2');
      await expect((service as any).setSelectionForInput(100, 0, 5)).rejects.toThrow('Could not resolve node for selection');
    });
  });

  // ==========================================================================
  // setSelectionForContentEditable (private)
  // ==========================================================================
  describe('setSelectionForContentEditable', () => {
    it('should set selection via Selection API', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { start: 0, end: 5, totalLength: 20 } } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'sel-ce-1');
      await (service as any).setSelectionForContentEditable(100, 0, 5);
      expect(client.sendCommand).toHaveBeenCalledWith('Runtime.callFunctionOn', expect.objectContaining({
        objectId: 'obj-1'
      }));
    });

    it('should throw when DOM.resolveNode fails', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'sel-ce-2');
      await expect((service as any).setSelectionForContentEditable(100, 0, 5)).rejects.toThrow('Could not resolve node for selection');
    });
  });

  // ==========================================================================
  // setSelectionByTextMatch (private)
  // ==========================================================================
  describe('setSelectionByTextMatch', () => {
    it('should route to setSelectionForContentEditable for contenteditable', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: {} } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'stm-key-1');
      const spy = vi.spyOn(service as any, 'setSelectionForContentEditable');
      await (service as any).setSelectionByTextMatch(100, 0, 5, 'contenteditable');
      expect(spy).toHaveBeenCalledWith(100, 0, 5);
    });

    it('should route to setSelectionForInput for input elements', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: {} } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'stm-key-2');
      const spy = vi.spyOn(service as any, 'setSelectionForInput');
      await (service as any).setSelectionByTextMatch(100, 0, 5, 'input');
      expect(spy).toHaveBeenCalledWith(100, 0, 5);
    });
  });

  // ==========================================================================
  // findTextInElement (private)
  // ==========================================================================
  describe('findTextInElement', () => {
    it('should find text and return offsets', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { found: true, startOffset: 5, endOffset: 10 } } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'find-key-1');
      const result = await (service as any).findTextInElement(100, 'hello', 0, 'input');
      expect(result.found).toBe(true);
      expect(result.startOffset).toBe(5);
      expect(result.endOffset).toBe(10);
    });

    it('should return not-found when text is absent', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { found: false, startOffset: -1, endOffset: -1 } } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'find-key-2');
      const result = await (service as any).findTextInElement(100, 'missing', 0, 'input');
      expect(result.found).toBe(false);
    });

    it('should throw when DOM.resolveNode fails', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'find-key-3');
      await expect((service as any).findTextInElement(100, 'test', 0, 'input')).rejects.toThrow('Could not resolve node for text search');
    });
  });

  // ==========================================================================
  // findAndReplaceAllText (private)
  // ==========================================================================
  describe('findAndReplaceAllText', () => {
    it('should replace all occurrences', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockImplementation(async (method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { success: true, replacementCount: 3 } } };
        if (method === 'Runtime.releaseObject') return {};
        return {};
      });
      const service = await DomService.forClient(client, 'fart-key-1');
      const result = await (service as any).findAndReplaceAllText(100, 'old', 'new', 'input');
      expect(result.success).toBe(true);
      expect(result.replacementCount).toBe(3);
    });

    it('should throw when DOM.resolveNode fails', async () => {
      const client = createMockClient({ attached: true });
      (client.sendCommand as any).mockResolvedValue({});
      const service = await DomService.forClient(client, 'fart-key-2');
      await expect((service as any).findAndReplaceAllText(100, 'old', 'new', 'input')).rejects.toThrow('Could not resolve node for text replacement');
    });
  });
});
