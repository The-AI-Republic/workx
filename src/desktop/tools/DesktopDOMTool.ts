/**
 * Desktop DOM Tool
 *
 * Desktop-mode implementation of browser_dom that delegates to the shared DomService.
 * This replaces CDPDOMTool.ts by using the same DomService that powers the extension,
 * giving desktop mode all extension features for free: SPA wait, a11y enrichment,
 * caching, frame-scoped node IDs, shadow DOM, and iframes.
 *
 * @module desktop/tools/DesktopDOMTool
 */

import {
  BaseTool,
  createToolDefinition,
  type BaseToolRequest,
  type BaseToolOptions,
  type ToolDefinition,
} from '@/tools/BaseTool';
import type { SerializedDom, ActionResult } from '@/types/domTool';
import { DomService } from '@/tools/dom/DomService';
import { DesktopTabManager } from './browser/DesktopTabManager';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Desktop DOM tool request (same interface as extension DOMTool)
 */
export interface DesktopDOMToolRequest {
  action: 'snapshot' | 'click' | 'type' | 'keypress' | 'scroll';
  node_id?: string | number;
  text?: string;
  key?: string;
  options?: any;
}

// ============================================================================
// Desktop DOM Tool
// ============================================================================

/**
 * DesktopDOMTool - thin wrapper that delegates to the shared DomService.
 *
 * All DOM operations are handled by DomService which is platform-agnostic.
 * This tool just bridges the tool interface to DomService.
 */
export class DesktopDOMTool extends BaseTool {
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
        description: 'Target element node ID (for click, type, scroll actions). Format: "frameId:backendNodeId"',
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
          'iframe_support',
          'shadow_dom_support',
          'spa_wait',
        ],
        platforms: ['desktop'],
      },
    }
  );

  /**
   * Get or create a DomService for the given tab
   */
  private async getDomService(tabId: number): Promise<DomService> {
    const tabManager = DesktopTabManager.getInstance();
    const client = await tabManager.getClient(tabId);
    return DomService.forClient(client, `desktop:${tabId}`);
  }

  /**
   * Execute DOM tool action - delegates to shared DomService
   */
  protected async executeImpl(
    request: BaseToolRequest,
    options?: BaseToolOptions
  ): Promise<SerializedDom | ActionResult> {
    const typedRequest = request as DesktopDOMToolRequest;

    const tabId = options?.metadata?.tabId;

    if (tabId === undefined || tabId === null || tabId === -1) {
      throw new Error('Target tab ID not provided in execution context');
    }

    const domService = await this.getDomService(tabId);

    switch (typedRequest.action) {
      case 'snapshot':
        return domService.getSerializedDom();

      case 'click':
        if (typedRequest.node_id === undefined) {
          throw new Error('node_id is required for click action');
        }
        return domService.click(typedRequest.node_id);

      case 'type':
        if (typedRequest.node_id === undefined) {
          throw new Error('node_id is required for type action');
        }
        if (typedRequest.text === undefined) {
          throw new Error('text is required for type action');
        }
        return domService.type(typedRequest.node_id, typedRequest.text, typedRequest.options);

      case 'keypress':
        if (!typedRequest.key) {
          throw new Error('key is required for keypress action');
        }
        return domService.keypress(typedRequest.key, typedRequest.options?.modifiers);

      case 'scroll':
        if (typedRequest.node_id === undefined) {
          throw new Error('node_id is required for scroll action');
        }
        return domService.scroll(
          typedRequest.node_id,
          typedRequest.options?.scrollX || 0,
          typedRequest.options?.scrollY
        );

      default:
        throw new Error(`Unknown action: ${(typedRequest as any).action}`);
    }
  }
}
