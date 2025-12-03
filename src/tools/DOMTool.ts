/**
 * DOM Tool v2.0 - High-Level DOM Reading
 *
 * Refactored to provide a single high-level interaction capture operation
 * that captures page models for AI agent consumption.
 *
 * BREAKING CHANGE: Removed all atomic operations (query, click, type, etc.)
 * in favor of comprehensive DOM capture with selector_map for element lookup.
 */

import { BaseTool, createToolDefinition, type BaseToolRequest, type BaseToolOptions, type ToolDefinition } from './BaseTool';
import type {
  SerializationOptions,
  SerializedDom,
  ClickOptions,
  TypeOptions,
  KeyPressOptions,
  ActionResult,
} from '../types/domTool';
import { DomService } from './dom/DomService';

// ============================================================================
// Type Definitions for v3.0 Wrapper
// ============================================================================

/**
 * Unified DOM tool request (discriminated union by action type)
 * Note: tab_id is passed internally via metadata, not exposed to LLM
 */
export interface DOMToolRequest {
  action: 'snapshot' | 'click' | 'type' | 'keypress' | 'scroll';
  node_id?: string | number; // Format: "frameId:backendNodeId" (e.g., "0:123") or number for backward compatibility
  text?: string;
  key?: string;
  options?: any;
}

/**
 * Unified DOM tool response
 */
export interface DOMToolResponse {
  success: boolean;
  data?: SerializedDom | ActionResult;
  error?: {
    code: string;
    message: string;
    details: Record<string, any>;
  };
  metadata: {
    duration: number;
    toolName: 'browser_dom';
    tabId: number;
    retryCount?: number;
  };
}

/**
 * DOM Tool error codes
 */
export enum DOMToolErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TAB_NOT_FOUND = 'TAB_NOT_FOUND',
  CONTENT_SCRIPT_NOT_LOADED = 'CONTENT_SCRIPT_NOT_LOADED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  ACTION_FAILED = 'ACTION_FAILED',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}
/**
 * DOM Tool v3.0 Implementation
 *
 * CDP-based DOM operations with visual effects support.
 * All DOM operations use Chrome DevTools Protocol for cross-origin/shadow DOM support.
 */
