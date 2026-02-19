/**
 * Debugger Client Contract
 *
 * Low-level interface for sending CDP commands to the browser.
 * Abstracts chrome.debugger (extension) and puppeteer CDPSession (native).
 *
 * This is the middle layer between DomService and platform-specific APIs.
 *
 * @module contracts/debugger-client
 */

import type { Page } from 'puppeteer-core';

/**
 * Target for debugger attachment
 */
export type DebuggerTarget =
  | { tabId: number }      // Extension mode: Chrome tab ID
  | { page: Page };        // Native mode: puppeteer Page

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
 * @example Native Mode
 * ```typescript
 * const client = new CDPDebuggerClient();
 * await client.attach({ page: puppeteerPage });
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
   * @param target - Tab ID (extension) or Page (native)
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

// ─────────────────────────────────────────────────────────────────────────────
// Common CDP Response Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DOM.getDocument response
 */
export interface DOMGetDocumentResponse {
  root: DOMNode;
}

/**
 * DOM node from CDP
 */
export interface DOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount?: number;
  children?: DOMNode[];
  attributes?: string[];
  documentURL?: string;
  baseURL?: string;
  publicId?: string;
  systemId?: string;
  internalSubset?: string;
  xmlVersion?: string;
  name?: string;
  value?: string;
  pseudoType?: string;
  shadowRootType?: string;
  frameId?: string;
  contentDocument?: DOMNode;
  shadowRoots?: DOMNode[];
  templateContent?: DOMNode;
  pseudoElements?: DOMNode[];
  distributedNodes?: BackendNode[];
  isSVG?: boolean;
}

/**
 * Backend node reference
 */
export interface BackendNode {
  nodeType: number;
  nodeName: string;
  backendNodeId: number;
}

/**
 * DOM.getBoxModel response
 */
export interface DOMGetBoxModelResponse {
  model: BoxModel;
}

/**
 * Box model for an element
 */
export interface BoxModel {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
}

/**
 * Accessibility.getFullAXTree response
 */
export interface AccessibilityGetFullAXTreeResponse {
  nodes: AXNode[];
}

/**
 * Accessibility tree node
 */
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: AXProperty[];
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/**
 * Accessibility property
 */
export interface AXProperty {
  name: string;
  value: AXValue;
}

/**
 * Accessibility value
 */
export interface AXValue {
  type: string;
  value?: unknown;
  relatedNodes?: AXRelatedNode[];
  sources?: AXValueSource[];
}

/**
 * Related accessibility node
 */
export interface AXRelatedNode {
  backendDOMNodeId: number;
  idref?: string;
  text?: string;
}

/**
 * Accessibility value source
 */
export interface AXValueSource {
  type: string;
  value?: AXValue;
  attribute?: string;
  attributeValue?: AXValue;
  superseded?: boolean;
  nativeSource?: string;
  nativeSourceValue?: AXValue;
  invalid?: boolean;
  invalidReason?: string;
}

/**
 * Page.captureScreenshot response
 */
export interface PageCaptureScreenshotResponse {
  data: string; // Base64-encoded image
}

/**
 * Runtime.evaluate response
 */
export interface RuntimeEvaluateResponse {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

/**
 * Remote object from runtime
 */
export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

/**
 * Exception details from runtime
 */
export interface ExceptionDetails {
  exceptionId: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  scriptId?: string;
  url?: string;
  stackTrace?: StackTrace;
  exception?: RemoteObject;
  executionContextId?: number;
}

/**
 * Stack trace
 */
export interface StackTrace {
  description?: string;
  callFrames: CallFrame[];
  parent?: StackTrace;
}

/**
 * Call frame in stack trace
 */
export interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}
