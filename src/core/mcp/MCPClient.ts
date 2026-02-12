/**
 * MCP Client Wrapper
 *
 * Wraps the official MCP SDK Client with our custom SSE transport.
 * Provides a simplified interface for browserx integration.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, type SSEClientTransportOptions } from './transports/SSEClientTransport';
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
import { isDebugLoggingEnabled } from './MCPConfig';

/**
 * Options for MCPClient
 */
export interface MCPClientOptions {
  /** Server configuration */
  config: IMCPServerConfig;

  /** Decrypted API key (if any) */
  apiKey?: string;

  /** Callback when connection status changes */
  onStatusChange?: (status: MCPConnectionStatus, error?: string) => void;

  /** Callback when tools list changes */
  onToolsChange?: (tools: IMCPTool[]) => void;

  /** Callback when resources list changes */
  onResourcesChange?: (resources: IMCPResource[]) => void;
}

/**
 * MCPClient wraps the MCP SDK Client with browserx-specific functionality.
 *
 * Usage:
 * ```typescript
 * const client = new MCPClient({ config, apiKey });
 * await client.connect();
 * const tools = await client.listTools();
 * const result = await client.callTool('search', { query: 'test' });
 * await client.disconnect();
 * ```
 */
export class MCPClient implements IMCPClientAdapter {
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private status: MCPConnectionStatus = 'disconnected';
  private serverInfo: IMCPServerInfo | undefined;
  private capabilities: IMCPCapabilities | undefined;
  private protocolVersion: string | undefined;
  private tools: IMCPTool[] = [];
  private resources: IMCPResource[] = [];
  private lastError: string | undefined;
  private debugLogging: boolean | null = null;

  constructor(private readonly options: MCPClientOptions) {}

  /**
   * Check if debug logging is enabled and log message if so (T062).
   */
  private async debugLog(message: string, data?: unknown): Promise<void> {
    // Cache debug logging setting
    if (this.debugLogging === null) {
      try {
        this.debugLogging = await isDebugLoggingEnabled();
      } catch {
        this.debugLogging = false;
      }
    }

    if (this.debugLogging) {
      if (data !== undefined) {
        console.log(`[MCP:${this.options.config.name}] ${message}`, data);
      } else {
        console.log(`[MCP:${this.options.config.name}] ${message}`);
      }
    }
  }

