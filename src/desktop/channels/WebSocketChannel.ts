/**
 * WebSocket Channel Adapter
 *
 * Desktop-mode channel adapter that bridges WebSocket connections
 * to the ChannelAdapter interface.
 *
 * @module desktop/channels/WebSocketChannel
 */

import type {
  ChannelAdapter,
  ChannelType,
  ConnectionState,
  SubmissionContext,
} from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';

/** WebSocket-specific submission handler (receives context only) */
type WSSubmissionHandler = (context: SubmissionContext) => Promise<void>;
import {
  WebSocketServer,
  type WebSocketServerConfig,
  type ConnectedClient,
} from './websocket/WebSocketServer';
import type {
  WSUserTurn,
  WSAssistantTurnStart,
  WSAssistantChunk,
  WSAssistantTurnComplete,
  WSToolUse,
  WSToolResult,
  WSError,
  WSOutboundMessage,
} from './websocket/types';
import { isUserTurn, isCancel } from './websocket/types';

/**
 * WebSocketChannel implements ChannelAdapter for WebSocket connections
 *
 * @example
 * ```typescript
 * const channel = new WebSocketChannel({ port: 8765 });
 * await channel.initialize();
 *
 * channel.onSubmission(async (ctx) => {
 *   console.log('Received submission from:', ctx.clientId);
 *   // Process and send response via sendEvent
 * });
 * ```
 */
export class WebSocketChannel implements ChannelAdapter {
  readonly channelId = 'websocket-api';
  readonly channelType: ChannelType = 'websocket';

  private server: WebSocketServer;
  private submissionHandlers: WSSubmissionHandler[] = [];
  private connectionState: ConnectionState = 'disconnected';
  private initialized = false;
  private currentTurns = new Map<string, { clientId: string; turnId: string }>();

  constructor(config?: Partial<WebSocketServerConfig>) {
    this.server = new WebSocketServer(config);
  }

  /**
   * Initialize the WebSocket channel
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('[WebSocketChannel] Initializing...');
    this.connectionState = 'connecting';

    try {
      // Register message handler
      this.server.onMessage(async (clientId, message) => {
        await this.handleMessage(clientId, message);
      });

      // Start the server
      await this.server.start();

      this.connectionState = 'connected';
      this.initialized = true;

      console.log('[WebSocketChannel] Initialized');
    } catch (error) {
      this.connectionState = 'error';
      console.error('[WebSocketChannel] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Register a submission handler
   */
  onSubmission(handler: WSSubmissionHandler): void {
    this.submissionHandlers.push(handler);
  }

  /**
   * Send an event to a specific client or broadcast
   */
  async sendEvent(event: EventMsg, targetClientId?: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('WebSocketChannel not initialized');
    }

    // Convert event to WebSocket message format
    const wsMessage = this.eventToWSMessage(event);
    if (!wsMessage) {
      return;
    }

    if (targetClientId) {
      await this.server.send(targetClientId, wsMessage);
    } else {
      await this.server.broadcast(wsMessage);
    }
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Close the channel
   */
  async close(): Promise<void> {
    console.log('[WebSocketChannel] Closing...');

    await this.server.stop();

    this.submissionHandlers = [];
    this.currentTurns.clear();
    this.connectionState = 'disconnected';
    this.initialized = false;

    console.log('[WebSocketChannel] Closed');
  }

