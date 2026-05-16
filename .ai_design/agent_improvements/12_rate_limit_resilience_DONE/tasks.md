# Track 12 — Tasks

Implements [Track 12: Rate-Limit Resilience](./design.md). All `path:line` are
code-verified vs `HEAD` bd34246a (see design "Code-Verification Audit"). Paths are
relative to `src/`. Sequence with **Track 25** (shared `TurnManager` boundary +
classification + circuit breaker — land together).

## Phase 0 — Delete the decoy (P0)

- [ ] 0.1 Delete `core/models/RequestQueue.ts` and
      `core/models/__tests__/RequestQueue.test.ts`.
- [ ] 0.2 Remove barrel re-exports `core/models/index.ts:43,46,48`
      (`RequestQueue`, `RateLimitConfig as RequestQueueRateLimitConfig`).
- [ ] 0.3 In `core/models/client/OpenAIResponsesClient.ts` remove: import `:31`,
      field `:124-125`, instantiation block `:227-233`, and status/pause/clear refs
      `:1433-1434,1449-1454,1463,1470-1471`.
- [ ] 0.4 `grep -rn RequestQueue src` is empty; `npm run type-check` + existing model
      tests green.

## Phase 1 — Orchestrator + classification + test seam (P0 correctness)

- [ ] 1.1 New `core/models/resilience/withRetry.ts`: plain async fn (no generator).
      Constants: `DEFAULT_MAX_RETRIES`, `MAX_529_RETRIES=3`, `BASE_DELAY_MS=500`,
      `PERSISTENT_MAX_BACKOFF_MS=5min`, `RESET_CAP_MS=6h`, chunk=30s.
- [ ] 1.2 `classify(error)` off `instanceof RateLimitError`
      (`ModelClientError.ts:61-89`) + `error.statusCode` (429 / 529 / ≥500) +
      `retryAfter`. **Do not import or modify `StreamAttemptError` (dead code).**
- [ ] 1.3 `getResetDelayMs(error)`: prefer `RateLimitError.retryAfter` (ms,
      `ModelClientError.ts:25`) → `RateLimitWindow.resets_in_seconds`
      (`RateLimits.ts:19`) → `rateLimitMetadata.reset - now` (unix, `:21`); cap
      `RESET_CAP_MS`. Consecutive-529 counter, reset on any non-529 outcome.
- [ ] 1.4 Wrap `tryRunTurn(prompt)` at the `TurnManager.runTurn` retry loop
      (`TurnManager.ts:175-207`, call site `:176`). Each retry re-runs the whole turn
      from rebuilt history (orphan-free by construction — design Divergence 5). Do NOT
      inject retry into the client.
- [ ] 1.5 Collapse the shallow loops: base `ModelClient.withRetry()`
      (`ModelClient.ts:445-479`) keep signature → delegate; reduce
      `OpenAIResponsesClient.ts:358-398` & `:566-633` to a single non-retrying request
      (SDK already `maxRetries:0` at `:215`).
- [ ] 1.6 Test-injection seam: `__test__`-gated hook that forces the next model call to
      throw a synthetic `RateLimitError` with chosen `statusCode`/`retryAfter`
      (replaces the deleted `RequestQueue.test.ts` coverage).
- [ ] 1.7 Tests: 429 then success retries once; non-retryable (`statusCode:400`) fails
      immediately; `retryAfter` honored; provider behavior unchanged behind
      `error-handling.test.ts` / `ModelClient.contract.test.ts`.

## Phase 2 — Unattended plumbing (P0)

- [ ] 2.1 Add `unattended?: boolean` to `TurnContextConfig` (`TurnContext.ts:22-45`) +
      getter on `TurnContext`; spread-merge in ctor (`:62-82`) and `update()`
      (`:87-123`).
- [ ] 2.2 Add `unattended?: boolean` to `Submission.context`
      (`protocol/types.ts:21-26`); thread through `RepublicAgent.submitOperation`
      2nd arg (`RepublicAgent.ts:481`) → engine → `TurnContextConfig`.
- [ ] 2.3 Default resolver where the engine builds/updates `TurnContext`
      (`RepublicAgentEngine.ts:85,89,98`; `Session.updateTurnContext()`
      `Session.ts:323-330`): `platformId==='server'` (`IPlatformAdapter.ts:60`) ⇒
      `true`, else `false`.
- [ ] 2.4 Set `unattended:true` at the unattended drivers: server
      `ServerAgentBootstrap.ts:638-644`, desktop `DesktopAgentBootstrap.ts:589-592`,
      extension sidepanel submit (the `?scheduledJob=` path from
      `service-worker.ts:671`).
