/**
 * Unit tests for AttributeDeduplicator
 * Covers: implicit role removal, empty attribute removal, custom role preservation,
 * recursive processing, and edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AttributeDeduplicator } from '../../../serializers/simplifiers/AttributeDeduplicator';
import type { VirtualNode } from '../../../types';
import { NODE_TYPE_ELEMENT } from '../../../types';

describe('AttributeDeduplicator', () => {
  let deduplicator: AttributeDeduplicator;

  beforeEach(() => {
    deduplicator = new AttributeDeduplicator();
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

  describe('deduplicate', () => {
    it('should remove redundant role=button on <button>', () => {
      const node = createElement(1, 'button', {
        attributes: ['role', 'button', 'type', 'submit'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['type', 'submit']);
    });

    it('should remove redundant role=link on <a>', () => {
      const node = createElement(1, 'a', {
        attributes: ['role', 'link', 'href', '/home'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['href', '/home']);
    });

    it('should remove redundant role=textbox on <input>', () => {
      const node = createElement(1, 'input', {
        attributes: ['role', 'textbox', 'name', 'email'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['name', 'email']);
    });

    it('should remove redundant role=textbox on <textarea>', () => {
      const node = createElement(1, 'textarea', {
        attributes: ['role', 'textbox'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toBeUndefined();
    });

    it('should remove redundant role=combobox on <select>', () => {
      const node = createElement(1, 'select', {
        attributes: ['role', 'combobox', 'name', 'country'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['name', 'country']);
    });

    it('should remove redundant role=navigation on <nav>', () => {
      const node = createElement(1, 'nav', {
        attributes: ['role', 'navigation'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toBeUndefined();
    });

    it('should preserve custom role on <button>', () => {
      const node = createElement(1, 'button', {
        attributes: ['role', 'tab'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['role', 'tab']);
    });

    it('should preserve custom role on <div>', () => {
      const node = createElement(1, 'div', {
        attributes: ['role', 'dialog'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['role', 'dialog']);
    });

    it('should remove empty attribute value', () => {
      const node = createElement(1, 'div', {
        attributes: ['class', '', 'id', 'test'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['id', 'test']);
    });

    it('should remove whitespace-only attribute value', () => {
      const node = createElement(1, 'div', {
        attributes: ['class', '   ', 'id', 'test'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['id', 'test']);
    });

    it('should return undefined when all attributes are removed', () => {
      const node = createElement(1, 'button', {
        attributes: ['role', 'button', 'type', ''],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toBeUndefined();
    });

    it('should return undefined when node has no attributes', () => {
      const node = createElement(1, 'div');
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toBeUndefined();
    });

    it('should return undefined when attributes array is empty', () => {
      const node = createElement(1, 'div', { attributes: [] });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toBeUndefined();
    });

    it('should process children recursively', () => {
      const parent = createElement(1, 'div', {
        attributes: ['id', 'parent'],
        children: [
          createElement(2, 'button', {
            attributes: ['role', 'button', 'id', 'btn'],
          }),
          createElement(3, 'a', {
            attributes: ['role', 'link', 'href', '/page'],
          }),
        ],
      });
      const result = deduplicator.deduplicate(parent);
      expect(result.children!.length).toBe(2);
      expect(result.children![0].attributes).toEqual(['id', 'btn']);
      expect(result.children![1].attributes).toEqual(['href', '/page']);
    });

    it('should handle node using nodeName when localName is missing', () => {
      const node: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'BUTTON',
        // no localName
        tier: 'structural',
        attributes: ['role', 'button'],
      };
      const result = deduplicator.deduplicate(node);
      // Should detect implicit role via BUTTON -> button -> button
      expect(result.attributes).toBeUndefined();
    });

    it('should handle leaf node (no children)', () => {
      const node = createElement(1, 'span', {
        attributes: ['class', 'highlight'],
      });
      const result = deduplicator.deduplicate(node);
      expect(result.attributes).toEqual(['class', 'highlight']);
      expect(result.children).toBeUndefined();
    });

    it('should handle all semantic tag implicit roles', () => {
      const tags: Array<[string, string]> = [
        ['main', 'main'],
        ['header', 'banner'],
        ['footer', 'contentinfo'],
        ['aside', 'complementary'],
        ['form', 'form'],
        ['article', 'article'],
        ['section', 'region'],
      ];

      for (const [tag, role] of tags) {
        const node = createElement(1, tag, {
          attributes: ['role', role],
        });
        const result = deduplicator.deduplicate(node);
        expect(result.attributes).toBeUndefined();
      }
    });
  });
});
