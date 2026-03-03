/**
 * Wire Protocol Frame Types
 *
 * Defines the JSON frames exchanged over WebSocket between
 * server and clients. All frames are validated with Zod schemas.
 *
 * @module server/protocol/frames
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Protocol version
// ─────────────────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────
// Frame schemas
// ─────────────────────────────────────────────────────────────────────────

/** Client → Server request */
export const RequestFrameSchema = z.object({
  type: z.literal('req'),
  id: z.string().uuid(),
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

/** Server → Client response */
export const ResponseFrameSchema = z.object({
  type: z.literal('res'),
  id: z.string().uuid(),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      retryable: z.boolean().optional(),
      retryAfterMs: z.number().optional(),
    })
    .optional(),
});

/** Server → Client unsolicited event */
export const EventFrameSchema = z.object({
  type: z.literal('event'),
  event: z.string().min(1),
  payload: z.unknown().optional(),
  seq: z.number().int().nonnegative().optional(),
});

/** Union of all inbound frames (from client perspective, only req) */
export const InboundFrameSchema = RequestFrameSchema;

/** Any frame from the wire (for initial parse) */
export const AnyFrameSchema = z.discriminatedUnion('type', [
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
]);

// ─────────────────────────────────────────────────────────────────────────
// TypeScript types derived from schemas
// ─────────────────────────────────────────────────────────────────────────

export type RequestFrame = z.infer<typeof RequestFrameSchema>;
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;
export type EventFrame = z.infer<typeof EventFrameSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Handshake frames (pre-protocol)
// ─────────────────────────────────────────────────────────────────────────

export const ConnectRequestSchema = z.object({
  type: z.literal('req'),
  id: z.string().uuid(),
  method: z.literal('connect'),
  params: z.object({
    // Protocol negotiation — range or single version
    minProtocol: z.number().int().optional(),
    maxProtocol: z.number().int().optional(),
    protocolVersion: z.number().int().optional(), // backward compat (treated as min=max=value)

    // Client identification — structured or flat
    client: z
      .object({
        id: z.string().min(1),
        displayName: z.string().default(''),
        version: z.string().default(''),
        platform: z.string().default(''),
        mode: z.enum(['operator', 'channel', 'node']),
        instanceId: z.string().optional(),
      })
      .optional(),
    // Flat fallbacks for simple clients
    clientId: z.string().min(1).optional(),
    clientMode: z.enum(['operator', 'channel', 'node']).optional(),

    // Capabilities
    caps: z.array(z.string()).optional(),

    // Authentication
    auth: z
      .object({
        token: z.string().optional(),
        password: z.string().optional(),
        deviceToken: z.string().optional(),
        deviceId: z.string().optional(),
        deviceSignature: z.string().optional(),
      })
      .optional(),

    // RBAC
    role: z.string().optional(),
    scopes: z.array(z.string()).optional(),

    // Session resumption
    resume: z
      .object({
        sessionKey: z.string(),
        lastSeq: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});

export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

/** Resolved client info from either structured or flat fields */
export interface ResolvedClientInfo {
  id: string;
  displayName: string;
  version: string;
  platform: string;
  mode: 'operator' | 'channel' | 'node';
  instanceId?: string;
}

/**
 * Resolve client info from ConnectParams, supporting both structured
 * `client {}` object and flat `clientId`/`clientMode` fields.
 */
export function resolveClientInfo(params: ConnectRequest['params']): ResolvedClientInfo | null {
  if (params.client) {
    return {
      id: params.client.id,
      displayName: params.client.displayName ?? '',
      version: params.client.version ?? '',
      platform: params.client.platform ?? '',
      mode: params.client.mode,
      instanceId: params.client.instanceId,
    };
  }
  if (params.clientId && params.clientMode) {
    return {
      id: params.clientId,
      displayName: '',
      version: '',
      platform: '',
      mode: params.clientMode,
    };
  }
  return null;
}

/**
 * Negotiate protocol version from client's range.
 * Supports minProtocol/maxProtocol range or single protocolVersion.
 * Returns the negotiated version, or null if no compatible version.
 */
export function negotiateProtocolVersion(params: ConnectRequest['params']): number | null {
  let minP: number;
  let maxP: number;

  if (params.minProtocol != null && params.maxProtocol != null) {
    minP = params.minProtocol;
    maxP = params.maxProtocol;
  } else if (params.protocolVersion != null) {
    minP = params.protocolVersion;
    maxP = params.protocolVersion;
  } else {
    // No version info — assume current
    return PROTOCOL_VERSION;
  }

  // Server supports only PROTOCOL_VERSION; check if it's in client's range
  if (PROTOCOL_VERSION >= minP && PROTOCOL_VERSION <= maxP) {
    return PROTOCOL_VERSION;
  }
  return null;
}

export interface ChallengePayload {
  nonce: string;
  protocolVersion: number;
  serverVersion: string;
  authModes: string[];
}

export interface HelloOkPayload {
  type: 'hello-ok';
  protocol: number;

  server: {
    version: string;
    connId: string;
  };

  features: {
    methods: string[];
    events: string[];
  };

  snapshot: {
    sessions: unknown[];
    health: unknown;
  };

  auth?: {
    deviceToken?: string;
    role: string;
    scopes: string[];
    issuedAtMs: number;
  };

  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };

  sessionKey?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Frame constructors
// ─────────────────────────────────────────────────────────────────────────

export function makeResponse(
  id: string,
  payload?: unknown
): ResponseFrame {
  return { type: 'res', id, ok: true, payload };
}

export function makeErrorResponse(
  id: string,
  error: ResponseFrame['error']
): ResponseFrame {
  return { type: 'res', id, ok: false, error };
}

export function makeEvent(
  event: string,
  payload?: unknown,
  seq?: number
): EventFrame {
  return { type: 'event', event, payload, seq };
}
