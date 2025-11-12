/**
 * Unit tests for NoiseFilter
 * Test script, style, meta removal
 */

import { describe, it, expect } from 'vitest';
import { NoiseFilter } from '../../../serializers/filters/NoiseFilter';
import { VirtualNode, NODE_TYPE_COMMENT } from '../../../types';

describe('NoiseFilter', () => {
  const filter = new NoiseFilter();

  const createNode = (options: Partial<VirtualNode> = {}): VirtualNode => {
    return {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 1,
      nodeName: 'DIV',
      tier: 'structural',
      ...options
    };
  };

  describe('script tag filtering', () => {
    it('should filter <script> elements', () => {
      const script = createNode({
        nodeName: 'SCRIPT',
        localName: 'script',
        nodeValue: 'console.log("test")'
      });

      const result = filter.filter(script);
      expect(result).toBeNull();
    });

    it('should filter script tags regardless of case', () => {
      const scriptUpper = createNode({
        nodeName: 'SCRIPT',
        localName: 'script'
      });

      const result = filter.filter(scriptUpper);
      expect(result).toBeNull();
    });
  });

  describe('style tag filtering', () => {
    it('should filter <style> elements', () => {
      const style = createNode({
        nodeName: 'STYLE',
        localName: 'style',
        nodeValue: 'body { margin: 0; }'
      });

      const result = filter.filter(style);
      expect(result).toBeNull();
    });
  });

  describe('meta tag filtering', () => {
    it('should filter <meta> elements', () => {
      const meta = createNode({
        nodeName: 'META',
        localName: 'meta',
        attributes: ['name', 'description', 'content', 'test']
      });

      const result = filter.filter(meta);
      expect(result).toBeNull();
    });
  });

  describe('link tag filtering', () => {
    it('should filter <link> elements', () => {
      const link = createNode({
        nodeName: 'LINK',
        localName: 'link',
        attributes: ['rel', 'stylesheet', 'href', 'styles.css']
      });

      const result = filter.filter(link);
      expect(result).toBeNull();
    });
  });

  describe('noscript tag filtering', () => {
    it('should filter <noscript> elements', () => {
      const noscript = createNode({
        nodeName: 'NOSCRIPT',
        localName: 'noscript'
      });

      const result = filter.filter(noscript);
      expect(result).toBeNull();
    });
  });

  describe('title tag filtering', () => {
    it('should filter <title> elements', () => {
      const title = createNode({
        nodeName: 'TITLE',
        localName: 'title',
        nodeValue: 'Page Title'
      });

      const result = filter.filter(title);
      expect(result).toBeNull();
    });
  });

  describe('comment node filtering', () => {
    it('should filter HTML comments', () => {
      const comment = createNode({
        nodeType: NODE_TYPE_COMMENT,
        nodeName: '#comment',
        nodeValue: 'This is a comment'
      });

      const result = filter.filter(comment);
      expect(result).toBeNull();
    });
  });

  describe('base tag filtering', () => {
    it('should filter <base> elements', () => {
      const base = createNode({
        nodeName: 'BASE',
        localName: 'base',
        attributes: ['href', 'https://example.com/']
      });

      const result = filter.filter(base);
      expect(result).toBeNull();
    });
  });

  describe('preserving content elements', () => {
    it('should preserve semantic elements', () => {
      const button = createNode({
        nodeName: 'BUTTON',
        localName: 'button',
        tier: 'semantic'
      });

      const result = filter.filter(button);
      expect(result).not.toBeNull();
    });

    it('should preserve structural elements', () => {
      const div = createNode({
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural'
      });

      const result = filter.filter(div);
      expect(result).not.toBeNull();
    });
  });

  describe('recursive filtering', () => {
    it('should filter noise elements within content', () => {
      const parent = createNode({
        nodeName: 'DIV',
        localName: 'div',
        children: [
          createNode({
            backendNodeId: 2,
            nodeName: 'SCRIPT',
            localName: 'script'
          }),
          createNode({
            backendNodeId: 3,
            nodeName: 'BUTTON',
            localName: 'button',
            tier: 'semantic'
          }),
          createNode({
            backendNodeId: 4,
            nodeName: 'STYLE',
            localName: 'style'
          })
        ]
      });

      const result = filter.filter(parent);
      expect(result).not.toBeNull();
      expect(result?.children).toHaveLength(1);
      expect(result?.children?.[0].nodeName).toBe('BUTTON');
    });
  });

  describe('real-world scenarios', () => {
    it('should clean typical HTML head section', () => {
      const head = createNode({
        nodeName: 'HEAD',
        localName: 'head',
        children: [
          createNode({
            backendNodeId: 2,
            nodeName: 'TITLE',
            localName: 'title'
          }),
          createNode({
            backendNodeId: 3,
            nodeName: 'META',
            localName: 'meta'
          }),
          createNode({
            backendNodeId: 4,
            nodeName: 'LINK',
            localName: 'link'
          }),
          createNode({
            backendNodeId: 5,
            nodeName: 'SCRIPT',
            localName: 'script'
          }),
          createNode({
            backendNodeId: 6,
            nodeName: 'STYLE',
            localName: 'style'
          })
        ]
      });

      const result = filter.filter(head);
      // Head element preserved but children filtered
      expect(result).not.toBeNull();
      expect(result?.children).toBeUndefined(); // All noise children filtered
    });

    it('should preserve content while filtering embedded scripts', () => {
      const body = createNode({
        nodeName: 'BODY',
        localName: 'body',
        children: [
          createNode({
            backendNodeId: 2,
            nodeName: 'DIV',
            localName: 'div',
            children: [
              createNode({
                backendNodeId: 3,
                nodeName: 'BUTTON',
                localName: 'button',
                tier: 'semantic'
              }),
              createNode({
                backendNodeId: 4,
                nodeName: 'SCRIPT',
                localName: 'script' // Inline analytics script
              })
            ]
          })
        ]
      });

      const result = filter.filter(body);
      expect(result).not.toBeNull();

      // Button preserved, script filtered
      const div = result?.children?.[0];
      expect(div).toBeDefined();
      expect(div?.children).toHaveLength(1);
      expect(div?.children?.[0].nodeName).toBe('BUTTON');
    });
  });
});
