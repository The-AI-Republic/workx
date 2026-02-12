/**
 * Desktop Tools Registration
 *
 * Registers browser automation tools via MCPManager's builtin 'browser' server,
 * plus cross-platform tools (planning, web search).
 *
 * The builtin browser server (chrome-devtools-mcp) is connected via MCPManager,
 * and its tools are registered dynamically with prefixed names (e.g., browser__click).
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
      return;
    }

    const definition = toolInstance.getDefinition();

    if (!isPlatformSupported(definition, platform)) {
      return;
    }

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
    try {
      const mcpManager = await MCPManager.getInstance('desktop');

      // Find the builtin browser server
      const browserServer = mcpManager.getServerByName('browser');

      if (browserServer) {
        // Connect with retry — chrome-devtools-mcp may take time to start
        const MAX_RETRIES = 2;
        const RETRY_DELAY_MS = 2000;
        let lastError: unknown;
        let connected = false;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            if (attempt > 0) {
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
            await mcpManager.connect(browserServer.id);
            connected = true;
            break;
          } catch (connectError) {
            lastError = connectError;

            // Disconnect before retrying so MCPManager doesn't think we're still connecting
            if (attempt < MAX_RETRIES) {
              try { await mcpManager.disconnect(browserServer.id); } catch { /* ignore */ }
            }
          }
        }

        if (connected) {
          // Get the connection to access discovered tools
          const connection = mcpManager.getConnection(browserServer.id);

          if (connection && connection.tools.length > 0) {
            // Register all discovered tools with prefixed names (browser__click, etc.)
            await registerMCPTools(mcpManager, 'browser', connection.tools, registry);
          } else {
            console.warn('[registerDesktopTools] Browser server connected but no tools discovered');
          }
        } else {
          console.warn('[registerDesktopTools] Browser tools will be unavailable — agent will proceed with planning and web search only');
        }
      } else {
        console.warn('[registerDesktopTools] Builtin browser server not found in MCPManager');
      }
    } catch (error) {
      console.error('[registerDesktopTools] Failed to initialize MCPManager:', error);
    }
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
