/**
 * Browser Controller Interface
 *
 * Abstracts browser automation operations across platforms.
 * Extension mode uses chrome.debugger, desktop mode uses CDP via puppeteer-core.
 *
 * @module core/tools/browser/BrowserController
 */

import type {
  SerializedDOM,
  NavigateOptions,
  ClickOptions,
  TypeOptions,
  ScreenshotOptions,
  WaitCondition,
} from './types';

/**
 * Browser Controller Interface
 *
 * @example Extension Mode
 * ```typescript
 * const controller = new ExtensionBrowserController(tabId);
 * await controller.navigate('https://example.com');
 * await controller.click('#submit-button');
 * ```
 *
 * @example Desktop Mode
 * ```typescript
 * const controller = new CDPBrowserController();
 * await controller.initialize();
 * await controller.navigate('https://example.com');
 * const screenshot = await controller.screenshot();
 * ```
 */
export interface BrowserController {
  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the controller (connect to browser, etc.)
   * For desktop mode, this handles the connection fallback chain.
   */
  initialize(): Promise<void>;

  /**
   * Check if controller is connected and ready
   */
  isConnected(): boolean;

  /**
   * Disconnect from browser (keeps browser running)
   */
  disconnect(): Promise<void>;

  /**
   * Close browser entirely (desktop mode only)
   */
  close(): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Navigate to a URL
   *
   * @param url - URL to navigate to
   * @param options - Navigation options
   */
  navigate(url: string, options?: NavigateOptions): Promise<void>;

  /**
   * Go back in history
   */
  goBack(): Promise<void>;

  /**
   * Go forward in history
   */
  goForward(): Promise<void>;

  /**
   * Reload the current page
   */
  reload(): Promise<void>;

  /**
   * Get current URL
   */
  getUrl(): Promise<string>;

  /**
   * Get page title
   */
  getTitle(): Promise<string>;

  // ─────────────────────────────────────────────────────────────────────────
  // DOM Interaction
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Click an element
   *
   * @param selector - CSS selector or element ID
   * @param options - Click options
   */
  click(selector: string, options?: ClickOptions): Promise<void>;

  /**
   * Type text into an element
   *
   * @param selector - CSS selector for input element
   * @param text - Text to type
   * @param options - Type options
   */
  type(selector: string, text: string, options?: TypeOptions): Promise<void>;

  /**
   * Select option(s) in a select element
   *
   * @param selector - CSS selector for select element
   * @param values - Value(s) to select
   */
  select(selector: string, ...values: string[]): Promise<void>;

  /**
   * Focus an element
   *
   * @param selector - CSS selector
   */
  focus(selector: string): Promise<void>;

  /**
   * Hover over an element
   *
   * @param selector - CSS selector
   */
  hover(selector: string): Promise<void>;

  /**
   * Scroll to element or position
   *
   * @param target - CSS selector or {x, y} coordinates
   */
  scroll(target: string | { x: number; y: number }): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Content Extraction
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get serialized DOM snapshot for agent
   * Includes accessibility tree and element metadata
   */
  getSnapshot(): Promise<SerializedDOM>;

  /**
   * Take a screenshot
   *
   * @param options - Screenshot options
   * @returns Screenshot as base64 string
   */
  screenshot(options?: ScreenshotOptions): Promise<string>;

  /**
   * Get page content as text (for reading)
   */
  getTextContent(): Promise<string>;

  /**
   * Get page HTML
   */
  getHtml(): Promise<string>;

  // ─────────────────────────────────────────────────────────────────────────
  // JavaScript Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate JavaScript in page context
   *
   * @param fn - Function or expression to evaluate
   * @param args - Arguments to pass to function
   * @returns Evaluation result
   */
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;

  // ─────────────────────────────────────────────────────────────────────────
  // Waiting
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Wait for a condition
   *
   * @param condition - What to wait for
   */
  waitFor(condition: WaitCondition): Promise<void>;
}
