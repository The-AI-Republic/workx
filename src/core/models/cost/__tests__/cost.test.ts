// File: src/core/models/cost/__tests__/cost.test.ts
//
// Track 18 — USD cost calculator: cached-subset formula, the >= 0 clamp,
// reasoning-at-output-rate, and unknown-key degradation (number + flag,
// never throw).

import { describe, it, expect } from 'vitest';
import { calculateUSDCost, formatCost, formatCostSummary } from '../cost';
import { MODEL_COST_TABLE, DEFAULT_FALLBACK_RATE } from '../modelCostTable';
import type { TokenUsage } from '../../types/TokenUsage';

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

describe('formatCost / formatCostSummary', () => {
  it('uses 4 dp at/under $0.50 and 2 dp above', () => {
    expect(formatCost(0.1234)).toBe('$0.1234');
    expect(formatCost(1.239)).toBe('$1.24');
  });

  it('summary shows total, per-model breakdown and an estimated marker', () => {
    const out = formatCostSummary([
      { providerModelKey: 'openai:gpt-5.1', costUSD: 1.5, estimated: false },
      { providerModelKey: 'anthropic:claude', costUSD: 0.25, estimated: true },
    ]);
    expect(out).toContain('Total cost: $1.75');
    expect(out).toContain('≈ estimated');
    expect(out).toContain('openai:gpt-5.1: $1.50');
    expect(out).toContain('anthropic:claude: $0.2500 ≈');
  });

  it('folds an x402 spend line into the total', () => {
    const out = formatCostSummary([{ providerModelKey: 'openai:gpt-5.1', costUSD: 1.0, estimated: false }], { x402USD: 0.5 });
    expect(out).toContain('Total cost: $1.50');
    expect(out).toContain('x402 payments: $0.5000');
  });
});
