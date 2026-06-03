# Track 41: Shadow Agent Runtime

**Date**: 2026-05-16
**Scope**: Runtime-launched internal child agents for background maintenance, extraction, compaction preparation, prompt assistance, and diagnostics
**Claudy reference**: `/home/rich/dev/study/claudy/src/utils/forkedAgent.ts`, `/home/rich/dev/study/claudy/src/services/sessionMemory.ts`, `/home/rich/dev/study/claudy/src/services/promptSuggestion.ts`, `/home/rich/dev/study/claudy/src/services/extractMemories.ts`, `/home/rich/dev/study/claudy/src/services/compact.ts`
**BrowserX reference**: `src/core/sessionSummary`, `src/core/compact`, `src/core/engine`, `src/tools/AgentTool`

**Implementation status (2026-05-18, `origin/agent-improvements` `e9bbff26`)**: DONE via
PR #245 and follow-up commits. Session summary extraction is migrated to
`ShadowAgentScheduler`; shadow context, runner, scheduler, failure policies, diagnostics,
and compaction preparation are implemented with tests.

## End-To-End Goal

After this track is implemented, BrowserX has a first-class internal **shadow agent** runtime:

1. Runtime services can launch background child agents without going through the user-facing `sub_agent` tool.
2. Shadow agents can receive explicit parent context snapshots, model/tool policies, timeouts, and failure policies.
3. Shadow jobs do not appear in `list_sub_agents`, do not consume sub-agent registry slots, and do not inject `<task-notification>` unless a caller intentionally bridges them to user-visible UI.
4. Session summary extraction is migrated end to end from a quiet background sub-agent to `ShadowAgentRunner`, preserving path-locked file behavior and eliminating phantom background task state.
5. Compaction gets a shadow-compatible path for preparation/future background summarization while the existing direct `CompactService` remains the correctness fallback.
6. All shadow failures are observable to runtime code through typed results, events, or telemetry. No job fails silently by default.

Terminology: the user prefers "shadow agent" for Claudy's lower-level forked-agent concept. In this design, **forked subagent** remains Track 40's user/tool-launched subagent context mode; **shadow agent** is runtime-launched internal work.

## Claudy Ground Truth

Claudy's `runForkedAgent(...)` is not the same thing as Claudy's `AgentTool` forked subagent path.

The lower-level helper in `src/utils/forkedAgent.ts`:

- accepts cache-safe params from the parent context (`systemPrompt`, `userContext`, `systemContext`, `toolUseContext`, optional `forkContextMessages`);
- creates an isolated child agent context through `createSubagentContext(...)`;
- can run with caller-supplied `canUseTool`, `querySource`, `forkLabel`, model overrides, max turns, output token limits, and transcript/cache flags;
- streams query events to an optional `onMessage`;
- accumulates usage and returns output to the runtime caller;
- logs telemetry, but does not go through the normal subagent UI/task lifecycle.

Claudy runtime services decide concurrency and failure behavior themselves:

- Session memory extraction is wrapped in a sequential gate.
- Prompt suggestion suppresses abort/cancellation failures and skips transcript/cache writes.
- Memory extraction has `inProgress` plus `pendingContext` coalescing.
- Compaction uses a forked-agent path opportunistically and falls back to the direct streaming compaction path on failure or empty output.

BrowserX should adopt the lower-level shape and the caller-owned policy model. It should not copy Claudy's exact cache machinery or string query-source model.

## BrowserX Ground Truth

BrowserX currently has no separate shadow-agent runtime.

The closest implementation is `SessionSummaryHook`:

- `src/core/sessionSummary/SessionSummaryHook.ts` creates a dedicated `SubAgentRegistry` with `maxConcurrent: 1`.
- It creates a dedicated `SubAgentRunner` with a custom `session_summary_extractor` type.
- `src/core/sessionSummary/cacheSafeParams.ts` runs that type as `background: true` and `quietBackground: true`.
- `src/core/sessionSummary/extractorType.ts` allows `file_edit`, uses approval `never`, suppresses streaming, and writes the summary file through a path-locked gate.

That path works by special-casing a user-facing sub-agent system:

