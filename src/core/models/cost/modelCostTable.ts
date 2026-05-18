/**
 * Numeric USD cost table — Track 18.
 *
 * The runtime source of truth for model pricing. `providers/default.json`
 * carries pricing as heterogeneous human-readable prose
 * (`"$0.20 / 1M tokens"`, `"Default: $1.25 …, Cached: $0.125 …"`,
 * `"≤200K tokens: $2.00 / 1M, >200K tokens: $4.00 / 1M"`,
 * `"Cache Hit: $0.15 …, Cache Miss: $0.60 …"`) which must never be parsed on
 * a hot path. This table holds the equivalent **numbers**, hand-authored from
 * that prose, keyed by the composite `"providerId:modelId"` exactly as
 * produced by `TurnContext.getSelectedModelKey()`.
 */

export interface ModelRate {
  /** USD per 1M non-cached input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. `reasoning_output_tokens` is priced here too. */
  outputPer1M: number;
  /**
   * USD per 1M cached input tokens. `cached_input_tokens` is a *subset* of
   * `input_tokens` across all browserx clients, so cost.ts charges
   * `(input - cached)` at `inputPer1M` and `cached` at this rate. Providers
   * with no cache discount set this == `inputPer1M` (net == full input rate).
   */
  cachedInputPer1M: number;
}

/**
 * Keyed by `"providerId:modelId"` (the provider id is the top-level key in
 * `providers/default.json`; the model id is its `modelKey`). Tiered prose is
 * collapsed to the base tier: context-size tiers → the ≤200K rate; OpenAI
 * `Default`/`Priority` → `Default`; `Cache Hit`/`Cache Miss` → cached/input.
 * A larger-context or priority-tier request is therefore an under-estimate
 * flagged by neither `estimated` (the model *is* known) nor a crash — an
 * accepted approximation (see design Risks).
 */
export const MODEL_COST_TABLE: Record<string, ModelRate> = {
  // xai — flat, no cache discount
  'xai:grok-4-1-fast-reasoning': { inputPer1M: 0.2, outputPer1M: 0.5, cachedInputPer1M: 0.2 },

  // openai — Default tier (Priority tier intentionally not modeled)
  'openai:gpt-5.1': { inputPer1M: 1.25, outputPer1M: 10.0, cachedInputPer1M: 0.125 },
  'openai:gpt-5.2': { inputPer1M: 1.75, outputPer1M: 14.0, cachedInputPer1M: 0.175 },

  // google-ai-studio — ≤200K base tier; client always reports cached=0
  'google-ai-studio:gemini-3-pro-preview': { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 2.0 },
  'google-ai-studio:gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0, cachedInputPer1M: 1.25 },

  // moonshot — Cache Miss = input rate, Cache Hit = cached rate
  'moonshot:kimi-k2-thinking': { inputPer1M: 0.6, outputPer1M: 2.5, cachedInputPer1M: 0.15 },
  'moonshot:kimi-k2-thinking-turbo': { inputPer1M: 1.15, outputPer1M: 8.0, cachedInputPer1M: 0.15 },

  // fireworks
  'fireworks:accounts/fireworks/models/kimi-k2-thinking': { inputPer1M: 0.6, outputPer1M: 2.5, cachedInputPer1M: 0.6 },
  'fireworks:accounts/fireworks/models/kimi-k2p5': { inputPer1M: 0.6, outputPer1M: 0.3, cachedInputPer1M: 0.1 },

  // together
  'together:moonshotai/Kimi-K2-Thinking': { inputPer1M: 1.2, outputPer1M: 4.0, cachedInputPer1M: 1.2 },
};

/**
 * Rate used when a `"providerId:modelId"` is absent — e.g. a Track 12
 * rate-limit downgrade to a model not in the table, or a config the table
 * has not caught up with. Deliberately conservative-high so unattended
 * budget caps fail *safe* (over- rather than under-estimate) instead of
 * going blind. Always paired with `estimated: true`.
 */
export const DEFAULT_FALLBACK_RATE: ModelRate = { inputPer1M: 2.0, outputPer1M: 10.0, cachedInputPer1M: 0.5 };
