/**
 * Browser Control Types
 *
 * Shared types for browser automation across extension and desktop modes.
 *
 * @module core/tools/browser/types
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
 * Browser connection method (desktop mode)
 */
export type ConnectionMethod =
  | 'auto-connect' // Chrome DevTools MCP
  | 'existing-port' // Connected to existing debug port
  | 'profile-copy' // Launched with copied profile
  | 'none'; // No browser connection (degraded mode)

/**
 * Browser connection status
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Browser connection state (desktop mode)
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
