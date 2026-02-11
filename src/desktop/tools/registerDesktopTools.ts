/**
 * Desktop Tools Registration
 *
 * Registers chrome-devtools-mcp tools in the ToolRegistry with known schemas.
 * The actual MCP connection is deferred — handlers lazy-connect on first call
 * via ChromeDevToolsMCPClient.ensureConnected().
 *
 * Also registers cross-platform tools (planning, web search).
 *
 * @module desktop/tools/registerDesktopTools
 */

import { ToolRegistry } from '../../tools/ToolRegistry';
import type { IToolsConfig } from '../../config/types';
import type { ToolDefinition, Platform } from '../../tools/BaseTool';
import { PlanningTool } from '../../tools/PlanningTool';
import { WebSearchTool } from '../../tools/WebSearchTool';
import { ChromeDevToolsMCPClient } from './browser/ChromeDevToolsMCPClient';

/**
 * Check if a tool supports the given platform based on its metadata
 */
function isPlatformSupported(toolDef: ToolDefinition, platform: Platform): boolean {
  if (toolDef.type !== 'function') {
    return true;
  }

  const platforms = toolDef.metadata?.platforms;

  if (!platforms || platforms.length === 0) {
    return true;
  }

  return platforms.includes(platform);
}

/**
 * Known chrome-devtools-mcp tool definitions.
 * These are registered at startup so the LLM always sees them.
 * The actual MCP connection happens lazily on first tool call.
 */
const CHROME_DEVTOOLS_MCP_TOOLS: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> = [
  {
    name: 'navigate_page',
    description: 'Navigate to a URL, go back/forward in history, or reload the page.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: 'Navigation type' },
        url: { type: 'string', description: 'URL to navigate to (required when type is "url")' },
        timeout: { type: 'integer', description: 'Navigation timeout in ms. 0 uses the default.' },
        handleBeforeUnload: { type: 'string', enum: ['accept', 'decline'], description: 'How to handle beforeunload dialogs' },
        ignoreCache: { type: 'boolean', description: 'Bypass cache on reload' },
      },
    },
  },
  {
    name: 'take_snapshot',
    description: 'Take a snapshot of the current page. Returns the accessibility tree of the page, which is a semantically meaningful representation of the page content, optimized for LLM consumption. Elements have unique IDs (uid) that can be used with other tools like click and fill.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Save location instead of inline attachment' },
        verbose: { type: 'boolean', description: 'Include all accessibility tree data. Default: false.' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click on an element identified by its uid from a page snapshot.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The uid of the element from the page snapshot' },
        dblClick: { type: 'boolean', description: 'Double-click. Default: false.' },
        includeSnapshot: { type: 'boolean', description: 'Return page snapshot in response. Default: false.' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'fill',
    description: 'Fill out an input element identified by its uid from a page snapshot.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The uid of the element from the page snapshot' },
        value: { type: 'string', description: 'Text to fill in' },
        includeSnapshot: { type: 'boolean', description: 'Return page snapshot in response. Default: false.' },
      },
      required: ['uid', 'value'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element identified by its uid from a page snapshot.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The uid of the element from the page snapshot' },
        includeSnapshot: { type: 'boolean', description: 'Return page snapshot in response. Default: false.' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a key or key combination (e.g. "Enter", "Control+A", "Tab").',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or key combination to press' },
        includeSnapshot: { type: 'boolean', description: 'Return page snapshot in response. Default: false.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'drag',
    description: 'Drag an element to another element, both identified by uids from a page snapshot.',
    parameters: {
      type: 'object',
      properties: {
        startUid: { type: 'string', description: 'The uid of the element to drag from' },
        endUid: { type: 'string', description: 'The uid of the element to drag to' },
        includeSnapshot: { type: 'boolean', description: 'Return page snapshot in response. Default: false.' },
      },
      required: ['startUid', 'endUid'],
    },
  },
  {
    name: 'fill_form',
    description: 'Fill out multiple form elements at once.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              uid: { type: 'string', description: 'The uid of the form element' },
              value: { type: 'string', description: 'Value to fill in' },
            },
            required: ['uid', 'value'],
          },
          description: 'Form fields to fill',
        },
        includeSnapshot: { type: 'boolean', description: 'Return page snapshot in response. Default: false.' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'handle_dialog',
    description: 'Handle a dialog (alert, confirm, prompt, beforeunload).',
    parameters: {
      type: 'object',
      properties: {
        accept: { type: 'boolean', description: 'Whether to accept (true) or dismiss (false) the dialog' },
        promptText: { type: 'string', description: 'Text to enter in a prompt dialog' },
      },
      required: ['accept'],
    },
  },
  {
    name: 'upload_file',
    description: 'Upload a file to a file input element.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The uid of the file input element' },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to upload',
        },
      },
      required: ['uid', 'filePaths'],
    },
  },
  {
    name: 'new_page',
    description: 'Open a new page (tab) and navigate to a URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        background: { type: 'boolean', description: 'Open without focus. Default: false.' },
        timeout: { type: 'integer', description: 'Navigation timeout in ms. 0 uses the default.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_pages',
    description: 'List all open pages (tabs) in the browser.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'select_page',
    description: 'Switch to a different page (tab) by its index.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Page index from list_pages' },
      },
      required: ['index'],
    },
  },
  {
    name: 'close_page',
    description: 'Close a page (tab) by its index.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Page index from list_pages' },
      },
      required: ['index'],
    },
  },
  {
    name: 'evaluate_script',
    description: 'Execute JavaScript in the page context and return the result.',
    parameters: {
      type: 'object',
      properties: {
        function: { type: 'string', description: 'JavaScript function declaration to execute' },
        args: { type: 'array', description: 'Arguments to pass to the function' },
      },
      required: ['function'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the current page.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Save location instead of inline' },
      },
    },
  },
  {
    name: 'wait_for',
    description: 'Wait for specific text to appear on the page.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for on the page' },
        timeout: { type: 'integer', description: 'Max wait time in ms. 0 uses the default.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_console_messages',
    description: 'List console messages (log, warn, error) from the page.',
    parameters: { type: 'object', properties: {} },
  },
];

