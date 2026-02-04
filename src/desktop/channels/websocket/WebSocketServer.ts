/**
 * WebSocket Server
 *
 * Manages WebSocket connections for the remote control API.
 * Handles authentication, message routing, and connection lifecycle.
 *
 * @module desktop/channels/websocket/WebSocketServer
 */

import { invoke } from '@tauri-apps/api/tauri';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  WSMessage,
  WSInboundMessage,
  WSOutboundMessage,
  WSAuthMessage,
  WSAuthResponse,
  WSError,
  WSPong,
  WSStatusResponse,
} from './types';
import { isAuthMessage, isPing, isUserTurn, isCancel, isStatusRequest } from './types';

/**
 * Server configuration
 */
export interface WebSocketServerConfig {
  /** Port to listen on */
  port?: number;
  /** Host to bind to */
  host?: string;
  /** API key for authentication (null = localhost only, no auth) */
  apiKey?: string | null;
  /** Require authentication for all connections */
  requireAuth?: boolean;
  /** Max connections */
  maxConnections?: number;
  /** Connection timeout in milliseconds */
  connectionTimeout?: number;
  /** Ping interval in milliseconds */
  pingInterval?: number;
}

/**
 * Connected client info
 */
export interface ConnectedClient {
  /** Client ID */
  id: string;
  /** Remote address */
  address: string;
  /** Is localhost connection */
  isLocalhost: boolean;
  /** Is authenticated */
  authenticated: boolean;
  /** Session ID if authenticated */
  sessionId?: string;
  /** Connection timestamp */
  connectedAt: number;
  /** Last activity timestamp */
  lastActivity: number;
}

/**
 * Message handler type
 */
export type MessageHandler = (
  clientId: string,
  message: WSInboundMessage
) => Promise<void>;

/**
 * Default server configuration
 */
const DEFAULT_CONFIG: WebSocketServerConfig = {
  port: 8765,
  host: '127.0.0.1',
  apiKey: null,
  requireAuth: false,
  maxConnections: 10,
  connectionTimeout: 60000,
  pingInterval: 30000,
};

/**
 * WebSocketServer manages the WebSocket remote control API
 *
 * @example
 * ```typescript
 * const server = new WebSocketServer();
 *
 * server.onMessage(async (clientId, message) => {
 *   if (message.type === 'user_turn') {
 *     // Handle user turn
 *     await server.send(clientId, {
 *       type: 'assistant_turn_start',
 *       turnId: 'turn-123',
 *       conversationId: 'conv-456',
 *     });
 *   }
 * });
 *
 * await server.start();
 * ```
 */
export class WebSocketServer {
  private config: WebSocketServerConfig;
  private clients = new Map<string, ConnectedClient>();
  private messageHandlers: MessageHandler[] = [];
  private running = false;
  private startTime = 0;
  private unlistenFunctions: UnlistenFn[] = [];

  constructor(config?: Partial<WebSocketServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    console.log(
      `[WebSocketServer] Starting on ${this.config.host}:${this.config.port}`
    );

    try {
      // Start server via Tauri command
      await invoke('ws_server_start', {
        port: this.config.port,
        host: this.config.host,
        maxConnections: this.config.maxConnections,
      });

      // Listen for events from Rust
      const unlistenConnect = await listen<{ clientId: string; address: string }>(
        'ws_client_connected',
        (event) => this.handleClientConnected(event.payload)
      );
      this.unlistenFunctions.push(unlistenConnect);

      const unlistenDisconnect = await listen<{ clientId: string }>(
        'ws_client_disconnected',
        (event) => this.handleClientDisconnected(event.payload.clientId)
      );
      this.unlistenFunctions.push(unlistenDisconnect);

      const unlistenMessage = await listen<{ clientId: string; message: string }>(
        'ws_message',
        (event) => this.handleIncomingMessage(event.payload)
      );
      this.unlistenFunctions.push(unlistenMessage);

      this.running = true;
      this.startTime = Date.now();

      console.log('[WebSocketServer] Started');
    } catch (error) {
      console.error('[WebSocketServer] Failed to start:', error);
      throw error;
    }
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    console.log('[WebSocketServer] Stopping...');

    // Remove event listeners
    for (const unlisten of this.unlistenFunctions) {
      unlisten();
    }
    this.unlistenFunctions = [];

    // Stop server via Tauri command
    try {
      await invoke('ws_server_stop');
    } catch (error) {
      console.warn('[WebSocketServer] Error stopping:', error);
    }

    this.clients.clear();
    this.running = false;

    console.log('[WebSocketServer] Stopped');
  }

