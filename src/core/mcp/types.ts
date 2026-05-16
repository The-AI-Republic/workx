/**
 * MCP Server Integration Type Definitions
 *
 * These types define the contracts for MCP server integration in ApplePi.
 * They are used for configuration, runtime state, and tool integration.
 */

import type { JsonSchema, ToolDefinition, ToolHandler } from '../../tools/BaseTool';

// =============================================================================
// Transport and Platform Types
// =============================================================================

/**
 * Transport type for MCP server communication.
 * - 'sse': Server-Sent Events (works on both extension and desktop)
 * - 'stdio': Standard I/O subprocess (desktop only, handled by Rust rmcp)
 */
export type MCPTransportType = 'sse' | 'stdio';

/**
 * Platform scope for MCP server visibility.
 * - 'shared': Visible on both extension and desktop
 * - 'extension': Only visible in Chrome extension mode
 * - 'desktop': Only visible in desktop (Tauri) mode
 * - 'server': Only visible in server (headless) mode
 */
export type MCPPlatformScope = 'shared' | 'extension' | 'desktop' | 'server';

// =============================================================================
// Configuration Types (Persisted via ConfigStorageProvider)
// =============================================================================

/**
 * Configuration for a single MCP server connection.
 * Persisted via ConfigStorageProvider under 'mcpServers' key.
 */
export interface IMCPServerConfig {
  /** UUID v4 identifier */
  id: string;

  /** Display name, also used as tool prefix (e.g., "github" → "github:search") */
  name: string;

  /** Server endpoint URL (required for SSE, not needed for stdio) */
  url: string;

  /** Encrypted API key for authentication (optional) */
  apiKey?: string;

  /** Whether to auto-connect on extension startup */
  enabled: boolean;

  /** Request timeout in milliseconds (default: 30000) */
  timeout: number;

  /** Transport type (default: 'sse') */
  transport: MCPTransportType;

  /** Platform scope (default: 'shared') */
  platform: MCPPlatformScope;

  /** Whether this is a builtin server (cannot be deleted by user) */
  builtin?: boolean;

  /** Command to execute (required for stdio transport) */
  command?: string;

  /** Arguments for the command (stdio transport) */
  args?: string[];

  /** Environment variables (stdio transport) */
  env?: Record<string, string>;

  /** Working directory (stdio transport) */
  cwd?: string;

  /** Unix timestamp of creation */
  createdAt: number;

  /** Unix timestamp of last update */
  updatedAt: number;

  /**
   * Track 10: plugin owner. Present when this server was registered by a
   * plugin (manifest.mcpServers slot). Used by `MCPManager.removeByPluginId`
   * for scoped removal on plugin disable. ID format: `<pluginName>@<marketplace>`.
   * Absent for user-added or builtin servers.
   */
  pluginId?: string;
}

/**
 * Input for creating a new MCP server configuration.
 */
export interface IMCPServerConfigCreate {
  name: string;
  url?: string;
  apiKey?: string;
  enabled?: boolean;
  timeout?: number;
  transport?: MCPTransportType;
  platform?: MCPPlatformScope;
  builtin?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Track 10: plugin owner (absent for user-added servers). */
  pluginId?: string;
}

/**
 * Input for updating an existing MCP server configuration.
 */
export interface IMCPServerConfigUpdate {
  name?: string;
  url?: string;
  apiKey?: string;
  enabled?: boolean;
  timeout?: number;
  transport?: MCPTransportType;
  platform?: MCPPlatformScope;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// =============================================================================
// Connection State Types (Runtime only, not persisted)
// =============================================================================

/**
 * Connection status for an MCP server.
 */
export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

/**
 * Server information returned during MCP initialization.
 */
export interface IMCPServerInfo {
  name: string;
  version: string;
}

/**
 * Server capabilities advertised during MCP initialization.
 */
export interface IMCPCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
}

/**
 * Runtime state for an active MCP connection.
 */
export interface IMCPConnection {
  /** Reference to MCPServerConfig.id */
  configId: string;

  /** Current connection status */
  status: MCPConnectionStatus;

  /** Negotiated MCP protocol version */
  protocolVersion?: string;

  /** Server metadata from handshake */
  serverInfo?: IMCPServerInfo;

  /** Server capabilities from handshake */
  capabilities?: IMCPCapabilities;

  /** Discovered tools */
  tools: IMCPTool[];

  /** Discovered resources */
  resources: IMCPResource[];

