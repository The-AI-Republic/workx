# Track 40: Sub-Agent Runtime Optimization

**Date**: 2026-05-16
**Scope**: `sub_agent` tool, `SubAgentRunner`, child engine/session creation, sub-agent type behavior, foreground/background execution, forked subagent mode
**Claudy reference**: `/home/rich/dev/study/claudy/src/tools/AgentTool`, `/home/rich/dev/study/claudy/src/tools/AgentTool/forkSubagent.ts`, `/home/rich/dev/study/claudy/src/tools/AgentTool/runAgent.ts`
**BrowserX reference**: `src/tools/AgentTool`, `src/core/engine`, `src/core/Session.ts`, `src/core/skills`

**Implementation status (2026-05-18, `origin/agent-improvements` `e9bbff26`)**: DONE.
PR #243 and follow-ups implemented the runtime; the final local follow-up added an explicit
fork-recursion/tag guard equivalent to Claudy's "already forked" check.

## End-To-End Goal

After this track is implemented, BrowserX has one coherent sub-agent runtime with two context modes:

1. Existing isolated sub-agents keep their current behavior: the child agent starts with no parent conversation history, receives a focused prompt, and runs under `SubAgentRunner`/`SubAgentRegistry`.
2. Each sub-agent type has an enum-backed `agentType` that selects runtime behavior through a central behavior profile. Dynamic plugin/config ids remain strings, but behavior is no longer driven by ad hoc string comparisons.
3. A caller can request `context_mode: "fork"` for a sub-agent. The child engine receives a tool-call-safe snapshot of the parent conversation plus the delegated prompt, then runs as a normal managed sub-agent.
4. Foreground and background behavior works for both isolated and forked modes. Foreground awaits the child result. Background returns a launch response and later delivers the completion notification to the parent conversation.
5. Skill frontmatter `context: "fork"` becomes a real forked subagent execution path instead of the current prompt-only sub-agent delegation.
6. Sub-agent management tools, especially `send_message`, work end to end because child-engine pending-message drain is wired through to `TaskRunner`.

This track is about **forked subagents**, not shadow agents. A forked subagent is still created by the parent agent through the `sub_agent` tool and remains visible to sub-agent management APIs. Runtime-launched internal background agents are Track 41.

## Claudy Ground Truth

Claudy has two different ideas that are easy to confuse:

- `AgentTool` sub-agents, including the forked subagent path.
- Lower-level `runForkedAgent(...)` runtime helpers used by background services. BrowserX calls that concept "shadow agent" in Track 41.

The forked subagent path in Claudy is inside `AgentTool.tsx`:

- `subagent_type` is optional. When omitted and the fork-subagent feature is enabled, Claudy selects a synthetic `FORK_AGENT` instead of a registered built-in/custom subagent.
- `FORK_AGENT` has `agentType: "fork"`, `tools: ["*"]`, `model: "inherit"`, `permissionMode: "bubble"`, and is intentionally not part of the normal built-in registry.
- Fork mode has recursion guards. Claudy rejects fork-subagent execution if the current query source is already `agent:builtin:fork` or the message history contains the fork boilerplate tag.
- Fork mode receives `forkContextMessages` from the parent. `runAgent(...)` prepends those messages to the delegated prompt messages and clones parent read-file state.
- Fork mode can use exact parent tools, but that is a Claudy-specific trust/cache choice. BrowserX should not copy this blindly because BrowserX already has child tool filtering and provider-neutral approval behavior.
- Claudy forces subagent spawns into the async/task-notification path when fork-subagent mode is enabled so the parent sees a unified completion notification model.

Claudy also uses `agentType` as behavior-bearing identity in several places. It is stringly typed there: `Explore`/`Plan` affect context omission, `fork` affects routing, and built-in/custom identity affects query source and transcript metadata. BrowserX should adopt the behavior-bearing idea but use TypeScript enums for runtime-controlled behavior.

## BrowserX Ground Truth

### Current Sub-Agent Runtime

BrowserX already has a real managed sub-agent system:

- `src/tools/AgentTool/SubAgentTool.ts` exposes `sub_agent`.
- `src/tools/AgentTool/SubAgentRunner.ts` validates params, creates a child registry, creates a child engine, registers the run, executes it, emits sub-agent events, and cleans up foreground runs.
- `src/tools/AgentTool/SubAgentRegistry.ts` tracks active sub-agents, max concurrency, status, and pending `send_message` payloads.
- `src/tools/AgentTool/managementTools.ts` implements `list_sub_agents`, `cancel_sub_agent`, and `send_message`.
- `src/tools/ToolRegistryCloner.ts` excludes `sub_agent`, `list_sub_agents`, `cancel_sub_agent`, and `send_message` from child registries.

