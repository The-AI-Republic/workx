/**
 * MCP Manager Singleton
 *
 * Central manager for all MCP server connections.
 * Supports SSE (extension + desktop UI through runtime) and stdio (runtime sidecar).
 * Routes to MCPClient (SSE) or NodeMCPBridge (stdio) based on server config.
 */

import type {
  IMCPServerConfig,
  IMCPServerConfigCreate,
  IMCPServerConfigUpdate,
  IMCPClientAdapter,
  IMCPConnection,
  IMCPTool,
  IMCPResource,
  IMCPToolResult,
  IMCPResourceContent,
  MCPConnectionStatus,
  MCPManagerEvent,
  MCPPlatformScope,
  IMCPManager,
  RuntimeAuthContext,
} from './types';
import { MCPClient } from './MCPClient';
import {
  loadServers,
  saveServers,
  createServerConfig,
  updateServerConfig,
} from './MCPConfig';
import { decryptApiKey } from '../../utils/encryption';

/**
 * Maximum number of MCP servers allowed (excluding builtins).
 *
 * Track 10 (Q8 decision) raised this from 5 → 100. The original cap was
 * conservative; 100 is plenty for any reasonable user-plus-plugin
 * combination. No per-source exemption needed — plugin-installed servers
 * count toward the same ceiling.
 */
const MAX_SERVERS = 100;

/** Builtin browser server ID — deterministic UUID for desktop.
 *  Must be a valid UUID to pass MCPServerConfigSchema validation. */
const BUILTIN_BROWSER_SERVER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * MCPManager manages multiple MCP server connections.
 *
 * This is a singleton class that:
 * - Loads/saves server configurations from storage
 * - Manages IMCPClientAdapter instances (MCPClient or NodeMCPBridge)
 * - Filters servers by platform (shared + current platform)
 * - Seeds builtin servers (e.g., browser server on desktop)
 * - Aggregates tools and resources from all connected servers
 * - Emits events for status changes and updates
 *
 * Usage:
 * ```typescript
 * const manager = await MCPManager.getInstance('desktop');
 * await manager.connect(browserServerId);
 * const tools = manager.getAllTools();
 * ```
 */
export class MCPManager implements IMCPManager {
  private static instance: MCPManager | null = null;

  private servers: Map<string, IMCPServerConfig> = new Map();
  private clients: Map<string, IMCPClientAdapter> = new Map();
  private connections: Map<string, IMCPConnection> = new Map();
  private eventHandlers: Set<(event: MCPManagerEvent) => void> = new Set();
  private initialized: boolean = false;
  private platform: MCPPlatformScope;

  private constructor(platform?: MCPPlatformScope) {
    // Detect platform from build mode if not specified
    this.platform = platform ?? (
      typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop'
        ? 'desktop'
        : 'extension'
    );
  }

  /**
   * Get the singleton instance of MCPManager.
   * @param platform - Optional platform override (detected from __BUILD_MODE__ if not provided)
   */
  public static async getInstance(platform?: MCPPlatformScope): Promise<MCPManager> {
    if (!MCPManager.instance) {
      const instance = new MCPManager(platform);
      await instance.initialize();
      MCPManager.instance = instance;
    }
    return MCPManager.instance;
  }

