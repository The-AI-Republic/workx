/**
 * Test suite for LayoutSimplifier empty div removal enhancements
 * Verifies that empty div leaves and containers with only container children are removed
 */

import { describe, it, expect } from 'vitest';
import { LayoutSimplifier } from '@/tools/dom/serializers/simplifiers/LayoutSimplifier';
import type { VirtualNode } from '@/tools/dom/types';

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

  describe('Container Hoisting (Without Aggressive Removal)', () => {
    it('should hoist through nested containers without removing semantic elements', () => {
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
                // Empty structural container - will be removed
              },
              {
                nodeId: 4,
                backendNodeId: 4,
                nodeType: 1,
                nodeName: 'SPAN',
                localName: 'span',
                tier: 'structural',
                // Empty structural container - will be kept (not a div)
              }
            ]
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Hoisting process:
      // 1. Empty DIV child (node 3) is filtered out as empty leaf
      // 2. SPAN child (node 4) remains (not a DIV)
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

    it('should remove empty div leaves in nested chains without cascade', () => {
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
                    // Empty leaf - will be removed
                  }
                ]
              }
            ]
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // Process from bottom up:
      // 1. Node 4 (innermost): empty, returned as-is (no children to filter)
      // 2. Node 3: child=node4, filtered (empty leaf removed), becomes empty
      // 3. Node 2: child=node3 (empty), filtered (empty leaf removed), becomes empty
      // 4. Node 1: child=node2 (empty), filtered (empty leaf removed), becomes empty
      // Result is top-level div with no children (cascade stops here)
      expect(result.nodeName).toBe('DIV');
      expect(result.children?.length || 0).toBe(0);
    });
  });

  describe('Flattening Meaningless Containers', () => {
    it('should flatten meaningless containers with multiple children', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        accessibility: {
          role: 'main'
        },
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            // Meaningless container with multiple children - should be flattened
            children: [
              {
                nodeId: 3,
                backendNodeId: 3,
                nodeType: 1,
                nodeName: 'BUTTON',
                localName: 'button',
                tier: 'semantic',
                nodeValue: 'Button A'
              },
              {
                nodeId: 4,
                backendNodeId: 4,
                nodeType: 1,
                nodeName: 'BUTTON',
                localName: 'button',
                tier: 'semantic',
                nodeValue: 'Button B'
              }
            ]
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // The meaningless div (node 2) should be flattened
      // Its children (buttons A and B) should be promoted to the parent
      expect(result.children).toHaveLength(2);
      expect(result.children?.[0].nodeName).toBe('BUTTON');
      expect(result.children?.[0].nodeValue).toBe('Button A');
      expect(result.children?.[1].nodeName).toBe('BUTTON');
      expect(result.children?.[1].nodeValue).toBe('Button B');
    });

    it('should NOT flatten containers with meaningful attributes', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        accessibility: {
          role: 'main' // Make parent meaningful so it doesn't get hoisted away
        },
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            attributes: ['data-testid', 'container'], // Meaningful attribute
            children: [
              {
                nodeId: 3,
                backendNodeId: 3,
                nodeType: 1,
                nodeName: 'BUTTON',
                localName: 'button',
                tier: 'semantic',
                nodeValue: 'Button A'
              },
              {
                nodeId: 4,
                backendNodeId: 4,
                nodeType: 1,
                nodeName: 'BUTTON',
                localName: 'button',
                tier: 'semantic',
                nodeValue: 'Button B'
              }
            ]
          }
        ]
      };

      const result = simplifier.simplify(tree);

      // The div (node 2) has data-testid, so it's meaningful and should NOT be flattened
      // Parent (with role=main) should have 1 child (the div container with data-testid)
      expect(result.children).toHaveLength(1);
      expect(result.children?.[0].nodeName).toBe('DIV');
      expect(result.children?.[0].attributes).toEqual(['data-testid', 'container']);
      expect(result.children?.[0].children).toHaveLength(2);
    });
  });

  describe('Combined Removal and Hoisting', () => {
    it('should remove empty leaves and hoist through wrappers', () => {
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
            // Empty leaf - will be removed
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
                // Nested empty - will be removed, making parent empty too
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

      // Processing:
      // 1. Node 5 (nested empty): returned as-is
      // 2. Node 4 (parent): child filtered (empty), becomes empty, returned as-is
      // 3. Node 1: filters children - node 3 removed (empty), node 4 removed (empty)
      // 4. Three children remain: button, span with content
      // 5. Parent has multiple children, no hoisting
      // Result: div with button and span
      expect(result.children).toHaveLength(2);
      expect(result.children?.[0].nodeName).toBe('BUTTON');
      expect(result.children?.[1].nodeName).toBe('SPAN');
    });
  });
});
