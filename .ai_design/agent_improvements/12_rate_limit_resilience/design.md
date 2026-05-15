# Track 12: Rate-Limit Resilience

**Priority: P0** · **Effort: M** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Not covered by the original 2026-04-07 analysis or tracks 01–10. This document is grounded in a full read of both implementations — see "Validation Notes" for exact `file:line` citations.

## Problem

BrowserX runs unattended work (scheduler jobs, server-mode sessions, background `TaskRunner` agents). The model-call path has **three competing, shallow retry mechanisms and one fully-simulated dead one**:

1. `ModelClient.withRetry()` (base, `core/models/ModelClient.ts:445-479`) — fixed `maxRetries: 3`, exponential backoff, no reset-awareness.
2. Per-provider manual retry loops (`OpenAIResponsesClient.ts:353-389` for connect, `:565-624` for stream) — each re-implements backoff with `maxRetries = provider.request_max_retries ?? 3`.
3. `RequestQueue.ts` — **entirely simulated**: `executeRequest()` (`:362-373`) does `sleep(500 + Math.random()*1000)` then `if (Math.random() < 0.1) throw new Error('Simulated request failure')`; `processQueue()` (`:291`) carries the comment *"Here we would make the actual request / For now, this is a placeholder"*. It is never wired to a real model call.

Consequences: a `429` after 3 attempts **hard-fails an unattended run** instead of waiting for the window to reset; there is no model downgrade on sustained overload; rate-limit early-warning is dead code; and `Session.sendTokenCountEvent()` hardcodes `const rateLimits = undefined; // Would need getRateLimits method from SessionState` (`core/Session.ts:1610`) so even the snapshot that *is* parsed never reaches the UI.

## What Claudy Does

### `withRetry` — a single generator-based retry engine (`services/api/withRetry.ts`)

`withRetry<T>()` (`:170-517`) is an `AsyncGenerator<SystemAPIErrorMessage, T>`: it *yields* heartbeat messages during waits and *returns* the operation result. One engine wraps every model call. Key constants (`:52-98`): `DEFAULT_MAX_RETRIES = 10`, `MAX_529_RETRIES = 3`, `BASE_DELAY_MS = 500`, `PERSISTENT_MAX_BACKOFF_MS = 5min`, `PERSISTENT_RESET_CAP_MS = 6hr`, `HEARTBEAT_INTERVAL_MS = 30s`.

**Query-source awareness** (`:62-89`). `FOREGROUND_529_RETRY_SOURCES: Set<QuerySource>` — foreground/user-blocking sources retry on 529; background sources (summaries, titles, suggestions, classifiers) **bail immediately** via `CannotRetryError` (`:318-324`) to avoid 3-10× gateway amplification during a capacity cascade the user never sees.

**Persistent unattended mode** (`:91-104`, `:368-512`). `isPersistentRetryEnabled()` = `feature('UNATTENDED_RETRY') && isEnvTruthy(CLAUDE_CODE_UNATTENDED_RETRY)`. When on and the error is a transient capacity error (429/529):
- `shouldRetry()` (`:702-706`) makes 429/529 unconditionally retryable, bypassing subscriber gates.
- A separate `persistentAttempt` counter drives backoff while the `for`-loop `attempt` is clamped at `maxRetries` so the loop **never terminates** (`:504-506`).
- `getRateLimitResetDelayMs(error)` (`:814-822`) reads the `anthropic-ratelimit-unified-reset` header (absolute unix seconds) and waits *until the window resets* rather than polling uselessly, capped at `PERSISTENT_RESET_CAP_MS`.
- Long sleeps are **chunked** into `HEARTBEAT_INTERVAL_MS` slices, each yielding a `SystemAPIErrorMessage` (`:489-503`) so the host environment does not mark the session idle mid-wait.

**Model fallback** (`:326-365`). After `MAX_529_RETRIES` consecutive 529s, if `options.fallbackModel` is set, `withRetry` **throws `FallbackTriggeredError(originalModel, fallbackModel)`** (`:160-168`, `:347-350`). `withRetry` does *not* swap the model itself — the caller catches the typed error and re-invokes with the fallback model.

