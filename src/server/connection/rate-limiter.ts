/**
 * Rate Limiter
 *
 * Per-connection and per-method sliding window rate limiting.
 *
 * @module server/connection/rate-limiter
 */

import { rateLimited, type ErrorShape } from '@applepi/ws-server';

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────

export interface RateLimitRule {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_RULES: Record<string, RateLimitRule> = {
  /** Per-connection general limit */
  general: { windowMs: 60_000, maxRequests: 60 },
  /** Per-userId inference limit */
  'chat.send': { windowMs: 60_000, maxRequests: 10 },
  /** Control-plane writes */
  'config.set': { windowMs: 60_000, maxRequests: 3 },
  'config.patch': { windowMs: 60_000, maxRequests: 3 },
  /** Browser-origin connections */
  browser: { windowMs: 60_000, maxRequests: 30 },
};

// ─────────────────────────────────────────────────────────────────────────
// Sliding window implementation
// ─────────────────────────────────────────────────────────────────────────

interface SlidingWindow {
  timestamps: number[];
  rule: RateLimitRule;
}

/**
 * Per-connection rate limit state
 */
const _windows = new Map<string, SlidingWindow>();

function getWindowKey(connectionId: string, bucket: string): string {
  return `${connectionId}:${bucket}`;
}

function getOrCreateWindow(key: string, rule: RateLimitRule): SlidingWindow {
  let window = _windows.get(key);
  if (!window) {
    window = { timestamps: [], rule };
    _windows.set(key, window);
  }
  return window;
}

function pruneWindow(window: SlidingWindow, now: number): void {
  const cutoff = now - window.rule.windowMs;
  // Remove timestamps older than the window
  while (window.timestamps.length > 0 && window.timestamps[0] < cutoff) {
    window.timestamps.shift();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check rate limit for a connection + method combination.
 *
 * @returns null if allowed, ErrorShape if rate limited
 */
export function checkRateLimit(
  connectionId: string,
  method: string,
  options?: { isLoopback?: boolean; isBrowserOrigin?: boolean }
): ErrorShape | null {
  // Loopback connections are exempt (except browser-origin)
  if (options?.isLoopback && !options?.isBrowserOrigin) {
    return null;
  }

  const now = Date.now();

  // Check general per-connection limit
  const generalResult = checkBucket(connectionId, 'general', DEFAULT_RULES.general, now);
  if (generalResult) return generalResult;

  // Check method-specific limit
  const methodRule = DEFAULT_RULES[method];
  if (methodRule) {
    const methodResult = checkBucket(connectionId, method, methodRule, now);
    if (methodResult) return methodResult;
  }

  // Check browser-origin limit
  if (options?.isBrowserOrigin) {
    const browserResult = checkBucket(connectionId, 'browser', DEFAULT_RULES.browser, now);
    if (browserResult) return browserResult;
  }

  return null;
}

function checkBucket(
  connectionId: string,
  bucket: string,
  rule: RateLimitRule,
  now: number
): ErrorShape | null {
  const key = getWindowKey(connectionId, bucket);
  const window = getOrCreateWindow(key, rule);

  pruneWindow(window, now);

  if (window.timestamps.length >= rule.maxRequests) {
    // Calculate retry-after from oldest timestamp in window
    const oldestInWindow = window.timestamps[0];
    const retryAfterMs = (oldestInWindow + rule.windowMs) - now;
    return rateLimited(Math.max(retryAfterMs, 1_000));
  }

  // Allow: record timestamp
  window.timestamps.push(now);
  return null;
}

/**
 * Remove all rate limit state for a connection.
 */
export function clearRateLimits(connectionId: string): void {
  for (const key of _windows.keys()) {
    if (key.startsWith(connectionId + ':')) {
      _windows.delete(key);
    }
  }
}

/**
 * Clear all rate limit state (for shutdown).
 */
export function resetAllRateLimits(): void {
  _windows.clear();
}

/**
 * Override default rules (for config hot-reload).
 */
export function setRateLimitRule(bucket: string, rule: RateLimitRule): void {
  DEFAULT_RULES[bucket] = rule;
}
