/**
 * ScreenshotService - CDP-based screenshot capture
 *
 * Captures viewport screenshots using Chrome DevTools Protocol Page.captureScreenshot
 */

import type { ScreenshotCaptureOptions, ViewportBounds, ScrollOffset } from './types';
import { getDebuggerSessionRegistry } from '../browser/ChromeDebuggerSessionRegistry';
import type { DebuggerHandle } from '@/core/tools/browser/DebuggerSessionRegistry';
import { downscalePngToCssPixels } from './downscale';

export class ScreenshotService {
  private tabId: number;
  private sendCommand: <T = any>(method: string, params?: any) => Promise<T>;
  /** Shared debugger session reference, when created via forTab(). */
  private handle: DebuggerHandle | null = null;

  constructor(
    tabId: number,
    sendCommand: <T = any>(method: string, params?: any) => Promise<T>
  ) {
    this.tabId = tabId;
    this.sendCommand = sendCommand;
  }

  /**
   * Capture current viewport as PNG screenshot
   *
   * @param options - Screenshot capture options
   * @returns Base64-encoded PNG screenshot data
   * @throws Error if screenshot capture fails
   */
  async captureViewport(options?: ScreenshotCaptureOptions): Promise<{
    base64Data: string;
    viewport: ViewportBounds;
  }> {
    try {
      // Get viewport bounds (+ DPR) before capture
      const { devicePixelRatio, ...viewport } = await this.getViewportBounds();

      // Capture screenshot using CDP (device pixels)
      const screenshot = await this.sendCommand<{ data: string }>('Page.captureScreenshot', {
        format: options?.format || 'png',
        quality: options?.quality,
        captureBeyondViewport: false // Only capture visible viewport
      });

      // Downscale to CSS pixels so the image the model sees matches the
      // coordinate space clicks are dispatched in (no-op when DPR == 1).
      const base64Data = await downscalePngToCssPixels(screenshot.data, devicePixelRatio);

      return {
        base64Data,
        viewport
      };
    } catch (error: any) {
      console.error('[ScreenshotService] Failed to capture viewport:', error);
      throw new Error(`SCREENSHOT_FAILED: ${error.message}`);
    }
  }

  /**
   * Capture viewport after scrolling to specified position
   *
   * @param scrollOffset - Scroll offset (x, y) before capture
   * @param options - Screenshot capture options
   * @returns Base64-encoded PNG screenshot data
   * @throws Error if scroll or screenshot capture fails
   */
  async captureWithScroll(
    scrollOffset: ScrollOffset,
    options?: ScreenshotCaptureOptions
  ): Promise<{
    base64Data: string;
    viewport: ViewportBounds;
  }> {
    try {
      // Scroll to specified position
      await this.scrollTo(scrollOffset);

      // Wait for scroll to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Capture viewport after scroll
      return await this.captureViewport(options);
    } catch (error: any) {
      console.error('[ScreenshotService] Failed to capture with scroll:', error);
      throw new Error(`SCREENSHOT_FAILED: ${error.message}`);
    }
  }

  /**
   * Scroll page to specified offset
   */
  private async scrollTo(offset: ScrollOffset): Promise<void> {
    const expression = `
      window.scrollTo({
        left: ${offset.x ?? 'window.scrollX'},
        top: ${offset.y ?? 'window.scrollY'},
        behavior: 'smooth'
      });
    `;

    await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true
    });
  }

  /**
   * Get current viewport bounds
   */
  private async getViewportBounds(): Promise<ViewportBounds & { devicePixelRatio: number }> {
    const result = await this.sendCommand<any>('Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight, scroll_x: window.scrollX, scroll_y: window.scrollY, device_pixel_ratio: window.devicePixelRatio })',
      returnByValue: true
    });

    const { width, height, scroll_x, scroll_y, device_pixel_ratio } = result.result.value;

    return {
      width,
      height,
      scroll_x,
      scroll_y,
      devicePixelRatio: device_pixel_ratio ?? 1
    };
  }

  /**
   * Create ScreenshotService for a specific tab.
   *
   * Acquires a shared, refcounted debugger session from the registry instead of
   * attaching independently (which previously raced with DomService/page_vision
   * via a `Runtime.evaluate('1+1')` probe and never detached). Callers MUST
   * {@link release} the service when done; page_vision acquires once per action.
   */
  static async forTab(tabId: number): Promise<ScreenshotService> {
    const handle = await getDebuggerSessionRegistry().acquire(tabId);

    // Enable Page domain (required for screenshots; deduped across the session).
    try {
      await handle.enableDomain('Page');
    } catch (error: any) {
      await handle.release();
      console.error(`[ScreenshotService] Failed to enable Page domain:`, error);
      throw new Error(`SCREENSHOT_FAILED: Failed to enable Page domain: ${error.message}`);
    }

    const sendCommand = <T = any>(method: string, params?: any): Promise<T> =>
      handle.sendCommand<T>(method, params);

    const service = new ScreenshotService(tabId, sendCommand);
    service.handle = handle;
    return service;
  }

  /** Release this service's reference to the shared debugger session. */
  async release(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.release();
  }
}