  /**
   * Initialize the manager by loading configs from storage and seeding builtins.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const configs = await loadServers();
      for (const config of configs) {
        this.servers.set(config.id, config);
        // Initialize connection state (disconnected)
        this.connections.set(config.id, {
          configId: config.id,
          status: 'disconnected',
          tools: [],
          resources: [],
        });
      }

      // Seed builtin servers for the current platform
      await this.seedBuiltinServers();

      this.initialized = true;
    } catch (error) {
      console.error('[MCPManager] Failed to initialize:', error);
      this.initialized = true; // Mark as initialized to prevent infinite retries
    }
  }

  // ==========================================================================
  // Server Configuration Management
  // ==========================================================================

  /**
   * Add a new MCP server configuration.
   */
  async addServer(input: IMCPServerConfigCreate): Promise<IMCPServerConfig> {
    this.ensureInitialized();

    // Validate: stdio transport only allowed on desktop
    if (input.transport === 'stdio' && this.platform === 'extension') {
      throw new Error('stdio transport is only available in desktop mode');
    }

    // Check server limit (exclude builtins from count)
    const userServers = Array.from(this.servers.values()).filter(s => !s.builtin && !s.runtime);
    if (userServers.length >= MAX_SERVERS) {
      throw new Error(`Maximum of ${MAX_SERVERS} user MCP servers allowed`);
    }

    const existingServers = Array.from(this.servers.values());
    const config = createServerConfig(input, existingServers);

    this.servers.set(config.id, config);

    // Initialize connection state
    this.connections.set(config.id, {
      configId: config.id,
      status: 'disconnected',
      tools: [],
      resources: [],
    });

    // Only persist non-builtin servers
    if (!config.builtin && !config.runtime) {
      await this.persistServers();
    }

    // Emit event
    this.emit({ type: 'config-added', config });

    return config;
  }

  /**
   * Update an existing MCP server configuration.
   */
  async updateServer(id: string, update: IMCPServerConfigUpdate): Promise<IMCPServerConfig> {
    this.ensureInitialized();

    const existing = this.servers.get(id);
    if (!existing) {
      throw new Error(`Server not found: ${id}`);
    }

    const allServers = Array.from(this.servers.values());
    const updated = updateServerConfig(existing, update, allServers);

    this.servers.set(id, updated);

    // Persist to storage (only non-builtin servers)
    if (!updated.builtin && !updated.runtime) {
      await this.persistServers();
    }

    // Emit event
    this.emit({ type: 'config-updated', config: updated });

    return updated;
  }

  /**
   * Remove an MCP server configuration.
   * Builtin servers cannot be removed.
   */
  async removeServer(id: string): Promise<void> {
    this.ensureInitialized();

    const config = this.servers.get(id);
    if (!config) {
      throw new Error(`Server not found: ${id}`);
    }

    // Block deletion of builtin servers
    if (config.builtin) {
      throw new Error(`Cannot remove builtin server: ${config.name}`);
    }

    // Disconnect if connected
    const connection = this.connections.get(id);
    if (connection && connection.status === 'connected') {
      await this.disconnect(id);
    }

    // Remove from maps
    this.servers.delete(id);
    this.clients.delete(id);
    this.connections.delete(id);

    // Persist to storage
    await this.persistServers();

    // Emit event
    this.emit({ type: 'config-removed', configId: id });

  }

  /**
   * Track 10: scoped removal — remove every server owned by a given plugin.
   *
   * Called by `PluginRegistry.disable(pluginId)` to unload one plugin's
   * MCP servers. Each server is removed via `removeServer`, which already
   * disconnects before drop and emits `config-removed` per server.
   *
   * Best-effort: per-server errors are logged but don't halt the loop, so
   * a server whose `removeServer` throws may remain in `this.servers`.
   * The loop attempts removal of every matching server regardless. Builtin
   * and user-added servers are unaffected (no `pluginId`).
   */
  async removeByPluginId(pluginId: string): Promise<void> {
    this.ensureInitialized();
    const targets = Array.from(this.servers.values()).filter(
      (s) => s.pluginId === pluginId,
    );
    for (const target of targets) {
      try {
        await this.removeServer(target.id);
      } catch (e) {
        console.warn(`[MCPManager.removeByPluginId] ${target.name}:`, e);
      }
    }
  }

  async addRuntimeServer(input: IMCPServerConfigCreate): Promise<IMCPServerConfig> {
    this.ensureInitialized();

    const existing = this.getServerByName(input.name);
    if (existing?.runtime) {
      await this.removeServer(existing.id);
    } else if (existing) {
      throw new Error(`Server with name "${input.name}" already exists`);
    }

    const config = createServerConfig(
      {
        ...input,
        runtime: true,
        enabled: input.enabled ?? true,
      },
      Array.from(this.servers.values()),
    );

    this.servers.set(config.id, config);
    this.connections.set(config.id, {
      configId: config.id,
      status: 'disconnected',
      tools: [],
      resources: [],
    });
    this.emit({ type: 'config-added', config });
    return config;
  }

