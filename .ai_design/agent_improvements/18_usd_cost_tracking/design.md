# Track 18: USD Cost Tracking

**Priority: P1** · **Effort: M** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's cost-tracker and browserx's token-usage layer — see "Validation Notes".

## Problem

BrowserX tracks **tokens only**. `core/models/types/TokenUsage.ts` has no cost/USD field anywhere. `core/models/providers/default.json` carries pricing as **heterogeneous display strings**, never a number. Sub-agent (`TaskRunner`) usage is tracked separately and never folded into a single session total. For unattended multi-provider scheduler/server work, there is no cost visibility at all.

## What Claudy Does

`cost-tracker.ts` centers on `addToTotalSessionCost(cost, usage, model)` (`:290-335`):

- `addToTotalModelUsage` (`:262-288`) maintains per-model `ModelUsage { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens }`.
- **Recursively folds sub-agent ("advisor") cost into the parent** (`:316-333`): `for (const advisorUsage of getAdvisorUsage(usage)) { totalCost += addToTotalSessionCost(calculateUSDCost(advisorUsage.model, advisorUsage), advisorUsage, advisorUsage.model) }`.
- Cost comes from `calculateUSDCost(model, usage)` — imported from `utils/modelCost.js`, a **numeric** rate table, *not* parsed from prose.
- `hasUnknownModelCost()` / `setHasUnknownModelCost()` → graceful "costs may be inaccurate due to usage of unknown models" instead of crashing (`:228-233`). **This is the key resilience contract.**
- Persistence: `saveCurrentSessionCosts()` (`:143-175`) writes `lastCost` + per-model `lastModelUsage` + `lastSessionId` to **project config**; `restoreCostStateForSession(sessionId)` (`:130-137`) restores only when `lastSessionId` matches.
- `formatTotalCost()` (`:228-256`): total + API/wall duration + per-model breakdown + **x402 payment summary** (`:237-247`). `getCostCounter()?.add` / `getTokenCounter()?.add` emit OTEL-style metrics with `{model, type}`. `costHook.ts` (23 lines) flushes on exit.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Token shape | `TokenUsage { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens }` (`types/TokenUsage.ts:4-10`) | One cache bucket (`cached_input_tokens`), no creation/read split; **no cost** |
| Aggregation | `aggregateTokenUsage` / `addTokenUsage` / `updateTokenUsageInfo`; `TokenUsageInfo {total_token_usage,last_token_usage,…}` (`:53-92`) | Tokens only |
| Pricing data | `providers/default.json` — `"inputToken": "$0.20 / 1M tokens"`, `"Default: $1.25 / 1M tokens, Cached: $0.125 … | Priority: $2.50 …"`, `"≤200K tokens: $2.00 / 1M, >200K: $4.00 / 1M"`, `"Cache Hit: $0.15 / 1M, Cache Miss: $0.60 / 1M"` | **Heterogeneous prose**, tiered by context size / cache hit-miss / priority — not uniformly machine-parseable |
| Sub-agent usage | `TaskRunner` `tokenUsage`/`tokenBudget`/`aggregateTokenUsage`/`persistTokenUsage` (`TaskRunner.ts:93,228,245,374,456,521`) | Tracked separately, never folded into a session cost |
| Token event | `Session.sendTokenCountEvent` `TokenCount` (see Track 12: `Session.ts:1610` already discards rate-limit data via the same path) | No cost field |

### Key design decisions (and divergences from claudy)

1. **A numeric cost table — do NOT runtime-parse `default.json` prose.** This reverses the first-pass draft. The pricing strings are tiered and inconsistent (context-size tiers, cache hit/miss, priority tier); a runtime parser over them is fragile and will silently misprice. Mirror claudy's `utils/modelCost.ts`: `core/models/cost/modelCostTable.ts` holds **numeric** rates keyed by `provider+model` (`inputPer1M`, `outputPer1M`, `cachedInputPer1M`). A one-time tolerant extractor *may* seed it from `default.json`, but the runtime source of truth is the numeric table, with `hasUnknownModelCost` degradation — never a hot-path string parse.

2. **`CostTracker` mirrors `addToTotalSessionCost`, shaped to browserx's `TokenUsage`.** Per-`provider+model` accumulator over `input_tokens / cached_input_tokens / output_tokens` (+ `reasoning_output_tokens` priced at output rate). **Divergence:** browserx has a single `cached_input_tokens` bucket, not claudy's read/creation split — the table and accumulator model what browserx actually emits, not claudy's Anthropic-Usage shape.

