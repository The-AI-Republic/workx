/**
 * Unit tests for LayoutSimplifier
 * Covers: wrapper collapsing, meaningless container flattening, empty div removal,
 * semantic container preservation, hoistChildren, attribute merging, and edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutSimplifier } from '../../../serializers/simplifiers/LayoutSimplifier';
import type { VirtualNode } from '../../../types';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT } from '../../../types';

describe('LayoutSimplifier', () => {
  let simplifier: LayoutSimplifier;

  beforeEach(() => {
    simplifier = new LayoutSimplifier();
  });

  const createElement = (
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

  describe('simplify - basic', () => {
    it('should return leaf node unchanged', () => {
      const node = createElement(1, 'span');
      const result = simplifier.simplify(node);
      expect(result).toEqual(node);
    });

    it('should return node with no children unchanged', () => {
      const node = createElement(1, 'div');
      const result = simplifier.simplify(node);
      expect(result).toEqual(node);
    });

    it('should return node with empty children array unchanged', () => {
      const node = createElement(1, 'div', { children: [] });
      const result = simplifier.simplify(node);
      expect(result).toEqual(node);
    });
  });

  describe('collapsible wrapper detection', () => {
    it('should collapse structural div wrapper around button', () => {
      const wrapper = createElement(1, 'div', {
        children: [
          createElement(2, 'button', {
            tier: 'semantic',
            accessibility: { role: 'button' },
          }),
        ],
      });
      const result = simplifier.simplify(wrapper);
      // Wrapper collapsed, child hoisted
      expect(result.localName).toBe('button');
      expect(result.backendNodeId).toBe(2);
    });

    it('should NOT collapse semantic tier wrapper', () => {
      const wrapper = createElement(1, 'div', {
        tier: 'semantic',
        children: [createElement(2, 'span')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('div');
      expect(result.children).toBeDefined();
    });

    it('should NOT collapse non-semantic tier wrapper', () => {
      const wrapper = createElement(1, 'div', {
        tier: 'non-semantic',
        children: [createElement(2, 'span')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('div');
    });

    it('should NOT collapse scrollable wrapper', () => {
      const wrapper = createElement(1, 'div', {
        scrollable: 'vertical',
        children: [createElement(2, 'span')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('div');
    });

    it('should NOT collapse semantic container (form)', () => {
      const wrapper = createElement(1, 'form', {
        children: [createElement(2, 'input')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('form');
    });

    it('should NOT collapse semantic container (table)', () => {
      const wrapper = createElement(1, 'table', {
        children: [createElement(2, 'tbody')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('table');
    });

    it('should NOT collapse semantic container (nav)', () => {
      const wrapper = createElement(1, 'nav', {
        children: [createElement(2, 'a')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('nav');
    });

    it('should NOT collapse #document', () => {
      const wrapper = createElement(1, '#document', {
        localName: '#document',
        children: [createElement(2, 'html')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('#document');
    });

    it('should NOT collapse html element', () => {
      const wrapper = createElement(1, 'html', {
        children: [createElement(2, 'body')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('html');
    });

    it('should NOT collapse head element', () => {
      const wrapper = createElement(1, 'head', {
        children: [createElement(2, 'title')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('head');
    });

    it('should NOT collapse body element', () => {
      const wrapper = createElement(1, 'body', {
        children: [createElement(2, 'div')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('body');
    });

    it('should NOT collapse node with meaningful accessibility role', () => {
      const wrapper = createElement(1, 'div', {
        accessibility: { role: 'region' },
        children: [createElement(2, 'p')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('div');
    });

    it('should collapse node with generic accessibility role', () => {
      const wrapper = createElement(1, 'div', {
        accessibility: { role: 'generic' },
        children: [createElement(2, 'p')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('p');
    });

    it('should collapse node with none accessibility role', () => {
      const wrapper = createElement(1, 'div', {
        accessibility: { role: 'none' },
        children: [createElement(2, 'p')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('p');
    });
  });

  describe('empty div leaf removal', () => {
    it('should remove empty div leaf', () => {
      const parent = createElement(1, 'div', {
        children: [
          createElement(2, 'button', { tier: 'semantic' }),
          createElement(3, 'div'), // empty leaf
        ],
      });
      const result = simplifier.simplify(parent);
      // After removing empty div, only button remains
      // Then wrapper collapsing may apply
      expect(result.localName).toBe('button');
    });

    it('should NOT remove empty div with semantic tier', () => {
      const parent = createElement(1, 'div', {
        tier: 'semantic',
        children: [
          createElement(2, 'div', { tier: 'semantic' }),
        ],
      });
      const result = simplifier.simplify(parent);
      expect(result.localName).toBe('div');
      expect(result.children).toBeDefined();
    });

    it('should NOT remove empty div with non-semantic tier', () => {
      const parent = createElement(1, 'div', {
        tier: 'semantic',
        children: [
          createElement(2, 'div', { tier: 'non-semantic' }),
        ],
      });
      const result = simplifier.simplify(parent);
      expect(result.children).toBeDefined();
      expect(result.children!.length).toBe(1);
    });

    it('should NOT remove empty div with meaningful role', () => {
      const parent = createElement(1, 'div', {
        tier: 'semantic',
        children: [
          createElement(2, 'div', {
            accessibility: { role: 'alert' },
          }),
        ],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT remove empty div with nodeValue', () => {
      const parent = createElement(1, 'div', {
        tier: 'semantic',
        children: [
          createElement(2, 'div', { nodeValue: 'some content' }),
        ],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT remove non-div empty leaf', () => {
      const parent = createElement(1, 'div', {
        tier: 'semantic',
        children: [
          createElement(2, 'span'), // not a div
        ],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT remove div with children', () => {
      const parent = createElement(1, 'div', {
        tier: 'semantic',
        children: [
          createElement(2, 'div', {
            children: [createTextNode(3, 'Content')],
          }),
        ],
      });
      const result = simplifier.simplify(parent);
      expect(result.children).toBeDefined();
    });

    it('should remove empty div with generic role', () => {
      const parent = createElement(1, 'div', {
        tier: 'semantic',
        children: [
          createElement(2, 'button', { tier: 'semantic' }),
          createElement(3, 'div', {
            accessibility: { role: 'generic' },
          }),
        ],
      });
      const result = simplifier.simplify(parent);
      // Empty div with generic role should be removed
      // Parent is semantic so it stays
      expect(result.children!.length).toBe(1);
      expect(result.children![0].localName).toBe('button');
    });

    it('should remove div with whitespace-only nodeValue', () => {
      const parent = createElement(1, 'div', {
        tier: 'semantic',
        children: [
          createElement(2, 'button', { tier: 'semantic' }),
          createElement(3, 'div', { nodeValue: '   ' }),
        ],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });
  });

  describe('meaningless container flattening', () => {
    it('should flatten meaningless div with multiple children', () => {
      const wrapper = createElement(2, 'div', {
        children: [
          createElement(3, 'button', { tier: 'semantic' }),
          createElement(4, 'a', { tier: 'semantic' }),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      // Meaningless div should be flattened -- its children promoted
      expect(result.children!.length).toBe(2);
      expect(result.children![0].localName).toBe('button');
      expect(result.children![1].localName).toBe('a');
    });

    it('should NOT flatten div with non-generic accessibility role', () => {
      const wrapper = createElement(2, 'div', {
        accessibility: { role: 'navigation' },
        children: [
          createElement(3, 'a'),
          createElement(4, 'a'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
      expect(result.children![0].localName).toBe('div');
    });

    it('should NOT flatten div with semantic attributes (aria-label)', () => {
      const wrapper = createElement(2, 'div', {
        attributes: ['aria-label', 'Navigation area'],
        children: [
          createElement(3, 'a'),
          createElement(4, 'a'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT flatten div with data-testid', () => {
      const wrapper = createElement(2, 'div', {
        attributes: ['data-testid', 'my-component'],
        children: [
          createElement(3, 'span'),
          createElement(4, 'span'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT flatten div with aria-describedby', () => {
      const wrapper = createElement(2, 'div', {
        attributes: ['aria-describedby', 'desc-1'],
        children: [createElement(3, 'span'), createElement(4, 'span')],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT flatten div with aria-labelledby', () => {
      const wrapper = createElement(2, 'div', {
        attributes: ['aria-labelledby', 'label-1'],
        children: [createElement(3, 'span'), createElement(4, 'span')],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT flatten non-div element', () => {
      const wrapper = createElement(2, 'span', {
        children: [
          createElement(3, 'a'),
          createElement(4, 'a'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
      expect(result.children![0].localName).toBe('span');
    });

    it('should NOT flatten scrollable div', () => {
      const wrapper = createElement(2, 'div', {
        scrollable: 'vertical',
        children: [
          createElement(3, 'p'),
          createElement(4, 'p'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT flatten semantic tier div', () => {
      const wrapper = createElement(2, 'div', {
        tier: 'semantic',
        children: [
          createElement(3, 'span'),
          createElement(4, 'span'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should flatten zero-width bounding box div', () => {
      const wrapper = createElement(2, 'div', {
        boundingBox: { x: 0, y: 0, width: 0, height: 100 },
        children: [
          createElement(3, 'button', { tier: 'semantic' }),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      // Zero-width div is meaningless
      expect(result.children!.length).toBe(1);
      expect(result.children![0].localName).toBe('button');
    });

    it('should flatten zero-height bounding box div', () => {
      const wrapper = createElement(2, 'div', {
        boundingBox: { x: 0, y: 0, width: 100, height: 0 },
        children: [
          createElement(3, 'span'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
      expect(result.children![0].localName).toBe('span');
    });

    it('should NOT flatten div with expanded accessibility state', () => {
      const wrapper = createElement(2, 'div', {
        accessibility: { role: 'generic', expanded: true },
        children: [
          createElement(3, 'span'),
          createElement(4, 'span'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT flatten div with accessibility name', () => {
      const wrapper = createElement(2, 'div', {
        accessibility: { role: 'generic', name: 'Important section' },
        children: [
          createElement(3, 'span'),
          createElement(4, 'span'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });

    it('should NOT flatten div with accessibility description', () => {
      const wrapper = createElement(2, 'div', {
        accessibility: { role: 'generic', description: 'Some description' },
        children: [
          createElement(3, 'span'),
          createElement(4, 'span'),
        ],
      });
      const parent = createElement(1, 'section', {
        children: [wrapper],
      });
      const result = simplifier.simplify(parent);
      expect(result.children!.length).toBe(1);
    });
  });

  describe('hoistChildren - recursive container hoisting', () => {
    it('should hoist through chain of meaningless single-child divs', () => {
      const deep = createElement(4, 'button', { tier: 'semantic' });
      const mid2 = createElement(3, 'div', { children: [deep] });
      const mid1 = createElement(2, 'div', { children: [mid2] });
      const root = createElement(1, 'section', { children: [mid1] });

      const result = simplifier.simplify(root);
      // Chain of meaningless divs should be hoisted
      expect(result.children!.length).toBe(1);
      expect(result.children![0].localName).toBe('button');
    });

    it('should NOT hoist through semantic container', () => {
      const deep = createElement(4, 'button', { tier: 'semantic' });
      const nav = createElement(3, 'nav', { children: [deep] });
      const wrapper = createElement(2, 'div', { children: [nav] });
      const root = createElement(1, 'section', { children: [wrapper] });

      const result = simplifier.simplify(root);
      // nav should be preserved
      expect(result.children!.some(
        (c: VirtualNode) => c.localName === 'nav'
      )).toBe(true);
    });

    it('should recursively process multiple children during hoisting', () => {
      const child1 = createElement(3, 'div', {
        children: [createElement(5, 'button', { tier: 'semantic' })],
      });
      const child2 = createElement(4, 'div', {
        children: [createElement(6, 'a', { tier: 'semantic' })],
      });
      const parent = createElement(1, 'section', {
        children: [child1, child2],
      });

      const result = simplifier.simplify(parent);
      // Both inner divs should be flattened
      expect(result.children!.length).toBe(2);
      expect(result.children![0].localName).toBe('button');
      expect(result.children![1].localName).toBe('a');
    });
  });

  describe('attribute merging during hoisting', () => {
    it('should merge wrapper attributes to hoisted child', () => {
      const wrapper = createElement(1, 'div', {
        attributes: ['class', 'wrapper-class', 'data-x', 'val'],
        children: [
          createElement(2, 'button', {
            tier: 'semantic',
            accessibility: { role: 'button' },
            attributes: ['id', 'btn-1'],
          }),
        ],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('button');
      // Should have both child and wrapper attributes
      expect(result.attributes).toContain('id');
      expect(result.attributes).toContain('class');
      expect(result.attributes).toContain('data-x');
    });

    it('should let child attributes override wrapper attributes on conflict', () => {
      const wrapper = createElement(1, 'div', {
        attributes: ['class', 'wrapper', 'id', 'wrapper-id'],
        children: [
          createElement(2, 'span', {
            attributes: ['class', 'child-class'],
          }),
        ],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.localName).toBe('span');
      // Child class should win over wrapper class
      const classIndex = result.attributes!.indexOf('class');
      expect(result.attributes![classIndex + 1]).toBe('child-class');
      // Wrapper-only attributes should still be present
      expect(result.attributes).toContain('id');
    });

    it('should produce undefined attributes when both are empty', () => {
      const wrapper = createElement(1, 'div', {
        children: [createElement(2, 'span')],
      });
      const result = simplifier.simplify(wrapper);
      expect(result.attributes).toBeUndefined();
    });
  });

  describe('complex scenarios', () => {
    it('should handle deeply nested structure with mixed rules', () => {
      const tree = createElement(1, 'body', {
        children: [
          createElement(2, 'div', {
            children: [
              createElement(3, 'div', { // empty leaf -- removed
              }),
              createElement(4, 'div', { // meaningless, one child
                children: [
                  createElement(5, 'button', {
                    tier: 'semantic',
                    accessibility: { role: 'button' },
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      const result = simplifier.simplify(tree);
      expect(result.localName).toBe('body');
      // After empty div removal and flattening, should have button
      expect(result.children).toBeDefined();
    });

    it('should handle node using nodeName when localName is absent', () => {
      const wrapper: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'DIV',
        tier: 'structural',
        children: [createElement(2, 'span')],
      };
      const result = simplifier.simplify(wrapper);
      // DIV -> div, should be collapsible
      expect(result.localName).toBe('span');
    });
  });
});