The current model is isolated by design. `SubAgentTool` tells the model that the sub-agent has no conversation history and the caller must include everything needed in the prompt. `SubAgentRunner.prepare()` creates a child engine, and that child engine creates a new non-persistent `Session`.

Foreground/background already exists:

- Foreground is the default and awaits `execute(...)`.
- Background detaches, returns a launch result, and eventually injects a `<task-notification>` through `RepublicAgentEngine.enqueueSyntheticUserTurn(...)`.
- The parent engine buffers notifications while idle and prepends them to the next user input.

Those behaviors should remain stable for isolated mode.

### Required BrowserX Seams To Fix

Fork mode cannot be implemented correctly by only adding a tool parameter. These code seams must be fixed first.

1. `RepublicAgentEngineConfig.initialHistory` is currently not effective for child engines.

   `RepublicAgentEngine.initialize()` creates an internal `Session(config.agentConfig, persistent, undefined, toolRegistry)` and does not pass `config.initialHistory`. `createChildEngine(...)` also does not accept initial history today. A forked child agent needs that path.

2. `Session` supports `InitialHistory`, but non-persistent child sessions do not hydrate forked history.

   `Session` has `InitialHistory` support and `recordInitialHistory(...)`, but the current reconstruction/persistence behavior is centered on persistent sessions and rollout restore. Forked subagents should use in-memory initial history without creating a new persistent user conversation.

   Important detail: `InitialHistory.mode === "forked"` currently carries `rolloutItems`, not raw `ResponseItem[]`. The fork-context builder should either wrap trimmed response items as `response_item` rollout records or extend `InitialHistory` with an explicit in-memory response-item payload. Prefer wrapping into rollout items first because it reuses `reconstructHistoryFromRollout(...)` and keeps the session initialization model narrower.

3. `send_message` has a broken propagation seam.

   `SubAgentRunner.prepare()` passes `drainPendingMessages` to `createChildEngine(...)`; `TaskRunner` has a `drainPendingMessages` option and consumes it before pending input; but `RegularTask`/`AgentTask` do not pass the engine config value through to `TaskRunner`. Track 40 must wire this through so managed sub-agent messaging works while adding fork mode.

4. Tool-call pairing must remain valid in forked history.

   `TaskRunner.processTurnResult(...)` normally records assistant tool calls and tool outputs together. Fork mode should still defensively trim dangling tool calls before creating child initial history. Track 15 already has pairing-trim logic in `src/core/session/rewind.ts`; this should be extracted or reused.

## Design

### Registration Id Versus Behavior Type

Keep the existing dynamic registration key:

```ts
id: string;
```

Plugin and config-defined agents need ids such as `my-plugin:reviewer`; those cannot be TypeScript enum values. Add a separate enum-backed behavior field:

```ts
// src/tools/AgentTool/agentTypes.ts
export enum AgentType {
  GeneralPurpose = 'general_purpose',
  Researcher = 'researcher',
  Planner = 'planner',
  Worker = 'worker',
  Verifier = 'verifier',
  Internal = 'internal',
}

export enum SubAgentContextMode {
  Isolated = 'isolated',
  Fork = 'fork',
}

export enum SubAgentExecutionMode {
  Foreground = 'foreground',
  Background = 'background',
}
```

Extend `SubAgentTypeConfig`:

```ts
export interface SubAgentTypeConfig {
  id: string;
  agentType: AgentType;
  name: string;
  description: string;
  systemPrompt: string;
  defaultContextMode?: SubAgentContextMode;
  allowedContextModes?: SubAgentContextMode[];
  // existing fields stay: tools, model, maxTurns, approvalPolicy, suppressedEvents
}
```

Defaulting rules:

- Built-ins must declare `agentType`.
- Config/plugin sub-agents default to `AgentType.GeneralPurpose`.
- Plugin frontmatter may opt into safe enum values only. Do not allow plugins to declare `AgentType.Internal`.
- Default context mode is `isolated` unless the type explicitly says otherwise.
- External `id` remains the schema enum value; `agentType` controls runtime behavior.

### Behavior Profiles

Add a central resolver instead of scattering `if (agentType === ...)` checks:

```ts
export interface SubAgentBehaviorProfile {
  agentType: AgentType;
  defaultContextMode: SubAgentContextMode;
  allowedContextModes: SubAgentContextMode[];
  approvalPolicyDefault: 'inherit' | 'never';
  canRunInBackground: boolean;
  canUseParentHistory: boolean;
  canUseBrowserContext: boolean;
  toolPolicy: 'configured' | 'read_only_bias' | 'mutation_capable' | 'internal_locked';
  suppressStreamingEvents: boolean;
}
```

