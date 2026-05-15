# Track 12: Rate-Limit Resilience

**Priority: P0** · **Effort: M** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of both implementations and all three browserx deploy targets — see "Validation Notes" for exact `file:line` citations.

## Problem

BrowserX runs unattended work (scheduler jobs, Apple Pi Server sessions, connector-driven sessions, background `TaskRunner` sub-agents). The model-call path has **three competing, shallow retry mechanisms and one fully-simulated dead one**:

1. `ModelClient.withRetry()` (base, `core/models/ModelClient.ts:445-479`) — fixed `maxRetries: 3`, exponential backoff, no reset-awareness.
2. Per-provider manual retry loops (`OpenAIResponsesClient.ts:353-389` connect, `:565-624` stream) — each re-implements backoff with `maxRetries = provider.request_max_retries ?? 3`.
3. `RequestQueue.ts` — **entirely simulated**: `executeRequest()` (`:362-373`) does `sleep(500 + Math.random()*1000)` then `if (Math.random() < 0.1) throw new Error('Simulated request failure')`; `processQueue()` (`:291`) carries the comment *"Here we would make the actual request / For now, this is a placeholder"*. Never wired to a real model call.

Consequences: a `429` after 3 attempts **hard-fails an unattended run** instead of waiting for the window to reset; on Apple Pi Server this surfaces as `Error` → `scheduler.failJob()` (`ServerAgentBootstrap.ts:714-725`) with no human to retry; there is no model downgrade on sustained overload; rate-limit early-warning is dead code; and `Session.sendTokenCountEvent()` hardcodes `const rateLimits = undefined; // Would need getRateLimits method from SessionState` (`core/Session.ts:1614`) so even the snapshot that *is* parsed never reaches any client.

## What Claudy Does

### `withRetry` — a single generator-based retry engine (`services/api/withRetry.ts`)

`withRetry<T>()` (`:170-517`) is an `AsyncGenerator<SystemAPIErrorMessage, T>`: it *yields* heartbeat messages during waits and *returns* the operation result. One engine wraps every model call. Constants (`:52-55`, `:96-98`): `DEFAULT_MAX_RETRIES = 10`, `MAX_529_RETRIES = 3`, `BASE_DELAY_MS = 500`, `PERSISTENT_MAX_BACKOFF_MS = 5min`, `PERSISTENT_RESET_CAP_MS = 6hr`, `HEARTBEAT_INTERVAL_MS = 30s`.

**Query-source awareness** (`:62-89`). `FOREGROUND_529_RETRY_SOURCES: Set<QuerySource>` lists user-blocking sources that retry on 529; `shouldRetry529()` (`:84-89`) returns `true` only for those or `undefined` (conservative for untagged paths). Background sources (summaries, titles, suggestions, classifiers) **bail immediately** via `CannotRetryError` (`:144-158`) to avoid 3-10× gateway amplification during a capacity cascade the user never sees.

**Persistent unattended mode** (`:91-104`, `:368-512`). `isPersistentRetryEnabled()` (`:100-104`) = `feature('UNATTENDED_RETRY') && isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)`. `isTransientCapacityError()` (`:106-110`) = `is529Error || (APIError && status===429)`. When on and transient:
- `shouldRetry()` (`:702-706`) makes 429/529 unconditionally retryable, bypassing subscriber gates.
- A separate `persistentAttempt` counter drives backoff while the loop `attempt` is clamped at `maxRetries` so the loop **never terminates** (`:504-506`).
- `getRateLimitResetDelayMs(error)` (`:814-822`) reads `anthropic-ratelimit-unified-reset` (absolute unix seconds) and waits *until the window resets*, capped at `PERSISTENT_RESET_CAP_MS`.
- Long sleeps are **chunked** into `HEARTBEAT_INTERVAL_MS` slices, each yielding a `SystemAPIErrorMessage` (`:489-503`) so the host does not mark the session idle. (`TODO(ANT-344)` at `:94-95` notes this keep-alive is a stopgap for a missing dedicated channel — browserx avoids the stopgap, see Divergence 3.)

**Model fallback** (`:160-168`, `:326-365`). After `MAX_529_RETRIES` consecutive 529s, if `options.fallbackModel` is set, `withRetry` **throws `FallbackTriggeredError(originalModel, fallbackModel)`**. It does *not* swap the model itself — the caller catches the typed error and re-invokes with the fallback model.

