# Track 12: Rate-Limit Resilience

**Priority: P0** · **Effort: M** · **Status: IMPLEMENTATION-READY (code-verified 2026-05-15)**

> Source: second-pass claudy↔browserx research (2026-05-14); implementation-readiness +
> multi-platform pass (2026-05-15); **final code-verification pass (2026-05-15)** — every
> seam below traced against `HEAD` (`bd34246a`) by reading the actual source, not grepping.
> All `path:line` citations in this revision are byte-accurate; corrections from earlier
> drafts are listed in "Code-Verification Audit" at the bottom.

## Problem

BrowserX runs unattended work (scheduler jobs, Apple Pi Server sessions, connector-driven
sessions, background `TaskRunner` sub-agents). The model-call path has **five competing,
shallow retry mechanisms and one fully-simulated dead one**:

1. Base `ModelClient.withRetry()` (`core/models/ModelClient.ts:445-479`) — fixed
   `maxRetries: 3` (`:156`), exponential backoff, no reset-awareness. **Note: type-only
   import of `StreamAttemptError` at `:8`, never actually used in the body.**
2. `OpenAIResponsesClient` connect-phase loop (`core/models/client/OpenAIResponsesClient.ts:358-398`,
   `maxRetries = provider.request_max_retries ?? 3` at `:359`).
3. `OpenAIResponsesClient` stream-phase loop (`:566-633`, same `?? 3` at `:571`).
4. `TitleGenerator` private retry loop (`core/title/TitleGenerator.ts:43-76`) — its own
   `maxRetries`/backoff; retries blindly on any error; calls `modelClient.stream()`
   directly at `:158`, **bypassing the turn path**.
5. `CompactService` private retry loop (`core/compact/CompactService.ts:156-268`) — same
   pattern; calls `modelClient.stream()` directly at `:368`, bypassing the turn path.
6. `core/models/RequestQueue.ts` — **entirely simulated**: `executeRequest()`
   (`:362-373`) does `await this.sleep(500 + Math.random()*1000)` (`:365`) then
   `if (Math.random() < 0.1) throw new Error('Simulated request failure')` (`:368-370`);
   `processQueue()` (`:291-357`) carries the placeholder comment at `:319-320`. `enqueue()`
   is **never called anywhere in production** — even though `OpenAIResponsesClient`
   imports (`:31`), holds (`:124`), and conditionally instantiates it (`:228`,
   `queueEnabled=true` at `:233`), the queue only ever runs the simulated `executeRequest`.

Consequences: a `429`/`529` after 3 attempts **hard-fails an unattended run** instead of
waiting for the window to reset; on Apple Pi Server this surfaces as an `Error` event →
`scheduler.failJob()` (`ServerAgentBootstrap.ts:714-725`) with no human to retry; there is
no model downgrade on sustained overload; rate-limit early-warning does not exist; and
**two adjacent dead-data bugs** in `Session.sendTokenCountEvent` (`core/Session.ts:1611`)
hardcode `const tokenInfo = undefined` (`:1613`) and `const rateLimits = undefined`
(`:1614`) — so every `TokenCountEvent` carries `info: undefined` + `rate_limits: undefined`
regardless of state, even though `SessionState` correctly stores both
(`SessionState.updateRateLimits()` `:169`, private `latestRateLimits` `:39`;
`getTokenInfo()` already exists at `:159` but the `:1613` comment falsely claims it does
not).

## What Claudy Does (reference architecture)

Claudy splits this into **three layers that never reach into each other** — the
separation of concerns is the architectural pattern we copy wholesale; the code is a heavy
port for Layer 1, an algorithm transplant for Layer 2, and a from-scratch
reimplementation for Layer 3.

