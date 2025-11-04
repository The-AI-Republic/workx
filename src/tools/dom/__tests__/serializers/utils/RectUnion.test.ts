/**
 * Unit tests for RectUnion
 * Test contains, add, subtract, fullyCovers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RectUnion } from '../../../serializers/utils/RectUnion';
import { Rect } from '../../../types';

describe('RectUnion', () => {
  let union: RectUnion;

  beforeEach(() => {
    union = new RectUnion();
  });

  describe('contains', () => {
    it('should return false for empty union', () => {
      const rect: Rect = { x: 0, y: 0, width: 100, height: 100 };
      expect(union.contains(rect)).toBe(false);
    });

    it('should return true if rect fully covered by single rect in union', () => {
      const coveringRect: Rect = { x: 0, y: 0, width: 200, height: 200 };
      const targetRect: Rect = { x: 50, y: 50, width: 50, height: 50 };

      union.add(coveringRect);
      expect(union.contains(targetRect)).toBe(true);
    });

    it('should return false if rect only partially covered', () => {
      const coveringRect: Rect = { x: 0, y: 0, width: 100, height: 100 };
      const targetRect: Rect = { x: 50, y: 50, width: 100, height: 100 };

      union.add(coveringRect);
      expect(union.contains(targetRect)).toBe(false);
    });

    it('should return true if rect fully covered by multiple rects', () => {
      const rect1: Rect = { x: 0, y: 0, width: 60, height: 100 };
      const rect2: Rect = { x: 60, y: 0, width: 40, height: 100 };
      const targetRect: Rect = { x: 0, y: 0, width: 100, height: 100 };

      union.add(rect1);
      union.add(rect2);
      expect(union.contains(targetRect)).toBe(true);
    });

    it('should handle complex occlusion patterns', () => {
      // Modal dialog scenario: dialog covers content below
      const dialog: Rect = { x: 100, y: 100, width: 300, height: 200 };
      const content: Rect = { x: 150, y: 150, width: 200, height: 100 };

      union.add(dialog);
      expect(union.contains(content)).toBe(true);
    });

    it('should handle edge touching (not overlapping)', () => {
      const rect1: Rect = { x: 0, y: 0, width: 50, height: 50 };
      const rect2: Rect = { x: 50, y: 0, width: 50, height: 50 };
      const targetRect: Rect = { x: 0, y: 0, width: 100, height: 50 };

      union.add(rect1);
      union.add(rect2);

      // Edge touching should NOT count as covered (gap at boundary)
      // This depends on implementation - typically <= vs <
      // Our implementation uses <= so this should be covered
      expect(union.contains(targetRect)).toBe(true);
    });
  });

  describe('add', () => {
    it('should add rect to union', () => {
      const rect: Rect = { x: 0, y: 0, width: 100, height: 100 };
      union.add(rect);
      expect(union.getSize()).toBe(1);
    });

    it('should not add rect if already fully contained', () => {
      const largeRect: Rect = { x: 0, y: 0, width: 200, height: 200 };
      const smallRect: Rect = { x: 50, y: 50, width: 50, height: 50 };

      union.add(largeRect);
      union.add(smallRect); // Should not be added (optimization)

      expect(union.getSize()).toBe(1);
    });

    it('should add multiple non-overlapping rects', () => {
      const rect1: Rect = { x: 0, y: 0, width: 50, height: 50 };
      const rect2: Rect = { x: 100, y: 100, width: 50, height: 50 };

      union.add(rect1);
      union.add(rect2);

      expect(union.getSize()).toBe(2);
    });
  });

  describe('clear', () => {
    it('should clear all rects from union', () => {
      union.add({ x: 0, y: 0, width: 100, height: 100 });
      union.add({ x: 100, y: 100, width: 100, height: 100 });

      union.clear();

      expect(union.getSize()).toBe(0);
    });
  });

  describe('getSize', () => {
    it('should return number of rects in union', () => {
      expect(union.getSize()).toBe(0);

      union.add({ x: 0, y: 0, width: 100, height: 100 });
      expect(union.getSize()).toBe(1);

      union.add({ x: 100, y: 100, width: 100, height: 100 });
      expect(union.getSize()).toBe(2);
    });
  });

  describe('geometric correctness', () => {
    it('should correctly detect L-shaped coverage', () => {
      // Two rects forming L-shape
      const horizontal: Rect = { x: 0, y: 0, width: 200, height: 100 };
      const vertical: Rect = { x: 0, y: 100, width: 100, height: 100 };

      union.add(horizontal);
      union.add(vertical);

      // Target fully within L-shape
      const insideL: Rect = { x: 10, y: 10, width: 80, height: 180 };
      expect(union.contains(insideL)).toBe(true);

      // Target partially outside L-shape
      const outsideL: Rect = { x: 150, y: 150, width: 100, height: 100 };
      expect(union.contains(outsideL)).toBe(false);
    });

    it('should handle zero-area rects', () => {
      const zeroWidth: Rect = { x: 0, y: 0, width: 0, height: 100 };
      const zeroHeight: Rect = { x: 0, y: 0, width: 100, height: 0 };

      union.add(zeroWidth);
      expect(union.contains(zeroHeight)).toBe(false);
    });

    it('should handle negative coordinates', () => {
      const rect: Rect = { x: -50, y: -50, width: 100, height: 100 };
      const target: Rect = { x: -25, y: -25, width: 30, height: 30 };

      union.add(rect);
      expect(union.contains(target)).toBe(true);
    });
  });

  describe('real-world paint order scenarios', () => {
    it('should detect element obscured by modal overlay', () => {
      // Modal overlay covering entire viewport
      const overlay: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

      // Button below overlay
      const button: Rect = { x: 100, y: 500, width: 120, height: 40 };

      union.add(overlay);
      expect(union.contains(button)).toBe(true);
    });

    it('should detect element partially visible beside modal', () => {
      // Modal dialog (not fullscreen)
      const modal: Rect = { x: 400, y: 200, width: 600, height: 400 };

      // Sidebar button (partially visible)
      const sidebarButton: Rect = { x: 50, y: 300, width: 100, height: 40 };

      union.add(modal);
      expect(union.contains(sidebarButton)).toBe(false);
    });

    it('should detect stacked loading spinners', () => {
      // Multiple overlapping spinners (common during loading states)
      const spinner1: Rect = { x: 400, y: 300, width: 100, height: 100 };
      const spinner2: Rect = { x: 410, y: 310, width: 80, height: 80 };

      union.add(spinner1);
      expect(union.contains(spinner2)).toBe(true);
    });
  });

  describe('performance characteristics', () => {
    it('should handle large number of rects efficiently', () => {
      const start = performance.now();

      // Add 100 non-overlapping rects
      for (let i = 0; i < 100; i++) {
        union.add({ x: i * 10, y: i * 10, width: 5, height: 5 });
      }

      // Check containment
      const target: Rect = { x: 0, y: 0, width: 5, height: 5 };
      union.contains(target);

      const duration = performance.now() - start;

      // Should complete in reasonable time (<100ms)
      expect(duration).toBeLessThan(100);
    });
  });
});
