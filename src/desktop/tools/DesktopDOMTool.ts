/**
 * Desktop DOM Tool
 *
 * Desktop-mode implementation of browser_dom that delegates to chrome-devtools-mcp
 * via the ChromeDevToolsMCPClient singleton. Uses MCP tool calls instead of
 * direct CDP/DomService for all DOM operations.
 *
 * chrome-devtools-mcp's take_snapshot returns an LLM-optimized accessibility tree
 * with [uid] identifiers that map directly to the action tools (click, fill, press_key).
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
import { ChromeDevToolsMCPClient } from './browser/ChromeDevToolsMCPClient';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Desktop DOM tool request
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
 * DesktopDOMTool - delegates to chrome-devtools-mcp via MCP tool calls.
 *
 * All DOM operations are handled by chrome-devtools-mcp which manages
 * its own Chrome instance and page state internally.
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
1. **snapshot**: Capture current page accessibility tree for AI analysis (returns elements with uid identifiers)
2. **click**: Click on an element by node_id (uid from snapshot)
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
        description: 'Target element uid from snapshot',
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
          'iframe_support',
          'shadow_dom_support',
        ],
        platforms: ['desktop'],
      },
    }
  );

  /**
   * Execute DOM tool action via chrome-devtools-mcp
   */
  protected async executeImpl(
    request: BaseToolRequest,
    _options?: BaseToolOptions
  ): Promise<any> {
    const typedRequest = request as DesktopDOMToolRequest;
    const mcpClient = ChromeDevToolsMCPClient.getInstance();

    switch (typedRequest.action) {
      case 'snapshot': {
        const result = await mcpClient.callTool('take_snapshot');
        return {
          dom: ChromeDevToolsMCPClient.getTextContent(result),
          metadata: { source: 'chrome-devtools-mcp' },
        };
      }

      case 'click': {
        if (typedRequest.node_id === undefined) {
          throw new Error('node_id is required for click action');
        }
        const result = await mcpClient.callTool('click', { uid: String(typedRequest.node_id) });
        if (result.isError) {
          throw new Error(`Click failed: ${ChromeDevToolsMCPClient.getTextContent(result)}`);
        }
        return { success: true, action: 'click', node_id: typedRequest.node_id };
      }

      case 'type': {
        if (typedRequest.node_id === undefined) {
          throw new Error('node_id is required for type action');
        }
        if (typedRequest.text === undefined) {
          throw new Error('text is required for type action');
        }
        const result = await mcpClient.callTool('fill', {
          uid: String(typedRequest.node_id),
          value: typedRequest.text,
        });
        if (result.isError) {
          throw new Error(`Type failed: ${ChromeDevToolsMCPClient.getTextContent(result)}`);
        }
        return { success: true, action: 'type', node_id: typedRequest.node_id };
      }

      case 'keypress': {
        if (!typedRequest.key) {
          throw new Error('key is required for keypress action');
        }
        const result = await mcpClient.callTool('press_key', { key: typedRequest.key });
        if (result.isError) {
          throw new Error(`Keypress failed: ${ChromeDevToolsMCPClient.getTextContent(result)}`);
        }
        return { success: true, action: 'keypress', key: typedRequest.key };
      }

      case 'scroll': {
        if (typedRequest.node_id === undefined) {
          throw new Error('node_id is required for scroll action');
        }
        const uid = String(typedRequest.node_id);
        const scrollX = typedRequest.options?.scrollX || 0;
        const scrollY = typedRequest.options?.scrollY || 0;
        // Use evaluate_script to scroll — chrome-devtools-mcp doesn't have a dedicated scroll tool
        const result = await mcpClient.callTool('evaluate_script', {
          function: `(uid, x, y) => {
            const el = document.querySelector('[data-uid="' + uid + '"]');
            if (el) { el.scrollBy(x, y); } else { window.scrollBy(x, y); }
          }`,
          args: [uid, scrollX, scrollY],
        });
        if (result.isError) {
          throw new Error(`Scroll failed: ${ChromeDevToolsMCPClient.getTextContent(result)}`);
        }
        return { success: true, action: 'scroll', node_id: typedRequest.node_id };
      }

      default:
        throw new Error(`Unknown action: ${(typedRequest as any).action}`);
    }
  }
}
