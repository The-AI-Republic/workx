# Track 18: USD Cost Tracking

**Priority: P1** · **Effort: M** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's cost-tracker and browserx's token-usage + scheduler layers across all three deploy targets — see "Validation Notes".

## Problem

BrowserX tracks **tokens only**. `core/models/types/TokenUsage.ts` has no cost/USD field anywhere. `core/models/providers/default.json` carries pricing as **heterogeneous display strings**, never a number. Sub-agent (`TaskRunner`) usage is tracked separately and never folded into a single session total. For unattended multi-provider scheduler/server work there is no cost visibility at all — a runaway scheduled job, or a Track 12 rate-limit fallback that silently switches to a pricier model, burns money invisibly on Apple Pi Server.

## What Claudy Does

`cost-tracker.ts` centers on `addToTotalSessionCost(cost, usage, model)` (`:290-335`):

- `addToTotalModelUsage` (`:262-288`) maintains per-model `ModelUsage { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens }`.
- **Recursively folds sub-agent ("advisor") cost into the parent** (`:316-333`): `for (const advisorUsage of getAdvisorUsage(usage)) { totalCost += addToTotalSessionCost(calculateUSDCost(advisorUsage.model, advisorUsage), advisorUsage, advisorUsage.model) }`.
- Cost from `calculateUSDCost(model, usage)` — imported from `utils/modelCost.js`, a **numeric** rate table, *not* parsed from prose.
- `hasUnknownModelCost()` / `setHasUnknownModelCost()` → graceful "costs may be inaccurate due to usage of unknown models" instead of crashing (`:228-233`). **The key resilience contract.**
- Persistence: `saveCurrentSessionCosts()` (`:143-175`) writes `lastCost` + per-model `lastModelUsage` + `lastSessionId` to **project config**; `restoreCostStateForSession(sessionId)` (`:130-137`) restores only when `lastSessionId` matches.
- `formatTotalCost()` (`:228-256`): total + API/wall duration + per-model breakdown + **x402 payment summary** (`:237-247`). `getCostCounter()?.add`/`getTokenCounter()?.add` emit OTEL-style metrics with `{model,type}`. `costHook.ts` (23 lines) flushes on exit.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Token shape | `TokenUsage { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens }` (`types/TokenUsage.ts:4-10`) | One cache bucket; **no cost** |
| Aggregation | `aggregateTokenUsage`/`addTokenUsage`/`updateTokenUsageInfo`; `TokenUsageInfo` (`:53-92`) | Tokens only |
| Pricing data | `providers/default.json` — `"$0.20 / 1M tokens"`, `"Default: $1.25 …, Cached: $0.125 … | Priority: $2.50 …"`, context-size + cache hit/miss + priority tiers | **Heterogeneous prose**, not uniformly machine-parseable |
| Sub-agent usage | `TaskRunner` `tokenUsage`/`aggregateTokenUsage`/`persistTokenUsage` (`TaskRunner.ts:93,228,245,374,456,521`) | Tracked separately, never folded |
| Token event | `Session.sendTokenCountEvent` `TokenCount` (Track 12: `Session.ts:1614` discards rate-limit data via the same path) | No cost field |
| Server per-job seam | `handleSchedulerEventCompletion` reads `data.token_usage.total` → `scheduler.completeJob(jobId,{tokenUsage,…})` (`ServerAgentBootstrap.ts:692-726`, esp. `:702-710`) | **Already carries token usage per job — extend to carry cost** |

### Per-Platform Behavior

The accumulator + numeric table is **pure core**, identical everywhere. What differs is *surfacing* and the *operational stakes*.

- **BrowserX (extension)** & **Apple Pi (desktop).** Surface: shared `webfront` `/cost` command + the `cost` field on the `TokenCount` event; persisted in the IndexedDB (ext) / Tauri (desktop) session/rollout store. Cost is benign, PII-free metadata, so the Track 16 cost metric is low-risk to emit. Value: a human running long browsing automation sees spend live. One implementation (shared `webfront`).
- **Apple Pi Server (headless).** The high-stakes target. Unattended multi-provider scheduler jobs currently have **zero** cost visibility, and Track 12's rate-limit fallback can silently swap in a costlier model mid-run. Three server-specific behaviors: **(a)** cost flows through the existing `emitLog`/`logs.tail` via Track 16's `ServerLogSink` so operators watch per-job spend in the same stream they already tail; **(b)** **per-job cost attribution** — extend `handleSchedulerEventCompletion` (`ServerAgentBootstrap.ts:702-710`), which already extracts `token_usage.total` and passes `tokenUsage` to `scheduler.completeJob`, to also compute and pass `costUSD`, so `ServerExecutionStorage` execution records carry cost → per-job/per-day cost history; **(c)** an optional **USD budget cap** (per-job or per-day) that, when exceeded, aborts/pauses the unattended job — composes with Track 12 (unattended loop) and Track 20 (the cap is a managed-policy key). This per-job attribution + cap is net-new value that only exists, and only matters, on the headless server.

