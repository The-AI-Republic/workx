# Track 40 Tasks: Sub-Agent Runtime Optimization

## Phase 0: Required Child-Agent Seams

- [ ] Change `RepublicAgentEngineConfig.initialHistory` to use the real `InitialHistory` type from `src/core/session/state/types.ts`.
- [ ] Pass `config.initialHistory` into internally-created `Session` instances in `RepublicAgentEngine.initialize()`.
- [ ] Extend `RepublicAgentEngine.createChildEngine()` so child engines can receive `initialHistory`.
- [ ] Update `Session` so non-persistent `InitialHistory.mode === "forked"` hydrates in-memory history without creating/persisting a top-level rollout.
- [ ] Add a helper that converts trimmed `ResponseItem[]` snapshots into forked `InitialHistory` rollout items, or explicitly extend `InitialHistory` with an in-memory response-item payload.
- [ ] Extract or share the Track 15 tool-call pairing trim utility from `src/core/session/rewind.ts`.
- [ ] Wire `drainPendingMessages` from `RepublicAgentEngineConfig` through `RegularTask`/`AgentTask` into `TaskRunner`.
- [ ] Add a test proving a fork snapshot includes the current user request that triggered the child run.
- [ ] Add seam tests proving child initial history is visible to a child task.
- [ ] Add seam tests proving `send_message` reaches a running child agent.

## Phase 1: Typed Agent Semantics

- [ ] Add `src/tools/AgentTool/agentTypes.ts` with `AgentType`, `SubAgentContextMode`, and `SubAgentExecutionMode`.
- [ ] Extend `SubAgentTypeConfig` with `agentType`, `defaultContextMode`, and `allowedContextModes`.
- [ ] Update built-in sub-agent configs to declare enum-backed `agentType`.
- [ ] Update `validateTypeConfig.ts` to validate/default new fields.
- [ ] Update `SubAgentSlotLoader` so plugin frontmatter can declare safe `agentType` and context-mode fields.
- [ ] Reject plugin/config attempts to use `AgentType.Internal`.
- [ ] Add tests for built-in, config, and plugin validation/defaulting.

## Phase 2: Behavior Profiles

- [ ] Add a central `resolveSubAgentBehavior()` function.
- [ ] Move current hardcoded defaults into behavior profiles without changing isolated-mode behavior.
- [ ] Apply resolved behavior in `SubAgentRunner.prepare()` before child registry/engine creation.
- [ ] Include `agentType`, `contextMode`, and `executionMode` in internal run metadata.
- [ ] Add tests for `GeneralPurpose`, `Researcher`, `Planner`, `Worker`, `Verifier`, and `Internal` profile resolution.

## Phase 3: Forked Subagent Context

- [ ] Add `src/tools/AgentTool/forkContext.ts`.
- [ ] Add a narrow parent conversation snapshot accessor for `SubAgentRunner`.
- [ ] Pairing-trim the parent history snapshot.
- [ ] Append a delegated fork-subagent instruction as the latest child user item.
- [ ] Build forked child `InitialHistory` from the trimmed history plus delegated instruction.
- [ ] Add fork metadata for diagnostics without writing a new top-level session.
- [ ] Add unit tests for empty, normal, tool-call-heavy, and trimmed-history fork contexts.

## Phase 4: Tool Schema And Runner Routing

- [ ] Extend `SubAgentToolParams` with `contextMode`.
- [ ] Extend the LLM-facing `sub_agent` schema with `context_mode`.
- [ ] Resolve effective context mode from tool params, type config, and behavior profile.
- [ ] Preserve isolated mode as the default path.
- [ ] Route fork mode through child engine `initialHistory`.
- [ ] Add guards for max depth, fork recursion, plugin opt-in, and background approval policy.
- [ ] Ensure background terminal task state is recorded even when notification delivery is suppressed.
- [ ] Add foreground and background fork-mode tests.

## Phase 5: Skill Integration

- [ ] Update `buildSubAgentInvoker()` so skill `context: "fork"` passes `context_mode: "fork"`.
- [ ] Update skill parser/executor tests to prove fork skills receive parent history.
- [ ] Keep existing skill frontmatter compatibility.
- [ ] Document that skill `context: "fork"` means forked subagent execution after this track.

## Phase 6: Events, Diagnostics, And Telemetry

- [ ] Add `type_id`, `agent_type`, `context_mode`, and `execution_mode` to sub-agent events/results where applicable.
- [ ] Include `agentType` and `contextMode` in `list_sub_agents`.
- [ ] Include fork/isolated mode in background `<task-notification>` metadata.
- [ ] Add regression coverage for existing isolated foreground/background behavior.
- [ ] Run sub-agent, skill, session-history, and task-state tests.
