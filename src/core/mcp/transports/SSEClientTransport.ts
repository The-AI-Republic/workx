/**
 * SSE Client Transport for MCP
 *
 * Implements MCP transport protocol using:
 * - EventSource (SSE) for server→client messages
 * - fetch() POST for client→server messages
 *
 * Based on MCP "Streamable HTTP" transport specification.
 */

import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

/**
 * Configuration options for SSEClientTransport
 */
export interface SSEClientTransportOptions {
  /** Server URL endpoint */
  url: string;

  /** Optional API key for authentication */
  apiKey?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Custom headers to include in requests */
  headers?: Record<string, string>;
}

/**
 * SSE Client Transport implementation for browser context.
 *
 * Uses EventSource for receiving server messages (SSE stream)
 * and fetch() for sending client messages (POST requests).
 */
export class SSEClientTransport implements Transport {
  private eventSource: EventSource | null = null;
  private _sessionId: string | undefined = undefined;
  private messageEndpoint: string;
  private sseEndpoint: string;
  private closed: boolean = false;

  // Transport callbacks (required by Transport interface)
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  // Session ID property (required by Transport interface)
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  // Protocol version setter (optional, called when initialize response is received)
  setProtocolVersion?: (version: string) => void;

  constructor(private readonly options: SSEClientTransportOptions) {
    // Parse URL and construct endpoints
    const baseUrl = options.url.replace(/\/$/, '');
    this.messageEndpoint = `${baseUrl}/message`;
    this.sseEndpoint = `${baseUrl}/sse`;
  }

  /**
   * Start the transport connection.
   * Opens an EventSource connection for receiving server messages.
   */
  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('Transport has been closed');
    }

    return new Promise((resolve, reject) => {
      try {
        // Build SSE URL with optional API key
        let sseUrl = this.sseEndpoint;
        if (this.options.apiKey) {
          sseUrl += `?apiKey=${encodeURIComponent(this.options.apiKey)}`;
        }

        this.eventSource = new EventSource(sseUrl);

        // Handle SSE connection open
        this.eventSource.onopen = () => {
          console.debug('[SSEClientTransport] SSE connection opened');
          resolve();
        };

        // Handle incoming messages
        this.eventSource.onmessage = (event: MessageEvent) => {
          this.handleMessage(event.data);
        };

        // Handle named events (MCP uses 'message' and 'endpoint' events)
        this.eventSource.addEventListener('message', (event: MessageEvent) => {
          this.handleMessage(event.data);
        });

        this.eventSource.addEventListener('endpoint', (event: MessageEvent) => {
          // Server may send endpoint URL for message posting
          try {
            const data = JSON.parse(event.data);
            if (data.endpoint) {
              this.messageEndpoint = data.endpoint;
            }
            if (data.sessionId) {
              this._sessionId = data.sessionId;
            }
          } catch {
            // Ignore parse errors for endpoint event
          }
        });

        // Handle SSE errors
        this.eventSource.onerror = (event: Event) => {
          const error = new Error('SSE connection error');

          // Check if this is a connection failure during startup
          if (this.eventSource?.readyState === EventSource.CLOSED) {
            reject(error);
            return;
          }

          // Runtime error - notify via callback
          console.error('[SSEClientTransport] SSE error:', event);
          this.onerror?.(error);
        };

        // Set timeout for initial connection
        const timeout = this.options.timeout ?? 30000;
        setTimeout(() => {
          if (this.eventSource?.readyState === EventSource.CONNECTING) {
            this.eventSource.close();
            reject(new Error(`SSE connection timeout after ${timeout}ms`));
          }
        }, timeout);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Send a JSON-RPC message to the server.
   */
  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) {
      throw new Error('Transport has been closed');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...this.options.headers,
    };

    // Add API key if provided
    if (this.options.apiKey) {
      headers['Authorization'] = `Bearer ${this.options.apiKey}`;
    }

    // Add session ID if established
    if (this._sessionId) {
      headers['Mcp-Session-Id'] = this._sessionId;
    }

    const timeout = this.options.timeout ?? 30000;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(this.messageEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // Extract session ID from response headers if present
      const newSessionId = response.headers.get('Mcp-Session-Id');
      if (newSessionId) {
        this._sessionId = newSessionId;
      }

      // Handle response body (may contain response message)
      const contentType = response.headers.get('Content-Type');
      if (contentType?.includes('application/json')) {
        const responseText = await response.text();
        if (responseText) {
          this.handleMessage(responseText);
        }
      }

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Close the transport connection.
   */
  async close(): Promise<void> {
    this.closed = true;

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this._sessionId = undefined;
    this.onclose?.();

    console.debug('[SSEClientTransport] Transport closed');
  }

  /**
   * Handle incoming message data.
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as JSONRPCMessage;
      this.onmessage?.(message);
    } catch (error) {
      console.error('[SSEClientTransport] Failed to parse message:', error, data);
      this.onerror?.(new Error(`Invalid JSON message: ${error}`));
    }
  }

  /**
   * Get the current session ID (if established).
   */
  getSessionId(): string | undefined {
    return this._sessionId;
  }

  /**
   * Check if the transport is connected.
   */
  isConnected(): boolean {
    return !this.closed && this.eventSource?.readyState === EventSource.OPEN;
  }
}
