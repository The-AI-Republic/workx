import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetExtractionLifecycleForTests,
  isExtractionInFlight,
  markExtractionCompleted,
  markExtractionStarted,
  waitForSessionSummaryExtraction,
} from '../extractionLifecycle';

describe('extractionLifecycle', () => {
  beforeEach(() => {
    _resetExtractionLifecycleForTests();
  });

  it('flag lifecycle: started → completed clears', () => {
    expect(isExtractionInFlight('s1')).toBe(false);
    markExtractionStarted('s1');
    expect(isExtractionInFlight('s1')).toBe(true);
    markExtractionCompleted('s1');
    expect(isExtractionInFlight('s1')).toBe(false);
  });

  it('per-session isolation: two sessions are independent', () => {
    markExtractionStarted('s1');
    expect(isExtractionInFlight('s1')).toBe(true);
    expect(isExtractionInFlight('s2')).toBe(false);
    markExtractionStarted('s2');
    markExtractionCompleted('s1');
    expect(isExtractionInFlight('s1')).toBe(false);
    expect(isExtractionInFlight('s2')).toBe(true);
  });

  it('a thrown wrapped function still clears the flag in finally', async () => {
    const wrapped = async () => {
      markExtractionStarted('s1');
      try {
        throw new Error('boom');
      } finally {
        markExtractionCompleted('s1');
      }
    };
    await expect(wrapped()).rejects.toThrow('boom');
    expect(isExtractionInFlight('s1')).toBe(false);
  });

  describe('waitForSessionSummaryExtraction', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns no-op immediately when no extraction is in flight', async () => {
      const result = await waitForSessionSummaryExtraction('idle');
      expect(result).toBe('no-op');
    });

    it('resolves with "cleared" when flag clears mid-wait', async () => {
      vi.useFakeTimers();
      markExtractionStarted('s1');

      const promise = waitForSessionSummaryExtraction('s1');

      // Clear the flag a moment in and advance the polling timer.
      markExtractionCompleted('s1');
      await vi.advanceTimersByTimeAsync(1100);

      await expect(promise).resolves.toBe('cleared');
    });

    it('returns "timeout" when the 15s hard deadline hits', async () => {
      vi.useFakeTimers();
      markExtractionStarted('s1');

      const promise = waitForSessionSummaryExtraction('s1');
      // Advance past the 15s deadline.
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(promise).resolves.toBe('timeout');
    });

    it('returns "stale" and force-clears the flag past the 60s staleness threshold', async () => {
      vi.useFakeTimers();
      // Backdate the flag so it's already 61s old (older than the 60s
      // staleness threshold but the 15s deadline hasn't elapsed yet — fake
      // timers start from now and the flag's timestamp uses Date.now()).
      markExtractionStarted('s1');

      // Manually move the wall clock forward.
      vi.setSystemTime(new Date(Date.now() + 61_000));

      const promise = waitForSessionSummaryExtraction('s1');
      const result = await promise;
      expect(result).toBe('stale');
      expect(isExtractionInFlight('s1')).toBe(false);
    });
  });
});
