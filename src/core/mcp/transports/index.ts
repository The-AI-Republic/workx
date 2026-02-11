/**
 * MCP Transport Factory
 *
 * Provides transport implementations for MCP communication.
 * Supports SSE (extension/web) and stdio (desktop) transports.
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
  /** Command for stdio transport */
  command?: string;
  /** Arguments for stdio transport */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Connection timeout in milliseconds */
  timeout?: number;
}

/**
 * Create a transport based on configuration
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
      // Stdio transport for desktop mode (uses Tauri)
      if (__BUILD_MODE__ !== 'desktop') {
        throw new Error('stdio transport is only available in desktop mode');
      }
      const { TauriStdioTransport } = await import('./TauriStdioTransport');
      return new TauriStdioTransport({
        command: config.command!,
        args: config.args || [],
        env: config.env,
        cwd: config.cwd,
      });

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
// Note: TauriStdioSDKTransport is not re-exported here to avoid pulling in
// Tauri dependencies during non-desktop builds. Import directly from
// './TauriStdioSDKTransport' when needed in desktop code.