**Max-tokens overflow self-heal** (`:384-427`, `parseMaxTokensContextOverflowError` `:550-595`): parses the `400 input length and max_tokens exceed context limit: A + B > C` message and lowers `retryContext.maxTokensOverride` for the next attempt instead of failing.

### `claudeAiLimits.ts` — limit observation + early warning

`extractQuotaStatusFromHeaders(headers)` (`:454-485`) runs on **every** response; `extractQuotaStatusFromError(error)` (`:487-515`) on 429. Both produce a typed `ClaudeAILimits` (`:122-136`: `status: 'allowed'|'allowed_warning'|'rejected'`, `resetsAt`, `rateLimitType`, `utilization`, `overageStatus`, `overageDisabledReason`, `surpassedThreshold`). Change detection via `isEqual` then `emitStatusChange()` (`:184-197`) fans out to `statusListeners: Set<StatusChangeListener>` (`:181-182`) and logs an analytics event.

**Two-tier early warning** (`:53-374`). `getEarlyWarningFromHeaders()`: first the server-sent `…-surpassed-threshold` header (`getHeaderBasedEarlyWarning` `:255-294`); fallback to client-side **time-relative** thresholds (`EARLY_WARNING_CONFIGS` `:53-70`, e.g. five-hour window: warn when `utilization ≥ 0.9 && timeProgress ≤ 0.72`; `computeTimeProgress()` `:98-103`). This catches "burning quota faster than the window sustains" before rejection.

## BrowserX Mapping

### The real seams

| Concern | BrowserX location | State |
|---|---|---|
| Turn-loop → model call | `TurnManager.ts:224` `await this.turnContext.getModelClient().stream(processedPrompt)` | **The single wrap point** for retry/fallback |
| Model client owner | `TurnContext` (model from `ModelClientFactory.createClientForModelKey`, `RepublicAgentEngine.ts:79-83`) | Where a fallback model swap must re-create the client |
| Per-attempt retry | `OpenAIResponsesClient.ts:353-389` & `:565-624`; base `ModelClient.withRetry()` `:445-479` | Duplicated, shallow, no persistent/fallback/source logic |
| Error classification | `StreamAttemptError` (`types/StreamAttemptError.ts`): `RetryableHttp | RetryableTransport | Fatal`, `status`, `retryAfter`, `classify()` | Good substrate — extend, don't replace |
| Typed errors | `ModelClientError.ts`: `RateLimitError` (`reset`, `window`, `retryAfter`), `UsageLimitReachedError`, `ErrorFactory.createRateLimitError(headers)` | Rich metadata already parsed but under-used |
| Snapshot parse | provider `parseRateLimitSnapshot()` → emits `{type:'RateLimits', snapshot}` ResponseEvent (`OpenAIResponsesClient.ts:798-800, 888-890`) | Parsed but…|
| Snapshot → state | `Session.updateRateLimits()` `core/Session.ts:2477` → `SessionState.updateRateLimits()` `state/SessionState.ts:169` | …stored but **`Session.ts:1610` hardcodes `rateLimits = undefined`** so `RateLimitSnapshotEvent` (`protocol/events.ts:260`) never carries data — a live bug |
| Dead simulation | `RequestQueue.ts` (+ `__tests__/RequestQueue.test.ts`) | Fully simulated; never wired |

### Key design decisions (and divergences from claudy)

1. **Delete `RequestQueue.ts` and its test.** It is decoy infrastructure (verified: only `OpenAIResponsesClient.ts:218` mentions a queue, and never routes real requests through it). The real retry path is the provider `stream()` + `StreamAttemptError`, not a queue. This mirrors Track 08's deletion of the dead `QueueProcessor.ts`. *Do not "wire it up" — that would resurrect a fake design.*

2. **One retry orchestrator, not three.** Introduce `core/models/resilience/withRetry.ts` modeled on claudy's generator but adapted to browserx's `ResponseStream`: a single function the provider `stream()` path delegates to. Collapse the base `ModelClient.withRetry()` and the two `OpenAIResponsesClient` loops into it. Classification stays in `StreamAttemptError` (extend `classify()` with the 529/overloaded + consecutive-counter notion).

