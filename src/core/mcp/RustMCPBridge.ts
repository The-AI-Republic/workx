/**
 * Rust MCP Bridge
 *
 * Thin JS adapter implementing IMCPClientAdapter for stdio-based MCP servers.
 * Each method delegates to Tauri invoke() → Rust mcp_manager.rs → rmcp SDK.
 *
 * Used by MCPManager when transport === 'stdio' (desktop only).
 *
 * @module core/mcp/RustMCPBridge
 */

import type {
  IMCPClientAdapter,
  IMCPServerConfig,
  IMCPServerInfo,
  IMCPCapabilities,
  IMCPTool,
  IMCPResource,
  IMCPToolResult,
  IMCPResourceContent,
  MCPConnectionStatus,
} from './types';

/**
 * Result from Rust mcp_connect command
 */
interface McpConnectResult {
  success: boolean;
  server_name?: string;
  server_version?: string;
  protocol_version?: string;
  capabilities?: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  error?: string;
}

/**
 * Tool definition from Rust mcp_list_tools command
 */
interface McpToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/**
 * Content block from Rust mcp_call_tool command
 */
interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * Tool result from Rust mcp_call_tool command
 */
interface McpToolResult {
  content: McpContentBlock[];
  is_error: boolean;
}

/**
 * Resource definition from Rust mcp_list_resources command
 */
interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * Resource content from Rust mcp_read_resource command
 */
interface McpResourceContentResult {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/**
 * Options for RustMCPBridge
 */
export interface RustMCPBridgeOptions {
  /** Server configuration */
  config: IMCPServerConfig;

  /** Callback when connection status changes */
  onStatusChange?: (status: MCPConnectionStatus, error?: string) => void;

  /** Callback when tools list changes */
  onToolsChange?: (tools: IMCPTool[]) => void;

  /** Callback when resources list changes */
  onResourcesChange?: (resources: IMCPResource[]) => void;
}

/**
 * RustMCPBridge implements IMCPClientAdapter for stdio MCP servers.
 *
 * Instead of running MCP protocol in JS, it delegates to Rust's rmcp SDK
 * via Tauri invoke(). This gives us proper process management, efficient
 * binary I/O, and the full MCP protocol handled natively.
 */
export class RustMCPBridge implements IMCPClientAdapter {
  private status: MCPConnectionStatus = 'disconnected';
  private serverInfo: IMCPServerInfo | undefined;
  private capabilities: IMCPCapabilities | undefined;
  private protocolVersion: string | undefined;
  private tools: IMCPTool[] = [];
  private resources: IMCPResource[] = [];
  private lastError: string | undefined;

  constructor(private readonly options: RustMCPBridgeOptions) {}

  /**
   * Connect to the MCP server via Rust subprocess.
   */
  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      const connectParams = {
        serverId: this.options.config.id,
        command: this.options.config.command!,
        args: this.options.config.args || [],
        env: this.options.config.env,
        cwd: this.options.config.cwd,
      };

      const result = await invoke<McpConnectResult>('mcp_connect', connectParams);

      if (!result.success) {
        throw new Error(result.error || 'Connection failed');
      }

      // Store server metadata
      if (result.server_name) {
        this.serverInfo = {
          name: result.server_name,
          version: result.server_version || '0.0.0',
        };
      }

      if (result.capabilities) {
        this.capabilities = {
          tools: result.capabilities.tools ? { listChanged: false } : undefined,
          resources: result.capabilities.resources ? { subscribe: false } : undefined,
          prompts: result.capabilities.prompts ? { listChanged: false } : undefined,
        };
      }

      this.protocolVersion = result.protocol_version;

      // Discover tools and resources
      await this.discoverTools();
      await this.discoverResources();