**Layer 1 — `services/api/withRetry.ts`: one generator-based retry engine.**
`withRetry<T>()` (`:170-517`) is an `AsyncGenerator<SystemAPIErrorMessage, T>`: it *yields*
heartbeats during waits and *returns* the result. One engine wraps every model call.
Constants (`:52-55,96-98`): `DEFAULT_MAX_RETRIES=10`, `MAX_529_RETRIES=3`,
`BASE_DELAY_MS=500`, `PERSISTENT_MAX_BACKOFF_MS=5min`, `PERSISTENT_RESET_CAP_MS=6hr`,
`HEARTBEAT_INTERVAL_MS=30s`. Key mechanisms:
- **Consecutive-overload counter** (`:186,:326-365`) separate from the retry count; after
  `MAX_529_RETRIES` consecutive 529s, if a fallback model is configured, **throws
  `FallbackTriggeredError`** (it does not swap the model itself).
- **Persistent unattended mode** (`:368-512`): a separate `persistentAttempt` drives
  backoff while the loop `attempt` is clamped (`:504-506`) so the loop **never
  terminates** on 429/529; reads the reset header and waits until reset
  (`getRateLimitResetDelayMs:814-822`, capped 6 h); long sleeps chunked into 30 s slices
  (`:489-503`) — the chunk boundary is also where `signal.aborted` is polled (`:491`).
- **Query-source awareness** (`:62-89,:316-324`): background sources (titles, summaries,
  classifiers) **bail immediately** on 529 (`CannotRetryError`) to avoid 3-10× gateway
  amplification during a capacity cascade; untagged paths default to retry.
- **Max-tokens self-heal** (`:384-427`, `parseMaxTokensContextOverflowError:550-595`).

**Layer 2 — `services/claudeAiLimits.ts`: passive header→status observer + early warning.**
`extractQuotaStatusFromHeaders()` (`:454`) runs on every response; two-tier early warning
(`:347-374`): server `…-surpassed-threshold` header first, else client-side time-relative
thresholds — warn when `utilization ≥ t.utilization && timeProgress ≤ t.timePct`
(`getTimeRelativeEarlyWarning:301-340`), i.e. "burning quota faster than the window
sustains". A `< 0.7` floor (`rateLimitMessages.ts:69-78`) suppresses false alarms from
stale post-reset data.

**Layer 3 — caller-side fallback (`query.ts` + `claude.ts`): signal → re-throw → act.**
The orchestrator only *signals* via the typed `FallbackTriggeredError`. An intermediate
catch (`claude.ts:2603-2605`) must **re-throw it untouched** (swallowing it makes fallback
a silent no-op). The top layer (`query.ts:894-939`) does the real work: swap model **and**
discard partial assistant/tool state + strip model-bound thinking blocks before replaying,
or the retry 400s on orphaned `tool_use`. **BrowserX does not need this cleanup — see
Divergence 5.**

## BrowserX Mapping

### The real seams (code-verified 2026-05-15)

