/**
 * ScreenshotService - CDP-based screenshot capture
 *
 * Captures viewport screenshots using Chrome DevTools Protocol Page.captureScreenshot
 */

import type { ScreenshotCaptureOptions, ViewportBounds, ScrollOffset } from './types';
import { downscalePngToCssPixels } from './downscale';

export class ScreenshotService {
  private tabId: number;
  private sendCommand: <T = any>(method: string, params?: any) => Promise<T>;

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
      const format = options?.format || 'png';
      const screenshot = await this.sendCommand<{ data: string }>('Page.captureScreenshot', {
        format,
        quality: options?.quality,
        captureBeyondViewport: false // Only capture visible viewport
      });

      // Downscale to CSS pixels so the image the model sees matches the
      // coordinate space clicks are dispatched in (no-op when DPR == 1).
      // Preserve the requested image format when re-encoding.
      const base64Data = await downscalePngToCssPixels(screenshot.data, devicePixelRatio, {
        mimeType: `image/${format}`,
        quality: options?.quality != null ? options.quality / 100 : undefined,
      });

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
   * Create ScreenshotService for a specific tab
   * Uses chrome.debugger to send CDP commands
   */
  static async forTab(tabId: number): Promise<ScreenshotService> {
    // Check if debugger is already attached
    let isAttached = false;
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1+1',
        returnByValue: true
      });
      isAttached = true;
    } catch (error: any) {
      // Debugger not attached - will attach below
      isAttached = false;
    }

    // Attach debugger if not already attached
    if (!isAttached) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (error: any) {
        console.error(`[ScreenshotService] Failed to attach debugger to tab ${tabId}:`, error);

        // Check for common errors
        if (error.message?.includes('Another debugger is already attached')) {
          // Debugger is attached by another process (DevTools, DomService, etc.) - this is OK
        } else if (error.message?.includes('Cannot access')) {
          throw new Error(`CDP_CONNECTION_LOST: Cannot attach debugger to tab ${tabId}. Tab may be a protected page (chrome://, chrome-extension://, etc.)`);
        } else {
          throw new Error(`CDP_CONNECTION_LOST: Failed to attach debugger to tab ${tabId}: ${error.message}`);
        }
      }
    }

    // Enable Page domain (required for screenshots)
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    } catch (error: any) {
      console.error(`[ScreenshotService] Failed to enable Page domain:`, error);
      throw new Error(`SCREENSHOT_FAILED: Failed to enable Page domain: ${error.message}`);
    }

    // Create send command wrapper
    const sendCommand = async <T = any>(method: string, params?: any): Promise<T> => {
      return await chrome.debugger.sendCommand({ tabId }, method, params) as T;
    };

    return new ScreenshotService(tabId, sendCommand);
  }
}
