import { describe, it, expect } from 'vitest';
import { NumericCompactor } from '../optimizers/NumericCompactor';
import type { VirtualNode } from '../../types';

/**
 * Helper: create a minimal VirtualNode for testing
 */
function makeNode(overrides: Partial<VirtualNode> & { backendNodeId: number }): VirtualNode {
  return {
    nodeId: overrides.backendNodeId,
    backendNodeId: overrides.backendNodeId,
    nodeType: 1,
    nodeName: 'DIV',
    tier: 'structural',
    ...overrides,
  };
}

describe('NumericCompactor', () => {
  let compactor: NumericCompactor;

  beforeEach(() => {
    compactor = new NumericCompactor();
  });

  // ─── compact: single node ─────────────────────────────────────

  describe('compact: single node', () => {
    it('should round bounding box floats to integers', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 100.5, y: 200.3, width: 50.7, height: 30.1 },
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: 101, y: 200, width: 51, height: 30 });
    });

    it('should keep integer bounding box unchanged', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 100, y: 200, width: 50, height: 30 },
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: 100, y: 200, width: 50, height: 30 });
    });

    it('should handle zero-value bounding box', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });

    it('should set boundingBox to undefined when node has no bounding box', () => {
      const tree = makeNode({ backendNodeId: 1 });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toBeUndefined();
    });

    it('should round 0.5 upward (Math.round behavior)', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 0.5, y: 1.5, width: 2.5, height: 3.5 },
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    });

    it('should handle negative coordinates', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: -10.3, y: -20.7, width: 50.1, height: 30.9 },
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: -10, y: -21, width: 50, height: 31 });
    });

    it('should handle very large values', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 99999.4, y: 88888.6, width: 77777.5, height: 66666.1 },
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: 99999, y: 88889, width: 77778, height: 66666 });
    });

    it('should preserve other node properties', () => {
      const tree = makeNode({
        backendNodeId: 42,
        nodeName: 'BUTTON',
        tier: 'semantic',
        boundingBox: { x: 10.5, y: 20.5, width: 100.5, height: 50.5 },
        accessibility: { role: 'button', name: 'Submit' },
      });

      const result = compactor.compact(tree);
      expect(result.backendNodeId).toBe(42);
      expect(result.nodeName).toBe('BUTTON');
      expect(result.tier).toBe('semantic');
      expect(result.accessibility).toEqual({ role: 'button', name: 'Submit' });
    });
  });

  // ─── compact: recursive children ──────────────────────────────

  describe('compact: recursive children', () => {
    it('should compact children recursively', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 0.1, y: 0.2, width: 500.3, height: 500.4 },
        children: [
          makeNode({
            backendNodeId: 2,
            boundingBox: { x: 10.7, y: 10.8, width: 50.9, height: 50.1 },
          }),
          makeNode({
            backendNodeId: 3,
            boundingBox: { x: 100.4, y: 100.6, width: 80.3, height: 80.7 },
          }),
        ],
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: 0, y: 0, width: 500, height: 500 });
      expect(result.children).toHaveLength(2);
      expect(result.children![0].boundingBox).toEqual({ x: 11, y: 11, width: 51, height: 50 });
      expect(result.children![1].boundingBox).toEqual({ x: 100, y: 101, width: 80, height: 81 });
    });

    it('should compact deeply nested children', () => {
      const tree = makeNode({
        backendNodeId: 1,
        children: [
          makeNode({
            backendNodeId: 2,
            children: [
              makeNode({
                backendNodeId: 3,
                boundingBox: { x: 5.5, y: 6.5, width: 7.5, height: 8.5 },
              }),
            ],
          }),
        ],
      });

      const result = compactor.compact(tree);
      const deepChild = result.children![0].children![0];
      expect(deepChild.boundingBox).toEqual({ x: 6, y: 7, width: 8, height: 9 });
    });

    it('should handle empty children array', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 10.5, y: 20.5, width: 100.5, height: 50.5 },
        children: [],
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: 11, y: 21, width: 101, height: 51 });
      // Empty children array means length 0, so the code skips recursion
      // The result should still have the children array from spread
      expect(result.children).toEqual([]);
    });

    it('should handle children without bounding boxes', () => {
      const tree = makeNode({
        backendNodeId: 1,
        children: [
          makeNode({ backendNodeId: 2 }), // no boundingBox
          makeNode({
            backendNodeId: 3,
            boundingBox: { x: 5.3, y: 6.7, width: 10.1, height: 20.9 },
          }),
        ],
      });

      const result = compactor.compact(tree);
      expect(result.children![0].boundingBox).toBeUndefined();
      expect(result.children![1].boundingBox).toEqual({ x: 5, y: 7, width: 10, height: 21 });
    });

    it('should handle node without children property', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 1.1, y: 2.2, width: 3.3, height: 4.4 },
      });

      const result = compactor.compact(tree);
      expect(result.boundingBox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
      expect(result.children).toBeUndefined();
    });
  });

  // ─── bboxToArray (static) ─────────────────────────────────────

  describe('bboxToArray', () => {
    it('should convert bounding box to [x, y, width, height] array', () => {
      const result = NumericCompactor.bboxToArray({ x: 10, y: 20, width: 100, height: 50 });
      expect(result).toEqual([10, 20, 100, 50]);
    });

    it('should round float values', () => {
      const result = NumericCompactor.bboxToArray({ x: 10.7, y: 20.3, width: 100.5, height: 50.1 });
      expect(result).toEqual([11, 20, 101, 50]);
    });

    it('should handle zero values', () => {
      const result = NumericCompactor.bboxToArray({ x: 0, y: 0, width: 0, height: 0 });
      expect(result).toEqual([0, 0, 0, 0]);
    });

    it('should handle negative coordinates', () => {
      const result = NumericCompactor.bboxToArray({ x: -5.2, y: -10.8, width: 50, height: 30 });
      expect(result).toEqual([-5, -11, 50, 30]);
    });

    it('should return an array of length 4', () => {
      const result = NumericCompactor.bboxToArray({ x: 1, y: 2, width: 3, height: 4 });
      expect(result).toHaveLength(4);
    });

    it('should handle very small fractional values', () => {
      const result = NumericCompactor.bboxToArray({ x: 0.001, y: 0.999, width: 0.4999, height: 0.5001 });
      expect(result).toEqual([0, 1, 0, 1]);
    });
  });

  // ─── arrayToBbox (static) ─────────────────────────────────────

  describe('arrayToBbox', () => {
    it('should convert [x, y, width, height] array to bounding box', () => {
      const result = NumericCompactor.arrayToBbox([10, 20, 100, 50]);
      expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    });

    it('should handle zero values', () => {
      const result = NumericCompactor.arrayToBbox([0, 0, 0, 0]);
      expect(result).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });

    it('should handle negative values', () => {
      const result = NumericCompactor.arrayToBbox([-5, -10, 50, 30]);
      expect(result).toEqual({ x: -5, y: -10, width: 50, height: 30 });
    });

    it('should handle floats in array (no rounding)', () => {
      const result = NumericCompactor.arrayToBbox([1.5, 2.5, 3.5, 4.5]);
      expect(result).toEqual({ x: 1.5, y: 2.5, width: 3.5, height: 4.5 });
    });

    it('should handle undefined entries gracefully', () => {
      // arrayToBbox reads arr[0]..arr[3]; if array is short, values will be undefined
      const result = NumericCompactor.arrayToBbox([10]);
      expect(result.x).toBe(10);
      expect(result.y).toBeUndefined();
      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
    });

    it('should ignore extra array elements', () => {
      const result = NumericCompactor.arrayToBbox([1, 2, 3, 4, 5, 6]);
      expect(result).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    });
  });

  // ─── roundtrip: bboxToArray + arrayToBbox ─────────────────────

  describe('roundtrip: bboxToArray <-> arrayToBbox', () => {
    it('should roundtrip integer bbox', () => {
      const original = { x: 10, y: 20, width: 100, height: 50 };
      const arr = NumericCompactor.bboxToArray(original);
      const restored = NumericCompactor.arrayToBbox(arr);
      expect(restored).toEqual(original);
    });

    it('should roundtrip after rounding', () => {
      const original = { x: 10.7, y: 20.3, width: 100.5, height: 50.1 };
      const arr = NumericCompactor.bboxToArray(original);
      const restored = NumericCompactor.arrayToBbox(arr);
      expect(restored).toEqual({ x: 11, y: 20, width: 101, height: 50 });
    });
  });

  // ─── compact: immutability ────────────────────────────────────

  describe('compact: immutability', () => {
    it('should not mutate the original node', () => {
      const originalBbox = { x: 10.5, y: 20.3, width: 50.7, height: 30.1 };
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { ...originalBbox },
      });

      compactor.compact(tree);

      // Original should remain unchanged
      expect(tree.boundingBox).toEqual(originalBbox);
    });

    it('should not mutate original children', () => {
      const childBbox = { x: 5.5, y: 6.5, width: 7.5, height: 8.5 };
      const tree = makeNode({
        backendNodeId: 1,
        children: [
          makeNode({
            backendNodeId: 2,
            boundingBox: { ...childBbox },
          }),
        ],
      });

      compactor.compact(tree);

      expect(tree.children![0].boundingBox).toEqual(childBbox);
    });

    it('should return a new node object', () => {
      const tree = makeNode({
        backendNodeId: 1,
        boundingBox: { x: 1.1, y: 2.2, width: 3.3, height: 4.4 },
      });

      const result = compactor.compact(tree);
      expect(result).not.toBe(tree);
    });
  });
});