  /** Unix timestamp of last successful connection */
  lastConnected?: number;

  /** Last error message (if status is 'error') */
  lastError?: string;
}

// =============================================================================
// MCP Protocol Types (Match MCP specification)
// =============================================================================

/**
 * Tool definition from MCP server.
 */
export interface IMCPTool {
  /** Tool name (e.g., "search_repositories") */
  name: string;

  /** Human-readable description */
  description: string;

  /** JSON Schema for tool arguments */
  inputSchema: JsonSchema;

  /** Optional JSON Schema for tool result */
  outputSchema?: JsonSchema;

  /** Optional annotations */
  annotations?: {
    /** Raw MCP hints — preserved for concurrency classification */
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    /** Display-oriented fields */
    audience?: ('user' | 'assistant')[];
    priority?: number;
    costLevel?: 'low' | 'medium' | 'high';
  };
}

/**
 * Resource definition from MCP server.
 */
export interface IMCPResource {
  /** Resource URI (e.g., "file:///path/to/file") */
  uri: string;

  /** Human-readable name */
  name: string;

  /** Resource description */
  description?: string;

  /** MIME type of resource content */
  mimeType?: string;
}

/**
 * Content item in tool result (union type).
 */
export type IMCPContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: IMCPResource }
  | { type: 'resource_link'; uri: string; name?: string };

/**
 * Result of an MCP tool execution.
 */
export interface IMCPToolResult {
  /** Array of content items */
  content: IMCPContent[];

  /** True if tool execution failed */
  isError?: boolean;
}

/**
 * Resource content returned from resources/read.
 */
export interface IMCPResourceContent {
  /** Resource URI */
  uri: string;

  /** MIME type */
  mimeType?: string;

  /** Text content (if text-based) */
  text?: string;

  /** Binary content as base64 (if binary) */
  blob?: string;
}

// =============================================================================
// Manager Interface
// =============================================================================

/**
 * Events emitted by MCPManager.
 */
export type MCPManagerEvent =
  | { type: 'connection-status-changed'; configId: string; status: MCPConnectionStatus; error?: string }
  | { type: 'tools-updated'; configId: string; tools: IMCPTool[] }
  | { type: 'resources-updated'; configId: string; resources: IMCPResource[] }
  | { type: 'config-added'; config: IMCPServerConfig }
  | { type: 'config-updated'; config: IMCPServerConfig }
  | { type: 'config-removed'; configId: string };

/**
 * MCPManager interface for managing multiple MCP connections.
 */
export interface IMCPManager {
  /**
   * Initialize manager, loading configs from storage.
   */
  initialize(): Promise<void>;

  /**
   * Add a new MCP server configuration.
   */
  addServer(config: IMCPServerConfigCreate): Promise<IMCPServerConfig>;

  /**
   * Update an existing MCP server configuration.
   */
  updateServer(id: string, update: IMCPServerConfigUpdate): Promise<IMCPServerConfig>;

  /**
   * Remove an MCP server configuration.
   */
  removeServer(id: string): Promise<void>;

  /**
   * Track 10: scoped removal — remove every server owned by a given plugin.
   * Each server is disconnected before drop. Per-server errors logged but
   * don't halt the loop.
   */
  removeByPluginId(pluginId: string): Promise<void>;

  /**
   * Get all server configurations.
   */
  getServers(): IMCPServerConfig[];

  /**
   * Get a specific server configuration by ID.
   */
  getServer(id: string): IMCPServerConfig | undefined;

  /**
   * Connect to an MCP server.
   */
  connect(id: string): Promise<void>;

  /**
   * Disconnect from an MCP server.
   */
  disconnect(id: string): Promise<void>;

  /**
   * Get connection state for a server.
   */
  getConnection(id: string): IMCPConnection | undefined;

  /**
   * Get all active connections.
   */
  getConnections(): IMCPConnection[];

  /**
   * Get all available MCP tools (from all connected servers).
   */
  getAllTools(): Array<{ serverName: string; tool: IMCPTool }>;

  /**
   * Execute a tool on the appropriate server.
   * @param prefixedName Tool name with server prefix (e.g., "github:search")
   * @param args Tool arguments
   */
  executeTool(prefixedName: string, args: Record<string, unknown>): Promise<IMCPToolResult>;

  /**
   * Get all available MCP resources (from all connected servers).
   */
  getAllResources(): Array<{ serverName: string; resource: IMCPResource }>;

