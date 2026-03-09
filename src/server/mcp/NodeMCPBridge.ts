/**
 * Node.js MCP Bridge (stdio transport)
 *
 * Server-mode replacement for RustMCPBridge. Uses the official MCP SDK's
 * StdioClientTransport (child_process.spawn) instead of Tauri IPC.
 *
 * Implements IMCPClientAdapter so MCPManager can use it transparently.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
} from '@/core/mcp/types';

export interface NodeMCPBridgeOptions {
  config: IMCPServerConfig;
  onStatusChange?: (status: MCPConnectionStatus, error?: string) => void;
  onToolsChange?: (tools: IMCPTool[]) => void;
  onResourcesChange?: (resources: IMCPResource[]) => void;
}

export class NodeMCPBridge implements IMCPClientAdapter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private status: MCPConnectionStatus = 'disconnected';
  private serverInfo: IMCPServerInfo | undefined;
  private capabilities: IMCPCapabilities | undefined;
  private protocolVersion: string | undefined;
  private tools: IMCPTool[] = [];
  private resources: IMCPResource[] = [];
  private lastError: string | undefined;

  constructor(private readonly options: NodeMCPBridgeOptions) {}

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      const config = this.options.config;

      if (!config.command) {
        throw new Error('stdio transport requires a command');
      }

      // Create SDK stdio transport — spawns the child process
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env as Record<string, string> | undefined,
        cwd: config.cwd,
        stderr: 'pipe',
      });

      // Create MCP SDK client
      this.client = new Client(
        { name: 'applepi-server', version: '1.0.0' },
        { capabilities: {} },
      );

      // Wire transport error/close
      this.transport.onerror = (error) => {
        console.error(`[NodeMCPBridge:${config.name}] Transport error:`, error);
        if (this.status === 'connected') {
          this.setStatus('error', error.message);
        }
      };

      this.transport.onclose = () => {
        if (this.status === 'connected') {
          this.setStatus('error', 'Connection lost');
        }
      };

      // Connect with timeout
      const timeout = config.timeout || 30000;
      const connectPromise = this.client.connect(this.transport);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Connection timeout after ${timeout}ms`)), timeout);
      });

      await Promise.race([connectPromise, timeoutPromise]);

      // Extract server info
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
      console.log(`[NodeMCPBridge:${config.name}] Connected (${this.tools.length} tools, ${this.resources.length} resources)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.setStatus('error', msg);
      await this.cleanup();
      throw new Error(`Failed to connect to MCP server: ${msg}`);
    }
  }

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

  // ==========================================================================
  // Tools
  // ==========================================================================

  async listTools(): Promise<IMCPTool[]> {
    this.ensureConnected();

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
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<IMCPToolResult> {
    this.ensureConnected();

    const timeout = this.options.config.timeout || 30000;

    try {
      const callPromise = this.client!.callTool({ name, arguments: args });
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Tool call timeout after ${timeout}ms`)), timeout);
      });

      const result = await Promise.race([callPromise, timeoutPromise]);

      if ('toolResult' in result) {
        return {
          content: [{ type: 'text', text: JSON.stringify(result.toolResult) }],
          isError: false,
        };
      }

      return {
        content: result.content.map((c) => {
          if (c.type === 'text') return { type: 'text' as const, text: c.text };
          if (c.type === 'image') return { type: 'image' as const, data: c.data, mimeType: c.mimeType };
          if (c.type === 'audio') return { type: 'audio' as const, data: c.data, mimeType: c.mimeType };
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
            return { type: 'resource_link' as const, uri: c.uri, name: c.name };
          }
          return { type: 'text' as const, text: JSON.stringify(c) };
        }),
        isError: result.isError,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }

  // ==========================================================================
  // Resources
  // ==========================================================================

  async listResources(): Promise<IMCPResource[]> {
    this.ensureConnected();

    if (!this.capabilities?.resources) return [];

    try {
      const result = await this.client!.listResources();
      this.resources = result.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));

      this.options.onResourcesChange?.(this.resources);
      return this.resources;
    } catch {
      return [];
    }
  }

  async readResource(uri: string): Promise<IMCPResourceContent> {
    this.ensureConnected();

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
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getStatus(): MCPConnectionStatus { return this.status; }
  getServerInfo(): IMCPServerInfo | undefined { return this.serverInfo; }
  getCapabilities(): IMCPCapabilities | undefined { return this.capabilities; }
  getProtocolVersion(): string | undefined { return this.protocolVersion; }
  getTools(): IMCPTool[] { return this.tools; }
  getResources(): IMCPResource[] { return this.resources; }
  getLastError(): string | undefined { return this.lastError; }
  getConfigId(): string { return this.options.config.id; }

  // ==========================================================================
  // Private
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
      await this.listTools();
    }
  }

  private async discoverResources(): Promise<void> {
    if (this.capabilities?.resources) {
      await this.listResources();
    }
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }
    } catch (error) {
      console.warn('[NodeMCPBridge] Error during cleanup:', error);
    }

    this.client = null;
    this.tools = [];
    this.resources = [];
    this.serverInfo = undefined;
    this.capabilities = undefined;
    this.protocolVersion = undefined;
  }
}
