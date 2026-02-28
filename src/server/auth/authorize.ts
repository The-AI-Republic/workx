/**
 * Authorization
 *
 * Checks whether a connection has the required scope for a method or event.
 *
 * @module server/auth/authorize
 */

import { METHOD_REGISTRY, EVENT_SCOPE_MAP, BROADCAST_EVENTS } from '../protocol/methods';
import type { ErrorShape } from '../protocol/errors';
import { unauthorized } from '../protocol/errors';

// ─────────────────────────────────────────────────────────────────────────
// Connection scope store
// ─────────────────────────────────────────────────────────────────────────

export interface ConnectionAuth {
  connectionId: string;
  role: string;
  scopes: string[];
  userId?: string;
  authenticated: boolean;
}

const _connections = new Map<string, ConnectionAuth>();

export function setConnectionAuth(auth: ConnectionAuth): void {
  _connections.set(auth.connectionId, auth);
}

export function getConnectionAuth(connectionId: string): ConnectionAuth | undefined {
  return _connections.get(connectionId);
}

export function removeConnectionAuth(connectionId: string): void {
  _connections.delete(connectionId);
}

// ─────────────────────────────────────────────────────────────────────────
// Method authorization
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if a connection is authorized to invoke a method.
 *
 * @returns null if authorized, ErrorShape if denied
 */
export function authorizeMethod(connectionId: string, method: string): ErrorShape | null {
  const conn = _connections.get(connectionId);
  if (!conn || !conn.authenticated) {
    return unauthorized('Not authenticated');
  }

  const spec = METHOD_REGISTRY[method];
  if (!spec) {
    // Unknown methods are rejected at frame validation
    return null;
  }

  if (!conn.scopes.includes(spec.scope)) {
    return unauthorized(`Insufficient scope for ${method}. Requires: ${spec.scope}`);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Event authorization (outbound filtering)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if a connection should receive a particular event.
 */
export function shouldReceiveEvent(connectionId: string, eventName: string): boolean {
  // Broadcast events go to all authenticated connections
  if (BROADCAST_EVENTS.has(eventName)) {
    const conn = _connections.get(connectionId);
    return conn?.authenticated ?? false;
  }

  const requiredScope = EVENT_SCOPE_MAP[eventName];
  if (!requiredScope) {
    // Unknown events go to authenticated connections by default
    const conn = _connections.get(connectionId);
    return conn?.authenticated ?? false;
  }

  const conn = _connections.get(connectionId);
  if (!conn || !conn.authenticated) return false;

  return conn.scopes.includes(requiredScope);
}