3. **Fold sub-agent cost recursively at the existing TaskRunner seam.** Claudy recurses through `getAdvisorUsage`. BrowserX already aggregates sub-agent tokens in `TaskRunner.aggregateTokenUsage`/`persistTokenUsage` (`TaskRunner.ts:374,456,521`); add a cost rollup at that exact seam so the parent `Session` total is the true number — no parallel path.

4. **Persist per session via the rollout/session store, not "project config."** Browserx has no claudy-style project config. Persist cumulative cost in `SessionState`/rollout keyed by `sessionId` so resume restores it (composes with Track 15's rollout work). Same "restore only if it's this session" guard.

5. **Surface three ways, reusing existing seams.** `/cost` command (Track 03); a `cost` field added to the existing `TokenCount` event (the same `Session.sendTokenCountEvent` path Track 12 must already fix at `Session.ts:1610` — coordinate, one fix); a cost metric via Track 16 telemetry (`{model,type}` attrs, exactly claudy's counter shape). **x402 (Track 23) spend folds into the total** precisely as claudy's `formatTotalCost` appends its x402 section.

6. **`hasUnknownModelCost` graceful degradation is mandatory.** A missing/`unknown` model price yields `cost: undefined` + a surfaced "estimated/partial" flag — never a thrown error in the turn loop. This is the single most important resilience behavior to port.

### Phase plan

- **Phase 1:** `modelCostTable.ts` (numeric, provider+model) + one-time tolerant seeder from `default.json`; `CostTracker` per-session/per-model USD accumulator over browserx `TokenUsage`; `hasUnknownModelCost` degradation.
- **Phase 2:** sub-agent cost fold-in at `TaskRunner` aggregate/persist seam; cumulative-cost persistence in session/rollout store.
- **Phase 3:** `/cost` command + `cost` on the `TokenCount` event (shared fix with Track 12) + Track 16 cost metric; x402 (Track 23) spend folded into the total.

## Dependencies

- **Track 01** (Events): `cost` rides the existing `TokenCount`/event path
- **Track 12** (Rate-Limit): **shares the `Session.ts:1610` `sendTokenCountEvent` fix** — do it once, carry both rate-limit + cost
- **Track 03** (Commands): `/cost`, `/usage`
- **Track 16** (Telemetry): cost metric counter (`{model,type}`)
- **Track 23** (x402): payment spend folds into the total (mirrors claudy `formatTotalCost`)
- **Track 15** (Rewind/rollout): cumulative-cost persistence rides the session/rollout store

## Risks

- Pricing drift / format zoo: the prose tiers (context-size, cache hit/miss, priority) mean a single rate per model is an approximation — model `cachedInputPer1M` explicitly; treat tier nuances as best-effort and flag `hasUnknownModelCost` liberally rather than misreport precisely.
- Multi-provider: rates differ per provider — key the table by `provider+model`, never model alone.
- Double counting sub-agents: fold at exactly one seam (`TaskRunner` persist) — pin with a test that a sub-agent's tokens appear once in the parent total.
- Never crash a turn on missing price (above) — the degradation contract is non-negotiable.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `cost-tracker.ts:48` (`calculateUSDCost` from numeric `utils/modelCost.js`), `:262-288` (`addToTotalModelUsage` per-model shape), `:290-335` (`addToTotalSessionCost` + recursive advisor fold `:316-333`), `:130-175` (project-config persistence keyed by `lastSessionId`), `:228-256` (`formatTotalCost` incl. x402 + unknown-cost notice), `:303-313` (OTEL counters); `costHook.ts` (exit flush).
- browserx: `core/models/types/TokenUsage.ts:4-92` (`TokenUsage` single cache bucket, aggregation helpers, **no cost**); `core/models/providers/default.json:38-303` (pricing as heterogeneous tiered prose); `core/TaskRunner.ts:93,228,245,374,456,521` (sub-agent token usage tracked separately, the fold seam); Track 12 doc / `core/Session.ts:1610` (shared `sendTokenCountEvent` fix).

Corrections vs the first-pass draft:
1. **Reversed the core approach:** the draft said "parse the existing pricing JSON → USD". Reading `default.json` showed the strings are tiered/inconsistent prose; claudy itself uses a *numeric* table (`utils/modelCost.ts`), not parsing. The design now uses a numeric table with at most a one-time seeder — no hot-path parse.
2. browserx `TokenUsage` has **one** `cached_input_tokens` bucket, not claudy's read/creation split — the accumulator/table is shaped to browserx's real emission, not claudy's Anthropic `Usage`.
3. Persistence is the rollout/session store, not "project config" (browserx has none) — composes with Track 15.
4. The cost event is the **same** `sendTokenCountEvent`/`Session.ts:1610` fix Track 12 needs — explicitly shared, not a second event path.
