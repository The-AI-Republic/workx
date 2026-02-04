/**
 * WebSocket Message Types
 *
 * Type definitions for the WebSocket remote control API.
 *
 * @module desktop/channels/websocket/types
 */

/**
 * Base message structure
 */
export interface WSMessage {
  /** Message type */
  type: string;
  /** Unique message ID */
  id?: string;
  /** Timestamp */
  timestamp?: number;
}

/**
 * Authentication message
 */
export interface WSAuthMessage extends WSMessage {
  type: 'auth';
  /** API key for authentication */
  apiKey: string;
}

/**
 * Authentication response
 */
export interface WSAuthResponse extends WSMessage {
  type: 'auth_response';
  /** Whether authentication succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Session ID if successful */
  sessionId?: string;
}

/**
 * User turn message (send prompt to agent)
 */
export interface WSUserTurn extends WSMessage {
  type: 'user_turn';
  /** User message content */
  content: string;
  /** Optional conversation ID */
  conversationId?: string;
  /** Attached images (base64) */
  images?: string[];
}

/**
 * Assistant turn start event
 */
export interface WSAssistantTurnStart extends WSMessage {
  type: 'assistant_turn_start';
  /** Turn ID */
  turnId: string;
  /** Conversation ID */
  conversationId: string;
}

/**
 * Assistant content chunk (streaming)
 */
export interface WSAssistantChunk extends WSMessage {
  type: 'assistant_chunk';
  /** Turn ID */
  turnId: string;
  /** Text content chunk */
  content: string;
}

/**
 * Tool use event
 */
export interface WSToolUse extends WSMessage {
  type: 'tool_use';
  /** Turn ID */
  turnId: string;
  /** Tool name */
  tool: string;
  /** Tool input */
  input: Record<string, unknown>;
  /** Tool use ID */
  toolUseId: string;
}

/**
 * Tool result event
 */
export interface WSToolResult extends WSMessage {
  type: 'tool_result';
  /** Turn ID */
  turnId: string;
  /** Tool use ID */
  toolUseId: string;
  /** Tool result */
  result: string | Record<string, unknown>;
  /** Whether tool execution succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Assistant turn complete event
 */
export interface WSAssistantTurnComplete extends WSMessage {
  type: 'assistant_turn_complete';
  /** Turn ID */
  turnId: string;
  /** Complete response text */
  content: string;
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Error event
 */
export interface WSError extends WSMessage {
  type: 'error';
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Related turn ID if applicable */
  turnId?: string;
}

/**
 * Ping message (keep-alive)
 */
export interface WSPing extends WSMessage {
  type: 'ping';
}

/**
 * Pong response
 */
export interface WSPong extends WSMessage {
  type: 'pong';
}

/**
 * Cancel current turn
 */
export interface WSCancel extends WSMessage {
  type: 'cancel';
  /** Turn ID to cancel */
  turnId?: string;
}

/**
 * Cancel acknowledgment
 */
export interface WSCancelAck extends WSMessage {
  type: 'cancel_ack';
  /** Turn ID that was cancelled */
  turnId: string;
  /** Whether cancellation succeeded */
  success: boolean;
}

/**
 * Status request
 */
export interface WSStatusRequest extends WSMessage {
  type: 'status_request';
}

/**
 * Status response
 */
export interface WSStatusResponse extends WSMessage {
  type: 'status_response';
  /** Connection status */
  status: 'idle' | 'processing' | 'error';
  /** Current turn ID if processing */
  currentTurnId?: string;
  /** Number of pending requests */
  pendingRequests: number;
  /** Uptime in seconds */
  uptimeSeconds: number;
}

/**
 * All message types union
 */
export type WSInboundMessage =
  | WSAuthMessage
  | WSUserTurn
  | WSPing
  | WSCancel
  | WSStatusRequest;

/**
 * All outbound message types union
 */
export type WSOutboundMessage =
  | WSAuthResponse
  | WSAssistantTurnStart
  | WSAssistantChunk
  | WSToolUse
  | WSToolResult
  | WSAssistantTurnComplete
  | WSError
  | WSPong
  | WSCancelAck
  | WSStatusResponse;

/**
 * Type guard for authentication message
 */
export function isAuthMessage(msg: WSMessage): msg is WSAuthMessage {
  return msg.type === 'auth';
}

/**
 * Type guard for user turn message
 */
export function isUserTurn(msg: WSMessage): msg is WSUserTurn {
  return msg.type === 'user_turn';
}

/**
 * Type guard for ping message
 */
export function isPing(msg: WSMessage): msg is WSPing {
  return msg.type === 'ping';
}

/**
 * Type guard for cancel message
 */
export function isCancel(msg: WSMessage): msg is WSCancel {
  return msg.type === 'cancel';
}

/**
 * Type guard for status request message
 */
export function isStatusRequest(msg: WSMessage): msg is WSStatusRequest {
  return msg.type === 'status_request';
}