  /**
   * Send a message to a client
   */
  async send(clientId: string, message: WSOutboundMessage): Promise<void> {
    if (!this.running) {
      throw new Error('Server not running');
    }

    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client not found: ${clientId}`);
    }

    await invoke('ws_send', {
      clientId,
      message: JSON.stringify({
        ...message,
        timestamp: Date.now(),
      }),
    });
  }

  /**
   * Broadcast a message to all authenticated clients
   */
  async broadcast(message: WSOutboundMessage): Promise<void> {
    const authenticatedClients = Array.from(this.clients.values()).filter(
      (client) => client.authenticated || (client.isLocalhost && !this.config.requireAuth)
    );

    for (const client of authenticatedClients) {
      try {
        await this.send(client.id, message);
      } catch (error) {
        console.warn(`[WebSocketServer] Failed to send to ${client.id}:`, error);
      }
    }
  }

  /**
   * Register a message handler
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Remove a message handler
   */
  offMessage(handler: MessageHandler): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index !== -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  /**
   * Get connected clients
   */
  getClients(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get client by ID
   */
  getClient(clientId: string): ConnectedClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Disconnect a client
   */
  async disconnect(clientId: string): Promise<void> {
    await invoke('ws_disconnect', { clientId });
    this.clients.delete(clientId);
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get server uptime in seconds
   */
  getUptime(): number {
    if (!this.running) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Handle client connected event
   */
  private handleClientConnected(payload: { clientId: string; address: string }): void {
    const { clientId, address } = payload;
    const isLocalhost = this.isLocalhostAddress(address);

    const client: ConnectedClient = {
      id: clientId,
      address,
      isLocalhost,
      authenticated: isLocalhost && !this.config.requireAuth,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.clients.set(clientId, client);
    console.log(`[WebSocketServer] Client connected: ${clientId} (${address})`);
  }

  /**
   * Handle client disconnected event
   */
  private handleClientDisconnected(clientId: string): void {
    this.clients.delete(clientId);
    console.log(`[WebSocketServer] Client disconnected: ${clientId}`);
  }

  /**
   * Handle incoming message from client
   */
  private async handleIncomingMessage(payload: {
    clientId: string;
    message: string;
  }): Promise<void> {
    const { clientId, message: messageStr } = payload;
    const client = this.clients.get(clientId);

    if (!client) {
      console.warn(`[WebSocketServer] Message from unknown client: ${clientId}`);
      return;
    }

    client.lastActivity = Date.now();

    let message: WSMessage;
    try {
      message = JSON.parse(messageStr);
    } catch (error) {
      await this.sendError(clientId, 'PARSE_ERROR', 'Invalid JSON message');
      return;
    }

    // Handle authentication
    if (isAuthMessage(message)) {
      await this.handleAuth(clientId, message);
      return;
    }

    // Handle ping
    if (isPing(message)) {
      await this.send(clientId, { type: 'pong', id: message.id } as WSPong);
      return;
    }

    // Check authentication for other messages
    if (!client.authenticated && !client.isLocalhost) {
      await this.sendError(clientId, 'UNAUTHORIZED', 'Authentication required');
      return;
    }

    // Handle status request
    if (isStatusRequest(message)) {
      await this.handleStatusRequest(clientId, message.id);
      return;
    }

    // Dispatch to message handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(clientId, message as WSInboundMessage);
      } catch (error) {
        console.error('[WebSocketServer] Message handler error:', error);
        await this.sendError(
          clientId,
          'HANDLER_ERROR',
          `Error processing message: ${error}`
        );
      }
    }
  }

  /**
   * Handle authentication message
   */
  private async handleAuth(clientId: string, message: WSAuthMessage): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    // If no API key configured, localhost connections are automatically authenticated
    if (!this.config.apiKey && client.isLocalhost) {
      client.authenticated = true;
      client.sessionId = `session-${Date.now()}`;

      await this.send(clientId, {
        type: 'auth_response',
        id: message.id,
        success: true,
        sessionId: client.sessionId,
      } as WSAuthResponse);
      return;
    }

    // Validate API key
    if (message.apiKey === this.config.apiKey) {
      client.authenticated = true;
      client.sessionId = `session-${Date.now()}`;

      await this.send(clientId, {
        type: 'auth_response',
        id: message.id,
        success: true,
        sessionId: client.sessionId,
      } as WSAuthResponse);
    } else {
      await this.send(clientId, {
        type: 'auth_response',
        id: message.id,
        success: false,
        error: 'Invalid API key',
      } as WSAuthResponse);
    }
  }

  /**
   * Handle status request
   */
  private async handleStatusRequest(clientId: string, messageId?: string): Promise<void> {
    const response: WSStatusResponse = {
      type: 'status_response',
      id: messageId,
      status: 'idle',
      pendingRequests: 0,
      uptimeSeconds: this.getUptime(),
    };

    await this.send(clientId, response);
  }

  /**
   * Send error message to client
   */
  private async sendError(
    clientId: string,
    code: string,
    message: string
  ): Promise<void> {
    await this.send(clientId, {
      type: 'error',
      code,
      message,
    } as WSError);
  }

  /**
   * Check if an address is localhost
   */
  private isLocalhostAddress(address: string): boolean {
    return (
      address === '127.0.0.1' ||
      address === '::1' ||
      address === 'localhost' ||
      address.startsWith('127.') ||
      address === '::ffff:127.0.0.1'
    );
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<WebSocketServerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): WebSocketServerConfig {
    return { ...this.config };
  }
}
