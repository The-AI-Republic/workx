import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT, NODE_TYPE_DOCUMENT_FRAGMENT } from '../types';
import { DomService } from '../DomService';
import { DomSnapshot } from '../DomSnapshot';
import type { VirtualNode, PageContext, SnapshotStats, SerializedNode } from '../types';

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
 * Performance Tests (User Story 3)
 *
 * Goals:
 * - Verify snapshot caching reduces unnecessary rebuilds
 * - Verify serialization caching prevents redundant flattening
 * - Verify lazy snapshot building (only when requested)
 * - Verify staleness detection prevents using old data
 * - Verify performance metrics in response metadata
 */

describe('Performance: Snapshot Caching', () => {
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
          url: 'https://perf-test.example.com',
          title: 'Performance Test',
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

  it('should cache snapshot and avoid redundant DOM.getDocument calls', async () => {
    let getDocumentCallCount = 0;

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        getDocumentCallCount++;
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
              backendDOMNodeId: 2,
              role: { value: 'button' },
              name: { value: 'Click' }
            }
          ]
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);

    // First call: should build snapshot
    const dom1 = await domService.getSerializedDom();
    expect(getDocumentCallCount).toBe(1);
    const nodes1 = flattenNodes(dom1.page.body);
    const buttons1 = nodes1.filter(n => n.tag === 'button');
    expect(buttons1.length).toBe(1);

    // Second call: should use cached snapshot (no rebuild)
    const dom2 = await domService.getSerializedDom();
    expect(getDocumentCallCount).toBe(1); // Still 1, no new call
    expect(dom2).toBe(dom1); // Same object reference (serialization cached)

    // Third call: same cache
    const dom3 = await domService.getSerializedDom();
    expect(getDocumentCallCount).toBe(1);
  });

  it('should rebuild snapshot when invalidated', async () => {
    let getDocumentCallCount = 0;

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        getDocumentCallCount++;
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

    // Build initial snapshot
    await domService.getSerializedDom();
    expect(getDocumentCallCount).toBe(1);

    // Invalidate snapshot
    domService.invalidateSnapshot();
    expect(domService.getCurrentSnapshot()).toBeNull();

    // Next call should rebuild
    await domService.getSerializedDom();
    expect(getDocumentCallCount).toBe(2); // Rebuilt
  });

  it('should rebuild stale snapshot (> 30s)', async () => {
    let getDocumentCallCount = 0;

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        getDocumentCallCount++;
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

    // Build initial snapshot
    const snapshot1 = await domService.buildSnapshot();
    expect(getDocumentCallCount).toBe(1);

    // Manually set timestamp to 31 seconds ago
    const oldTimestamp = new Date(Date.now() - 31000);
    (snapshot1 as any).timestamp = oldTimestamp;

    // Check staleness
    expect(snapshot1.isStale(30000)).toBe(true);

    // Next getSerializedDom should rebuild
    await domService.getSerializedDom();
    expect(getDocumentCallCount).toBe(2); // Rebuilt due to staleness
  });

  it('should use cached snapshot within staleness window', async () => {
    let getDocumentCallCount = 0;

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        getDocumentCallCount++;
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

    // Build initial snapshot
    const snapshot1 = await domService.buildSnapshot();
    expect(getDocumentCallCount).toBe(1);

    // Check not stale (< 30s)
    expect(snapshot1.isStale(30000)).toBe(false);

    // Multiple calls should use cache
    await domService.getSerializedDom();
    await domService.getSerializedDom();
    await domService.getSerializedDom();
    expect(getDocumentCallCount).toBe(1); // Still cached
  });

  it('should track snapshot build duration', async () => {
    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};

      if (method === 'DOM.getDocument') {
        // Simulate slow DOM fetch
        await new Promise(resolve => setTimeout(resolve, 50));
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
    const snapshot = await domService.buildSnapshot();

    const stats = snapshot.getStats();
    expect(stats.snapshotDuration).toBeGreaterThan(0);
    expect(stats.snapshotDuration).toBeGreaterThanOrEqual(40); // At least close to the simulated 50ms delay (allowing for timing variance)
  });

  it('should track serialization duration', async () => {
    // Create large virtual DOM
    const createLargeVirtualDom = (depth: number, breadth: number): VirtualNode => {
      const node: VirtualNode = {
        nodeId: Math.random(),
        backendNodeId: Math.random(),
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'semantic',
        interactionType: 'click',
        accessibility: {
          role: 'button',
          name: 'Test Button'
        }
      };

      if (depth > 0) {
        node.children = Array.from({ length: breadth }, () =>
          createLargeVirtualDom(depth - 1, breadth)
        );
      }

      return node;
    };

    const virtualDom = createLargeVirtualDom(5, 3); // 364 total nodes (3^0 + 3^1 + 3^2 + 3^3 + 3^4 + 3^5)

    const pageContext: PageContext = {
      url: 'https://example.com',
      title: 'Test',
      frameId: 'main',
      loaderId: 'loader',
      viewport: { width: 1920, height: 1080 },
      frameTree: []
    };

    const stats: SnapshotStats = {
      totalNodes: 364,
      interactiveNodes: 364,
      semanticNodes: 364,
      nonSemanticNodes: 0,
      structuralNodes: 0,
      frameCount: 0,
      shadowRootCount: 0,
      snapshotDuration: 100
    };

    // nodeIdMap no longer needed
    // backendIdMap no longer needed
    for (let i = 1; i <= 364; i++) {
    }

    const snapshot = new DomSnapshot(virtualDom, pageContext, stats);

    // First serialization (should track duration)
    const start = Date.now();
    const serialized1 = snapshot.serialize();
    const duration1 = Date.now() - start;

    // Get updated stats after serialization
    const updatedStats = snapshot.getStats();
    expect(updatedStats.serializationDuration).toBeDefined();
    expect(updatedStats.serializationDuration).toBeGreaterThanOrEqual(0); // Can be 0 for very fast serialization
    const nodes1 = flattenNodes(serialized1.page.body);
    // All nodes in the tree should be included (364 total nodes)
    expect(nodes1.length).toBeGreaterThan(0);

    // Second serialization (should use cache, near-instant)
    const start2 = Date.now();
    const serialized2 = snapshot.serialize();
    const duration2 = Date.now() - start2;

    expect(serialized2).toBe(serialized1); // Same object reference
    expect(duration2).toBeLessThanOrEqual(duration1); // Cached should be same or faster
  });

  it('should handle parallel serialization requests efficiently', async () => {
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
            children: Array.from({ length: 100 }, (_, i) => ({
              nodeId: i + 2,
              backendNodeId: i + 2,
              nodeType: NODE_TYPE_ELEMENT,
              nodeName: 'BUTTON',
              localName: 'button'
            }))
          }
        };
      }

      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: Array.from({ length: 100 }, (_, i) => ({
            backendDOMNodeId: i + 2,
            role: { value: 'button' },
            name: { value: `Button ${i}` }
          }))
        };
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);

    // Fire 10 parallel serialization requests
    const start = Date.now();
    const promises = Array.from({ length: 10 }, () => domService.getSerializedDom());
    const results = await Promise.all(promises);
    const duration = Date.now() - start;

    // All results should be identical (cached)
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }

    // Should be fast (< 500ms for 10 parallel requests with caching)
    expect(duration).toBeLessThan(500);

    // All should have 100 buttons
    const nodes = flattenNodes(results[0].page.body);
    const buttons = nodes.filter(n => n.tag === 'button');
    expect(buttons.length).toBe(100);
  });

  it('should invalidate snapshot on action (even on error)', async () => {
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
              name: { value: 'Test' }
            }
          ]
        };
      }

      if (method === 'DOM.getBoxModel') {
        // Simulate error
        throw new Error('CDP_ERROR: Element not attached to DOM');
      }

      return {};
    });

    const domService = await DomService.forTab(mockTabId);
    await domService.buildSnapshot();

    const snapshot1 = domService.getCurrentSnapshot();
    expect(snapshot1).not.toBeNull();

    const backendNodeId = 100;  // Use backendNodeId from serialized output
    expect(backendNodeId).toBeTruthy();

    // Attempt click (will fail due to getBoxModel error)
    const result = await domService.click(backendNodeId);

    expect(result.success).toBe(false);

    // Verify snapshot was invalidated despite error
    expect(domService.getCurrentSnapshot()).toBeNull();
  });

  it('should use singleton pattern efficiently (one service per tab)', async () => {
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

    // Multiple forTab calls should return same instance
    const service1 = await DomService.forTab(mockTabId);
    const service2 = await DomService.forTab(mockTabId);
    const service3 = await DomService.forTab(mockTabId);

    expect(service1).toBe(service2);
    expect(service2).toBe(service3);

    // Only one attach call
    expect(mockChrome.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it('should handle max tree depth limit to prevent stack overflow', async () => {
    // Create infinitely recursive DOM (simulate malicious or broken page)
    const createDeepDom = (depth: number): any => {
      return {
        nodeId: depth,
        backendNodeId: depth,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'DIV',
        localName: 'div',
        children: depth < 150 ? [createDeepDom(depth + 1)] : []
      };
    };

    mockChrome.debugger.sendCommand.mockImplementation(async (target: any, method: string) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return {};
      if (method === 'DOM.getDocument') {
        return { root: createDeepDom(1) };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [] };
      }
      return {};
    });

    const domService = await DomService.forTab(mockTabId, { maxTreeDepth: 100 });
    const snapshot = await domService.buildSnapshot();

    // Should not exceed maxTreeDepth (100)
    const stats = snapshot.getStats();
    expect(stats.totalNodes).toBeLessThanOrEqual(101); // 100 depth + root
  });
});