**Max-tokens overflow self-heal** (`:384-427`, `parseMaxTokensContextOverflowError` `:550-595`): parses `400 input length and max_tokens exceed context limit: A + B > C` and lowers `retryContext.maxTokensOverride` for the next attempt instead of failing.

### `claudeAiLimits.ts` — limit observation + early warning

`extractQuotaStatusFromHeaders(headers)` (`:454-485`) runs on **every** response; `extractQuotaStatusFromError(error)` (`:487-515`) on 429. Both produce a typed `ClaudeAILimits` (`:122-136`). Change detection via `isEqual` then `emitStatusChange()` (`:184-197`) fans out to `statusListeners` (`:181-182`). **Two-tier early warning** (`:255-374`): server-sent `…-surpassed-threshold` header first, else client-side time-relative thresholds (`EARLY_WARNING_CONFIGS` `:53-70`; e.g. five-hour window: warn when `utilization ≥ 0.9 && timeProgress ≤ 0.72`) — catches "burning quota faster than the window sustains" before rejection.

## BrowserX Mapping

### The real seams

| Concern | BrowserX location | State |
|---|---|---|
| Turn-loop → model call | `TurnManager.ts:224` `await this.turnContext.getModelClient().stream(processedPrompt)` | **The single wrap point** for retry/fallback |
| Per-turn config seam | `TurnContext` ctor `TurnContext.ts:62-82`, `update()` `:87-123` (`TurnContextConfig`) | No `unattended` field today — add here |
| Platform discriminator | `IPlatformAdapter.platformId: 'extension'\|'desktop'\|'server'` (`IPlatformAdapter.ts:60`); `ServerPlatformAdapter.platformId='server'` (`ServerPlatformAdapter.ts:18`) | Clean "is this a headless deployment" signal |
| Model client owner | `TurnContext` (model from `ModelClientFactory.createClientForModelKey`, `RepublicAgentEngine.ts:83-98`) | Where a fallback model swap must re-create the client |
| Per-attempt retry | `OpenAIResponsesClient.ts:353-389` & `:565-624`; base `ModelClient.withRetry()` `:445-479` | Duplicated, shallow, no persistent/fallback/source logic |
| Error classification | `StreamAttemptError` (`types/StreamAttemptError.ts:14`): type `'RetryableHttp'\|'RetryableTransport'\|'Fatal'` (`:15`), `status` (`:16`), `retryAfter` (`:17`); static factories `retryableHttp()` (`:39`), `retryableTransport()` (`:46`), `fatal()` (`:53`) — **no `classify()` method; extend via a new factory/branch** | Good substrate — extend, don't replace |
| Typed errors | `ModelClientError.ts`: `RateLimitError` class (`:61`) w/ `rateLimitMetadata` (`reset` `:21`, `retryAfter` `:25`); `ErrorFactory` (`:324`) `createRateLimitError(headers)` (`:328`, reads `x-ratelimit-reset/-limit/-remaining/-window`) | Rich metadata already parsed but under-used |
| Snapshot parse | provider `parseRateLimitSnapshot()` (`OpenAIResponsesClient.ts:1301`) → `{type:'RateLimits', snapshot}` ResponseEvent emitted `:805` & `:895` | Parsed but… |
| Snapshot → state | `Session.updateRateLimits()` `Session.ts:2481` → `SessionState.updateRateLimits()` `state/SessionState.ts:169` | …stored but **`Session.ts:1614` hardcodes `const rateLimits = undefined` inside `sendTokenCountEvent` (`:1611`)** so `RateLimitSnapshotEvent` (`protocol/events.ts:260`) never carries data — a live bug |
| Unattended driver (server) | `ServerAgentBootstrap.setJobLauncher` `ServerAgentBootstrap.ts:622-647` (scheduled jobs), connector bridges `:538-568` | Fire-and-forget `submitOperation`; no human; failure → `failJob` `:714-725` |
| Unattended driver (desktop) | `src/desktop/scheduler/DesktopSchedulerAlarms.ts` | Tauri-timer scheduled jobs; app may be minimized |
| Dead simulation | `RequestQueue.ts` (+ `__tests__/RequestQueue.test.ts`) | Fully simulated; never wired |

### Per-Platform Behavior

