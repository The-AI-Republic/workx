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

import { ToolRegistry, type ToolRegistrationOptions } from '../../tools/ToolRegistry';
import type { IToolsConfig } from '../../config/types';
import type { ToolDefinition, Platform } from '../../tools/BaseTool';
import { PlanningTool } from '../../tools/PlanningTool';
import { getTaskStore } from '../../core/taskmanager';
import { WebSearchTool, WEB_SEARCH_CONCURRENCY } from '../../tools/WebSearchTool';
import { SettingTool } from '../../tools/SettingTool';
import { registerResourceFetchTool } from '../../tools/ResourceFetchTool';
import { MCPManager } from '../../core/mcp/MCPManager';
import { registerMCPTools } from '../../core/mcp/MCPToolAdapter';
import { TerminalTool } from './terminal/TerminalTool';
import { registerFileSearchTools } from '../../tools/file-search/register';
import { invoke } from '@tauri-apps/api/core';
import { TerminalRiskAssessor } from '../../core/approval/assessors/TerminalRiskAssessor';
import { McpBrowserRiskAssessor } from '../../core/approval/assessors/McpBrowserRiskAssessor';
import { StaticRiskAssessor } from '../../core/approval/assessors/StaticRiskAssessor';
import { SettingToolRiskAssessor } from '../../core/approval/assessors/SettingToolRiskAssessor';
import type { IRiskAssessor } from '../../core/approval/types';

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

  // Risk assessors for desktop tools
  const mcpBrowserAssessor = new McpBrowserRiskAssessor();
  const terminalAssessor = new TerminalRiskAssessor();
  const staticAssessor = new StaticRiskAssessor();

  // Helper to register a BaseTool instance
  const registerTool = async (toolName: string, toolInstance: any, riskAssessor?: IRiskAssessor | ToolRegistrationOptions) => {
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
    }, riskAssessor);
  };

  // ── resource_fetch (Track 23 — the only x402-payable surface) ─────────
  // Desktop is the signer home; the wired capability requires explicit
  // human approval (ApprovalGate) above the trivial threshold.
  await registerResourceFetchTool(registry);

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
            await registerMCPTools(mcpManager, 'browser', connection.tools, registry, mcpBrowserAssessor);
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

  // Planning tool - always enabled (zero risk)
  try {
    const planningTool = new PlanningTool(getTaskStore());
    await registerTool('planning_tool', planningTool, new StaticRiskAssessor(0));
  } catch (error) {
    console.error('[registerDesktopTools] Failed to register PlanningTool (StorageProvider unavailable):', error);
  }

  // Web search tool (zero risk; read-only — Track 14 shared profile)
  const webSearchTool = new WebSearchTool();
  await registerTool('web_search', webSearchTool, {
    riskAssessor: new StaticRiskAssessor(0),
    runtime: { concurrency: WEB_SEARCH_CONCURRENCY },
  });

  // Setting tool - always enabled for reading/writing allowlisted settings via chat
  const settingTool = new SettingTool();
  await registerTool('setting_tool', settingTool, new SettingToolRiskAssessor());

  // ──────────────────────────────────────────────────────────────────────
  // Register terminal tool (desktop only)
  // ──────────────────────────────────────────────────────────────────────
  const terminalTool = new TerminalTool();
  let osName: string | undefined;
  try {
    const platformInfo = await invoke<{ os: string; arch: string; version: string }>('get_platform_info');
    osName = platformInfo.os;
  } catch (error) {
    console.warn('[registerDesktopTools] Failed to get platform info:', error);
  }

  // Initialize sandbox support and fetch status for dynamic tool description
  let sandboxStatus;
  try {
    await terminalTool.initializeSandbox();
    sandboxStatus = terminalTool.getSandboxManager().status ?? undefined;
    console.log('[registerDesktopTools] Sandbox initialized:', sandboxStatus?.status, sandboxStatus?.runtime);
  } catch (error) {
    console.warn('[registerDesktopTools] Failed to initialize sandbox:', error);
  }

  const terminalDef = terminalTool.getToolDefinition(osName, sandboxStatus);

  if (!registry.getTool('terminal')) {
    console.log('[registerDesktopTools] Registering terminal (desktop)...');

    await registry.register(
      {
        type: 'function',
        function: {
          name: terminalDef.name,
          description: terminalDef.description,
          strict: false,
          parameters: terminalDef.inputSchema as any,
        },
        metadata: {
          platforms: ['desktop'],
        },
      },
      async (params) => {
        return await terminalTool.handleInvocation(params as {
          command: string;
          cwd?: string;
          timeout?: number;
          userConfirmed?: boolean;
          sandboxed?: boolean;
        });
      },
      terminalAssessor
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Register ripgrep-backed read-only search tools (grep, glob) — desktop
  // ──────────────────────────────────────────────────────────────────────
  await registerFileSearchTools(registry, ['desktop']);
}
