# Track 18 — Tasks

Implements [Track 18: USD Cost Tracking](./design.md). All `path:line` are
code-verified vs `HEAD` d1ac8c46 (see design "Validation Notes"). Paths are
relative to `src/`. Track 18's core value (Phases 1–4) is **independent of
Track 12**; only the optional Phase-3 `TokenCount` rider (3.6) coordinates with
Tracks 12/25 — see the note there.

## Phase 1 — Cost table + calculator + degradation (pure core, no deps)

- [ ] 1.1 New `core/models/cost/modelCostTable.ts`: `ModelRate = { inputPer1M:
      number; outputPer1M: number; cachedInputPer1M: number }`;
      `MODEL_COST_TABLE: Record<"providerId:modelId", ModelRate>` hand-authored
      from every model's prose in `core/models/providers/default.json`
      (`cachedInputPer1M` ← the cheaper "cached"/"cache-hit" figure);
      `DEFAULT_FALLBACK_RATE: ModelRate`. Key strings exactly match
      `TurnContext.getSelectedModelKey()` format `"providerId:modelId"`
      (`TurnContext.ts:284-290`). **No per-provider cached-semantics map**
      (Decision 2 — uniformly subset).
- [ ] 1.2 New `core/models/cost/cost.ts`: `calculateUSDCost(providerModelKey:
      string, usage: TokenUsage): { costUSD: number; estimated: boolean }`.
      Formula (Decision 2, fixed): `Math.max(0, input_tokens −
      cached_input_tokens)/1e6·inputPer1M + cached_input_tokens/1e6·cachedInputPer1M
      + (output_tokens + reasoning_output_tokens)/1e6·outputPer1M`. Unknown key ⇒
      `DEFAULT_FALLBACK_RATE` + `estimated:true` (never `undefined`, never throw —
      Decision 6).
- [ ] 1.3 In `cost.ts` add `formatCostSummary(rows, opts?)` → claudy
      `formatTotalCost` shape: total USD, API/wall duration, per-`provider:model`
      breakdown, optional x402 line; `≈ $X (estimated)` when any row estimated.
      Pure, no singleton (Decision 3/5 — accumulators are `TokenUsageStore` +
      `SessionState`, not a parallel `CostTracker`).
- [ ] 1.4 Optional dev-only `scripts/seedModelCostTable.ts`: tolerant prose
      extractor to bootstrap 1.1's literals. **Not imported on any runtime path.**
- [ ] 1.5 Tests (`core/models/cost/__tests__/cost.test.ts`): cached-subset
      subtraction + `≥ 0` clamp; reasoning priced at output rate; unknown key ⇒
      number + `estimated:true` + no throw; known key matches a hand-computed
      figure; fallback rate applied.

## Phase 2 — Compute per-turn, fold once, persist (core)

- [ ] 2.1 `TurnManager.ts`: add `turnCostUSD?: number` + `turnCostEstimated?:
      boolean` to `TurnRunResult` (`:64-68`). At `case 'Completed'` (`:313-315`),
      after `totalTokenUsage = event.tokenUsage`, call `calculateUSDCost(
      this.turnContext.getSelectedModelKey(), event.tokenUsage)` and carry the
      result onto the returned `TurnRunResult`.
- [ ] 2.2 `TaskRunner.runLoop`: alongside the existing `totalTokenUsage`
      accumulation (`:373-376`), accumulate `totalCostUSD += turnResult.turnCostUSD
      ?? 0` and OR `costEstimated`. Thread both into `LoopOutcome` next to
      `buildLoopOutcome` (`:443-454`).
- [ ] 2.3 `storage/types.ts:5-39`: add `costUSD: number`, `costEstimated?:
      boolean`, `provider_model: string` to `TokenUsageRecord`; add `costUSD`
      (sum) to `SessionUsageSummary` + `DailyUsageSummary`.
- [ ] 2.4 `TaskRunner.persistTokenUsage` (`:537-559`): on the `TokenUsageRecord`
      built at `:540-552` set `costUSD`/`costEstimated` from the 2.2 rollup and
      `provider_model = this.turnContext.getSelectedModelKey()`; keep `model =
      getModel()` for back-compat (`:544`). Single construction site → folds once;
      called once per task (`emitTaskComplete:534` **xor** aborted-path `:245`).
