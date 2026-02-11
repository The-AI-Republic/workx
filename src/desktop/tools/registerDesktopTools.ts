/**
 * Desktop Tools Registration
 *
 * Registers browser automation tools via MCPManager's builtin 'browser' server,
 * plus cross-platform tools (planning, web search).
 *
 * The builtin browser server (chrome-devtools-mcp) is connected via MCPManager,
 * and its tools are registered dynamically with prefixed names (e.g., browser:click).
 *
 * @module desktop/tools/registerDesktopTools
 */

import { ToolRegistry } from '../../tools/ToolRegistry';
import type { IToolsConfig } from '../../config/types';
import type { ToolDefinition, Platform } from '../../tools/BaseTool';
import { PlanningTool } from '../../tools/PlanningTool';
import { WebSearchTool } from '../../tools/WebSearchTool';
import { MCPManager } from '../../core/mcp/MCPManager';
import { registerMCPTools } from '../../core/mcp/MCPToolAdapter';

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
 * Register desktop-specific tools.
 *
 * Connects the builtin browser MCP server and registers its tools dynamically.
 * Also registers cross-platform tools (planning, web search).
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
  // Register browser tools via MCPManager builtin server
  // ──────────────────────────────────────────────────────────────────────
  if (enableBrowserTools) {
    console.log('[registerDesktopTools] Browser tools enabled (enable_all_tools=%s, dom_tool=%s, navigation_tool=%s)',
      toolsConfig.enable_all_tools, toolsConfig.dom_tool, toolsConfig.navigation_tool);

    try {
      const mcpManager = await MCPManager.getInstance('desktop');

      // Find the builtin browser server
      const browserServer = mcpManager.getServerByName('browser');

      if (browserServer) {
        // Connect the browser server (lazy — will spawn chrome-devtools-mcp)
        try {
          await mcpManager.connect(browserServer.id);
          console.log('[registerDesktopTools] Browser MCP server connected');

          // Get the connection to access discovered tools
          const connection = mcpManager.getConnection(browserServer.id);

          if (connection && connection.tools.length > 0) {
            // Register all discovered tools with prefixed names (browser:click, etc.)
            await registerMCPTools(mcpManager, 'browser', connection.tools, registry);
            console.log(`[registerDesktopTools] Registered ${connection.tools.length} browser tools via MCP`);
          } else {
            console.warn('[registerDesktopTools] Browser server connected but no tools discovered');
          }
        } catch (connectError) {
          console.error('[registerDesktopTools] Failed to connect browser MCP server:', connectError);
          // Don't fail — tools will be unavailable but agent can still work
          console.log('[registerDesktopTools] Browser tools will be unavailable');
        }
      } else {
        console.warn('[registerDesktopTools] Builtin browser server not found in MCPManager');
      }
    } catch (error) {
      console.error('[registerDesktopTools] Failed to initialize MCPManager:', error);
    }
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
