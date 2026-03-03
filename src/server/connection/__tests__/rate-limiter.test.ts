import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkRateLimit,
  clearRateLimits,
  resetAllRateLimits,
  setRateLimitRule,
} from '../rate-limiter';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  resetAllRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// General rate limiting
// ---------------------------------------------------------------------------

describe('checkRateLimit — general', () => {
  it('allows requests under limit', () => {
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit('conn-1', 'chat.history')).toBeNull();
    }
  });

  it('denies requests over the general limit', () => {
    for (let i = 0; i < 60; i++) {
      checkRateLimit('conn-1', 'chat.history');
    }
    const err = checkRateLimit('conn-1', 'chat.history');
    expect(err).not.toBeNull();
    expect(err!.code).toBe('RATE_LIMITED');
    expect(err!.retryable).toBe(true);
    expect(err!.retryAfterMs).toBeGreaterThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------------------
// Method-specific limits
// ---------------------------------------------------------------------------

describe('checkRateLimit — method-specific', () => {
  it('enforces chat.send limit of 10', () => {
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit('conn-2', 'chat.send')).toBeNull();
    }
    const err = checkRateLimit('conn-2', 'chat.send');
    expect(err).not.toBeNull();
    expect(err!.code).toBe('RATE_LIMITED');
  });

  it('enforces config.set limit of 3', () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('conn-3', 'config.set')).toBeNull();
    }
    const err = checkRateLimit('conn-3', 'config.set');
    expect(err).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Browser-origin limits
// ---------------------------------------------------------------------------

describe('checkRateLimit — browser-origin', () => {
  it('enforces browser limit of 30', () => {
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit('conn-4', 'chat.history', { isBrowserOrigin: true })).toBeNull();
    }
    const err = checkRateLimit('conn-4', 'chat.history', { isBrowserOrigin: true });
    expect(err).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loopback exemption
// ---------------------------------------------------------------------------

describe('checkRateLimit — loopback', () => {
  it('exempts loopback connections', () => {
    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit('conn-5', 'chat.send', { isLoopback: true })).toBeNull();
    }
  });

  it('does not exempt loopback + browser-origin', () => {
    for (let i = 0; i < 30; i++) {
      checkRateLimit('conn-6', 'chat.history', { isLoopback: true, isBrowserOrigin: true });
    }
    const err = checkRateLimit('conn-6', 'chat.history', { isLoopback: true, isBrowserOrigin: true });
    expect(err).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sliding window behavior
// ---------------------------------------------------------------------------

describe('sliding window', () => {
  it('allows requests after window slides', () => {
    // Fill up the general limit
    for (let i = 0; i < 60; i++) {
      checkRateLimit('conn-7', 'chat.history');
    }
    expect(checkRateLimit('conn-7', 'chat.history')).not.toBeNull();

    // Advance past the window
    vi.advanceTimersByTime(61_000);

    // Should be allowed again
    expect(checkRateLimit('conn-7', 'chat.history')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearRateLimits
// ---------------------------------------------------------------------------

describe('clearRateLimits', () => {
  it('clears limits for a specific connection', () => {
    for (let i = 0; i < 60; i++) {
      checkRateLimit('conn-8', 'chat.history');
    }
    expect(checkRateLimit('conn-8', 'chat.history')).not.toBeNull();

    clearRateLimits('conn-8');
    expect(checkRateLimit('conn-8', 'chat.history')).toBeNull();
  });

  it('does not affect other connections', () => {
    for (let i = 0; i < 60; i++) {
      checkRateLimit('conn-a', 'chat.history');
      checkRateLimit('conn-b', 'chat.history');
    }

    clearRateLimits('conn-a');
    expect(checkRateLimit('conn-a', 'chat.history')).toBeNull();
    expect(checkRateLimit('conn-b', 'chat.history')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setRateLimitRule
// ---------------------------------------------------------------------------

describe('setRateLimitRule', () => {
  it('overrides default rules', () => {
    // Set a very tight general limit
    setRateLimitRule('general', { windowMs: 60_000, maxRequests: 2 });

    expect(checkRateLimit('conn-9', 'chat.history')).toBeNull();
    expect(checkRateLimit('conn-9', 'chat.history')).toBeNull();
    expect(checkRateLimit('conn-9', 'chat.history')).not.toBeNull();

    // Restore to avoid affecting other tests
    setRateLimitRule('general', { windowMs: 60_000, maxRequests: 60 });
  });
});
