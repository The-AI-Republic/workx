/**
 * CoordinateActionService - CDP-based coordinate-driven input actions
 *
 * Performs click, type, scroll, and keypress actions at specific screen coordinates
 * using Chrome DevTools Protocol Input domain commands.
 */

import type { Coordinates, KeyModifiers, CoordinateActionOptions } from './types';
import { dispatchKey } from '../input/InputDispatcher';

export class CoordinateActionService {
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

      // Dispatch mouse pressed event
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: coordinates.x,
        y: coordinates.y,
        button,
        clickCount,
        modifiers
      });

      // Dispatch mouse released event
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: coordinates.x,
        y: coordinates.y,
        button,
        clickCount,
        modifiers
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
   * Create CoordinateActionService for a specific tab
   * Uses chrome.debugger to send CDP commands
   */
  static async forTab(tabId: number): Promise<CoordinateActionService> {
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
        console.error(`[CoordinateActionService] Failed to attach debugger to tab ${tabId}:`, error);

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

    // Create send command wrapper
    const sendCommand = async <T = any>(method: string, params?: any): Promise<T> => {
      return await chrome.debugger.sendCommand({ tabId }, method, params) as T;
    };

    return new CoordinateActionService(tabId, sendCommand);
  }
}
