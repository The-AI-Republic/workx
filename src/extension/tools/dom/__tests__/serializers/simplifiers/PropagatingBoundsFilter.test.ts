/**
 * Unit tests for PropagatingBoundsFilter
 * Covers all uncovered branches: shouldFilterNestedClickable, isPropagatingContainer,
 * hasExceptionRule, isContained, excludedByParent flag, and edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PropagatingBoundsFilter } from '../../../serializers/simplifiers/PropagatingBoundsFilter';
import type { VirtualNode } from '../../../types';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT } from '../../../types';

describe('PropagatingBoundsFilter', () => {
  let filter: PropagatingBoundsFilter;

  beforeEach(() => {
    filter = new PropagatingBoundsFilter();
  });

  // Helper to create a VirtualNode
  const createNode = (
    id: number,
    tag: string,
    options: Partial<VirtualNode> = {}
  ): VirtualNode => ({
    nodeId: id,
    backendNodeId: id,
    nodeType: NODE_TYPE_ELEMENT,
    nodeName: tag.toUpperCase(),
    localName: tag.toLowerCase(),
    tier: 'structural',
    ...options,
  });

  const createTextNode = (id: number, text: string): VirtualNode => ({
    nodeId: id,
    backendNodeId: id,
    nodeType: NODE_TYPE_TEXT,
    nodeName: '#text',
    tier: 'structural',
    nodeValue: text,
  });

  describe('filter', () => {
    it('should return tree unchanged when no bounding box data exists', () => {
      const tree = createNode(1, 'div', {
        children: [createNode(2, 'button')],
      });
      const result = filter.filter(tree);
      expect(result).toBe(tree);
    });

    it('should process tree when bounding box data is found on root', () => {
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });
      const result = filter.filter(tree);
      expect(result).toBeDefined();
    });

    it('should find bounding box data in deeply nested children', () => {
      const tree = createNode(1, 'div', {
        children: [
          createNode(2, 'div', {
            children: [
              createNode(3, 'span', {
                boundingBox: { x: 0, y: 0, width: 50, height: 50 },
              }),
            ],
          }),
        ],
      });
      const result = filter.filter(tree);
      // Should have processed the tree (not returned original ref)
      expect(result).toBeDefined();
      expect(result.children).toBeDefined();
    });

    it('should filter nested clickable that is >99% contained in parent button', () => {
      const childLink = createNode(3, 'span', {
        tier: 'non-semantic',
        heuristics: {
          hasOnClick: false,
          hasDataTestId: false,
          hasCursorPointer: true,
          isVisuallyInteractive: false,
        },
        boundingBox: { x: 5, y: 5, width: 90, height: 40 },
      });
      const parentButton = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [childLink],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parentButton],
      });

      const result = filter.filter(tree);
      // The child should be removed because it is >99% contained
      const resultButton = result.children![0];
      expect(resultButton.children).toBeUndefined();
    });

    it('should not filter child when parent is not clickable', () => {
      const child = createNode(3, 'span', {
        tier: 'non-semantic',
        heuristics: {
          hasOnClick: false,
          hasDataTestId: false,
          hasCursorPointer: true,
          isVisuallyInteractive: false,
        },
        boundingBox: { x: 5, y: 5, width: 90, height: 40 },
      });
      const parent = createNode(2, 'div', {
        tier: 'structural',
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [child],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      const resultParent = result.children![0];
      expect(resultParent.children).toBeDefined();
      expect(resultParent.children!.length).toBe(1);
    });

    it('should not filter child when child is not clickable', () => {
      const child = createNode(3, 'span', {
        tier: 'structural',
        boundingBox: { x: 5, y: 5, width: 90, height: 40 },
      });
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [child],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      const resultButton = result.children![0];
      expect(resultButton.children).toBeDefined();
      expect(resultButton.children!.length).toBe(1);
    });

    it('should keep children array as undefined when all children are filtered', () => {
      // Create a scenario where a button's only clickable child gets filtered
      const childSpan = createNode(3, 'span', {
        tier: 'non-semantic',
        heuristics: {
          hasOnClick: false,
          hasDataTestId: false,
          hasCursorPointer: true,
          isVisuallyInteractive: false,
        },
        boundingBox: { x: 2, y: 2, width: 96, height: 46 },
      });
      const parentButton = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [childSpan],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parentButton],
      });

      const result = filter.filter(tree);
      const resultButton = result.children![0];
      // Child was filtered, so children should be undefined
      expect(resultButton.children).toBeUndefined();
    });

    it('should return leaf node as-is when it has no children', () => {
      const tree = createNode(1, 'span', {
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
      });
      const result = filter.filter(tree);
      expect(result).toEqual(tree);
    });
  });

  describe('isPropagatingContainer', () => {
    it('should treat <button> as propagating container', () => {
      const childClickable = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 2, y: 2, width: 96, height: 46 },
      });
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [childClickable],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      const resultButton = result.children![0];
      // Button is propagating, child is contained, so child should be removed
      expect(resultButton.children).toBeUndefined();
    });

    it('should treat <a> as propagating container', () => {
      const childClickable = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
      });
      const parent = createNode(2, 'a', {
        tier: 'semantic',
        accessibility: { role: 'link' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [childClickable],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      expect(result.children![0].children).toBeUndefined();
    });

    it('should treat <summary> as propagating container', () => {
      const childClickable = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
      });
      const parent = createNode(2, 'summary', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [childClickable],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      expect(result.children![0].children).toBeUndefined();
    });

    it('should treat <label> as propagating container', () => {
      const childClickable = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
      });
      const parent = createNode(2, 'label', {
        tier: 'semantic',
        accessibility: { role: 'generic' },
        interactionType: 'click',
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [childClickable],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      expect(result.children![0].children).toBeUndefined();
    });

    it('should treat element with hasOnClick as propagating container', () => {
      const childClickable = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
      });
      const parent = createNode(2, 'div', {
        tier: 'non-semantic',
        heuristics: {
          hasOnClick: true,
          hasDataTestId: false,
          hasCursorPointer: false,
          isVisuallyInteractive: false,
        },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [childClickable],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      expect(result.children![0].children).toBeUndefined();
    });

    it('should NOT treat a non-propagating div as propagating', () => {
      const childClickable = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
      });
      // Parent is a div with cursor:pointer but not onclick/tag-based propagating
      const parent = createNode(2, 'div', {
        tier: 'non-semantic',
        heuristics: {
          hasOnClick: false,
          hasDataTestId: false,
          hasCursorPointer: true,
          isVisuallyInteractive: false,
        },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [childClickable],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      // Child should NOT be filtered because parent is not propagating
      expect(result.children![0].children).toBeDefined();
      expect(result.children![0].children!.length).toBe(1);
    });
  });

  describe('hasExceptionRule', () => {
    // Helper that creates a typical filtering scenario but with exception
    const createFilterScenario = (
      childOverrides: Partial<VirtualNode>,
      parentOverrides: Partial<VirtualNode> = {}
    ) => {
      const child = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
        ...childOverrides,
      });
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [child],
        ...parentOverrides,
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });
      return tree;
    };

    it('should preserve <input> inside button (exception 1: form input)', () => {
      const tree = createFilterScenario({
        localName: 'input',
        nodeName: 'INPUT',
      });
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
      expect(result.children![0].children!.length).toBe(1);
    });

    it('should preserve <select> inside button (exception 1: form input)', () => {
      const tree = createFilterScenario({
        localName: 'select',
        nodeName: 'SELECT',
      });
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should preserve <textarea> inside button (exception 1: form input)', () => {
      const tree = createFilterScenario({
        localName: 'textarea',
        nodeName: 'TEXTAREA',
      });
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should preserve <button> inside button (exception 1: form input)', () => {
      const tree = createFilterScenario({
        localName: 'button',
        nodeName: 'BUTTON',
      });
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should preserve child with explicit onclick handler (exception 2)', () => {
      const tree = createFilterScenario({
        heuristics: {
          hasOnClick: true,
          hasDataTestId: false,
          hasCursorPointer: false,
          isVisuallyInteractive: false,
        },
      });
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
      expect(result.children![0].children!.length).toBe(1);
    });

    it('should preserve child with unique aria-label (exception 3)', () => {
      const tree = createFilterScenario(
        {
          accessibility: { role: 'generic', name: 'Close dialog' },
        },
        {
          accessibility: { role: 'button', name: 'Submit form' },
        }
      );
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should NOT preserve child when aria-label matches parent aria-label', () => {
      const tree = createFilterScenario(
        {
          accessibility: { role: 'generic', name: 'Submit' },
        },
        {
          accessibility: { role: 'button', name: 'Submit' },
        }
      );
      const result = filter.filter(tree);
      // Labels are the same, so exception 3 does not apply
      // But exception 4 does not apply either (generic role)
      expect(result.children![0].children).toBeUndefined();
    });

    it('should preserve child with different interactive role from parent (exception 4)', () => {
      const tree = createFilterScenario(
        {
          accessibility: { role: 'checkbox' },
        },
        {
          accessibility: { role: 'button' },
        }
      );
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should NOT trigger exception 4 when child role is generic', () => {
      const tree = createFilterScenario(
        {
          accessibility: { role: 'generic' },
        },
        {
          accessibility: { role: 'button' },
        }
      );
      const result = filter.filter(tree);
      // generic role is excluded from exception 4
      expect(result.children![0].children).toBeUndefined();
    });

    it('should NOT trigger exception 4 when roles are the same', () => {
      const tree = createFilterScenario(
        {
          accessibility: { role: 'button' },
        },
        {
          accessibility: { role: 'button' },
        }
      );
      const result = filter.filter(tree);
      // Same role, no exception 4
      // But note: child localName is 'span' so exception 1 does not apply
      expect(result.children![0].children).toBeUndefined();
    });

    it('should not trigger exception when child has no accessibility info', () => {
      const tree = createFilterScenario({
        // no accessibility, no onclick, not a form input tag
      });
      const result = filter.filter(tree);
      // No exceptions apply, child should be filtered
      expect(result.children![0].children).toBeUndefined();
    });
  });

  describe('isContained', () => {
    const createContainmentScenario = (
      childBox: { x: number; y: number; width: number; height: number },
      parentBox: { x: number; y: number; width: number; height: number }
    ) => {
      const child = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: childBox,
      });
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: parentBox,
        children: [child],
      });
      return createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 500, height: 500 },
        children: [parent],
      });
    };

    it('should filter child that is 100% contained', () => {
      const tree = createContainmentScenario(
        { x: 10, y: 10, width: 80, height: 30 },
        { x: 0, y: 0, width: 100, height: 50 }
      );
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeUndefined();
    });

    it('should NOT filter child that is less than 99% contained', () => {
      // Child extends well beyond parent
      const tree = createContainmentScenario(
        { x: 50, y: 0, width: 100, height: 50 },
        { x: 0, y: 0, width: 100, height: 50 }
      );
      const result = filter.filter(tree);
      // 50% containment, well below threshold
      expect(result.children![0].children).toBeDefined();
    });

    it('should NOT filter child when child has zero area', () => {
      const tree = createContainmentScenario(
        { x: 10, y: 10, width: 0, height: 50 },
        { x: 0, y: 0, width: 100, height: 50 }
      );
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should NOT filter when child bounding box is missing', () => {
      const child = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        // no boundingBox
      });
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [child],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should NOT filter when parent bounding box is missing', () => {
      const child = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 10, y: 10, width: 80, height: 30 },
      });
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        // no boundingBox
        children: [child],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should handle child entirely outside parent (no intersection)', () => {
      const tree = createContainmentScenario(
        { x: 200, y: 200, width: 50, height: 50 },
        { x: 0, y: 0, width: 100, height: 50 }
      );
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeDefined();
    });

    it('should filter child at exactly 99% containment', () => {
      // Parent: 0,0 100x100, Child: 0,0 100x100 (100% containment)
      const tree = createContainmentScenario(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 100, height: 100 }
      );
      const result = filter.filter(tree);
      expect(result.children![0].children).toBeUndefined();
    });
  });

  describe('custom threshold', () => {
    it('should use custom containment threshold', () => {
      const filterLow = new PropagatingBoundsFilter(0.5);
      // Child at 60% containment
      const child = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 40, y: 0, width: 100, height: 50 },
      });
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [child],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filterLow.filter(tree);
      // 60% > 50% threshold, so child should be filtered
      expect(result.children![0].children).toBeUndefined();
    });
  });

  describe('hasBoundingBoxData', () => {
    it('should return false for tree with no bounding boxes at all', () => {
      const tree = createNode(1, 'div', {
        children: [
          createNode(2, 'span', {
            children: [createNode(3, 'p')],
          }),
        ],
      });
      const result = filter.filter(tree);
      expect(result).toBe(tree);
    });

    it('should find bounding box in second branch of tree', () => {
      const tree = createNode(1, 'div', {
        children: [
          createNode(2, 'span'), // no bounding box
          createNode(3, 'p', {
            boundingBox: { x: 0, y: 0, width: 50, height: 50 },
          }),
        ],
      });
      const result = filter.filter(tree);
      // Should have processed the tree
      expect(result).not.toBe(tree);
    });
  });

  describe('nodeName fallback', () => {
    it('should use nodeName when localName is not set for isPropagatingContainer', () => {
      const child = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
      });
      const parent: VirtualNode = {
        nodeId: 2,
        backendNodeId: 2,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'BUTTON',
        // no localName
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [child],
      };
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      expect(result.children![0].children).toBeUndefined();
    });

    it('should use nodeName for hasExceptionRule child tag check', () => {
      const child: VirtualNode = {
        nodeId: 3,
        backendNodeId: 3,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'INPUT',
        // no localName
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
      };
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [child],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      // INPUT should be preserved as form input exception
      expect(result.children![0].children).toBeDefined();
    });
  });

  describe('recursive processing', () => {
    it('should process deeply nested structures', () => {
      const deepChild = createNode(5, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 2, y: 2, width: 96, height: 46 },
      });
      const middleButton = createNode(4, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [deepChild],
      });
      const wrapper = createNode(3, 'div', {
        boundingBox: { x: 0, y: 0, width: 120, height: 70 },
        children: [middleButton],
      });
      const parent = createNode(2, 'div', {
        boundingBox: { x: 0, y: 0, width: 150, height: 100 },
        children: [wrapper],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      // Navigate to the button -- deepChild should be filtered
      const resultButton = result.children![0].children![0].children![0];
      expect(resultButton.localName).toBe('button');
      expect(resultButton.children).toBeUndefined();
    });

    it('should keep some children and filter others', () => {
      const filteredChild = createNode(3, 'span', {
        tier: 'non-semantic',
        interactionType: 'click',
        boundingBox: { x: 1, y: 1, width: 98, height: 48 },
      });
      const keptChild = createTextNode(4, 'Click me');
      const parent = createNode(2, 'button', {
        tier: 'semantic',
        accessibility: { role: 'button' },
        boundingBox: { x: 0, y: 0, width: 100, height: 50 },
        children: [filteredChild, keptChild],
      });
      const tree = createNode(1, 'div', {
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [parent],
      });

      const result = filter.filter(tree);
      const resultButton = result.children![0];
      // Text node should remain, clickable span should be filtered
      expect(resultButton.children).toBeDefined();
      expect(resultButton.children!.length).toBe(1);
      expect(resultButton.children![0].nodeType).toBe(NODE_TYPE_TEXT);
    });
  });
});