  /**
   * Connect to the MCP server.
   * Establishes SSE transport and performs protocol handshake.
   */
  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      console.warn('[MCPClient] Already connected or connecting');
      return;
    }

    this.setStatus('connecting');

    try {
      // Create transport
      const transportOptions: SSEClientTransportOptions = {
        url: this.options.config.url,
        apiKey: this.options.apiKey,
        timeout: this.options.config.timeout,
      };

      this.transport = new SSEClientTransport(transportOptions);

      // Create MCP client with browserx identity
      this.client = new Client(
        {
          name: 'browserx',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      );

      // Set up transport error handling
      this.transport.onerror = (error) => {
        console.error('[MCPClient] Transport error:', error);
        this.handleTransportError(error);
      };

      this.transport.onclose = () => {
        console.debug('[MCPClient] Transport closed');
        if (this.status === 'connected') {
          this.setStatus('error', 'Connection lost');
        }
      };

      // Connect with timeout
      const connectPromise = this.client.connect(this.transport);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Connection timeout after ${this.options.config.timeout}ms`)),
          this.options.config.timeout
        );
      });

      await Promise.race([connectPromise, timeoutPromise]);

      // Extract server info from handshake
      const serverVersion = this.client.getServerVersion();
      if (serverVersion) {
        this.serverInfo = {
          name: serverVersion.name,
          version: serverVersion.version,
        };
      }

      // Extract capabilities
      const serverCaps = this.client.getServerCapabilities();
      if (serverCaps) {
        this.capabilities = {
          tools: serverCaps.tools ? { listChanged: !!serverCaps.tools.listChanged } : undefined,
          resources: serverCaps.resources ? { subscribe: !!serverCaps.resources.subscribe } : undefined,
          prompts: serverCaps.prompts ? { listChanged: !!serverCaps.prompts.listChanged } : undefined,
        };
      }

      // Discover tools and resources
      await this.discoverTools();
      await this.discoverResources();

      this.setStatus('connected');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.setStatus('error', errorMessage);
      await this.cleanup();
      throw new Error(`Failed to connect to MCP server: ${errorMessage}`);
    }
  }

  /**
   * Disconnect from the MCP server.
   * Performs graceful shutdown.
   */
  async disconnect(): Promise<void> {
    if (this.status === 'disconnected' || this.status === 'disconnecting') {
      return;
    }

    this.setStatus('disconnecting');

    try {
      await this.cleanup();
    } finally {
      this.setStatus('disconnected');
    }
  }

  /**
   * List available tools from the server.
   */
  async listTools(): Promise<IMCPTool[]> {
    this.ensureConnected();

    try {
      const result = await this.client!.listTools();
      this.tools = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema as IMCPTool['inputSchema'],
        outputSchema: tool.outputSchema as IMCPTool['outputSchema'],
        annotations: tool.annotations ? {
          audience: tool.annotations.readOnlyHint ? ['user' as const] : undefined,
          priority: undefined,
          costLevel: tool.annotations.destructiveHint ? 'high' as const : undefined,
        } : undefined,
      }));

      this.options.onToolsChange?.(this.tools);
      return this.tools;
    } catch (error) {
      console.error('[MCPClient] Failed to list tools:', error);
      throw error;
    }
  }

  /**
   * Call a tool with the given arguments.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<IMCPToolResult> {
    this.ensureConnected();

    const timeout = this.options.config.timeout;

    // Debug log: tool call request (T062)
    await this.debugLog(`Calling tool: ${name}`, { args, timeout });

    try {
      const callPromise = this.client!.callTool({
        name,
        arguments: args,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Tool call timeout after ${timeout}ms`)), timeout);
      });

      const result = await Promise.race([callPromise, timeoutPromise]);

      // Debug log: tool call response (T062)
      await this.debugLog(`Tool response: ${name}`, { isError: result.isError, contentCount: result.content?.length });

      // Handle compatibility with different result formats
      if ('toolResult' in result) {
        // Old format
        return {
          content: [{ type: 'text', text: JSON.stringify(result.toolResult) }],
          isError: false,
        };
      }

      // Standard format
      return {
        content: result.content.map((c) => {
          if (c.type === 'text') {
            return { type: 'text' as const, text: c.text };
          }
          if (c.type === 'image') {
            return { type: 'image' as const, data: c.data, mimeType: c.mimeType };
          }
          if (c.type === 'audio') {
            return { type: 'audio' as const, data: c.data, mimeType: c.mimeType };
          }
          if (c.type === 'resource') {
            return {
              type: 'resource' as const,
              resource: {
                uri: c.resource.uri,
                name: c.resource.uri.split('/').pop() || c.resource.uri,
                mimeType: c.resource.mimeType,
              },
            };
          }
          if (c.type === 'resource_link') {
            return {
              type: 'resource_link' as const,
              uri: c.uri,
              name: c.name,
            };
          }
          // Unknown type - convert to text
          return { type: 'text' as const, text: JSON.stringify(c) };
        }),
        isError: result.isError,
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

    // Check if server supports resources
    if (!this.capabilities?.resources) {
      return [];
    }

    try {
      const result = await this.client!.listResources();
      this.resources = result.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));

      this.options.onResourcesChange?.(this.resources);
      return this.resources;
    } catch (error) {
      console.error('[MCPClient] Failed to list resources:', error);
      // Return empty array if resources not supported
      return [];
    }
  }

  /**
   * Read a resource by URI.
   */
  async readResource(uri: string): Promise<IMCPResourceContent> {
    this.ensureConnected();

    try {
      const result = await this.client!.readResource({ uri });

      if (!result.contents || result.contents.length === 0) {
        throw new Error(`Resource not found: ${uri}`);
      }

      const content = result.contents[0];
      return {
        uri: content.uri,
        mimeType: content.mimeType,
        text: 'text' in content ? content.text : undefined,
        blob: 'blob' in content ? content.blob : undefined,
      };
    } catch (error) {
      console.error('[MCPClient] Failed to read resource:', error);
      throw error;
    }
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /**
   * Get current connection status.
   */
  getStatus(): MCPConnectionStatus {
    return this.status;
  }

  /**
   * Get server info from handshake.
   */
  getServerInfo(): IMCPServerInfo | undefined {
    return this.serverInfo;
  }

  /**
   * Get server capabilities.
   */
  getCapabilities(): IMCPCapabilities | undefined {
    return this.capabilities;
  }

  /**
   * Get negotiated protocol version.
   */
  getProtocolVersion(): string | undefined {
    return this.protocolVersion;
  }

  /**
   * Get cached tools list.
   */
  getTools(): IMCPTool[] {
    return this.tools;
  }

  /**
   * Get cached resources list.
   */
  getResources(): IMCPResource[] {
    return this.resources;
  }

  /**
   * Get last error message.
   */
  getLastError(): string | undefined {
    return this.lastError;
  }

  /**
   * Get the configuration ID this client is associated with.
   */
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
    if (this.status !== 'connected' || !this.client) {
      throw new Error('Not connected to MCP server');
    }
  }

  private async discoverTools(): Promise<void> {
    if (this.capabilities?.tools || !this.capabilities) {
      // Either server has tools capability or we don't know yet, try listing
      await this.listTools();
    }
  }

  private async discoverResources(): Promise<void> {
    if (this.capabilities?.resources) {
      await this.listResources();
    }
  }

  private handleTransportError(error: Error): void {
    if (this.status === 'connected') {
      this.setStatus('error', error.message);
    }
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }
    } catch (error) {
      console.warn('[MCPClient] Error during cleanup:', error);
    }

    this.client = null;
    this.tools = [];
    this.resources = [];
    this.serverInfo = undefined;
    this.capabilities = undefined;
    this.protocolVersion = undefined;
  }
}
