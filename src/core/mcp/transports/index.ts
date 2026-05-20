/**
 * MCP Transport Factory
 *
 * Provides transport implementations for MCP communication.
 * SSE transport is used for browser extension and web-based MCP servers.
 * Stdio transport is handled at the adapter level via NodeMCPBridge (server
 * mode + desktop runtime sidecar), not through this factory.
 *
 * @module core/mcp/transports
 */

/**
 * MCP transport types
 */
export type MCPTransportType = 'sse' | 'stdio' | 'websocket';

/**
 * Base transport interface
 */
export interface MCPTransport {
  /** Connect to the MCP server */
  connect(): Promise<void>;

  /** Disconnect from the server */
  disconnect(): Promise<void>;

  /** Send a message */
  send(message: unknown): Promise<void>;

  /** Register message handler */
  onMessage(handler: (message: unknown) => void): void;

  /** Register error handler */
  onError(handler: (error: Error) => void): void;

  /** Register close handler */
  onClose(handler: () => void): void;

  /** Check if connected */
  isConnected(): boolean;
}

/**
 * Transport configuration
 */
export interface TransportConfig {
  /** Transport type */
  type: MCPTransportType;
  /** Server URL for SSE/WebSocket */
  url?: string;
  /** Connection timeout in milliseconds */
  timeout?: number;
}

/**
 * Create a transport based on configuration
 *
 * Note: stdio transport is handled at the adapter level (NodeMCPBridge in
 * server mode + desktop runtime sidecar) rather than through this factory.
 * Only SSE transport is created here.
 *
 * @param config - Transport configuration
 * @returns Transport instance
 */
export async function createTransport(config: TransportConfig): Promise<MCPTransport> {
  switch (config.type) {
    case 'sse':
      // SSE transport for extension/web mode
      const { SSETransport } = await import('./SSETransport');
      return new SSETransport(config.url!, {
        timeout: config.timeout,
      });

    case 'stdio':
      // Stdio transport is handled at the adapter level via NodeMCPBridge.
      // MCPManager creates a NodeMCPBridge instead of using this factory for stdio servers.
      throw new Error('stdio transport is handled by NodeMCPBridge, not the transport factory');

    case 'websocket':
      throw new Error('WebSocket transport not yet implemented');

    default:
      throw new Error(`Unknown transport type: ${config.type}`);
  }
}

/**
 * Get the default transport type for the current build mode
 */
export function getDefaultTransportType(): MCPTransportType {
  return __BUILD_MODE__ === 'desktop' ? 'stdio' : 'sse';
}

// Re-export transport implementations
export { SSETransport } from './SSETransport';