| Concern | BrowserX location | State |
|---|---|---|
| Turn retry loop (the wrap point) | `TurnManager.runTurn()` retry loop `TurnManager.ts:175-207`; the model call it guards is `tryRunTurn` `:216` → `await this.turnContext.getModelClient().stream(processedPrompt)` **`:224`** | **The single caller-side wrap point.** `runTurn` already re-runs the whole `tryRunTurn` from rebuilt history on retry — exactly the restart semantics the orchestrator needs |
| Per-turn config seam | `TurnContextConfig` `TurnContext.ts:22-45`; ctor `:62-82`; `update()` `:87-123`; class `:50` | Flat optional fields, spread-merged. **No `unattended` field today** — add here |
| Platform discriminator | `IPlatformAdapter.platformId: 'extension'\|'desktop'\|'server'` (`IPlatformAdapter.ts:60`); `ServerPlatformAdapter.platformId='server'` (`ServerPlatformAdapter.ts:18`) | Clean headless signal |
| Model client owner / swap | `Session.setTurnContext()` `Session.ts:312-318`, `updateTurnContext()` `:323-330` (delegates to `TurnContext.update()`, does **not** touch history), `getTurnContext()` `:335-337`; sub-agent path builds it at `RepublicAgentEngine.ts:85,89,98` | Fallback model swap re-creates the client here, between turns |
| Per-attempt retry (to collapse) | `OpenAIResponsesClient.ts:358-398` & `:566-633`; base `ModelClient.withRetry()` `:445-479`; **plus** `TitleGenerator.ts:43-76` & `CompactService.ts:156-268` | 5 shallow loops, no reset/fallback/source logic |
| Error classification | `ModelClientError` (`ModelClient.ts:134-145`, **no `cause` param**); `RateLimitError extends ModelClientError` (`ModelClientError.ts:61-89`) w/ `rateLimitMetadata` (`reset` unix `:21`, `retryAfter` ms `:25`, `limit/remaining/window`); `ErrorFactory.createRateLimitError(headers)` `:328-341` reads `x-ratelimit-limit/-remaining/-reset/-window` + `retry-after`. `error.statusCode` survives the wrap (see below) | Classify off `instanceof RateLimitError` / `error.statusCode` (429/529/5xx) — **not** `StreamAttemptError** |
| ~~`StreamAttemptError`~~ | `core/models/types/StreamAttemptError.ts` — closed union, private ctor, exhaustive `toString()` | **DEAD CODE — do not touch.** Zero production consumers; only a type-only import at `ModelClient.ts:8` + barrel + contract test. The live loops classify via `instanceof ModelClientError`/`statusCode`. Earlier drafts' "carefully extend the union" analysis is moot |
| Snapshot parse | `OpenAIResponsesClient.parseRateLimitSnapshot()` `:1301` reads proprietary `x-pi-primary-*`/`x-pi-secondary-*`; emits `{type:'RateLimits', snapshot}` at `:805` & `:895` | Parsed but… |
| Snapshot → state | `Session.updateRateLimits()` `Session.ts:2481` → `:2486` `SessionState.updateRateLimits()` `:169` → `:2489` `sendTokenCountEvent` | …**stored then discarded** at `Session.ts:1614` (`rateLimits=undefined`). Also `:1613` (`tokenInfo=undefined`, stale comment) |
| Type-shape mismatch | stored `RateLimitSnapshot` = `{primary?,secondary?: RateLimitWindow}` (`RateLimits.ts:6-20`, `used_percent`/`window_minutes?`/`resets_in_seconds?`) **≠** event payload `RateLimitSnapshotEvent` (`events.ts:260-271`, 5 **required flat** numbers) | No converter exists anywhere. Step 3 must add an adapter, not just a getter |
| Event bus | `EventMsg` discriminated union `events.ts:28` (discriminator `type`, 84 variants, **no central registry — trivially extensible**); `Session.sendEvent()` | `RateLimitWaiting`/`RateLimitWarning`/`ModelDowngraded` are clean new variants. **No** rate-limit/waiting/warning/downgrade variant exists today |
| Early-warning primitive | `isApproachingRateLimit(snapshot, threshold=80)` `RateLimits.ts:111-117` (`>=`, most-restrictive window) | Static case covered; add time-relative configs alongside |
| Unattended driver (server) | `ServerAgentBootstrap.setJobLauncher` `:622-647` (submits `UserInput` at `:638-644`); connector bridges `:236,:428-435,:470`; fail path `:714-725`; event→WS `:198-215` | Fire-and-forget; failure → `failJob` |
| Unattended driver (desktop) | `DesktopAgentBootstrap.ts:570` (jobLauncher), submits at `:589-592`; alarms in `src/desktop/scheduler/DesktopSchedulerAlarms.ts` (timers only, builds no Op) | Tauri-timer jobs |
| Unattended driver (extension) | `src/extension/background/service-worker.ts:671` — **indirect**: opens sidepanel with `?scheduledJob=…`; the sidepanel submits the `UserInput` | MV3 SW lifetime constraint |
| Unattended carrier (none today) | `submitOperation(op, ctx?)` `RepublicAgent.ts:481` — `ctx` only `{tabId?}`; `Submission.context` `protocol/types.ts:21-26` `{tabId?,sessionId?}`; `ExecutionContext.metadata` `RepublicAgentEngineConfig.ts:169-173` (untyped passthrough); registry `SessionType='primary'\|'scheduled'` `registry/types.ts:20` (set `AgentRegistry.ts:278`, **dies at the registry**) | Pick one carrier (see Step 2) |
| Dead simulation | `RequestQueue.ts` + `__tests__/RequestQueue.test.ts`; barrel re-exports `core/models/index.ts:43,46,48`; client refs `OpenAIResponsesClient.ts:31,124,227-233,1433-1471` | Delete |

### Per-Platform Behavior

The improvement lands once in `core/` but its *default posture* differs per deploy
target, derived from `IPlatformAdapter.platformId` plus the submission driver — **not** an
env var (claudy's `CLAUDE_CODE_UNATTENDED_RETRY` has no browser analog).

- **Apple Pi Server (`platformId==='server'`).** Where the gap actually bites — *every*
  session is unattended (scheduled jobs `ServerAgentBootstrap.ts:622`, connector bridges,
  WS-API). **Default `unattended: true` for the process**, overridable down by config /
  managed policy (Track 20). Reset-wait + `RateLimitWaiting`/`RateLimitWarning`/
  `ModelDowngraded` events ride the existing event→`ServerChannel`→WS dispatch
  (`ServerAgentBootstrap.ts:198-215`) and the transcript, so a remote operator sees
  "waiting 42 min for limit reset" instead of an opaque `failJob`. `RESET_CAP_MS` + a
  policy max-wait bound the worker hold.
- **Apple Pi (`platformId==='desktop'`).** Mixed. Interactive chat is **attended**
  (`unattended:false`, fail fast). Scheduled jobs via `DesktopAgentBootstrap.ts:570` are
  **unattended per-task** (set on the scheduler's submission). The Tauri host is
  long-lived, so multi-hour waits are safe; emit `RateLimitWaiting` to the desktop UI
  (notification UX out of scope; the event is the contract).
- **BrowserX (`platformId==='extension'`).** Mostly **attended** → `unattended:false`.
  **Divergence/risk:** the MV3 service worker is evicted after ~30 s idle / 5 min hard
  cap, so a multi-hour persistent wait is *not* reliable. Extension scheduler jobs are
  indirect (sidepanel-driven, `service-worker.ts:671`); opt into persistent retry but
  **clamp the wait to one window** and rely on the alarm re-trigger to resume; never
  assume the SW survives the wait.

### Key design decisions (and divergences from claudy)

1. **Delete `RequestQueue.ts` and its test.** Verified pure simulation — never routes a
   real request, `enqueue()` never called in production. Also remove the barrel
   re-exports (`core/models/index.ts:43,46,48`) and the `OpenAIResponsesClient` import /
   field / instantiation / status-pause-clear refs (`:31,:124,:227-233,:1433-1471`).
   Mirrors Track 08's dead-`QueueProcessor.ts` deletion. *Do not "wire it up".*

2. **One retry orchestrator, caller-side, classifying off `ModelClientError`.** New
   `core/models/resilience/withRetry.ts`: a plain async function (no generator/yield —
   browserx has the event bus; Divergence 3) that **wraps the model call at the
   `TurnManager.runTurn` loop level** (`:175-207`). It classifies the caught error via
   `instanceof RateLimitError` and `error.statusCode` (429 / 529 / ≥500) + `retryAfter`.
   **`StreamAttemptError` is dead code and is NOT touched** (earlier-draft analysis about
   widening its union is withdrawn). The 5 shallow loops (§Problem 1-5) collapse into
   delegation to this orchestrator; the SDK is already `maxRetries: 0`
   (`OpenAIResponsesClient.ts:215`).

3. **Persistent unattended mode keyed off platform + driver, not an env var.**
   `unattended` becomes a `TurnContextConfig` field; default derived from `platformId`
   (`server`⇒`true`, else `false`), with scheduler/`TaskRunner`/connector submission paths
   explicitly setting `true`. **Divergence:** the "heartbeat" emits a `RateLimitWaiting`
   `EventMsg` on the existing bus via `Session.sendEvent` instead of claudy's yielded
   `SystemAPIErrorMessage` (claudy's own `TODO(ANT-344)` calls the yield a stopgap). The
   **chunked-sleep loop is kept** — not for stdout, but to poll the abort signal during
   long waits.

4. **Reset-until-wait uses browserx's relative field.** `getResetDelayMs()` prefers
   `RateLimitError.retryAfter` (ms, `ModelClientError.ts:25`), then
   `RateLimitWindow.resets_in_seconds` (`RateLimits.ts:19`), then
   `RateLimitError.rateLimitMetadata.reset - now` (unix, `:21`), capped at a 6 h
   `RESET_CAP_MS`. (Claudy's absolute `anthropic-ratelimit-unified-reset` is not on
   browserx's wire — its providers expose `x-pi-*` / `x-ratelimit-*`.)

5. **Model fallback is an in-orchestrator swap, NOT a deep typed-error throw.**
   **Corrected from earlier drafts (verified):** a typed error thrown *inside* the client
   is destroyed — `toModelClientError` (`OpenAIResponsesClient.ts:1106-1113,:683-698`,
   impl `:1191`) replaces the concrete class with a fresh `ModelClientError`, and
   `ModelClientError`'s ctor (`ModelClient.ts:134-145`) **cannot carry a `cause`**. So
   the claudy "throw deep, catch upstream" split is **not viable as-is**. Because the
   orchestrator sits *above* `TurnManager.ts:224` (caller side, above every
   type-destroying wrapper), it can resolve the fallback model and swap inline —
   `ModelClientFactory` → `Session.updateTurnContext({model})` → re-run the loop — with
   **no need to throw `FallbackTriggeredError` through anything** (it may still define one
   as an internal control-flow signal within the orchestrator). Emit a visible
   `ModelDowngraded` event. **History hygiene is NOT required:** verified that BrowserX
   records conversation history *only on successful turn return*
   (`TaskRunner.processTurnResult` at `:368-370` → `recordConversationItemsDual` `:731`);
   a mid-stream-failed turn commits nothing, so a between-turns swap+retry replays only
   clean prior history + the same user input — no orphan-`tool_use` hazard, no buffer
   reset. **Constraint:** the retry must restart the whole turn (re-enter
   `runTurn`/`tryRunTurn` — which it does by construction), never resume a partial
   iterator. Fallback chain comes from model config (`IModelConfig` /
   `providers/default.json`), not hardcoded.

6. **Fix both dead-data bugs + add time-relative early warning.** Add
   `SessionState.getRateLimits(): RateLimitSnapshot | undefined` (returns
   `latestRateLimits`) **and** use the existing `getTokenInfo()` (`:159`). In
   `Session.sendTokenCountEvent` (`:1611`) replace `:1613`/`:1614` with those getters,
   then **map** the stored `RateLimitSnapshot` → the flat `RateLimitSnapshotEvent` shape
   via a new pure adapter (the two types are structurally incompatible — a getter alone
   will not type-check at `Session.ts:1622`). The getter is the **shared prerequisite for
   Tracks 12/18/25** — add once. Then add time-relative `EARLY_WARNING_CONFIGS` next to
   `isApproachingRateLimit` in `RateLimits.ts`, evaluate in the response path, emit
   `RateLimitWarning`. **Divergence:** no `statusListeners` pub/sub — reuse the SQ/EQ
   `EventMsg` path; the consumer is a Svelte store, not a React hook.

## Implementation Plan (file-level, ordered)

Land behind the existing safety net (`__tests__/calculateBackoff.test.ts`,
`error-handling.test.ts`, `ModelClient.contract.test.ts`); `RequestQueue.test.ts` is
deleted with the file. Add a test-only error-injection seam (Step 1) so the new
reset-wait/fallback paths are deterministically exercisable — claudy has
`rateLimitMocking.ts`; BrowserX has no replacement once `RequestQueue.test.ts` is gone.

**Step 0 — delete decoy (P0).** Remove `core/models/RequestQueue.ts` +
`core/models/__tests__/RequestQueue.test.ts`; remove barrel re-exports
`core/models/index.ts:43,46,48`; remove import (`OpenAIResponsesClient.ts:31`), field
(`:124-125`), instantiation block (`:227-233`), and status/pause/clear references
(`:1433-1434,1449-1454,1463,1470-1471`). `grep -rn RequestQueue src` must come back clean.

**Step 1 — orchestrator + classification (Phase 1, P0 correctness).**
- New `core/models/resilience/withRetry.ts`: plain async fn; constants ported from claudy
  (`DEFAULT_MAX_RETRIES`, `MAX_529_RETRIES=3`, `BASE_DELAY_MS=500`,
  `PERSISTENT_MAX_BACKOFF_MS=5min`, `RESET_CAP_MS=6h`, chunk = 30 s for abort polling);
  `classify(error)` off `instanceof RateLimitError` + `error.statusCode` (429/529/≥500) +
  `retryAfter`; `getResetDelayMs(error)` per Divergence 4; consecutive-529 counter.
- Insert it at the `TurnManager.runTurn` retry loop (`:175-207`) — wrap the
  `tryRunTurn(prompt)` call (`:176`) so each retry restarts the whole turn from rebuilt
  clean history (Divergence 5 constraint). Do **not** inject retry logic into the client.
- Make the 5 shallow loops delegate / become pass-through: base
  `ModelClient.withRetry()` (`:445-479`) keep signature, delegate; collapse
  `OpenAIResponsesClient.ts:358-398` & `:566-633` to a single non-retrying request; route
  `TitleGenerator.ts:43-76` & `CompactService.ts:156-268` through the orchestrator with
  `source: 'background'` (Step 5).
- **Do NOT modify `StreamAttemptError`** (dead code).
- Test seam: a `__test__`-gated injectable that makes the next model call throw a
  synthetic `RateLimitError` with a chosen `retryAfter`/`statusCode`.

**Step 2 — unattended plumbing (Phase 1, P0).**
- Add `unattended?: boolean` to `TurnContextConfig` (`TurnContext.ts:22-45`) + getter on
  `TurnContext`.
- Default resolver where the engine builds/updates `TurnContext`
  (`RepublicAgentEngine.ts:85,89,98`; runtime swap via `Session.updateTurnContext()`
  `Session.ts:323-330`): `platformId==='server'` ⇒ `true`, else `false`.
- Carrier for per-job override: thread an `unattended` flag from the scheduler/connector
  submission. **Chosen carrier:** `submitOperation(op, ctx?)` 2nd arg
  (`RepublicAgent.ts:481`) → `Submission.context` (`protocol/types.ts:21-26`, add
  `unattended?: boolean`) → resolved into `TurnContextConfig` at the engine. Set
  `unattended:true` at: server `ServerAgentBootstrap.ts:638-644`, desktop
  `DesktopAgentBootstrap.ts:589-592`, extension sidepanel submit (the
  `?scheduledJob=` path opened at `service-worker.ts:671`).
- Orchestrator: when `unattended`, 429/529 is unconditionally retryable; sleep
  `getResetDelayMs()` (capped `RESET_CAP_MS`); before each long sleep emit
  `RateLimitWaiting` via `Session.sendEvent`. Extension: clamp cap to one window.

**Step 3 — dead-data fix + adapter + early warning (Phase 2, P1).**
- Add `SessionState.getRateLimits(): RateLimitSnapshot | undefined` (`SessionState.ts`,
  alongside `getTokenInfo()` `:159`).
- Add a pure adapter `toRateLimitSnapshotEvent(s: RateLimitSnapshot):
  RateLimitSnapshotEvent` (maps the 2 optional windows → the 5 required flat numbers;
  define behavior when a window is absent — zero-fill, documented).
- In `Session.sendTokenCountEvent` (`:1611`): `:1613` → `this.sessionState.getTokenInfo()`;
  `:1614` → `this.sessionState.getRateLimits()` then `toRateLimitSnapshotEvent(...)` into
  `msg.data.rate_limits` (`:1622`). Both fixes ship together (same method, both feed
  `TokenCountEvent`). Shared prerequisite for Tracks 12/18/25.
- Add `EARLY_WARNING_CONFIGS` (time-relative, ported formula:
  `used_percent/100 ≥ utilization && timeProgress ≤ timePct`, plus the `< 0.7` false-alarm
  floor) next to `isApproachingRateLimit` in `RateLimits.ts`; evaluate in the response
  path; emit a new `RateLimitWarning` `EventMsg` variant.

**Step 4 — model fallback (Phase 3, P1).**
- In the orchestrator: after `MAX_529_RETRIES` consecutive overloads, if a fallback model
  is configured, resolve it via `ModelClientFactory`, `Session.updateTurnContext({model})`,
  and continue the loop (in-orchestrator swap — Divergence 5; **no** deep typed-error
  throw, **no** history cleanup). Emit a new `ModelDowngraded` `EventMsg` variant.
- Add `fallbackModel`/chain to `IModelConfig` + `providers/default.json`.

**Step 5 — source awareness + max-tokens self-heal (Phase 4, P2).**
- Add a `source: 'foreground' | 'background'` field to the orchestrator options (no
  request/`Prompt` change needed — `Prompt` `ResponsesAPI.ts:44-55` stays clean). The
  concrete background call sites are `TitleGenerator.ts:158` and `CompactService.ts:368`
  (both bypass the turn path and call `stream()` directly) plus the Track-05b quiet
  extractor (`SessionSummaryHook.ts:286` via `SubAgentRunner`). Background sources
  bail fast on 529 instead of amplifying a capacity cascade.
- Port `parseMaxTokensContextOverflowError` → lower a `maxTokensOverride` on retry instead
  of failing. (Pairs with Track 25's `context_overflow` class on the same
  `TurnManager` boundary — land together.)

## Dependencies

- **Track 01** (Hooks/Events): `RateLimitWaiting`/`RateLimitWarning`/`ModelDowngraded`
  ride the existing `EventMsg` bus.
- **Track 04** (Typed Tasks): `unattended` correlates with scheduler/server/connector/
  background submission paths.
- **Track 18** (USD Cost): shares the `Session.ts:1613-1614` fix + `getRateLimits()`
  getter; downgrade may factor running cost.
- **Track 20** (Managed Settings): server-default `unattended:true` overridable via the
  same managed-policy fetcher.
- **Track 25** (Compaction): shares the `TurnManager.ts:224` boundary, the
  `ModelClientError`/`statusCode` classification, and the circuit-breaker — **land
  together**. Also shares `getRateLimits()`.

## Risks

- Unattended wait can stall a job for hours → cap at `RESET_CAP_MS` (6 h), always emit
  `RateLimitWaiting`, allow a policy max-wait (Track 20). On extension additionally clamp
  to one window (MV3 SW eviction).
- Collapsing 5 retry loops into one risks regressing per-provider behavior → keep
  `ModelClientError`/`RateLimitError` classification provider-pluggable; land behind the
  existing test net + the new injection seam.
- Silent model downgrade changes output quality → `ModelDowngraded` must be first-class
  and surfaced, never silent.
- The orchestrator must wrap **at/above `TurnManager.runTurn`**; injecting it into the
  client would have the typed control-flow error destroyed by `toModelClientError`
  (verified). Keep all orchestrator state on the caller side.
- The `RateLimitSnapshot` → `RateLimitSnapshotEvent` adapter is a real type seam — a
  getter without the adapter does not compile. Treat the adapter as part of the Step 3
  acceptance, with explicit absent-window behavior.

## Code-Verification Audit (2026-05-15, vs `HEAD` bd34246a)

Every seam read end-to-end (not grepped). Corrections applied to earlier drafts:

1. **Path drift:** `OpenAIResponsesClient.ts` is `src/core/models/client/OpenAIResponsesClient.ts`,
   not `src/core/models/`. (CLAUDE.md is also stale on this.)
2. **Line drift:** connect retry loop `:353-389`→**`:358-398`**; stream retry loop
   `:565-624`→**`:566-633`**. (`RequestQueue` import `:31`, field `:124`, instantiation
   `:228`/`:233`, `parseRateLimitSnapshot` `:1301`, emits `:805`/`:895`,
   `ModelClient.withRetry` `:445-479`, `Session.ts:1611/1614/2481/2469/2489`,
   `SessionState.ts:169/39`, `RateLimits.ts:111`, `events.ts:28/255/257/260`,
   `TurnManager.ts:224`, `TurnContext.ts:22-45/62-82/87-123`,
   `RepublicAgentEngine.ts:85/89/98`, `IPlatformAdapter.ts:60`,
   `ServerPlatformAdapter.ts:18`, `ServerAgentBootstrap.ts:198-215/622-647/714-725`
   all **confirmed exact**.)
3. **`StreamAttemptError` is dead code (CONTRADICTION).** Zero production consumers
   (type-only import `ModelClient.ts:8` + barrel + contract test). Live loops classify
   via `instanceof ModelClientError` + `statusCode`. The entire earlier "do not widen the
   closed union; detect via `status===529`" analysis is **withdrawn** — the class is not
   in the request path at all. Net effort *down* (one fewer fragile change).
4. **Layer-3 fallback premise corrected (CONTRADICTION, both directions).** (a) A typed
   error thrown inside the client is destroyed by `toModelClientError`
   (`OpenAIResponsesClient.ts:1106-1113,:683-698,:1191`); `ModelClientError` ctor has no
   `cause` (`ModelClient.ts:134-145`). So "throw deep, catch at `TurnManager`" is not
   viable — the orchestrator must wrap caller-side at `runTurn` (`:175-207`) and swap
   inline. (b) Conversely, the earlier worry that BrowserX needs claudy-style
   orphan-`tool_use` history cleanup is **false**: record-on-success
   (`TaskRunner.ts:368-370` → `:731`) means a failed turn commits nothing; a
   between-turns swap+retry is orphan-free *by construction*, no buffer reset needed.
   The only constraint is "restart the whole turn", which `runTurn` does anyway.
5. **Second dead-data bug found:** `Session.ts:1613` `tokenInfo=undefined` with a stale
   comment ("would need getTokenInfo") — but `SessionState.getTokenInfo()` already exists
   (`:159`). Folded into Step 3 (same method, both feed `TokenCountEvent`).
6. **Type-shape mismatch found:** stored `RateLimitSnapshot` (`RateLimits.ts:6-20`,
   nested optional windows) is structurally incompatible with the
   `RateLimitSnapshotEvent` payload (`events.ts:260-271`, 5 required flat numbers); no
   converter exists. Step 3 now requires a `toRateLimitSnapshotEvent` adapter, not just a
   getter.
7. **Background-source targets are concrete:** `TitleGenerator.ts:158` and
   `CompactService.ts:368` call `modelClient.stream()` directly (bypassing the turn
   path) with their own blind retry loops — they are the real "background" callers Step 5
   must route + fast-bail. No `source`/`querySource` field exists on `Prompt`/`Op`/
   `TurnContext` today; chosen carrier for `unattended` is `Submission.context`.
8. **No streaming→non-streaming fallback exists** (verified) — claudy's
   `initialConsecutive529Errors` cross-mode seam is N/A for BrowserX; dropped from scope.
9. **No env-var analog** — `unattended` posture derives from `IPlatformAdapter.platformId`
   + submission driver (server defaults on; the real bite point is `failJob`
   `ServerAgentBootstrap.ts:714-725`).

Net effort: still **M** (Step 1 orchestrator greenfield + 5-loop collapse is the bulk);
the `StreamAttemptError` simplification offsets the added adapter + second-bug fix. No
track-invalidating surprise.
