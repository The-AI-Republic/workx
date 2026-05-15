# Track 25: Autonomous & Reactive Context Compaction

**Priority: P1** · **Effort: S–M** · **Status: READY TO IMPLEMENT**

> Source: third-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's compaction subsystem and browserx's compaction seams across all three deploy targets — see "Validation Notes". Closes two robustness gaps that matter most for *unattended* runs; companion to Track 12, with which it shares the model-call boundary.

## Problem

BrowserX's compaction *machinery* is solid (`CompactService`, Track 05b summary interlock, Track 09 tool-result offload) and `Session.shouldCompact()` already uses the **real** API token count. But it is not wired for autonomy or recovery:

1. **No autonomous main-loop trigger.** The only self-triggering compaction is the sub-agent path (`TaskRunner.shouldCompactBeforeRequest`, `TaskRunner.ts:343,776`). The main session **never self-compacts**: `Compact mode:auto` is only a passive submission handler (`RepublicAgent.ts:546-547`); nothing in `TurnManager`/`RepublicAgentEngine`/UI/server enqueues it from token pressure (verified by grep). A long unattended server/scheduler run with no front-end sending `Compact` grows unbounded until it hard-fails.
2. **No reactive recovery.** Zero 413 / "prompt too long" / context-overflow handling on a normal turn (`TurnManager`/`Session`/engine grep empty). The only overflow handling is the trim-oldest retry *inside* `CompactService.compact()`. If the proactive trigger never fires, the turn fails with no recovery.

Operability is also thinner than claudy: a single boolean `shouldCompact` (no graduated tiers), no cross-turn circuit breaker, no recompaction-chain awareness.

## What Claudy Does

**Proactive — every turn, in the query loop.** `autoCompactIfNeeded()` (`services/compact/autoCompact.ts:241`) runs inside `query.ts`'s loop every turn. `shouldAutoCompact()` (`:160`) compares `tokenCountWithEstimation(messages)` against `getAutoCompactThreshold()` (`:72` = window − `AUTOCOMPACT_BUFFER_TOKENS` 13k). `calculateTokenWarningState()` (`:93-145`) returns graduated tiers (`percentLeft`, `isAboveWarningThreshold`, `isAboveErrorThreshold`, `isAboveAutoCompactThreshold`, `isAtBlockingLimit`). A **circuit breaker** stops after `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (`:70`, cited prod data: ~250k wasted API calls/day without it). `AutoCompactTrackingState` (`:51-60`) threads turn/recompaction-chain state.

**Reactive — real API 413 fallback.** `query.ts:15-16` lazily loads `services/compact/reactiveCompact.ts` (feature-gated `REACTIVE_COMPACT`). `query.ts:811` `isWithheldPromptTooLong(message)` and `:1119` `if ((isWithheld413 || isWithheldMedia) && reactiveCompact)` catch a *real* prompt-too-long/media error and compact-then-retry; `compact.ts:238,472,882` implement the lossy trim + `prompt_too_long` telemetry. Proactive and reactive are deliberately complementary (`autoCompact.ts:189-223`).

## BrowserX Mapping

### The real seam — machinery exists, wiring does not

| Concern | BrowserX location | State |
|---|---|---|
| Post-turn hook | `Session.registerPostTurnHook(fn)` (`Session.ts:519`) — fires after every successful turn, errors swallowed | **The clean autonomous-trigger seam** (Track 05b extension point; core ⇒ fires on all platforms) |
| Trigger fn | `Session.shouldCompact(contextWindow)` (`Session.ts:766-769`) → real `tokenInfo.total_tokens` | Correct + accurate — **never called in the main loop** |
| Auto-compact limit | `ModelClient.getAutoCompactTokenLimit()` = `contextWindow*0.8` (`OpenAIResponsesClient.ts:271`); `TokenUsageInfo.auto_compact_token_limit` | Defined per-client, unused by a trigger |
| Enqueue path | `RepublicAgent.ts:547` `submitOperation({type:'Compact',mode:'auto'})` → engine `handleCompact` → `Session.compact()`; priority-ordered by shipped Track 08 CommandQueue (`queue/priorityForOp.ts:27`) | Passive only |
| Model-call boundary | `TurnManager.ts:224` `turnContext.getModelClient().stream(...)`; Track 12's `StreamAttemptError` classification (static factories `retryableHttp`/`retryableTransport`/`fatal`, `StreamAttemptError.ts:14-53` — no `classify()` method) + orchestrator | No `context_overflow` case; reactive hook belongs here |
| Overflow patterns | `CompactService.isContextOverflowError()` (`CompactService.ts:416-427`) | Reusable for reactive detection |
| Token-pressure surfacing | `Session.sendTokenCountEvent()` (`Session.ts:1611`, called `:2469/:2489`); `Session.ts:1614` discard bug (Tracks 12/18) | Single boolean; no tiers |
| Threshold constants | `CompactService triggerThreshold 0.85` (`compact/constants.ts`); `TaskRunner.COMPACTION_THRESHOLD 0.85` (`:124`); client `getAutoCompactTokenLimit 0.8` | **Three inconsistent thresholds** |

