# Track 25: Autonomous & Reactive Context Compaction

**Priority: P1** · **Effort: S–M** · **Status: NOT STARTED**

> Source: third-pass claudy↔browserx research (2026-05-14), prompted by a context-window-management comparison. Grounded in a full read of claudy's compaction subsystem and browserx's compaction seams — see "Validation Notes". Closes two robustness gaps that matter most for *unattended* runs; companion to Track 12 (Rate-Limit Resilience), with which it shares the model-call boundary.

## Problem

BrowserX's compaction *machinery* is solid (`CompactService`, Track 05b summary interlock, Track 09 tool-result offload) and `Session.shouldCompact()` already uses the **real** API token count. But it is not wired for autonomy or recovery:

1. **No autonomous main-loop trigger.** The only self-triggering compaction is the sub-agent path (`TaskRunner.shouldCompactBeforeRequest`, `TaskRunner.ts:343,776`). The interactive/headless **main session never self-compacts**: `Compact mode:auto` is only a passive submission handler (`RepublicAgent.ts:546-547`); nothing in `TurnManager`/`RepublicAgentEngine`/UI/server enqueues it from token pressure (verified by grep). A long unattended server/scheduler run with no front-end sending `Compact` grows unbounded until it hard-fails.
2. **No reactive recovery.** There is zero 413 / "prompt too long" / context-overflow handling on a normal turn (`TurnManager`/`Session`/engine grep is empty). The only overflow handling is the trim-oldest retry *inside* a `CompactService.compact()` call. If the proactive trigger never fires (not wired, or estimate off), the turn fails with no recovery.

Operability is also thinner than claudy: a single boolean `shouldCompact` (no graduated "context low" tiers), no cross-turn circuit breaker, no recompaction-chain awareness.

## What Claudy Does

**Proactive — every turn, in the query loop.** `autoCompactIfNeeded()` (`services/compact/autoCompact.ts:241`) is called inside `query.ts`'s loop on every turn. `shouldAutoCompact()` (`:160`) compares `tokenCountWithEstimation(messages)` against `getAutoCompactThreshold()` (`:72` = effective window − `AUTOCOMPACT_BUFFER_TOKENS` 13k). `calculateTokenWarningState()` (`:93-145`) returns graduated tiers: `percentLeft`, `isAboveWarningThreshold`, `isAboveErrorThreshold`, `isAboveAutoCompactThreshold`, `isAtBlockingLimit`. A **circuit breaker** stops after `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (`:70`, with cited prod data: ~250k wasted API calls/day without it). `AutoCompactTrackingState` (`:51-60`) threads turn/recompaction-chain state.

**Reactive — real API 413 fallback.** `query.ts:15-16` lazily loads `services/compact/reactiveCompact.ts` (feature-gated `REACTIVE_COMPACT`). In the loop, `query.ts:811` `reactiveCompact?.isWithheldPromptTooLong(message)` and `:1119` `if ((isWithheld413 || isWithheldMedia) && reactiveCompact)` catch a *real* API prompt-too-long / media-size error and compact-then-retry; `compact.ts:238,472,882` implement the lossy oldest-context trim + `prompt_too_long` telemetry. Proactive and reactive are deliberately complementary (`autoCompact.ts:189-223`: reactive-only mode suppresses proactive and lets the 413 drive).

## BrowserX Mapping

### The real seam — machinery exists, wiring does not

