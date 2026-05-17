# Track 41 Tasks: Shadow Agent Runtime

## Phase 0: Shared Child-Agent Foundation

- [ ] Reuse or implement the child-engine `initialHistory` seam described in Track 40.
- [ ] Reuse or implement non-persistent `Session` hydration for forked/parent-history child runs.
- [ ] Reuse or implement conversion from selected `ResponseItem[]` history into forked `InitialHistory` rollout items.
- [ ] Reuse or extract tool-call pairing trim from Track 15 rewind logic.
- [ ] Extract reusable child tool registry filtering from `ToolRegistryCloner`.
- [ ] Ensure child registries for shadow agents never include sub-agent management tools.
- [ ] Add foundation tests if Track 40 has not already added them.

## Phase 1: Runtime Skeleton

- [ ] Add `src/core/shadowAgent/types.ts` with `ShadowAgentKind`, `ShadowAgentPriority`, `ShadowContextPolicy`, `ShadowFailurePolicy`, and request/result types.
- [ ] Add `src/core/shadowAgent/builtins.ts` with immutable profiles for session summary, compact, prompt suggestion, memory extraction, and diagnostics.
- [ ] Add `ShadowAgentEvents.ts` and event payload types.
- [ ] Add `ShadowAgentContext.ts` for building policy-specific child initial history.
- [ ] Add `ShadowAgentRunner` that creates a child engine from a parent engine without registering a `sub_agent` type.
- [ ] Add unit tests for runner context/tool-policy resolution.

## Phase 2: Scheduler, Concurrency, And Failure Policy

- [ ] Add `ShadowAgentScheduler` with total active limit and per-kind limits.
- [ ] Implement queue policies: `queue`, `coalesce_latest`, `abort_previous`, and `drop_duplicate`.
- [ ] Implement `dedupeKey` handling.
- [ ] Implement timeout and cancellation.
- [ ] Implement failure policies: `throw`, `return_error`, `log_and_suppress`, and `fallback`.
- [ ] Emit start/completion/failure/cancel/coalesce/timeout/fallback events.
- [ ] Add scheduler unit tests for all queue and failure policies.

## Phase 3: Lifecycle Integration

- [ ] Attach one shadow scheduler to each top-level `RepublicAgent` or session runtime.
- [ ] Expose a narrow internal accessor for services that need shadow execution.
- [ ] Cancel queued and active shadow jobs on shutdown/dispose.
- [ ] Add diagnostics snapshot API for active, queued, recent, failed, timed-out, and fallback jobs.
- [ ] Add telemetry fields for `kind`, `priority`, `status`, `duration_ms`, `timeout_ms`, `failure_policy`, and model override.

## Phase 4: Session Summary Migration

- [ ] Replace `SessionSummaryHook`'s dedicated `SubAgentRunner` with `ShadowAgentScheduler`.
- [ ] Preserve current trigger thresholds and in-flight/coalescing behavior through scheduler policy.
- [ ] Preserve path-locked `file_edit` behavior.
- [ ] Preserve summary cache refresh and compaction interlock behavior.
- [ ] Remove `quietBackground` dependency from the session-summary path.
- [ ] Ensure extractor completion cannot leave typed background task state permanently running.
- [ ] Remove `session_summary_extractor` from user-facing sub-agent registration if no remaining caller needs it.
- [ ] Update session-summary unit tests.
- [ ] Add one extract-to-file integration test through shadow runtime.

## Phase 5: Compaction Integration

- [ ] Add optional shadow compaction preparation path behind a feature flag or explicit runtime config.
- [ ] Keep existing direct `CompactService` path as fallback/correctness path.
- [ ] Wire `ShadowFailurePolicy.Fallback` for shadow compact requests.
- [ ] Preserve session-summary wait/interlock behavior before direct compaction.
- [ ] Add timeout/fallback tests.
- [ ] Document when compaction should use direct vs shadow execution.

## Phase 6: Cleanup And Regression

- [ ] Audit internal callers for remaining `quietBackground` usage.
- [ ] Deprecate or remove `quietBackground` if no internal caller needs it.
- [ ] Update developer docs to distinguish sub-agent, forked subagent, shadow agent, and conversation fork.
- [ ] Verify shadow jobs do not appear in `list_sub_agents`.
- [ ] Verify shadow jobs do not inject `<task-notification>` unless explicitly bridged.
- [ ] Run sub-agent, session-summary, compact, task-state, and shutdown test suites.