### Per-Platform Behavior

The fix is **pure core** — one post-turn hook on `Session` (instantiated identically on the extension background, `DesktopAgentBootstrap`, and `ServerAgentBootstrap`'s agent factory). What differs per platform is the *consequence of the gap today*, which is why this is P1 and headless-motivated:

- **BrowserX (extension)** & **Apple Pi (desktop)** — interactive. Today the main session never auto-compacts, but a human watching can type `/compact` (or notice the failure and recover). The gap is a **degraded UX / avoidable failure**, not silent death. After the fix, both gain claudy-style per-turn proactivity. MV3 note: the post-turn hook only *enqueues* an `Op`; the compaction itself runs as a normal turn the service worker already drives, so there is no new SW-lifetime exposure (the enqueue is synchronous and cheap).
- **Apple Pi Server (headless)** — the motivating platform. A long unattended scheduled/connector-driven session has **no front-end and no human** to ever send `Compact`. Without the autonomous trigger it grows unbounded and **hard-fails** — surfacing as `Error` → `scheduler.failJob()` (`ServerAgentBootstrap.ts:714`), the same dead-end Track 12 fixes for rate-limits. This is a **correctness failure on the server**, not a UX nicety. The reactive 413 recovery is likewise correctness-critical here: there is no operator to manually `/compact` after an overflow. Composition: a server job that hits context overflow mid-run recovers via Track 25's compact-then-retry on Track 12's boundary instead of `failJob`. And claudy's circuit-breaker economics (~250k wasted API calls/day) are explicitly a **fleet/server** concern — an extension user re-triggering a failing compact is annoying; a fleet of Apple Pi Server replicas doing it is the cited cost disaster.

### Key design decisions (and divergences from claudy)

1. **Autonomous trigger via the existing post-turn hook — do not touch `CompactService`.** Register a `postTurnHook` (the Track 05b seam, `Session.registerPostTurnHook` `:519`) that calls the already-correct `Session.shouldCompact(contextWindow)` and, if true, enqueues `{type:'Compact',mode:'auto'}` via the shipped Track 08 priority CommandQueue (`priorityForOp.ts:27` already maps `Compact`→`'later'`, so it correctly yields to `UserInput`/`Interrupt` — forward-verified). **Forward-trace caveat (2026-05-15): this is a net-new pattern, not a Track 05b copy.** (a) `PostTurnContext` (`SessionSummaryHook.ts:71`) carries `totalTokenUsage.total_tokens` but **NOT `contextWindow`** — the hook must source the window from the model client (`getAutoCompactTokenLimit()` `OpenAIResponsesClient.ts:271`), not from the ctx. (b) **No existing postTurnHook enqueues an op** — `SessionSummaryHook` does its work *directly* (sub-agent extraction), never via the op queue; the enqueue half has no precedent. (c) The hook must therefore be **constructed at the `RepublicAgent` level** holding an engine handle (exactly as `SessionSummaryHook` holds `parentEngine`, attached at `RepublicAgent.ts:362`; passive enqueue precedent at `:547`) so it can call `requireEngine().submitOperation(...)`. Still low-risk and the compaction path is unchanged, but budget it as new wiring, not a one-line hook. **Divergence:** browserx has no query-loop generator/terminal; the trigger is a post-turn hook + SQ/EQ enqueue, not an inline `autoCompactIfNeeded`.
2. **Keep browserx's accurate signal — the gap is wiring, not estimation.** `Session.shouldCompact` uses real API `total_tokens`; claudy uses `tokenCountWithEstimation`. Do **not** swap in an estimate (`CompactService.estimateTokens` stays a post-compact metric only). browserx is *ahead* here; don't regress.
3. **Reactive recovery integrates with Track 12's boundary, not a parallel path.** Add a `context_overflow` factory/case to Track 12's `StreamAttemptError` classification (alongside `retryableHttp`/`retryableTransport`/`fatal`) (413 + reuse `CompactService.isContextOverflowError` + provider `prompt is too long`). On classify at `TurnManager.ts:224`: compact-then-retry **before** consuming a normal retry, gated by a per-session consecutive-overflow circuit breaker (claudy's `MAX=3`). One model-call resilience boundary, not two.
4. **Unify the three thresholds.** `0.85`/`0.85`/`0.8` reconcile to one source — adopt `getAutoCompactTokenLimit()` (per-model, plumbed via `TokenUsageInfo.auto_compact_token_limit`) as canonical; main + sub-agent consume it.
5. **Graduated warning tiers + circuit breaker (operability parity).** Add claudy-style `calculateTokenWarningState` (percentLeft/warning/error/blocking) surfaced on `sendTokenCountEvent` (the same `Session.ts:1614` fix Tracks 12/18 need — one fix, four riders: rate-limit, cost, migration-of-no, context-pressure). Per-session consecutive-autocompact-failure breaker (claudy's 250k/day rationale = the fleet/server case).
6. **Out of scope for v1 (explicit).** Microcompaction, `collapseReadSearch` (1,110 LOC), history snip, context-collapse — claudy's *strategy breadth*. Efficiency, not correctness; deferred, not denied.

## Implementation Plan (file-level, ordered)

**Phase 1 (P1, S) — autonomous trigger (closes the headless correctness gap).**
- New `core/compact/autoCompactHook.ts`: constructed in `RepublicAgent` (where both `this.session` and `requireEngine()` `:486` are reachable; attach via the existing `RepublicAgent.ts:362` `registerPostTurnHook` pattern). On post-turn it reads `ctx.totalTokenUsage.total_tokens` (`PostTurnContext`), sources the window from the model client `getAutoCompactTokenLimit()` (`OpenAIResponsesClient.ts:271`), calls `Session.shouldCompact(window)` (`:766`), and if true (and none pending / breaker not tripped) enqueues `{type:'Compact',mode:'auto'}` via `requireEngine().submitOperation` (Track 08 maps it `'later'`).
- Register it where `Session`/`RepublicAgent` is constructed so it is live on all three platforms (one registration point in the agent/engine init, not per-bootstrap).
- Unify thresholds: point `CompactService` and `TaskRunner.COMPACTION_THRESHOLD` (`:124`) at `getAutoCompactTokenLimit()`.
- Ship the minimal "don't re-enqueue while one is pending / after N consecutive failures" guard *in Phase 1* (not deferred — it is the enqueue-storm safety).

**Phase 2 (P1, S–M) — reactive recovery on Track 12's boundary.**
- Add a `context_overflow` factory/case to `core/models/types/StreamAttemptError.ts` (`:14-53`, alongside `retryableHttp`/`retryableTransport`/`fatal`) (413 + `CompactService.isContextOverflowError` patterns `:416-427`).
- In Track 12's retry orchestrator at the `TurnManager.ts:224` boundary: on `context_overflow`, compact-then-retry before consuming a normal retry; per-session consecutive-overflow circuit breaker. Must land *on* Track 12's orchestrator — sequence after/with Track 12 Phase 1.

**Phase 3 (P1, S) — tiers + breaker surfacing.**
- `calculateTokenWarningState`-equivalent in `core/compact/`; surface via the shared `Session.sendTokenCountEvent`/`Session.ts:1614` fix (coordinate with Tracks 12/18 — one edit, four consumers). Consecutive-autocompact-failure breaker state on the session.

## Dependencies

- **Track 12** (Rate-Limit): shares the `TurnManager.ts:224` boundary, `StreamAttemptError` classification, orchestrator, circuit-breaker pattern — Phase 2 lands on Track 12's orchestrator. **Land 12+25 together.**
- **Track 08** (CommandQueue, shipped): priority-ordered auto-`Compact` enqueue.
- **Track 05 / 05b** (DONE): the compaction this triggers; `registerPostTurnHook` is Track 05b's seam.
- **Tracks 12 / 16 / 18**: all share the `Session.ts:1614` `sendTokenCountEvent` fix — context-pressure tiers are a rider on that one change.
- **Track 04** (Typed Tasks): `TaskRunner` sub-agent path unified onto the canonical threshold.

## Risks

- Enqueue storm: an auto-`Compact` that fails and re-triggers is exactly claudy's circuit-breaker case — the minimal guard ships in **Phase 1**, not deferred.
- Ordering: auto-`Compact` must not preempt in-flight `UserInput`/`Interrupt` — rely on shipped Track 08 priority lanes; add a test.
- Reactive double-handling: a 413 handled by exactly one of Track 12 retry vs Track 25 compact — `StreamAttemptError` class is the single arbiter.
- Threshold unification shifts sub-agent compaction `0.85→0.8` — earlier is safer; call it out.
- Don't regress the accurate signal: keep `Session.shouldCompact` on real `total_tokens`; never swap in `estimateTokens`.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `services/compact/autoCompact.ts:51-60,70,72-91,93-145,160-239,241,189-223`; `query.ts:15-16,811,1119`; `services/compact/compact.ts:238,472,882`.
- browserx: `core/Session.ts:130,519-523` (`postTurnHooks`/`registerPostTurnHook` — core seam, all platforms), `:766-769` (`shouldCompact`→`compactService.shouldCompact` real `total_tokens`), `:1611` (`sendTokenCountEvent`), `:1614` (shared discard fix), called `:2469/:2489`; `core/compact/CompactService.ts:61,66,416,418,452`, `compact/constants.ts:37` (`triggerThreshold:0.85`); `core/TaskRunner.ts:124,343,742`; `core/models/client/OpenAIResponsesClient.ts:271` (`getAutoCompactTokenLimit`); `core/RepublicAgent.ts:547` (passive `Compact mode:auto`); `core/engine/RepublicAgentEngine.ts:480,483,746`; `core/models/types/StreamAttemptError.ts:14-53`; `TurnManager.ts:224`; `src/server/agent/ServerAgentBootstrap.ts:714` (headless hard-fail consequence today); UI/server grep: no autonomous Compact sender anywhere.

Notes / honest scoping:
1. *Wiring + safety-net*, not a rewrite — `CompactService` + Track 05b interlock deliberately untouched.
2. browserx is genuinely *ahead* of claudy on trigger-signal accuracy (real `total_tokens`) — don't "import claudy's estimator."
3. Strategy breadth (microcompact/collapseReadSearch/snip) explicitly deferred — efficiency, not the correctness gap.
4. **Multi-platform (2026-05-15):** the fix is one core post-turn hook (fires on all three platforms via `Session`); the *consequence of its absence* is asymmetric — a recoverable UX gap on interactive ext/desktop (human can `/compact`) but a **hard correctness failure on Apple Pi Server** (no human, unbounded growth → `failJob` at `ServerAgentBootstrap.ts:714`). Claudy's circuit-breaker cost rationale (~250k calls/day) is explicitly the fleet/server case. This asymmetry is why the track is headless-motivated and P1.

## Forward-Trace Verification (2026-05-15)

- ✅ **Holds:** Track 08 queue genuinely supports this — `priorityForOp.ts:27` already maps `Compact`→`'later'` (auto-Compact correctly yields to `UserInput`/`Interrupt`). `Session.shouldCompact:766`, `RepublicAgent` engine handle (`requireEngine` `:486`, hook-attach pattern `:362`) all confirmed reachable. Threshold-unify targets real (`CompactService` `constants.ts:37` `0.85`, `TaskRunner.ts:124` `0.85`, `OpenAIResponsesClient.ts:271` `getAutoCompactTokenLimit`).
- ⚠️ **Rescoped — the autonomous trigger is a NET-NEW pattern, not a Track 05b copy.** Forward-trace found: `PostTurnContext` (`SessionSummaryHook.ts:71`) has `totalTokenUsage` but **no `contextWindow`** (source it from the model client); and **no postTurnHook enqueues an op today** — `SessionSummaryHook` works directly, never via the queue. Wiring must be a `RepublicAgent`-level hook holding an engine handle (precedented by `SessionSummaryHook.parentEngine`). Still low-risk; effort Phase 1 S→S–M.
- ⚠️ **Reactive path (Phase 2) — 413 is `Fatal` today.** `StreamAttemptError.fromHttpStatus:73` routes 413 → `fatal()` (non-retryable); "prompt too long" provider errors are often 400 → also Fatal. The reactive hook must intercept on the *message/status* **before** Fatal classification, not as a new retryable union member — coordinate with Track 12's `StreamAttemptError` rescope (shared finding). Per-session circuit breaker + threshold-unify unaffected.
- Shared with Tracks 12/18: the `Session.ts:1614` + new `SessionState.getRateLimits()` getter (Phase 3 tiers ride it). Net effort still **S–M**; no track-invalidating surprise.