Add:

```ts
resolveSubAgentBehavior(config, params, parentContext): ResolvedSubAgentBehavior
```

Initial table:

| `AgentType` | Intended behavior |
| --- | --- |
| `GeneralPurpose` | Preserve current generic behavior. Isolated by default. Configured tools. |
| `Researcher` | Read-biased. Isolated by default. Default approval `never`. Streaming deltas suppressed unless explicitly enabled. |
| `Planner` | Planning/read-biased. Mutation tools denied unless configured by trusted code. Default approval `never`. |
| `Worker` | Mutation-capable. Approval may inherit in foreground. Background still cannot prompt. |
| `Verifier` | Verification/read-execute oriented. Mutation disabled unless explicitly configured. |
| `Internal` | Runtime-only. Not exposed through plugin ids. Strict tool gate. No user-facing task notification by default; Track 41 owns most internal jobs. |

`SubAgentRunner.prepare()` should consume this resolved profile once and then derive:

- effective context mode;
- effective model;
- effective max turns;
- effective approval policy;
- effective child tool registry;
- effective event suppression;
- execution-mode telemetry.

### Tool Schema

Extend `SubAgentToolParams` with an explicit context mode:

```ts
export interface SubAgentToolParams {
  type: string;
  prompt: string;
  description?: string;
  signal?: AbortSignal;
  background?: boolean;
  quietBackground?: boolean;
  canUseTool?: PreExecuteCheck;
  contextMode?: SubAgentContextMode;
}
```

The LLM-facing JSON schema should expose `context_mode: "isolated" | "fork"`. Keep `type` required. Do not copy Claudy's omitted-type fork shortcut because BrowserX has dynamic plugin ids and a clearer explicit schema is safer.

Naming:

- API/internal field: `contextMode`.
- Tool parameter: `context_mode`.
- Telemetry/event field: `context_mode`.

### Fork Context Construction

Add:

```text
src/tools/AgentTool/forkContext.ts
```

Responsibilities:

1. Read a stable parent conversation snapshot from the parent engine/session. Prefer `SessionState.historySnapshot()` through a narrow engine/session accessor instead of reaching into internals from the runner. `TaskRunner.run_task(...)` records the submitted user input before the agent loop starts, so this snapshot should include the user request that caused the `sub_agent` tool call, even though the assistant tool-call result has not been committed yet.
2. Apply tool-call pairing trim using shared Track 15 logic extracted from `src/core/session/rewind.ts`.
3. Append a final delegated user instruction that names the child as a forked subagent and scopes the task.
4. Build an `InitialHistory` value for a non-persistent child session. In the current type shape, this means converting the trimmed history plus delegated instruction from `ResponseItem[]` into `RolloutItem[]` with `type: "response_item"` and `mode: "forked"`.
5. Attach lightweight metadata for diagnostics: parent session id, parent engine id, subagent run id, type id, `agentType`, and `contextMode`.

Do not initially clone active in-flight tool calls from the current streaming assistant item. BrowserX records completed turns with tool-call/tool-result pairs through `TaskRunner.processTurnResult(...)`; fork mode should snapshot committed history. If future provider behavior requires active assistant-call placeholders like Claudy's `buildForkedMessages(...)`, add that as a focused extension after tests prove the need.

The fork directive should be concise and behavioral, not a second system prompt:

- you are a delegated forked subagent;
- use the inherited conversation only to complete the delegated task;
- do not assume control of the main conversation;
- return one final result to the parent;
- do not spawn subagents because child registries already deny management tools.

### Child Engine And Session Initial History

Update engine config typing:

```ts
// src/core/engine/RepublicAgentEngineConfig.ts
import type { InitialHistory } from '../session/state/types';

export interface RepublicAgentEngineConfig {
  initialHistory?: InitialHistory;
  childRole?: 'subagent' | 'shadow_agent';
  // existing fields
}
```

Update `RepublicAgentEngine.initialize()` so internally-created sessions receive `config.initialHistory`.

Update `RepublicAgentEngine.createChildEngine(...)` to accept `initialHistory` and pass it to the child engine config.

Update `Session` so non-persistent sessions hydrate `InitialHistory` in memory:

- `mode: "new"` starts empty.
- `mode: "forked"` reconstructs provided history into the in-memory state but does not persist a new rollout unless the session itself is persistent.
- `mode: "resumed"` should remain a top-level/persistent concern unless a caller explicitly needs it.

This should be implemented as a clear session capability, not as a sub-agent-specific hack. Track 41 shadow agents will reuse the same seam.

