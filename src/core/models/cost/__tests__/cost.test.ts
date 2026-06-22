// File: src/core/models/cost/__tests__/cost.test.ts
//
// Track 18 — USD cost calculator: cached-subset formula, the >= 0 clamp,
// reasoning-at-output-rate, and unknown-key degradation (number + flag,
// never throw).

import { describe, it, expect } from 'vitest';
import { calculateUSDCost, formatCost } from '../cost';
import { MODEL_COST_TABLE, DEFAULT_FALLBACK_RATE } from '../modelCostTable';
import type { TokenUsage } from '../../types/TokenUsage';
import defaultProviders from '../../providers/default.json';

const usage = (p: Partial<TokenUsage>): TokenUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
  ...p,
});

describe('calculateUSDCost', () => {
  it('charges (input - cached) at input rate and cached at cached rate', () => {
    // openai:gpt-5.1 → input 1.25, cached 0.125, output 10.00 /1M
    const r = calculateUSDCost('openai:gpt-5.1', usage({ input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 1_000_000 }));
    // uncached 600k @1.25 + cached 400k @0.125 + output 1M @10
    expect(r.costUSD).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.125 + 10.0, 10);
    expect(r.estimated).toBe(false);
  });

  it('prices reasoning_output_tokens at the output rate', () => {
    const r = calculateUSDCost('openai:gpt-5.1', usage({ output_tokens: 500_000, reasoning_output_tokens: 500_000 }));
    expect(r.costUSD).toBeCloseTo(1_000_000 / 1_000_000 * 10.0, 10);
  });

  it('clamps uncached input at >= 0 when cached exceeds input', () => {
    const r = calculateUSDCost('openai:gpt-5.1', usage({ input_tokens: 100, cached_input_tokens: 1000 }));
    // no negative input term; only cached @0.125
    expect(r.costUSD).toBeCloseTo(1000 / 1_000_000 * 0.125, 12);
    expect(r.costUSD).toBeGreaterThanOrEqual(0);
  });

  it('degrades on unknown key: fallback rate, estimated flag, no throw', () => {
    let r!: ReturnType<typeof calculateUSDCost>;
    expect(() => { r = calculateUSDCost('anthropic:claude-opus-4-7', usage({ input_tokens: 1_000_000 })); }).not.toThrow();
    expect(r.estimated).toBe(true);
    expect(r.costUSD).toBeCloseTo(DEFAULT_FALLBACK_RATE.inputPer1M, 10);
  });

  it('uses concrete Anthropic model rates from provider metadata', () => {
    const opus = calculateUSDCost('anthropic:claude-opus-4-8', usage({
      input_tokens: 1_000_000,
      cached_input_tokens: 100_000,
      output_tokens: 1_000_000,
    }));
    expect(opus.estimated).toBe(false);
    expect(opus.costUSD).toBeCloseTo(0.9 * 5.0 + 0.1 * 0.5 + 25.0, 10);

    expect(calculateUSDCost('anthropic:claude-sonnet-4-6', usage({ input_tokens: 1_000_000 })).estimated).toBe(false);
    expect(calculateUSDCost('anthropic:claude-fable-5', usage({ input_tokens: 1_000_000 })).estimated).toBe(false);
    expect(calculateUSDCost('anthropic:claude-haiku-4-5-20251001', usage({ input_tokens: 1_000_000 })).estimated).toBe(false);
  });

  it('treats a bare (non-provider-qualified) model id as unknown/estimated', () => {
    const r = calculateUSDCost('gpt-5.1', usage({ output_tokens: 1_000_000 }));
    expect(r.estimated).toBe(true);
  });

  it('covers every model in the cost table without throwing', () => {
    for (const key of Object.keys(MODEL_COST_TABLE)) {
      const r = calculateUSDCost(key, usage({ input_tokens: 1000, output_tokens: 1000 }));
      expect(r.estimated).toBe(false);
      expect(Number.isFinite(r.costUSD)).toBe(true);
      expect(r.costUSD).toBeGreaterThan(0);
    }
  });

  it('returns zero cost for empty usage', () => {
    expect(calculateUSDCost('openai:gpt-5.1', usage({})).costUSD).toBe(0);
  });
});

describe('formatCost', () => {
  it('uses 4 dp at/under $0.50 and 2 dp above', () => {
    expect(formatCost(0.1234)).toBe('$0.1234');
    expect(formatCost(1.239)).toBe('$1.24');
  });
});

describe('cost table ↔ catalog coverage', () => {
  // The cost table is hand-coupled to providers/default.json by string
  // convention. A model added to the catalog but missing here silently
  // degrades to DEFAULT_FALLBACK_RATE (estimated=true). Guard that drift.
  it('has a rate for every model in default.json', () => {
    const missing: string[] = [];
    for (const [providerId, provider] of Object.entries(defaultProviders as Record<string, { models?: Array<{ modelKey: string }> }>)) {
      for (const model of provider.models ?? []) {
        const compositeKey = `${providerId}:${model.modelKey}`;
        if (!(compositeKey in MODEL_COST_TABLE)) missing.push(compositeKey);
      }
    }
    expect(missing).toEqual([]);
  });
});
