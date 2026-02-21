import { describe, it, expect, beforeEach } from 'vitest';
import { PaintOrderFilter } from '../filters/PaintOrderFilter';
import type { VirtualNode } from '../../types';

/**
 * Helper: create a minimal VirtualNode for testing.
 */
function makeNode(overrides: Partial<VirtualNode> & { backendNodeId: number }): VirtualNode {
  const { backendNodeId, ...rest } = overrides;
  return {
    nodeId: backendNodeId,
    backendNodeId,
    nodeType: 1,
    nodeName: 'DIV',
    tier: 'structural',
    ...rest,
  };
}

/**
 * Helper: create a root container that participates in paint-order detection
 * but does NOT have its own boundingBox (so it is never grouped for occlusion).
 * This keeps the root from occluding its children in tests.
 */
function makeRoot(children: VirtualNode[], extra?: Partial<VirtualNode>): VirtualNode {
  return makeNode({
    backendNodeId: 1,
    // paintOrder is present (to trigger processing) but no boundingBox
    // so root is never grouped for occlusion
    paintOrder: 0,
    children,
    ...extra,
  });
}

describe('PaintOrderFilter', () => {
  let filter: PaintOrderFilter;

  beforeEach(() => {
    filter = new PaintOrderFilter();
  });

  // ─── hasPaintOrderData detection ──────────────────────────────

  describe('hasPaintOrderData detection', () => {
    it('should return tree unchanged when no paint order data exists', () => {
      const tree = makeNode({
        backendNodeId: 1,
        children: [
          makeNode({ backendNodeId: 2 }),
          makeNode({ backendNodeId: 3 }),
        ],
      });

      const result = filter.filter(tree);
      expect(result).toBe(tree); // same reference — no filtering applied
    });

    it('should detect paint order on root node', () => {
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 0,
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });

      const result = filter.filter(tree);
      // Should process (not return same ref), since paint order exists
      expect(result).not.toBe(tree);
    });

    it('should detect paint order on deeply nested child', () => {
      const tree = makeNode({
        backendNodeId: 1,
        children: [
          makeNode({
            backendNodeId: 2,
            children: [
              makeNode({
                backendNodeId: 3,
                paintOrder: 5,
                boundingBox: { x: 0, y: 0, width: 50, height: 50 },
              }),
            ],
          }),
        ],
      });

      const result = filter.filter(tree);
      expect(result).not.toBe(tree);
    });

    it('should detect paint order in shadow roots', () => {
      const tree = makeNode({
        backendNodeId: 1,
        shadowRoots: [
          makeNode({
            backendNodeId: 2,
            paintOrder: 1,
            boundingBox: { x: 0, y: 0, width: 50, height: 50 },
          }),
        ],
      });

      const result = filter.filter(tree);
      expect(result).not.toBe(tree);
    });

    it('should detect paint order in contentDocument', () => {
      const tree = makeNode({
        backendNodeId: 1,
        contentDocument: makeNode({
          backendNodeId: 2,
          paintOrder: 3,
          boundingBox: { x: 0, y: 0, width: 50, height: 50 },
        }),
      });

      const result = filter.filter(tree);
      expect(result).not.toBe(tree);
    });

    it('should return tree when only empty children arrays exist', () => {
      const tree = makeNode({
        backendNodeId: 1,
        children: [],
      });

      const result = filter.filter(tree);
      expect(result).toBe(tree);
    });

    it('should detect paint order nested inside shadowRoot children', () => {
      const tree = makeNode({
        backendNodeId: 1,
        shadowRoots: [
          makeNode({
            backendNodeId: 2,
            children: [
              makeNode({
                backendNodeId: 3,
                paintOrder: 1,
              }),
            ],
          }),
        ],
      });

      const result = filter.filter(tree);
      expect(result).not.toBe(tree);
    });

    it('should detect paint order inside contentDocument children', () => {
      const tree = makeNode({
        backendNodeId: 1,
        contentDocument: makeNode({
          backendNodeId: 2,
          children: [
            makeNode({
              backendNodeId: 3,
              paintOrder: 7,
            }),
          ],
        }),
      });

      const result = filter.filter(tree);
      expect(result).not.toBe(tree);
    });
  });

  // ─── collectNodes ─────────────────────────────────────────────

  describe('collectNodes (via filter behavior)', () => {
    it('should collect nodes from children', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 10, y: 10, width: 50, height: 50 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
    });

    it('should collect nodes from shadow roots', () => {
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 0,
        shadowRoots: [
          makeNode({
            backendNodeId: 2,
            paintOrder: 1,
            boundingBox: { x: 10, y: 10, width: 50, height: 50 },
          }),
        ],
      });

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
    });

    it('should collect nodes from contentDocument', () => {
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 0,
        contentDocument: makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 10, y: 10, width: 50, height: 50 },
        }),
      });

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
    });
  });

  // ─── groupByPaintOrder ────────────────────────────────────────

  describe('groupByPaintOrder (via filter behavior)', () => {
    it('should skip nodes without boundingBox', () => {
      const tree = makeRoot([
        makeNode({ backendNodeId: 2, paintOrder: 1 }), // no boundingBox
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      // Node 2 should still be in tree (not filtered) since it had no bbox for occlusion grouping
      expect(result!.children).toBeDefined();
      expect(result!.children!.length).toBe(1);
    });

    it('should skip nodes without paintOrder', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          boundingBox: { x: 10, y: 10, width: 50, height: 50 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.children).toBeDefined();
      expect(result!.children!.length).toBe(1);
    });
  });

  // ─── detectOcclusion ──────────────────────────────────────────

  describe('occlusion detection', () => {
    it('should remove a fully occluded node', () => {
      // Node 2 (paintOrder 1) is fully covered by node 3 (paintOrder 5)
      // Root has no bbox, so it does not participate in occlusion
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 10, y: 10, width: 50, height: 50 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 5,
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      expect(childIds).not.toContain(2);
      expect(childIds).toContain(3);
    });

    it('should keep a partially visible node', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 5,
          boundingBox: { x: 50, y: 50, width: 100, height: 100 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      expect(childIds).toContain(2);
      expect(childIds).toContain(3);
    });

    it('should keep non-overlapping nodes', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 0, y: 0, width: 50, height: 50 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 5,
          boundingBox: { x: 200, y: 200, width: 50, height: 50 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      expect(childIds).toContain(2);
      expect(childIds).toContain(3);
    });

    it('should process paint orders in descending order (highest first)', () => {
      // paintOrder 10 covers paintOrder 5 and 1
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 0, y: 0, width: 50, height: 50 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 10,
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }),
        makeNode({
          backendNodeId: 4,
          paintOrder: 5,
          boundingBox: { x: 0, y: 0, width: 80, height: 80 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      expect(childIds).not.toContain(2);
      expect(childIds).not.toContain(4);
      expect(childIds).toContain(3);
    });

    it('should set ignoredByPaintOrder flag on occluded nodes', () => {
      const child = makeNode({
        backendNodeId: 2,
        paintOrder: 1,
        boundingBox: { x: 10, y: 10, width: 30, height: 30 },
      });
      const overlay = makeNode({
        backendNodeId: 3,
        paintOrder: 5,
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });

      const tree = makeRoot([child, overlay]);

      filter.filter(tree);
      expect(child.ignoredByPaintOrder).toBe(true);
    });

    it('should NOT set ignoredByPaintOrder on visible nodes', () => {
      const visible = makeNode({
        backendNodeId: 2,
        paintOrder: 5,
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });

      const tree = makeRoot([visible]);

      filter.filter(tree);
      expect(visible.ignoredByPaintOrder).toBeUndefined();
    });
  });

  // ─── filterByOcclusion (tree rewriting) ───────────────────────

  describe('filterByOcclusion (tree structure)', () => {
    it('should return null if root itself is occluded', () => {
      // Root (paintOrder 1, bbox 10..60) fully inside child (paintOrder 5, bbox 0..100)
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 1,
        boundingBox: { x: 10, y: 10, width: 50, height: 50 },
        children: [
          makeNode({
            backendNodeId: 2,
            paintOrder: 5,
            boundingBox: { x: 0, y: 0, width: 100, height: 100 },
          }),
        ],
      });

      const result = filter.filter(tree);
      expect(result).toBeNull();
    });

    it('should produce undefined children when all children are filtered', () => {
      // Root has no bbox: will not be grouped for occlusion.
      // Children 2 and 3 (paintOrder 1) are fully covered by child 4 (paintOrder 5).
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 10, y: 10, width: 20, height: 20 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 1,
          boundingBox: { x: 40, y: 40, width: 20, height: 20 },
        }),
        makeNode({
          backendNodeId: 4,
          paintOrder: 5,
          boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      expect(childIds).toEqual([4]);
    });

    it('should filter shadow roots recursively', () => {
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 0,
        // no boundingBox for root
        shadowRoots: [
          makeNode({
            backendNodeId: 5,
            paintOrder: 1,
            boundingBox: { x: 10, y: 10, width: 30, height: 30 },
          }),
        ],
        children: [
          makeNode({
            backendNodeId: 6,
            paintOrder: 5,
            boundingBox: { x: 0, y: 0, width: 200, height: 200 },
          }),
        ],
      });

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.shadowRoots).toBeUndefined();
    });

    it('should filter contentDocument recursively', () => {
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 0,
        contentDocument: makeNode({
          backendNodeId: 7,
          paintOrder: 1,
          boundingBox: { x: 10, y: 10, width: 30, height: 30 },
        }),
        children: [
          makeNode({
            backendNodeId: 8,
            paintOrder: 5,
            boundingBox: { x: 0, y: 0, width: 200, height: 200 },
          }),
        ],
      });

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.contentDocument).toBeUndefined();
    });

    it('should preserve tree structure for non-occluded nodes', () => {
      // Child at paintOrder 5 is NOT occluded (no higher paint-order element covers it)
      // Its sub-child at paintOrder 4 IS occluded by its parent (paintOrder 5)
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 5,
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
          children: [
            makeNode({
              backendNodeId: 3,
              paintOrder: 4,
              boundingBox: { x: 10, y: 10, width: 20, height: 20 },
            }),
          ],
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.backendNodeId).toBe(1);
      expect(result!.children).toBeDefined();
      expect(result!.children!.length).toBe(1);
      expect(result!.children![0].backendNodeId).toBe(2);
    });

    it('should handle empty children arrays (no children after filter)', () => {
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 0,
        boundingBox: { x: 0, y: 0, width: 500, height: 500 },
        children: [],
      });

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.children).toBeUndefined();
    });

    it('should handle empty shadowRoots array', () => {
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 0,
        boundingBox: { x: 0, y: 0, width: 500, height: 500 },
        shadowRoots: [],
      });

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.shadowRoots).toBeUndefined();
    });

    it('should handle node without contentDocument', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 0, y: 0, width: 50, height: 50 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.contentDocument).toBeUndefined();
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle a tree with a single node (root only)', () => {
      const tree = makeNode({
        backendNodeId: 1,
        paintOrder: 0,
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.backendNodeId).toBe(1);
    });

    it('should handle nodes with same paint order (no occlusion between peers)', () => {
      // Same paint order: processed in array order. First is added to union,
      // second is checked against it. If second covers first, second still survives
      // because they are at the same layer.
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 0, y: 0, width: 50, height: 50 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 1,
          boundingBox: { x: 200, y: 200, width: 50, height: 50 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      // Non-overlapping same-paint-order nodes should both survive
      expect(childIds).toContain(2);
      expect(childIds).toContain(3);
    });

    it('should handle nodes with zero-size bounding boxes', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 50, y: 50, width: 0, height: 0 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 5,
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      // The zero-size node is fully contained by the overlay
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      expect(childIds).not.toContain(2);
      expect(childIds).toContain(3);
    });

    it('should handle deep nesting across children/shadowRoots/contentDocument', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 5,
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
          shadowRoots: [
            makeNode({
              backendNodeId: 3,
              paintOrder: 3,
              boundingBox: { x: 10, y: 10, width: 30, height: 30 },
              contentDocument: makeNode({
                backendNodeId: 4,
                paintOrder: 2,
                boundingBox: { x: 15, y: 15, width: 10, height: 10 },
              }),
            }),
          ],
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      expect(result!.backendNodeId).toBe(1);
    });

    it('should handle multiple overlay layers', () => {
      // Three layers: bottom (1), middle (5), top (10)
      // Top covers middle, which covers bottom
      // Root has no bbox, so does not participate.
      const tree = makeRoot([
        makeNode({
          backendNodeId: 10,
          paintOrder: 1,
          boundingBox: { x: 10, y: 10, width: 80, height: 80 },
        }),
        makeNode({
          backendNodeId: 11,
          paintOrder: 5,
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }),
        makeNode({
          backendNodeId: 12,
          paintOrder: 10,
          boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      // paintOrder 10 covers paintOrder 5, which covers paintOrder 1
      expect(childIds).not.toContain(10);
      expect(childIds).not.toContain(11);
      expect(childIds).toContain(12);
    });

    it('should handle node where only some children are occluded', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 0, y: 0, width: 30, height: 30 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 1,
          boundingBox: { x: 300, y: 300, width: 30, height: 30 }, // far away
        }),
        makeNode({
          backendNodeId: 4,
          paintOrder: 5,
          boundingBox: { x: 0, y: 0, width: 50, height: 50 }, // covers node 2 only
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      expect(childIds).not.toContain(2); // occluded
      expect(childIds).toContain(3);     // not occluded (far away)
      expect(childIds).toContain(4);     // visible overlay
    });

    it('should handle tree with no occluded nodes at all', () => {
      const tree = makeRoot([
        makeNode({
          backendNodeId: 2,
          paintOrder: 1,
          boundingBox: { x: 0, y: 0, width: 50, height: 50 },
        }),
        makeNode({
          backendNodeId: 3,
          paintOrder: 2,
          boundingBox: { x: 100, y: 100, width: 50, height: 50 },
        }),
        makeNode({
          backendNodeId: 4,
          paintOrder: 3,
          boundingBox: { x: 200, y: 200, width: 50, height: 50 },
        }),
      ]);

      const result = filter.filter(tree);
      expect(result).not.toBeNull();
      const childIds = result!.children?.map(c => c.backendNodeId) ?? [];
      expect(childIds).toContain(2);
      expect(childIds).toContain(3);
      expect(childIds).toContain(4);
    });
  });
});
