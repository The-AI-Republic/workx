/**
 * Unit tests for TextCollapser
 * Covers merging consecutive text nodes, single text nodes, mixed children,
 * empty results, recursive processing, and edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TextCollapser } from '../../../serializers/simplifiers/TextCollapser';
import type { VirtualNode } from '../../../types';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT } from '../../../types';

describe('TextCollapser', () => {
  let collapser: TextCollapser;

  beforeEach(() => {
    collapser = new TextCollapser();
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

  const createTextNode = (
    id: number,
    text: string,
    options: Partial<VirtualNode> = {}
  ): VirtualNode => ({
    nodeId: id,
    backendNodeId: id,
    nodeType: NODE_TYPE_TEXT,
    nodeName: '#text',
    tier: 'structural',
    nodeValue: text,
    ...options,
  });

  describe('collapse', () => {
    it('should return leaf node unchanged', () => {
      const node = createElement(1, 'span');
      const result = collapser.collapse(node);
      expect(result).toEqual(node);
    });

    it('should return node with empty children unchanged', () => {
      const node = createElement(1, 'div', { children: [] });
      const result = collapser.collapse(node);
      // No children, returns as-is
      expect(result).toEqual(node);
    });

    it('should handle single non-text child', () => {
      const parent = createElement(1, 'div', {
        children: [createElement(2, 'span')],
      });
      const result = collapser.collapse(parent);
      expect(result.children).toBeDefined();
      expect(result.children!.length).toBe(1);
    });

    it('should handle single text child without merging', () => {
      const parent = createElement(1, 'p', {
        children: [createTextNode(2, 'Hello')],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(1);
      expect(result.children![0].nodeValue).toBe('Hello');
    });

    it('should merge two consecutive text nodes', () => {
      const parent = createElement(1, 'p', {
        children: [
          createTextNode(2, 'Hello '),
          createTextNode(3, 'world'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(1);
      expect(result.children![0].nodeValue).toBe('Hello world');
      // Should use first node as base
      expect(result.children![0].backendNodeId).toBe(2);
    });

    it('should merge three consecutive text nodes', () => {
      const parent = createElement(1, 'p', {
        children: [
          createTextNode(2, 'Hello '),
          createTextNode(3, 'beautiful '),
          createTextNode(4, 'world'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(1);
      expect(result.children![0].nodeValue).toBe('Hello beautiful world');
    });

    it('should not merge text nodes separated by element', () => {
      const parent = createElement(1, 'p', {
        children: [
          createTextNode(2, 'Hello '),
          createElement(3, 'br'),
          createTextNode(4, 'world'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(3);
      expect(result.children![0].nodeValue).toBe('Hello ');
      expect(result.children![1].localName).toBe('br');
      expect(result.children![2].nodeValue).toBe('world');
    });

    it('should merge consecutive text nodes at the beginning only', () => {
      const parent = createElement(1, 'p', {
        children: [
          createTextNode(2, 'Hello '),
          createTextNode(3, 'world'),
          createElement(4, 'span'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(2);
      expect(result.children![0].nodeValue).toBe('Hello world');
      expect(result.children![1].localName).toBe('span');
    });

    it('should merge consecutive text nodes at the end only', () => {
      const parent = createElement(1, 'p', {
        children: [
          createElement(2, 'span'),
          createTextNode(3, 'Hello '),
          createTextNode(4, 'world'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(2);
      expect(result.children![0].localName).toBe('span');
      expect(result.children![1].nodeValue).toBe('Hello world');
    });

    it('should handle multiple groups of consecutive text nodes', () => {
      const parent = createElement(1, 'p', {
        children: [
          createTextNode(2, 'A'),
          createTextNode(3, 'B'),
          createElement(4, 'br'),
          createTextNode(5, 'C'),
          createTextNode(6, 'D'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(3);
      expect(result.children![0].nodeValue).toBe('AB');
      expect(result.children![1].localName).toBe('br');
      expect(result.children![2].nodeValue).toBe('CD');
    });

    it('should handle text node with empty nodeValue', () => {
      const parent = createElement(1, 'p', {
        children: [
          createTextNode(2, ''),
          createTextNode(3, 'world'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(1);
      expect(result.children![0].nodeValue).toBe('world');
    });

    it('should handle text node with undefined nodeValue', () => {
      const textNode: VirtualNode = {
        nodeId: 2,
        backendNodeId: 2,
        nodeType: NODE_TYPE_TEXT,
        nodeName: '#text',
        tier: 'structural',
        // nodeValue is undefined
      };
      const parent = createElement(1, 'p', {
        children: [textNode, createTextNode(3, 'world')],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(1);
      expect(result.children![0].nodeValue).toBe('world');
    });

    it('should process children recursively before merging', () => {
      const innerParent = createElement(2, 'span', {
        children: [
          createTextNode(3, 'Inner '),
          createTextNode(4, 'text'),
        ],
      });
      const parent = createElement(1, 'div', {
        children: [innerParent],
      });
      const result = collapser.collapse(parent);
      expect(result.children![0].children!.length).toBe(1);
      expect(result.children![0].children![0].nodeValue).toBe('Inner text');
    });

    it('should handle deeply nested recursive collapsing', () => {
      const level3 = createElement(4, 'em', {
        children: [
          createTextNode(5, 'deep '),
          createTextNode(6, 'text'),
        ],
      });
      const level2 = createElement(3, 'span', {
        children: [level3],
      });
      const level1 = createElement(2, 'p', {
        children: [
          createTextNode(7, 'top '),
          createTextNode(8, 'level'),
          level2,
        ],
      });
      const root = createElement(1, 'div', { children: [level1] });
      const result = collapser.collapse(root);

      // Level 1: "top " + "level" merged, then <span>
      expect(result.children![0].children!.length).toBe(2);
      expect(result.children![0].children![0].nodeValue).toBe('top level');
      // Level 3: "deep " + "text" merged
      const deepSpan = result.children![0].children![1];
      expect(deepSpan.children![0].children![0].nodeValue).toBe('deep text');
    });

    it('should only have element children (no text nodes to merge)', () => {
      const parent = createElement(1, 'div', {
        children: [
          createElement(2, 'span'),
          createElement(3, 'p'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(2);
    });

    it('should handle a single text node in a list of many children', () => {
      const parent = createElement(1, 'div', {
        children: [
          createElement(2, 'span'),
          createTextNode(3, 'lone text'),
          createElement(4, 'p'),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children!.length).toBe(3);
      expect(result.children![1].nodeValue).toBe('lone text');
    });

    it('should preserve whitespace when merging', () => {
      const parent = createElement(1, 'p', {
        children: [
          createTextNode(2, '  Hello  '),
          createTextNode(3, '  world  '),
        ],
      });
      const result = collapser.collapse(parent);
      expect(result.children![0].nodeValue).toBe('  Hello    world  ');
    });
  });
});
