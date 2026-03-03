/**
 * Server Tools Registration
 *
 * Registers cross-platform tools (planning, web search) and optionally
 * connects the chrome-devtools-mcp browser server for headless browser
 * automation in server mode.
 *
 * Gracefully degrades if Chrome/Chromium is not installed on the host.
 *
 * @module server/tools/registerServerTools
 */

import { execSync } from 'node:child_process';
import type { ToolRegistry } from '@/tools/ToolRegistry';
import type { IRiskAssessor } from '@/core/approval/types';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const BROWSER_SERVER_ID = '00000000-0000-4000-8000-000000000002'; // distinct from desktop's builtin
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

// ─────────────────────────────────────────────────────────────────────────
// Main registration
// ─────────────────────────────────────────────────────────────────────────

/**
 * Register server-mode tools.
 *
 * 1. Registers cross-platform tools (planning, web search)
 * 2. Attempts to connect chrome-devtools-mcp for browser automation
 * 3. Sets up dynamic MCP tool registration for user-configured servers
 */
export async function registerServerTools(
  registry: ToolRegistry
): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────
  // Cross-platform tools
  // ──────────────────────────────────────────────────────────────────────

  try {
    const { PlanningTool } = await import('@/tools/PlanningTool');
    const { StaticRiskAssessor } = await import('@/core/approval/assessors/StaticRiskAssessor');

    const { getTaskStore } = await import('@/core/taskmanager');
    const planningTool = new PlanningTool(getTaskStore());
    const definition = planningTool.getDefinition();

    if (!registry.getTool('planning_tool')) {
      await registry.register(
        definition,
        async (params, context) => {
          return planningTool.execute(params, {
            metadata: {
              ...context.metadata,
              sessionId: context.sessionId,
              turnId: context.turnId,
              toolName: context.toolName,
            },
          });
        },
        new StaticRiskAssessor(0)
      );
      console.log('[registerServerTools] Planning tool registered');
    }
  } catch (err) {
    console.warn('[registerServerTools] Failed to register planning tool:', err);
  }

  try {
    const { WebSearchTool } = await import('@/tools/WebSearchTool');
    const { StaticRiskAssessor } = await import('@/core/approval/assessors/StaticRiskAssessor');

    const webSearchTool = new WebSearchTool();
    const definition = webSearchTool.getDefinition();

    if (!registry.getTool('web_search')) {
      await registry.register(
        definition,
        async (params, context) => {
          return webSearchTool.execute(params, {
            metadata: {
              ...context.metadata,
              sessionId: context.sessionId,
              turnId: context.turnId,
              toolName: context.toolName,
            },
          });
        },
        new StaticRiskAssessor(0)
      );
      console.log('[registerServerTools] Web search tool registered');
    }
  } catch (err) {
    console.warn('[registerServerTools] Failed to register web search tool:', err);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Browser automation via chrome-devtools-mcp
  // ──────────────────────────────────────────────────────────────────────

  await registerBrowserTools(registry);

  // ──────────────────────────────────────────────────────────────────────
  // Dynamic MCP tool registration for user-configured servers
  // ──────────────────────────────────────────────────────────────────────

  await setupDynamicMCPRegistration(registry);
}

/**
 * Register browser automation tools via chrome-devtools-mcp.
 * Gracefully degrades if Chrome is not installed.
 */
