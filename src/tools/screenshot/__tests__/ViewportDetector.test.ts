import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ViewportDetector, type ViewportBounds } from '../ViewportDetector';

describe('ViewportDetector', () => {
  let mockSendCommand: ReturnType<typeof vi.fn>;

  const DEFAULT_VIEWPORT: ViewportBounds = {
    width: 1920,
    height: 1080,
    scrollX: 0,
    scrollY: 0,
  };

  /**
   * Helper: build a content quad array from a bounding box.
   * CDP DOM.getBoxModel returns content as [x1,y1, x2,y1, x2,y2, x1,y2].
   */
  function makeContentQuad(x: number, y: number, w: number, h: number): number[] {
    return [x, y, x + w, y, x + w, y + h, x, y + h];
  }

  /**
   * Helper: create a boxModel response.
   */
  function boxModelResponse(x: number, y: number, w: number, h: number) {
    return { model: { content: makeContentQuad(x, y, w, h) } };
  }

  beforeEach(() => {
    mockSendCommand = vi.fn();
  });

  // ==========================================================================
  // getViewportBounds
  // ==========================================================================
  describe('getViewportBounds', () => {
    it('fetches viewport bounds via Runtime.evaluate', async () => {
      mockSendCommand.mockResolvedValue({
        result: { value: { width: 1024, height: 768, scrollX: 50, scrollY: 100 } },
      });

      const bounds = await ViewportDetector.getViewportBounds(mockSendCommand);

      expect(mockSendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
        expression:
          '({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })',
        returnByValue: true,
      });
      expect(bounds).toEqual({ width: 1024, height: 768, scrollX: 50, scrollY: 100 });
    });

    it('returns exact values from CDP response', async () => {
      mockSendCommand.mockResolvedValue({
        result: { value: { width: 800, height: 600, scrollX: 0, scrollY: 0 } },
      });

      const bounds = await ViewportDetector.getViewportBounds(mockSendCommand);

      expect(bounds.width).toBe(800);
      expect(bounds.height).toBe(600);
      expect(bounds.scrollX).toBe(0);
      expect(bounds.scrollY).toBe(0);
    });
  });

  // ==========================================================================
  // isInViewport — fully visible element
  // ==========================================================================
  describe('isInViewport — fully visible element', () => {
    it('returns inViewport true and 100% for element fully inside viewport', async () => {
      // Element at (100, 100) size 200x200, viewport 1920x1080, no scroll
      mockSendCommand.mockResolvedValue(boxModelResponse(100, 100, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        1,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(true);
      expect(result.visibilityPercent).toBe(100);
    });

    it('returns inViewport true for element at top-left corner', async () => {
      mockSendCommand.mockResolvedValue(boxModelResponse(0, 0, 100, 100));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        2,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(true);
      expect(result.visibilityPercent).toBe(100);
    });

    it('returns inViewport true for element at bottom-right edge of viewport', async () => {
      // Element: 100x100 placed at (1820, 980) — fits exactly within 1920x1080
      mockSendCommand.mockResolvedValue(boxModelResponse(1820, 980, 100, 100));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        3,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(true);
      expect(result.visibilityPercent).toBe(100);
    });
  });

  // ==========================================================================
  // isInViewport — partially visible element
  // ==========================================================================
  describe('isInViewport — partially visible element', () => {
    it('returns inViewport true when more than 50% is visible', async () => {
      // Element 200x200 at (1800, 0). Viewport width 1920.
      // Visible width = 1920 - 1800 = 120 px (out of 200)
      // Visible area = 120 * 200 = 24000, total = 40000, percent = 60%
      mockSendCommand.mockResolvedValue(boxModelResponse(1800, 0, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        4,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(true);
      expect(result.visibilityPercent).toBe(60);
    });

    it('returns inViewport false when exactly 50% is visible', async () => {
      // Element 200x200 at (1820, 0). Visible width = 1920 - 1820 = 100 (50% of 200)
      // Visible area = 100 * 200 = 20000, total = 40000, percent = 50%
      // Threshold is >50%, so 50% exactly should be false
      mockSendCommand.mockResolvedValue(boxModelResponse(1820, 0, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        5,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(50);
    });

    it('returns inViewport false when less than 50% is visible', async () => {
      // Element 200x200 at (1850, 0). Visible width = 1920 - 1850 = 70 (35%)
      // Visible area = 70 * 200 = 14000, total = 40000, percent = 35%
      mockSendCommand.mockResolvedValue(boxModelResponse(1850, 0, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        6,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(35);
    });

    it('handles element partially visible on the top edge', async () => {
      // Element at (100, -100) size 200x200 (starts 100px above viewport)
      // Visible height = 200 - 100 = 100 (50% of 200)
      // But with scrollX/Y = 0, the element is in absolute coords at y=-100.
      // elemTop = -100 - 0 = -100, elemBottom = 100
      // intersectTop = max(-100, 0) = 0, intersectBottom = min(100, 1080) = 100
      // Visible area = 200 * 100 = 20000, total = 200 * 200 = 40000, 50%
      mockSendCommand.mockResolvedValue(boxModelResponse(100, -100, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        7,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false); // Exactly 50%, not >50%
      expect(result.visibilityPercent).toBe(50);
    });

    it('handles partial visibility on the bottom edge', async () => {
      // Element at (100, 980) size 200x200 in viewport 1920x1080
      // elemTop = 980, elemBottom = 1180
      // intersectBottom = min(1180, 1080) = 1080
      // Visible height = 1080 - 980 = 100 out of 200 = 50%
      mockSendCommand.mockResolvedValue(boxModelResponse(100, 980, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        8,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false); // exactly 50%
      expect(result.visibilityPercent).toBe(50);
    });
  });

  // ==========================================================================
  // isInViewport — element completely outside viewport
  // ==========================================================================
  describe('isInViewport — element completely outside viewport', () => {
    it('returns false for element entirely to the right of viewport', async () => {
      mockSendCommand.mockResolvedValue(boxModelResponse(2000, 100, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        9,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('returns false for element entirely below viewport', async () => {
      mockSendCommand.mockResolvedValue(boxModelResponse(100, 1200, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        10,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('returns false for element entirely above viewport', async () => {
      mockSendCommand.mockResolvedValue(boxModelResponse(100, -300, 200, 100));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        11,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('returns false for element entirely to the left of viewport', async () => {
      mockSendCommand.mockResolvedValue(boxModelResponse(-300, 100, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        12,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });
  });

  // ==========================================================================
  // isInViewport — scroll offset scenarios
  // ==========================================================================
  describe('isInViewport — with scroll offset', () => {
    it('element becomes visible after scrolling down', async () => {
      // Element at absolute position (100, 1200), size 200x200
      // Viewport scrolled to scrollY=1000
      // elemTop = 1200 - 1000 = 200, elemBottom = 400
      // Fully visible in viewport
      const scrolledViewport: ViewportBounds = {
        width: 1920,
        height: 1080,
        scrollX: 0,
        scrollY: 1000,
      };
      mockSendCommand.mockResolvedValue(boxModelResponse(100, 1200, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        13,
        scrolledViewport,
      );

      expect(result.inViewport).toBe(true);
      expect(result.visibilityPercent).toBe(100);
    });

    it('element goes out of view after scrolling past it', async () => {
      // Element at absolute (100, 100), size 200x200
      // Viewport scrolled to scrollY=500
      // elemTop = 100 - 500 = -400, elemBottom = -200
      // Completely above viewport
      const scrolledViewport: ViewportBounds = {
        width: 1920,
        height: 1080,
        scrollX: 0,
        scrollY: 500,
      };
      mockSendCommand.mockResolvedValue(boxModelResponse(100, 100, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        14,
        scrolledViewport,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('handles horizontal scroll offset correctly', async () => {
      // Element at absolute (2100, 100) size 200x200
      // Viewport scrollX=2000, width=1920
      // elemLeft = 2100 - 2000 = 100, elemRight = 300
      // Fully visible
      const scrolledViewport: ViewportBounds = {
        width: 1920,
        height: 1080,
        scrollX: 2000,
        scrollY: 0,
      };
      mockSendCommand.mockResolvedValue(boxModelResponse(2100, 100, 200, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        15,
        scrolledViewport,
      );

      expect(result.inViewport).toBe(true);
      expect(result.visibilityPercent).toBe(100);
    });
  });

  // ==========================================================================
  // isInViewport — edge cases
  // ==========================================================================
  describe('isInViewport — edge cases', () => {
    it('returns false for zero-width element', async () => {
      mockSendCommand.mockResolvedValue(boxModelResponse(100, 100, 0, 200));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        16,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('returns false for zero-height element', async () => {
      mockSendCommand.mockResolvedValue(boxModelResponse(100, 100, 200, 0));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        17,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('returns false when boxModel has no content property', async () => {
      mockSendCommand.mockResolvedValue({ model: {} });

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        18,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('returns false when boxModel is null', async () => {
      mockSendCommand.mockResolvedValue(null);

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        19,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('returns false when boxModel.model is null', async () => {
      mockSendCommand.mockResolvedValue({ model: null });

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        20,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('fetches viewport bounds via sendCommand when not provided', async () => {
      // First call: DOM.getBoxModel, second call could be Runtime.evaluate (for viewport)
      // But isInViewport calls getViewportBounds first, then DOM.getBoxModel
      // Actually: it checks viewport first, then getBoxModel
      mockSendCommand
        .mockResolvedValueOnce({
          result: { value: { width: 1920, height: 1080, scrollX: 0, scrollY: 0 } },
        })
        .mockResolvedValueOnce(boxModelResponse(100, 100, 200, 200));

      const result = await ViewportDetector.isInViewport(mockSendCommand, 21);

      expect(mockSendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.any(Object));
      expect(mockSendCommand).toHaveBeenCalledWith('DOM.getBoxModel', { backendNodeId: 21 });
      expect(result.inViewport).toBe(true);
    });

    it('handles CDP error gracefully and returns not in viewport', async () => {
      mockSendCommand.mockRejectedValue(new Error('Node not found'));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        999,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(0);
    });

    it('handles element that spans the entire viewport', async () => {
      // Element covers the whole viewport exactly
      mockSendCommand.mockResolvedValue(boxModelResponse(0, 0, 1920, 1080));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        22,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(true);
      expect(result.visibilityPercent).toBe(100);
    });

    it('handles element larger than viewport', async () => {
      // Element 3000x2000 at (0,0), viewport 1920x1080
      // Visible area = 1920 * 1080, total area = 3000 * 2000
      // percent = (1920 * 1080) / (3000 * 2000) * 100 = 34.56%
      mockSendCommand.mockResolvedValue(boxModelResponse(0, 0, 3000, 2000));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        23,
        DEFAULT_VIEWPORT,
      );

      expect(result.inViewport).toBe(false); // 34.56% < 50%
      expect(result.visibilityPercent).toBeCloseTo(34.56, 1);
    });

    it('passes the backendNodeId to DOM.getBoxModel', async () => {
      mockSendCommand.mockResolvedValue(boxModelResponse(100, 100, 200, 200));

      await ViewportDetector.isInViewport(mockSendCommand, 42, DEFAULT_VIEWPORT);

      expect(mockSendCommand).toHaveBeenCalledWith('DOM.getBoxModel', { backendNodeId: 42 });
    });
  });

  // ==========================================================================
  // isInViewport — small viewport
  // ==========================================================================
  describe('isInViewport — small viewport', () => {
    const smallViewport: ViewportBounds = {
      width: 375,
      height: 667,
      scrollX: 0,
      scrollY: 0,
    };

    it('handles mobile-sized viewport correctly', async () => {
      // Element 375x50 at top of page, fully visible
      mockSendCommand.mockResolvedValue(boxModelResponse(0, 0, 375, 50));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        24,
        smallViewport,
      );

      expect(result.inViewport).toBe(true);
      expect(result.visibilityPercent).toBe(100);
    });

    it('element wider than mobile viewport is partially visible', async () => {
      // Element 1000x100 at (0, 0), viewport 375 wide
      // Visible width = 375, total width = 1000
      // Visible area = 375 * 100 = 37500, total = 1000 * 100 = 100000
      // percent = 37.5%
      mockSendCommand.mockResolvedValue(boxModelResponse(0, 0, 1000, 100));

      const result = await ViewportDetector.isInViewport(
        mockSendCommand,
        25,
        smallViewport,
      );

      expect(result.inViewport).toBe(false);
      expect(result.visibilityPercent).toBe(37.5);
    });
  });
});
