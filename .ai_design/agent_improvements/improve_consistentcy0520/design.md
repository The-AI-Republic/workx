# Track improve_consistentcy0520: Cross-Track Consistency Hardening

Date: 2026-05-20
Status: OPEN - P0/P1 integration hardening
Type: Cross-track consistency and regression track
Branch audited: `agent-improvements` at `dafce222`
Tasks: `./tasks.md`
Aliases: `improve_consistency_0520`, `consistency-hardening-0520`
Scope: `.ai_design/agent_improvements/*` design tracks plus the current branch implementation that landed from those tracks. Adjacent Apple Pi designs are noted only where their merged code touches agent-improvement seams.

> The directory name intentionally keeps the user-requested spelling:
> `improve_consistentcy0520`.

## Why This Track Exists

Many tracks under `.ai_design/agent_improvements/` are marked `DONE`, but they were
implemented one at a time. The implementation now has several shared seams where individually
reasonable track code composes poorly:

- global prompt/runtime state shared across sessions;
- multiple session shutdown paths with different cleanup guarantees;
- config updates that do not invalidate all consumers built from that config;
- background and forked agent paths that do not consistently inherit approval/tool policy;
- tool-result, task-output, rollout, and quota lifetimes that are not governed by one storage
  contract;
- track status metadata that no longer matches the merged branch.

This track is not another feature track. Its job is to restore a small set of runtime
contracts that all completed and open tracks must obey.

## Contracts To Restore

1. **Session isolation**: prompt extensions, dynamic runtime context, memory, summaries, plan
   review state, and skill visibility must be scoped to the active session/turn.
2. **One teardown path**: every public close/cleanup/terminate path must run the same
   idempotent session disposal contract.
3. **Committed post-turn state**: post-turn hooks must observe the completed turn after the
   assistant/tool output has been recorded.
4. **Stable config generation per action**: model clients, hook registries, and tool dispatch
   must use an intentional config generation and invalidate/rebuild when constructor inputs
   change.
5. **No implicit permission downgrade**: background/forked/skill/shadow execution may be
   noninteractive, but it must not silently broaden tools or auto-approve mutation.
6. **Balanced tool lifecycle**: every tool start must have a terminal outcome; progress and
   gate-denial surfaces must be observable consistently.
7. **Single storage lifetime policy**: rollout pointers, persisted tool results, task output,
   caches, and quota eviction must be ordered so durable references do not point at vanished
   data.
8. **Truthful track ledger**: folder names, README status, tasks, and merged code must agree.

## Design Review Verdict

The findings are source-backed and real. The original version of this document was not yet
implementation-ready because it described the desired contracts but left three things open:

1. phase boundaries were too broad for safe review;
2. the new runtime APIs were not named;
3. test ownership was not mapped to files.

This version makes the track implementation-ready by defining the PR-sized slices below,
the concrete files each slice should touch, and the regression tests that must fail before
the production fix lands.

## Implementation Readiness Decisions

1. **Land this as six small PRs, not one large refactor.** The safe order is:
   prompt scoping, lifecycle disposal, post-turn/config generation, tool/approval semantics,
   storage lifetime, documentation ledger.
2. **Keep compatibility wrappers during migration.** Existing `loadPrompt(mode)`,
   `registerPromptExtension(name, fn)`, and `setDynamicRuntimeContext(fn)` callers should
   continue to compile while new session-aware overloads are introduced.
3. **Prefer idempotent cleanup over caller-perfect cleanup.** Both `close()` and
   `shutdown()` should be safe to call multiple times and in either order.
4. **Use existing event shapes where possible.** For balanced tool lifecycle, prefer adding
   optional fields to existing events or emitting existing terminal events consistently
   before inventing a parallel event family.
5. **Do not edit old DONE design docs as part of this implementation.** Track status drift is
   fixed in README/status-ledger artifacts and stale source comments. Old designs remain
   historical records unless a separate docs cleanup track says otherwise.
6. **Use runtime metadata for policy decisions.** Prompt-visible tags are useful context for
   the model, but they must not be used as security or recursion guards.
7. **Use owner metadata for persisted-result reachability.** This track chooses
   persisted-result owner metadata over a separate refcount table or full mark-and-sweep as
   the first implementation because quota cleanup needs cheap, local decisions.
8. **Use one machine-checkable status ledger.** This track should introduce
   `.ai_design/agent_improvements/track_status.yml` as the canonical machine-readable status
   layer, with README rows remaining the human index.

## Ownership Against Existing Tracks

This track restores shared contracts. It should not silently duplicate older follow-up work.
The table below is the implementation posture for overlapping areas.