- [ ] 2.5 `SessionState` (`session/state/SessionState.ts`): add private
      `cumulativeCostUSD?: number` + `hasUnknownModelCost?: boolean`; methods
      `addCost(usd, estimated)` / `getCostInfo()`; add both to
      `SessionStateExport` (`:12-22`), `export()` (`:271-287`), `import()`
      (`:294-334`) — mirror the existing `tokenInfo` handling exactly. Resume
      restores via `import()`.
- [ ] 2.6 Add `Session.addCost(usd, estimated)` delegating to `sessionState`.
      Call it from `TaskRunner.persistTokenUsage` via the already-held
      `this.session` (verified in scope: `this.session.getSessionId()` `:541-542`)
      — **same single seam as 2.4**, no parallel path. Restore guard keys off
      conversation id so a Track-15 fork starts a fresh accumulator (Decision 7).
- [ ] 2.7 Tests: parent + 2 sub-agents ⇒ exactly 3 `TokenUsageRecord`s; summed
      `costUSD` == expected; parent record's cost excludes sub-agent cost
      ("counted once" pin); `SessionState` round-trips `cumulativeCostUSD` through
      export→import; fork does not inherit parent total.

## Phase 3 — Surfaces (shared `webfront`, live path)

- [ ] 3.1 `protocol/events.ts`: add `cost_usd?: number` + `cost_estimated?:
      boolean` to `TaskCompleteEvent` (`:229-240`).
- [ ] 3.2 `TaskRunner.emitTaskComplete` (`:512-535`): set `data.cost_usd` /
      `data.cost_estimated` from the 2.2 rollup, beside the existing
      `data.token_usage` block (`:521-526`). This is the **live** carrier every
      consumer reads (Decision 3 — no recompute downstream).
- [ ] 3.3 `webfront/components/event_display/EventProcessor.ts`: in the
      `TaskComplete` case (`:353-379`) read `msg.data.cost_usd` into
      `EventMetadata`; render `$X` / `≈ $X (estimated)`. Add `cost?: number` to
      `EventMetadata.tokenUsage` (`src/types/ui.ts:115-136`) and surface in
      `webfront/components/event_display/TaskEvent.svelte:40-44` (respect the
      existing `showTokenUsage` toggle).
- [ ] 3.4 `/cost` + `/usage` commands: in `webfront/commands/builtinCommands.ts`
      register two builtin commands (registry has no alias field — register both;
      idempotent via the existing `has()` guard), `action: () => push('/usage')`
      (route exists, `webfront/App.svelte:43`).
- [ ] 3.5 `webfront/stores/usageStore.ts` + `pages/usage/Usage.svelte` +
      `components/usage/UsageList.svelte` + `UsageChart.svelte`: sum the new
      `TokenUsageRecord.costUSD` for cumulative USD + per-`provider:model` +
      per-day cost; show an "estimated" badge when any row is estimated.
- [ ] 3.6 **Optional rider — coordinate with Track 12 (do NOT repair the dead
      stubs here unless 18 lands before 12).** Add `cost?: number` to
      `TokenCountEvent` (`protocol/events.ts:255-258`); populate `msg.data.cost`
      in `Session.sendTokenCountEvent` (`Session.ts:1611-1627`). If Track 12 has
      landed its Step 3 (un-stub `:1613`/`:1614`, add `SessionState.getRateLimits()`,
      add `toRateLimitSnapshotEvent`), this is purely additive. If Track 18
      precedes Track 12, Track 18 must perform Track-12 Step 3 in full as a
      prerequisite (getter + adapter + both stubs) — it cannot just touch `:1614`.
