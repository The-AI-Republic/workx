# Track 41 Tasks: Shadow Agent Runtime

Status: DONE; re-verified 2026-05-18 on `origin/agent-improvements` at `e9bbff26`.

## Phase 0: Shared Child-Agent Foundation

- [x] Reuse or implement the child-engine `initialHistory` seam described in Track 40.
- [x] Reuse or implement non-persistent `Session` hydration for forked/parent-history child runs.
- [x] Reuse or implement conversion from selected `ResponseItem[]` history into forked `InitialHistory` rollout items.
- [x] Reuse or extract tool-call pairing trim from Track 15 rewind logic.
- [x] Extract reusable child tool registry filtering from `ToolRegistryCloner`.
- [x] Ensure child registries for shadow agents never include sub-agent management tools.
- [x] Add foundation tests if Track 40 has not already added them.

## Phase 1: Runtime Skeleton

- [x] Add `src/core/shadowAgent/types.ts` with `ShadowAgentKind`, `ShadowAgentPriority`, `ShadowContextPolicy`, `ShadowFailurePolicy`, and request/result types.
- [x] Add `src/core/shadowAgent/builtins.ts` with immutable profiles for session summary, compact, prompt suggestion, memory extraction, and diagnostics.
- [x] Add `ShadowAgentEvents.ts` and event payload types.
- [x] Add `ShadowAgentContext.ts` for building policy-specific child initial history.
- [x] Add `ShadowAgentRunner` that creates a child engine from a parent engine without registering a `sub_agent` type.
- [x] Add unit tests for runner context/tool-policy resolution.

## Phase 2: Scheduler, Concurrency, And Failure Policy

- [x] Add `ShadowAgentScheduler` with total active limit and per-kind limits.
- [x] Implement queue policies: `queue`, `coalesce_latest`, `abort_previous`, and `drop_duplicate`.
- [x] Implement `dedupeKey` handling.
- [x] Implement timeout and cancellation.
- [x] Implement failure policies: `throw`, `return_error`, `log_and_suppress`, and `fallback`.
- [x] Emit start/completion/failure/cancel/coalesce/timeout/fallback events.
- [x] Add scheduler unit tests for all queue and failure policies.

## Phase 3: Lifecycle Integration

- [x] Attach one shadow scheduler to each top-level `RepublicAgent` or session runtime.
- [x] Expose a narrow internal accessor for services that need shadow execution.
- [x] Cancel queued and active shadow jobs on shutdown/dispose.
- [x] Add diagnostics snapshot API for active, queued, recent, failed, timed-out, and fallback jobs.
- [x] Add telemetry fields for `kind`, `priority`, `status`, `duration_ms`, `timeout_ms`, `failure_policy`, and model override.

## Phase 4: Session Summary Migration

- [x] Replace `SessionSummaryHook`'s dedicated `SubAgentRunner` with `ShadowAgentScheduler`.
- [x] Preserve current trigger thresholds and in-flight/coalescing behavior through scheduler policy.
- [x] Preserve path-locked `file_edit` behavior.
- [x] Preserve summary cache refresh and compaction interlock behavior.
- [x] Remove `quietBackground` dependency from the session-summary path.
- [x] Ensure extractor completion cannot leave typed background task state permanently running.
- [x] Remove `session_summary_extractor` from user-facing sub-agent registration if no remaining caller needs it.
- [x] Update session-summary unit tests.
- [x] Add one extract-to-file integration test through shadow runtime.

## Phase 5: Compaction Integration

- [x] Add optional shadow compaction preparation path behind a feature flag or explicit runtime config.
- [x] Keep existing direct `CompactService` path as fallback/correctness path.
- [x] Wire `ShadowFailurePolicy.Fallback` for shadow compact requests.
- [x] Preserve session-summary wait/interlock behavior before direct compaction.
- [x] Add timeout/fallback tests.
- [x] Document when compaction should use direct vs shadow execution.

## Phase 6: Cleanup And Regression

- [x] Audit internal callers for remaining `quietBackground` usage.
- [x] Deprecate or remove `quietBackground` if no internal caller needs it.
- [x] Update developer docs to distinguish sub-agent, forked subagent, shadow agent, and conversation fork.
- [x] Verify shadow jobs do not appear in `list_sub_agents`.
- [x] Verify shadow jobs do not inject `<task-notification>` unless explicitly bridged.
- [x] Run sub-agent, session-summary, compact, task-state, and shutdown test suites.
