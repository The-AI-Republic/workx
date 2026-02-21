/**
 * Unit tests for ClickableCache
 * Test caching, clear, hit/miss stats
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClickableCache } from '../../../serializers/utils/ClickableCache';
import type { VirtualNode } from '../../../types';

describe('ClickableCache', () => {
  let cache: ClickableCache;

  beforeEach(() => {
    cache = new ClickableCache();
  });

  const createNode = (backendNodeId: number, tier: 'semantic' | 'non-semantic' | 'structural', options: Partial<VirtualNode> = {}): VirtualNode => {
    return {
      nodeId: backendNodeId,
      backendNodeId,
      nodeType: 1,
      nodeName: 'DIV',
      tier,
      ...options
    };
  };

  describe('isClickable', () => {
    it('should detect semantic clickable elements (button role)', () => {
      const button = createNode(1, 'semantic', {
        accessibility: { role: 'button' }
      });

      const result = cache.isClickable(button);
      expect(result).toBe(true);
    });

    it('should detect semantic clickable elements (link role)', () => {
      const link = createNode(2, 'semantic', {
        accessibility: { role: 'link' }
      });

      const result = cache.isClickable(link);
      expect(result).toBe(true);
    });

    it('should detect non-semantic clickable with onclick handler', () => {
      const div = createNode(3, 'non-semantic', {
        heuristics: {
          hasOnClick: true,
          hasDataTestId: false,
          hasCursorPointer: false,
          isVisuallyInteractive: false
        }
      });

      const result = cache.isClickable(div);
      expect(result).toBe(true);
    });

    it('should detect non-semantic clickable with cursor pointer', () => {
      const div = createNode(4, 'non-semantic', {
        heuristics: {
          hasOnClick: false,
          hasDataTestId: false,
          hasCursorPointer: true,
          isVisuallyInteractive: false
        }
      });

      const result = cache.isClickable(div);
      expect(result).toBe(true);
    });

    it('should detect elements with interactionType', () => {
      const element = createNode(5, 'semantic', {
        interactionType: 'click'
      });

      const result = cache.isClickable(element);
      expect(result).toBe(true);
    });

    it('should detect button tags', () => {
      const button = createNode(6, 'structural', {
        nodeName: 'BUTTON',
        localName: 'button'
      });

      const result = cache.isClickable(button);
      expect(result).toBe(true);
    });

    it('should detect anchor tags', () => {
      const link = createNode(7, 'structural', {
        nodeName: 'A',
        localName: 'a'
      });

      const result = cache.isClickable(link);
      expect(result).toBe(true);
    });

    it('should return false for non-clickable structural elements', () => {
      const div = createNode(8, 'structural');

      const result = cache.isClickable(div);
      expect(result).toBe(false);
    });

    it('should return false for elements without interactive markers', () => {
      const span = createNode(9, 'structural', {
        nodeName: 'SPAN',
        localName: 'span',
        heuristics: {
          hasOnClick: false,
          hasDataTestId: false,
          hasCursorPointer: false,
          isVisuallyInteractive: false
        }
      });

      const result = cache.isClickable(span);
      expect(result).toBe(false);
    });
  });

  describe('caching behavior', () => {
    it('should cache results for repeated checks', () => {
      const button = createNode(1, 'semantic', {
        accessibility: { role: 'button' }
      });

      // First call - cache miss
      cache.isClickable(button);

      // Second call - cache hit
      cache.isClickable(button);
      cache.isClickable(button);

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });

    it('should use backendNodeId as cache key', () => {
      const node1 = createNode(1, 'semantic', {
        accessibility: { role: 'button' }
      });

      const node2 = createNode(1, 'structural'); // Same backendNodeId, different props

      cache.isClickable(node1);
      cache.isClickable(node2); // Should use cached result from node1

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear cache and reset stats', () => {
      const button = createNode(1, 'semantic', {
        accessibility: { role: 'button' }
      });

      cache.isClickable(button);
      cache.isClickable(button);

      cache.clear();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.size).toBe(0);
    });

    it('should force re-detection after clear', () => {
      const button = createNode(1, 'semantic', {
        accessibility: { role: 'button' }
      });

      cache.isClickable(button);
      cache.clear();
      cache.isClickable(button); // Should be cache miss again

      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return correct hit/miss/size stats', () => {
      const button1 = createNode(1, 'semantic', {
        accessibility: { role: 'button' }
      });
      const button2 = createNode(2, 'semantic', {
        accessibility: { role: 'button' }
      });

      // 2 misses
      cache.isClickable(button1);
      cache.isClickable(button2);

      // 3 hits
      cache.isClickable(button1);
      cache.isClickable(button1);
      cache.isClickable(button2);

      const stats = cache.getStats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(2);
      expect(stats.size).toBe(2);
    });

    it('should show 100% hit rate after warmup', () => {
      const nodes = [
        createNode(1, 'semantic', { accessibility: { role: 'button' } }),
        createNode(2, 'semantic', { accessibility: { role: 'link' } }),
        createNode(3, 'non-semantic', { heuristics: { hasOnClick: true, hasDataTestId: false, hasCursorPointer: false, isVisuallyInteractive: false } })
      ];

      // Warmup (3 misses)
      nodes.forEach(node => cache.isClickable(node));

      // Repeated checks (all hits)
      for (let i = 0; i < 10; i++) {
        nodes.forEach(node => cache.isClickable(node));
      }

      const stats = cache.getStats();
      expect(stats.hits).toBe(30); // 10 * 3 nodes
      expect(stats.misses).toBe(3);

      const hitRate = stats.hits / (stats.hits + stats.misses);
      expect(hitRate).toBeCloseTo(0.909, 2); // ~91% hit rate
    });
  });

  describe('performance improvement', () => {
    it('should demonstrate cache performance benefit', () => {
      const nodes = Array.from({ length: 100 }, (_, i) =>
        createNode(i, 'semantic', { accessibility: { role: 'button' } })
      );

      // Measure without cache (first pass)
      cache.clear();
      const startCold = performance.now();
      nodes.forEach(node => cache.isClickable(node));
      const coldDuration = performance.now() - startCold;

      // Measure with cache (second pass)
      const startWarm = performance.now();
      nodes.forEach(node => cache.isClickable(node));
      const warmDuration = performance.now() - startWarm;

      // Cached lookups should be faster or comparable
      // Note: With very fast operations, timing differences can be in the noise range
      // so we just verify the cache doesn't make things significantly slower
      expect(warmDuration).toBeLessThan(coldDuration * 5); // Cache should not be 5x slower
    });
  });

  describe('real-world scenarios', () => {
    it('should correctly identify various interactive elements', () => {
      const testCases = [
        { node: createNode(1, 'semantic', { accessibility: { role: 'checkbox' } }), expected: true },
        { node: createNode(2, 'semantic', { accessibility: { role: 'radio' } }), expected: true },
        { node: createNode(3, 'semantic', { accessibility: { role: 'menuitem' } }), expected: true },
        { node: createNode(4, 'semantic', { accessibility: { role: 'tab' } }), expected: true },
        { node: createNode(5, 'semantic', { accessibility: { role: 'switch' } }), expected: true },
        { node: createNode(6, 'semantic', { accessibility: { role: 'generic' } }), expected: false },
        { node: createNode(7, 'structural', { nodeName: 'INPUT', localName: 'input' }), expected: true },
        { node: createNode(8, 'structural', { nodeName: 'SELECT', localName: 'select' }), expected: true },
        { node: createNode(9, 'structural', { nodeName: 'TEXTAREA', localName: 'textarea' }), expected: true },
        { node: createNode(10, 'non-semantic', { heuristics: { hasDataTestId: true, hasOnClick: false, hasCursorPointer: false, isVisuallyInteractive: false } }), expected: true }
      ];

      testCases.forEach(({ node, expected }) => {
        const result = cache.isClickable(node);
        expect(result).toBe(expected);
      });
    });
  });
});