export class DOMTool extends BaseTool {
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
The type action automatically focuses the target element before typing and auto-detects element type:
- **DO NOT** click an element to focus it before typing - type action handles focus automatically
- **EXCEPTION**: If target is a button/trigger that renders a NEW text input (e.g., "Add comment" button), follow observe-action pattern:
  1. Observe page → See "Add comment" button → Click button
  2. Observe page → See newly rendered text area → Type text

## FINDING CORRECT INPUT TARGETS

**Traditional Input Elements** (type directly):
- <input>, <textarea> elements
- contenteditable="true" divs already visible

**Modern Rich Text Editors** (find the contenteditable div):
- Quill: .ql-editor div with contenteditable="true"
- Slate: [data-slate-editor="true"] div
- Draft.js: .public-DraftEditor-content div
- TinyMCE: #tinymce or .mce-content-body
- CKEditor: .cke_editable
- ProseMirror/Tiptap: .ProseMirror
- Lexical: [contenteditable="true"][data-lexical-editor="true"]
**Important**: Target the inner contenteditable div, NOT wrapper containers

**Trigger Buttons** (click first to reveal input):
- Buttons with labels like "Add", "Reply", "Comment", "Edit", "Write"
- Placeholder divs that expand into editors when clicked

## VIEWPORT AWARENESS
Snapshots only return elements visible in the current viewport (inViewport: true). Elements outside viewport are filtered to reduce token consumption.

**Key Principles**:
1. If you don't see expected elements, they may be below/above current scroll position
2. Use scroll action to discover more content
3. Scrollable elements are marked with aria-label="scrollable: [direction]" (including <html> tag for page scroll)
4. To scroll the main page, target the <html> element which is always marked as scrollable

**Scrolling Decision**:
- Looking for content in main page flow? → Scroll the <html> element (it has scrollable: vertical)
- Page inside an iframe? → Scroll that iframe's <html> element
- Element has aria-label="scrollable: ..."? → Scroll that container
- Looking in specific widget/panel/sidebar? → Scroll that container`,
    {
      action: {
        type: 'string',
        description: 'Action type: snapshot (capture DOM - only returns elements visible in viewport), click (click element), type (input text), keypress (keyboard input), scroll (scroll element by relative pixel offset)',
        enum: ['snapshot', 'click', 'type', 'keypress', 'scroll'],
      },
      node_id: {
        type: 'string',
        description: 'Target element node ID from snapshot (required for click, type, and scroll actions). Format: "frameId:backendNodeId" (e.g., "0:123" for main frame, "1:456" for iframe). For scroll: target the <html> element (marked with scrollable: vertical) to scroll the main page. For iframe page scroll, target the iframe\'s <html> element. For scrollable containers (modals, chat, sidebars), target the element with aria-label="scrollable: ...".',
      },
      text: {
        type: 'string',
        description: 'Text to type into element (required for type action). Use options.commit to control finalization: "change" (default, fires change event) or "enter" (appends Enter keystroke for search/chat inputs).',
      },
      key: {
        type: 'string',
        description: 'Key to press (required for keypress action). Examples: Enter, Escape, Tab, ArrowDown',
      },
      options: {
        type: 'object',
        description: 'Action-specific options. For scroll: { scrollX?: number, scrollY?: number } - RELATIVE pixel offsets (deltas, not absolute positions). scrollY: positive=down, negative=up. scrollX: positive=right, negative=left. Examples: {scrollY: 500} scrolls down 500px, {scrollY: -300} scrolls up 300px. For type: { clearFirst?: boolean, speed?: number, method?: "auto"|"instant"|"char-by-char"|"paste", commit?: "change"|"enter", blur?: boolean }. The method option controls typing strategy: "auto" (default, auto-detects based on element type AND content length - for content ≤300 chars uses char-by-char for contenteditable or instant for inputs; for content >300 chars uses paste method for efficiency), "instant" (fast, works for <input>/<textarea>), "char-by-char" (simulates human typing character-by-character, best for rich text editors like Quill/Slate/Draft.js, configurable speed in ms per character - AVOID for long content as it\'s slow), "paste" (simulates Ctrl+V paste, fast for rich editors - RECOMMENDED for content >300 characters). **IMPORTANT**: For text longer than 300 characters, use method: "paste" to avoid slow character-by-character typing. For click: { button?: "left"|"right"|"middle", scrollIntoView?: boolean }. For keypress: { modifiers?: { ctrl?: boolean, shift?: boolean, alt?: boolean, meta?: boolean } }. For snapshot: { includeValues?: boolean, metadata?: { includeAriaLabel?: boolean, includeText?: boolean, includeValue?: boolean, includeInputType?: boolean, includeHint?: boolean, includeBbox?: boolean, includeStates?: boolean, includeHref?: boolean } }.',
      },
    },
    {
      required: ['action'],
      category: 'dom',
      version: '3.0.0',
      metadata: {
        capabilities: [
          'dom_snapshot',
          'dom_serialization',
          'page_click',
          'page_input',
          'page_keypress',
          'change_detection',
          'iframe_support',
          'shadow_dom_support',
          'node_id_preservation',
          'auto_invalidation',
          'incremental_virtual_dom_updates',
        ],
        permissions: ['activeTab', 'scripting', 'tabs'],
      },
    }
  );

  constructor() {
    super();
  }

  /**
   * Override execute to inject action into metadata
   */
  async execute(request: BaseToolRequest, options?: BaseToolOptions): Promise<any> {
    const typedRequest = request as DOMToolRequest;

    // Inject action into metadata so it's available in the response
    const enrichedOptions = {
      ...options,
      metadata: {
        ...options?.metadata,
        action: typedRequest.action,
      },
    };

    return super.execute(request, enrichedOptions);
  }

  /**
   * Execute DOM tool action - routes to v3.0 implementation
   */
  protected async executeImpl(
    request: BaseToolRequest,
    options?: BaseToolOptions
  ): Promise<SerializedDom | ActionResult> {

    // Validate Chrome context
    this.validateChromeContext();

    // Validate required permissions
    await this.validatePermissions(['activeTab', 'scripting']);

    // Validate request
    const validationError = this.validateRequest(request);
    if (validationError) {
      throw new Error(validationError);
    }

    const typedRequest = request as DOMToolRequest;

    // Get tabId from metadata (passed internally, not from LLM)
    const tabId = options?.metadata?.tabId;

    // Check if tabId is valid
    if (tabId === undefined || tabId === null) {
      throw new Error('Target tab ID not provided in execution context');
    }

    if (tabId === -1) {
      throw new Error('Target tab cannot be found. Please ensure a tab is bound to the current session.');
    }


    // Validate tab exists
    try {
      const tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(`Target tab ${tabId} not found or inaccessible`);
    }


    // Route by action type - return raw data, BaseTool.execute() will wrap it
    let result: SerializedDom | ActionResult;
    switch (typedRequest.action) {
      case 'snapshot':
        result = await this.executeSnapshot(tabId, typedRequest.options);
        break;
      case 'click':
        result = await this.executeClick(tabId, typedRequest.node_id!, typedRequest.options);
        break;
      case 'type':
        result = await this.executeType(tabId, typedRequest.node_id!, typedRequest.text!, typedRequest.options);
        break;
      case 'keypress':
        result = await this.executeKeypress(tabId, typedRequest.key!, typedRequest.options);
        break;
      case 'scroll':
        result = await this.executeScroll(tabId, typedRequest.node_id!, typedRequest.options);
        break;
      default:
        throw new Error(`Unknown action: ${typedRequest.action}`);
    }

    return result;
  }

  // ============================================================================
  // v3.0 Action Execution Methods
  // ============================================================================

  /**
   * Execute snapshot action
   */
  private async executeSnapshot(
    tabId: number,
    options?: SerializationOptions
  ): Promise<SerializedDom> {
    this.log('debug', 'Executing snapshot', { tabId, options });

    // Always use CDP-based implementation (content-script implementation removed)
    const domService = await DomService.forTab(tabId);
    const serializedDom = await domService.getSerializedDom();
    return serializedDom;
  }

  /**
   * Execute click action
   */
  private async executeClick(
    tabId: number,
    nodeId: number | string,
    options?: ClickOptions
  ): Promise<ActionResult> {

    // Always use CDP-based implementation (content-script implementation removed)
    const domService = await DomService.forTab(tabId);
    return await domService.click(nodeId);
  }

  /**
   * Execute type action
   */
  private async executeType(
    tabId: number,
    nodeId: number | string,
    text: string,
    options?: TypeOptions
  ): Promise<ActionResult> {

    // Always use CDP-based implementation (content-script implementation removed)
    const domService = await DomService.forTab(tabId);
    return await domService.type(nodeId, text, options);
  }

  /**
   * Execute keypress action
   */
  private async executeKeypress(
    tabId: number,
    key: string,
    options?: KeyPressOptions
  ): Promise<ActionResult> {

    // Always use CDP-based implementation (content-script implementation removed)
    const domService = await DomService.forTab(tabId);
    // Extract modifiers from options if present
    const modifiers = options?.modifiers
      ? Object.entries(options.modifiers)
        .filter(([_, enabled]) => enabled)
        .map(([mod]) => mod.charAt(0).toUpperCase() + mod.slice(1))
      : undefined;
    return await domService.keypress(key, modifiers);
  }

  /**
   * Execute scroll action
   */
  private async executeScroll(
    tabId: number,
    nodeId: number,
    options?: { scrollX?: number; scrollY?: number }
  ): Promise<ActionResult> {

    // Always use CDP-based implementation
    const domService = await DomService.forTab(tabId);

    // Extract scroll coordinates
    // scrollX defaults to 0, scrollY defaults to undefined (which triggers 80% of window height in DomService)
    const scrollX = options?.scrollX ?? 0;
    const scrollY = options?.scrollY;

    return await domService.scroll(nodeId, scrollX, scrollY);
  }

  // ============================================================================
  // v3.0 Request Validation & Error Handling
  // ============================================================================

  /**
   * Validate DOMToolRequest
   */
  private validateRequest(request: unknown): string | null {
    if (!request || typeof request !== 'object') {
      return 'Request must be an object';
    }

    const req = request as any;

    // Validate action
    if (!['snapshot', 'click', 'type', 'keypress', 'scroll'].includes(req.action)) {
      return `Invalid action: ${req.action}. Must be one of: snapshot, click, type, keypress, scroll`;
    }

    // Helper to validate node_id (accepts string "frameId:backendNodeId" or number for backward compatibility)
    const validateNodeId = (actionName: string): string | null => {
      if (req.node_id === undefined) {
        return `node_id is required for ${actionName} action`;
      }
      // Accept string format "frameId:backendNodeId" (e.g., "0:123", "1:456")
      if (typeof req.node_id === 'string') {
        // Validate format: should be "number:number"
        const parts = req.node_id.split(':');
        if (parts.length !== 2) {
          return `node_id must be in format "frameId:backendNodeId" (e.g., "0:123")`;
        }
        const frameId = parseInt(parts[0], 10);
        const backendNodeId = parseInt(parts[1], 10);
        if (isNaN(frameId) || isNaN(backendNodeId)) {
          return `node_id must contain valid numbers in format "frameId:backendNodeId"`;
        }
        return null;
      }
      // Accept number for backward compatibility
      if (typeof req.node_id === 'number') {
        if (!Number.isInteger(req.node_id)) {
          return 'node_id must be an integer';
        }
        return null;
      }
      return `node_id must be a string (format: "frameId:backendNodeId") or number`;
    };

    // Action-specific validation
    switch (req.action) {
      case 'snapshot':
        return null; // Only action is required

      case 'click':
        return validateNodeId('click');

      case 'type':
        const typeNodeIdError = validateNodeId('type');
        if (typeNodeIdError) return typeNodeIdError;
        if (!req.text || typeof req.text !== 'string') {
          return 'text is required for type action';
        }
        return null;

      case 'keypress':
        if (!req.key || typeof req.key !== 'string') {
          return 'key is required for keypress action';
        }
        return null;

      case 'scroll':
        return validateNodeId('scroll');

      default:
        return `Unknown action: ${req.action}`;
    }
  }

  /**
   * Handle errors from action execution
   */
  private handleError(
    error: any,
    action: string,
    tabId: number,
    duration: number
  ): DOMToolResponse {
    const errorMessage = error?.message || String(error);

    this.log('error', `DOM tool action failed: ${errorMessage}`, { action, tabId });

    // Map error to code
    let code = DOMToolErrorCode.UNKNOWN_ERROR;
    if (errorMessage.includes('not found') || errorMessage.includes('No tab with id')) {
      code = DOMToolErrorCode.TAB_NOT_FOUND;
    } else if (errorMessage.includes('Could not establish connection')) {
      code = DOMToolErrorCode.CONTENT_SCRIPT_NOT_LOADED;
    } else if (errorMessage.includes('Element') && errorMessage.includes('not found')) {
      code = DOMToolErrorCode.ELEMENT_NOT_FOUND;
    } else if (errorMessage.includes('action failed')) {
      code = DOMToolErrorCode.ACTION_FAILED;
    } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
      code = DOMToolErrorCode.TIMEOUT;
    } else if (errorMessage.includes('permission')) {
      code = DOMToolErrorCode.PERMISSION_DENIED;
    } else if (errorMessage.includes('Invalid action') || errorMessage.includes('is required')) {
      code = DOMToolErrorCode.VALIDATION_ERROR;
    }

    return {
      success: false,
      error: {
        code,
        message: errorMessage,
        details: {
          action,
          tabId,
          stack: error instanceof Error ? error.stack : undefined,
        },
      },
      metadata: {
        duration,
        toolName: 'browser_dom',
        tabId,
      },
    };
  }
}
