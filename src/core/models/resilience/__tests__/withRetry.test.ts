/**
 * Track 12 — retry orchestrator tests.
 * Covers classification, reset-delay, attended retry parity, persistent
 * (unattended) mode, background fast-bail, and the test-injection seam.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyModelError,
  getResetDelayMs,
  withModelRetry,
  __setModelRetryTestInjector,
  parseMaxTokensContextOverflowError,
  RESET_CAP_MS,
  MAX_529_RETRIES,
} from '../withRetry';
import { ModelClientError } from '../../ModelClient';
import { RateLimitError } from '../../ModelClientError';

const noSleep = async () => {};

function rateLimitError(opts: { retryAfterMs?: number; resetUnixSec?: number } = {}) {
  return new RateLimitError(
    'rate limited',
    {
      limit: 100,
      remaining: 0,
      reset: opts.resetUnixSec ?? 0,
      window: 60,
      retryAfter: opts.retryAfterMs,
    },
    429,
    'test',
  );
}

afterEach(() => {
  __setModelRetryTestInjector(null);
});

describe('classifyModelError', () => {
  it('classifies 429 as rate_limit', () => {
    expect(classifyModelError(new ModelClientError('x', 429)).kind).toBe('rate_limit');
  });
  it('classifies RateLimitError as rate_limit', () => {
    expect(classifyModelError(rateLimitError()).kind).toBe('rate_limit');
  });
  it('classifies 529 as overloaded', () => {
    expect(classifyModelError(new ModelClientError('x', 529)).kind).toBe('overloaded');
  });
  it('classifies overloaded message (no status) as overloaded', () => {
    expect(classifyModelError(new Error('{"type":"overloaded_error"}')).kind).toBe(
      'overloaded',
    );
  });
  it('classifies 5xx as server', () => {
    expect(classifyModelError(new ModelClientError('x', 503)).kind).toBe('server');
  });
  it('classifies 4xx (401/400) as fatal', () => {
    expect(classifyModelError(new ModelClientError('x', 401)).kind).toBe('fatal');
    expect(classifyModelError(new ModelClientError('x', 400)).kind).toBe('fatal');
  });
  it('classifies stream-closed / network as transport (retryable)', () => {
    expect(classifyModelError(new Error('stream closed before response.completed')).kind).toBe(
      'transport',
    );
    expect(classifyModelError(new Error('ECONNRESET')).kind).toBe('transport');
  });
});

describe('getResetDelayMs', () => {
  it('prefers retryAfter (ms)', () => {
    expect(getResetDelayMs(rateLimitError({ retryAfterMs: 5000 }))).toBe(5000);
  });
  it('falls back to reset unix seconds - now', () => {
    const future = Math.floor(Date.now() / 1000) + 120;
    const d = getResetDelayMs(rateLimitError({ resetUnixSec: future }));
    expect(d).toBeGreaterThan(60_000);
    expect(d).toBeLessThanOrEqual(120_000);
  });
  it('caps at RESET_CAP_MS', () => {
    expect(getResetDelayMs(rateLimitError({ retryAfterMs: RESET_CAP_MS * 10 }))).toBe(
      RESET_CAP_MS,
    );
  });
  it('returns null when nothing usable', () => {
    expect(getResetDelayMs(new ModelClientError('x', 429))).toBeNull();
  });
});

describe('withModelRetry — attended', () => {
  it('returns on first success', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    await expect(withModelRetry(op, { maxRetries: 3, unattended: false, sleep: noSleep })).resolves.toBe(
      'ok',
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 then succeeds, firing onRetryNotice', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new ModelClientError('rl', 429))
      .mockResolvedValue('ok');
    const onRetryNotice = vi.fn();
    const res = await withModelRetry(op, {
      maxRetries: 3,
      unattended: false,
      sleep: noSleep,
      onRetryNotice,
    });
    expect(res).toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
    expect(onRetryNotice).toHaveBeenCalledTimes(1);
  });

  it('does not retry a fatal 400', async () => {
    const op = vi.fn().mockRejectedValue(new ModelClientError('bad', 400));
    await expect(
      withModelRetry(op, { maxRetries: 3, unattended: false, sleep: noSleep }),
    ).rejects.toThrow('bad');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('honors isNonRetryable predicate', async () => {
    const op = vi.fn().mockRejectedValue(new ModelClientError('rl', 429));
    await expect(
      withModelRetry(op, {
        maxRetries: 3,
        unattended: false,
        sleep: noSleep,
        isNonRetryable: () => true,
      }),
    ).rejects.toThrow('rl');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('honors retryAfter as the delay', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError({ retryAfterMs: 1234 }))
      .mockResolvedValue('ok');
    const sleep = vi.fn(noSleep);
    await withModelRetry(op, { maxRetries: 3, unattended: false, sleep });
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it('exhausts maxRetries then throws (3 retries)', async () => {
    const op = vi.fn().mockRejectedValue(new ModelClientError('rl', 429));
    await expect(
      withModelRetry(op, { maxRetries: 3, unattended: false, sleep: noSleep }),
    ).rejects.toThrow('rl');
    // 1 initial + 3 retries = 4 calls
    expect(op).toHaveBeenCalledTimes(4);
  });

  it('throws when cancelled', async () => {
    let cancelled = false;
    const op = vi.fn().mockImplementation(async () => {
      cancelled = true;
      throw new ModelClientError('rl', 429);
    });
    await expect(
      withModelRetry(op, {
        maxRetries: 3,
        unattended: false,
        sleep: noSleep,
        isCancelled: () => cancelled,
      }),
    ).rejects.toBeTruthy();
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('withModelRetry — unattended (persistent)', () => {
  it('keeps retrying 429 past maxRetries until success, emitting onWait', async () => {
    let n = 0;
    const op = vi.fn().mockImplementation(async () => {
      n++;
      if (n < 6) throw rateLimitError({ retryAfterMs: 10 });
      return 'ok';
    });
    const onWait = vi.fn();
    const res = await withModelRetry(op, {
      maxRetries: 3,
      unattended: true,
      sleep: noSleep,
      onWait,
    });
    expect(res).toBe('ok');
    expect(op).toHaveBeenCalledTimes(6); // would have failed at 4 if attended
    expect(onWait).toHaveBeenCalled();
  });

  it('respects resetCapMs clamp (extension single-window)', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError({ retryAfterMs: 60 * 60 * 1000 }))
      .mockResolvedValue('ok');
    const sleep = vi.fn(noSleep);
    await withModelRetry(op, {
      maxRetries: 3,
      unattended: true,
      sleep,
      resetCapMs: 5000,
    });
    expect(sleep).toHaveBeenCalledWith(5000);
  });
});

describe('withModelRetry — background fast-bail', () => {
  it('bails immediately on overloaded when background + attended', async () => {
    const op = vi.fn().mockRejectedValue(new ModelClientError('overloaded', 529));
    await expect(
      withModelRetry(op, {
        maxRetries: 5,
        unattended: false,
        source: 'background',
        sleep: noSleep,
      }),
    ).rejects.toThrow('overloaded');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('background still waits when unattended', async () => {
    let n = 0;
    const op = vi.fn().mockImplementation(async () => {
      n++;
      if (n < 3) throw new ModelClientError('overloaded', 529);
      return 'ok';
    });
    const res = await withModelRetry(op, {
      maxRetries: 1,
      unattended: true,
      source: 'background',
      sleep: noSleep,
    });
    expect(res).toBe('ok');
  });
});

describe('withModelRetry — fallback', () => {
  it('swaps model after MAX_529_RETRIES consecutive overloads', async () => {
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls <= MAX_529_RETRIES) throw new ModelClientError('overloaded', 529);
      return 'ok-on-fallback';
    });
    const applyFallbackModel = vi.fn();
    const onDowngrade = vi.fn();
    const res = await withModelRetry(op, {
      maxRetries: 10,
      unattended: false,
      sleep: noSleep,
      currentModel: () => 'big',
      fallback: {
        resolveFallbackModel: () => 'small',
        applyFallbackModel,
        onDowngrade,
      },
    });
    expect(res).toBe('ok-on-fallback');
    expect(applyFallbackModel).toHaveBeenCalledWith('small');
    expect(onDowngrade).toHaveBeenCalledWith('big', 'small');
  });

  it('downgrades only once (resolve returns undefined after swap) then fails attended', async () => {
    let current = 'big';
    const op = vi.fn().mockRejectedValue(new ModelClientError('overloaded', 529));
    const applyFallbackModel = vi.fn((m: string) => {
      current = m;
    });
    await expect(
      withModelRetry(op, {
        maxRetries: 2,
        unattended: false,
        sleep: noSleep,
        currentModel: () => current,
        fallback: {
          // mirrors TurnManager's "downgrade once" guard
          resolveFallbackModel: () => (current !== 'small' ? 'small' : undefined),
          applyFallbackModel,
        },
      }),
    ).rejects.toThrow('overloaded');
    expect(applyFallbackModel).toHaveBeenCalledTimes(1);
    expect(applyFallbackModel).toHaveBeenCalledWith('small');
  });
});

describe('parseMaxTokensContextOverflowError', () => {
  it('parses the 400 overflow message', () => {
    const e = new ModelClientError(
      'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000',
      400,
    );
    expect(parseMaxTokensContextOverflowError(e)).toEqual({
      inputTokens: 188059,
      maxTokens: 20000,
      contextLimit: 200000,
    });
  });
  it('returns undefined for unrelated errors', () => {
    expect(parseMaxTokensContextOverflowError(new ModelClientError('x', 429))).toBeUndefined();
    expect(parseMaxTokensContextOverflowError(new ModelClientError('bad', 400))).toBeUndefined();
  });
});

describe('withModelRetry — context-overflow self-heal', () => {
  it('retries without counting when onContextOverflow handles it', async () => {
    let n = 0;
    const op = vi.fn().mockImplementation(async () => {
      n++;
      if (n === 1) {
        throw new ModelClientError(
          'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000',
          400,
        );
      }
      return 'ok';
    });
    const onContextOverflow = vi.fn().mockReturnValue(true);
    const res = await withModelRetry(op, {
      maxRetries: 0, // would fail immediately if counted as a retry
      unattended: false,
      sleep: noSleep,
      onContextOverflow,
    });
    expect(res).toBe('ok');
    expect(onContextOverflow).toHaveBeenCalledWith({
      inputTokens: 190000,
      maxTokens: 20000,
      contextLimit: 200000,
    });
  });

  it('stays fatal when no handler is provided', async () => {
    const op = vi
      .fn()
      .mockRejectedValue(
        new ModelClientError(
          'input length and `max_tokens` exceed context limit: 1 + 2 > 3',
          400,
        ),
      );
    await expect(
      withModelRetry(op, { maxRetries: 3, unattended: false, sleep: noSleep }),
    ).rejects.toThrow('exceed context limit');
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('test-injection seam', () => {
  it('throws the injected error before the operation runs', async () => {
    __setModelRetryTestInjector(() => new ModelClientError('injected-rl', 429));
    const op = vi.fn().mockResolvedValue('ok');
    // Always injected → attended exhausts and throws the injected error.
    await expect(
      withModelRetry(op, { maxRetries: 2, unattended: false, sleep: noSleep }),
    ).rejects.toThrow('injected-rl');
    expect(op).not.toHaveBeenCalled();
  });
});