  /**
   * Read a resource from a server.
   * @param serverName Server name
   * @param uri Resource URI
   */
  readResource(serverName: string, uri: string): Promise<IMCPResourceContent>;

  /**
   * Subscribe to manager events.
   */
  on(event: 'event', handler: (event: MCPManagerEvent) => void): void;

  /**
   * Unsubscribe from manager events.
   */
  off(event: 'event', handler: (event: MCPManagerEvent) => void): void;
}

// =============================================================================
// Tool Adapter Interface
// =============================================================================

/**
 * Adapts MCP tools to ApplePi ToolDefinition format.
 */
export interface IMCPToolAdapter {
  /**
   * Convert an MCP tool to a ToolDefinition.
   * @param tool MCP tool definition
   * @param serverName Server name for prefixing
   */
  adaptTool(tool: IMCPTool, serverName: string): ToolDefinition;

  /**
   * Create a handler for an MCP tool.
   * @param manager MCP manager instance
   * @param serverName Server name
   * @param toolName Original tool name (without prefix)
   */
  createHandler(
    manager: IMCPManager,
    serverName: string,
    toolName: string
  ): ToolHandler;

  /**
   * Parse a prefixed tool name into server and tool parts.
   * @param prefixedName e.g., "github__search"
   * @returns { serverName: "github", toolName: "search" } or null if invalid
   */
  parsePrefixedName(prefixedName: string): { serverName: string; toolName: string } | null;
}

// =============================================================================
// Client Adapter Interface
// =============================================================================

/**
 * Unified client adapter interface for MCP connections.
 * Both MCPClient (SSE) and RustMCPBridge (stdio) implement this interface,
 * allowing MCPManager to work with either transport transparently.
 */
export interface IMCPClientAdapter {
  /** Connect to the MCP server */
  connect(): Promise<void>;

  /** Disconnect from the MCP server */
  disconnect(): Promise<void>;

  /** List available tools from the server */
  listTools(): Promise<IMCPTool[]>;

  /** Call a tool with the given arguments */
  callTool(name: string, args: Record<string, unknown>): Promise<IMCPToolResult>;

  /** List available resources from the server */
  listResources(): Promise<IMCPResource[]>;

  /** Read a resource by URI */
  readResource(uri: string): Promise<IMCPResourceContent>;

  /** Get current connection status */
  getStatus(): MCPConnectionStatus;

  /** Get server info from handshake */
  getServerInfo(): IMCPServerInfo | undefined;

  /** Get server capabilities */
  getCapabilities(): IMCPCapabilities | undefined;

  /** Get cached tools list */
  getTools(): IMCPTool[];

  /** Get cached resources list */
  getResources(): IMCPResource[];

  /** Get last error message */
  getLastError(): string | undefined;

  /** Get the configuration ID this client is associated with */
  getConfigId(): string;

  /** Get negotiated protocol version */
  getProtocolVersion(): string | undefined;
}

// =============================================================================
// Transport Interface
// =============================================================================

/**
 * Transport interface for MCP communication.
 * Custom implementation for browser context (EventSource + fetch).
 */
export interface IMCPTransport {
  /**
   * Start the transport connection.
   */
  start(): Promise<void>;

  /**
   * Send a message to the server.
   */
  send(message: unknown): Promise<void>;

  /**
   * Close the transport connection.
   */
  close(): Promise<void>;

  /**
   * Callback for receiving messages.
   */
  onMessage?: (message: unknown) => void;

  /**
   * Callback for connection close.
   */
  onClose?: () => void;

  /**
   * Callback for errors.
   */
  onError?: (error: Error) => void;
}

// =============================================================================
// Message Types (for chrome.runtime communication)
// =============================================================================

export type MCPMessageType =
  | 'MCP_GET_SERVERS'
  | 'MCP_ADD_SERVER'
  | 'MCP_UPDATE_SERVER'
  | 'MCP_REMOVE_SERVER'
  | 'MCP_CONNECT'
  | 'MCP_DISCONNECT'
  | 'MCP_GET_CONNECTION'
  | 'MCP_GET_ALL_TOOLS'
  | 'MCP_EXECUTE_TOOL'
  | 'MCP_GET_ALL_RESOURCES'
  | 'MCP_READ_RESOURCE';

export interface MCPMessage {
  type: MCPMessageType;
  payload?: unknown;
}

export interface MCPResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
