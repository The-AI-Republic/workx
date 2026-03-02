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
import {
  PROTOCOL_VERSION,
  ConnectRequestSchema,
  makeResponse,
  makeErrorResponse,
  makeEvent,
  resolveClientInfo,
  negotiateProtocolVersion,
} from '../protocol/frames';
import type { ChallengePayload, HelloOkPayload, ConnectRequest, ResolvedClientInfo } from '../protocol/frames';
import { WS_CLOSE, unauthorized, invalidRequest } from '../protocol/errors';
import { verifyAuth } from './auth';
import { resolveScopes, isValidRole, type Role } from '../auth/roles';
import { setConnectionAuth } from '../auth/authorize';
import { getServerConfig } from '../config/server-config';
import { getRegisteredMethods } from '../protocol/methods';
import { EVENT_SCOPE_MAP, BROADCAST_EVENTS } from '../protocol/methods';
import { getHealthStatus } from '../handlers/health';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface HandshakeResult {
  connectionId: string;
  role: Role;
  scopes: string[];
  userId?: string;
  clientId: string;
  clientInfo: ResolvedClientInfo;
  sessionKey?: string;
}

export interface WsHandle {
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
  isLoopback: boolean;
  headers: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────
// Snapshot providers (injected by bootstrap)
// ─────────────────────────────────────────────────────────────────────────

export interface HandshakeSnapshotProviders {
  getSessionSummaries: () => Promise<unknown[]>;
}

let _snapshotProviders: HandshakeSnapshotProviders | null = null;

export function setHandshakeSnapshotProviders(providers: HandshakeSnapshotProviders): void {
  _snapshotProviders = providers;
}

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const SERVER_VERSION = '1.0.0';
const TICK_INTERVAL_MS = 30_000;

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
 */
export function sendChallenge(ws: WsHandle): void {
  const config = getServerConfig();
  const nonce = randomUUID();

  const challenge: ChallengePayload = {
    nonce,
    protocolVersion: PROTOCOL_VERSION,
    serverVersion: SERVER_VERSION,
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
export async function handleConnectRequest(
  ws: WsHandle,
  rawFrame: unknown
): Promise<HandshakeResult | null> {
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

  // Negotiate protocol version (supports range or single)
  const negotiatedVersion = negotiateProtocolVersion(req.params);
  if (negotiatedVersion === null) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(req.id, invalidRequest(
          `Protocol version mismatch. Server supports ${PROTOCOL_VERSION}`
        ))
      )
    );
    ws.close(WS_CLOSE.PROTOCOL_MISMATCH, 'Protocol version mismatch');
    return null;
  }

  // Resolve client info (structured or flat)
  const clientInfo = resolveClientInfo(req.params);
  if (!clientInfo) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(req.id, invalidRequest('Client identification required (provide client {} or clientId + clientMode)'))
      )
    );
    return null;
  }

  // Validate role
  if (!isValidRole(clientInfo.mode)) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(req.id, invalidRequest(`Invalid client mode: ${clientInfo.mode}`))
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
  const role = clientInfo.mode as Role;
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

  // Gather snapshot data
  const config = getServerConfig();
  const healthSnapshot = getHealthStatus();

  let sessionSummaries: unknown[] = [];
  if (_snapshotProviders) {
    try {
      sessionSummaries = await _snapshotProviders.getSessionSummaries();
    } catch {
      // Non-fatal — send empty snapshot
    }
  }

  // Build available events for this connection's scopes
  const availableEvents = buildAvailableEvents(scopes);

  // Build HelloOk response
  const helloOk: HelloOkPayload = {
    type: 'hello-ok',
    protocol: negotiatedVersion,

    server: {
      version: SERVER_VERSION,
      connId: connectionId,
    },

    features: {
      methods: getRegisteredMethods(),
      events: availableEvents,
    },

    snapshot: {
      sessions: sessionSummaries,
      health: healthSnapshot,
    },

    auth: {
      role,
      scopes,
      issuedAtMs: Date.now(),
    },

    policy: {
      maxPayload: config.server.limits.maxPayloadBytes,
      maxBufferedBytes: config.server.limits.maxBufferedBytes,
      tickIntervalMs: TICK_INTERVAL_MS,
    },

    sessionKey,
  };

  ws.send(JSON.stringify(makeResponse(req.id, helloOk)));

  return {
    connectionId,
    role,
    scopes,
    userId: authResult.userId,
    clientId: clientInfo.id,
    clientInfo,
    sessionKey,
  };
}

/**
 * Build the list of events this connection will receive based on scopes.
 */
function buildAvailableEvents(scopes: string[]): string[] {
  const events = new Set<string>();

  // Broadcast events are always included
  for (const evt of BROADCAST_EVENTS) {
    events.add(evt);
  }

  // Add scoped events
  for (const [eventName, requiredScope] of Object.entries(EVENT_SCOPE_MAP)) {
    if (scopes.includes(requiredScope)) {
      events.add(eventName);
    }
  }

  return Array.from(events);
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
