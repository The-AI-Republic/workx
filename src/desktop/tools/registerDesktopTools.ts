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
import { registerMCPTools, unregisterMCPTools } from '../../core/mcp/MCPToolAdapter';
import { TerminalTool } from './terminal/TerminalTool';
import { registerFileSearchTools } from '../../tools/file-search/register';
import { TerminalRiskAssessor } from '../../core/approval/assessors/TerminalRiskAssessor';
import { McpBrowserRiskAssessor } from '../../core/approval/assessors/McpBrowserRiskAssessor';
import { StaticRiskAssessor } from '../../core/approval/assessors/StaticRiskAssessor';
import { SettingToolRiskAssessor } from '../../core/approval/assessors/SettingToolRiskAssessor';
import type { IRiskAssessor } from '../../core/approval/types';
import {
  AppActivationService,
  AppInstallService,
  AppLocalStore,
  AppMarketplaceClient,
  AppMetadataIndex,
  registerAppAgentTools,
  type AppAgentToolDeps,
  type AppConnectionStatus,
} from '../../core/apps';
import { getCredentialStore } from '../../core/storage';
import { resolveRuntimeUrls } from '../../config/runtimeUrls';

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

function createDesktopAppAgentToolDeps(): AppAgentToolDeps {
  const marketplaceBaseUrl = resolveRuntimeUrls().homePageBaseUrl ?? 'https://airepublic.com';
  const store = new AppLocalStore();
  const marketplace = new AppMarketplaceClient({
    baseUrl: marketplaceBaseUrl,
    getAccessToken: () => getCredentialStore().get('auth', 'access_token'),
  });
  const installer = new AppInstallService(marketplace, store);
  const index = new AppMetadataIndex(store);
  const activation = new AppActivationService(
    store,
    undefined,
    undefined,
    (appId: string, status: AppConnectionStatus, lastError?: string) =>
      installer.reportStatus(appId, status, lastError),
  );

  return { store, index, activation };
}

async function registerActiveRuntimeAppMCPTools(
  registry: ToolRegistry,
  riskAssessor?: IRiskAssessor,
): Promise<void> {
  const mcpManager = await MCPManager.getInstance('desktop');
  for (const connection of mcpManager.getConnections()) {
    if (connection.status !== 'connected' || connection.tools.length === 0) continue;
    const config = mcpManager.getServer(connection.configId);
    if (!config?.runtime) continue;
    await registerMCPTools(mcpManager, config.name, connection.tools, registry, riskAssessor);
  }
}

/**
 * Wire the runtime-app MCP `tools-updated` observer for this session's registry.
 *
 * The MCPManager is a process singleton while each agent session owns its own
 * ToolRegistry, so this attaches one listener per session. It returns an
 * unsubscribe that the platform adapter MUST call on dispose() — otherwise
 * listeners (and the dead registries they close over) accumulate on the
 * long-lived singleton across sessions.
 */
async function setupRuntimeAppMCPRegistration(
  registry: ToolRegistry,
  riskAssessor?: IRiskAssessor,
): Promise<() => void> {
  const mcpManager = await MCPManager.getInstance('desktop');
  const registeredToolsByServer = new Map<string, import('../../core/mcp/types').IMCPTool[]>();

  for (const connection of mcpManager.getConnections()) {
    if (connection.status !== 'connected' || connection.tools.length === 0) continue;
    const config = mcpManager.getServer(connection.configId);
    if (config?.runtime) {
      registeredToolsByServer.set(connection.configId, connection.tools);
    }
  }

  const handler = (event: import('../../core/mcp/types').MCPManagerEvent): void => {
    if (event.type !== 'tools-updated') return;

    const config = mcpManager.getServer(event.configId);
    if (!config?.runtime) return;

    const previousTools = registeredToolsByServer.get(event.configId);
    if (previousTools && previousTools.length > 0) {
      unregisterMCPTools(config.name, previousTools, registry).catch((error) => {
        console.error('[registerDesktopTools] Failed to unregister app MCP tools:', error);
      });
      registeredToolsByServer.delete(event.configId);
    }

    if (event.tools.length > 0) {
      registerMCPTools(mcpManager, config.name, event.tools, registry, riskAssessor).catch((error) => {
        console.error('[registerDesktopTools] Failed to register app MCP tools:', error);
      });
      registeredToolsByServer.set(event.configId, event.tools);
    }
  };

  mcpManager.on('event', handler);
  return () => mcpManager.off('event', handler);
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
): Promise<(() => void) | undefined> {
  let disposeRuntimeAppMCPRegistration: (() => void) | undefined;
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
        callId: context.callId,
        onProgress: context.onProgress,
        signal: context.signal,
      });
    }, riskAssessor);
  };

  // ── resource_fetch (Track 23 — the only x402-payable surface) ─────────
  // Desktop is the signer home; the wired capability requires explicit
  // human approval (ApprovalGate) above the trivial threshold.
  await registerResourceFetchTool(registry);

  try {
    await registerAppAgentTools(registry, createDesktopAppAgentToolDeps());
    await registerActiveRuntimeAppMCPTools(registry, staticAssessor);
    disposeRuntimeAppMCPRegistration = await setupRuntimeAppMCPRegistration(registry, staticAssessor);
  } catch (error) {
    console.error('[registerDesktopTools] Failed to register app connector tools:', error);
  }

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
  const osName = process.platform;

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

  return disposeRuntimeAppMCPRegistration;
}
