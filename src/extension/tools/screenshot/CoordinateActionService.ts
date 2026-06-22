/**
 * CoordinateActionService - CDP-based coordinate-driven input actions
 *
 * Performs click, type, scroll, and keypress actions at specific screen coordinates
 * using Chrome DevTools Protocol Input domain commands.
 */

import type { Coordinates, KeyModifiers, CoordinateActionOptions } from './types';
import { getDebuggerSessionRegistry } from '../browser/ChromeDebuggerSessionRegistry';
import type { DebuggerHandle } from '@/core/tools/browser/DebuggerSessionRegistry';
import { dispatchKey, click as dispatchClick } from '../input/InputDispatcher';

export class CoordinateActionService {
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
   * Click at specific screen coordinates
   *
   * @param coordinates - Screen coordinates (x, y)
   * @param options - Click options (button, modifiers, etc.)
   */
  async clickAt(
    coordinates: Coordinates,
    options?: CoordinateActionOptions
  ): Promise<void> {
    try {
      const button = options?.button || 'left';
      const clickCount = options?.clickCount || 1;
      const modifiers = this.encodeModifiers(options?.modifiers);

      // Route through the shared dispatcher: mouseMoved -> mousePressed ->
      // mouseReleased with correct `buttons` bookkeeping.
      await dispatchClick((method, params) => this.sendCommand(method, params), coordinates.x, coordinates.y, {
        button,
        clickCount,
        modifiers,
      });

      // Wait after action if specified
      if (options?.waitAfter) {
        await new Promise(resolve => setTimeout(resolve, options.waitAfter));
      }
    } catch (error: any) {
      console.error('[CoordinateActionService] Click failed:', error);
      throw new Error(`COORDINATE_CLICK_FAILED: ${error.message}`);
    }
  }

  /**
   * Type text at specific screen coordinates
   * First clicks at coordinates to focus, then types text
   *
   * @param coordinates - Screen coordinates (x, y) to focus before typing
   * @param text - Text to type
   * @param options - Type options
   */
  async typeAt(
    coordinates: Coordinates,
    text: string,
    options?: CoordinateActionOptions
  ): Promise<void> {
    try {
      // Click to focus element at coordinates
      await this.clickAt(coordinates, { clickCount: 1 });

      // Wait for focus
      await new Promise(resolve => setTimeout(resolve, 100));

      // Type text using Input.insertText (simpler than key events)
      await this.sendCommand('Input.insertText', { text });

      // Wait after action if specified
      if (options?.waitAfter) {
        await new Promise(resolve => setTimeout(resolve, options.waitAfter));
      }
    } catch (error: any) {
      console.error('[CoordinateActionService] Type failed:', error);
      throw new Error(`COORDINATE_TYPE_FAILED: ${error.message}`);
    }
  }

  /**
   * Scroll to specific coordinates using mouse wheel
   *
   * @param coordinates - Target coordinates to scroll to
   * @param options - Scroll options
   */
  async scrollTo(
    coordinates: Coordinates,
    options?: CoordinateActionOptions
  ): Promise<void> {
    try {
      // Get current viewport bounds
      const viewport = await this.getViewportBounds();

      // Calculate scroll delta needed
      const deltaX = coordinates.x - viewport.scrollX;
      const deltaY = coordinates.y - viewport.scrollY;

      // Dispatch mouse wheel event to scroll
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: viewport.width / 2,  // Center of viewport
        y: viewport.height / 2,
        deltaX,
        deltaY
      });

      // Wait for scroll to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Wait after action if specified
      if (options?.waitAfter) {
        await new Promise(resolve => setTimeout(resolve, options.waitAfter));
      }
    } catch (error: any) {
      console.error('[CoordinateActionService] Scroll failed:', error);
      throw new Error(`COORDINATE_SCROLL_FAILED: ${error.message}`);
    }
  }

  /**
   * Press keyboard key with optional modifiers
   *
   * @param key - Key to press (e.g., 'Enter', 'Escape', 'Tab')
   * @param options - Key press options (modifiers)
   */
  async keypressAt(
    key: string,
    options?: CoordinateActionOptions
  ): Promise<void> {
    try {
      const modifiers = this.encodeModifiers(options?.modifiers);

      // Correct key synthesis via the shared dispatcher (real code/keyCode/text).
      await dispatchKey((method, params) => this.sendCommand(method, params), key, { modifiers });

      // Wait after action if specified
      if (options?.waitAfter) {
        await new Promise(resolve => setTimeout(resolve, options.waitAfter));
      }
    } catch (error: any) {
      console.error('[CoordinateActionService] Keypress failed:', error);
      throw new Error(`COORDINATE_KEYPRESS_FAILED: ${error.message}`);
    }
  }

  /**
   * Encode key modifiers to CDP modifier bitmask
   */
  private encodeModifiers(modifiers?: KeyModifiers): number {
    if (!modifiers) return 0;

    let modifierBits = 0;
    if (modifiers.alt) modifierBits |= 1;
    if (modifiers.ctrl) modifierBits |= 2;
    if (modifiers.meta) modifierBits |= 4;
    if (modifiers.shift) modifierBits |= 8;

    return modifierBits;
  }

  /**
   * Get current viewport bounds
   */
  private async getViewportBounds(): Promise<{
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  }> {
    const result = await this.sendCommand<any>('Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })',
      returnByValue: true
    });

    return result.result.value;
  }

  /**
   * Create CoordinateActionService for a specific tab.
   *
   * Acquires a shared, refcounted debugger session from the registry instead of
   * attaching independently (the old `Runtime.evaluate('1+1')` probe raced with
   * other services and never detached). Callers MUST {@link release} the service
   * when done; page_vision acquires once per action.
   */
  static async forTab(tabId: number): Promise<CoordinateActionService> {
    const handle = await getDebuggerSessionRegistry().acquire(tabId);

    const sendCommand = <T = any>(method: string, params?: any): Promise<T> =>
      handle.sendCommand<T>(method, params);

    const service = new CoordinateActionService(tabId, sendCommand);
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