| Area | Existing track | Posture | This track owns | Existing track remains owner of |
|------|----------------|---------|-----------------|---------------------------------|
| Session-scoped prompt/runtime context | none | absorb here | C1 design, implementation, tests | none |
| Unified session disposal | Track 34 partially, Track 41 cleanup tests | absorb here | One idempotent close/shutdown/dispose contract and timer/watcher cleanup | Historical extractor phantom details already fixed by Track 41 |
| Post-turn hook commit ordering | none | absorb here | C3 move to after commit plus committed delta context | none |
| Skill `allowed-tools` dispatch gate | Track 28 | coordinate/absorb G1 | Real dispatch enforcement and prompt/execution parity needed to avoid advertising unusable skills | Track 28 non-shared items: orphaned commands, active-tab debounce, parse-time `agent:` validation unless explicitly closed |
| Progress callback plumbing | Track 27 | coordinate | Balanced lifecycle event contract and minimal `onProgress` handoff from `TurnManager` | User-facing progress UX, sibling `AbortController`, and data-extraction bound-tab follow-ups |
| Reactive config and hook generation | Track 35 | absorb if implemented here | Config event typing, client cache-generation inputs, per-tool hook snapshots | Track 35 can be closed or reduced after this lands |
| Tool-exec route tier consistency | Track 33 | defer | Only lifecycle/event consistency unless touched by storage work | Tier-2 budget behavior on legacy single-call route |
| Approval serialization | Track 36 | absorb if implemented here | Per-key in-flight mutex in `ApprovalGate.check()` | Track 36 can be closed or reduced after this lands |
| Task output / result-store tiering | Tracks 29, 32, 37 | coordinate shared decision | Single storage lifetime policy, owner metadata, production `TaskOutputManager` wiring where needed | Any UI delivery or unrelated persistence wiring not required by pointer safety |
| Fork recursion guard | Track 40 | absorb final follow-up | Runtime-metadata fork guard and tests | Broader Track 40 runtime optimization history |
| Track status drift | none | absorb here | Status ledger schema and README normalization | none |

## Audit Findings

### C1 - P0: Prompt/runtime context is global but sessions are not

Evidence:

- `src/core/PromptLoader.ts` keeps module-level `promptExtensions`,
  `dynamicContextProvider`, `configuredAgentType`, and `staticContext`.
- `src/core/RepublicAgent.ts` registers the `memory` prompt extension with a callback that
  closes over one `RepublicAgent.session`.
- `src/core/sessionSummary/SessionSummaryHook.ts` registers `session_summary` the same way.
- desktop/extension bootstraps register `skills` and plan-review runtime context globally.

Bug:

When multiple sessions exist, the newest session can overwrite global prompt callbacks used by
older sessions. A prompt for session A can include session B's memory/summary or inspect
session B's tool registry for plan-review state. Cleanup gaps make stale callbacks likely
after close.

Required fix:

- Replace global prompt-extension state with a session-scoped or turn-scoped registry.
- Pass `sessionId`, `TurnContext`, and `ToolRegistry` into prompt composition instead of
  resolving them through process-global callbacks.
- Keep shared static prompt content global only when it has no session/runtime dependency.
- Ensure session disposal unregisters every session-owned prompt extension.

Validation:

- Two concurrent sessions with different memory, summaries, skills, and plan-review freeze
  states must render isolated prompts.
- Closing one session must not remove or alter another session's prompt extensions.

### C2 - P0/P1: Session teardown is split and incomplete

Evidence:

- `RepublicAgent.cleanup()` disposes the engine but does not call `session.shutdown()`.
- `RepublicAgentEngine.dispose()` only calls `session.shutdown()` when `ownsSession` is true;
  parent engines are created with `ownsSession: false`.
- `AgentSession.terminate()` calls `session.close()` before `agent.cleanup()`, but
  `Session.close()` does not detach the session-summary hook, clear post-turn hooks, stop the
  eviction timer, or clear shadow/session prompt state.
- `Session.shutdown()` detaches the summary hook and closes some services, but it does not
  abort tasks, clear the eviction timer, or clean task-output state.
- `ConfigHookLoader.watch(...)` returns an unsubscribe function; `RepublicAgent` ignores it.

Bug:

Different close paths leave different resources behind. Direct agent cleanup can skip
session-owned cleanup. Registry-driven termination can skip summary-hook teardown. Eviction
timers, post-turn hooks, prompt extensions, config watchers, background/shadow jobs, and task
stores can survive longer than the session they belong to.

Required fix:

- Add one idempotent `Session.dispose(options)` or equivalent lifecycle method.
- Make `close()`, `shutdown()`, `AgentSession.terminate()`, and `RepublicAgent.cleanup()`
  call the same disposal core.
- Disposal order should be explicit:
  1. stop accepting new input;
  2. abort active tasks and child/shadow work;
  3. detach summary/memory/prompt/post-turn hooks;
  4. unsubscribe config/plugin watchers;
  5. stop eviction and scheduler timers;
  6. flush rollout and telemetry;
  7. close memory/result/output stores according to persistence policy.

Validation:

- Fake-timer tests prove no session eviction interval remains after every close path.
- Listener-count tests prove config/hook subscriptions are removed.
- Closing a persistent session keeps durable data, while closing a nonpersistent child cleans
  child-only result/task output.

### C3 - P1: Post-turn hooks fire before the completed turn is committed

Evidence:

