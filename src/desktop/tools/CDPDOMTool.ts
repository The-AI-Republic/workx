/**
 * CDP DOM Tool - Desktop Version
 *
 * Desktop-mode implementation of DOM tool using Chrome DevTools Protocol (CDP).
 * Uses NativeBrowserController for browser automation instead of Chrome extension APIs.
 *
 * Shares the same serialization pipeline as the extension version for consistent
 * HTML processing before sending to LLM.
 *
 * @module desktop/tools/CDPDOMTool
 */

import {
  BaseTool,
  createToolDefinition,
  type BaseToolRequest,
  type BaseToolOptions,
  type ToolDefinition,
} from '@/tools/BaseTool';
import type { SerializedDom, ActionResult } from '@/types/domTool';
import { NativeBrowserController } from './browser/NativeBrowserController';
import { DomSnapshot, FrameRegistry } from '@/tools/dom/DomSnapshot';
import { serializedNodeToHtml } from '@/tools/dom/utils';
import type { VirtualNode, PageContext, SnapshotStats } from '@/tools/dom/types';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * CDP DOM tool request (same interface as extension DOMTool for compatibility)
 */
export interface CDPDOMToolRequest {
  action: 'snapshot' | 'click' | 'type' | 'keypress' | 'scroll';
  node_id?: string | number;
  text?: string;
  key?: string;
  options?: any;
}

/**
 * CDP DOM Tool Implementation
 *
 * Provides DOM inspection and actions using CDP for desktop mode.
 */
export class CDPDOMTool extends BaseTool {
  private controller: NativeBrowserController;
  private initialized = false;

  protected toolDefinition: ToolDefinition = createToolDefinition(
    'browser_dom',
    `Unified DOM inspection and action tool for page interaction.

## USAGE PATTERN: Observe-Action Cycle
The DOM tool implements a closed-loop observe-action pattern:
- **One Observation + One Action = One Unit**: After observing the page state, perform ONLY ONE action (click, type, scroll), then observe again
- **DO NOT** plan or execute multiple actions based on a single observation
- **DO** observe the page after each action to see the updated state before deciding the next action

Example workflow:
1. Observe page → See login form → Click username field
2. Observe page → See username field focused → Type username
3. Observe page → See password field → Click password field
4. Observe page → See password field focused → Type password
5. Observe page → See submit button → Click submit

## TYPE ACTION BEHAVIOR
The type action automatically focuses the target element before typing.

## Available Actions
1. **snapshot**: Capture current page DOM for AI analysis
2. **click**: Click on an element by node_id
3. **type**: Type text into an element
4. **keypress**: Send keyboard key (Enter, Escape, Tab, etc.)
5. **scroll**: Scroll page or element`,
    {
      action: {
        type: 'string',
        enum: ['snapshot', 'click', 'type', 'keypress', 'scroll'],
        description: 'Action to perform',
      },
      node_id: {
        type: 'string',
        description: 'Target element node ID (for click, type, scroll actions)',
      },
      text: {
        type: 'string',
        description: 'Text to type (for type action)',
      },
      key: {
        type: 'string',
        description: 'Key to press (for keypress action): Enter, Escape, Tab, ArrowUp, ArrowDown, etc.',
      },
      options: {
        type: 'object',
        description: 'Additional options for the action',
      },
    },
    {
      required: ['action'],
      version: '1.0.0',
      metadata: {
        capabilities: [
          'dom_snapshot',
          'dom_serialization',
          'page_click',
          'page_input',
          'page_keypress',
          'cdp_based',
        ],
        platforms: ['desktop'],
      },
    }
  );

  constructor() {
    super();
    this.controller = new NativeBrowserController();
  }