  /**
   * Get connected clients
   */
  getClients(): ConnectedClient[] {
    return this.server.getClients();
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleMessage(
    clientId: string,
    message: Record<string, unknown> | { type: string }
  ): Promise<void> {
    if (isUserTurn(message as { type: string })) {
      const userTurn = message as unknown as WSUserTurn;
      await this.handleUserTurn(clientId, userTurn);
    } else if (isCancel(message as { type: string })) {
      await this.handleCancel(clientId, (message as { turnId?: string }).turnId);
    }
  }

  /**
   * Handle user turn message
   */
  private async handleUserTurn(
    clientId: string,
    message: WSUserTurn
  ): Promise<void> {
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conversationId = message.conversationId || `conv-${clientId}`;

    // Track the turn
    this.currentTurns.set(turnId, { clientId, turnId });

    // Create submission context
    const context = {
      channelId: this.channelId,
      channelType: this.channelType,
      clientId,
      payload: {
        type: 'user_turn',
        content: message.content,
        images: message.images,
        conversationId,
        turnId,
      },
      timestamp: Date.now(),
    } as unknown as SubmissionContext;

    // Send turn start event
    await this.server.send(clientId, {
      type: 'assistant_turn_start',
      turnId,
      conversationId,
      timestamp: Date.now(),
    } as WSAssistantTurnStart);

    // Dispatch to handlers
    for (const handler of this.submissionHandlers) {
      try {
        await handler(context);
      } catch (error) {
        console.error('[WebSocketChannel] Handler error:', error);

        // Send error to client
        await this.server.send(clientId, {
          type: 'error',
          code: 'HANDLER_ERROR',
          message: `Error processing request: ${error}`,
          turnId,
          timestamp: Date.now(),
        } as WSError);
      }
    }
  }

  /**
   * Handle cancel message
   */
  private async handleCancel(
    clientId: string,
    turnId?: string
  ): Promise<void> {
    // Find turn to cancel
    let turnToCancel: string | undefined = turnId;

    if (!turnToCancel) {
      // Cancel the most recent turn for this client
      for (const [tid, info] of this.currentTurns) {
        if (info.clientId === clientId) {
          turnToCancel = tid;
          break;
        }
      }
    }

    if (turnToCancel) {
      this.currentTurns.delete(turnToCancel);

      await this.server.send(clientId, {
        type: 'cancel_ack',
        turnId: turnToCancel,
        success: true,
        timestamp: Date.now(),
      } as WSOutboundMessage);
    }
  }

  /**
   * Get the turnId for the most recently active turn, if any.
   */
  private getActiveTurnId(): string {
    // Return the most recently tracked turn
    for (const info of this.currentTurns.values()) {
      return info.turnId;
    }
    return '';
  }

  /**
   * Convert internal EventMsg to WebSocket outbound message.
   *
   * Maps from the core protocol EventMsg discriminated union to the
   * WebSocket-specific message types. Only a subset of EventMsg types
   * are relevant for WebSocket clients; the rest return null.
   */
  private eventToWSMessage(
    event: EventMsg
  ): WSOutboundMessage | null {
    const timestamp = Date.now();
    const turnId = this.getActiveTurnId();

    switch (event.type) {
      case 'AgentMessageDelta':
        return {
          type: 'assistant_chunk',
          turnId,
          content: event.data.delta,
          timestamp,
        } as WSAssistantChunk;

      case 'ToolExecutionStart':
        return {
          type: 'tool_use',
          turnId,
          tool: event.data.tool_name,
          input: {},
          toolUseId: `tool-${event.data.start_time || Date.now()}`,
          timestamp,
        } as WSToolUse;

      case 'ToolExecutionEnd':
        return {
          type: 'tool_result',
          turnId,
          toolUseId: `tool-${timestamp}`,
          result: event.data.success ? 'success' : 'failed',
          success: event.data.success,
          timestamp,
        } as WSToolResult;

      case 'TaskComplete':
        return {
          type: 'assistant_turn_complete',
          turnId,
          content: event.data.last_agent_message || '',
          timestamp,
        } as WSAssistantTurnComplete;

      case 'Error':
        return {
          type: 'error',
          code: event.data.code || 'ERROR',
          message: event.data.message,
          turnId,
          timestamp,
        } as WSError;

      default:
        // Most EventMsg types (reasoning, approval, etc.) don't need WS forwarding
        return null;
    }
  }

  /**
   * Get the underlying WebSocket server
   */
  getServer(): WebSocketServer {
    return this.server;
  }

  /**
   * Update server configuration
   */
  updateConfig(config: Partial<WebSocketServerConfig>): void {
    this.server.updateConfig(config);
  }
}