- `src/core/TurnManager.ts` fires `session.firePostTurnHooks(...)` in the `Completed` path.
- `src/core/TaskRunner.ts` records the assistant/tool output later in
  `processTurnResult()`.
- `SessionSummaryHook.handlePostTurn(...)` consumes the history passed from that hook.

Bug:

The session-summary hook can extract from the previous committed history instead of the
just-completed turn. This can lag extraction, miss tool-call state, and make the
auto-extraction/compaction interlock reason over stale input.

Required fix:

- Remove post-turn hook emission from `TurnManager`'s `Completed` branch.
- Have `TurnManager` return post-turn metadata only; `TaskRunner` fires
  `session.firePostTurnHooks(...)` after `processTurnResult()` records the completed turn.
- Build the hook context from the committed session state after
  `recordConversationItemsDual(...)`, not from the pre-commit
  `getConversationHistory().items` snapshot.
- Pass both the committed history and the committed delta so hooks do not need to infer the
  just-finished turn from the whole transcript.

Validation:

- A post-turn hook registered before a turn must see the assistant message and any
  function-call outputs from that same turn.
- Session-summary extraction tests must fail if the hook sees only the previous history.

### C4 - P1 security: Background/forked/skill execution can bypass intended policy

Evidence:

- `src/tools/AgentTool/SubAgentRunner.ts` forces background runs to
  `approvalPolicy = 'never'` even when the sub-agent type says `approvalPolicy: 'inherit'`.
- The comment acknowledges background cannot prompt, but the implementation silently
  downgrades the policy instead of failing or constraining the tools.
- Track 28 remains open: skill `allowed-tools` is parsed and returned by
  `SkillExecutor`, but desktop `use_skill` returns only the inline body and drops the
  allow-list; server/extension parity is still incomplete.
- Forked skills use `sub_agent` through `buildSubAgentInvoker`, so skill, fork, background,
  and approval semantics now overlap.

Bug:

Noninteractive execution is treated as auto-approval. Any background sub-agent type with
mutation-capable tools can run under `never` unless an additional pre-execute check happens
to be installed. Inline skill allow-lists are advertised but not enforced.

Required fix:

- Introduce explicit noninteractive policy semantics:
  - fail fast when a background run would require inherited approval and has mutation-capable
    tools;
  - allow `never` only for trusted internal/read-only/path-locked noninteractive profiles;
  - require plugin/config types to opt into any background mutation capability.
- Define a noninteractive profile as the resolved sub-agent behavior fields that determine
  background execution without prompts: `executionMode`, `toolPolicy`, `approvalPolicy`, and
  an explicit `backgroundApproval` value such as `deny_mutation`, `readonly_only`,
  `path_locked`, or `trusted_never`.
- Enforce skill `allowed-tools` in the actual dispatch path for inline and forked skills.
- Keep shadow-agent internal profiles separate from user-facing sub-agent defaults.

Validation:

- Background sub-agent with `approvalPolicy: inherit` plus a mutating tool returns a
  structured error unless its type explicitly opts into safe noninteractive execution.
- Internal session-summary extraction can still use path-locked `file_edit`.
- Inline skill with `allowed-tools: read_dom` cannot call write/mutation tools.

### C5 - P1: Config reactivity is not a generation-safe contract

Evidence:

- `src/config/types.ts` omits `section: 'tools'`, while `AgentConfig` emits `'tools' as any`.
- `RepublicAgent.setupConfigSubscriptions()` reacts only to `section === 'model'`.
- `ModelClientFactory` caches by provider, selected model key, and routing type; the key does
  not include `parallelToolCalls` or other constructor-time client inputs.
- Hook reloads mutate the live registry; `TurnManager` fires Pre/Post hooks by querying the
  registry at each point instead of using a per-tool snapshot.

Bug:

A config change can leave the model client using stale construction-time values. A hook
reload can cause one tool execution to use different hook generations for PreToolUse and
PostToolUse.

Required fix:

- Add `tools` and any other emitted sections to `IConfigChangeEvent`.
- Version config generations and identify which sections feed model-client construction,
  hook loading, tool policy, prompt composition, and feature flags.
- Include constructor-time inputs in `ModelClientFactory` cache keys and clear relevant cache
  entries when a client-feeding config generation changes.
- Snapshot hooks per tool execution so PreToolUse, PermissionRequest, PostToolUse, and
  PostToolUseFailure for one action are governed by one hook generation.

Validation:

- Toggle `parallelToolCalls` mid-session and assert the next request uses the new value.
- Change model A to B and back to A; the returned A client must reflect current config.
- Reload hooks between PreToolUse and PostToolUse; both phases for one tool use the same
  generation, while the next tool uses the new generation.

### C6 - P1: Tool execution lifecycle is not balanced

Evidence:

- `src/tools/ToolRegistry.ts` emits `ToolExecutionStart` before approval/policy gates, but
  gate denials return without a matching terminal event.
- `TurnManager.executeBrowserTool()` does not supply `onProgress`, so the progress pipeline
  remains inert for normal tool calls.
