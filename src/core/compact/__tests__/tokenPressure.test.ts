import { describe, expect, it } from 'vitest';
import {
  calculateTokenWarningState,
  getAutoCompactRatio,
  getAutoCompactTokenLimit,
  shouldAutoCompactTokens,
} from '../tokenPressure';

describe('tokenPressure', () => {
  it('uses model-provided auto compact limit before the default ratio', () => {
    expect(getAutoCompactTokenLimit(100000, 75000)).toBe(75000);
    expect(getAutoCompactRatio(100000, 75000)).toBe(0.75);
  });

  it('falls back to 80 percent of context window', () => {
    expect(getAutoCompactTokenLimit(100000)).toBe(80000);
    expect(shouldAutoCompactTokens(80000, 100000)).toBe(true);
    expect(shouldAutoCompactTokens(79999, 100000)).toBe(false);
  });

  it('calculates graduated warning tiers', () => {
    const state = calculateTokenWarningState({
      currentTokens: 85000,
      contextWindow: 100000,
      autoCompactTokenLimit: 80000,
    });

    expect(state.percent_used).toBe(85);
    expect(state.percent_left).toBe(15);
    expect(state.is_above_warning_threshold).toBe(true);
    expect(state.is_above_error_threshold).toBe(false);
    expect(state.is_above_auto_compact_threshold).toBe(true);
    expect(state.is_at_blocking_limit).toBe(false);
  });
});
