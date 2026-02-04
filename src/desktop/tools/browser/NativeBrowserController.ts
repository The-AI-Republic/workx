/**
 * Native Browser Controller
 *
 * Desktop-mode implementation of BrowserController using native CDP connection.
 * Provides high-level browser automation through the NativeCDPClient.
 *
 * @module desktop/tools/browser/NativeBrowserController
 */

import type {
  BrowserController,
  NavigateOptions,
  ClickOptions,
  TypeOptions,
  ScreenshotOptions,
  EvaluateOptions,
  WaitOptions,
} from '@/core/tools/browser/BrowserController';
import type { SerializedDOM } from '@/core/tools/browser/types';
import { NativeCDPClient } from './NativeCDPClient';
import { ChromeLauncher, type LaunchResult } from './ChromeLauncher';

/**
 * Browser connection fallback mode
 */
export type ConnectionMode =
  | 'auto-connect' // Connect to running Chrome with debug port
  | 'debug-port' // Launch with debug port
  | 'profile-copy' // Copy profile and launch
  | 'fresh' // Launch with fresh profile
  | 'degraded'; // Minimal functionality without CDP

/**
 * NativeBrowserController implements BrowserController for desktop mode
 *
 * @example
 * ```typescript
 * const controller = new NativeBrowserController();
 * await controller.initialize();
 *
 * await controller.navigate('https://example.com');
 * await controller.click('#submit-button');
 * const screenshot = await controller.screenshot();
 *
 * await controller.close();
 * ```
 */
export class NativeBrowserController implements BrowserController {
  private client: NativeCDPClient;
  private launcher: ChromeLauncher;
  private connectionMode: ConnectionMode | null = null;
  private initialized = false;

  constructor() {
    this.client = new NativeCDPClient();
    this.launcher = new ChromeLauncher();
  }

  /**
   * Initialize the browser controller
   *
   * Uses fallback chain: auto-connect → debug-port → profile-copy → fresh → degraded
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('[NativeBrowserController] Initializing...');

    // Try fallback chain
    let result: LaunchResult;

    // 1. Try auto-connect to running Chrome
    console.log('[NativeBrowserController] Attempting auto-connect...');
    result = await this.launcher.connectToRunning();
    if (result.success && result.wsEndpoint) {
      this.connectionMode = 'auto-connect';
      await this.connectToEndpoint(result.wsEndpoint);
      return;
    }

    // 2. Try launching with user profile
    console.log('[NativeBrowserController] Attempting launch with user profile...');
    try {
      result = await this.launcher.launchWithUserProfile();
      if (result.success && result.wsEndpoint) {
        this.connectionMode = 'profile-copy';
        await this.connectToEndpoint(result.wsEndpoint);
        return;
      }
    } catch (error) {
      console.warn('[NativeBrowserController] Profile launch failed:', error);
    }

    // 3. Try launching with fresh profile
    console.log('[NativeBrowserController] Attempting launch with fresh profile...');
    result = await this.launcher.launch();
    if (result.success && result.wsEndpoint) {
      this.connectionMode = 'fresh';
      await this.connectToEndpoint(result.wsEndpoint);
      return;
    }

    // 4. Degraded mode
    console.warn('[NativeBrowserController] Falling back to degraded mode');
    this.connectionMode = 'degraded';
    this.initialized = true;
  }

  /**
   * Connect to a WebSocket endpoint and enable required domains
   */
  private async connectToEndpoint(wsEndpoint: string): Promise<void> {
    await this.client.attach({ wsEndpoint });

    // Enable required CDP domains
    await this.client.enableDomain('Page');
    await this.client.enableDomain('Runtime');
    await this.client.enableDomain('DOM');
    await this.client.enableDomain('Network');

    this.initialized = true;
    console.log(`[NativeBrowserController] Connected in ${this.connectionMode} mode`);
  }

  /**
   * Close the browser controller
   */
  async close(): Promise<void> {
    console.log('[NativeBrowserController] Closing...');

    if (this.client.isConnected()) {
      await this.client.detach();
    }

    await this.launcher.close();
    this.initialized = false;
    this.connectionMode = null;

    console.log('[NativeBrowserController] Closed');
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, options?: NavigateOptions): Promise<void> {
    this.ensureConnected();

    const waitUntil = options?.waitUntil || 'load';
    const timeout = options?.timeout || 30000;

    console.log(`[NativeBrowserController] Navigating to ${url}`);

    // Start navigation
    await this.client.sendCommand('Page.navigate', { url });

    // Wait for load event
    if (waitUntil === 'load') {
      await this.client.waitForEvent('Page.loadEventFired', timeout);
    } else if (waitUntil === 'domcontentloaded') {
      await this.client.waitForEvent('Page.domContentEventFired', timeout);
    }
  }