### Key design decisions (and divergences from claudy)

1. **A numeric cost table — do NOT runtime-parse `default.json` prose.** Reverses the first-pass draft. The strings are tiered/inconsistent (context-size, cache hit/miss, priority); a runtime parser will silently misprice. Mirror claudy's `utils/modelCost.ts`: `core/models/cost/modelCostTable.ts` holds **numeric** rates keyed by `provider+model` (`inputPer1M`, `outputPer1M`, `cachedInputPer1M`). A one-time tolerant extractor *may* seed it from `default.json`; the runtime source of truth is the numeric table, with `hasUnknownModelCost` degradation — never a hot-path string parse.
2. **`CostTracker` mirrors `addToTotalSessionCost`, shaped to browserx's `TokenUsage`.** Per-`provider+model` accumulator over `input_tokens / cached_input_tokens / output_tokens` (+ `reasoning_output_tokens` at output rate). **Divergence:** browserx has a single `cached_input_tokens` bucket, not claudy's read/creation split — model what browserx emits.
3. **Fold sub-agent cost recursively at the existing TaskRunner seam.** BrowserX already aggregates sub-agent tokens in `TaskRunner.aggregateTokenUsage`/`persistTokenUsage` (`TaskRunner.ts:374,456,521`); add a cost rollup at that exact seam so the parent `Session` total is the true number — no parallel path.
4. **Persist per session via the rollout/session store, not "project config."** BrowserX has no claudy-style project config. Persist cumulative cost in `SessionState`/rollout keyed by `sessionId`; resume restores it (composes with Track 15). Same "restore only if it's this session" guard.
5. **Surface, reusing existing seams.** `/cost` command (Track 03, shared `webfront`); a `cost` field on the existing `TokenCount` event (**the same `Session.sendTokenCountEvent`/`Session.ts:1614` fix Track 12 needs — one fix, both consumers**); a Track 16 cost metric (`{model,type}`, claudy's counter shape); server per-job cost via the scheduler-completion seam; x402 (Track 23) spend folded into the total exactly as claudy's `formatTotalCost` appends its x402 section.
6. **`hasUnknownModelCost` graceful degradation is mandatory.** A missing/`unknown` price → `cost: undefined` + a surfaced "estimated/partial" flag — never a thrown error in the turn loop. **Composition with Track 12:** a rate-limit *fallback model* may not be in the table; this contract is exactly what keeps a downgraded unattended job running (cost flagged estimated, not crashed).

## Implementation Plan (file-level, ordered)

**Phase 1 — table + tracker + degradation.**
- `core/models/cost/modelCostTable.ts`: numeric rates keyed `provider+model`; `calculateUSDCost(providerModel, TokenUsage)`; `hasUnknownModelCost`/`setHasUnknownModelCost`. Optional one-time `seedFromDefaultJson()` (tolerant; not on the hot path).
- `core/models/cost/CostTracker.ts`: per-`provider+model` USD accumulator over browserx `TokenUsage`; `reasoning_output_tokens` priced at output rate.

**Phase 2 — fold-in + persistence.**
- Cost rollup at `TaskRunner.aggregateTokenUsage`/`persistTokenUsage` (`TaskRunner.ts:374,456,521`) so sub-agent cost lands once in the parent total (pin with a "counted once" test).
- Cumulative cost persisted in `SessionState`/rollout keyed by `sessionId`; restore-if-same-session guard (composes with Track 15).

**Phase 3 — surfaces.**
- Add `cost` to the `TokenCount` event in `Session.sendTokenCountEvent` — coordinate as the **single** `Session.ts:1614` fix with Track 12 (rate-limit snapshot + cost ride out together).
- `/cost` (`/usage`) Track 03 command → shared `webfront` view (ext + desktop).
- Track 16 cost metric counter (`{model,type}`).

**Phase 4 — server per-job cost + budget cap (headless).**
- Extend `handleSchedulerEventCompletion` (`ServerAgentBootstrap.ts:702-710`): compute `costUSD` from the job's accumulated usage; pass it through `scheduler.completeJob`; widen the `ServerExecutionStorage` execution record to store it → per-job/per-day cost history.
- Optional USD budget cap (per-job/per-day): a Track 20 managed-policy key checked in the unattended loop; on breach, abort/pause the job and emit a surfaced event (composes with Track 12's unattended path).
- x402 (Track 23) spend folded into the total (mirrors claudy `formatTotalCost`).

## Dependencies

- **Track 01** (Events): `cost` rides the existing `TokenCount`/event path.
- **Track 12** (Rate-Limit): **shares the `Session.ts:1614` `sendTokenCountEvent` fix**; downgrade/fallback model cost is exactly what `hasUnknownModelCost` must tolerate.
- **Track 03** (Commands): `/cost`, `/usage`.
- **Track 16** (Telemetry): cost metric counter; server cost flows via its `ServerLogSink`.
- **Track 23** (x402): payment spend folds into the total.
- **Track 15** (Rewind/rollout): cumulative-cost persistence rides the session/rollout store.
- **Track 20** (Managed Settings): per-job/per-day USD budget cap is a policy key.

## Risks

- Pricing drift / format zoo: prose tiers (context-size, cache hit/miss, priority) make a single rate an approximation — model `cachedInputPer1M` explicitly; flag `hasUnknownModelCost` liberally rather than misreport precisely.
- Multi-provider: rates differ per provider — key the table by `provider+model`, never model alone.
- Double counting sub-agents: fold at exactly one seam (`TaskRunner` persist) — pin with a test.
- Never crash a turn on missing price — the degradation contract is non-negotiable (and is what keeps a Track 12 fallback job alive).
- Budget-cap safety: a cap that aborts mid-job must do so cleanly through the unattended loop's abort path, not by throwing in the turn — and must be policy-overridable so it can't strand a critical job.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `cost-tracker.ts:48,228-256,262-288,290-335,316-333,130-175,303-313`; `costHook.ts`.
- browserx core: `core/models/types/TokenUsage.ts:4-92`; `core/models/providers/default.json:38-303`; `core/TaskRunner.ts:93,228,245,374,456,521`; `core/Session.ts:1614` (shared `sendTokenCountEvent` fix).
- browserx platforms: server `src/server/agent/ServerAgentBootstrap.ts:692-726` (`handleSchedulerEventCompletion`), esp. `:702-710` (`token_usage.total` → `scheduler.completeJob({tokenUsage,…})` — the per-job cost extension point); `src/server/scheduler/ServerExecutionStorage.ts` (execution record to widen); shared `webfront` `/cost` view (ext + desktop).

Corrections vs the first-pass draft:
1. **Reversed the core approach:** numeric table (claudy's `utils/modelCost.ts` model), not runtime prose parsing of `default.json`.
2. browserx `TokenUsage` has **one** `cached_input_tokens` bucket — accumulator/table shaped to browserx's real emission.
3. Persistence is the rollout/session store, not "project config".
4. The cost event is the **same** `sendTokenCountEvent`/`Session.ts:1614` fix Track 12 needs — explicitly shared.
5. **Multi-platform (2026-05-15):** the strongest payoff is on Apple Pi Server — per-job cost attribution via the existing `handleSchedulerEventCompletion`→`completeJob` seam (already carries token usage), a USD budget cap for unattended jobs, and cost flowing through the existing `logs.tail`/`ServerLogSink`. Composition with Track 12: a fallback/downgrade model is precisely the `hasUnknownModelCost` case, which is what keeps a downgraded unattended job from crashing.

## Forward-Trace Verification (2026-05-15)

- ✅ **Holds:** the sub-agent cost fold-in seam is real and precise — `TaskRunner` `outcome.tokenUsage` (`:227-229`) → `this.persistTokenUsage(outcome.tokenUsage.total, outcome.turnCount)` (`:245`). Folding USD there is exactly one seam, no parallel path. Server per-job seam `handleSchedulerEventCompletion`→`scheduler.completeJob({tokenUsage})` re-confirmed. claudy's numeric `modelCost.ts:177 calculateUSDCost` (vs prose `default.json`) re-confirmed — the decision-1 reversal is correct.
- ⚠️ **Shared prerequisite — `SessionState.getRateLimits()`:** the Phase-3 `cost`-on-`TokenCount` fix rides the **same `Session.ts:1614` + new `SessionState.getRateLimits()` getter** as Tracks 12/25. Forward-traced: the getter is *absent* and must be added (definitively, not "if present"). One getter, three consumers — coordinate so it lands once.
- Net effort unchanged (**M**); no track-invalidating surprise.
