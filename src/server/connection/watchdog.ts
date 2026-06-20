/**
 * Connection Watchdog
 *
 * Manages heartbeat ticks, slow consumer detection, flood guard,
 * and stale connection cleanup.
 *
 * @module server/connection/watchdog
 */

import { makeEvent } from '@workx/ws-server';
import { WS_CLOSE } from '@workx/ws-server';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 30_000;
const STALE_CONNECTION_MS = 60_000;
const MAX_FAILED_AUTH_ATTEMPTS = 5;

// ─────────────────────────────────────────────────────────────────────────
// Connection tracking
// ─────────────────────────────────────────────────────────────────────────

export interface TrackedConnection {
  connectionId: string;
  ws: {
    send: (data: string) => void;
    close: (code: number, reason: string) => void;
    bufferedAmount?: number;
    readyState?: number;
  };
  connectedAt: number;
  lastActivity: number;
  authenticated: boolean;
  failedAuthAttempts: number;
  bufferedBytes: number;
  maxBufferedBytes: number;
}

const _connections = new Map<string, TrackedConnection>();

// ─────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────

export function trackConnection(conn: TrackedConnection): void {
  _connections.set(conn.connectionId, conn);
}

export function untrackConnection(connectionId: string): void {
  _connections.delete(connectionId);
}

export function getTrackedConnection(connectionId: string): TrackedConnection | undefined {
  return _connections.get(connectionId);
}

export function getTrackedConnections(): TrackedConnection[] {
  return Array.from(_connections.values());
}

export function getConnectionCount(): number {
  return _connections.size;
}

/**
 * Record activity for a connection (resets stale timer).
 */
export function touchConnection(connectionId: string): void {
  const conn = _connections.get(connectionId);
  if (conn) {
    conn.lastActivity = Date.now();
  }
}

/**
 * Record a failed auth attempt. Returns true if flood guard triggered.
 */
export function recordFailedAuth(connectionId: string): boolean {
  const conn = _connections.get(connectionId);
  if (!conn) return false;

  conn.failedAuthAttempts++;
  if (conn.failedAuthAttempts >= MAX_FAILED_AUTH_ATTEMPTS) {
    conn.ws.close(WS_CLOSE.POLICY_VIOLATION, 'Too many failed auth attempts');
    _connections.delete(connectionId);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Tick broadcast
// ─────────────────────────────────────────────────────────────────────────

let _tickTimer: ReturnType<typeof setInterval> | null = null;
let _tickSeq = 0;

export function startTickBroadcast(): void {
  if (_tickTimer) return;

  _tickTimer = setInterval(() => {
    _tickSeq++;
    const frame = JSON.stringify(
      makeEvent('tick', { ts: Date.now(), seq: _tickSeq }, _tickSeq)
    );

    for (const conn of _connections.values()) {
      if (!conn.authenticated) continue;

      try {
        conn.ws.send(frame);
      } catch {
        // Connection probably closed — cleanup will handle
      }
    }
  }, TICK_INTERVAL_MS);
}

export function stopTickBroadcast(): void {
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Slow consumer detection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if a connection is a slow consumer.
 * If the WebSocket buffer exceeds the threshold, close the connection.
 */
export function checkSlowConsumer(connectionId: string): boolean {
  const conn = _connections.get(connectionId);
  if (!conn) return false;

  const buffered = conn.ws.bufferedAmount ?? 0;
  if (buffered > conn.maxBufferedBytes) {
    console.warn(`[Watchdog] Slow consumer detected: ${connectionId} (${buffered} bytes buffered)`);
    conn.ws.close(WS_CLOSE.POLICY_VIOLATION, 'Slow consumer');
    _connections.delete(connectionId);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Stale connection cleanup
// ─────────────────────────────────────────────────────────────────────────

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startStaleCleanup(): void {
  if (_cleanupTimer) return;

  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, conn] of _connections) {
      // Only clean up unauthenticated stale connections
      if (!conn.authenticated && now - conn.connectedAt > STALE_CONNECTION_MS) {
        console.warn(`[Watchdog] Stale unauthenticated connection: ${id}`);
        conn.ws.close(WS_CLOSE.POLICY_VIOLATION, 'Handshake not completed');
        _connections.delete(id);
      }
    }
  }, STALE_CONNECTION_MS);
}

export function stopStaleCleanup(): void {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Full shutdown
// ─────────────────────────────────────────────────────────────────────────

export function shutdownWatchdog(): void {
  stopTickBroadcast();
  stopStaleCleanup();
  _connections.clear();
}