async function registerBrowserTools(registry: ToolRegistry): Promise<void> {
  try {
    const { MCPManager } = await import('@/core/mcp/MCPManager');
    const { registerMCPTools } = await import('@/core/mcp/MCPToolAdapter');

    // Use 'server' scope — avoids Tauri-specific builtin seeding in MCPManager
    const mcpManager = await MCPManager.getInstance('server');

    // Check if browser server is already seeded (from desktop builtin)
    let browserServer = mcpManager.getServerByName('browser');

    if (!browserServer) {
      // Build chrome-devtools-mcp args based on deployment mode:
      // - CHROME_REMOTE_URL: connect to external browser (K8s browser pool, sidecar)
      // - CHROME_WS_ENDPOINT: connect via WebSocket to external browser
      // - CHROME_BIN or local detection: launch Chrome as child process
      const remoteUrl = process.env.CHROME_REMOTE_URL;
      const wsEndpoint = process.env.CHROME_WS_ENDPOINT;

      const mcpArgs = ['chrome-devtools-mcp', '--no-usage-statistics'];

      if (remoteUrl) {
        // Remote browser via HTTP (e.g. browserless, Chrome sidecar)
        mcpArgs.push('--browserUrl', remoteUrl);
        console.log(`[registerServerTools] Connecting to remote browser: ${remoteUrl}`);
      } else if (wsEndpoint) {
        // Remote browser via WebSocket
        mcpArgs.push('--wsEndpoint', wsEndpoint);
        const wsHeaders = process.env.CHROME_WS_HEADERS;
        if (wsHeaders) {
          mcpArgs.push('--wsHeaders', wsHeaders);
        }
        console.log(`[registerServerTools] Connecting to browser via WebSocket: ${wsEndpoint}`);
      } else {
        // Local Chrome — check if available
        const chromeBin = process.env.CHROME_BIN ?? findChromeBinary();
        if (!chromeBin) {
          console.warn(
            '[registerServerTools] Chrome/Chromium not found — browser automation disabled. ' +
            'Install Chrome, set CHROME_BIN, or set CHROME_REMOTE_URL for remote browser.'
          );
          return;
        }
        mcpArgs.push(
          '--isolated',
          '--chromeArg=--headless',
          '--chromeArg=--no-sandbox',
          '--chromeArg=--disable-setuid-sandbox',
        );
        console.log(`[registerServerTools] Using local Chrome: ${chromeBin}`);
      }

      try {
        browserServer = await mcpManager.addServer({
          name: 'browser',
          transport: 'stdio',
          command: 'npx',
          args: mcpArgs,
          enabled: true,
          timeout: 180_000,
        });
      } catch (err) {
        console.warn('[registerServerTools] Failed to add browser MCP server:', err);
        return;
      }
    }

    // Connect with retry
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
        if (attempt < MAX_RETRIES) {
          try { await mcpManager.disconnect(browserServer.id); } catch { /* ignore */ }
        }
      }
    }

    if (connected) {
      const connection = mcpManager.getConnection(browserServer.id);
      if (connection && connection.tools.length > 0) {
        let riskAssessor: IRiskAssessor | undefined;
        try {
          const { McpBrowserRiskAssessor } = await import('@/core/approval/assessors/McpBrowserRiskAssessor');
          riskAssessor = new McpBrowserRiskAssessor();
        } catch {
          // Risk assessor optional
        }

        await registerMCPTools(mcpManager, 'browser', connection.tools, registry, riskAssessor);
        console.log(`[registerServerTools] Browser tools registered (${connection.tools.length} tools)`);
      } else {
        console.warn('[registerServerTools] Browser server connected but no tools discovered');
      }
    } else {
      console.warn(
        '[registerServerTools] Browser tools unavailable — could not connect to chrome-devtools-mcp. ' +
        'Agent will proceed with planning and web search only.'
      );
    }
  } catch (err) {
    console.warn('[registerServerTools] Browser tools setup failed (non-fatal):', err);
  }
}

/**
 * Set up dynamic MCP tool registration — subscribe to tools-updated events
 * so user-configured MCP servers auto-register/unregister tools.
 */
async function setupDynamicMCPRegistration(registry: ToolRegistry): Promise<void> {
  try {
    const { MCPManager } = await import('@/core/mcp/MCPManager');
    const { registerMCPTools, unregisterMCPTools } = await import('@/core/mcp/MCPToolAdapter');
    const mcpManager = await MCPManager.getInstance('desktop');

    const registeredToolsByServer = new Map<string, import('@/core/mcp/types').IMCPTool[]>();

    mcpManager.on('event', (event) => {
      if (event.type !== 'tools-updated') return;

      const config = mcpManager.getServer(event.configId);
      if (!config) return;

      // Unregister previously registered tools
      const previousTools = registeredToolsByServer.get(event.configId);
      if (previousTools && previousTools.length > 0) {
        unregisterMCPTools(config.name, previousTools, registry).catch((error) => {
          console.error('[registerServerTools] Failed to unregister MCP tools:', error);
        });
        registeredToolsByServer.delete(event.configId);
      }

      if (event.tools.length > 0) {
        registerMCPTools(mcpManager, config.name, event.tools, registry).catch((error) => {
          console.error('[registerServerTools] Failed to register MCP tools:', error);
        });
        registeredToolsByServer.set(event.configId, event.tools);
      }
    });

    console.log('[registerServerTools] Dynamic MCP registration configured');
  } catch (err) {
    console.warn('[registerServerTools] Dynamic MCP setup failed (non-fatal):', err);
  }
}

/**
 * Try to find Chrome/Chromium binary on the system.
 */
function findChromeBinary(): string | null {

  const candidates = [
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
  ];

  for (const candidate of candidates) {
    try {
      const result = execSync(`which ${candidate}`, { encoding: 'utf-8' }).trim();
      if (result) return result;
    } catch {
      // Not found
    }
  }

  return null;
}
