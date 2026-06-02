/**
 * App-Server Rate Limiter
 *
 * Simple per-connection sliding-window limiter. Instance-scoped (unlike the
 * module-global headless limiter) so each app-server instance is independent.
 *
 * @module app-server/connection/rateLimiter
 */

import { rateLimited, type ErrorShape } from '@applepi/ws-server';

export interface RateLimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests per connection per window. */
  max: number;
}

export class AppServerRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly opts: RateLimiterOptions = { windowMs: 1000, max: 50 }) {}

  /**
   * Record a request and return a RATE_LIMITED error if the connection has
   * exceeded its window budget, or null if allowed.
   */
  check(connectionId: string, now: number): ErrorShape | null {
    const windowStart = now - this.opts.windowMs;
    const arr = (this.hits.get(connectionId) ?? []).filter((t) => t > windowStart);
    if (arr.length >= this.opts.max) {
      const retryAfterMs = Math.max(1, arr[0] + this.opts.windowMs - now);
      this.hits.set(connectionId, arr);
      return rateLimited(retryAfterMs);
    }
    arr.push(now);
    this.hits.set(connectionId, arr);
    return null;
  }

  clear(connectionId: string): void {
    this.hits.delete(connectionId);
  }

  clearAll(): void {
    this.hits.clear();
  }
}
