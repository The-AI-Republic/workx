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
 */
export interface DOMToolRequest {
  action: 'snapshot' | 'click' | 'type' | 'keypress' | 'scroll';
  tab_id?: number;
  node_id?: number; // Numeric CDP nodeId
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
    'Unified DOM inspection and action tool. Capture page DOM snapshots with token-optimized serialization, and execute actions (click, type, keypress) on elements using persistent node IDs. Combines DOM capture with page interaction in a single tool.',
    {
      action: {
        type: 'string',
        description: 'Action type: snapshot (capture DOM), click (click element), type (input text), keypress (keyboard input), scroll (scroll element into view)',
        enum: ['snapshot', 'click', 'type', 'keypress', 'scroll'],
      },
      tab_id: {
        type: 'number',
        description: 'Target tab ID (optional, defaults to active tab)',
      },
      node_id: {
        type: 'number',
        description: 'Target element node ID from snapshot (required for click and type actions). This is a numeric identifier corresponding to the node_id field in the serialized DOM. Example: 1469, 1537, etc. Special values: -1 for window-level scroll, -2 for document-level keypress.',
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
        description: 'Action-specific options. For type action: { clearFirst?: boolean, speed?: number, commit?: "change"|"enter", blur?: boolean }. commit controls input finalization: "change" (default, fires change event) or "enter" (appends Enter keystroke). For click: { button?: "left"|"right"|"middle", scrollIntoView?: boolean }. For keypress: { modifiers?: { ctrl?: boolean, shift?: boolean, alt?: boolean, meta?: boolean } }. For snapshot: { includeValues?: boolean, metadata?: { includeAriaLabel?: boolean, includeText?: boolean, includeValue?: boolean, includeInputType?: boolean, includeHint?: boolean, includeBbox?: boolean, includeStates?: boolean, includeHref?: boolean } }.',
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

    // Get target tab
    const targetTab = typedRequest.tab_id
      ? await this.validateTabId(typedRequest.tab_id)
      : await this.getActiveTab();

    const tabId = targetTab.id!;

    // Route by action type - return raw data, BaseTool.execute() will wrap it
    switch (typedRequest.action) {
      case 'snapshot':
        return await this.executeSnapshot(tabId, typedRequest.options);
      case 'click':
        return await this.executeClick(tabId, typedRequest.node_id!, typedRequest.options);
      case 'type':
        return await this.executeType(tabId, typedRequest.node_id!, typedRequest.text!, typedRequest.options);
      case 'keypress':
        return await this.executeKeypress(tabId, typedRequest.key!, typedRequest.options);
      case 'scroll':
        return await this.executeScroll(tabId, typedRequest.node_id!, typedRequest.options);
      default:
        throw new Error(`Unknown action: ${typedRequest.action}`);
    }
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
    return await domService.getSerializedDom();
  }

  /**
   * Execute click action
   */
  private async executeClick(
    tabId: number,
    nodeId: number,
    options?: ClickOptions
  ): Promise<ActionResult> {
    this.log('debug', 'Executing click', { tabId, nodeId, options });

    // Always use CDP-based implementation (content-script implementation removed)
    const domService = await DomService.forTab(tabId);
    return await domService.click(nodeId);
  }

  /**
   * Execute type action
   */
  private async executeType(
    tabId: number,
    nodeId: number,
    text: string,
    options?: TypeOptions
  ): Promise<ActionResult> {
    this.log('debug', 'Executing type', { tabId, nodeId, text, options });

    // Always use CDP-based implementation (content-script implementation removed)
    const domService = await DomService.forTab(tabId);
    return await domService.type(nodeId, text);
  }

  /**
   * Execute keypress action
   */
  private async executeKeypress(
    tabId: number,
    key: string,
    options?: KeyPressOptions
  ): Promise<ActionResult> {
    this.log('debug', 'Executing keypress', { tabId, key, options });

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
    options?: { block?: 'start' | 'center' | 'end' | 'nearest'; inline?: 'start' | 'center' | 'end' | 'nearest' }
  ): Promise<ActionResult> {
    this.log('debug', 'Executing scroll', { tabId, nodeId, options });

    // Always use CDP-based implementation
    const domService = await DomService.forTab(tabId);
    return await domService.scrollIntoView(nodeId, options);
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

    // Validate tab_id if provided
    if (req.tab_id !== undefined && typeof req.tab_id !== 'number') {
      return 'tab_id must be a number';
    }

    // Action-specific validation
    switch (req.action) {
      case 'snapshot':
        return null; // Only action is required

      case 'click':
        if (req.node_id === undefined || typeof req.node_id !== 'number') {
          return 'node_id is required for click action and must be a number';
        }
        if (!Number.isInteger(req.node_id)) {
          return 'node_id must be an integer';
        }
        return null;

      case 'type':
        if (req.node_id === undefined || typeof req.node_id !== 'number') {
          return 'node_id is required for type action and must be a number';
        }
        if (!Number.isInteger(req.node_id)) {
          return 'node_id must be an integer';
        }
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
        if (req.node_id === undefined || typeof req.node_id !== 'number') {
          return 'node_id is required for scroll action and must be a number';
        }
        if (!Number.isInteger(req.node_id)) {
          return 'node_id must be an integer';
        }
        return null;

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