- `ApprovalGate.check()` has no per-key mutex, so parallel batches can produce duplicate
  prompts for one logical decision.
- `ToolRegistry.replace()` deletes the old tool and then registers the new one, creating a
  short discover/dispatch gap.

Bug:

Diagnostics, telemetry, progress UI, and approval UX cannot rely on a single balanced tool
lifecycle. Parallel tool execution widens the gaps.

Required fix:

- Define a single tool lifecycle envelope: start, gated/denied/blocked, progress, success,
  failure, cancelled.
- Emit a terminal event for gate denial and policy blocks.
- Wire `onProgress` from `TurnManager` into tool requests.
- Add per-decision approval serialization.
- Make tool replacement atomic for discovery and dispatch by swapping from a ready
  replacement entry without a delete-first gap.

Validation:

- Every tool start observed in tests has exactly one terminal event.
- Denied tools are visible as denied, not as missing completion.
- Parallel sibling tool calls for one remembered decision produce one approval prompt.
- Replacing a tool concurrently with discovery cannot produce a transient "tool missing" for
  a previously registered tool.

### C7 - P1: Storage lifetime and quota ordering are fragmented

Evidence:

- `Session` now constructs a tool-result store when platform services are present, but quota
  ownership remains split across session close, result-store sweep, rollout persistence, and
  cache eviction.
- `TaskOutputManager` exists, but this audit found no production `new TaskOutputManager(...)`
  wiring; `StorageQuotaManager` is constructed without a tier-0 evictor in the extension
  service-worker path.
- Track 37 remains open because persisted tool results can disappear while rollout pointers
  still reference them.
- Track 29, Track 32, and Track 37 all mention tier ordering; this needs one decision, not
  three independent fixes.

Bug:

The system can persist a pointer in the rollout that later points at data removed by a
different retention path. Task-output pressure, tool-result pressure, rollout pressure, and
cache pressure are not governed by one durable-reference policy.

Required fix:

- Define the tier ordering once:
  - tier 0: ephemeral task output for terminal/unretained tasks;
  - tier 1: persisted tool results referenced by nonpersistent child sessions;
  - tier 2: persistent rollout-referenced tool results;
  - tier 3: rollout history and user-visible session state.
- Wire `TaskOutputManager` into production quota paths where task-output chunks exist.
- Make result deletion pointer-aware through persisted-result owner metadata. Each persisted
  blob should record an owner:
  - `{ kind: 'persistent_rollout', sessionId, callId }` for results referenced by durable
    rollout history;
  - `{ kind: 'transient_session', sessionId, taskId? }` for nonpersistent child/session data.
- Deletion and quota eviction may remove `transient_session` blobs normally, but must not
  delete `persistent_rollout` blobs unless the owning rollout/session is deleted or a
  reachability check proves the pointer is gone.
- Treat legacy blobs without owner metadata conservatively as rollout-referenced until a
  rebuild/cleanup pass can classify them.
- Make cleanup policy depend on session persistence and reference reachability, not only age.

Validation:

- Persisted output referenced from a rollout remains readable after quota cleanup.
- Nonpersistent child output is cleaned after child disposal.
- Tiered eviction frees lower-tier data before rollout-referenced data.

### C8 - P1/P2: Fork context has opt-in and max-depth, but no explicit fork-recursion tag guard

Evidence:

- Track 40 states one remaining follow-up: an explicit fork-recursion/tag guard.
- `buildForkedSubAgentInitialHistory(...)` adds a `<forked-subagent-task>` directive, but
  there is no explicit guard preventing a forked child from creating another fork through
  inherited fork boilerplate beyond the generic max-depth and type opt-in checks.

Bug:

Max-depth limits bound the damage, but they do not express the intended Track 40 invariant:
forked children should not recursively fork through inherited fork context unless a future
design deliberately enables that behavior.

Required fix:

- Detect active fork context by runtime metadata only: explicit context mode, child-engine
  metadata, session initial-history mode, or a `forkDepth`/`isForkedSubAgent` field.
- Reject nested fork mode with a structured tool error before child-engine creation.
- Preserve isolated child sub-agents if the type permits them.
- Keep `<forked-subagent-task>` as prompt text only. It must never be the source of truth for
  policy or recursion decisions because model-visible text can be copied, removed, or
  paraphrased.

Validation:

- Forked sub-agent attempting `context_mode: "fork"` fails with a clear error.
- Forked sub-agent attempting an isolated sub-agent behaves according to the type's normal
  allowed context modes.

### C9 - P2: Track ledger and merged-code status are stale

Evidence:

- `23_agentic_payments_x402/` is still not marked done in README and `tasks.md` is unchecked,
  but the branch contains x402 implementation code and recent PR history indicates it was
  merged.
- Track 40 is implemented according to README and source, but the folder is not marked
  `_DONE`.
- `43_apple_pi_runtime_decoupling/` exists under agent improvements and code is merged on
  the current branch, but README does not list Track 43.