3. **Persistent unattended mode keyed off task type, not an env var.** Claudy uses `CLAUDE_CODE_UNATTENDED_RETRY`. BrowserX's analog is structural: `TaskRunner`/scheduler/server sessions set `unattended: true` on the `TurnContext`/request. Retry then loops with reset-wait + heartbeat instead of failing after N. **Divergence:** browserx has no stdout-idle host to keep alive; the "heartbeat" instead emits a `RateLimitWaiting` event on the existing SQ/EQ bus (`Session.sendEvent`) so the UI/clients show "waiting N min for limit reset" — replacing claudy's yielded `SystemAPIErrorMessage`.

4. **Reset-until-wait uses browserx's relative field.** Claudy reads an absolute unix `anthropic-ratelimit-unified-reset`. BrowserX is provider-agnostic: `RateLimitWindow.resets_in_seconds` (`types/RateLimits.ts:19`) and `RateLimitError.rateLimitMetadata.reset` (`ModelClientError.ts:23`, unix seconds from `x-ratelimit-reset`). The browserx `getResetDelayMs()` must prefer `RateLimitError.retryAfter`, then `resets_in_seconds` (relative), then `reset - now` (absolute), capped at a 6h `RESET_CAP_MS`.

5. **Model fallback via a typed signal caught at `TurnManager`.** Add `FallbackTriggeredError(fromModel, toModel)`. The retry orchestrator throws it after `MAX_529_RETRIES` consecutive overloads when a fallback is configured; `TurnManager.ts:224`'s caller catches it, asks `ModelClientFactory` for the fallback model, swaps it onto `TurnContext`, and re-invokes `stream()`. Fallback chain comes from model config (`config/types IModelConfig`) / `providers/default.json` — **not** hardcoded. Emit a visible `ModelDowngraded` event.

6. **Fix the early-warning bug + add time-relative thresholds.** First, make `Session.sendTokenCountEvent` (`core/Session.ts:1610`) actually read `sessionState.getRateLimits()` and populate `RateLimitSnapshotEvent` (`protocol/events.ts:260`). Then port claudy's two-tier model: browserx already has `isApproachingRateLimit(snapshot, 80)` (`types/RateLimits.ts:111`) for the static case; add time-relative `EARLY_WARNING_CONFIGS` over `RateLimitWindow.{used_percent, resets_in_seconds, window_minutes}` and emit a `RateLimitWarning` event through the existing bus. **Divergence:** browserx has no `statusListeners` pub/sub — reuse the SQ/EQ `Event`/`EventMsg` path that already exists, not a new listener set.

### Phase plan

- **Phase 1 (P0 — correctness):** delete `RequestQueue.ts` + test; create `core/models/resilience/withRetry.ts`; collapse the base + provider retry loops into it; add reset-until-wait honoring `RateLimitError.retryAfter`/`resets_in_seconds`; add `unattended` flag on `TurnContext` set by `TaskRunner`/scheduler/server bootstraps; emit `RateLimitWaiting` events instead of silent sleeps.
- **Phase 2 (P1):** fix `Session.ts:1610` to surface `RateLimitSnapshotEvent`; add time-relative `EARLY_WARNING_CONFIGS`; emit `RateLimitWarning`.
- **Phase 3 (P1):** `FallbackTriggeredError` + consecutive-529 counter in the orchestrator; catch at `TurnManager`; model swap via `ModelClientFactory`; `ModelDowngraded` event; fallback chain in model config.
- **Phase 4 (P2):** query-source awareness (`QuerySource` enum + `FOREGROUND_RETRY_SOURCES`) so background calls (title/compact/summary via `TitleGenerator`, `CompactService`) bail fast under capacity cascades; max-tokens-overflow self-heal.

## Dependencies

- **Track 01** (Hooks/Events): `RateLimitWaiting` / `RateLimitWarning` / `ModelDowngraded` ride the existing `Event`/`EventMsg` bus
- **Track 04** (Typed Tasks): `unattended` is derived from task family — scheduler/server/background ⇒ persistent retry
- **Track 18** (USD Cost): downgrade decisions may factor running cost; both touch `ModelClientFactory`/model config
- **Track 20** (Managed Settings): shares no code but the same ETag/poll/fail-open shape if org rate-limit policy is added later

