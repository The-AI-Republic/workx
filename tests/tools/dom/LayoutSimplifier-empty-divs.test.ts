/**
 * Test suite for LayoutSimplifier empty div removal enhancements
 * Verifies that empty div leaves and containers with only container children are removed
 */

import { describe, it, expect } from 'vitest';
import { LayoutSimplifier } from '../../../src/tools/dom/serializers/simplifiers/LayoutSimplifier';
import type { VirtualNode } from '../../../src/tools/dom/types';

describe('LayoutSimplifier - Empty Div Removal', () => {
  const simplifier = new LayoutSimplifier();

  describe('Empty Div Leaf Removal', () => {
    it('should remove empty div leaves with no children or content', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'BUTTON',
            localName: 'button',
            tier: 'semantic',
            nodeValue: 'Click me'
          },
          {
            nodeId: 3,
            backendNodeId: 3,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            // Empty div leaf - should be removed
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Empty div should be removed
      // Since only one child remains (button), the wrapper is hoisted, so result IS the button
      expect(result.nodeName).toBe('BUTTON');
      expect(result.nodeValue).toBe('Click me');
    });

    it('should NOT remove empty divs with semantic tier', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'semantic', // Semantic tier - should be preserved
            accessibility: {
              role: 'button'
            }
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Semantic empty div should be preserved
      // Since wrapper has single child and is collapsible, it gets hoisted
      expect(result.tier).toBe('semantic');
      expect(result.accessibility?.role).toBe('button');
    });

    it('should NOT remove empty divs with meaningful role', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            accessibility: {
              role: 'navigation' // Meaningful role - should be preserved
            }
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Div with meaningful role should be preserved
      // Since wrapper has single child and is collapsible, it gets hoisted
      expect(result.accessibility?.role).toBe('navigation');
    });

    it('should NOT remove divs with content value', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            nodeValue: 'Some text content' // Has content - should be preserved
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Div with content should be preserved
      // Since wrapper has single child and is collapsible, it gets hoisted
      expect(result.nodeValue).toBe('Some text content');
    });
  });

  describe('Container-Only Div Removal', () => {
    it('should remove divs containing only other containers', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            children: [
              {
                nodeId: 3,
                backendNodeId: 3,
                nodeType: 1,
                nodeName: 'DIV',
                localName: 'div',
                tier: 'structural',
                // Empty structural container
              },
              {
                nodeId: 4,
                backendNodeId: 4,
                nodeType: 1,
                nodeName: 'SPAN',
                localName: 'span',
                tier: 'structural',
                // Another structural container
              }
            ]
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Container with only containers processing:
      // 1. Empty DIV child (node 3) is filtered out as empty leaf
      // 2. Empty SPAN child (node 4) remains (not a DIV, so not caught by isEmptyDivLeaf)
      // 3. Middle DIV (node 2) now has single child (SPAN) → gets hoisted
      // 4. Parent DIV (node 1) now has single child (SPAN) → gets hoisted
      // Result is the SPAN element
      expect(result.nodeName).toBe('SPAN');
      expect(result.tier).toBe('structural');
    });

    it('should NOT remove divs containing meaningful nodes', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            children: [
              {
                nodeId: 3,
                backendNodeId: 3,
                nodeType: 1,
                nodeName: 'BUTTON',
                localName: 'button',
                tier: 'semantic', // Meaningful node
                nodeValue: 'Click'
              }
            ]
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Container with semantic child should be preserved
      // Nested single-child wrappers get hoisted, so result is the button
      expect(result.nodeName).toBe('BUTTON');
      expect(result.nodeValue).toBe('Click');
    });

    it('should NOT remove divs containing nodes with content', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            children: [
              {
                nodeId: 3,
                backendNodeId: 3,
                nodeType: 1,
                nodeName: 'SPAN',
                localName: 'span',
                tier: 'structural',
                nodeValue: 'Text content' // Has content
              }
            ]
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Container with child containing text should be preserved
      // Nested single-child wrappers get hoisted, so result is the span
      expect(result.nodeName).toBe('SPAN');
      expect(result.nodeValue).toBe('Text content');
    });

    it('should remove nested chains of empty containers', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            children: [
              {
                nodeId: 3,
                backendNodeId: 3,
                nodeType: 1,
                nodeName: 'DIV',
                localName: 'div',
                tier: 'structural',
                children: [
                  {
                    nodeId: 4,
                    backendNodeId: 4,
                    nodeType: 1,
                    nodeName: 'DIV',
                    localName: 'div',
                    tier: 'structural',
                    // Empty leaf
                  }
                ]
              }
            ]
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // All nested empty containers should be removed
      expect(result.children).toHaveLength(0);
    });
  });

  describe('Combined Removal Logic', () => {
    it('should remove multiple empty leaves and container-only divs', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'BUTTON',
            localName: 'button',
            tier: 'semantic',
            nodeValue: 'Keep me'
          },
          {
            nodeId: 3,
            backendNodeId: 3,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            // Empty leaf - remove
          },
          {
            nodeId: 4,
            backendNodeId: 4,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            children: [
              {
                nodeId: 5,
                backendNodeId: 5,
                nodeType: 1,
                nodeName: 'DIV',
                localName: 'div',
                tier: 'structural',
                // Nested empty - remove parent
              }
            ]
          },
          {
            nodeId: 6,
            backendNodeId: 6,
            nodeType: 1,
            nodeName: 'SPAN',
            localName: 'span',
            tier: 'structural',
            nodeValue: 'Also keep me'
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Only button and span with content should remain
      expect(result.children).toHaveLength(2);
      expect(result.children?.[0].nodeName).toBe('BUTTON');
      expect(result.children?.[1].nodeName).toBe('SPAN');
    });
  });
});
