/**
 * Track 12 — RateLimitSnapshot → event adapter + time-relative early warning.
 */

import { describe, it, expect } from 'vitest';
import {
  toRateLimitSnapshotEvent,
  evaluateEarlyWarning,
  type RateLimitSnapshot,
} from '../RateLimits';

describe('toRateLimitSnapshotEvent', () => {
  it('maps both windows', () => {
    const snap: RateLimitSnapshot = {
      primary: { used_percent: 42, window_minutes: 300 },
      secondary: { used_percent: 10, window_minutes: 10080 },
    };
    expect(toRateLimitSnapshotEvent(snap)).toEqual({
      primary_used_percent: 42,
      secondary_used_percent: 10,
      primary_to_secondary_ratio_percent: Math.round((300 / 10080) * 100),
      primary_window_minutes: 300,
      secondary_window_minutes: 10080,
    });
  });

  it('zero-fills an absent window', () => {
    const snap: RateLimitSnapshot = { primary: { used_percent: 55 } };
    expect(toRateLimitSnapshotEvent(snap)).toEqual({
      primary_used_percent: 55,
      secondary_used_percent: 0,
      primary_to_secondary_ratio_percent: 0,
      primary_window_minutes: 0,
      secondary_window_minutes: 0,
    });
  });

  it('handles an empty snapshot', () => {
    expect(toRateLimitSnapshotEvent({})).toEqual({
      primary_used_percent: 0,
      secondary_used_percent: 0,
      primary_to_secondary_ratio_percent: 0,
      primary_window_minutes: 0,
      secondary_window_minutes: 0,
    });
  });
});

describe('evaluateEarlyWarning', () => {
  it('warns on fast burn (90% used, only ~28% of window elapsed)', () => {
    // 300-min window, 215 min remaining → elapsed ≈ 28%.
    const snap: RateLimitSnapshot = {
      primary: { used_percent: 92, window_minutes: 300, resets_in_seconds: 215 * 60 },
    };
    const w = evaluateEarlyWarning(snap);
    expect(w).not.toBeNull();
    expect(w?.window).toBe('primary');
    expect(w?.used_percent).toBe(92);
  });

  it('does NOT warn below the 0.7 floor even if a low threshold matches', () => {
    const snap: RateLimitSnapshot = {
      primary: { used_percent: 55, window_minutes: 300, resets_in_seconds: 290 * 60 },
    };
    expect(evaluateEarlyWarning(snap)).toBeNull();
  });

  it('does NOT warn when usage is proportional to elapsed time', () => {
    // 90% used but 90% of the window already elapsed → sustainable, no warning.
    const snap: RateLimitSnapshot = {
      primary: { used_percent: 90, window_minutes: 300, resets_in_seconds: 30 * 60 },
    };
    expect(evaluateEarlyWarning(snap)).toBeNull();
  });

  it('returns null when window timing is unknown', () => {
    expect(evaluateEarlyWarning({ primary: { used_percent: 99 } })).toBeNull();
  });

  it('falls back to the secondary window', () => {
    const snap: RateLimitSnapshot = {
      primary: { used_percent: 5 },
      secondary: { used_percent: 95, window_minutes: 10080, resets_in_seconds: 9000 * 60 },
    };
    const w = evaluateEarlyWarning(snap);
    expect(w?.window).toBe('secondary');
  });
});
