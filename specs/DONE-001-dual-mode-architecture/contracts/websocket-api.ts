/**
 * WebSocket API Contract
 *
 * Defines the protocol for remote control of PI via WebSocket.
 * Enables external applications and scripts to send tasks and receive events.
 *
 * @module contracts/websocket-api
 */

import type { Op, EventMsg } from '@/protocol/types';

// ─────────────────────────────────────────────────────────────────────────────
// Client → Server Messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authentication message (required for non-localhost connections)
 */
export interface AuthMessage {
  type: 'auth';
  /** API key for authentication */
  api_key: string;
}

/**
 * Submission message (send a task to the agent)
 */
export interface SubmissionMessage {
  type: 'submission';
  /** Optional session ID (creates new if not provided) */
  sessionId?: string;
  /** The operation to perform */
  op: Op;
}

/**
 * Ping message for keepalive
 */
export interface PingMessage {
  type: 'ping';
}

/**
 * All client message types
 */
export type ClientMessage = AuthMessage | SubmissionMessage | PingMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Server → Client Messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connection established message
 */
export interface ConnectedMessage {
  type: 'connected';
  /** Unique client ID for this connection */
  clientId: string;
  /** Server version */
  version: string;
  /** Whether authentication is required */
  authRequired: boolean;
}

/**
 * Authentication result message
 */
export interface AuthResultMessage {
  type: 'auth_result';
  /** Whether authentication succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Event message (agent events)
 */
export interface EventMessage {
  type: 'event';
  /** The agent event */
  event: EventMsg;
  /** Session ID this event belongs to */
  sessionId?: string;
}

/**
 * Error message
 */
export interface ErrorMessage {
  type: 'error';
  /** Error code */
  code: ErrorCode;
  /** Human-readable error message */
  message: string;
}

/**
 * Pong message (response to ping)
 */
export interface PongMessage {
  type: 'pong';
  /** Server timestamp */
  timestamp: number;
}

/**
 * All server message types
 */
export type ServerMessage =
  | ConnectedMessage
  | AuthResultMessage
  | EventMessage
  | ErrorMessage
  | PongMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebSocket API error codes
 */
export type ErrorCode =
  | 'AUTH_REQUIRED'        // Authentication required but not provided
  | 'AUTH_FAILED'          // Invalid API key
  | 'INVALID_MESSAGE'      // Malformed message
  | 'INVALID_OP'           // Invalid operation type
  | 'SESSION_NOT_FOUND'    // Referenced session doesn't exist
  | 'AGENT_BUSY'           // Agent is processing another task
  | 'RATE_LIMITED'         // Too many requests
  | 'INTERNAL_ERROR';      // Server error

/**
 * WebSocket close codes (standard + custom)
 */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  INVALID_DATA: 1003,
  // Custom codes (4000-4999)
  AUTH_TIMEOUT: 4001,      // Didn't authenticate in time
  AUTH_FAILED: 4002,       // Invalid credentials
  TOO_MANY_CLIENTS: 4003,  // Max connections reached
  INVALID_ORIGIN: 4004,    // Origin not allowed
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebSocket server configuration
 */
export interface WebSocketConfig {
  /** Port to listen on (default: 8765) */
  port: number;
  /** Host to bind to (default: 'localhost') */
  host: string;
  /** Maximum concurrent clients (default: 10) */
  maxClients: number;
  /** Authentication timeout in ms (default: 30000) */
  authTimeout: number;
  /** Ping interval in ms (default: 30000) */
  pingInterval: number;
  /** API key for non-localhost auth (generated if not set) */
  apiKey?: string;
}

/**
 * Default WebSocket configuration
 */
export const DEFAULT_WEBSOCKET_CONFIG: WebSocketConfig = {
  port: 8765,
  host: 'localhost',
  maxClients: 10,
  authTimeout: 30000,
  pingInterval: 30000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Client State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connected WebSocket client state
 */
export interface WebSocketClientState {
  /** Unique client ID */
  clientId: string;
  /** Remote address */
  remoteAddress: string;
  /** Whether client is authenticated */
  authenticated: boolean;
  /** Whether client is from localhost */
  isLocalhost: boolean;
  /** Connection timestamp */
  connectedAt: number;
  /** Last activity timestamp */
  lastActivityAt: number;
  /** Associated session ID (if any) */
  sessionId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if message is an auth message
 */
export function isAuthMessage(msg: unknown): msg is AuthMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as AuthMessage).type === 'auth' &&
    typeof (msg as AuthMessage).api_key === 'string'
  );
}

/**
 * Check if message is a submission message
 */
export function isSubmissionMessage(msg: unknown): msg is SubmissionMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as SubmissionMessage).type === 'submission' &&
    typeof (msg as SubmissionMessage).op === 'object'
  );
}

/**
 * Check if message is a ping message
 */
export function isPingMessage(msg: unknown): msg is PingMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as PingMessage).type === 'ping'
  );
}

/**
 * Parse and validate a client message
 */
export function parseClientMessage(data: string): ClientMessage | null {
  try {
    const msg = JSON.parse(data);
    if (isAuthMessage(msg) || isSubmissionMessage(msg) || isPingMessage(msg)) {
      return msg;
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Example Usage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @example Python client
 * ```python
 * import asyncio
 * import websockets
 * import json
 *
 * async def main():
 *     uri = "ws://localhost:8765"
 *     async with websockets.connect(uri) as ws:
 *         # Wait for connected message
 *         msg = json.loads(await ws.recv())
 *         print(f"Connected as {msg['clientId']}")
 *
 *         # Send a task
 *         await ws.send(json.dumps({
 *             "type": "submission",
 *             "op": {
 *                 "type": "UserTurn",
 *                 "items": [{"type": "text", "text": "Hello, PI!"}],
 *                 "tabId": 0,
 *                 "approval_policy": "auto",
 *                 "model": "gpt-4o"
 *             }
 *         }))
 *
 *         # Listen for events
 *         while True:
 *             msg = json.loads(await ws.recv())
 *             if msg["type"] == "event":
 *                 event = msg["event"]
 *                 if event["type"] == "AssistantTextDelta":
 *                     print(event["delta"], end="", flush=True)
 *                 elif event["type"] == "TaskComplete":
 *                     print("\nDone!")
 *                     break
 *
 * asyncio.run(main())
 * ```
 */