/**
 * Register desktop-specific tools.
 *
 * Registers chrome-devtools-mcp tools with known schemas. The MCP connection
 * is deferred — happens lazily on first tool call.
 *
 * @param registry - Tool registry instance
 * @param toolsConfig - Tool configuration settings
 * @param modelConfig - Optional model configuration
 */
export async function registerDesktopToolsImpl(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  const platform: Platform = 'desktop';
  const enableBrowserTools =
    toolsConfig.enable_all_tools === true ||
    toolsConfig.dom_tool === true ||
    toolsConfig.navigation_tool === true;

  // Helper to register a BaseTool instance
  const registerTool = async (toolName: string, toolInstance: any) => {
    if (registry.getTool(toolName)) {
      console.log(`[registerDesktopTools] ${toolName} already registered, skipping...`);
      return;
    }

    const definition = toolInstance.getDefinition();

    if (!isPlatformSupported(definition, platform)) {
      console.log(`[registerDesktopTools] ${toolName} not supported on ${platform}, skipping...`);
      return;
    }

    console.log(`[registerDesktopTools] Registering ${toolName} (desktop)...`);

    await registry.register(definition, async (params, context) => {
      return toolInstance.execute(params, {
        metadata: {
          ...context.metadata,
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolName: context.toolName,
        },
      });
    });
  };

  // ──────────────────────────────────────────────────────────────────────
  // Register chrome-devtools-mcp tools (browser automation)
  // ──────────────────────────────────────────────────────────────────────
  if (enableBrowserTools) {
    console.log('[registerDesktopTools] Browser tools enabled (enable_all_tools=%s, dom_tool=%s, navigation_tool=%s)',
      toolsConfig.enable_all_tools, toolsConfig.dom_tool, toolsConfig.navigation_tool);

    const mcpClient = ChromeDevToolsMCPClient.getInstance();
    let registeredCount = 0;

    for (const tool of CHROME_DEVTOOLS_MCP_TOOLS) {
      if (registry.getTool(tool.name)) {
        console.log(`[registerDesktopTools] ${tool.name} already registered, skipping`);
        continue;
      }

      const definition: ToolDefinition = {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          strict: false,
          parameters: tool.parameters as any,
        },
      };

      // Handler lazy-connects via mcpClient.callTool → ensureConnected()
      const toolName = tool.name;
      const handler = async (args: Record<string, unknown>) => {
        console.log(`[registerDesktopTools:handler] ▶ ${toolName} called with args:`, JSON.stringify(args));

        try {
          const result = await mcpClient.callTool(toolName, args);

          if (result.isError) {
            const errorText = ChromeDevToolsMCPClient.getTextContent(result);
            console.error(`[registerDesktopTools:handler] ✗ ${toolName} returned error:`, errorText);
            throw new Error(errorText || `Tool ${toolName} failed`);
          }

          // Extract all content (text + image) from the MCP result
          const output = ChromeDevToolsMCPClient.formatContent(result);
          console.log(`[registerDesktopTools:handler] ✓ ${toolName} succeeded (output length: ${output.length})`);
          return output;
        } catch (error) {
          console.error(`[registerDesktopTools:handler] ✗ ${toolName} threw:`, error);
          throw error;
        }
      };

      await registry.register(definition, handler);
      registeredCount++;
    }

    console.log(`[registerDesktopTools] Registered ${registeredCount}/${CHROME_DEVTOOLS_MCP_TOOLS.length} chrome-devtools-mcp tools (lazy connection)`);
  } else {
    console.log('[registerDesktopTools] Browser tools DISABLED (enable_all_tools=%s, dom_tool=%s, navigation_tool=%s)',
      toolsConfig.enable_all_tools, toolsConfig.dom_tool, toolsConfig.navigation_tool);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Register cross-platform tools
  // ──────────────────────────────────────────────────────────────────────

  // Planning tool - always enabled
  const planningTool = new PlanningTool();
  await registerTool('planning_tool', planningTool);

  // Web search tool
  const webSearchTool = new WebSearchTool();
  await registerTool('web_search', webSearchTool);
}
