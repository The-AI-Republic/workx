/**
 * WebSocket Handshake
 *
 * Implements the connect flow:
 *   1. Server sends `connect.challenge` event with nonce
 *   2. Client sends `connect` request with auth + client info
 *   3. Server validates, sends `connect.hello-ok` response or closes
 *
 * @module server/connection/handshake
 */

import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, ConnectRequestSchema, makeResponse, makeErrorResponse, makeEvent } from '../protocol/frames';
import type { ChallengePayload, HelloOkPayload, ConnectRequest } from '../protocol/frames';
import { WS_CLOSE, unauthorized, invalidRequest } from '../protocol/errors';
import { verifyAuth } from './auth';
import { resolveScopes, isValidRole, type Role } from '../auth/roles';
import { setConnectionAuth } from '../auth/authorize';
import { getServerConfig } from '../config/server-config';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface HandshakeResult {
  connectionId: string;
  role: Role;
  scopes: string[];
  userId?: string;
  clientId: string;
  sessionKey?: string;
}

export interface WsHandle {
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
  isLoopback: boolean;
  headers: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────
// Pending handshake tracking
// ─────────────────────────────────────────────────────────────────────────

interface PendingHandshake {
  nonce: string;
  timer: ReturnType<typeof setTimeout>;
  ws: WsHandle;
}

const _pending = new Map<WsHandle, PendingHandshake>();

// ─────────────────────────────────────────────────────────────────────────
// Handshake initiation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Start the handshake by sending a challenge to the client.
 * Returns a promise that resolves when the handshake completes (or rejects on timeout).
 */
export function sendChallenge(ws: WsHandle): void {
  const config = getServerConfig();
  const nonce = randomUUID();

  const challenge: ChallengePayload = {
    nonce,
    protocolVersion: PROTOCOL_VERSION,
    serverVersion: '1.0.0',
    authModes: [config.server.auth.mode],
  };

  const frame = makeEvent('connect.challenge', challenge);
  ws.send(JSON.stringify(frame));

  // Set handshake timeout
  const timer = setTimeout(() => {
    _pending.delete(ws);
    ws.close(WS_CLOSE.POLICY_VIOLATION, 'Handshake timeout');
  }, config.server.limits.handshakeTimeoutMs);

  _pending.set(ws, { nonce, timer, ws });
}

// ─────────────────────────────────────────────────────────────────────────
// Handshake completion
// ─────────────────────────────────────────────────────────────────────────

/**
 * Process a `connect` request from the client.
 *
 * @returns HandshakeResult on success, null on failure (ws already closed or error sent)
 */
export function handleConnectRequest(
  ws: WsHandle,
  rawFrame: unknown
): HandshakeResult | null {
  const pending = _pending.get(ws);
  if (!pending) {
    // No pending handshake — unexpected connect
    const reqId = (rawFrame as { id?: string })?.id ?? randomUUID();
    ws.send(JSON.stringify(makeErrorResponse(reqId, invalidRequest('No pending handshake'))));
    return null;
  }

  // Clear timeout
  clearTimeout(pending.timer);
  _pending.delete(ws);

  // Validate frame structure
  const parseResult = ConnectRequestSchema.safeParse(rawFrame);
  if (!parseResult.success) {
    const reqId = (rawFrame as { id?: string })?.id ?? randomUUID();
    ws.send(
      JSON.stringify(
        makeErrorResponse(reqId, invalidRequest('Invalid connect request', parseResult.error.issues))
      )
    );
    return null;
  }

  const req: ConnectRequest = parseResult.data;

  // Validate protocol version
  if (req.params.protocolVersion !== PROTOCOL_VERSION) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(req.id, invalidRequest(`Protocol version mismatch. Expected ${PROTOCOL_VERSION}`))
      )
    );
    ws.close(WS_CLOSE.PROTOCOL_MISMATCH, 'Protocol version mismatch');
    return null;
  }

  // Validate role
  if (!isValidRole(req.params.clientMode)) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(req.id, invalidRequest(`Invalid client mode: ${req.params.clientMode}`))
      )
    );
    return null;
  }

  // Authenticate
  const authResult = verifyAuth(req.params.auth, ws.headers, ws.isLoopback);
  if (!authResult.authenticated) {
    ws.send(JSON.stringify(makeErrorResponse(req.id, authResult.error ?? unauthorized('Authentication failed'))));
    return null;
  }

  // Resolve scopes
  const role = req.params.clientMode as Role;
  const scopes = resolveScopes(role, req.params.scopes);

  // Generate connection ID
  const connectionId = `conn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  // Register connection auth
  setConnectionAuth({
    connectionId,
    role,
    scopes,
    userId: authResult.userId,
    authenticated: true,
  });

  // Build session key
  const sessionKey = req.params.resume?.sessionKey ??
    `ws:main:${connectionId}`;

  // Send hello-ok response
  const helloOk: HelloOkPayload = {
    connectionId,
    role,
    scopes,
    sessionKey,
  };

  ws.send(JSON.stringify(makeResponse(req.id, helloOk)));

  return {
    connectionId,
    role,
    scopes,
    userId: authResult.userId,
    clientId: req.params.clientId,
    sessionKey,
  };
}

/**
 * Cancel a pending handshake (e.g., on disconnect before completing).
 */
export function cancelHandshake(ws: WsHandle): void {
  const pending = _pending.get(ws);
  if (pending) {
    clearTimeout(pending.timer);
    _pending.delete(ws);
  }
}