- Track 23 code comments still reference stale assumptions such as Track 18 being absent.
- Adjacent branch designs under `.ai_design/applepi_*` are not represented in the
  agent-improvements dependency graph even though their prompt/file-tool changes touch the
  same runtime seams.

Bug:

Future implementers cannot tell which contracts are shipped, partial, stale, or superseded.
Folder suffixes and README rows are no longer reliable enough to drive implementation order.

Required fix:

- Add `.ai_design/agent_improvements/track_status.yml` with one schema for design status,
  code status, PRs, merge date, remaining follow-ups, and validation state.
- Normalize README rows for 23, 40, 43, and this track.
- Mark tracks `_DONE` only when tasks and source status agree, or mark them explicitly
  `IMPLEMENTED_WITH_FOLLOWUPS`.
- Update stale comments that encode false track assumptions.

Validation:

- A repo-local audit can list tracks whose folder suffix, README status, and task checklist
  disagree.
- No merged track is absent from README.

## Implementation Blueprint

### Phase 0 - Lock failing regressions first

Add focused tests before broad production edits. The tests can initially be skipped or marked
as TODO only if the team wants to stage them across PRs, but every phase must land with its
corresponding regression active.

Test files to add or extend:

- `src/core/__tests__/PromptLoader.sessionIsolation.test.ts`
- `src/core/__tests__/Session.dispose.test.ts`
- `src/core/__tests__/TaskRunner.postTurnHooks.test.ts`
- `src/core/__tests__/BrowserxAgent.model-switch.test.ts`
- `src/core/hooks/__tests__/HookDispatcher.snapshot.test.ts`
- `src/tools/__tests__/ToolRegistry.lifecycle.test.ts`
- `src/core/approval/__tests__/ApprovalGate.serialization.test.ts`
- `src/tools/AgentTool/__tests__/SubAgentRunner.backgroundApproval.test.ts`
- `src/core/skills/__tests__/SkillAllowedTools.dispatch.test.ts`
- `src/storage/__tests__/StorageQuotaManager.tieredRetention.test.ts`
- `src/tools/AgentTool/__tests__/forkRecursionGuard.test.ts`

### Platform Coverage Matrix

| Phase | Shared core | Desktop | Extension service worker | Server/headless |
|-------|-------------|---------|--------------------------|-----------------|
| 1 Prompt runtime | `PromptLoader`, `RepublicAgent`, `TurnManager`, `SessionSummaryHook` | plan-review dynamic context and skill prompt rendering | skill prompt rendering and runtime prompt context | prompt composition if server uses the shared loader |
| 2 Disposal | `Session`, engine, registries, shadow scheduler | platform adapter dispose ordering | SW agent/session cleanup and timers | registry/bootstrap shutdown and rollout flush |
| 3 Post-turn/config | `TurnManager`, `TaskRunner`, config types, model factory, hooks | config update hot-swap paths | config update/session recreation paths | config update/hot-swap paths |
| 4 Tool/approval | `ToolRegistry`, `ApprovalGate`, sub-agent runtime, skills | `use_skill`, ApprovalGate, plan-review state | `use_skill` parity or prompt suppression, ApprovalGate | no fail-open server skill advertising; server tool lifecycle events |
| 5 Storage | task output, result store, retention policy | mostly shared result-store semantics | `StorageQuotaManager` with tier-0 evictor | file-backed result store and sweep policy |
| 6 Ledger | status schema and lint | n/a | n/a | n/a |

### Staging And Rollback

- Land one PR per phase. Each PR must be independently revertible and must keep existing
  public APIs compiling through compatibility wrappers.
- Use temporary runtime/config feature flags for user-visible behavior changes:
  - session-scoped prompt runtime;
  - post-turn-after-commit hook timing;
  - strict background approval semantics;
  - owner-metadata-based persisted-result retention.
- The default should be correctness-on once the phase tests pass. The flag exists for rollout
  rollback, not as a permanent alternate contract.
- Storage owner metadata must be backward compatible. Missing owner metadata is treated as
  durable until classified, so rollback never deletes data under an existing rollout pointer.
- Disposal changes must avoid double-emitting lifecycle hooks. A reverted phase must not leave
  sessions half-disposed or make `SessionEnd` fire twice.

### Phase 1 - Session-scoped prompt and runtime context

Production files:

- `src/core/PromptLoader.ts`
- `src/core/RepublicAgent.ts`
- `src/core/TurnManager.ts`
- `src/core/sessionSummary/SessionSummaryHook.ts`
- `src/desktop/agent/DesktopAgentBootstrap.ts`
- `src/extension/background/service-worker.ts`

Required API shape:

```ts
export interface PromptRuntimeContext {
  sessionId?: string;
  mode?: AgentMode;
  toolRegistry?: ToolRegistry;
  turnContext?: TurnContext;
}

export type PromptExtensionScope =
  | { type: 'global' }
  | { type: 'session'; sessionId: string };

export function registerPromptExtension(
  name: string,
  fn: (ctx: PromptRuntimeContext) => string,
  scope?: PromptExtensionScope,
): () => void;

export async function loadPrompt(
  mode?: AgentMode,
  ctx?: PromptRuntimeContext,
): Promise<string>;
```

