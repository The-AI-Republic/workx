/**
 * Unit tests for ClickableTextAggregator
 * Covers: isClickable branches, aggregateText traversal, getTextAlternative priority,
 * isInvisible inline styles, and edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClickableTextAggregator } from '../../../serializers/simplifiers/ClickableTextAggregator';
import type { VirtualNode } from '../../../types';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT } from '../../../types';

describe('ClickableTextAggregator', () => {
  let aggregator: ClickableTextAggregator;

  beforeEach(() => {
    aggregator = new ClickableTextAggregator();
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

  describe('isClickable detection', () => {
    it('should detect interactionType=click', () => {
      const node = createElement(1, 'div', {
        interactionType: 'click',
        children: [createTextNode(2, 'Click me')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Click me');
      expect(result.children).toEqual([]);
    });

    it('should detect interactionType=link', () => {
      const node = createElement(1, 'div', {
        interactionType: 'link',
        children: [createTextNode(2, 'Go here')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Go here');
    });

    it('should detect accessibility role button', () => {
      const node = createElement(1, 'div', {
        accessibility: { role: 'button' },
        children: [createTextNode(2, 'Press')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Press');
    });

    it('should detect accessibility role link', () => {
      const node = createElement(1, 'div', {
        accessibility: { role: 'link' },
        children: [createTextNode(2, 'Navigate')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Navigate');
    });

    it('should detect accessibility role tab', () => {
      const node = createElement(1, 'div', {
        accessibility: { role: 'tab' },
        children: [createTextNode(2, 'Tab name')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Tab name');
    });

    it('should detect accessibility role menuitem', () => {
      const node = createElement(1, 'div', {
        accessibility: { role: 'menuitem' },
        children: [createTextNode(2, 'Menu item')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Menu item');
    });

    it('should detect accessibility role checkbox', () => {
      const node = createElement(1, 'div', {
        accessibility: { role: 'checkbox' },
        children: [createTextNode(2, 'Check me')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Check me');
    });

    it('should detect accessibility role radio', () => {
      const node = createElement(1, 'div', {
        accessibility: { role: 'radio' },
        children: [createTextNode(2, 'Option A')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Option A');
    });

    it('should detect accessibility role switch', () => {
      const node = createElement(1, 'div', {
        accessibility: { role: 'switch' },
        children: [createTextNode(2, 'Toggle')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Toggle');
    });

    it('should detect <a> tag as clickable', () => {
      const node = createElement(1, 'a', {
        children: [createTextNode(2, 'Link text')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Link text');
    });

    it('should detect <button> tag as clickable', () => {
      const node = createElement(1, 'button', {
        children: [createTextNode(2, 'Button text')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Button text');
    });

    it('should NOT detect non-clickable element', () => {
      const node = createElement(1, 'div', {
        children: [createTextNode(2, 'Plain text')],
      });
      const result = aggregator.simplify(node);
      // Should not aggregate -- children should remain
      expect(result.nodeValue).toBeUndefined();
      expect(result.children!.length).toBe(1);
    });

    it('should NOT detect element with non-clickable role', () => {
      const node = createElement(1, 'div', {
        accessibility: { role: 'heading' },
        children: [createTextNode(2, 'Title')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBeUndefined();
    });

    it('should detect using nodeName fallback when localName is missing', () => {
      const node: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'A',
        // no localName
        tier: 'structural',
        children: [createTextNode(2, 'Fallback link')],
      };
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Fallback link');
    });
  });

  describe('aggregateText', () => {
    it('should aggregate text from deeply nested descendants', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            children: [
              createElement(3, 'span', {
                children: [createTextNode(4, 'Deep text')],
              }),
            ],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Deep text');
      expect(result.children).toEqual([]);
    });

    it('should join multiple text nodes with space', () => {
      const node = createElement(1, 'a', {
        children: [
          createElement(2, 'span', {
            children: [createTextNode(3, 'Hello')],
          }),
          createElement(4, 'span', {
            children: [createTextNode(5, 'World')],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Hello World');
    });

    it('should trim whitespace from text nodes', () => {
      const node = createElement(1, 'button', {
        children: [createTextNode(2, '  padded  ')],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('padded');
    });

    it('should skip empty text nodes', () => {
      const node = createElement(1, 'button', {
        children: [
          createTextNode(2, '  '),
          createTextNode(3, 'Content'),
          createTextNode(4, '   '),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Content');
    });

    it('should return empty aggregated text for clickable with no visible text', () => {
      const node = createElement(1, 'button', {
        children: [createElement(2, 'span')],
      });
      const result = aggregator.simplify(node);
      // No text found, aggregatedText is empty, so node is returned as-is
      expect(result.nodeValue).toBeUndefined();
      expect(result.children).toBeDefined();
    });
  });

  describe('getTextAlternative for img/svg', () => {
    it('should extract aria-label from img element (priority 1)', () => {
      const node = createElement(1, 'a', {
        children: [
          createElement(2, 'img', {
            attributes: ['aria-label', 'Logo image', 'alt', 'Logo alt'],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      // aria-label takes priority over alt
      expect(result.nodeValue).toBe('Logo image');
    });

    it('should extract alt from img element (priority 2)', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'img', {
            attributes: ['alt', 'Profile picture'],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Profile picture');
    });

    it('should extract title from img element (priority 3)', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'img', {
            attributes: ['title', 'Tooltip text'],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Tooltip text');
    });

    it('should use accessibility name from img (priority 4)', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'img', {
            accessibility: { role: 'img', name: 'Accessible name' },
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Accessible name');
    });

    it('should extract aria-label from svg element', () => {
      const node = createElement(1, 'a', {
        children: [
          createElement(2, 'svg', {
            attributes: ['aria-label', 'Menu icon'],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Menu icon');
    });

    it('should not traverse children of img/svg with text alternative', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'svg', {
            attributes: ['aria-label', 'Icon'],
            children: [createTextNode(3, 'SVG internal text')],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      // Should use aria-label, not traverse into SVG children
      expect(result.nodeValue).toBe('Icon');
    });

    it('should ignore img/svg without any text alternative', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'img'),
          createTextNode(3, 'Button text'),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Button text');
    });

    it('should trim aria-label value', () => {
      const node = createElement(1, 'a', {
        children: [
          createElement(2, 'img', {
            attributes: ['aria-label', '  padded label  '],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('padded label');
    });

    it('should trim alt attribute value', () => {
      const node = createElement(1, 'a', {
        children: [
          createElement(2, 'img', {
            attributes: ['alt', '  padded alt  '],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('padded alt');
    });

    it('should trim title attribute value', () => {
      const node = createElement(1, 'a', {
        children: [
          createElement(2, 'img', {
            attributes: ['title', '  padded title  '],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('padded title');
    });

    it('should trim accessibility name', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'svg', {
            accessibility: { role: 'img', name: '  padded a11y  ' },
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('padded a11y');
    });

    it('should skip empty aria-label', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'img', {
            attributes: ['aria-label', '', 'alt', 'Fallback'],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Fallback');
    });

    it('should skip empty alt', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'img', {
            attributes: ['alt', '', 'title', 'Title fallback'],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Title fallback');
    });

    it('should skip empty title', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'img', {
            attributes: ['title', ''],
            accessibility: { role: 'img', name: 'A11y fallback' },
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('A11y fallback');
    });
  });

  describe('isInvisible', () => {
    it('should skip element with display:none computed style', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            computedStyle: { display: 'none' },
            children: [createTextNode(3, 'Hidden text')],
          }),
          createTextNode(4, 'Visible text'),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Visible text');
    });

    it('should skip element with visibility:hidden computed style', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            computedStyle: { visibility: 'hidden' },
            children: [createTextNode(3, 'Hidden text')],
          }),
          createTextNode(4, 'Visible text'),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Visible text');
    });

    it('should skip element with inline style display:none', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            attributes: ['style', 'display:none'],
            children: [createTextNode(3, 'Hidden')],
          }),
          createTextNode(4, 'Shown'),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Shown');
    });

    it('should skip element with inline style display: none (with space)', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            attributes: ['style', 'display: none'],
            children: [createTextNode(3, 'Hidden')],
          }),
          createTextNode(4, 'Shown'),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Shown');
    });

    it('should skip element with inline style visibility:hidden', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            attributes: ['style', 'visibility:hidden'],
            children: [createTextNode(3, 'Hidden')],
          }),
          createTextNode(4, 'Shown'),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Shown');
    });

    it('should skip element with inline style visibility: hidden (with space)', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            attributes: ['style', 'visibility: hidden'],
            children: [createTextNode(3, 'Hidden')],
          }),
          createTextNode(4, 'Shown'),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Shown');
    });

    it('should NOT skip visible element with non-hidden style', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            attributes: ['style', 'color: red'],
            children: [createTextNode(3, 'Red text')],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      expect(result.nodeValue).toBe('Red text');
    });

    it('should check style attribute specifically (not other attributes)', () => {
      const node = createElement(1, 'button', {
        children: [
          createElement(2, 'span', {
            attributes: ['class', 'display:none', 'id', 'test'],
            children: [createTextNode(3, 'Visible')],
          }),
        ],
      });
      const result = aggregator.simplify(node);
      // class attribute with 'display:none' should not trigger invisible
      expect(result.nodeValue).toBe('Visible');
    });
  });

  describe('recursive simplification', () => {
    it('should simplify children before aggregating parent', () => {
      // Inner clickable gets simplified first
      const innerButton = createElement(3, 'button', {
        children: [
          createElement(4, 'span', {
            children: [createTextNode(5, 'Inner')],
          }),
        ],
      });
      const outerDiv = createElement(1, 'div', {
        children: [innerButton],
      });
      const result = aggregator.simplify(outerDiv);
      // Inner button should have been aggregated
      const resultButton = result.children![0];
      expect(resultButton.nodeValue).toBe('Inner');
      expect(resultButton.children).toEqual([]);
    });

    it('should handle nested clickable elements', () => {
      const inner = createElement(2, 'a', {
        children: [createTextNode(3, 'Link')],
      });
      const outer = createElement(1, 'button', {
        children: [inner],
      });
      const result = aggregator.simplify(outer);
      // Inner link gets aggregated first during recursion (nodeValue='Link', children=[])
      // Outer button then aggregates, but inner <a> with empty children has no text nodes
      // So outer button gets empty aggregation and returns as-is
      // The inner <a> was already simplified though
      expect(result.children).toBeDefined();
      expect(result.children!.length).toBe(1);
      expect(result.children![0].nodeValue).toBe('Link');
    });
  });
});
