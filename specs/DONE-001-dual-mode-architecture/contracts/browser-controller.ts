/**
 * Browser Controller Contract
 *
 * Defines the interface for browser automation across platforms.
 * Extension mode uses chrome.debugger, native mode uses CDP via puppeteer-core.
 *
 * @module contracts/browser-controller
 */

/**
 * Serialized DOM representation for agent consumption
 */
export interface SerializedDOM {
  /** Root element of the serialized tree */
  root: SerializedElement;
  /** Accessibility tree nodes */
  accessibilityTree?: AccessibilityNode[];
  /** Page metadata */
  metadata: PageMetadata;
}

export interface SerializedElement {
  nodeId: number;
  tagName: string;
  attributes: Record<string, string>;
  textContent?: string;
  children: SerializedElement[];
  boundingBox?: BoundingBox;
  isVisible: boolean;
  isInteractive: boolean;
}

export interface AccessibilityNode {
  nodeId: number;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
}

export interface PageMetadata {
  url: string;
  title: string;
  documentState: 'loading' | 'interactive' | 'complete';
  viewport: { width: number; height: number };
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Navigation options
 */
export interface NavigateOptions {
  /** Wait condition after navigation */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  /** Navigation timeout in milliseconds */
  timeout?: number;
  /** HTTP referrer */
  referer?: string;
}

/**
 * Click options
 */
export interface ClickOptions {
  /** Mouse button */
  button?: 'left' | 'right' | 'middle';
  /** Number of clicks */
  clickCount?: number;
  /** Delay between mousedown and mouseup in milliseconds */
  delay?: number;
}

/**
 * Type options
 */
export interface TypeOptions {
  /** Delay between key presses in milliseconds */
  delay?: number;
  /** Clear existing text before typing */
  clear?: boolean;
}

/**
 * Screenshot options
 */
export interface ScreenshotOptions {
  /** Output format */
  format?: 'png' | 'jpeg' | 'webp';
  /** Quality (0-100) for jpeg/webp */
  quality?: number;
  /** Capture full page or visible viewport */
  fullPage?: boolean;
  /** Clip to specific region */
  clip?: BoundingBox;
}

/**
 * Wait condition for waitFor
 */
export type WaitCondition =
  | { type: 'selector'; selector: string; visible?: boolean; timeout?: number }
  | { type: 'navigation'; timeout?: number }
  | { type: 'networkIdle'; timeout?: number }
  | { type: 'function'; fn: string; timeout?: number };

/**
 * Browser Controller Interface
 *
 * Abstracts browser automation operations across platforms.
 *
 * @example Extension Mode
 * ```typescript
 * const controller = new ExtensionBrowserController(tabId);
 * await controller.navigate('https://example.com');
 * await controller.click('#submit-button');
 * ```
 *
 * @example Native Mode
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
   * For native mode, this handles the connection fallback chain.
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
   * Close browser entirely (native mode only)
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
   * @returns Screenshot as Buffer
   */
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;

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

/**
 * Browser connection method (native mode)
 */
export type ConnectionMethod =
  | 'auto-connect'    // Chrome DevTools MCP
  | 'existing-port'   // Connected to existing debug port
  | 'profile-copy'    // Launched with copied profile
  | 'none';           // No browser connection (degraded mode)

/**
 * Browser connection status
 */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

/**
 * Browser connection state (native mode)
 */
export interface BrowserConnectionState {
  method: ConnectionMethod;
  status: ConnectionStatus;
  port?: number;
  profilePath?: string;
  browser?: BrowserInfo;
  error?: string;
}

/**
 * Detected browser information
 */
export interface BrowserInfo {
  name: 'chrome' | 'edge' | 'chromium';
  path: string;
  profilePath: string;
  version?: string;
}
