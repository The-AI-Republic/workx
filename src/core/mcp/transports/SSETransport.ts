/**
 * SSE Transport
 *
 * Server-Sent Events transport for MCP communication.
 * Used in extension mode for web-based MCP servers.
 *
 * @module core/mcp/transports/SSETransport
 */

import type { MCPTransport } from './index';

/**
 * SSE transport options
 */
export interface SSETransportOptions {
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Retry interval for reconnection */
  retryInterval?: number;
  /** Maximum retries */
  maxRetries?: number;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: SSETransportOptions = {
  timeout: 30000,
  retryInterval: 1000,
  maxRetries: 3,
};

/**
 * SSETransport implements MCPTransport using Server-Sent Events
 *
 * @example
 * ```typescript
 * const transport = new SSETransport('https://mcp-server.example.com/sse');
 * await transport.connect();
 *
 * transport.onMessage((msg) => console.log('Received:', msg));
 * await transport.send({ method: 'initialize', params: {} });
 * ```
 */
export class SSETransport implements MCPTransport {
  private url: string;
  private options: SSETransportOptions;
  private eventSource: EventSource | null = null;
  private messageHandlers: Array<(message: unknown) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private connected = false;
  private messageEndpoint: string;

  constructor(url: string, options?: SSETransportOptions) {
    this.url = url;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Derive message endpoint from SSE URL
    const urlObj = new URL(url);
    urlObj.pathname = urlObj.pathname.replace('/sse', '/message');
    this.messageEndpoint = urlObj.toString();
  }

  /**
   * Connect to the SSE server
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.eventSource) {
          this.eventSource.close();
        }
        reject(new Error('Connection timeout'));
      }, this.options.timeout);

      this.eventSource = new EventSource(this.url);

      this.eventSource.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        console.log('[SSETransport] Connected');
        resolve();
      };

      this.eventSource.onerror = (event) => {
        clearTimeout(timeout);
        const error = new Error('SSE connection error');

        if (!this.connected) {
          reject(error);
        } else {
          this.notifyError(error);
        }
      };

      this.eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.notifyMessage(message);
        } catch (error) {
          console.error('[SSETransport] Failed to parse message:', error);
        }
      };
    });
  }

  /**
   * Disconnect from the server
   */
  async disconnect(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connected = false;
    this.notifyClose();
    console.log('[SSETransport] Disconnected');
  }

  /**
   * Send a message to the server
   */
  async send(message: unknown): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const response = await fetch(this.messageEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.status} ${response.statusText}`);
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
   * Notify message handlers
   */
  private notifyMessage(message: unknown): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[SSETransport] Message handler error:', error);
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
        console.error('[SSETransport] Error handler error:', err);
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
        console.error('[SSETransport] Close handler error:', error);
      }
    }
  }
}