### Tool And Permission Policy

Isolated mode continues to use the current restricted child registry.

Fork mode should also use the restricted child registry in v1. Claudy gives forked subagents exact parent tools for its own cache/trust model, but BrowserX should keep child safety consistent:

- child registries must still remove sub-agent management tools;
- tool allow/deny comes from the type config plus behavior profile;
- plugin fork mode is allowed only when `allowedContextModes` includes `fork`;
- background execution forces non-interactive approval behavior, as it does today.

Approval rules:

- Foreground + trusted mutation-capable type may inherit approval.
- Background cannot prompt. If a background forked subagent would require inherited approval, fail early with a clear tool error or downgrade to the configured non-interactive policy only when the behavior profile explicitly permits it.
- `quietBackground` remains internal-only and should not be exposed to the model.

### Foreground And Background Execution

The execution split remains in `SubAgentRunner.run()`:

- Foreground: prepare child, execute, return final result, cleanup/unregister.
- Background: prepare child, detach async run, return launch result, later notify parent unless quiet/internal.

Required fixes:

- Terminal task state must be recorded even when notification delivery is suppressed.
- `send_message` must reach the child task through the `drainPendingMessages` seam.
- Background forked subagent completion must inject the same `<task-notification>` format as isolated background subagents, with added `agent_type` and `context_mode` metadata.

### Skill Integration

Today `src/core/skills/types.ts` supports `context: "inline" | "fork"` and `SkillExecutor` delegates `context: "fork"` to `sub_agent`, but the execution is isolated/prompt-only.

After this track:

- `context: "fork"` calls `sub_agent` with `context_mode: "fork"` and the configured `agent`.
- Existing skills keep compatibility.
- A future `context: "subagent"` or `context: "isolated"` can be added later if authors need prompt-only child execution. Do not add that unless required by migration.

### Plugin And Config Loading

Update validation/loading:

- `src/tools/AgentTool/validateTypeConfig.ts` validates optional `agentType`, `defaultContextMode`, and `allowedContextModes`.
- `src/core/plugins/loaders/SubAgentSlotLoader.ts` maps plugin frontmatter to the new fields.
- Unknown `agentType` values fail validation.
- Plugin `agentType` defaults to `GeneralPurpose`.
- Plugin `allowedContextModes` defaults to `[Isolated]`.
- Plugin config cannot select `Internal`.

### Events, Diagnostics, Telemetry

Add fields to existing sub-agent events/results where applicable:

- `type_id`
- `agent_type`
- `context_mode`
- `execution_mode`
- `parent_engine_id`
- `child_engine_id`

Expose `agentType` and `contextMode` in `list_sub_agents` output. This is useful for debugging foreground/background/fork behavior and does not change the management model.

## Non-Goals

- No runtime-launched shadow agents. Track 41 owns that.
- No cross-session sub-agent coordination.
- No user-visible omitted-type fork shortcut.
- No exact-parent-tool inheritance for forked subagents in v1.
- No recursive subagent spawning from subagents.
- No plugin access to internal agent types.

## Validation Plan

Unit tests:

- built-in configs declare expected `AgentType`;
- config/plugin sub-agents default to `GeneralPurpose`;
- validation rejects unknown `agentType` and plugin `Internal`;
- behavior resolver returns expected defaults for each enum value;
- isolated mode still starts with no parent history;
- fork mode builds initial history from parent history plus delegated prompt;
- fork mode trims dangling tool-call pairs;
- child registry still excludes sub-agent management tools;
- `send_message` pending messages reach the child `TaskRunner`;
- skill `context: "fork"` passes `context_mode: "fork"`.

Integration tests:

- foreground isolated subagent remains compatible with current tests;
- background isolated subagent still injects `<task-notification>`;
- foreground forked subagent can answer from parent conversation context without restating it in the prompt;
- background forked subagent completes and notifies the parent;
- fork mode rejects recursion/depth-limit violations;
- background fork mode fails early when it would require an interactive approval prompt.

Regression suites:

- existing sub-agent tests;
- skill executor tests;
- session rewind/pairing tests;
- task-state/background notification tests.

## Implementation Order

1. Fix child-engine seams: `initialHistory` and `drainPendingMessages`.
2. Add enum-backed type model and behavior resolver with no behavior change.
3. Add fork context construction and child initial-history hydration.
4. Add `context_mode` routing through tool schema and runner.
5. Migrate skills to real fork mode.
6. Add diagnostics/telemetry and broaden tests.

This order matters. If fork mode is built before child session history and pending-message delivery are fixed, the API will appear to exist but will not work end to end.
