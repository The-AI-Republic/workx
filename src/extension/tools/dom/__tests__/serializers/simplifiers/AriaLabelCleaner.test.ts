/**
 * Unit tests for AriaLabelCleaner
 * Covers: text node cleaning, accessibility removal, element node preservation,
 * recursive simplification, and edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AriaLabelCleaner } from '../../../serializers/simplifiers/AriaLabelCleaner';
import type { VirtualNode } from '../../../types';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT } from '../../../types';

describe('AriaLabelCleaner', () => {
  let cleaner: AriaLabelCleaner;

  beforeEach(() => {
    cleaner = new AriaLabelCleaner();
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

  describe('simplify', () => {
    it('should remove accessibility from text node', () => {
      const textNode = createTextNode(1, 'Hello', {
        accessibility: { role: 'StaticText', name: 'Hello' },
      });
      const result = cleaner.simplify(textNode);
      expect(result.accessibility).toBeUndefined();
      expect(result.nodeValue).toBe('Hello');
    });

    it('should NOT modify text node without accessibility', () => {
      const textNode = createTextNode(1, 'Hello');
      const result = cleaner.simplify(textNode);
      expect(result).toEqual(textNode);
    });

    it('should NOT modify element node even if it has accessibility', () => {
      const element = createElement(1, 'button', {
        accessibility: { role: 'button', name: 'Submit' },
      });
      const result = cleaner.simplify(element);
      expect(result.accessibility).toBeDefined();
      expect(result.accessibility!.name).toBe('Submit');
    });

    it('should recursively clean text nodes in children', () => {
      const parent = createElement(1, 'div', {
        children: [
          createTextNode(2, 'Hello', {
            accessibility: { role: 'StaticText', name: 'Hello' },
          }),
          createTextNode(3, 'World', {
            accessibility: { role: 'StaticText', name: 'World' },
          }),
        ],
      });
      const result = cleaner.simplify(parent);
      expect(result.children!.length).toBe(2);
      expect(result.children![0].accessibility).toBeUndefined();
      expect(result.children![1].accessibility).toBeUndefined();
    });

    it('should preserve element accessibility while cleaning text children', () => {
      const parent = createElement(1, 'button', {
        accessibility: { role: 'button', name: 'Click me' },
        children: [
          createTextNode(2, 'Click me', {
            accessibility: { role: 'StaticText', name: 'Click me' },
          }),
        ],
      });
      const result = cleaner.simplify(parent);
      // Button accessibility preserved
      expect(result.accessibility).toBeDefined();
      expect(result.accessibility!.role).toBe('button');
      // Text node accessibility removed
      expect(result.children![0].accessibility).toBeUndefined();
    });

    it('should handle deeply nested text nodes', () => {
      const tree = createElement(1, 'div', {
        children: [
          createElement(2, 'span', {
            children: [
              createTextNode(3, 'Deep text', {
                accessibility: { role: 'StaticText', name: 'Deep text' },
              }),
            ],
          }),
        ],
      });
      const result = cleaner.simplify(tree);
      const deepText = result.children![0].children![0];
      expect(deepText.accessibility).toBeUndefined();
      expect(deepText.nodeValue).toBe('Deep text');
    });

    it('should handle node with no children', () => {
      const node = createElement(1, 'br');
      const result = cleaner.simplify(node);
      expect(result).toEqual(node);
    });

    it('should handle empty children array', () => {
      const node = createElement(1, 'div', { children: [] });
      const result = cleaner.simplify(node);
      expect(result.children).toEqual([]);
    });
  });
});
