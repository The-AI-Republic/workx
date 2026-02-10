/**
 * MCP Manager Singleton
 *
 * Central manager for all MCP server connections.
 * Follows the AgentConfig singleton pattern for consistency.
 */

import type {
  IMCPServerConfig,
  IMCPServerConfigCreate,
  IMCPServerConfigUpdate,
  IMCPConnection,
  IMCPTool,
  IMCPResource,
  IMCPToolResult,
  IMCPResourceContent,
  MCPConnectionStatus,
  MCPManagerEvent,
  IMCPManager,
} from './types';
import { MCPClient } from './MCPClient';
import {
  loadServers,
  saveServers,
  createServerConfig,
  updateServerConfig,
} from './MCPConfig';
import { decryptApiKey } from '../../utils/encryption';

/** Maximum number of MCP servers allowed */
const MAX_SERVERS = 5;

/**
 * MCPManager manages multiple MCP server connections.
 *
 * This is a singleton class that:
 * - Loads/saves server configurations from chrome.storage.local
 * - Manages MCPClient instances for each connected server
 * - Aggregates tools and resources from all connected servers
 * - Emits events for status changes and updates
 *
 * Usage:
 * ```typescript
 * const manager = await MCPManager.getInstance();
 * const config = await manager.addServer({ name: 'github', url: 'https://...' });
 * await manager.connect(config.id);
 * const tools = manager.getAllTools();
 * ```
 */
export class MCPManager implements IMCPManager {
  private static instance: MCPManager | null = null;

  private servers: Map<string, IMCPServerConfig> = new Map();
  private clients: Map<string, MCPClient> = new Map();
  private connections: Map<string, IMCPConnection> = new Map();
  private eventHandlers: Set<(event: MCPManagerEvent) => void> = new Set();
  private initialized: boolean = false;

  private constructor() {}

  /**
   * Get the singleton instance of MCPManager.
   */
  public static async getInstance(): Promise<MCPManager> {
    if (!MCPManager.instance) {
      const instance = new MCPManager();
      await instance.initialize();
      MCPManager.instance = instance;
    }
    return MCPManager.instance;
  }

  /**
   * Initialize the manager by loading configs from storage.
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
      this.initialized = true;
      console.info(`[MCPManager] Initialized with ${this.servers.size} server(s)`);
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

    // Check server limit
    if (this.servers.size >= MAX_SERVERS) {
      throw new Error(`Maximum of ${MAX_SERVERS} MCP servers allowed`);
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

    // Persist to storage
    await this.persistServers();

    // Emit event
    this.emit({ type: 'config-added', config });

    console.info(`[MCPManager] Added server: ${config.name} (${config.id})`);
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

    // Persist to storage
    await this.persistServers();

    // Emit event
    this.emit({ type: 'config-updated', config: updated });

    console.info(`[MCPManager] Updated server: ${updated.name} (${id})`);
    return updated;
  }

  /**
   * Remove an MCP server configuration.
   */
  async removeServer(id: string): Promise<void> {
    this.ensureInitialized();

    const config = this.servers.get(id);
    if (!config) {
      throw new Error(`Server not found: ${id}`);
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

    console.info(`[MCPManager] Removed server: ${config.name} (${id})`);
  }

  /**
   * Get all server configurations.
   */
  getServers(): IMCPServerConfig[] {
    this.ensureInitialized();
    return Array.from(this.servers.values());
  }

  /**
   * Get a specific server configuration by ID.
   */
  getServer(id: string): IMCPServerConfig | undefined {
    this.ensureInitialized();
    return this.servers.get(id);
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  /**
   * Connect to an MCP server.
   */
  async connect(id: string): Promise<void> {
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
      // Decrypt API key if present
      let apiKey: string | undefined;
      if (config.apiKey) {
        const decrypted = decryptApiKey(config.apiKey);
        apiKey = decrypted ?? undefined;
      }

      // Create and connect client
      const client = new MCPClient({
        config,
        apiKey,
        onStatusChange: (status, error) => {
          this.updateConnectionStatus(id, status, error);
        },
        onToolsChange: (tools) => {
          this.updateConnectionTools(id, tools);
        },
        onResourcesChange: (resources) => {
          this.updateConnectionResources(id, resources);
        },
      });

      await client.connect();

      this.clients.set(id, client);

      // Update connection state
      const conn = this.connections.get(id)!;
      conn.status = 'connected';
      conn.serverInfo = client.getServerInfo();
      conn.capabilities = client.getCapabilities();
      conn.protocolVersion = client.getProtocolVersion();
      conn.tools = client.getTools();
      conn.resources = client.getResources();
      conn.lastConnected = Date.now();
      conn.lastError = undefined;

      this.emit({ type: 'connection-status-changed', configId: id, status: 'connected' });
      this.emit({ type: 'tools-updated', configId: id, tools: conn.tools });
      if (conn.resources.length > 0) {
        this.emit({ type: 'resources-updated', configId: id, resources: conn.resources });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
   * @param prefixedName Tool name with server prefix (e.g., "github:search")
   * @param args Tool arguments
   */
  async executeTool(prefixedName: string, args: Record<string, unknown>): Promise<IMCPToolResult> {
    this.ensureInitialized();

    // Parse prefixed name
    const colonIndex = prefixedName.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid tool name format: ${prefixedName}. Expected "serverName:toolName"`);
    }

    const serverName = prefixedName.slice(0, colonIndex);
    const toolName = prefixedName.slice(colonIndex + 1);

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
  // Private Methods
  // ==========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MCPManager not initialized. Call getInstance() first.');
    }
  }

  private async persistServers(): Promise<void> {
    const configs = Array.from(this.servers.values());
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