  /**
   * Get all server configurations visible to the current platform.
   * Returns 'shared' servers plus servers matching the current platform.
   */
  getServers(): IMCPServerConfig[] {
    this.ensureInitialized();
    return Array.from(this.servers.values()).filter(
      (s) => s.platform === 'shared' || s.platform === this.platform
    );
  }

  /**
   * Get a specific server configuration by ID.
   */
  getServer(id: string): IMCPServerConfig | undefined {
    this.ensureInitialized();
    return this.servers.get(id);
  }

  /**
   * Find a server by name.
   */
  getServerByName(name: string): IMCPServerConfig | undefined {
    this.ensureInitialized();
    for (const config of this.servers.values()) {
      if (config.name === name) {
        return config;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  /**
   * Connect to an MCP server.
   * Creates the appropriate adapter (MCPClient for SSE, NodeMCPBridge for stdio).
   */
  async connect(id: string, authContext?: RuntimeAuthContext): Promise<void> {
    this.ensureInitialized();

    const config = this.servers.get(id);
    if (!config) {
      throw new Error(`Server not found: ${id}`);
    }

    const connection = this.connections.get(id);
    if (connection?.status === 'connected' || connection?.status === 'connecting') {
      console.warn(`[MCPManager] Server ${config.name} is already connected or connecting`);
      return;
    }

    // Update status to connecting
    this.updateConnectionStatus(id, 'connecting');

    try {
      // Create the appropriate adapter based on transport type
      const adapter = await this.createAdapter(config, authContext);

      await adapter.connect();

      this.clients.set(id, adapter);

      // Update connection state
      const conn = this.connections.get(id)!;
      conn.status = 'connected';
      conn.serverInfo = adapter.getServerInfo();
      conn.capabilities = adapter.getCapabilities();
      conn.protocolVersion = adapter.getProtocolVersion();
      conn.tools = adapter.getTools();
      conn.resources = adapter.getResources();
      conn.lastConnected = Date.now();
      conn.lastError = undefined;

      this.emit({ type: 'connection-status-changed', configId: id, status: 'connected' });
      this.emit({ type: 'tools-updated', configId: id, tools: conn.tools });
      if (conn.resources.length > 0) {
        this.emit({ type: 'resources-updated', configId: id, resources: conn.resources });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MCPManager] Connection to ${config.name} failed: ${errorMessage}`);
      this.updateConnectionStatus(id, 'error', errorMessage);
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(id: string): Promise<void> {
    this.ensureInitialized();

    const client = this.clients.get(id);
    if (!client) {
      // Not connected, just update status
      this.updateConnectionStatus(id, 'disconnected');
      return;
    }

    this.updateConnectionStatus(id, 'disconnecting');

    try {
      await client.disconnect();
    } catch (error) {
      console.warn(`[MCPManager] Error disconnecting from ${id}:`, error);
    }

    this.clients.delete(id);

    // Update connection state
    const conn = this.connections.get(id);
    if (conn) {
      conn.status = 'disconnected';
      conn.tools = [];
      conn.resources = [];
    }

    this.emit({ type: 'connection-status-changed', configId: id, status: 'disconnected' });
    this.emit({ type: 'tools-updated', configId: id, tools: [] });
  }

  /**
   * Get connection state for a server.
   */
  getConnection(id: string): IMCPConnection | undefined {
    this.ensureInitialized();
    return this.connections.get(id);
  }

  /**
   * Get all connections.
   */
  getConnections(): IMCPConnection[] {
    this.ensureInitialized();
    return Array.from(this.connections.values());
  }

  // ==========================================================================
  // Tool Management
  // ==========================================================================

  /**
   * Get all available MCP tools from all connected servers.
   */
  getAllTools(): Array<{ serverName: string; tool: IMCPTool }> {
    this.ensureInitialized();

    const allTools: Array<{ serverName: string; tool: IMCPTool }> = [];

    for (const [id, connection] of this.connections) {
      if (connection.status === 'connected') {
        const config = this.servers.get(id);
        if (config) {
          for (const tool of connection.tools) {
            allTools.push({ serverName: config.name, tool });
          }
        }
      }
    }

    return allTools;
  }

  /**
   * Execute a tool on the appropriate server.
   * @param prefixedName Tool name with server prefix (e.g., "github__search")
   * @param args Tool arguments
   */
  async executeTool(prefixedName: string, args: Record<string, unknown>): Promise<IMCPToolResult> {
    this.ensureInitialized();

    // Parse prefixed name (separator is __ to avoid LLM API restrictions on colons)
    const separatorIndex = prefixedName.indexOf('__');
    if (separatorIndex === -1) {
      throw new Error(`Invalid tool name format: ${prefixedName}. Expected "serverName__toolName"`);
    }

    const serverName = prefixedName.slice(0, separatorIndex);
    const toolName = prefixedName.slice(separatorIndex + 2);

    // Find server by name
    let serverId: string | undefined;
    for (const [id, config] of this.servers) {
      if (config.name === serverName) {
        serverId = id;
        break;
      }
    }

    if (!serverId) {
      throw new Error(`Server not found: ${serverName}`);
    }

    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`Server not connected: ${serverName}`);
    }

    return await client.callTool(toolName, args);
  }

  // ==========================================================================
  // Resource Management
  // ==========================================================================

  /**
   * Get all available MCP resources from all connected servers.
   */
  getAllResources(): Array<{ serverName: string; resource: IMCPResource }> {
    this.ensureInitialized();

    const allResources: Array<{ serverName: string; resource: IMCPResource }> = [];

    for (const [id, connection] of this.connections) {
      if (connection.status === 'connected') {
        const config = this.servers.get(id);
        if (config) {
          for (const resource of connection.resources) {
            allResources.push({ serverName: config.name, resource });
          }
        }
      }
    }

    return allResources;
  }

  /**
   * Read a resource from a server.
   */
  async readResource(serverName: string, uri: string): Promise<IMCPResourceContent> {
    this.ensureInitialized();

    // Find server by name
    let serverId: string | undefined;
    for (const [id, config] of this.servers) {
      if (config.name === serverName) {
        serverId = id;
        break;
      }
    }

    if (!serverId) {
      throw new Error(`Server not found: ${serverName}`);
    }

    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`Server not connected: ${serverName}`);
    }

    return await client.readResource(uri);
  }

  // ==========================================================================
  // Event Management
  // ==========================================================================

  /**
   * Subscribe to manager events.
   */
  on(event: 'event', handler: (event: MCPManagerEvent) => void): void {
    this.eventHandlers.add(handler);
  }

  /**
   * Unsubscribe from manager events.
   */
  off(event: 'event', handler: (event: MCPManagerEvent) => void): void {
    this.eventHandlers.delete(handler);
  }

  // ==========================================================================
  // Platform & Adapter Management
  // ==========================================================================

  /**
   * Get the current platform.
   */
  getPlatform(): MCPPlatformScope {
    return this.platform;
  }

  /**
   * Create the appropriate adapter for a server configuration.
   */
  private async createAdapter(config: IMCPServerConfig, authContext?: RuntimeAuthContext): Promise<IMCPClientAdapter> {
    const callbacks = {
      onStatusChange: (status: MCPConnectionStatus, error?: string) => {
        this.updateConnectionStatus(config.id, status, error);
      },
      onToolsChange: (tools: IMCPTool[]) => {
        this.updateConnectionTools(config.id, tools);
      },
      onResourcesChange: (resources: IMCPResource[]) => {
        this.updateConnectionResources(config.id, resources);
      },
    };

    if (config.transport === 'stdio') {
      if (__BUILD_MODE__ === 'server') {
        // Server and desktop-runtime both build under `server` mode — both
        // use Node's child_process via the MCP SDK. (Track 43: the legacy
        // RustMCPBridge has been deleted along with the Rust mcp_manager
        // command surface; the desktop runtime is the agent process and
        // owns MCP stdio directly.)
        const { NodeMCPBridge } = await import('@/server/mcp/NodeMCPBridge');
        return new NodeMCPBridge({ config, ...callbacks });
      }
      throw new Error(
        'stdio MCP servers are runtime-owned; the WebView build cannot create stdio MCP clients. Route through the runtime via mcp.* services.',
      );
    }

    // Default: SSE transport
    let apiKey: string | undefined;
    if (config.apiKey) {
      const decrypted = decryptApiKey(config.apiKey);
      apiKey = decrypted ?? undefined;
    }

    return new MCPClient({
      config,
      apiKey,
      headers: authContext?.headers,
      ...callbacks,
    });
  }

  /**
   * Seed builtin servers for the current platform.
   * On desktop, injects the 'browser' server config for chrome-devtools-mcp.
   */
  private async seedBuiltinServers(): Promise<void> {
    if (this.platform !== 'desktop') {
      return;
    }

    // Check if builtin browser server already exists
    if (this.servers.has(BUILTIN_BROWSER_SERVER_ID)) {
      return;
    }

    // Check if a server named 'browser' already exists (user-created)
    for (const config of this.servers.values()) {
      if (config.name === 'browser') {
        return;
      }
    }

    // Try the bundled sidecar binary first (production builds).
    // Fall back to npx + node_modules for dev mode where no sidecar is built.
    let command = 'npx';
    let args = ['chrome-devtools-mcp', '--no-usage-statistics', '--isolated', '--chromeArg=--no-sandbox', '--chromeArg=--disable-setuid-sandbox'];
    let cwd: string | undefined;

    if (__BUILD_MODE__ === 'server') {
      try {
        const { getOptionalDesktopRuntimeHost } = await import('@/desktop-runtime/host');
        const host = getOptionalDesktopRuntimeHost();
        if (host?.browserMcpSidecarPath) {
          command = host.browserMcpSidecarPath;
          args = ['--no-usage-statistics', '--isolated', '--chromeArg=--no-sandbox', '--chromeArg=--disable-setuid-sandbox'];
        } else if (host?.projectRoot) {
          cwd = host.projectRoot;
        }
      } catch (err) {
        console.warn('[MCPManager] Failed to resolve desktop runtime MCP host paths:', err);
      }
    }
    // Track 43: the `__BUILD_MODE__ === 'desktop'` branch that resolved the
    // sidecar path via Tauri `invoke('get_browser_mcp_sidecar_path')` is
    // gone — MCP runs in the runtime and the runtime host handshake carries
    // `browserMcpSidecarPath` directly.

    const now = Date.now();
    const builtinConfig: IMCPServerConfig = {
      id: BUILTIN_BROWSER_SERVER_ID,
      name: 'browser',
      url: '',
      transport: 'stdio',
      platform: 'desktop',
      builtin: true,
      command,
      args,
      cwd,
      enabled: true,
      timeout: 180000, // 3 min — browser tools can be slow
      createdAt: now,
      updatedAt: now,
    };

    this.servers.set(builtinConfig.id, builtinConfig);
    this.connections.set(builtinConfig.id, {
      configId: builtinConfig.id,
      status: 'disconnected',
      tools: [],
      resources: [],
    });

  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MCPManager not initialized. Call getInstance() first.');
    }
  }

  private async persistServers(): Promise<void> {
    // Only persist user/plugin servers, never builtin or runtime app servers.
    const configs = Array.from(this.servers.values()).filter(s => !s.builtin && !s.runtime);
    await saveServers(configs);
  }

  private updateConnectionStatus(id: string, status: MCPConnectionStatus, error?: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.status = status;
      conn.lastError = error;
      this.emit({ type: 'connection-status-changed', configId: id, status, error });
    }
  }

  private updateConnectionTools(id: string, tools: IMCPTool[]): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.tools = tools;
      this.emit({ type: 'tools-updated', configId: id, tools });
    }
  }

  private updateConnectionResources(id: string, resources: IMCPResource[]): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.resources = resources;
      this.emit({ type: 'resources-updated', configId: id, resources });
    }
  }

  private emit(event: MCPManagerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[MCPManager] Event handler error:', error);
      }
    }
  }

  /**
   * Reset the singleton instance (for testing purposes).
   * @internal
   */
  static resetInstance(): void {
    MCPManager.instance = null;
  }
}