- [ ] 2.5 Orchestrator persistent branch: when `unattended`, 429/529 unconditionally
      retryable; sleep `getResetDelayMs()` (cap `RESET_CAP_MS`); chunk the sleep (30s)
      polling the abort signal; before each long sleep emit `RateLimitWaiting`.
      Extension: clamp cap to a single window.
- [ ] 2.6 Tests: server default unattended (waits, emits `RateLimitWaiting`, no
      `failJob`); extension clamps to one window; abort during wait is honored.

## Phase 3 — Dead-data fix + adapter + early warning (P1)

- [ ] 3.1 Add `SessionState.getRateLimits(): RateLimitSnapshot | undefined`
      (`SessionState.ts`, beside `getTokenInfo()` `:159`; returns `latestRateLimits`
      `:39`). Shared prerequisite for Tracks 12/18/25.
- [ ] 3.2 Add pure adapter `toRateLimitSnapshotEvent(s: RateLimitSnapshot):
      RateLimitSnapshotEvent` (`RateLimits.ts:6-20` → `events.ts:260-271`; 2 optional
      windows → 5 required flat numbers; absent window ⇒ documented zero-fill).
- [ ] 3.3 Fix `Session.sendTokenCountEvent` (`Session.ts:1611`): `:1613` →
      `sessionState.getTokenInfo()`; `:1614` → `sessionState.getRateLimits()` then
      `toRateLimitSnapshotEvent(...)` into `msg.data.rate_limits` (`:1622`).
- [ ] 3.4 Add time-relative `EARLY_WARNING_CONFIGS` next to `isApproachingRateLimit`
      (`RateLimits.ts:111-117`): warn when `used_percent/100 ≥ utilization &&
      timeProgress ≤ timePct`; `< 0.7` false-alarm floor. Evaluate in the response
      path.
- [ ] 3.5 Add `RateLimitWarning` variant to the `EventMsg` union (`events.ts:28`);
      emit via `Session.sendEvent`.
- [ ] 3.6 Tests: `TokenCountEvent` now carries real `info` + `rate_limits`; adapter
      maps both/one/zero windows; time-relative warning fires "fast burn", not after a
      clean reset.

## Phase 4 — Model fallback (P1)

- [ ] 4.1 Add `fallbackModel`/chain to `IModelConfig` + `providers/default.json`.
- [ ] 4.2 Orchestrator: after `MAX_529_RETRIES` consecutive overloads with a fallback
      configured → resolve via `ModelClientFactory`, `Session.updateTurnContext({model})`,
      continue the loop (in-orchestrator swap; no deep typed-error throw; no history
      cleanup — design Divergence 5).
- [ ] 4.3 Add `ModelDowngraded` variant to `EventMsg` (`events.ts:28`); emit on swap
      (never silent).
- [ ] 4.4 Tests: 3 consecutive 529 → swap + `ModelDowngraded` + retry succeeds on
      fallback; no fallback configured → fails after cap; replayed history is the clean
      prior history (no orphan `tool_use`).

## Phase 5 — Source awareness + max-tokens self-heal (P2)

- [ ] 5.1 Add `source: 'foreground' | 'background'` to the orchestrator options (no
      `Prompt`/`Op` change). Background ⇒ bail fast on 529.
- [ ] 5.2 Route the direct-`stream()` background callers through the orchestrator with
      `source:'background'`: `TitleGenerator.ts:158` (replace loop `:43-76`),
      `CompactService.ts:368` (replace loop `:156-268`); Track-05b quiet extractor
      (`SessionSummaryHook.ts:286`) inherits via the sub-agent turn path.
- [ ] 5.3 Port `parseMaxTokensContextOverflowError` → lower a `maxTokensOverride` on
      retry instead of failing (pairs with Track 25 `context_overflow`).
- [ ] 5.4 Tests: background caller bails immediately on 529 (no amplification);
      foreground still retries; max-tokens overflow self-heals once then proceeds.

## Exit criteria

- `RequestQueue` fully gone; `grep -rn RequestQueue src` empty; `StreamAttemptError`
  untouched.
- One orchestrator wraps the model call at `TurnManager.runTurn`; the 5 shallow loops
  delegate or are removed.
- Server unattended job survives a 429/529 by waiting for reset (emits
  `RateLimitWaiting`) instead of `failJob`; extension wait is window-clamped.
- `TokenCountEvent` carries real `info` + `rate_limits` (via the adapter);
  time-relative `RateLimitWarning` fires before rejection.
- Sustained overload triggers a visible `ModelDowngraded` swap; background callers
  fast-bail.
- All new paths covered by the test-injection seam; existing model/error test net green;
  `npm run type-check` clean.
