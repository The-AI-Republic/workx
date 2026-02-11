/**
 * Tauri Stdio Transport
 *
 * Desktop-mode transport using Tauri to spawn and communicate
 * with MCP servers via stdio.
 *
 * @module core/mcp/transports/TauriStdioTransport
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { MCPTransport } from './index';

/**
 * Stdio transport options
 */
export interface TauriStdioTransportOptions {
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Startup timeout in milliseconds */
  timeout?: number;
}

/**
 * Message received from MCP process.
 * Field names must match the Rust McpMessage struct's serde serialization (snake_case).
 */
interface MCPProcessMessage {
  session_id: string;
  message: string;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: Partial<TauriStdioTransportOptions> = {
  args: [],
  timeout: 30000,
};

/**
 * TauriStdioTransport implements MCPTransport using Tauri's process spawning
 *
 * @example
 * ```typescript
 * const transport = new TauriStdioTransport({
 *   command: 'npx',
 *   args: ['-y', '@anthropic-ai/mcp-server-filesystem'],
 * });
 *
 * await transport.connect();
 * transport.onMessage((msg) => console.log('Received:', msg));
 * await transport.send({ jsonrpc: '2.0', method: 'initialize', id: 1 });
 * ```
 */
export class TauriStdioTransport implements MCPTransport {
  private options: Required<TauriStdioTransportOptions>;
  private sessionId: string | null = null;
  private messageHandlers: Array<(message: unknown) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private connected = false;
  private unlistenFn: UnlistenFn | null = null;

  constructor(options: TauriStdioTransportOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      args: options.args || [],
      timeout: options.timeout || 30000,
    } as Required<TauriStdioTransportOptions>;
  }

  /**
   * Connect (spawn the MCP server process)
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    console.log(`[TauriStdioTransport] Spawning: ${this.options.command} ${this.options.args.join(' ')}`);

    try {
      // Listen for messages from the MCP process
      this.unlistenFn = await listen<MCPProcessMessage>('mcp_message', (event) => {
        const payload = event.payload;
        console.log(`[TauriStdioTransport] Event received: session_id=${payload.session_id}, my_session=${this.sessionId}, message_len=${payload.message?.length ?? 0}`);

        if (payload.session_id === this.sessionId) {
          this.handleMessage(payload.message);
        } else {
          console.warn(`[TauriStdioTransport] Session mismatch: got ${payload.session_id}, expected ${this.sessionId}`);
        }
      });

      // Spawn the MCP server process via Tauri command
      const result = await invoke<{ session_id: string; success: boolean; error?: string }>(
        'mcp_spawn',
        {
          server: this.options.command,
          args: this.options.args,
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to spawn MCP server');
      }

      this.sessionId = result.session_id;
      this.connected = true;

      console.log(`[TauriStdioTransport] Connected, session: ${this.sessionId}`);
    } catch (error) {
      console.error('[TauriStdioTransport] Failed to connect:', error);
      this.cleanup();
      throw error;
    }
  }

  /**
   * Disconnect (terminate the MCP server process)
   */
  async disconnect(): Promise<void> {
    if (!this.connected || !this.sessionId) {
      return;
    }

    console.log(`[TauriStdioTransport] Closing session: ${this.sessionId}`);

    try {
      await invoke('mcp_close', { sessionId: this.sessionId });
    } catch (error) {
      console.warn('[TauriStdioTransport] Error closing:', error);
    }

    this.cleanup();
    this.notifyClose();

    console.log('[TauriStdioTransport] Disconnected');
  }

  /**
   * Send a message to the MCP server
   */
  async send(message: unknown): Promise<void> {
    if (!this.connected || !this.sessionId) {
      throw new Error('Not connected');
    }

    const messageStr = JSON.stringify(message);

    try {
      const result = await invoke<boolean>('mcp_send', {
        sessionId: this.sessionId,
        message: messageStr,
      });

      if (!result) {
        throw new Error('Failed to send message');
      }
    } catch (error) {
      console.error('[TauriStdioTransport] Send error:', error);
      throw error;
    }
  }

  /**
   * Register message handler
   */
  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register error handler
   */
  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  /**
   * Register close handler
   */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Handle incoming message from process
   */
  private handleMessage(messageStr: string): void {
    try {
      const message = JSON.parse(messageStr);
      const id = (message as any).id;
      const method = (message as any).method;
      console.log(`[TauriStdioTransport] Parsed message: id=${id}, method=${method}, handlers=${this.messageHandlers.length}`);
      this.notifyMessage(message);
    } catch (error) {
      console.error('[TauriStdioTransport] Failed to parse message:', messageStr?.substring(0, 200), error);
      this.notifyError(new Error(`Failed to parse message: ${error}`));
    }
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    if (this.unlistenFn) {
      this.unlistenFn();
      this.unlistenFn = null;
    }
    this.sessionId = null;
    this.connected = false;
  }

  /**
   * Notify message handlers
   */
  private notifyMessage(message: unknown): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[TauriStdioTransport] Message handler error:', error);
      }
    }
  }

  /**
   * Notify error handlers
   */
  private notifyError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (err) {
        console.error('[TauriStdioTransport] Error handler error:', err);
      }
    }
  }

  /**
   * Notify close handlers
   */
  private notifyClose(): void {
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch (error) {
        console.error('[TauriStdioTransport] Close handler error:', error);
      }
    }
  }
}
