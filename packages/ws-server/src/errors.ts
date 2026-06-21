/**
 * Server Mode Error Definitions
 *
 * Error codes, WebSocket close codes, and error factory helpers.
 *
 * @module server/protocol/errors
 */

// ─────────────────────────────────────────────────────────────────────────
// Error codes
// ─────────────────────────────────────────────────────────────────────────

export enum ErrorCode {
  INVALID_REQUEST = 'INVALID_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  AGENT_TIMEOUT = 'AGENT_TIMEOUT',
  UNAVAILABLE = 'UNAVAILABLE',
  DISCONNECTED = 'DISCONNECTED',
  /** Inbound request queue is saturated; the caller should retry later. */
  OVERLOADED = 'OVERLOADED',
}

// ─────────────────────────────────────────────────────────────────────────
// Error shape
// ─────────────────────────────────────────────────────────────────────────

export interface ErrorShape {
  code: ErrorCode;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// WebSocket close codes
// ─────────────────────────────────────────────────────────────────────────

export const WS_CLOSE = {
  /** Normal closure */
  NORMAL: 1000,
  /** Protocol version mismatch */
  PROTOCOL_MISMATCH: 1002,
  /** Policy violation (auth failure, slow consumer, flood guard) */
  POLICY_VIOLATION: 1008,
  /** Service restart (graceful shutdown) */
  SERVICE_RESTART: 1012,
  /** Tick timeout (client-side) */
  TICK_TIMEOUT: 4000,
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Error factories
// ─────────────────────────────────────────────────────────────────────────

export function invalidRequest(message: string, details?: unknown): ErrorShape {
  return { code: ErrorCode.INVALID_REQUEST, message, details, retryable: false };
}

export function unauthorized(message: string, details?: unknown): ErrorShape {
  return { code: ErrorCode.UNAUTHORIZED, message, details, retryable: false };
}

export function notFound(message: string, details?: unknown): ErrorShape {
  return { code: ErrorCode.NOT_FOUND, message, details, retryable: false };
}

export function rateLimited(retryAfterMs: number, message?: string): ErrorShape {
  return {
    code: ErrorCode.RATE_LIMITED,
    message: message ?? 'Rate limit exceeded',
    retryable: true,
    retryAfterMs,
  };
}

export function agentTimeout(message?: string): ErrorShape {
  return {
    code: ErrorCode.AGENT_TIMEOUT,
    message: message ?? 'Agent run exceeded time limit',
    retryable: false,
  };
}

export function unavailable(message?: string, details?: unknown): ErrorShape {
  return {
    code: ErrorCode.UNAVAILABLE,
    message: message ?? 'Service temporarily unavailable',
    details,
    retryable: true,
  };
}

export function overloaded(retryAfterMs = 250, message?: string): ErrorShape {
  return {
    code: ErrorCode.OVERLOADED,
    message: message ?? 'Server overloaded; retry later.',
    retryable: true,
    retryAfterMs,
  };
}