| Concern | BrowserX location | State |
|---|---|---|
| Post-turn hook | `Session.registerPostTurnHook(fn)` (`Session.ts:519`) — "fires after every successful turn (after `Completed` in TurnManager)", errors swallowed | **The clean autonomous-trigger seam** (Track 05b extension point, already used by the session-summary hook) |
| Trigger fn | `Session.shouldCompact(contextWindow)` (`Session.ts:766-769`) → real `tokenInfo.total_tokens` | Correct and accurate — **just never called in the main loop** |
| Auto-compact limit | `ModelClient.getAutoCompactTokenLimit()` = `contextWindow * 0.8` (`OpenAIResponsesClient.ts:266-269`, also Google client); `TokenUsageInfo.auto_compact_token_limit` | Defined per-client, unused by a trigger |
| Enqueue path | `RepublicAgent.ts:547` `submitOperation({type:'Compact', mode:'auto'})` → engine `handleCompact` → `Session.compact()`; priority-ordered by shipped Track 08 CommandQueue (`queue/priorityForOp.ts:27`) | Passive only |
| Model-call boundary | `TurnManager.ts:224` `turnContext.getModelClient().stream(...)`; Track 12's `StreamAttemptError.classify()` + retry orchestrator | No `context_overflow` class; the reactive hook belongs here |
| Overflow patterns | `CompactService.isContextOverflowError()` (`CompactService.ts:416-427`): `context_length_exceeded`/`maximum context length`/`token limit`/`context window`/`too many tokens` | Reusable for reactive detection |
| Token-pressure surfacing | `Session.sendTokenCountEvent()` (`Session.ts:1607`, called `:2465/:2485`); the `Session.ts:1610` discard bug noted by Tracks 12/18 | Single boolean; no graduated tiers |
| Threshold constants | `CompactService` `triggerThreshold: 0.85` (`compact/constants.ts`); `TaskRunner.COMPACTION_THRESHOLD = 0.85` (`TaskRunner.ts:124`); client `getAutoCompactTokenLimit` 0.8 | **Three inconsistent thresholds** |

### Key design decisions (and divergences from claudy)

1. **Autonomous trigger via the existing post-turn hook — do not touch `CompactService`.** Register a `postTurnHook` (the Track 05b seam, `Session.ts:519`) that calls the already-correct `Session.shouldCompact(contextWindow)` and, if true, enqueues `{type:'Compact', mode:'auto'}` through the engine's **shipped Track 08 priority CommandQueue** (so an auto-Compact is ordered correctly vs `Interrupt`/`UserInput`). This gives the interactive *and headless* main session claudy's per-turn proactivity with near-zero risk — the heavy-tested compaction path is unchanged. **Divergence from claudy:** browserx has no query-loop generator and no terminal; the trigger is a post-turn hook + SQ/EQ enqueue, not an inline `autoCompactIfNeeded` call.

2. **Keep browserx's accurate signal — the gap is wiring, not estimation.** `Session.shouldCompact` already uses real API `total_tokens`; claudy uses `tokenCountWithEstimation`. Do **not** replace it with an estimate. (The crude `length/4` in `CompactService.estimateTokens` stays a post-compact metric only.) This is a point where browserx is *ahead* and must not regress.

