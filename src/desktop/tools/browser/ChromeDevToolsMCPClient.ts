/**
 * Chrome DevTools MCP Client
 *
 * Dedicated singleton managing the chrome-devtools-mcp server lifecycle.
 * Separate from the user-facing MCPManager (which handles user-configured MCP servers).
 *
 * Uses TauriStdioSDKTransport to spawn chrome-devtools-mcp as a subprocess
 * and communicates via the MCP SDK Client.
 *
 * @module desktop/tools/browser/ChromeDevToolsMCPClient
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { TauriStdioSDKTransport } from '@/core/mcp/transports/TauriStdioSDKTransport';

/**
 * Result from an MCP tool call
 */
export interface MCPToolCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/**
 * ChromeDevToolsMCPClient manages the chrome-devtools-mcp server lifecycle.
 *
 * - Spawns chrome-devtools-mcp via TauriStdioSDKTransport
 * - Performs MCP handshake with SDK Client
 * - Exposes callTool() for tool invocations
 * - Lazy-initializes on first use, stays connected for session lifetime
 * - Auto-reconnects if transport closes
 */
export class ChromeDevToolsMCPClient {
  private static instance: ChromeDevToolsMCPClient | null = null;

  private client: Client | null = null;
  private transport: TauriStdioSDKTransport | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): ChromeDevToolsMCPClient {
    if (!ChromeDevToolsMCPClient.instance) {
      ChromeDevToolsMCPClient.instance = new ChromeDevToolsMCPClient();
    }
    return ChromeDevToolsMCPClient.instance;
  }

  /**
   * Ensure the MCP client is connected. Lazy-initializes on first call.
   * Safe to call multiple times — will reuse existing connection or wait
   * for an in-progress connection attempt.
   */
  async ensureConnected(): Promise<void> {
    if (this.connected && this.client) {
      console.log('[ChromeDevToolsMCPClient] Already connected, reusing connection');
      return;
    }

    // If already connecting, wait for that to finish
    if (this.connecting) {
      console.log('[ChromeDevToolsMCPClient] Connection in progress, waiting...');
      await this.connecting;
      return;
    }

    console.log('[ChromeDevToolsMCPClient] Not connected, starting connection...');
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Call an MCP tool on the chrome-devtools-mcp server.
   *
   * @param name - Tool name (e.g. 'navigate_page', 'take_snapshot', 'click')
   * @param args - Tool arguments
   * @param requestTimeoutMs - MCP SDK request timeout in ms (default: 180000 = 3 min).
   *   This must be longer than the tool's own timeout to avoid the SDK aborting
   *   before the tool completes.
   */
  async callTool(name: string, args: Record<string, unknown> = {}, requestTimeoutMs = 180000): Promise<MCPToolCallResult> {
    await this.ensureConnected();

    if (!this.client) {
      throw new Error('ChromeDevToolsMCPClient: not connected');
    }

    console.log(`[ChromeDevToolsMCPClient] Calling tool: ${name}`, JSON.stringify(args));

    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: requestTimeoutMs }
      );

      const response: MCPToolCallResult = {
        content: (result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) || [],
        isError: !!result.isError,
      };

      const contentTypes = response.content.map(c => c.type).join(', ');
      const textPreview = ChromeDevToolsMCPClient.getTextContent(response).substring(0, 300);
      console.log(`[ChromeDevToolsMCPClient] Tool ${name} result: isError=${result.isError}, blocks=${response.content.length} (${contentTypes}), text=${textPreview}`);

      return response;
    } catch (error) {
      console.error(`[ChromeDevToolsMCPClient] Tool ${name} threw:`, error);
      throw error;
    }
  }

  /**
   * List all available tools from the chrome-devtools-mcp server.
   * Returns the native MCP tool schemas for direct registration.
   */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    await this.ensureConnected();

    if (!this.client) {
      throw new Error('ChromeDevToolsMCPClient: not connected');
    }

    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Get text content from a tool call result.
   * Convenience helper that extracts the first text content block.
   */
  static getTextContent(result: MCPToolCallResult): string {
    const textBlock = result.content.find((c) => c.type === 'text');
    return textBlock?.text ?? '';
  }

  /**
   * Format all content from a tool call result for LLM consumption.
   * Concatenates text blocks, includes image references, and handles
   * all content types from the MCP response.
   */
  static formatContent(result: MCPToolCallResult): string {
    if (!result.content || result.content.length === 0) {
      return '';
    }

    const parts: string[] = [];

    for (const block of result.content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'image' && block.data) {
        parts.push(`[Screenshot: base64 image (${block.mimeType || 'image/png'}, ${block.data.length} chars)]`);
      } else {
        console.log(`[ChromeDevToolsMCPClient] Unknown content block type: ${block.type}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Disconnect and clean up resources.
   */
  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        console.warn('[ChromeDevToolsMCPClient] Error closing transport:', error);
      }
      this.transport = null;
    }

    this.client = null;
    console.log('[ChromeDevToolsMCPClient] Disconnected');
  }

  /**
   * Check if currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Reset the singleton instance (for testing or full cleanup).
   */
  static async reset(): Promise<void> {
    if (ChromeDevToolsMCPClient.instance) {
      await ChromeDevToolsMCPClient.instance.disconnect();
      ChromeDevToolsMCPClient.instance = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    console.log('[ChromeDevToolsMCPClient] Connecting to chrome-devtools-mcp...');

    try {
      // Create transport — spawns chrome-devtools-mcp via Tauri.
      // Uses locally-installed binary (from node_modules/.bin) via npx.
      // No @latest tag — avoids npm registry check on every launch.
      this.transport = new TauriStdioSDKTransport({
        command: 'npx',
        args: ['chrome-devtools-mcp'],
      });

      // Wire transport close handler for auto-reconnect
      this.transport.onclose = () => {
        console.warn('[ChromeDevToolsMCPClient] Transport closed unexpectedly');
        this.connected = false;
        this.client = null;
        this.transport = null;
      };

      this.transport.onerror = (error) => {
        console.error('[ChromeDevToolsMCPClient] Transport error:', error);
      };

      // Create MCP SDK client
      this.client = new Client(
        { name: 'browserx-desktop', version: '1.0.0' },
        { capabilities: {} }
      );

      // Connect (performs MCP handshake: initialize + initialized)
      await this.client.connect(this.transport);

      this.connected = true;
      console.log('[ChromeDevToolsMCPClient] Connected successfully');
    } catch (error) {
      console.error('[ChromeDevToolsMCPClient] Connection failed:', error);
      await this.disconnect();

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to chrome-devtools-mcp: ${message}`);
    }
  }
}