Implementation notes:

- Keep the old two-argument-free `registerPromptExtension(name, fn)` behavior as a global
  compatibility path, but route all session-specific callers to `{ type: 'session' }`.
- Convert the `memory` and `session_summary` extensions to session-scoped registrations.
- Replace `setDynamicRuntimeContext(() => ...)` plan-review usage with a context-aware
  resolver that reads the `toolRegistry` passed to `loadPrompt`.
- Treat skills as global only when the rendered prompt is truly platform-global. If skill
  visibility depends on active tab/session state, render it from `PromptRuntimeContext`.
- Update every `loadPrompt(...)` call from `RepublicAgent` and `TurnManager` to pass
  `sessionId`, `mode`, `toolRegistry`, and `turnContext` when available.

Exit criteria:

- The prompt for session A cannot include session B memory, summary, plan-review freeze state,
  or session-specific skill visibility.
- Unregistering or disposing one session does not remove global prompt content or another
  session's extensions.

### Phase 2 - Unified lifecycle disposal

Production files:

- `src/core/Session.ts`
- `src/core/RepublicAgent.ts`
- `src/core/engine/RepublicAgentEngine.ts`
- `src/core/registry/AgentSession.ts`
- `src/core/registry/AgentRegistry.ts`
- `src/core/sessionSummary/SessionSummaryHook.ts`
- `src/core/hooks/loaders/ConfigHookLoader.ts`

Required API shape:

```ts
export interface SessionDisposeOptions {
  reason?: 'completed' | 'error' | 'tabClosed' | 'manual' | 'shutdown';
  abortTasks?: boolean;
  flushRollout?: boolean;
  cleanupNonPersistentStores?: boolean;
}

async dispose(options?: SessionDisposeOptions): Promise<void>;
```

Implementation notes:

- `Session.dispose()` should be idempotent and should become the common core behind
  `close()` and `shutdown()`.
- Disposal should maintain explicit internal state: `active`, `disposing`, `disposed`.
  A second call while `disposing` should await the first call; a call after `disposed` should
  return without re-firing hooks, re-flushing rollout, or re-cleaning stores.
- `close()` may remain as a semantic wrapper for persistent-session close, but it must call
  disposal cleanup for hooks, timers, prompt extensions, summary hooks, and memory services.
- `RepublicAgent.cleanup()` must dispose the session even when the engine was created with
  `ownsSession: false`.
- Store the unsubscribe returned by `ConfigHookLoader.watch(...)` and invoke it during agent
  cleanup.
- Stop the terminal-task eviction interval explicitly. Do not rely only on a future tick to
  notice there are no tasks.
- Shut down the per-session `ShadowAgentScheduler` before closing stores.
- In-flight tasks/tools:
  - stop accepting new user input immediately;
  - abort active tasks through their existing task/session abort channels;
  - pass cancellation signals to cancellable tools where available;
  - for non-cancellable tools already past the gate, wait for either completion or a short
    disposal timeout, then discard late synthetic notifications while preserving any completed
    rollout commit that already started.
- Rollout flushing must be ordered after any in-progress `recordConversationItemsDual(...)`
  commit. If there is no existing commit mutex, add one at the session/task-runner seam so
  `dispose()` cannot flush/close the rollout while a turn commit is still writing.
- `SessionEnd` and other terminal lifecycle hooks must be emitted once per session. Move or
  gate existing firing sites as needed so `AgentSession.terminate()` plus
  `RepublicAgent.cleanup()` cannot double-fire.

Exit criteria:

- Every public termination path has the same cleanup side effects.
- All cleanup paths are safe if called twice.

### Phase 3 - Post-turn commit order and config generations

Production files:

- `src/core/TurnManager.ts`
- `src/core/TaskRunner.ts`
- `src/core/Session.ts`
- `src/config/types.ts`
- `src/config/AgentConfig.ts`
- `src/core/RepublicAgent.ts`
- `src/core/models/ModelClientFactory.ts`
- `src/core/hooks/HookRegistry.ts`
- `src/core/hooks/HookDispatcher.ts`

Post-turn implementation:

- Remove the `firePostTurnHooks(...)` call from `TurnManager`'s stream `Completed` branch.
- Have `TurnManager` return enough post-turn metadata for `TaskRunner`.
- After `TaskRunner.processTurnResult()` records the assistant/tool output, call
  `session.firePostTurnHooks(...)` with:
  - full committed history;
  - committed delta for the just-finished turn;
  - session id, turn id, model, token usage, and stop reason.

Config-generation implementation:

- Add `'tools'` to `IConfigChangeEvent['section']` and remove `'tools' as any` emissions.
- Treat at least `model`, `providers`, `profiles`, `tools`, `policy`, and `hooks` as named
  generations.
- Add a `ModelClientFactory` cache-key builder that includes constructor-time inputs:
  selected model key, provider/routing, base URL, service tier, and `parallelToolCalls`.
