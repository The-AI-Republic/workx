/**
 * USD cost calculator — Track 18.
 *
 * Pure functions over the numeric `MODEL_COST_TABLE`. No accumulation state:
 * workx's cost accumulators are `TokenUsageStore` (durable per-record
 * history) and `SessionState` (live cumulative) — a parallel singleton would
 * be a competing source of truth.
 */

import type { TokenUsage } from '../types/TokenUsage';
import { MODEL_COST_TABLE, DEFAULT_FALLBACK_RATE, type ModelRate } from './modelCostTable';

export interface CostResult {
  /** USD for this usage. Always a finite number (best-effort when estimated). */
  costUSD: number;
  /** true when the model was absent and DEFAULT_FALLBACK_RATE was used. */
  estimated: boolean;
}

/**
 * Compute USD cost for a `TokenUsage` under a `"providerId:modelId"` key.
 *
 * Invariant (verified across every workx model client — all OpenAI-family,
 * no Anthropic-native client exists): `cached_input_tokens` is a SUBSET of
 * `input_tokens`. So uncached input = `max(0, input - cached)` (clamp guards
 * a provider ever reporting cached > prompt). `reasoning_output_tokens` is
 * billed at the output rate. Unknown key → `DEFAULT_FALLBACK_RATE` +
 * `estimated: true`; never throws, never returns undefined (a turn must not
 * crash on a missing price — this is what keeps a Track 12 fallback job's
 * budget cap honest instead of blind).
 */
export function calculateUSDCost(providerModelKey: string, usage: TokenUsage): CostResult {
  const known = MODEL_COST_TABLE[providerModelKey];
  const rate: ModelRate = known ?? DEFAULT_FALLBACK_RATE;
  const uncachedInput = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
  const costUSD =
    (uncachedInput / 1_000_000) * rate.inputPer1M +
    (usage.cached_input_tokens / 1_000_000) * rate.cachedInputPer1M +
    ((usage.output_tokens + usage.reasoning_output_tokens) / 1_000_000) * rate.outputPer1M;
  return { costUSD, estimated: known === undefined };
}

/** claudy-style USD formatting: ≤ $0.50 → 4 dp, above → 2 dp. */
export function formatCost(costUSD: number): string {
  return '$' + (costUSD > 0.5 ? costUSD.toFixed(2) : costUSD.toFixed(4));
}
