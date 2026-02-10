/**
 * Debugger Client Interface
 *
 * Low-level interface for sending CDP commands to the browser.
 * Abstracts chrome.debugger (extension) and puppeteer CDPSession (desktop).
 *
 * @module core/tools/browser/DebuggerClient
 */

/**
 * Target for debugger attachment
 */
export type DebuggerTarget =
  | { tabId: number }        // Extension mode: Chrome tab ID
  | { wsEndpoint: string };  // Desktop mode: native WebSocket CDP

/**
 * CDP event callback
 */
export type CDPEventCallback = (method: string, params: unknown) => void;

/**
 * CDP domain for event subscription
 */
export type CDPDomain =
  | 'DOM'
  | 'CSS'
  | 'Page'
  | 'Network'
  | 'Runtime'
  | 'Debugger'
  | 'Input'
  | 'Accessibility'
  | 'Performance'
  | 'Target';

/**
 * Debugger Client Interface
 *
 * Provides unified access to Chrome DevTools Protocol across platforms.
 * DomService and other tools use this interface instead of calling
 * chrome.debugger or puppeteer directly.
 *
 * @example Extension Mode
 * ```typescript
 * const client = new ChromeDebuggerClient();
 * await client.attach({ tabId: 123 });
 *
 * const { root } = await client.sendCommand('DOM.getDocument', { depth: -1 });
 * ```
 *
 * @example Desktop Mode
 * ```typescript
 * const client = new CDPDebuggerClient();
 * await client.attach({ wsEndpoint: 'ws://localhost:9222/devtools/page/...' });
 *
 * const { root } = await client.sendCommand('DOM.getDocument', { depth: -1 });
 * ```
 */
export interface DebuggerClient {
  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Attach to a debugging target
   *
   * @param target - Tab ID (extension) or Page (desktop)
   */
  attach(target: DebuggerTarget): Promise<void>;

  /**
   * Detach from current target
   */
  detach(): Promise<void>;

  /**
   * Check if currently attached
   */
  isAttached(): boolean;

  // ─────────────────────────────────────────────────────────────────────────
  // Command Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a CDP command
   *
   * @param method - CDP method (e.g., 'DOM.getDocument', 'Page.navigate')
   * @param params - Command parameters
   * @returns Command result
   *
   * @example
   * ```typescript
   * // Get document
   * const { root } = await client.sendCommand('DOM.getDocument', { depth: -1 });
   *
   * // Navigate
   * await client.sendCommand('Page.navigate', { url: 'https://example.com' });
   *
   * // Take screenshot
   * const { data } = await client.sendCommand('Page.captureScreenshot', { format: 'png' });
   * ```
   */
  sendCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handling
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to CDP events
   *
   * @param callback - Function called when events are received
   *
   * @example
   * ```typescript
   * client.onEvent((method, params) => {
   *   if (method === 'Page.loadEventFired') {
   *     console.log('Page loaded');
   *   }
   * });
   * ```
   */
  onEvent(callback: CDPEventCallback): void;

  /**
   * Unsubscribe from CDP events
   *
   * @param callback - Previously registered callback to remove
   */
  offEvent(callback: CDPEventCallback): void;

  /**
   * Enable a CDP domain to receive events
   *
   * @param domain - CDP domain to enable
   *
   * @example
   * ```typescript
   * await client.enableDomain('DOM');
   * await client.enableDomain('Page');
   * ```
   */
  enableDomain(domain: CDPDomain): Promise<void>;

  /**
   * Disable a CDP domain
   *
   * @param domain - CDP domain to disable
   */
  disableDomain(domain: CDPDomain): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Convenience Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get current target info
   */
  getTargetInfo(): DebuggerTarget | null;

  /**
   * Get attached tab ID (extension mode only)
   */
  getTabId(): number | null;
}