## Risks

- Unattended wait can stall a job for hours → cap at `RESET_CAP_MS` (6h), always emit `RateLimitWaiting` so it is observable, allow a policy max-wait override.
- Collapsing three retry loops into one risks regressing provider-specific behavior → keep `StreamAttemptError.classify()` provider-pluggable; land behind tests (existing `__tests__/calculateBackoff.test.ts`, `error-handling.test.ts`, `ModelClient.contract.test.ts` are the safety net; `RequestQueue.test.ts` is deleted with the file).
- Silent model downgrade changes output quality → `ModelDowngraded` must be a first-class, surfaced event, never silent.
- Provider header divergence (`x-pi-*` vs `x-ratelimit-*` vs none) → reset/limit extraction must live behind `parseRateLimitSnapshot()` per provider; the orchestrator consumes the normalized `RateLimitSnapshot`/`RateLimitError` only.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

Both implementations were read end-to-end. Citations:

- claudy: `services/api/withRetry.ts:52-98` (constants), `:62-89` (`FOREGROUND_529_RETRY_SOURCES`/`shouldRetry529`), `:170-517` (`withRetry` generator), `:160-168` (`FallbackTriggeredError`), `:326-365` (529 counter + fallback throw), `:368-512` (persistent backoff/heartbeat), `:504-506` (loop clamp), `:814-822` (`getRateLimitResetDelayMs`), `:550-595` (`parseMaxTokensContextOverflowError`), `:696-787` (`shouldRetry`); `services/claudeAiLimits.ts:53-70` (`EARLY_WARNING_CONFIGS`), `:122-136` (`ClaudeAILimits`), `:181-197` (`statusListeners`/`emitStatusChange`), `:255-374` (two-tier early warning), `:454-515` (header/error extraction).
- browserx: `core/models/ModelClient.ts:118-129,154-163` (`RetryConfig` defaults), `:445-479` (`withRetry`), `:349` (`parseRateLimitSnapshot` contract); `core/models/client/OpenAIResponsesClient.ts:353-389,565-624` (manual retry loops), `:798-800,888-890` (`RateLimits` event emit); `core/models/RequestQueue.ts:291,362-373` (simulated stub — recommend deletion); `core/models/ModelClientError.ts:15-26,61-89` (`RateLimitMetadata`/`RateLimitError`), `:328-342` (`ErrorFactory.createRateLimitError`); `core/models/types/RateLimits.ts:6-20,111-117` (`RateLimitSnapshot`/`isApproachingRateLimit`); `core/models/types/StreamAttemptError.ts` (classification); `core/Session.ts:1610` (`rateLimits = undefined` bug), `:2477` (`updateRateLimits`); `core/session/state/SessionState.ts:169` (`updateRateLimits`); `core/protocol/events.ts:257,260` (`RateLimitSnapshotEvent`); `core/TurnManager.ts:224` (model stream call site); `core/engine/RepublicAgentEngine.ts:79-83` (client creation).

Corrections applied vs the first-pass draft of this doc:
1. The "fix the `RequestQueue` stub" recommendation is changed to **delete** it — reading the code showed it is a fully simulated decoy never wired to a model, not a half-finished feature. Wiring it would institutionalize a fake design.
2. Identified a *separate* live bug not in the first draft: `Session.ts:1610` discards the parsed rate-limit snapshot (`rateLimits = undefined`), so `RateLimitSnapshotEvent` is dead today regardless of early-warning work — folded into Phase 2.
3. Replaced claudy's `statusListeners` pub/sub and yielded `SystemAPIErrorMessage` heartbeat with browserx-native SQ/EQ `Event` emission — browserx has no terminal stdout host and already has an event bus.
4. Reset-wait must use browserx's **relative** `resets_in_seconds` / `RateLimitError.retryAfter`, not claudy's absolute `anthropic-ratelimit-unified-reset` header (browserx is provider-agnostic; those Anthropic headers do not exist on its wire).
5. Fallback is a caller-side swap at `TurnManager.ts:224` via `ModelClientFactory`, not in-orchestrator — matches claudy's "throw `FallbackTriggeredError`, caller re-invokes" contract mapped onto browserx's `TurnContext`/factory ownership.
