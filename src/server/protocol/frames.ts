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
    protocolVersion: z.number().int(),
    clientId: z.string().min(1),
    clientMode: z.enum(['operator', 'channel', 'node']),
    auth: z
      .object({
        token: z.string().optional(),
        password: z.string().optional(),
        deviceSignature: z.string().optional(),
        deviceId: z.string().optional(),
      })
      .optional(),
    scopes: z.array(z.string()).optional(),
    resume: z
      .object({
        sessionKey: z.string(),
        lastSeq: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});

export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

export interface ChallengePayload {
  nonce: string;
  protocolVersion: number;
  serverVersion: string;
  authModes: string[];
}

export interface HelloOkPayload {
  connectionId: string;
  role: string;
  scopes: string[];
  sessionKey?: string;
  deviceToken?: string;
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