- Clear relevant cache entries when a client-feeding generation changes; cache hits must only
  occur when the selected model, provider/routing, base URL, service tier, and
  `parallelToolCalls` all match.
- Add a hook snapshot primitive. Minimal acceptable API:

```ts
const snapshot = hookRegistry.snapshot();
const dispatcher = hookDispatcher.withSnapshot(snapshot);
```

or an equivalent method that freezes matching hooks for one tool execution. PreToolUse,
PermissionRequest, PostToolUse, and PostToolUseFailure for the same tool must use one
snapshot.

Exit criteria:

- Session-summary post-turn extraction sees the turn that just completed.
- A config change cannot reuse a model client built from stale constructor inputs.
- Hook reloads take effect at the next tool/turn boundary, not midway through one action.

### Phase 4 - Tool, approval, skill, and noninteractive semantics

Production files:

- `src/tools/ToolRegistry.ts`
- `src/core/protocol/events.ts`
- `src/core/TurnManager.ts`
- `src/core/approval/ApprovalGate.ts`
- `src/tools/AgentTool/behavior.ts`
- `src/tools/AgentTool/types.ts`
- `src/tools/AgentTool/SubAgentRunner.ts`
- `src/tools/AgentTool/forkContext.ts`
- `src/core/skills/SkillExecutor.ts`
- desktop/server/extension `use_skill` registration paths

Tool lifecycle implementation:

- Add one helper in `ToolRegistry.execute()` that emits the terminal event for every return
  path after `ToolExecutionStart`.
- For validation failure, pre-execute denial, plan-review freeze, approval denial, timeout,
  and handler exception, emit a terminal event with `success: false`. If event schemas are
  extended, use optional `outcome` and `error_code` fields so older consumers continue to
  parse the event.
- Pass a real `onProgress` callback from `TurnManager.executeBrowserTool()` into
  `ToolRegistry.execute()`. A no-op callback is acceptable if the registry remains the
  central progress-event emitter.
- Make `ToolRegistry.replace()` gap-free by constructing the replacement entry first,
  swapping the map entry synchronously, and then emitting a `ToolUpdated` or equivalent event.
  Do not delete the old tool before the new entry is ready.

Approval and background implementation:

- Add an in-flight approval map to `ApprovalGate.check()` keyed by normalized tool,
  parameters relevant to policy, current domain/cwd, and risk category.
- Sibling checks for the same key must await the first decision and reuse it.
- Extend `SubAgentBehaviorProfile` with explicit noninteractive behavior and allow
  `SubAgentTypeConfig` to opt into stricter/trusted background behavior only through
  validated fields. Default:
  - foreground `inherit` continues to inherit approval;
  - background `inherit` plus mutation-capable tools fails before child creation;
  - `never` is allowed only for read-only, trusted internal, or path-locked profiles.

Skill implementation:

- Enforce `allowed-tools` at dispatch time, not only in `SkillExecutor`.
- The gate must apply to inline skills and to forked skills that delegate through
  `sub_agent`.
- Server and extension bootstraps must register `use_skill` with the same executor and risk
  assessor behavior as desktop, or must explicitly suppress skill prompt advertising.

Fork guard implementation:

- Add an `isForkedSubAgentContext(...)` helper that detects runtime metadata only.
- Reject nested `context_mode: "fork"` before child-engine creation with a structured tool
  error.
- Do not reject isolated child sub-agents solely because the parent is forked.

Exit criteria:

- Every started tool call has exactly one terminal event.
- Background runs no longer turn "cannot ask" into mutation-capable auto-approval.
- Skill allow-lists are a real containment boundary.
- Fork recursion is explicitly blocked.

### Phase 5 - Storage lifetime policy

Production files:

- `src/core/tasks/TaskOutputManager.ts`
- `src/core/tasks/TaskOutputStore.ts`
- `src/core/Session.ts`
- `src/storage/StorageQuotaManager.ts`
- `src/extension/background/service-worker.ts`
- `src/server/agent/ServerAgentBootstrap.ts`
- `src/tools/resultStore.ts`
- `src/core/TurnManager.ts`

Implementation notes:

- Wire `TaskOutputManager` into production `StorageQuotaManager` construction wherever
  `task_output_chunks` can exist.
- Add one retention contract for persisted tool results:
  - nonpersistent child results may be cleaned on child disposal;
  - persistent-session rollout-referenced results are durable until the rollout reference is
    gone or the entire session is deleted;
  - model-facing delete tools must not delete a referenced blob.
- Extend persisted-result metadata with an owner field:

```ts
type PersistedResultOwner =
  | { kind: 'persistent_rollout'; sessionId: string; callId: string }
  | { kind: 'transient_session'; sessionId: string; taskId?: string };
```

- `TurnManager` should persist tool outputs with `persistent_rollout` owner metadata when the
  session is persistent and the preview will be recorded into rollout history.
- Child/nonpersistent sessions should use `transient_session` owner metadata so disposal can
  clean them cheaply.