  /**
   * Click an element
   */
  async click(selector: string, options?: ClickOptions): Promise<void> {
    this.ensureConnected();

    // Find the element
    const node = await this.findElement(selector);
    if (!node) {
      throw new Error(`Element not found: ${selector}`);
    }

    // Get element position
    const boxModel = await this.client.sendCommand<{
      model: { content: number[] };
    }>('DOM.getBoxModel', { nodeId: node.nodeId });

    const content = boxModel.model.content;
    const x = (content[0] + content[2]) / 2;
    const y = (content[1] + content[5]) / 2;

    // Dispatch mouse events
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: options?.button || 'left',
      clickCount: options?.clickCount || 1,
    });

    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: options?.button || 'left',
      clickCount: options?.clickCount || 1,
    });
  }

  /**
   * Type text
   */
  async type(selector: string, text: string, options?: TypeOptions): Promise<void> {
    this.ensureConnected();

    // Focus the element
    const node = await this.findElement(selector);
    if (!node) {
      throw new Error(`Element not found: ${selector}`);
    }

    await this.client.sendCommand('DOM.focus', { nodeId: node.nodeId });

    // Clear existing content if requested
    if (options?.clearExisting) {
      await this.client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        modifiers: 2, // Ctrl
      });
      await this.client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        modifiers: 2,
      });
      await this.client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Backspace',
      });
      await this.client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
      });
    }

    // Type each character
    const delay = options?.delay || 0;
    for (const char of text) {
      await this.client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
      });
      await this.client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char,
      });

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Take a screenshot
   */
  async screenshot(options?: ScreenshotOptions): Promise<string> {
    this.ensureConnected();

    const params: Record<string, unknown> = {
      format: options?.format || 'png',
    };

    if (options?.quality && params.format === 'jpeg') {
      params.quality = options.quality;
    }

    if (options?.fullPage) {
      // Get full page metrics
      const metrics = await this.client.sendCommand<{
        contentSize: { width: number; height: number };
      }>('Page.getLayoutMetrics');

      params.clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
    } else if (options?.clip) {
      params.clip = { ...options.clip, scale: 1 };
    }

    const result = await this.client.sendCommand<{ data: string }>(
      'Page.captureScreenshot',
      params
    );

    return result.data;
  }

  /**
   * Get DOM snapshot
   */
  async getSnapshot(): Promise<SerializedDOM> {
    this.ensureConnected();

    // Get the document
    const doc = await this.client.sendCommand<{ root: { nodeId: number } }>(
      'DOM.getDocument',
      { depth: -1, pierce: true }
    );

    // Get outer HTML
    const html = await this.client.sendCommand<{ outerHTML: string }>(
      'DOM.getOuterHTML',
      { nodeId: doc.root.nodeId }
    );

    return {
      html: html.outerHTML,
      timestamp: Date.now(),
    };
  }

  /**
   * Evaluate JavaScript in the page
   */
  async evaluate<T>(
    expression: string | ((...args: unknown[]) => T),
    options?: EvaluateOptions
  ): Promise<T> {
    this.ensureConnected();

    const expr = typeof expression === 'function' ? `(${expression})()` : expression;

    const result = await this.client.sendCommand<{
      result: { value: T };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${result.exceptionDetails.text}`);
    }

    return result.result.value;
  }

  /**
   * Wait for selector
   */
  async waitForSelector(selector: string, options?: WaitOptions): Promise<void> {
    this.ensureConnected();

    const timeout = options?.timeout || 30000;
    const interval = 100;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const node = await this.findElement(selector);
      if (node) {
        if (options?.visible) {
          const boxModel = await this.client.sendCommand<{
            model?: { width: number; height: number };
          }>('DOM.getBoxModel', { nodeId: node.nodeId }).catch(() => ({}));
          if (boxModel.model && boxModel.model.width > 0 && boxModel.model.height > 0) {
            return;
          }
        } else {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  /**
   * Wait for navigation
   */
  async waitForNavigation(options?: WaitOptions): Promise<void> {
    this.ensureConnected();

    const timeout = options?.timeout || 30000;
    await this.client.waitForEvent('Page.loadEventFired', timeout);
  }

  /**
   * Get current URL
   */
  async getUrl(): Promise<string> {
    return this.evaluate(() => window.location.href);
  }

  /**
   * Get page title
   */
  async getTitle(): Promise<string> {
    return this.evaluate(() => document.title);
  }

  /**
   * Get connection mode
   */
  getConnectionMode(): ConnectionMode | null {
    return this.connectionMode;
  }

  /**
   * Find element by selector
   */
  private async findElement(
    selector: string
  ): Promise<{ nodeId: number } | null> {
    const doc = await this.client.sendCommand<{ root: { nodeId: number } }>(
      'DOM.getDocument'
    );

    const result = await this.client.sendCommand<{ nodeId: number }>(
      'DOM.querySelector',
      {
        nodeId: doc.root.nodeId,
        selector,
      }
    );

    return result.nodeId ? result : null;
  }

  /**
   * Ensure client is connected
   */
  private ensureConnected(): void {
    if (!this.initialized) {
      throw new Error('Browser controller not initialized. Call initialize() first.');
    }
    if (this.connectionMode === 'degraded') {
      throw new Error('Browser control not available in degraded mode');
    }
    if (!this.client.isConnected()) {
      throw new Error('Not connected to browser');
    }
  }
}