  /**
   * Initialize the CDP connection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.controller.initialize();
    this.initialized = true;
    console.log('[CDPDOMTool] Initialized');
  }

  /**
   * Ensure controller is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Execute DOM tool action
   */
  protected async executeImpl(
    request: BaseToolRequest,
    options?: BaseToolOptions
  ): Promise<SerializedDom | ActionResult> {
    await this.ensureInitialized();

    const typedRequest = request as CDPDOMToolRequest;

    switch (typedRequest.action) {
      case 'snapshot':
        return this.executeSnapshot(typedRequest.options);
      case 'click':
        return this.executeClick(typedRequest.node_id!, typedRequest.options);
      case 'type':
        return this.executeType(typedRequest.node_id!, typedRequest.text!, typedRequest.options);
      case 'keypress':
        return this.executeKeypress(typedRequest.key!, typedRequest.options);
      case 'scroll':
        return this.executeScroll(typedRequest.node_id, typedRequest.options);
      default:
        throw new Error(`Unknown action: ${(typedRequest as any).action}`);
    }
  }

  /**
   * Execute snapshot action - capture and serialize DOM
   */
  private async executeSnapshot(options?: any): Promise<SerializedDom> {
    const startTime = Date.now();

    // Get raw DOM snapshot from CDP
    const rawSnapshot = await this.controller.getSnapshot();

    // Get page context
    const url = await this.controller.getUrl();
    const title = await this.controller.getTitle();

    // Parse HTML and build virtual DOM
    const virtualDom = await this.parseHtmlToVirtualDom(rawSnapshot.html);

    // Get viewport info via CDP
    const viewportInfo = await this.controller.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
    }));

    // Build page context
    const pageContext: PageContext = {
      url,
      title,
      viewport: {
        width: viewportInfo.width,
        height: viewportInfo.height,
        overflowTop: viewportInfo.scrollY,
        overflowBottom: Math.max(0, viewportInfo.scrollHeight - viewportInfo.height - viewportInfo.scrollY),
      },
    };

    // Build stats
    const stats: SnapshotStats = {
      nodeCount: this.countNodes(virtualDom),
      textNodeCount: this.countTextNodes(virtualDom),
      elementCount: this.countElements(virtualDom),
      interactiveCount: 0,
      iframeCount: 0,
    };

    // Create snapshot and serialize using shared pipeline
    const snapshot = new DomSnapshot(virtualDom, pageContext, stats);
    const rawDom = snapshot.serialize();

    // Transform to stringified format for LLM consumption
    const htmlContent = serializedNodeToHtml(rawDom.page.body);

    return {
      page: {
        context: {
          url: rawDom.page.context.url,
          title: rawDom.page.context.title,
          viewport: {
            width: `${rawDom.page.context.viewport.width}px`,
            height: `${rawDom.page.context.viewport.height}px`,
            overflowTop: `${rawDom.page.context.viewport.overflowTop}px`,
            overflowBottom: `${rawDom.page.context.viewport.overflowBottom}px`,
          },
        },
        body: htmlContent,
      },
      metadata: {
        nodeCount: stats.nodeCount,
        textNodeCount: stats.textNodeCount,
        elementCount: stats.elementCount,
        interactiveCount: stats.interactiveCount,
        iframeCount: stats.iframeCount,
        duration: Date.now() - startTime,
        platform: 'desktop',
      },
    };
  }

  /**
   * Execute click action
   */
  private async executeClick(nodeId: string | number, options?: any): Promise<ActionResult> {
    const selector = this.nodeIdToSelector(nodeId);
    await this.controller.click(selector, options);

    return {
      success: true,
      action: 'click',
      nodeId: String(nodeId),
      message: `Clicked element ${nodeId}`,
    };
  }

  /**
   * Execute type action
   */
  private async executeType(
    nodeId: string | number,
    text: string,
    options?: any
  ): Promise<ActionResult> {
    const selector = this.nodeIdToSelector(nodeId);
    await this.controller.type(selector, text, options);

    return {
      success: true,
      action: 'type',
      nodeId: String(nodeId),
      text,
      message: `Typed "${text}" into element ${nodeId}`,
    };
  }

  /**
   * Execute keypress action
   */
  private async executeKeypress(key: string, options?: any): Promise<ActionResult> {
    // Use CDP Input.dispatchKeyEvent
    await this.controller.evaluate((keyName: string) => {
      const event = new KeyboardEvent('keydown', {
        key: keyName,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement?.dispatchEvent(event);

      const upEvent = new KeyboardEvent('keyup', {
        key: keyName,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement?.dispatchEvent(upEvent);
    }, key);

    return {
      success: true,
      action: 'keypress',
      key,
      message: `Pressed key: ${key}`,
    };
  }

  /**
   * Execute scroll action
   */
  private async executeScroll(nodeId?: string | number, options?: any): Promise<ActionResult> {
    if (nodeId) {
      const selector = this.nodeIdToSelector(nodeId);
      await this.controller.scroll(selector);
    } else {
      // Scroll page
      const amount = options?.amount || 300;
      const direction = options?.direction || 'down';
      const delta = direction === 'up' ? -amount : amount;

      await this.controller.evaluate((scrollDelta: number) => {
        window.scrollBy(0, scrollDelta);
      }, delta);
    }

    return {
      success: true,
      action: 'scroll',
      nodeId: nodeId ? String(nodeId) : undefined,
      message: nodeId ? `Scrolled to element ${nodeId}` : 'Scrolled page',
    };
  }

  /**
   * Convert node ID to CSS selector
   * Node IDs are in format "frameId:backendNodeId" or just a number
   */
  private nodeIdToSelector(nodeId: string | number): string {
    // For now, use data-browserx-id attribute that we inject during snapshot
    // In future, we can use CDP's DOM.resolveNode with backendNodeId
    return `[data-browserx-id="${nodeId}"]`;
  }

  /**
   * Parse HTML string to VirtualNode tree
   * This is a simplified version - in production, use the full DOM tree builder
   */
  private async parseHtmlToVirtualDom(html: string): Promise<VirtualNode> {
    // Use CDP to build the DOM tree with node IDs
    const domTree = await this.controller.evaluate(() => {
      function buildVirtualNode(element: Element, nodeId: number): any {
        const children: any[] = [];
        let childId = nodeId * 100; // Simple ID generation

        for (const child of element.children) {
          children.push(buildVirtualNode(child, childId++));
        }

        // Get text content (direct text nodes only)
        let textContent = '';
        for (const node of element.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            textContent += node.textContent?.trim() || '';
          }
        }

        const rect = element.getBoundingClientRect();

        return {
          tag: element.tagName.toLowerCase(),
          backendNodeId: nodeId,
          frameId: 0,
          attributes: Array.from(element.attributes).reduce(
            (acc, attr) => ({ ...acc, [attr.name]: attr.value }),
            {}
          ),
          text: textContent || undefined,
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          isVisible: rect.width > 0 && rect.height > 0,
          isInteractive:
            element.tagName === 'BUTTON' ||
            element.tagName === 'A' ||
            element.tagName === 'INPUT' ||
            element.tagName === 'SELECT' ||
            element.tagName === 'TEXTAREA' ||
            element.getAttribute('role') === 'button' ||
            element.hasAttribute('onclick'),
          children: children.length > 0 ? children : undefined,
        };
      }

      return buildVirtualNode(document.body, 1);
    });

    return domTree as VirtualNode;
  }

  /**
   * Count total nodes in tree
   */
  private countNodes(node: VirtualNode): number {
    let count = 1;
    if (node.children) {
      for (const child of node.children) {
        count += this.countNodes(child);
      }
    }
    return count;
  }

  /**
   * Count text nodes
   */
  private countTextNodes(node: VirtualNode): number {
    let count = node.text ? 1 : 0;
    if (node.children) {
      for (const child of node.children) {
        count += this.countTextNodes(child);
      }
    }
    return count;
  }

  /**
   * Count element nodes
   */
  private countElements(node: VirtualNode): number {
    let count = node.tag ? 1 : 0;
    if (node.children) {
      for (const child of node.children) {
        count += this.countElements(child);
      }
    }
    return count;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.initialized) {
      await this.controller.close();
      this.initialized = false;
    }
  }
}
