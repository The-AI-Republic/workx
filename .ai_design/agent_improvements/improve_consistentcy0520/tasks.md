# Track improve_consistentcy0520 Tasks

Status: OPEN
Date: 2026-05-20

Implementation rule: each phase must land with a failing regression first, then the
production fix, then validation. Keep phases reviewable; do not bundle unrelated phases into
one PR unless the code dependency is unavoidable.

## Phase 0 - Regression Harness

- [ ] 0.0 Confirm the overlap posture table in `design.md` before opening implementation PRs;
      do not start duplicate work against Tracks 27/28/29/32/33/35/36/37/40.
- [ ] 0.1 Add prompt isolation regression for two simultaneous sessions with different
      memory, session summary, skills, and plan-review state.
- [ ] 0.2 Add lifecycle regression covering `RepublicAgent.cleanup()`,
      `AgentSession.terminate()`, `Session.close()`, `Session.shutdown()`, and engine
      disposal with fake timers/listener counts.
- [ ] 0.3 Add post-turn regression proving hooks see the assistant/tool output from the
      just-completed turn.
- [ ] 0.4 Add config regression for `tools.parallelToolCalls` and model A -> B -> A cache
      reuse.
- [ ] 0.5 Add hook-generation regression for a hooks reload between PreToolUse and
      PostToolUse.
- [ ] 0.6 Add tool-lifecycle regression requiring one terminal event for every started tool.
- [ ] 0.7 Add approval-serialization regression for parallel sibling checks.
- [ ] 0.8 Add background sub-agent approval regression for `approvalPolicy: inherit` plus
      mutation-capable tools.
- [ ] 0.9 Add skill `allowed-tools` dispatch regression.
- [ ] 0.10 Add storage retention regression for rollout-referenced persisted output under
      quota cleanup.
- [ ] 0.11 Add fork-recursion guard regression.

## Phase 1 - Session-Scoped Prompt Runtime

- [ ] 1.0 Add temporary rollout/rollback flag for session-scoped prompt runtime, using the
      existing feature-flag/config pattern from Track 22 where practical.
- [ ] 1.1 Add `PromptRuntimeContext` and scoped prompt-extension registration in
      `src/core/PromptLoader.ts`.
- [ ] 1.2 Keep compatibility wrappers for old global prompt-extension callers.
- [ ] 1.3 Convert `memory` prompt extension to session scope in `RepublicAgent`.
- [ ] 1.4 Convert `session_summary` prompt extension to session scope in
      `SessionSummaryHook`.
- [ ] 1.5 Make plan-review dynamic runtime context derive from the active session/turn
      `ToolRegistry`, not global state.
- [ ] 1.6 Audit desktop and extension skill prompt rendering; scope it if rendered output
      varies by session or active tab.
- [ ] 1.7 Pass `PromptRuntimeContext` from every `loadPrompt(...)` call site that has
      session context.
- [ ] 1.8 Validate prompt isolation tests.

## Phase 2 - Unified Lifecycle Disposal

- [ ] 2.1 Add idempotent `Session.dispose(options)` and route `close()` / `shutdown()`
      through it.
- [ ] 2.2 Track `active` / `disposing` / `disposed` state so repeated dispose calls await or
      return without double-firing hooks or double-flushing rollout.
- [ ] 2.3 Define and implement in-flight task/tool behavior: stop new input, abort active
      tasks, signal cancellable tools, wait-or-timeout non-cancellable tools, and discard
      late synthetic notifications.
- [ ] 2.4 Add a commit/flush guard so disposal cannot flush/close rollout while
      `recordConversationItemsDual(...)` is writing.
- [ ] 2.5 Detach summary hook, post-turn hooks, prompt extensions, memory services, and
      config/plugin watchers during disposal.
- [ ] 2.6 Explicitly clear the terminal-task eviction timer.
- [ ] 2.7 Ensure `RepublicAgent.cleanup()` disposes the session even when the engine does
      not own it.
- [ ] 2.8 Ensure `SessionEnd` and other terminal hooks fire at most once per session.
- [ ] 2.9 Preserve durable stores for persistent sessions and clean nonpersistent child
      stores.
- [ ] 2.10 Validate lifecycle fake-timer/listener-count tests.

## Phase 3 - Post-Turn And Config Generation Consistency

- [ ] 3.0 Add temporary rollout/rollback flag for post-turn-after-commit timing if needed
      for staged deployment.
