/**
 * Extension Browser Controller
 *
 * Extension-mode implementation of BrowserController using ChromeDebuggerClient.
 *
 * @module extension/tools/browser/ExtensionBrowserController
 */

import type { BrowserController } from '@/core/tools/browser/BrowserController';
import type {
  SerializedDOM,
  NavigateOptions,
  ClickOptions,
  TypeOptions,
  ScreenshotOptions,
  WaitCondition,
  SerializedElement,
  PageMetadata,
} from '@/core/tools/browser/types';
import { ChromeDebuggerClient } from './ChromeDebuggerClient';

/**
 * Default timeout for operations (30 seconds)
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * ExtensionBrowserController implements BrowserController for Chrome extension mode
 *
 * @example
 * ```typescript
 * const controller = new ExtensionBrowserController(tabId);
 * await controller.initialize();
 *
 * await controller.navigate('https://example.com');
 * const snapshot = await controller.getSnapshot();
 * ```
 */
export class ExtensionBrowserController implements BrowserController {
  private tabId: number;
  private client: ChromeDebuggerClient;
  private connected = false;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.client = new ChromeDebuggerClient();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.client.attach({ tabId: this.tabId });
    await this.client.enableDomain('DOM');
    await this.client.enableDomain('Page');
    await this.client.enableDomain('Runtime');
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    await this.client.detach();
    this.connected = false;
  }

  async close(): Promise<void> {
    // In extension mode, we don't close the browser/tab
    // Just disconnect from debugger
    await this.disconnect();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  async navigate(url: string, options?: NavigateOptions): Promise<void> {
    this.ensureConnected();

    await this.client.sendCommand('Page.navigate', { url });

    // Wait for navigation to complete
    if (options?.waitUntil !== 'domcontentloaded') {
      await this.waitForLoad(options?.timeout);
    }
  }

  async goBack(): Promise<void> {
    this.ensureConnected();
    await this.client.sendCommand('Page.goBack');
    await this.waitForLoad();
  }

  async goForward(): Promise<void> {
    this.ensureConnected();
    await this.client.sendCommand('Page.goForward');
    await this.waitForLoad();
  }

  async reload(): Promise<void> {
    this.ensureConnected();
    await this.client.sendCommand('Page.reload');
    await this.waitForLoad();
  }

  async getUrl(): Promise<string> {
    this.ensureConnected();
    const result = await this.evaluate<string>(() => window.location.href);
    return result;
  }

  async getTitle(): Promise<string> {
    this.ensureConnected();
    const result = await this.evaluate<string>(() => document.title);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOM Interaction
  // ─────────────────────────────────────────────────────────────────────────

  async click(selector: string, options?: ClickOptions): Promise<void> {
    this.ensureConnected();

    const nodeId = await this.findElement(selector);
    const box = await this.getElementBoundingBox(nodeId);

    if (!box) {
      throw new Error(`Element not visible: ${selector}`);
    }

    // Calculate click position (center of element)
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Dispatch mouse events
    const button = options?.button || 'left';
    const clickCount = options?.clickCount || 1;
    const delay = options?.delay || 0;

    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
    });

    if (delay > 0) {
      await this.sleep(delay);
    }

    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
    });
  }

  async type(selector: string, text: string, options?: TypeOptions): Promise<void> {
    this.ensureConnected();

    // Focus the element first
    await this.focus(selector);

    // Clear existing text if requested
    if (options?.clear) {
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
        type: 'char',
        text: char,
      });
      if (delay > 0) {
        await this.sleep(delay);
      }
    }
  }

  async select(selector: string, ...values: string[]): Promise<void> {
    this.ensureConnected();

    await this.evaluate(
      ((sel: string, vals: string[]) => {
        const el = document.querySelector(sel) as HTMLSelectElement;
        if (!el) throw new Error(`Element not found: ${sel}`);

        for (const option of Array.from(el.options)) {
          option.selected = vals.includes(option.value);
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }) as (...args: unknown[]) => void,
      selector,
      values
    );
  }

  async focus(selector: string): Promise<void> {
    this.ensureConnected();

    const nodeId = await this.findElement(selector);
    await this.client.sendCommand('DOM.focus', { nodeId });
  }

  async hover(selector: string): Promise<void> {
    this.ensureConnected();

    const nodeId = await this.findElement(selector);
    const box = await this.getElementBoundingBox(nodeId);

    if (!box) {
      throw new Error(`Element not visible: ${selector}`);
    }

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
  }

  async scroll(target: string | { x: number; y: number }): Promise<void> {
    this.ensureConnected();

    if (typeof target === 'string') {
      await this.evaluate(((sel: string) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }) as (...args: unknown[]) => void, target);
    } else {
      await this.evaluate(
        ((x: number, y: number) => {
          window.scrollTo({ left: x, top: y, behavior: 'smooth' });
        }) as (...args: unknown[]) => void,
        target.x,
        target.y
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Content Extraction
  // ─────────────────────────────────────────────────────────────────────────

  async getSnapshot(): Promise<SerializedDOM> {
    this.ensureConnected();

    // Get document
    const { root: docNode } = await this.client.sendCommand<{ root: { nodeId: number } }>(
      'DOM.getDocument',
      { depth: -1, pierce: true }
    );

    // Serialize DOM tree
    const root = await this.serializeNode(docNode.nodeId);

    // Get page metadata
    const metadata = await this.getPageMetadata();

    return {
      root,
      metadata,
    };
  }

  async screenshot(options?: ScreenshotOptions): Promise<string> {
    this.ensureConnected();

    const params: Record<string, unknown> = {
      format: options?.format || 'png',
    };

    if (options?.quality !== undefined) {
      params.quality = options.quality;
    }

    if (options?.fullPage) {
      // Get full page dimensions
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
      params.captureBeyondViewport = true;
    } else if (options?.clip) {
      params.clip = { ...options.clip, scale: 1 };
    }

    const { data } = await this.client.sendCommand<{ data: string }>(
      'Page.captureScreenshot',
      params
    );

    return data;
  }

  async getTextContent(): Promise<string> {
    this.ensureConnected();
    return this.evaluate<string>(() => document.body.innerText);
  }

  async getHtml(): Promise<string> {
    this.ensureConnected();
    return this.evaluate<string>(() => document.documentElement.outerHTML);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // JavaScript Execution
  // ─────────────────────────────────────────────────────────────────────────

  async evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
    this.ensureConnected();

    let expression: string;
    if (typeof fn === 'function') {
      const fnStr = fn.toString();
      const argsStr = args.map((arg) => JSON.stringify(arg)).join(', ');
      expression = `(${fnStr})(${argsStr})`;
    } else {
      expression = fn;
    }

    const result = await this.client.sendCommand<{
      result: { value: T; type: string };
      exceptionDetails?: { exception: { description: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception.description);
    }

    return result.result.value;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Waiting
  // ─────────────────────────────────────────────────────────────────────────

  async waitFor(condition: WaitCondition): Promise<void> {
    this.ensureConnected();

    const timeout = condition.timeout || DEFAULT_TIMEOUT;
    const startTime = Date.now();

    switch (condition.type) {
      case 'selector': {
        while (Date.now() - startTime < timeout) {
          try {
            const nodeId = await this.findElement(condition.selector);
            if (condition.visible) {
              const box = await this.getElementBoundingBox(nodeId);
              if (box && box.width > 0 && box.height > 0) {
                return;
              }
            } else {
              return;
            }
          } catch {
            // Element not found yet, continue waiting
          }
          await this.sleep(100);
        }
        throw new Error(`Timeout waiting for selector: ${condition.selector}`);
      }

      case 'navigation': {
        await this.waitForLoad(timeout);
        return;
      }

      case 'networkIdle': {
        // Simple implementation: wait for no network activity for 500ms
        let lastActivity = Date.now();
        while (Date.now() - startTime < timeout) {
          await this.sleep(100);
          // If 500ms have passed without activity, consider network idle
          if (Date.now() - lastActivity > 500) {
            return;
          }
        }
        throw new Error('Timeout waiting for network idle');
      }

      case 'function': {
        while (Date.now() - startTime < timeout) {
          const result = await this.evaluate<boolean>(condition.fn);
          if (result) {
            return;
          }
          await this.sleep(100);
        }
        throw new Error('Timeout waiting for function to return true');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Browser controller not connected. Call initialize() first.');
    }
  }

  private async findElement(selector: string): Promise<number> {
    const { root } = await this.client.sendCommand<{ root: { nodeId: number } }>(
      'DOM.getDocument',
      { depth: 0 }
    );

    const { nodeId } = await this.client.sendCommand<{ nodeId: number }>(
      'DOM.querySelector',
      {
        nodeId: root.nodeId,
        selector,
      }
    );

    if (!nodeId) {
      throw new Error(`Element not found: ${selector}`);
    }

    return nodeId;
  }

  private async getElementBoundingBox(
    nodeId: number
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const { model } = await this.client.sendCommand<{
        model: { content: number[] };
      }>('DOM.getBoxModel', { nodeId });

      if (!model || !model.content) {
        return null;
      }

      // content is [x1, y1, x2, y2, x3, y3, x4, y4]
      const [x1, y1, x2, , , y3] = model.content;
      return {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y3 - y1,
      };
    } catch {
      return null;
    }
  }

  private async serializeNode(nodeId: number): Promise<SerializedElement> {
    const { node } = await this.client.sendCommand<{
      node: {
        nodeId: number;
        nodeName: string;
        nodeType: number;
        attributes?: string[];
        childNodeCount?: number;
        children?: Array<{ nodeId: number }>;
        nodeValue?: string;
      };
    }>('DOM.describeNode', { nodeId, depth: 1 });

    const attributes: Record<string, string> = {};
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        attributes[node.attributes[i]] = node.attributes[i + 1];
      }
    }

    const box = await this.getElementBoundingBox(nodeId);

    const children: SerializedElement[] = [];
    if (node.children) {
      for (const child of node.children) {
        try {
          const serialized = await this.serializeNode(child.nodeId);
          children.push(serialized);
        } catch {
          // Skip nodes that can't be serialized
        }
      }
    }

    return {
      nodeId: node.nodeId,
      tagName: node.nodeName.toLowerCase(),
      attributes,
      textContent: node.nodeValue || undefined,
      children,
      boundingBox: box || undefined,
      isVisible: box !== null && box.width > 0 && box.height > 0,
      isInteractive: this.isInteractiveTag(node.nodeName),
    };
  }

  private isInteractiveTag(tagName: string): boolean {
    const interactiveTags = [
      'A',
      'BUTTON',
      'INPUT',
      'SELECT',
      'TEXTAREA',
      'DETAILS',
      'SUMMARY',
      'LABEL',
    ];
    return interactiveTags.includes(tagName.toUpperCase());
  }

  private async getPageMetadata(): Promise<PageMetadata> {
    const [url, title, viewport, readyState] = await Promise.all([
      this.getUrl(),
      this.getTitle(),
      this.evaluate<{ width: number; height: number }>(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })),
      this.evaluate<string>(() => document.readyState),
    ]);

    return {
      url,
      title,
      viewport,
      documentState: readyState as 'loading' | 'interactive' | 'complete',
    };
  }

  private async waitForLoad(timeout = DEFAULT_TIMEOUT): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const readyState = await this.evaluate<string>(() => document.readyState);
      if (readyState === 'complete') {
        return;
      }
      await this.sleep(100);
    }

    throw new Error('Timeout waiting for page load');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