3. **Reactive recovery integrates with Track 12's boundary, not a parallel path.** Add a `context_overflow` classification to Track 12's `StreamAttemptError.classify()` (detect 413 + reuse `CompactService.isContextOverflowError` string set + provider `prompt is too long`). On classify at `TurnManager.ts:224`: trigger a compact (synchronous compact-then-retry, or enqueue + replay) **before** consuming a normal retry, gated by a per-session **consecutive-overflow circuit breaker** (mirror claudy's `MAX=3`). This deliberately rides Track 12's retry orchestrator so there is one model-call resilience boundary, not two.

4. **Unify the three thresholds.** `0.85` (CompactService), `0.85` (TaskRunner), `0.8` (`getAutoCompactTokenLimit`) must reconcile to one source of truth — adopt `getAutoCompactTokenLimit()` (per-model, already plumbed via `TokenUsageInfo.auto_compact_token_limit`) as canonical; main + sub-agent paths consume it. Currently main and sub-agent can disagree on when to compact.

5. **Graduated warning tiers + circuit breaker (operability parity).** Add a claudy-style `calculateTokenWarningState` (percentLeft / warning / error / blocking) and surface it on the existing `sendTokenCountEvent` path (the same `Session.ts:1610` fix Tracks 12/18 already need — one fix, three consumers: rate-limit, cost, context-pressure). Add a per-session consecutive-autocompact-failure breaker (claudy's cited 250k/day rationale applies to any unattended fleet).

6. **Out of scope for v1 (explicit).** Microcompaction (`microCompact.ts`), `collapseReadSearch` (1,110 LOC duplicate-read collapsing), history snip, context-collapse — claudy's *strategy breadth*. These are efficiency, not correctness; browserx's single full-compaction + Track 05b hint + Track 09 offload is an acceptable strategy. This track closes the **correctness/robustness** gaps (trigger + reactive), not strategy breadth — deferred, not denied.

### Phase plan

- **Phase 1 (P1, S):** autonomous trigger — `postTurnHook` → `Session.shouldCompact()` → priority-enqueue `Compact mode:auto`; unify on `getAutoCompactTokenLimit()`. Closes the headless/unattended gap with the lowest-risk change.
- **Phase 2 (P1, S–M):** reactive recovery — `context_overflow` class in Track 12's `StreamAttemptError`/orchestrator at `TurnManager.ts:224`, compact-then-retry, per-session circuit breaker.
- **Phase 3 (P1, S):** graduated `calculateTokenWarningState` tiers surfaced via the shared `sendTokenCountEvent`/`Session.ts:1610` fix (coordinate with Tracks 12/18); consecutive-autocompact-failure breaker.

## Dependencies

- **Track 12** (Rate-Limit Resilience): shares the `TurnManager.ts:224` model-call boundary, `StreamAttemptError.classify()`, retry orchestrator, and the circuit-breaker pattern — Phase 2 must land on Track 12's orchestrator, not beside it
- **Track 08** (CommandQueue, shipped): priority-ordered auto-`Compact` enqueue
- **Track 05 / 05b** (DONE): the compaction this track *triggers*; the `registerPostTurnHook` seam is Track 05b's
- **Track 16** (Telemetry) & **Track 18** (Migration) & **Track 12**: all share the `Session.ts:1610` `sendTokenCountEvent` fix — context-pressure tiers are a fourth rider on that one change
- **Track 04** (Typed Tasks): `TaskRunner` sub-agent path unified onto the canonical threshold

## Risks

- Enqueue storm: an auto-`Compact` that fails and re-triggers next turn is the exact failure claudy's circuit breaker exists for — Phase 1 must ship with at least a minimal "don't re-enqueue while one is pending / after N failures" guard, not defer it to Phase 3.
- Ordering: auto-`Compact` must not preempt an in-flight `UserInput`/`Interrupt` — rely on the shipped Track 08 priority lanes; add a test.
- Reactive double-handling: a 413 must be handled by exactly one of Track 12 retry vs Track 25 compact — the `StreamAttemptError` class is the single arbiter (compact-then-retry consumes the attempt deterministically).
- Threshold unification could change when existing sub-agent runs compact (0.85→0.8) — acceptable (earlier is safer) but call it out in the change.
- Don't regress the accurate signal: keep `Session.shouldCompact` on real `total_tokens`; never swap in `estimateTokens`.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `services/compact/autoCompact.ts:51-60` (`AutoCompactTrackingState`), `:70` (`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` + prod rationale), `:72-91` (`getAutoCompactThreshold`), `:93-145` (`calculateTokenWarningState` tiers incl. `isAtBlockingLimit`), `:160-239` (`shouldAutoCompact`), `:241` (`autoCompactIfNeeded`), `:189-223` (proactive/reactive complementarity); `query.ts:15-16` (`reactiveCompact` feature-load), `:811` (`isWithheldPromptTooLong`), `:1119` (413/media reactive path); `services/compact/compact.ts:238,472,882` (lossy trim + `prompt_too_long` telemetry).
- browserx: `core/Session.ts:513-520` (`registerPostTurnHook` — the seam), `:766-769` (`shouldCompact` on real `total_tokens`), `:1607` (`sendTokenCountEvent`, called `:2465/:2485`), `:1610` (discard bug, shared fix); `core/compact/CompactService.ts:61-80` (`shouldCompact`), `:416-427` (`isContextOverflowError` patterns), `compact/constants.ts` (`triggerThreshold 0.85`); `core/TaskRunner.ts:124` (`COMPACTION_THRESHOLD 0.85`), `:343,776` (sub-agent self-trigger); `core/models/client/OpenAIResponsesClient.ts:266-269` (`getAutoCompactTokenLimit` = ctx*0.8); `core/RepublicAgent.ts:546-547` (passive `Compact`); `core/engine/RepublicAgentEngine.ts:479-483,746-801` (`handleCompact`); `TurnManager.ts:224` (model-call boundary); UI/server grep: **no** autonomous Compact sender anywhere.

Notes / honest scoping:
1. This is a *wiring + safety-net* track, not a rewrite — `CompactService` and the Track 05b interlock are deliberately untouched (they are good and well-tested).
2. browserx is genuinely *ahead* of claudy on trigger-signal accuracy (real `total_tokens` vs estimation) — recorded so a future implementer doesn't "import claudy's estimator" as an improvement.
3. Strategy breadth (microcompact / collapseReadSearch / snip) is explicitly deferred: it is efficiency, not the correctness gap the context-window comparison surfaced.