- [ ] 3.1 Remove post-turn hook firing from `TurnManager` before conversation commit.
- [ ] 3.2 Fire post-turn hooks from `TaskRunner` after `processTurnResult()` records the
      completed assistant/tool output.
- [ ] 3.3 Include committed history and committed delta in `PostTurnContext`.
- [ ] 3.4 Add `tools` to `IConfigChangeEvent['section']` and remove `as any` tools emits.
- [ ] 3.5 Update `RepublicAgent` config subscriptions for all client-feeding sections.
- [ ] 3.6 Include construction-time client inputs in `ModelClientFactory` cache keys and
      clear relevant cache entries on every client-feeding generation change.
- [ ] 3.7 Add hook snapshot support so one tool execution uses one hook generation.
- [ ] 3.8 Validate post-turn, model-cache, and hook-generation tests.

## Phase 4 - Tool, Approval, Skill, And Sub-Agent Semantics

- [ ] 4.0 Add temporary rollout/rollback flag for strict background approval behavior.
- [ ] 4.1 Add a terminal-event helper in `ToolRegistry.execute()` and use it on every return
      path after `ToolExecutionStart`.
- [ ] 4.2 Emit terminal events for validation failure, pre-execute denial, plan-review
      freeze, approval denial, timeout, handler exception, and success.
- [ ] 4.3 Pass an `onProgress` callback from `TurnManager.executeBrowserTool()` into
      `ToolRegistry.execute()`.
- [ ] 4.4 Make `ToolRegistry.replace()` gap-free by building the replacement entry first,
      swapping the map entry synchronously, then emitting an update event.
- [ ] 4.5 Add per-decision in-flight serialization to `ApprovalGate.check()`.
- [ ] 4.6 Add explicit noninteractive/background approval semantics to sub-agent behavior.
- [ ] 4.7 Fail fast for background inherited-approval runs with mutation-capable tools unless
      the type is explicitly trusted/read-only/path-locked.
- [ ] 4.8 Enforce skill `allowed-tools` in dispatch for inline and forked skills.
- [ ] 4.9 Bring server and extension `use_skill` behavior to parity or suppress skill prompt
      advertising where execution is unavailable.
- [ ] 4.10 Add fork-recursion guard before child-engine creation using runtime metadata only;
      do not use `<forked-subagent-task>` as a policy signal.
- [ ] 4.11 Validate tool lifecycle, approval serialization, background approval, skill
      allow-list, and fork guard tests.

## Phase 5 - Storage Lifetime Policy

- [ ] 5.0 Add temporary rollout/rollback flag for owner-metadata-based result retention.
- [ ] 5.1 Wire `TaskOutputManager` into production `StorageQuotaManager` construction where
      `task_output_chunks` can exist.
- [ ] 5.2 Define and implement one tier ordering for task output, persisted tool results,
      rollout-referenced results, and rollout/session state.
- [ ] 5.3 Extend persisted-result metadata with owner records:
      `persistent_rollout` or `transient_session`.
- [ ] 5.4 Persist tool outputs with `persistent_rollout` owner metadata when the preview is
      recorded into durable rollout history.
- [ ] 5.5 Persist child/nonpersistent data with `transient_session` owner metadata.
- [ ] 5.6 Make persisted-result cleanup pointer-aware for persistent rollouts.
- [ ] 5.7 Prevent model-facing delete paths from deleting rollout-referenced blobs.
- [ ] 5.8 Treat legacy blobs without owner metadata conservatively as durable until
      classified.
- [ ] 5.9 Preserve nonpersistent child cleanup behavior.
- [ ] 5.10 Validate quota/retention tests under pressure and after session close/reopen.

## Phase 6 - Documentation And Track Status

- [ ] 6.1 Add `.ai_design/agent_improvements/track_status.yml` with the schema defined in
      `design.md`.
- [ ] 6.2 Add a status check that verifies README rows, folders, `_DONE` suffixes, and ledger
      entries agree.
- [ ] 6.3 Normalize README status for Track 23, Track 40, Track 43, and this track.
- [ ] 6.4 Update stale source comments that encode false track assumptions, including the
      Track 23 / Track 18 status drift.
- [ ] 6.5 Record which previous follow-up tracks are closed by this consistency work.
- [ ] 6.6 Validate the ledger can identify README/folder/tasks status drift.

## Final Validation

- [ ] Run `npm run type-check`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run test -- --run`.
- [ ] Manually review prompt/session cleanup behavior in a multi-session scenario.
- [ ] Confirm no old DONE design doc was modified except through an explicit docs-status
      decision.
