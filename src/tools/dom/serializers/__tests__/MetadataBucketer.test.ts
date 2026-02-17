import { describe, it, expect } from 'vitest';
import { MetadataBucketer } from '../optimizers/MetadataBucketer';
import type { BucketedMetadata } from '../optimizers/MetadataBucketer';
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

describe('MetadataBucketer', () => {
  let bucketer: MetadataBucketer;

  beforeEach(() => {
    bucketer = new MetadataBucketer();
  });

  // ─── extractMetadata: basic structure ─────────────────────────

  describe('extractMetadata: basic structure', () => {
    it('should return all empty arrays for a bare node', () => {
      const tree = makeNode({ backendNodeId: 1 });
      const meta = bucketer.extractMetadata(tree);

      expect(meta.disabled).toEqual([]);
      expect(meta.checked).toEqual([]);
      expect(meta.required).toEqual([]);
      expect(meta.readonly).toEqual([]);
      expect(meta.expanded).toEqual([]);
      expect(meta.selected).toEqual([]);
    });

    it('should return all six keys', () => {
      const tree = makeNode({ backendNodeId: 1 });
      const meta = bucketer.extractMetadata(tree);
      const keys = Object.keys(meta).sort();
      expect(keys).toEqual(['checked', 'disabled', 'expanded', 'readonly', 'required', 'selected']);
    });
  });

  // ─── extractMetadata: accessibility states ────────────────────

  describe('extractMetadata: accessibility states', () => {
    it('should extract disabled state', () => {
      const tree = makeNode({
        backendNodeId: 10,
        accessibility: { role: 'button', disabled: true },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([10]);
    });

    it('should extract checked state', () => {
      const tree = makeNode({
        backendNodeId: 20,
        accessibility: { role: 'checkbox', checked: true },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.checked).toEqual([20]);
    });

    it('should extract required state', () => {
      const tree = makeNode({
        backendNodeId: 30,
        accessibility: { role: 'textbox', required: true },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.required).toEqual([30]);
    });

    it('should extract expanded state', () => {
      const tree = makeNode({
        backendNodeId: 40,
        accessibility: { role: 'treeitem', expanded: true },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.expanded).toEqual([40]);
    });

    it('should NOT extract disabled when false', () => {
      const tree = makeNode({
        backendNodeId: 10,
        accessibility: { role: 'button', disabled: false },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([]);
    });

    it('should NOT extract checked when false', () => {
      const tree = makeNode({
        backendNodeId: 20,
        accessibility: { role: 'checkbox', checked: false },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.checked).toEqual([]);
    });

    it('should NOT extract required when false', () => {
      const tree = makeNode({
        backendNodeId: 30,
        accessibility: { role: 'textbox', required: false },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.required).toEqual([]);
    });

    it('should NOT extract expanded when false', () => {
      const tree = makeNode({
        backendNodeId: 40,
        accessibility: { role: 'treeitem', expanded: false },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.expanded).toEqual([]);
    });

    it('should NOT extract states when accessibility has no boolean flags set', () => {
      const tree = makeNode({
        backendNodeId: 50,
        accessibility: { role: 'generic' },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([]);
      expect(meta.checked).toEqual([]);
      expect(meta.required).toEqual([]);
      expect(meta.expanded).toEqual([]);
    });

    it('should extract multiple states from same node', () => {
      const tree = makeNode({
        backendNodeId: 60,
        accessibility: { role: 'checkbox', disabled: true, checked: true, required: true },
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([60]);
      expect(meta.checked).toEqual([60]);
      expect(meta.required).toEqual([60]);
    });
  });

  // ─── extractMetadata: attribute states ────────────────────────

  describe('extractMetadata: attribute states', () => {
    it('should extract readonly from attributes', () => {
      const tree = makeNode({
        backendNodeId: 100,
        attributes: ['readonly', ''],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.readonly).toEqual([100]);
    });

    it('should extract readonly with value "true"', () => {
      const tree = makeNode({
        backendNodeId: 100,
        attributes: ['readonly', 'true'],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.readonly).toEqual([100]);
    });

    it('should NOT extract readonly with value "false"', () => {
      const tree = makeNode({
        backendNodeId: 100,
        attributes: ['readonly', 'false'],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.readonly).toEqual([]);
    });

    it('should extract selected from attributes', () => {
      const tree = makeNode({
        backendNodeId: 200,
        attributes: ['selected', ''],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.selected).toEqual([200]);
    });

    it('should extract selected with value "selected"', () => {
      const tree = makeNode({
        backendNodeId: 200,
        attributes: ['selected', 'selected'],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.selected).toEqual([200]);
    });

    it('should NOT extract selected with value "false"', () => {
      const tree = makeNode({
        backendNodeId: 200,
        attributes: ['selected', 'false'],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.selected).toEqual([]);
    });

    it('should handle multiple attributes on same node', () => {
      const tree = makeNode({
        backendNodeId: 300,
        attributes: ['readonly', '', 'selected', 'true', 'class', 'my-class'],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.readonly).toEqual([300]);
      expect(meta.selected).toEqual([300]);
    });

    it('should handle attributes with non-matching names', () => {
      const tree = makeNode({
        backendNodeId: 400,
        attributes: ['class', 'active', 'id', 'my-input'],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.readonly).toEqual([]);
      expect(meta.selected).toEqual([]);
    });

    it('should handle empty attributes array', () => {
      const tree = makeNode({
        backendNodeId: 500,
        attributes: [],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.readonly).toEqual([]);
      expect(meta.selected).toEqual([]);
    });
  });

  // ─── extractMetadata: tree traversal ──────────────────────────

  describe('extractMetadata: tree traversal', () => {
    it('should traverse children', () => {
      const tree = makeNode({
        backendNodeId: 1,
        children: [
          makeNode({
            backendNodeId: 2,
            accessibility: { role: 'button', disabled: true },
          }),
          makeNode({
            backendNodeId: 3,
            accessibility: { role: 'checkbox', checked: true },
          }),
        ],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([2]);
      expect(meta.checked).toEqual([3]);
    });

    it('should traverse deeply nested children', () => {
      const tree = makeNode({
        backendNodeId: 1,
        children: [
          makeNode({
            backendNodeId: 2,
            children: [
              makeNode({
                backendNodeId: 3,
                children: [
                  makeNode({
                    backendNodeId: 4,
                    accessibility: { role: 'textbox', required: true },
                  }),
                ],
              }),
            ],
          }),
        ],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.required).toEqual([4]);
    });

    it('should collect states from multiple nodes at different depths', () => {
      const tree = makeNode({
        backendNodeId: 1,
        accessibility: { role: 'form', disabled: true },
        children: [
          makeNode({
            backendNodeId: 2,
            accessibility: { role: 'checkbox', checked: true },
            children: [
              makeNode({
                backendNodeId: 3,
                attributes: ['readonly', ''],
              }),
            ],
          }),
          makeNode({
            backendNodeId: 4,
            attributes: ['selected', 'true'],
          }),
        ],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([1]);
      expect(meta.checked).toEqual([2]);
      expect(meta.readonly).toEqual([3]);
      expect(meta.selected).toEqual([4]);
    });

    it('should handle node with no children property', () => {
      const tree = makeNode({ backendNodeId: 1 });
      // No children property at all
      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([]);
    });

    it('should handle node with empty children array', () => {
      const tree = makeNode({ backendNodeId: 1, children: [] });
      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([]);
    });
  });

  // ─── extractMetadata: combined accessibility + attributes ─────

  describe('extractMetadata: combined accessibility + attributes', () => {
    it('should extract both accessibility and attribute states from same node', () => {
      const tree = makeNode({
        backendNodeId: 77,
        accessibility: { role: 'textbox', disabled: true, required: true },
        attributes: ['readonly', '', 'selected', 'selected'],
      });

      const meta = bucketer.extractMetadata(tree);
      expect(meta.disabled).toEqual([77]);
      expect(meta.required).toEqual([77]);
      expect(meta.readonly).toEqual([77]);
      expect(meta.selected).toEqual([77]);
    });
  });

  // ─── hasState static method ───────────────────────────────────

  describe('hasState', () => {
    it('should return true when nodeId is in the specified bucket', () => {
      const meta: BucketedMetadata = {
        disabled: [1, 5, 10],
        checked: [2],
        required: [],
        readonly: [],
        expanded: [],
        selected: [],
      };

      expect(MetadataBucketer.hasState(5, 'disabled', meta)).toBe(true);
    });

    it('should return false when nodeId is not in the bucket', () => {
      const meta: BucketedMetadata = {
        disabled: [1, 5, 10],
        checked: [],
        required: [],
        readonly: [],
        expanded: [],
        selected: [],
      };

      expect(MetadataBucketer.hasState(99, 'disabled', meta)).toBe(false);
    });

    it('should return false for empty bucket', () => {
      const meta: BucketedMetadata = {
        disabled: [],
        checked: [],
        required: [],
        readonly: [],
        expanded: [],
        selected: [],
      };

      expect(MetadataBucketer.hasState(1, 'checked', meta)).toBe(false);
    });

    it('should check the correct bucket by name', () => {
      const meta: BucketedMetadata = {
        disabled: [1],
        checked: [2],
        required: [3],
        readonly: [4],
        expanded: [5],
        selected: [6],
      };

      expect(MetadataBucketer.hasState(1, 'disabled', meta)).toBe(true);
      expect(MetadataBucketer.hasState(1, 'checked', meta)).toBe(false);
      expect(MetadataBucketer.hasState(2, 'checked', meta)).toBe(true);
      expect(MetadataBucketer.hasState(3, 'required', meta)).toBe(true);
      expect(MetadataBucketer.hasState(4, 'readonly', meta)).toBe(true);
      expect(MetadataBucketer.hasState(5, 'expanded', meta)).toBe(true);
      expect(MetadataBucketer.hasState(6, 'selected', meta)).toBe(true);
    });
  });

  // ─── getCompactMetadata static method ─────────────────────────

  describe('getCompactMetadata', () => {
    it('should omit all empty arrays', () => {
      const meta: BucketedMetadata = {
        disabled: [],
        checked: [],
        required: [],
        readonly: [],
        expanded: [],
        selected: [],
      };

      const compact = MetadataBucketer.getCompactMetadata(meta);
      expect(compact).toEqual({});
    });

    it('should keep non-empty arrays', () => {
      const meta: BucketedMetadata = {
        disabled: [1, 2],
        checked: [],
        required: [3],
        readonly: [],
        expanded: [],
        selected: [],
      };

      const compact = MetadataBucketer.getCompactMetadata(meta);
      expect(compact).toEqual({
        disabled: [1, 2],
        required: [3],
      });
    });

    it('should keep all arrays when all non-empty', () => {
      const meta: BucketedMetadata = {
        disabled: [1],
        checked: [2],
        required: [3],
        readonly: [4],
        expanded: [5],
        selected: [6],
      };

      const compact = MetadataBucketer.getCompactMetadata(meta);
      expect(compact).toEqual(meta);
    });

    it('should return a new object (not mutate the original)', () => {
      const meta: BucketedMetadata = {
        disabled: [1],
        checked: [],
        required: [],
        readonly: [],
        expanded: [],
        selected: [],
      };

      const compact = MetadataBucketer.getCompactMetadata(meta);
      expect(compact).not.toBe(meta);
      expect(meta.checked).toEqual([]); // Original unchanged
    });
  });
});
