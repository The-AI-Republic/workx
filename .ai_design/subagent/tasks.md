# Sub-Agent Implementation Tasks

## Phase 0: AgentExecutor Refactoring (Prerequisite)

See `refactor-republic-agent.md` for full design.

### R01: AgentExecutorConfig types
**File:** `src/core/AgentExecutorConfig.ts` (new)
- [ ] Define `AgentExecutorConfig` interface
- [ ] Define `ExecutorResult` interface
- [ ] Define `RunOptions` interface
**Blocked by:** nothing

### R02: AgentExecutor implementation
**File:** `src/core/AgentExecutor.ts` (new, ~150 lines)
- [ ] Constructor: create non-persistent Session with injected ToolRegistry
- [ ] `initialize()`: create ModelClient via shared factory, set up TurnContext with system prompt
- [ ] `run(input, options)`: create RegularTask, call task.run() directly (awaitable), return ExecutorResult
- [ ] `cancel()`: abort session tasks
- [ ] Handle AbortSignal wiring
- [ ] Wire onEvent callback for event observation
**Blocked by:** R01

### R03: ToolRegistry.getToolEntry()
**File:** `src/tools/ToolRegistry.ts` (modify, ~5 lines)
- [ ] Add `getToolEntry(name: string): ToolRegistryEntry | undefined`
- [ ] Unit test
**Blocked by:** nothing

### R04: RepublicAgent.createExecutor()
**File:** `src/core/RepublicAgent.ts` (modify, ~15 lines)
- [ ] Add `createExecutor(config)` factory method
- [ ] Passes shared AgentConfig, ModelClientFactory
- [ ] Allows override of ToolRegistry, systemPrompt, model
**Blocked by:** R02

### R05: AgentExecutor unit tests
- [ ] Test: run() returns final assistant message
- [ ] Test: restricted ToolRegistry is respected (only allowed tools available)
- [ ] Test: cancel() aborts execution
- [ ] Test: non-persistent Session doesn't write to disk
- [ ] Test: onEvent callback receives events
**Blocked by:** R02

### R06: Integration test — createExecutor()
- [ ] Test: parentAgent.createExecutor() produces working executor
- [ ] Test: executor shares parent's ModelClientFactory
- [ ] Test: executor uses injected ToolRegistry
- [ ] Test: executor runs independently of parent's session
**Blocked by:** R04

**Phase 0 dependency graph:**
```
R01 ── R02 ── R04 ── R06
              R05
R03 (parallel)
```
**Critical path:** R01 → R02 → R04 → R06

---

## Phase 1: Core Sub-Agent (Foreground Only)

### T01: Sub-Agent Type Definitions
**File:** `src/core/subagent/types.ts`
- [ ] Define `SubAgentTypeConfig` interface
- [ ] Define `SubAgentToolParams` interface
- [ ] Define `SubAgentResult` interface
- [ ] Export all types
**Blocked by:** R01 (uses ExecutorResult as reference)

### T02: Built-in Sub-Agent Types
**File:** `src/core/subagent/builtinTypes.ts`
- [ ] Define `researcher` type config (read-only tools, concise prompt)
- [ ] Define `planner` type config (read + planning tools)
- [ ] Define `worker` type config (full tools minus sub_agent)
- [ ] Export `BUILTIN_SUBAGENT_TYPES` array
- [ ] Verify deny list tool names match actual registered tool names
**Blocked by:** T01

### T03: Tool Subsetting
**File:** `src/core/subagent/toolSubset.ts`
- [ ] Implement `createSubAgentToolRegistry(parentRegistry, config)`
- [ ] Apply allowlist logic
- [ ] Apply denylist logic
- [ ] Always exclude `sub_agent` tool (no nesting)
- [ ] Unit test: allowlist filters correctly
- [ ] Unit test: denylist filters correctly
- [ ] Unit test: sub_agent always excluded
**Blocked by:** T01, R03

### T04: SubAgentTool Definition
**File:** `src/core/subagent/SubAgentTool.ts`
- [ ] Implement `buildSubAgentToolDefinition(types)` — returns ToolDefinition
- [ ] Dynamic enum from registered type IDs
- [ ] Description includes type descriptions for LLM
- [ ] Do NOT include `background` param in Phase 1
- [ ] Unit test: schema is valid
**Blocked by:** T01, T02

### T05: Sub-Agent Event Types
**File:** `src/core/protocol/events.ts`
- [ ] Add `SubAgentStart` event type (runId, type, description)
- [ ] Add `SubAgentComplete` event type (runId, type, turnCount, tokenUsage, duration)
- [ ] Add `SubAgentError` event type (runId, type, error)
- [ ] Add to EventMsg union type
**Blocked by:** nothing