The improvement lands once in `core/` but its *default posture* differs per deploy target. Posture is derived from `IPlatformAdapter.platformId` plus the submission driver — **not** an env var (claudy's `CLAUDE_CODE_UNATTENDED_RETRY` has no browser analog).

- **Apple Pi Server (`platformId==='server'`, headless, Docker/K8s).** This is where the correctness gap actually bites. *Every* session is unattended: scheduled jobs (`ServerAgentBootstrap.ts:622`), connector-driven sessions (Slack/etc. bridges), and the WS-API. **Default `unattended: true` for the whole process**, overridable down by `APPLEPI_*` config / managed policy (Track 20). Reset-wait + `RateLimitWaiting`/`RateLimitWarning`/`ModelDowngraded` events ride the existing event→`ServerChannel`→WS dispatch (`ServerAgentBootstrap.ts:198-215`) and are appended to the transcript, so a remote operator sees "waiting 42 min for limit reset" instead of an opaque `failJob`. `RESET_CAP_MS` and a policy max-wait keep a job from hanging a worker forever.
- **Apple Pi (`platformId==='desktop'`, Tauri).** Mixed. Interactive chat is **attended** — `unattended: false`, fail fast and surface the error so the user can act. Scheduled/background jobs via `DesktopSchedulerAlarms` are **unattended per-task** (set on the scheduler's submission, not globally). The desktop process is long-lived (Tauri host, not a suspendable SW), so multi-hour reset-waits are safe; emit `RateLimitWaiting` to the desktop UI + a `@tauri-apps/plugin-notification` is appropriate (out of scope here; the event is the contract).
- **BrowserX (`platformId==='extension'`, Chrome MV3).** Mostly **attended** (popup UI, user watching) → `unattended: false` by default; fail fast. **Divergence/risk:** the MV3 service worker (`src/extension/background`) can be evicted after ~30 s idle / 5 min hard cap, so a multi-hour persistent wait is *not* reliable even when an extension-side scheduler triggers a job. For extension scheduler jobs, opt into persistent retry but **cap the wait short** (single window, not 6 h) and rely on the chrome alarms re-trigger to resume, rather than holding the event loop. Emit `RateLimitWaiting` so the popup (if open) shows status; never assume the SW survives the wait.

### Key design decisions (and divergences from claudy)

1. **Delete `RequestQueue.ts` and its test.** Decoy infrastructure: `OpenAIResponsesClient.ts` imports it (`:31`), holds a `requestQueue` field (`:124`), and instantiates it (`:228`, `queueEnabled=true` `:233`) — but `RequestQueue.executeRequest()` (`:362`) is a pure simulation (`sleep(500+rand*1000)` `:365`, then `if (Math.random() < 0.1) throw new Error('Simulated request failure')` `:368-369`), so it **never routes a real model request** regardless of being wired. Mirrors Track 08's deletion of dead `QueueProcessor.ts`. *Do not "wire it up" — it is fake by construction.*
2. **One retry orchestrator, not three.** Introduce `core/models/resilience/withRetry.ts` modeled on claudy's generator but adapted to browserx's `ResponseStream`: a single function the provider `stream()` path delegates to. Collapse the base `ModelClient.withRetry()` and the two `OpenAIResponsesClient` loops into it. Classification stays in `StreamAttemptError` — add a new factory/branch (alongside `retryableHttp()`/`retryableTransport()`/`fatal()`) for 529/overloaded + a consecutive-overload counter (there is **no `classify()` method** to extend — it is static factories).
3. **Persistent unattended mode keyed off platform + driver, not an env var.** `unattended` becomes a `TurnContextConfig` field. Default derived: `platformId==='server'` ⇒ `true`; `desktop`/`extension` ⇒ `false`, with the scheduler/`TaskRunner`/connector submission paths explicitly setting `true` on their `Op`/`TurnContext`. **Divergence:** browserx has no stdout-idle host; the "heartbeat" emits a `RateLimitWaiting` event on the existing SQ/EQ bus (`Session.sendEvent`) instead of claudy's yielded `SystemAPIErrorMessage` (claudy's own `TODO(ANT-344)` calls that a stopgap).
4. **Reset-until-wait uses browserx's relative field.** Claudy reads absolute `anthropic-ratelimit-unified-reset`. BrowserX is provider-agnostic: `getResetDelayMs()` prefers `RateLimitError.retryAfter`, then `RateLimitWindow.resets_in_seconds` (`types/RateLimits.ts:19`, relative), then `RateLimitError.rateLimitMetadata.reset - now` (`ModelClientError.ts:23`, absolute unix), capped at a 6 h `RESET_CAP_MS`.
5. **Model fallback via a typed signal caught at `TurnManager`.** Add `FallbackTriggeredError(fromModel, toModel)`. The orchestrator throws it after `MAX_529_RETRIES` consecutive overloads when a fallback is configured; the `TurnManager.ts:224` caller catches it, asks `ModelClientFactory` for the fallback model, swaps it onto `TurnContext` via `update({model})`, re-invokes `stream()`. Fallback chain comes from model config (`config/types IModelConfig` / `providers/default.json`) — not hardcoded. Emit a visible `ModelDowngraded` event.
6. **Fix the early-warning bug + add time-relative thresholds.** Make `Session.sendTokenCountEvent` (`Session.ts:1614`) read `sessionState.getRateLimits()` and populate `RateLimitSnapshotEvent` (`protocol/events.ts:260`). Then port claudy's two-tier model: browserx already has `isApproachingRateLimit(snapshot, 80)` (`types/RateLimits.ts:111`) for the static case; add time-relative `EARLY_WARNING_CONFIGS` over `RateLimitWindow.{used_percent, resets_in_seconds, window_minutes}` and emit `RateLimitWarning`. **Divergence:** browserx has no `statusListeners` pub/sub — reuse the SQ/EQ `Event`/`EventMsg` path.

## Implementation Plan (file-level, ordered)

Land behind the existing safety net (`__tests__/calculateBackoff.test.ts`, `error-handling.test.ts`, `ModelClient.contract.test.ts`); `RequestQueue.test.ts` is deleted with the file.

**Step 0 — delete decoy.** Remove `core/models/RequestQueue.ts` + `core/models/__tests__/RequestQueue.test.ts`; drop the `:218` reference in `OpenAIResponsesClient.ts`. Confirm no other importers (`grep -rn RequestQueue src`).

**Step 1 — orchestrator + classification (Phase 1, P0 correctness).**
- New `core/models/resilience/withRetry.ts`: generator-free async fn (browserx has the event bus; no need for yield-heartbeat) with constants ported from claudy `:52-55,96-98`; `getResetDelayMs(error)` per Divergence 4; `isTransientCapacityError()` reusing the `StreamAttemptError` type/status fields.
- **`StreamAttemptError` change is NOT a one-line factory (forward-traced 2026-05-15).** `type` is a *closed union* `'RetryableHttp'|'RetryableTransport'|'Fatal'` (`:15`) built only via a **private constructor** (`:20`) through static factories; `.type` is consumed by `delay()` (`:89`), `intoError()` (`:112-131`), `isRetryable()` (`:142`), and an **exhaustive `toString()` switch** (`:149-156`); the real classification entry points are the free fn `classifyError()` (`:170`) and `fromHttpStatus()` (`:66`). Adding an `Overloaded` member touches the union + all those sites (the `toString()` switch is a compile-time exhaustiveness break). **A 529 is already `RetryableHttp` with `status:529`** (`fromHttpStatus:68` `status>=500`), so the orchestrator can detect overload via `status===529` *without* a new union member — prefer that (consecutive-overload counting keyed on `status`/`retryAfter`) over widening the union. Only widen the union if a distinct `delay()`/`isRetryable()` policy is required; if so, budget the ~6-site change.
- Rewrite `OpenAIResponsesClient.ts:353-389` & `:565-624` to delegate to the orchestrator; delete the body of base `ModelClient.withRetry()` `:445-479` (keep signature, delegate).

**Step 2 — unattended plumbing (Phase 1, P0).**
- Add `unattended?: boolean` to `TurnContextConfig` + field/getter on `TurnContext` (`TurnContext.ts:50-82,87-123`).
- Default resolver: read `IPlatformAdapter.platformId` where the `RepublicAgent`/engine builds the `TurnContext` (`RepublicAgentEngine.ts` `createClientForModelKey` `:85` → `new TurnContext` `:89` → `setTurnContext` `:98`; runtime swap via `updateTurnContext` `:543`/`getTurnContext` `:546`) → `server` ⇒ `true`, else `false`.
- Server driver override: `ServerAgentBootstrap.setJobLauncher` (`:622-647`) and connector bridge submissions tag the op so the turn is unattended even if the global default is later relaxed by config.
- Desktop/extension scheduler: `DesktopSchedulerAlarms` / extension background scheduler set `unattended: true` on the scheduled `submitOperation`.
- Orchestrator: when `unattended`, `429/529` is unconditionally retryable; sleep `getResetDelayMs()` (capped `RESET_CAP_MS`); before each long sleep emit `RateLimitWaiting` (new `EventMsg`, `protocol/events.ts`) via `Session.sendEvent`. Extension path: clamp the cap to one window (MV3 SW lifetime — see Per-Platform).

**Step 3 — snapshot bug + early warning (Phase 2, P1).**
- Fix `Session.ts:1614`: replace `const rateLimits = undefined` with `sessionState.getRateLimits()`. **Forward-traced (2026-05-15): the getter does NOT exist** — `SessionState` has only `updateRateLimits()` (`:169`) writing the private `latestRateLimits` field (`:39`). This step **must add** `getRateLimits(): RateLimitSnapshot | undefined { return this.latestRateLimits; }` to `SessionState`. This is the shared prerequisite for Tracks 12/18/25 — add it once, all three consume it. Then populate `RateLimitSnapshotEvent` (`protocol/events.ts:257,260`).
- Add `EARLY_WARNING_CONFIGS` (time-relative) next to `isApproachingRateLimit` in `types/RateLimits.ts`; evaluate in the response path; emit `RateLimitWarning` `EventMsg`. Shared with Track 18 (`/cost`) — same `Session.ts:1614` fix.

**Step 4 — model fallback (Phase 3, P1).**
- Add `FallbackTriggeredError(fromModel,toModel)` (`core/models/resilience/`); orchestrator throws after `MAX_529_RETRIES` consecutive overloads when a fallback is configured.
- Catch at `TurnManager.ts:224` site: resolve fallback from model config, `TurnContext.update({model})`, re-invoke `stream()`; emit `ModelDowngraded`. Add `fallbackModel`/chain to `IModelConfig` + `providers/default.json`.

**Step 5 — query-source awareness + max-tokens self-heal (Phase 4, P2).**
- Introduce a `QuerySource`-equivalent on the request (browserx callers: main turn vs `TitleGenerator` vs `CompactService` vs sub-agent). Background sources bail fast under capacity cascade (claudy `:62-89` mapped to browserx call sites).
- Port `parseMaxTokensContextOverflowError` → lower a `maxTokensOverride` on retry instead of failing. (Pairs with Track 25's `context_overflow` class on the same `TurnManager.ts:224` boundary — land together.)

## Dependencies

- **Track 01** (Hooks/Events): `RateLimitWaiting`/`RateLimitWarning`/`ModelDowngraded` ride the existing `Event`/`EventMsg` bus.
- **Track 04** (Typed Tasks): `unattended` derived from platform + task family — scheduler/server/connector/background ⇒ persistent retry.
- **Track 18** (USD Cost): downgrade decisions may factor running cost; both touch `ModelClientFactory`/model config; both share the `Session.ts:1614` fix.
- **Track 20** (Managed Settings): server-default `unattended:true` overridable via the same managed-policy fetcher; shares ETag/poll/fail-open shape.
- **Track 25** (Compaction): shares the `TurnManager.ts:224` boundary, `StreamAttemptError`, and circuit-breaker — **land together**.

## Risks

- Unattended wait can stall a job for hours → cap at `RESET_CAP_MS` (6 h), always emit `RateLimitWaiting`, allow a policy max-wait override (Track 20). On extension, additionally clamp to one window (MV3 SW eviction).
- Collapsing three retry loops into one risks regressing provider behavior → keep `StreamAttemptError` classification provider-pluggable; land behind the existing test net.
- Silent model downgrade changes output quality → `ModelDowngraded` must be first-class and surfaced, never silent.
- Provider header divergence (`x-pi-*` vs `x-ratelimit-*` vs none) → reset/limit extraction stays behind per-provider `parseRateLimitSnapshot()`; the orchestrator consumes only the normalized `RateLimitSnapshot`/`RateLimitError`.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

Both implementations read end-to-end. Citations:

- claudy: `services/api/withRetry.ts:52-55,96-98` (constants), `:62-89` (`FOREGROUND_529_RETRY_SOURCES`/`shouldRetry529`), `:100-110` (`isPersistentRetryEnabled`/`isTransientCapacityError`), `:120-125` (`RetryContext`), `:144-168` (`CannotRetryError`/`FallbackTriggeredError`), `:170-517` (`withRetry` generator), `:326-365` (529 counter + fallback throw), `:368-512` (persistent backoff/heartbeat), `:489-503` (heartbeat chunking), `:504-506` (loop clamp), `:550-595` (`parseMaxTokensContextOverflowError`), `:702-706`/`:696-787` (`shouldRetry`), `:814-822` (`getRateLimitResetDelayMs`); `services/claudeAiLimits.ts:53-70,122-136,181-197,255-374,454-515`.
- browserx core: `core/models/ModelClient.ts:118-156,445-479`; `core/models/client/OpenAIResponsesClient.ts:31,124-125,215,223-233,359,363,571,574,805,895,1301`; `core/models/RequestQueue.ts:291,320,362-369` (delete); `core/models/ModelClientError.ts:21,25,61-89,324-342`; `core/models/types/RateLimits.ts:6-20,19,111`; `core/models/types/StreamAttemptError.ts:14-17,39,46,53`; `core/Session.ts:1611,1614,2481,2469,2489`; `core/session/state/SessionState.ts:169`; `core/protocol/events.ts:255,257,260`; `core/TurnManager.ts:224`; `core/TurnContext.ts:50,62-82,87-123`; `core/engine/RepublicAgentEngine.ts:85,89,98,543,546`.
- browserx platforms: `core/platform/IPlatformAdapter.ts:60`; `src/server/platform/ServerPlatformAdapter.ts:18`; `src/server/agent/ServerAgentBootstrap.ts:157-197` (agentFactory), `:198-215` (event→WS dispatch), `:622-647` (scheduled-job launcher = unattended driver), `:714-725` (failJob on rate-limit hard-fail today); `src/desktop/scheduler/DesktopSchedulerAlarms.ts`; `src/extension/background` (MV3 SW lifetime constraint).

Corrections applied vs the first-pass draft:
1. "Fix the `RequestQueue` stub" → **delete** it (it is a fully simulated decoy, not a half-finished feature).
2. Identified the separate live bug `Session.ts:1614` (`rateLimits = undefined`) that makes `RateLimitSnapshotEvent` dead today — folded into Step 3 (shared with Track 18).
3. Replaced claudy's `statusListeners` pub/sub + yielded `SystemAPIErrorMessage` heartbeat with browserx-native SQ/EQ `Event` emission (no terminal stdout host; claudy itself flags the yield as a `TODO(ANT-344)` stopgap).
4. Reset-wait uses browserx's **relative** `resets_in_seconds`/`RateLimitError.retryAfter`, not claudy's absolute `anthropic-ratelimit-unified-reset` (browserx is provider-agnostic; those Anthropic headers are not on its wire).
5. Fallback is a caller-side swap at `TurnManager.ts:224` via `ModelClientFactory`, not in-orchestrator.
6. **Multi-platform (2026-05-15):** unattended posture is derived from `IPlatformAdapter.platformId` + submission driver, not an env var — `server` defaults on (the real bite point: `failJob` today), `desktop` per-task via `DesktopSchedulerAlarms`, `extension` opt-in with a clamped wait because the MV3 service worker is evicted long before a 6 h reset.

## Forward-Trace Verification (2026-05-15)

Traced the *forward* claims (symbols to create/modify/call), not just citations:

- ✅ **Holds:** `TurnContextConfig` (`:22`) is an extensible interface used by ctor+`update()` — adding `unattended?: boolean` is the localized change described. `EventMsg` (`protocol/events.ts:28`) is a clean discriminated union — `RateLimitWaiting`/`RateLimitWarning`/`ModelDowngraded` are clean additions. `TurnManager.ts:224` fallback-catch site confirmed. `ErrorFactory.createRateLimitError`/`isApproachingRateLimit` reuse confirmed (read, not just grepped).
- ⚠️ **Rescoped — `StreamAttemptError`:** NOT a one-line factory. Closed union + private ctor + exhaustive `toString()` switch + `classifyError()`/`fromHttpStatus()` entry points. Preferred path: detect overload via `status===529` (already `RetryableHttp`) **without** widening the union (see Step 1). Effort for the classification piece: S→S–M.
- ⚠️ **Confirmed required (not "if absent") — `SessionState.getRateLimits()`:** does not exist; only `updateRateLimits()` (`:169`) + private `latestRateLimits` (`:39`). Step 3 must add the getter; it is the **shared prerequisite for Tracks 12/18/25** (add once).
- Net effort: still **M**; no track-invalidating surprise. The orchestrator/`withRetry.ts` greenfield and the `RequestQueue` deletion are unaffected.