- the extractor is still a sub-agent type;
- it still enters background task state;
- it requires `quietBackground` to avoid user-facing notifications;
- it needs a dedicated registry to avoid interfering with normal subagent concurrency;
- terminal task state can be skipped when the quiet path suppresses notification-related logic.

`CompactService` is different:

- `src/core/compact/CompactService.ts` performs summarization directly through model orchestration.
- It already waits briefly for session summary extraction before compacting.
- It should remain the correctness path until shadow compaction is proven.

## Relationship To Track 40

Track 41 should reuse the Track 40 child-agent seams:

- child engine `initialHistory`;
- non-persistent session hydration;
- conversion from committed `ResponseItem[]` snapshots into forked `InitialHistory` rollout items, unless `InitialHistory` is explicitly extended;
- tool-call pairing trim;
- child tool registry filtering;
- event routing helpers where they are generic.

Track 41 should not reuse the Track 40 managed sub-agent surface:

- no `SubAgentRegistry`;
- no `sub_agent` tool call;
- no `list_sub_agents`;
- no `cancel_sub_agent` unless bridged intentionally later;
- no default `<task-notification>`;
- no consumption of user-facing sub-agent concurrency limits.

If Track 41 is implemented before Track 40, implement the shared child-engine seams in Track 41 and let Track 40 reuse them. Do not implement separate history hydration paths.

## Design

### Package Layout

Add:

```text
src/core/shadowAgent/
|-- types.ts
|-- builtins.ts
|-- ShadowAgentRunner.ts
|-- ShadowAgentScheduler.ts
|-- ShadowAgentContext.ts
|-- ShadowAgentEvents.ts
`-- __tests__/
```

### Core Types

```ts
export enum ShadowAgentKind {
  SessionSummary = 'session_summary',
  Compact = 'compact',
  PromptSuggestion = 'prompt_suggestion',
  MemoryExtraction = 'memory_extraction',
  Diagnostics = 'diagnostics',
}

export enum ShadowAgentPriority {
  Immediate = 'immediate',
  Normal = 'normal',
  Idle = 'idle',
}

export enum ShadowContextPolicy {
  None = 'none',
  PromptOnly = 'prompt_only',
  ParentHistory = 'parent_history',
  ParentHistoryWithSummary = 'parent_history_with_summary',
  CompactCandidate = 'compact_candidate',
}

export type ShadowFailurePolicy =
  | 'throw'
  | 'return_error'
  | 'log_and_suppress'
  | 'fallback';
