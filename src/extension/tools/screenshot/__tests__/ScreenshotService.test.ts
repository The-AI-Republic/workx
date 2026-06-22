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

  // ==========================================================================
  // constructor
  // ==========================================================================
  describe('constructor', () => {
    it('creates an instance with tabId and sendCommand', () => {
      const svc = new ScreenshotService(42, mockSendCommand);
      expect(svc).toBeInstanceOf(ScreenshotService);
    });

    it('uses the provided sendCommand function', async () => {
      const customCmd = vi.fn().mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return { result: { value: { width: 100, height: 100, scroll_x: 0, scroll_y: 0 } } };
        }
        if (method === 'Page.captureScreenshot') {
          return { data: 'customData' };
        }
        return undefined;
      });
      const svc = new ScreenshotService(99, customCmd);

      const result = await svc.captureViewport();

      expect(customCmd).toHaveBeenCalled();
      expect(result.base64Data).toBe('customData');
    });
  });

  // ==========================================================================
  // captureViewport
  // ==========================================================================
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
        expression: '({ width: window.innerWidth, height: window.innerHeight, scroll_x: window.scrollX, scroll_y: window.scrollY, device_pixel_ratio: window.devicePixelRatio })',
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

    it('passes webp format option to CDP', async () => {
      await service.captureViewport({ format: 'webp' });

      expect(mockSendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
        format: 'webp',
        quality: undefined,
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

    it('returns viewport bounds with scroll offsets', async () => {
      mockSendCommand.mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return { result: { value: { width: 1920, height: 1080, scroll_x: 300, scroll_y: 500 } } };
        }
        if (method === 'Page.captureScreenshot') {
          return { data: 'scrolledScreenshot' };
        }
        return undefined;
      });

      const result = await service.captureViewport();

      expect(result.viewport.scroll_x).toBe(300);
      expect(result.viewport.scroll_y).toBe(500);
    });

    it('handles options being undefined (default to png)', async () => {
      const result = await service.captureViewport(undefined);

      expect(mockSendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
        format: 'png',
        quality: undefined,
        captureBeyondViewport: false,
      });
      expect(result.base64Data).toBe('base64EncodedScreenshot');
    });

    it('wraps error from getViewportBounds with SCREENSHOT_FAILED', async () => {
      mockSendCommand.mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          throw new Error('Runtime domain error');
        }
        return undefined;
      });

      await expect(service.captureViewport()).rejects.toThrow(
        'SCREENSHOT_FAILED: Runtime domain error'
      );
    });
  });

  // ==========================================================================
  // captureWithScroll
  // ==========================================================================
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

    it('uses smooth scroll behavior', async () => {
      vi.useFakeTimers();

      const capturePromise = service.captureWithScroll({ x: 50, y: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await capturePromise;

      const firstCall = mockSendCommand.mock.calls[0];
      expect(firstCall[1].expression).toContain("behavior: 'smooth'");

      vi.useRealTimers();
    });

    it('waits 100ms between scroll and capture', async () => {
      vi.useFakeTimers();
      const callTimestamps: number[] = [];

      mockSendCommand.mockImplementation(async (method: string) => {
        callTimestamps.push(Date.now());
        if (method === 'Runtime.evaluate') {
          return { result: { value: { width: 1920, height: 1080, scroll_x: 0, scroll_y: 0 } } };
        }
        if (method === 'Page.captureScreenshot') {
          return { data: 'delayed' };
        }
        return undefined;
      });

      const capturePromise = service.captureWithScroll({ y: 200 });
      await vi.advanceTimersByTimeAsync(100);
      await capturePromise;

      // The scroll call should happen first, then after 100ms the capture calls
      expect(callTimestamps.length).toBe(3); // scroll, getViewport, capture
      expect(callTimestamps[1] - callTimestamps[0]).toBeGreaterThanOrEqual(100);

      vi.useRealTimers();
    });

    it('only scrolls x when y is undefined', async () => {
      vi.useFakeTimers();

      const capturePromise = service.captureWithScroll({ x: 300 });
      await vi.advanceTimersByTimeAsync(100);
      await capturePromise;

      const firstCall = mockSendCommand.mock.calls[0];
      expect(firstCall[1].expression).toContain('left: 300');
      expect(firstCall[1].expression).toContain('top: window.scrollY');

      vi.useRealTimers();
    });

    it('only scrolls y when x is undefined', async () => {
      vi.useFakeTimers();

      const capturePromise = service.captureWithScroll({ y: 400 });
      await vi.advanceTimersByTimeAsync(100);
      await capturePromise;

      const firstCall = mockSendCommand.mock.calls[0];
      expect(firstCall[1].expression).toContain('left: window.scrollX');
      expect(firstCall[1].expression).toContain('top: 400');

      vi.useRealTimers();
    });
  });

  // ==========================================================================
  // forTab — static factory
  // ==========================================================================
  describe('forTab', () => {
    let mockDebuggerSendCommand: ReturnType<typeof vi.fn>;
    let mockDebuggerAttach: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockDebuggerSendCommand = vi.fn();
      mockDebuggerAttach = vi.fn().mockResolvedValue(undefined);

      // Set up chrome.debugger mock
      (globalThis as any).chrome.debugger = {
        sendCommand: mockDebuggerSendCommand,
        attach: mockDebuggerAttach,
      };
    });

    it('returns a ScreenshotService instance', async () => {
      // Debugger not attached yet (sendCommand throws), then attach + Page.enable succeeds
      mockDebuggerSendCommand
        .mockRejectedValueOnce(new Error('Not attached'))
        .mockResolvedValueOnce(undefined); // Page.enable

      const svc = await ScreenshotService.forTab(42);

      expect(svc).toBeInstanceOf(ScreenshotService);
    });

    it('attaches debugger when not already attached', async () => {
      mockDebuggerSendCommand
        .mockRejectedValueOnce(new Error('Not attached'))
        .mockResolvedValueOnce(undefined); // Page.enable

      await ScreenshotService.forTab(10);

      expect(mockDebuggerAttach).toHaveBeenCalledWith({ tabId: 10 }, '1.3');
    });

    it('skips attach when debugger is already attached', async () => {
      // First sendCommand (check) succeeds = already attached
      mockDebuggerSendCommand
        .mockResolvedValueOnce({ result: { value: 2 } }) // runtime check
        .mockResolvedValueOnce(undefined); // Page.enable

      await ScreenshotService.forTab(5);

      expect(mockDebuggerAttach).not.toHaveBeenCalled();
    });

    it('enables Page domain after attaching', async () => {
      mockDebuggerSendCommand
        .mockRejectedValueOnce(new Error('Not attached'))
        .mockResolvedValueOnce(undefined); // Page.enable

      await ScreenshotService.forTab(7);

      expect(mockDebuggerSendCommand).toHaveBeenCalledWith(
        { tabId: 7 },
        'Page.enable',
        {}
      );
    });

    it('throws CDP_CONNECTION_LOST for "Cannot access" error', async () => {
      mockDebuggerSendCommand.mockRejectedValueOnce(new Error('Not attached'));
      mockDebuggerAttach.mockRejectedValueOnce(new Error('Cannot access this tab'));

      await expect(ScreenshotService.forTab(1)).rejects.toThrow(
        'CDP_CONNECTION_LOST: Cannot attach debugger to tab 1'
      );
    });

    it('throws CDP_CONNECTION_LOST for unknown attach errors', async () => {
      mockDebuggerSendCommand.mockRejectedValueOnce(new Error('Not attached'));
      mockDebuggerAttach.mockRejectedValueOnce(new Error('Some unknown error'));

      await expect(ScreenshotService.forTab(3)).rejects.toThrow(
        'CDP_CONNECTION_LOST: Failed to attach debugger to tab 3: Some unknown error'
      );
    });

    it('ignores "Another debugger is already attached" error', async () => {
      mockDebuggerSendCommand
        .mockRejectedValueOnce(new Error('Not attached'))
        .mockResolvedValueOnce(undefined); // Page.enable
      mockDebuggerAttach.mockRejectedValueOnce(
        new Error('Another debugger is already attached')
      );

      const svc = await ScreenshotService.forTab(4);
      expect(svc).toBeInstanceOf(ScreenshotService);
    });

    it('throws SCREENSHOT_FAILED when Page.enable fails', async () => {
      mockDebuggerSendCommand
        .mockRejectedValueOnce(new Error('Not attached')) // check
        .mockRejectedValueOnce(new Error('Page domain not supported')); // Page.enable

      await expect(ScreenshotService.forTab(8)).rejects.toThrow(
        'SCREENSHOT_FAILED: Failed to enable Page domain: Page domain not supported'
      );
    });

    it('created service uses chrome.debugger.sendCommand wrapper', async () => {
      mockDebuggerSendCommand
        .mockResolvedValueOnce({ result: { value: 2 } }) // check attached
        .mockResolvedValueOnce(undefined) // Page.enable
        .mockResolvedValueOnce({ result: { value: { width: 800, height: 600, scroll_x: 0, scroll_y: 0 } } }) // getViewportBounds
        .mockResolvedValueOnce({ data: 'screenshotFromTab' }); // captureScreenshot

      const svc = await ScreenshotService.forTab(55);
      const result = await svc.captureViewport();

      expect(result.base64Data).toBe('screenshotFromTab');
      // Verify the wrapper passes tabId correctly
      expect(mockDebuggerSendCommand).toHaveBeenCalledWith(
        { tabId: 55 },
        'Page.captureScreenshot',
        expect.any(Object)
      );
    });

    it('checks debugger attachment with Runtime.evaluate expression 1+1', async () => {
      mockDebuggerSendCommand
        .mockResolvedValueOnce({ result: { value: 2 } })
        .mockResolvedValueOnce(undefined);

      await ScreenshotService.forTab(11);

      expect(mockDebuggerSendCommand).toHaveBeenCalledWith(
        { tabId: 11 },
        'Runtime.evaluate',
        { expression: '1+1', returnByValue: true }
      );
    });
  });
});
