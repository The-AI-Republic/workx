# Track 40 Tasks: Sub-Agent Runtime Optimization

Status: DONE. Implemented by PR #243, review follow-ups, and final fork-recursion/tag
guard on 2026-05-18.

Note: the merged code covers the child-history seams, typed agent semantics, fork routing,
skill fork integration, events, task-state regression coverage, and explicit rejection of
fork mode when inherited history already contains BrowserX's fork directive tag.

## Phase 0: Required Child-Agent Seams

- [x] Change `RepublicAgentEngineConfig.initialHistory` to use the real `InitialHistory` type from `src/core/session/state/types.ts`.
- [x] Pass `config.initialHistory` into internally-created `Session` instances in `RepublicAgentEngine.initialize()`.
- [x] Extend `RepublicAgentEngine.createChildEngine()` so child engines can receive `initialHistory`.
- [x] Update `Session` so non-persistent `InitialHistory.mode === "forked"` hydrates in-memory history without creating/persisting a top-level rollout.
- [x] Add a helper that converts trimmed `ResponseItem[]` snapshots into forked `InitialHistory` rollout items, or explicitly extend `InitialHistory` with an in-memory response-item payload.
- [x] Extract or share the Track 15 tool-call pairing trim utility from `src/core/session/rewind.ts`.
- [x] Wire `drainPendingMessages` from `RepublicAgentEngineConfig` through `RegularTask`/`AgentTask` into `TaskRunner`.
- [x] Add a test proving a fork snapshot includes the current user request that triggered the child run.
- [x] Add seam tests proving child initial history is visible to a child task.
- [x] Add seam tests proving `send_message` reaches a running child agent.

## Phase 1: Typed Agent Semantics

- [x] Add `src/tools/AgentTool/agentTypes.ts` with `AgentType`, `SubAgentContextMode`, and `SubAgentExecutionMode`.
- [x] Extend `SubAgentTypeConfig` with `agentType`, `defaultContextMode`, and `allowedContextModes`.
- [x] Update built-in sub-agent configs to declare enum-backed `agentType`.
- [x] Update `validateTypeConfig.ts` to validate/default new fields.
- [x] Update `SubAgentSlotLoader` so plugin frontmatter can declare safe `agentType` and context-mode fields.
- [x] Reject plugin/config attempts to use `AgentType.Internal`.
- [x] Add tests for built-in, config, and plugin validation/defaulting.

## Phase 2: Behavior Profiles

- [x] Add a central `resolveSubAgentBehavior()` function.
- [x] Move current hardcoded defaults into behavior profiles without changing isolated-mode behavior.
- [x] Apply resolved behavior in `SubAgentRunner.prepare()` before child registry/engine creation.
- [x] Include `agentType`, `contextMode`, and `executionMode` in internal run metadata.
- [x] Add tests for `GeneralPurpose`, `Researcher`, `Planner`, `Worker`, `Verifier`, and `Internal` profile resolution.

## Phase 3: Forked Subagent Context

- [x] Add `src/tools/AgentTool/forkContext.ts`.
- [x] Add a narrow parent conversation snapshot accessor for `SubAgentRunner`.
- [x] Pairing-trim the parent history snapshot.
- [x] Append a delegated fork-subagent instruction as the latest child user item.
- [x] Build forked child `InitialHistory` from the trimmed history plus delegated instruction.
- [x] Add fork metadata for diagnostics without writing a new top-level session.
- [x] Add unit tests for empty, normal, tool-call-heavy, and trimmed-history fork contexts.

## Phase 4: Tool Schema And Runner Routing

- [x] Extend `SubAgentToolParams` with `contextMode`.
- [x] Extend the LLM-facing `sub_agent` schema with `context_mode`.
- [x] Resolve effective context mode from tool params, type config, and behavior profile.
- [x] Preserve isolated mode as the default path.
- [x] Route fork mode through child engine `initialHistory`.
- [x] Add guards for max depth, plugin opt-in, and background approval policy.
- [x] Add an explicit fork-recursion/tag guard so a forked sub-agent cannot recursively fork
      from inherited history containing the fork boilerplate.
- [x] Ensure background terminal task state is recorded even when notification delivery is suppressed.
- [x] Add foreground and background fork-mode tests.

## Phase 5: Skill Integration

- [x] Update `buildSubAgentInvoker()` so skill `context: "fork"` passes `context_mode: "fork"`.
- [x] Update skill parser/executor tests to prove fork skills receive parent history.
- [x] Keep existing skill frontmatter compatibility.
- [x] Document that skill `context: "fork"` means forked subagent execution after this track.

## Phase 6: Events, Diagnostics, And Telemetry

- [x] Add `type_id`, `agent_type`, `context_mode`, and `execution_mode` to sub-agent events/results where applicable.
- [x] Include `agentType` and `contextMode` in `list_sub_agents`.
- [x] Include fork/isolated mode in background `<task-notification>` metadata.
- [x] Add regression coverage for existing isolated foreground/background behavior.
- [x] Run sub-agent, skill, session-history, and task-state tests.
