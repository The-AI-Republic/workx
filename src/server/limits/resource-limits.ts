/**
 * Resource Limits
 *
 * Enforces concurrency limits, connection limits, session limits,
 * message queue policies, and deduplication.
 *
 * @module server/limits/resource-limits
 */

import { getServerConfig } from '../config/server-config';
import { getConnectionCount } from '../connection/watchdog';

// ─────────────────────────────────────────────────────────────────────────
// Concurrency tracking
// ─────────────────────────────────────────────────────────────────────────

let _activeRuns = 0;

export function getActiveRunCount(): number {
  return _activeRuns;
}

export function incrementActiveRuns(): boolean {
  const config = getServerConfig();
  if (_activeRuns >= config.server.limits.maxConcurrentRuns) {
    return false; // Limit reached
  }
  _activeRuns++;
  return true;
}

export function decrementActiveRuns(): void {
  _activeRuns = Math.max(0, _activeRuns - 1);
}

// ─────────────────────────────────────────────────────────────────────────
// Connection limits
// ─────────────────────────────────────────────────────────────────────────

export function canAcceptConnection(): boolean {
  const config = getServerConfig();
  return getConnectionCount() < config.server.limits.maxConnections;
}

// ─────────────────────────────────────────────────────────────────────────
// Session limits
// ─────────────────────────────────────────────────────────────────────────

export function canCreateSession(currentSessionCount: number): boolean {
  const config = getServerConfig();
  return currentSessionCount < config.server.limits.maxSessions;
}

// ─────────────────────────────────────────────────────────────────────────
// Payload size limits
// ─────────────────────────────────────────────────────────────────────────

export function isPayloadTooLarge(bytes: number): boolean {
  const config = getServerConfig();
  return bytes > config.server.limits.maxPayloadBytes;
}

// ─────────────────────────────────────────────────────────────────────────
// Message deduplication
// ─────────────────────────────────────────────────────────────────────────

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

const _recentIds = new Map<string, number>();

/**
 * Check if a message ID is a duplicate (seen within TTL).
 * Returns true if duplicate.
 */
export function isDuplicate(messageId: string): boolean {
  const now = Date.now();

  // Prune expired entries (lazy cleanup)
  if (_recentIds.size > 10_000) {
    for (const [id, ts] of _recentIds) {
      if (now - ts > DEDUP_TTL_MS) {
        _recentIds.delete(id);
      }
    }
  }

  if (_recentIds.has(messageId)) {
    const ts = _recentIds.get(messageId)!;
    if (now - ts < DEDUP_TTL_MS) {
      return true; // Duplicate
    }
  }

  _recentIds.set(messageId, now);
  return false;
}

/**
 * Clear dedup state (for shutdown).
 */
export function resetDedup(): void {
  _recentIds.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// Message queue tracking (per session)
// ─────────────────────────────────────────────────────────────────────────

const _queueSizes = new Map<string, number>();

export function getQueueSize(sessionKey: string): number {
  return _queueSizes.get(sessionKey) ?? 0;
}

export function incrementQueue(sessionKey: string): boolean {
  const config = getServerConfig();
  const current = _queueSizes.get(sessionKey) ?? 0;
  if (current >= config.server.limits.queue.cap) {
    return false; // Queue full
  }
  _queueSizes.set(sessionKey, current + 1);
  return true;
}

export function decrementQueue(sessionKey: string): void {
  const current = _queueSizes.get(sessionKey) ?? 0;
  _queueSizes.set(sessionKey, Math.max(0, current - 1));
}

export function resetQueues(): void {
  _queueSizes.clear();
}
