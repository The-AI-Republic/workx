/**
 * Tauri Stdio SDK Transport Adapter
 *
 * Bridges the internal TauriStdioTransport (MCPTransport interface) to the
 * MCP SDK's Transport interface, allowing the SDK Client to communicate
 * over Tauri's stdio-based process spawning.
 *
 * @module core/mcp/transports/TauriStdioSDKTransport
 */

import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { TauriStdioTransport, type TauriStdioTransportOptions } from './TauriStdioTransport';

/**
 * TauriStdioSDKTransport adapts TauriStdioTransport to the MCP SDK Transport interface.
 *
 * This allows the MCP SDK Client to use Tauri's process spawning for stdio-based
 * MCP servers (like chrome-devtools-mcp).
 *
 * ```
 * MCP SDK Client.connect(transport)
 *         ↓
 * TauriStdioSDKTransport (implements SDK Transport)
 *         ↓
 * TauriStdioTransport (Tauri IPC: mcp_spawn/mcp_send/mcp_close)
 *         ↓
 * Rust mcp_commands.rs (spawns chrome-devtools-mcp subprocess)
 * ```
 */
export class TauriStdioSDKTransport implements Transport {
  private inner: TauriStdioTransport;
  private closed = false;

  // SDK Transport callbacks
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  constructor(options: TauriStdioTransportOptions) {
    this.inner = new TauriStdioTransport(options);
  }

  /**
   * Start the transport: connect the inner TauriStdioTransport and wire callbacks.
   */
  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('Transport has been closed');
    }

    console.log('[TauriStdioSDKTransport] Starting transport...');

    // Wire inner transport callbacks to SDK callbacks
    this.inner.onMessage((message: unknown) => {
      const msg = message as JSONRPCMessage;
      const method = (msg as any).method || (msg as any).id ? `id=${(msg as any).id}` : 'unknown';
      console.log(`[TauriStdioSDKTransport] ← Received message (${method})`);
      this.onmessage?.(msg);
    });

    this.inner.onError((error: Error) => {
      console.error('[TauriStdioSDKTransport] Transport error:', error.message);
      this.onerror?.(error);
    });

    this.inner.onClose(() => {
      console.warn('[TauriStdioSDKTransport] Transport closed');
      this.onclose?.();
    });

    // Spawn the MCP server process
    await this.inner.connect();

    this.sessionId = this.inner.getSessionId() ?? undefined;
    console.log(`[TauriStdioSDKTransport] Started successfully (sessionId: ${this.sessionId})`);
  }

  /**
   * Send a JSON-RPC message via the inner transport.
   */
  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) {
      throw new Error('Transport has been closed');
    }

    const method = (message as any).method || `id=${(message as any).id}`;
    console.log(`[TauriStdioSDKTransport] → Sending message (${method})`);

    await this.inner.send(message);
  }

  /**
   * Close the transport and terminate the MCP server process.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    await this.inner.disconnect();
    this.onclose?.();
  }
}
