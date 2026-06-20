# Track 25 — Tasks

Implements [Track 25](./design.md). The design is ready; this file makes the execution order
explicit.

Status: DONE. Phase 1 gives headless/main-session autonomy; Phase 2 adds reactive recovery;
Phase 3 adds warning-tier polish and shared observability.

## Phase 1 — Autonomous main-session compaction

- [x] 1.1 Add `src/core/compact/autoCompactHook.ts`.
- [x] 1.2 Construct/register the hook at the `RepublicAgent` level so it has both `Session`
      and engine access.
- [x] 1.3 On post-turn, read real token usage from `PostTurnContext`, get the active model's
      `getAutoCompactTokenLimit()`, and evaluate the canonical token-pressure helper.
- [x] 1.4 If compaction is needed, enqueue `{ type: 'Compact', mode: 'auto' }` through the
      existing engine/CommandQueue path.
- [x] 1.5 Add guards: no duplicate enqueue while compact is pending/running, no recursive
      enqueue immediately after an auto-compact turn, and consecutive-failure circuit breaker
      with max 3 failures per session.
- [x] 1.6 Test: main session over threshold enqueues exactly one later-priority Compact;
      user input/interrupt priority still wins; repeated failed compactions trip the breaker.

## Phase 2 — Reactive context-overflow compact-and-retry

- [x] 2.1 Extend Track 12's model-call error classification so HTTP 413 and provider
      "prompt/context too long" errors are recognized before they become plain fatal errors.
- [x] 2.2 Add a per-session `onContextOverflow` path at the `TurnManager` model-call boundary.
- [x] 2.3 On first overflow, run `Session.compact()` and retry the model request with the
      rebuilt prompt before consuming normal retry budget.
- [x] 2.4 Add a max-3 consecutive overflow circuit breaker; after it trips, surface the
      original failure instead of looping.
- [x] 2.5 Test: simulated 413 triggers compact then retry; repeated overflow trips breaker;
      non-overflow fatal errors remain fatal.

## Phase 3 — Threshold unification + warning tiers

- [x] 3.1 Make model-provided `getAutoCompactTokenLimit()` / `TokenUsageInfo.auto_compact_token_limit`
      the canonical threshold for main-session and sub-agent compaction.
- [x] 3.2 Remove hard-coded threshold drift where practical (`CompactService` default,
      `TaskRunner.COMPACTION_THRESHOLD`, client 0.8 behavior) or route callers through a
      shared helper.
- [x] 3.3 Add `calculateTokenWarningState` in `src/core/compact/` with warning/error/blocking
      tiers derived from the canonical threshold/window.
- [x] 3.4 Surface warning tiers through `Session.sendTokenCountEvent` without regressing rate
      limit/cost consumers.
- [x] 3.5 Test: threshold helper returns consistent values for OpenAI/Gemini/custom clients;
      token count event includes the expected tier fields.

## Exit criteria

- Main sessions self-compact after successful turns on extension, desktop, and server.
- Context-overflow model errors compact and retry once through the shared model-call boundary.
- Auto-compaction cannot storm indefinitely.
- Main-session and sub-agent compaction thresholds come from one canonical source.
- Token-pressure events expose useful warning tiers.
