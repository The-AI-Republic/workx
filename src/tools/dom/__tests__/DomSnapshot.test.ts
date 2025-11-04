import { describe, it, expect } from 'vitest';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT, NODE_TYPE_DOCUMENT_FRAGMENT } from '../types';
import { DomSnapshot } from '../DomSnapshot';
import type { VirtualNode, PageContext, SnapshotStats, SerializedNode } from '../types';

// Helper to flatten tree structure for testing
function flattenNodes(node: SerializedNode): SerializedNode[] {
  const result: SerializedNode[] = [node];
  if (node.kids) {
    for (const child of node.kids) {
      result.push(...flattenNodes(child));
    }
  }
  return result;
}

describe('DomSnapshot', () => {
  const mockVirtualDom: VirtualNode = {
    nodeId: 1,
    backendNodeId: 100,
    nodeType: NODE_TYPE_ELEMENT,
    nodeName: 'HTML',
    tier: 'structural',
    children: [
      {
        nodeId: 2,
        backendNodeId: 101,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'BUTTON',
        localName: 'button',
        tier: 'semantic',
        interactionType: 'click',
        accessibility: { role: 'button', name: 'Submit' }
      }
    ]
  };

  const mockPageContext: PageContext = {
    url: 'https://example.com',
    title: 'Example',
    frameId: 'main',
    loaderId: 'loader1',
    viewport: { width: 1920, height: 1080 },
    frameTree: []
  };

  const mockStats: SnapshotStats = {
    totalNodes: 2,
    interactiveNodes: 1,
    semanticNodes: 1,
    nonSemanticNodes: 0,
    structuralNodes: 1,
    frameCount: 0,
    shadowRootCount: 0,
    snapshotDuration: 100
  };

  it('should create snapshot with correct properties', () => {
    const snapshot = new DomSnapshot(
      mockVirtualDom,
      mockPageContext,
      mockStats
    );

    expect(snapshot.virtualDom).toBe(mockVirtualDom);
    expect(snapshot.getNodeByBackendId(101)?.backendNodeId).toBe(101); // backendNodeId 101 exists
    expect(snapshot.getNodeByBackendId(101)?.nodeId).toBe(2); // CDP nodeId is 2
    expect(snapshot.pageContext.url).toBe('https://example.com');
  });

  it('should serialize to tree structure', () => {
    const snapshot = new DomSnapshot(
      mockVirtualDom,
      mockPageContext,
      mockStats
    );

    const serialized = snapshot.serialize();

    // Check page structure
    expect(serialized.page.context.url).toBe('https://example.com');
    expect(serialized.page.context.title).toBe('Example');
    expect(serialized.page.body).toBeDefined();

    // Flatten tree to check nodes
    const allNodes = flattenNodes(serialized.page.body);
    const buttonNode = allNodes.find(n => n.tag === 'button');

    expect(buttonNode).toBeDefined();
    expect(buttonNode?.node_id).toBe(1); // Sequential ID (remapped from backendNodeId 101)
    expect(buttonNode?.role).toBe('button');
    expect(buttonNode?.aria_label).toBe('Submit');

    // Verify we can translate back to backend ID
    const backendId = snapshot.translateSequentialIdToBackendId(buttonNode?.node_id!);
    expect(backendId).toBe(101); // Should map back to original backendNodeId
  });

  it('should detect stale snapshots', async () => {
    const snapshot = new DomSnapshot(
      mockVirtualDom,
      mockPageContext,
      mockStats
    );

    expect(snapshot.isStale(100000)).toBe(false); // Fresh (within 100s)

    // Wait 1ms and check with 0ms threshold
    await new Promise(resolve => setTimeout(resolve, 2));
    expect(snapshot.isStale(0)).toBe(true); // Now stale (older than 0ms)
  });

  it('should cache serialization', () => {
    const snapshot = new DomSnapshot(
      mockVirtualDom,
      mockPageContext,
      mockStats
    );

    const serialized1 = snapshot.serialize();
    const serialized2 = snapshot.serialize();

    // Should return same object (cached)
    expect(serialized1).toBe(serialized2);
  });

  it('should return null for non-existent IDs', () => {
    const snapshot = new DomSnapshot(
      mockVirtualDom,
      mockPageContext,
      mockStats
    );

    expect(snapshot.getNodeByBackendId(999)).toBeNull(); // Non-existent backendNodeId

    // After serialization, test ID translation for non-existent sequential IDs
    snapshot.serialize();
    expect(snapshot.translateSequentialIdToBackendId(999)).toBeNull();
  });

  it('should return stats copy', () => {
    const snapshot = new DomSnapshot(
      mockVirtualDom,
      mockPageContext,
      mockStats
    );

    const stats = snapshot.getStats();
    stats.totalNodes = 999; // Modify copy

    // Original should be unchanged
    expect(snapshot.stats.totalNodes).toBe(2);
  });
});