      this.setStatus('connected');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[RustMCPBridge] Connection failed: ${errorMessage}`);
      this.setStatus('error', errorMessage);
      throw new Error(`Failed to connect to MCP server: ${errorMessage}`);
    }
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.status === 'disconnected' || this.status === 'disconnecting') {
      return;
    }

    this.setStatus('disconnecting');

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('mcp_disconnect', { serverId: this.options.config.id });
    } catch (error) {
      console.warn(`[RustMCPBridge] Error disconnecting:`, error);
    }

    this.cleanup();
    this.setStatus('disconnected');
  }

  /**
   * List available tools from the server.
   */
  async listTools(): Promise<IMCPTool[]> {
    this.ensureConnected();

    const { invoke } = await import('@tauri-apps/api/core');

    const rustTools = await invoke<McpToolDef[]>('mcp_list_tools', {
      serverId: this.options.config.id,
    });

    this.tools = rustTools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.input_schema as IMCPTool['inputSchema'],
    }));

    this.options.onToolsChange?.(this.tools);
    return this.tools;
  }

  /**
   * Call a tool with the given arguments.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<IMCPToolResult> {
    this.ensureConnected();

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      const result = await invoke<McpToolResult>('mcp_call_tool', {
        serverId: this.options.config.id,
        toolName: name,
        arguments: args,
        timeoutMs: this.options.config.timeout,
      });

      return {
        content: result.content.map((c) => {
          if (c.type === 'text') {
            return { type: 'text' as const, text: c.text || '' };
          }
          if (c.type === 'image') {
            return { type: 'image' as const, data: c.data || '', mimeType: c.mimeType || 'image/png' };
          }
          if (c.type === 'audio') {
            return { type: 'audio' as const, data: c.data || '', mimeType: c.mimeType || 'audio/wav' };
          }
          return { type: 'text' as const, text: c.text || `[${c.type}]` };
        }),
        isError: result.is_error,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  }

  /**
   * List available resources from the server.
   */
  async listResources(): Promise<IMCPResource[]> {
    this.ensureConnected();

    if (!this.capabilities?.resources) {
      return [];
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      const rustResources = await invoke<McpResourceDef[]>('mcp_list_resources', {
        serverId: this.options.config.id,
      });

      this.resources = rustResources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));

      this.options.onResourcesChange?.(this.resources);
      return this.resources;
    } catch (error) {
      console.error('[RustMCPBridge] Failed to list resources:', error);
      return [];
    }
  }

  /**
   * Read a resource by URI.
   */
  async readResource(uri: string): Promise<IMCPResourceContent> {
    this.ensureConnected();

    const { invoke } = await import('@tauri-apps/api/core');

    const result = await invoke<McpResourceContentResult>('mcp_read_resource', {
      serverId: this.options.config.id,
      uri,
    });

    return {
      uri: result.uri,
      mimeType: result.mimeType,
      text: result.text,
      blob: result.blob,
    };
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getStatus(): MCPConnectionStatus {
    return this.status;
  }

  getServerInfo(): IMCPServerInfo | undefined {
    return this.serverInfo;
  }

  getCapabilities(): IMCPCapabilities | undefined {
    return this.capabilities;
  }

  getProtocolVersion(): string | undefined {
    return this.protocolVersion;
  }

  getTools(): IMCPTool[] {
    return this.tools;
  }

  getResources(): IMCPResource[] {
    return this.resources;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getConfigId(): string {
    return this.options.config.id;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private setStatus(status: MCPConnectionStatus, error?: string): void {
    this.status = status;
    this.lastError = error;
    this.options.onStatusChange?.(status, error);
  }

  private ensureConnected(): void {
    if (this.status !== 'connected') {
      throw new Error('Not connected to MCP server');
    }
  }

  private async discoverTools(): Promise<void> {
    if (this.capabilities?.tools || !this.capabilities) {
      // Internal call — bypass ensureConnected() since we're still in connect()
      const { invoke } = await import('@tauri-apps/api/core');

      const rustTools = await invoke<McpToolDef[]>('mcp_list_tools', {
        serverId: this.options.config.id,
      });

      this.tools = rustTools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.input_schema as IMCPTool['inputSchema'],
      }));

      this.options.onToolsChange?.(this.tools);
    }
  }

  private async discoverResources(): Promise<void> {
    if (this.capabilities?.resources) {
      // Internal call — bypass ensureConnected() since we're still in connect()
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        const rustResources = await invoke<McpResourceDef[]>('mcp_list_resources', {
          serverId: this.options.config.id,
        });

        this.resources = rustResources.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));

        this.options.onResourcesChange?.(this.resources);
      } catch (error) {
        console.error('[RustMCPBridge] Failed to discover resources:', error);
      }
    }
  }

  private cleanup(): void {
    this.tools = [];
    this.resources = [];
    this.serverInfo = undefined;
    this.capabilities = undefined;
    this.protocolVersion = undefined;
  }
}