```

Request/result shape:

```ts
export interface ShadowAgentRequest {
  kind: ShadowAgentKind;
  prompt: string;
  systemPrompt: string;
  parentEngine: RepublicAgentEngine;
  contextPolicy?: ShadowContextPolicy;
  toolPolicy?: ShadowToolPolicy;
  model?: string;
  maxTurns?: number;
  priority?: ShadowAgentPriority;
  failurePolicy?: ShadowFailurePolicy;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ShadowAgentResult {
  kind: ShadowAgentKind;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'fallback_used';
  outputText?: string;
  error?: unknown;
  usage?: TokenUsage;
  durationMs: number;
  runId: string;
}
```

### Built-In Profiles

`builtins.ts` should define immutable profiles:

```ts
export interface ShadowAgentProfile {
  kind: ShadowAgentKind;
  defaultContextPolicy: ShadowContextPolicy;
  defaultPriority: ShadowAgentPriority;
  failurePolicy: ShadowFailurePolicy;
  maxConcurrency: number;
  queuePolicy: 'queue' | 'coalesce_latest' | 'abort_previous' | 'drop_duplicate';
  timeoutMs: number;
  maxTurns: number;
  toolPolicy: ShadowToolPolicy;
  visibleToUser: boolean;
}
```

Initial table:

| Kind | Context | Queue policy | Failure policy | Tools | User visibility |
| --- | --- | --- | --- | --- | --- |
| `SessionSummary` | `ParentHistory` | `coalesce_latest` | `return_error` | path-locked `file_edit` | diagnostic only |
| `Compact` | `CompactCandidate` | `coalesce_latest` | `fallback` | model-only/read-only | diagnostic only |
| `PromptSuggestion` | `ParentHistoryWithSummary` | `abort_previous` | `log_and_suppress` | none | caller decides |
| `MemoryExtraction` | `ParentHistory` | `coalesce_latest` | `log_and_suppress` | memory/file path-locked | diagnostic only |
| `Diagnostics` | `PromptOnly` | `queue` | `return_error` | read-only | diagnostics |

### Runner

`ShadowAgentRunner` executes one request. It is intentionally lower-level than the scheduler.

Responsibilities:

1. Resolve the built-in profile plus request overrides.
2. Build child context from `ShadowContextPolicy`.
3. Build a child tool registry from explicit `ShadowToolPolicy`.
4. Create a child engine using the shared child-engine initial-history seam.
5. Run the child prompt with max turns, timeout, and abort handling.
6. Return `ShadowAgentResult`.
7. Emit internal start/completion/failure/cancel/timeout events.

It must not:

- register a `SubAgentTypeConfig`;
- call `SubAgentRunner`;
- add an entry to `SubAgentRegistry`;
- register typed background task state by default;
- call `enqueueSyntheticUserTurn(...)` by default.

### Context Construction

Add `ShadowAgentContext.ts` with:

```ts
buildShadowInitialHistory(parentEngine, policy, request): InitialHistory | undefined
```

Policy behavior:

- `None`: no initial history; system prompt and prompt only.
- `PromptOnly`: no parent history; prompt may include explicit context from caller.
- `ParentHistory`: use parent committed history after pairing trim.
- `ParentHistoryWithSummary`: include parent committed history plus available session summary metadata when the caller provides it.
- `CompactCandidate`: use the candidate history slice that compaction is evaluating, not necessarily the entire parent session.

The output must be provider-neutral `InitialHistory` for `Session`; it should not depend on OpenAI-specific event object shapes except at existing conversion boundaries. With the current `InitialHistory` type, shadow context builders should wrap selected `ResponseItem[]` history as `response_item` rollout records before passing `mode: "forked"` to the child session.

### Tool Policy

```ts
export interface ShadowToolPolicy {
  allow?: string[];
  deny?: string[];
  preExecuteCheck?: PreExecuteCheck;
  exact?: boolean;
}
```

Defaults should be conservative:

- no tools unless the profile declares tools;
- never include sub-agent management tools;
- path-lock mutation tools for session summary/memory jobs;
- background jobs run non-interactively with approval `never`;
- `exact` is reserved for internal profiles only and should not mean "copy every parent tool" unless explicitly approved by code.

Extract reusable registry filtering from `ToolRegistryCloner` if needed:

```text
createChildToolRegistry(parentRegistry, policy, { childKind: 'subagent' | 'shadow_agent' })
```

### Scheduler

`ShadowAgentScheduler` owns concurrency and request coalescing for a parent agent/session.

Rules:

- one scheduler per top-level `RepublicAgent` or parent session;
- default total active shadow limit: 2;
- per-kind limit comes from profile;
- `dedupeKey` prevents duplicate queued work;
- `coalesce_latest` keeps one active request and one latest pending request;
- `abort_previous` cancels the active speculative run when a newer request arrives;
- shutdown cancels active and queued work.

This explicitly models the policies Claudy implements per service with ad hoc sequential wrappers or `inProgress` fields.

### Failure Policy

Implement failure policy in one place:

- `throw`: reject the scheduler/runner promise.
- `return_error`: resolve `ShadowAgentResult` with `status: "failed"`.
- `log_and_suppress`: emit event/telemetry and return a failed result to the caller, but do not throw.
- `fallback`: call a caller-provided fallback function or return `status: "fallback_used"` when the fallback succeeds.

No shadow path should catch and discard errors without at least `ShadowAgentFailed` telemetry/event.

### Events And Diagnostics

Add internal events:

- `ShadowAgentStarted`
- `ShadowAgentCompleted`
- `ShadowAgentFailed`
- `ShadowAgentCancelled`
- `ShadowAgentCoalesced`
- `ShadowAgentTimedOut`
- `ShadowAgentFallbackUsed`

Fields:

- `run_id`
- `kind`
- `priority`
- `status`
- `duration_ms`
- `timeout_ms`
- `failure_policy`
- `parent_engine_id`
- `child_engine_id`
- `dedupe_key`

Diagnostics should expose a snapshot:

- active jobs by kind;
- queued/coalesced latest jobs;
- recent completions;
- last failure per kind;
- timeout count;
- fallback count.

### Session Summary Migration

First end-to-end consumer: `SessionSummaryHook`.

Current path:

```text
SessionSummaryHook -> dedicated SubAgentRunner -> background quiet subagent -> wait for registry/task output
```

Target path:

```text
SessionSummaryHook -> ShadowAgentScheduler -> ShadowAgentRunner(kind: SessionSummary) -> path-locked file_edit -> refresh summary cache
```

Preserve:

- post-turn trigger threshold behavior;
- in-flight/coalescing behavior, now owned by scheduler;
- path-locked `file_edit`;
- telemetry;
- `waitForSessionSummaryExtraction(...)` interlock used by compaction.

Remove from this path:

- dedicated `SubAgentRunner`;
- dedicated `SubAgentRegistry`;
- `quietBackground`;
- user-facing background task state for extraction;
- `session_summary_extractor` type registration in the user-facing sub-agent set once no other caller needs it.

### Compaction Integration

Do not make compaction correctness depend on shadow agents in v1.

Initial target:

- keep `CompactService.compact(...)` direct path as the fallback/correctness path;
- allow a shadow compact request to prepare a candidate summary when context pressure is approaching;
- on hard compaction or shadow failure, use the existing direct path;
- use `ShadowFailurePolicy.Fallback`.

This aligns with Claudy's compaction behavior: the forked-agent path can improve cache/context handling, but failure falls back to the direct compaction path.

### Lifecycle Integration

Attach one scheduler to each top-level `RepublicAgent`/session runtime after engine initialization. Internal services access it through a narrow interface, not by constructing their own untracked runner unless tests need a fake.

Shutdown/dispose behavior:

- cancel queued jobs;
- abort active jobs;
- emit cancellation events;
- do not enqueue conversation messages during shutdown;
- do not leave file locks or task output streams open.

### Model Configuration

Shadow agents default to the parent model for provider consistency. Profiles and requests may override the model when a job has a clear reason:

- fast/cheap model for prompt suggestion;
- stronger model for compaction if configured;
- same model for session summary unless config says otherwise.

Model override must be explicit in the profile/request and included in telemetry. Shadow agents should not have a user-facing "agent type" selector.

## Non-Goals

- No user-visible `shadow_agent` tool.
- No replacement for user/tool-launched `sub_agent`.
- No cross-session shadow jobs in v1.
- No conversation rewind/fork session creation.
- No silent mutation tools.
- No default conversation injection of shadow results.
- No UI task state unless a specific future job needs visible progress.

## Validation Plan

Unit tests:

- scheduler enforces per-kind and total concurrency;
- `coalesce_latest`, `abort_previous`, `drop_duplicate`, and `queue` policies behave correctly;
- timeout cancels a child run and emits `ShadowAgentTimedOut`;
- each failure policy returns/throws/falls back as specified;
- shadow tool registry excludes sub-agent management tools;
- `ParentHistory` context builds valid child initial history;
- shutdown cancels queued and active jobs.

Integration tests:

- session summary extraction runs through shadow runtime and updates the summary file;
- session summary coalesces multiple post-turn triggers into latest work;
- compaction still succeeds when shadow compact fails;
- shadow jobs do not appear in `list_sub_agents`;
- shadow jobs do not inject `<task-notification>` into the main conversation;
- existing sub-agent foreground/background tests remain unchanged.

Regression suites:

- session summary;
- compact;
- task-state/background task;
- sub-agent management;
- session shutdown/dispose.

## Implementation Order

1. Implement/reuse child-engine seams from Track 40: initial history, non-persistent hydration, tool-call pairing trim, and child registry filtering.
2. Add shadow runtime types, built-in profiles, and events.
3. Implement `ShadowAgentRunner` with conservative tool/context policy.
4. Implement `ShadowAgentScheduler` with per-kind concurrency/coalescing/failure policy.
5. Migrate `SessionSummaryHook` end to end.
6. Add optional shadow compaction preparation with direct fallback.
7. Remove/deprecate session-summary-specific `quietBackground` usage and internal sub-agent registration.

The first production migration must be session summary because BrowserX already has that internal job and it currently depends on the user-facing sub-agent runtime.