- Make quota eviction ask lower tiers first and treat rollout-referenced persisted results as
  higher tier than unretained task output.
- Add conservative reachability checks before result-store cleanup. A false negative should
  keep data longer, not delete data under a rollout pointer.

Exit criteria:

- Any `<persisted-output>` recorded in a persistent rollout remains readable after quota
  pressure and session close/reopen.
- Nonpersistent child data still cleans up after disposal.

### Phase 6 - Documentation and status ledger

Production/docs files:

- `.ai_design/agent_improvements/README.md`
- `.ai_design/agent_improvements/improve_consistentcy0520/tasks.md`
- track folders for 23, 40, and 43 stay as-is unless a separate docs-status decision
  explicitly approves renaming; the ledger is the source of truth for this track
- stale source comments found during implementation

Implementation notes:

- Add `.ai_design/agent_improvements/track_status.yml` with this schema:

```yaml
tracks:
  - id: "23"
    folder: "23_agentic_payments_x402"
    title: "Agentic Payments (x402)"
    design_status: "open" # open | done | deferred | abandoned | implemented_with_followups
    code_status: "merged" # not_started | partial | merged | superseded
    prs: [238]
    merge_date: "2026-05-18"
    followups:
      - "headless approval semantics"
    validation_state: "source_verified" # unverified | source_verified | tests_passing
```

- Add a small status check that verifies every README row and every track folder has a ledger
  entry, and that `_DONE` folder suffixes agree with `design_status: done`.
- Normalize Track 23, Track 40, and Track 43 status without changing historical design text.
- Use Track 23 as the motivating example: its tasks still mention re-confirming Track 18 as
  absent even though Track 18 shipped, and Track 23 itself has merged code.
- Record which earlier follow-up tracks are fully closed by this work.

Exit criteria:

- A reader can tell which tracks are DONE, implemented-with-followups, open, deferred, or
  abandoned without reading git history.

## Acceptance Criteria

- Two live sessions cannot read or overwrite each other's prompt extensions, memory,
  summaries, skills, or plan-review state. Validated by
  `PromptLoader.sessionIsolation.test.ts`.
- Every session close path removes hooks, prompt extensions, watchers, timers, child/shadow
  jobs, and nonpersistent stores exactly once. Validated by fake-timer and listener-count
  assertions in `Session.dispose.test.ts`.
- Post-turn hooks see committed assistant/tool output from the turn that just finished.
  Validated by `TaskRunner.postTurnHooks.test.ts`.
- Model-client cache behavior changes when any constructor-time config input changes.
  Validated by `BrowserxAgent.model-switch.test.ts`.
- Hook reloads do not split one tool execution across two hook generations. Validated by
  `HookDispatcher.snapshot.test.ts`.
- Background sub-agents cannot silently convert inherited approval into mutation-capable
  auto-approval. Validated by `SubAgentRunner.backgroundApproval.test.ts`.
- Skill `allowed-tools` is enforced in dispatch, not only parsed. Validated by
  `SkillAllowedTools.dispatch.test.ts`.
- Tool lifecycle telemetry is balanced for success, failure, denial, cancellation, and
  progress. Validated by `ToolRegistry.lifecycle.test.ts`.
- Persisted rollout references remain readable after quota cleanup. Validated by
  `StorageQuotaManager.tieredRetention.test.ts`.
- Fork recursion is blocked by runtime metadata, not prompt text. Validated by
  `forkRecursionGuard.test.ts`.
- Track status metadata matches merged source status. Validated by the Phase 6 ledger check.

## Validation Commands

Minimum local validation after implementation:

```bash
npm run type-check
npm run lint
npm run test -- --run
```

Targeted test files are listed in Phase 0. At minimum, run the changed suites directly before
the full test pass:

```bash
npm run test -- --run \
  src/core/__tests__/PromptLoader.sessionIsolation.test.ts \
  src/core/__tests__/Session.dispose.test.ts \
  src/core/__tests__/TaskRunner.postTurnHooks.test.ts \
  src/core/__tests__/BrowserxAgent.model-switch.test.ts \
  src/core/hooks/__tests__/HookDispatcher.snapshot.test.ts \
  src/tools/__tests__/ToolRegistry.lifecycle.test.ts \
  src/core/approval/__tests__/ApprovalGate.serialization.test.ts \
  src/tools/AgentTool/__tests__/SubAgentRunner.backgroundApproval.test.ts \
  src/core/skills/__tests__/SkillAllowedTools.dispatch.test.ts \
  src/storage/__tests__/StorageQuotaManager.tieredRetention.test.ts \
  src/tools/AgentTool/__tests__/forkRecursionGuard.test.ts
```

## Out Of Scope

- Changing product behavior for unrelated UI features.
- Rewriting every open follow-up track. This track should close only the follow-up items that
  share the consistency contracts above.
- Reopening abandoned Track 06 cross-session coordination.
- Implementing x402 product behavior beyond fixing status drift and any consistency bugs found
  in shared approval/config/storage seams.
