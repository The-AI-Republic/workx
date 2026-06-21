/**
 * MCP Streamable HTTP client.
 *
 * Used for remote MCP servers that expose the MCP Streamable HTTP transport at
 * a single endpoint.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

export interface StreamableHttpMCPClientOptions {
  config: IMCPServerConfig;
  apiKey?: string;
  tokenProvider?: () => Promise<string | null>;
  refreshTokenProvider?: () => Promise<string | null>;
  onStatusChange?: (status: MCPConnectionStatus, error?: string) => void;
  onToolsChange?: (tools: IMCPTool[]) => void;
  onResourcesChange?: (resources: IMCPResource[]) => void;
}

export class StreamableHttpMCPClient implements IMCPClientAdapter {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private status: MCPConnectionStatus = 'disconnected';
  private serverInfo: IMCPServerInfo | undefined;
  private capabilities: IMCPCapabilities | undefined;
  private protocolVersion: string | undefined;
  private tools: IMCPTool[] = [];
  private resources: IMCPResource[] = [];
  private lastError: string | undefined;

  constructor(private readonly options: StreamableHttpMCPClientOptions) {}

  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') return;

    this.setStatus('connecting');
    try {
      const config = this.options.config;
      const timeout = config.timeout || 30000;

      this.transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
        fetch: this.createAuthenticatedFetch(),
      });

      this.client = new Client(
        { name: 'workx', version: '1.0.0' },
        { capabilities: {} },
      );

      this.transport.onerror = (error) => {
        console.error(`[StreamableHttpMCPClient:${config.name}] Transport error:`, error);
        if (this.status === 'connected') this.setStatus('error', error.message);
      };
      this.transport.onclose = () => {
        if (this.status === 'connected') this.setStatus('error', 'Connection lost');
      };

      await Promise.race([
        this.client.connect(this.transport),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Connection timeout after ${timeout}ms`)), timeout);
        }),
      ]);

      const serverVersion = this.client.getServerVersion();
      if (serverVersion) {
        this.serverInfo = { name: serverVersion.name, version: serverVersion.version };
      }

      const serverCaps = this.client.getServerCapabilities();
      if (serverCaps) {
        this.capabilities = {
          tools: serverCaps.tools ? { listChanged: !!serverCaps.tools.listChanged } : undefined,
          resources: serverCaps.resources ? { subscribe: !!serverCaps.resources.subscribe } : undefined,
          prompts: serverCaps.prompts ? { listChanged: !!serverCaps.prompts.listChanged } : undefined,
        };
      }

      this.setStatus('connected');
      await this.discoverTools();
      await this.discoverResources();

      console.log(`[StreamableHttpMCPClient:${config.name}] Connected (${this.tools.length} tools, ${this.resources.length} resources)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.setStatus('error', msg);
      await this.cleanup();
      throw new Error(`Failed to connect to MCP server: ${msg}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.status === 'disconnected' || this.status === 'disconnecting') return;
    this.setStatus('disconnecting');
    try {
      await this.cleanup();
    } finally {
      this.setStatus('disconnected');
    }
  }

  async listTools(): Promise<IMCPTool[]> {
    this.ensureConnected();
    const result = await this.client!.listTools();
    this.tools = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema as IMCPTool['inputSchema'],
      outputSchema: tool.outputSchema as IMCPTool['outputSchema'],
      annotations: tool.annotations ? {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        openWorldHint: tool.annotations.openWorldHint,
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
      const result = await Promise.race([
        this.client!.callTool({ name, arguments: args }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Tool call timeout after ${timeout}ms`)), timeout);
        }),
      ]);

      if (name === 'app_activate' || name === 'app_deactivate') {
        await this.listTools().catch((error) => {
          console.warn(`[StreamableHttpMCPClient:${this.options.config.name}] Failed to refresh tools:`, error);
        });
      }

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
          if (c.type === 'resource_link') return { type: 'resource_link' as const, uri: c.uri, name: c.name };
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

  private createAuthenticatedFetch(): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const authMode = this.options.config.authMode ?? (this.options.apiKey ? 'api-key' : 'none');

      const send = async (sessionToken?: string | null): Promise<Response> => {
        const headers = new Headers(init?.headers ?? {});
        for (const [key, value] of Object.entries(this.options.config.headers ?? {})) {
          if (!headers.has(key)) headers.set(key, value);
        }

        if (authMode === 'session-jwt') {
          if (!sessionToken) throw new Error('MCP session-jwt auth requires an access token');
          headers.set('Authorization', `Bearer ${sessionToken}`);
        } else if (authMode === 'api-key' && this.options.apiKey) {
          headers.set('Authorization', `Bearer ${this.options.apiKey}`);
        }

        return fetch(input, { ...init, headers });
      };

      if (authMode !== 'session-jwt') {
        return send();
      }

      let token = await this.options.tokenProvider?.();
      if (!token) {
        token = await this.options.refreshTokenProvider?.();
      }
      const response = await send(token);
      if (response.status !== 401 || !this.options.refreshTokenProvider) {
        return response;
      }

      const refreshed = await this.options.refreshTokenProvider();
      return refreshed ? send(refreshed) : response;
    };
  }

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
      await this.transport?.close();
    } catch (error) {
      console.warn(`[StreamableHttpMCPClient:${this.options.config.name}] Error during cleanup:`, error);
    }

    this.transport = null;
    this.client = null;
    this.tools = [];
    this.resources = [];
    this.serverInfo = undefined;
    this.capabilities = undefined;
    this.protocolVersion = undefined;
  }
}