- [ ] 3.7 Telemetry (only if Track 16 exists): `logEvent('cost', { costUSD,
      estimated })` — numeric/boolean metadata only; encode model via a numeric
      id/hash or the explicit `… as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
      cast (Track 16 marker-type discipline). Not a Track 18 blocker.
- [ ] 3.8 Tests: `TaskCompleteEvent` carries `cost_usd`; `EventProcessor`
      renders it (and the estimated badge); `usageStore` cumulative/by-model/
      by-day sums correct; `/cost` + `/usage` both resolve to the `/usage` route.

## Phase 4 — Server per-job cost + budget cap (headless)

- [ ] 4.1 `core/models/types/Scheduler.ts:35-48`: add `costUSD: number`
      (required) + `costEstimated?: boolean` to `JobResultRecord`. **No signature
      change** to `Scheduler.completeJob` / `JobExecutor.completeExecution` — the
      record persists as the opaque JSON blob (`ServerExecutionStorage`
      `:78,:108,:208-226`), **zero DDL / no migration framework needed**.
- [ ] 4.2 `ServerAgentBootstrap.handleSchedulerEventCompletion` (`:692-726`):
      between `:702`–`:703` read `data.cost_usd` / `data.cost_estimated` off the
      `TaskComplete` payload (do **not** recompute — Decision 3); add them to the
      `JobResultRecord` literal (`:703-710`). Optionally capture last-known
      cumulative on the failure/abort branch (`:714-725`) before `failJob`.
- [ ] 4.3 Mirror 4.2 **byte-for-byte** in
      `DesktopAgentBootstrap.ts:662-696` (`:672-680`).
- [ ] 4.4 Pass-through call sites compile unchanged (`server/handlers/scheduler.ts:125`,
      `core/services/scheduler-services.ts:64`); optionally add `costUSD`
      validation there for defense.
- [ ] 4.5 Budget cap (MVP, post-hoc, no migration): add `server.limits.maxUsdPerDay?`
      (+ optional `maxUsdPerJob?`) to `ServerConfigSchema`
      (`server/config/server-config.ts:75-94`); read via `getServerConfig()`,
      hot-reload via the already-wired `onConfigReload`
      (`ServerAgentBootstrap.ts:322`). After `completeJob`, sum today's
      `result.costUSD` over `ServerExecutionStorage.getExecutionsInRange(
      startOfDay, now)`. On breach: `Scheduler.pauseJobQueue()` (or refuse the
      next `launchJob`) **and** `emitLog('warn', 'budget_cap_exceeded', { date,
      totalUSD, capUSD })` (`server/handlers/logs.ts:39` → `logs.tail`).
- [ ] 4.6 x402 seam (Track 23, flag-gated/off by default): `SessionState`
      `addExternalSpend(usd)` reusing the 2.5 `addCost` path (flagged); when x402
      is enabled its per-payment USD folds into the same cumulative total + the
      per-job `JobResultRecord.costUSD` + the 4.5 sum. No-op when x402 disabled —
      Track 18 must not assume x402 exists.
- [ ] 4.7 Mid-run abort (documented extension, NOT MVP): once the 3.6 rider fires
      per-turn server-side, a monitor holding `runningSchedulerJobId` calls
      `Scheduler.cancelJob(runningSchedulerJobId)` → `JobExecutor.cancelExecution`
      → clean `Session.terminate('manual')` (yields distinct `cancelled` status).
      Never throw into the turn. Sequence after Track 12.
- [ ] 4.8 Tests: `TaskComplete.cost_usd` → `JobResultRecord.costUSD` persisted &
      read back from the JSON blob (old rows ⇒ `undefined`, tolerated); per-day
      sum over `getExecutionsInRange` triggers `pauseJobQueue` + `emitLog` exactly
      at the cap; desktop twin parity; estimated cost still enforces the cap.

## Exit criteria

- A numeric `provider:model` cost table is the runtime source of truth; no prose
  parsing on any hot path; unknown/fallback model ⇒ best-effort number +
  `estimated`, never `undefined`/throw.
- One cost computation (at `TurnManager.ts:315`), folded once at
  `TaskRunner.persistTokenUsage`, summed at read time — parent total provably
  excludes sub-agent cost (the "counted once" test is green).
- `TaskCompleteEvent` carries `cost_usd`; the shared `webfront` renders live cost
  + the estimated badge; `/cost`/`/usage` open the usage view with cumulative,
  per-model and per-day USD.
- `SessionState` persists `cumulativeCostUSD` and restores it on resume; a
  Track-15 fork starts a fresh accumulator (no inherited total).
- Server per-job cost lands in `JobResultRecord` (zero DDL); a per-day USD cap
  pauses the queue and emits a `logs.tail`-visible warning before overspend; the
  desktop bootstrap twin is in parity.
- No second cost calculator anywhere (esp. not server-side); `cost` is never a
  field inside `TokenUsage`; `npm run type-check` + `npm test` green.
