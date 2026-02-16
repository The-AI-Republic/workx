import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScreenshotService } from '../ScreenshotService';

describe('ScreenshotService', () => {
  const TAB_ID = 1;
  let mockSendCommand: ReturnType<typeof vi.fn>;
  let service: ScreenshotService;

  beforeEach(() => {
    vi.restoreAllMocks();

    mockSendCommand = vi.fn().mockImplementation(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 1920, height: 1080, scroll_x: 0, scroll_y: 0 } } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: 'base64EncodedScreenshot' };
      }
      return undefined;
    });

    service = new ScreenshotService(TAB_ID, mockSendCommand);
  });

  describe('captureViewport', () => {
    it('returns base64 data and viewport bounds', async () => {
      const result = await service.captureViewport();

      expect(result.base64Data).toBe('base64EncodedScreenshot');
      expect(result.viewport).toEqual({
        width: 1920,
        height: 1080,
        scroll_x: 0,
        scroll_y: 0,
      });
    });

    it('calls Runtime.evaluate to get viewport bounds', async () => {
      await service.captureViewport();

      expect(mockSendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: '({ width: window.innerWidth, height: window.innerHeight, scroll_x: window.scrollX, scroll_y: window.scrollY })',
        returnByValue: true,
      });
    });

    it('calls Page.captureScreenshot with default png format', async () => {
      await service.captureViewport();

      expect(mockSendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
        format: 'png',
        quality: undefined,
        captureBeyondViewport: false,
      });
    });

    it('passes format option to CDP', async () => {
      await service.captureViewport({ format: 'jpeg' });

      expect(mockSendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
        format: 'jpeg',
        quality: undefined,
        captureBeyondViewport: false,
      });
    });

    it('passes quality option to CDP', async () => {
      await service.captureViewport({ format: 'jpeg', quality: 80 });

      expect(mockSendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 80,
        captureBeyondViewport: false,
      });
    });

    it('wraps error with SCREENSHOT_FAILED', async () => {
      mockSendCommand.mockRejectedValue(new Error('CDP connection lost'));

      await expect(service.captureViewport()).rejects.toThrow('SCREENSHOT_FAILED: CDP connection lost');
    });

    it('calls getViewportBounds before Page.captureScreenshot', async () => {
      const callOrder: string[] = [];
      mockSendCommand.mockImplementation(async (method: string) => {
        callOrder.push(method);
        if (method === 'Runtime.evaluate') {
          return { result: { value: { width: 1920, height: 1080, scroll_x: 0, scroll_y: 0 } } };
        }
        if (method === 'Page.captureScreenshot') {
          return { data: 'base64EncodedScreenshot' };
        }
        return undefined;
      });

      await service.captureViewport();

      expect(callOrder).toEqual(['Runtime.evaluate', 'Page.captureScreenshot']);
    });
  });

  describe('captureWithScroll', () => {
    it('scrolls then captures the viewport', async () => {
      vi.useFakeTimers();

      const capturePromise = service.captureWithScroll({ x: 0, y: 500 });
      await vi.advanceTimersByTimeAsync(100);
      const result = await capturePromise;

      expect(result.base64Data).toBe('base64EncodedScreenshot');
      expect(result.viewport).toEqual({
        width: 1920,
        height: 1080,
        scroll_x: 0,
        scroll_y: 0,
      });

      vi.useRealTimers();
    });

    it('calls Runtime.evaluate with scroll expression before capturing', async () => {
      vi.useFakeTimers();

      const capturePromise = service.captureWithScroll({ x: 100, y: 500 });
      await vi.advanceTimersByTimeAsync(100);
      await capturePromise;

      // First call: scrollTo, second call: getViewportBounds, third call: captureScreenshot
      const firstCall = mockSendCommand.mock.calls[0];
      expect(firstCall[0]).toBe('Runtime.evaluate');
      expect(firstCall[1].expression).toContain('window.scrollTo');
      expect(firstCall[1].expression).toContain('left: 100');
      expect(firstCall[1].expression).toContain('top: 500');

      vi.useRealTimers();
    });

    it('uses window.scrollX/scrollY when offset values are undefined', async () => {
      vi.useFakeTimers();

      const capturePromise = service.captureWithScroll({});
      await vi.advanceTimersByTimeAsync(100);
      await capturePromise;

      const firstCall = mockSendCommand.mock.calls[0];
      expect(firstCall[0]).toBe('Runtime.evaluate');
      expect(firstCall[1].expression).toContain('left: window.scrollX');
      expect(firstCall[1].expression).toContain('top: window.scrollY');

      vi.useRealTimers();
    });

    it('passes scroll expression with returnByValue: true', async () => {
      vi.useFakeTimers();

      const capturePromise = service.captureWithScroll({ x: 0, y: 300 });
      await vi.advanceTimersByTimeAsync(100);
      await capturePromise;

      const firstCall = mockSendCommand.mock.calls[0];
      expect(firstCall[1].returnByValue).toBe(true);

      vi.useRealTimers();
    });

    it('wraps error with SCREENSHOT_FAILED when scroll fails', async () => {
      mockSendCommand.mockRejectedValueOnce(new Error('Scroll evaluation failed'));

      await expect(service.captureWithScroll({ x: 0, y: 500 })).rejects.toThrow(
        'SCREENSHOT_FAILED: Scroll evaluation failed'
      );
    });

    it('forwards capture options to captureViewport', async () => {
      vi.useFakeTimers();

      const capturePromise = service.captureWithScroll({ y: 200 }, { format: 'jpeg', quality: 75 });
      await vi.advanceTimersByTimeAsync(100);
      await capturePromise;

      expect(mockSendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 75,
        captureBeyondViewport: false,
      });

      vi.useRealTimers();
    });
  });
});