### T06: SubAgentRunner
**File:** `src/core/subagent/SubAgentRunner.ts`
- [ ] Implement `run(params, parentAgent, typeConfig)` method
- [ ] Create restricted ToolRegistry via `createSubAgentToolRegistry()`
- [ ] Create AgentExecutor via `parentAgent.createExecutor()`
- [ ] Call `executor.initialize()`
- [ ] Call `executor.run(input, { maxTurns, signal })`
- [ ] Wrap with `Promise.race()` for maxDurationMs timeout (default: 120s)
- [ ] Map ExecutorResult → SubAgentResult
- [ ] Emit SubAgentStart event to parent before run
- [ ] Emit SubAgentComplete/Error event to parent after run
- [ ] Handle cancellation (parent's AbortSignal → executor.cancel())
**Blocked by:** T01, T03, T05, R04

### T07: Registration Helper
**File:** `src/core/subagent/register.ts`
- [ ] Implement `registerSubAgentTool(agent, options)`
- [ ] Build tool definition from types
- [ ] Create handler that delegates to SubAgentRunner
- [ ] Register tool in agent's ToolRegistry
- [ ] Set risk assessor (low risk — internal delegation)
**Blocked by:** T04, T06

### T08: Bootstrap Integration
**Files:** `ServerAgentBootstrap.ts`, `DesktopAgentBootstrap.ts`, `service-worker.ts`
- [ ] Import and call `registerSubAgentTool()` after platform tools
- [ ] Pass built-in types
- [ ] Server mode: verify sub-agent spawning works
- [ ] Desktop mode: verify sub-agent spawning works
- [ ] Extension mode: verify sub-agent spawning works
**Blocked by:** T07

### T09: System Prompt Guidance
**File:** PromptComposer / base prompt
- [ ] Add guidance for when to use sub_agent vs doing work directly
- [ ] Emphasize: include ALL context in the prompt (sub-agent has no history)
- [ ] Emphasize: only for self-contained tasks, not interactive ones
- [ ] Make `description` required in prompt guidance
**Blocked by:** T08

### T10: Integration Tests
- [ ] E2E: parent delegates research task to researcher sub-agent
- [ ] E2E: parent delegates coding task to worker sub-agent
- [ ] E2E: sub-agent maxTurns enforcement
- [ ] E2E: sub-agent tool restriction (cannot use denied tools)
- [ ] E2E: sub-agent cannot spawn sub-agent (no nesting)
- [ ] E2E: parent cancellation propagates to sub-agent
- [ ] E2E: model override works (sub-agent uses different model)
- [ ] E2E: maxDurationMs timeout works
- [ ] E2E: token usage from sub-agent appears in parent's totals
**Blocked by:** T08

### T11: Index/Exports
**File:** `src/core/subagent/index.ts`
- [ ] Export public API: types, register, builtinTypes
**Blocked by:** T07

---

## Phase 2: Background Execution & Resume

### T20: Background SubAgentRunner
- [ ] Implement `runBackground()` — returns immediately with runId
- [ ] Store result in a Map keyed by runId on completion
- [ ] Emit SubAgentComplete notification to parent event stream
- [ ] Add `background` param to tool schema

### T21: sub_agent_status Tool
- [ ] New tool: query sub-agent status by runId
- [ ] Returns: status, result (if complete), turn count, elapsed time

### T22: Sub-Agent Resume
- [ ] Persist sub-agent session state (switch to persistent: true)
- [ ] Implement resume by runId (load history, continue)

### T23: Token Budget
- [ ] Add `maxTokens` to SubAgentTypeConfig
- [ ] Track cumulative token usage during sub-agent run
- [ ] Stop sub-agent when budget exceeded

---

## Phase 3: User-Defined Types & Memory

### T30: UI for Custom Sub-Agent Types
- [ ] Settings panel for creating/editing sub-agent types
- [ ] Custom system prompt editor
- [ ] Tool allow/deny list picker
- [ ] Model selector

### T31: Sub-Agent Memory
- [ ] Persistent storage per sub-agent type
- [ ] MEMORY.md loaded into sub-agent system prompt
- [ ] Read/Write tools for memory files

### T32: Sub-Agent Streaming to UI
- [ ] Forward sub-agent AgentMessageDelta events to parent UI
- [ ] Show sub-agent progress in real-time
- [ ] Collapsible sub-agent output in chat

---

## Full Dependency Graph

```
Phase 0 (Prerequisite):
  R01 ── R02 ── R04 ── R06
                R05
  R03 (parallel)

Phase 1 (after Phase 0 complete):
  T01 ─┬─ T02 ─── T04 ─┐
       └─ T03 ──────────┤
  T05 ─── T06 ───────────┼─ T07 ─── T08 ─── T09 ─── T10
  R04 ─── T06            │
                          └─ T11
```

**Critical path:** R01 → R02 → R04 → T06 → T07 → T08 → T10

## File Structure (Final)

```
src/core/
  ├── AgentExecutor.ts           # NEW — core execution engine
  ├── AgentExecutorConfig.ts     # NEW — types
  ├── RepublicAgent.ts           # MODIFIED — add createExecutor()
  ├── subagent/                  # NEW — sub-agent system
  │   ├── types.ts
  │   ├── builtinTypes.ts
  │   ├── SubAgentTool.ts
  │   ├── SubAgentRunner.ts
  │   ├── toolSubset.ts
  │   ├── register.ts
  │   └── index.ts
  └── ... (unchanged)

src/tools/
  └── ToolRegistry.ts            # MODIFIED — add getToolEntry()
```
