# Migrate RepublicAgent to RepublicAgentEngine — Tasks

> Implementation tasks for consolidating the dual execution loops.
> See [design.md](./design.md) for full design details.

## Overview

| Phase | Description | Tasks | Critical Path |
|-------|-------------|-------|---------------|
| Phase 1 | Wire Engine to Real Session | M1.1 - M1.4 | ✅ Yes |
| Phase 2 | Move Execution Handlers to Engine | M2.1 - M2.5 | ✅ Yes |
| Phase 3 | RepublicAgent Delegates to Engine | M3.1 - M3.5 | ✅ Yes |
| Phase 4 | Remove Duplicate Queue | M4.1 - M4.3 | No |
| Phase 5 | Sub-Agent End-to-End Validation | M5.1 - M5.3 | No |

**Critical Path:** `M1.1 → M1.2 → M1.3 → M2.1 → M2.3 → M3.1 → M3.2 → M3.3`

---

## Phase 1: Wire Engine to Real Session (Foundation)

| Task | Status | File(s) | Description | Blocked By |
|------|--------|---------|-------------|------------|
| M1.1 | ✅ | `src/core/engine/RepublicAgentEngineConfig.ts` | Add `session?` and `ownsSession?` to config type | — |
| M1.2 | ✅ | `src/core/engine/RepublicAgentEngine.ts` | Accept external Session in `initialize()`, create internal Session when none provided | M1.1 |
| M1.3 | ✅ | `src/core/engine/RepublicAgentEngine.ts` | Replace `handleUserInput()` stub with `Session.spawnTask()` delegation | M1.2 |
| M1.4 | ⬜ | `src/core/engine/__tests__/RepublicAgentEngine.test.ts` | Unit tests: engine with injected mock Session spawns real tasks | M1.3 |

### M1.1 Details
- Add to `RepublicAgentEngineConfig`:
  - `session?: Session` — externally managed Session instance
  - `ownsSession?: boolean` — whether engine disposes session on `dispose()`
- Default: `ownsSession = true` when `session` is not provided, `false` when provided

### M1.2 Details
- In `initialize()`:
  - If `config.session` is provided, use it directly (don't create a new one)
  - If not provided, create a new non-persistent Session (sub-agent path)
  - Store `this.ownsSession` flag for `dispose()` logic
- In `dispose()`:
  - Only call `session.shutdown()` if `this.ownsSession === true`

### M1.3 Details
- Replace echo stub in `handleUserInput()` with:
  1. Build `InputItem[]` from submission
  2. Create `RegularTask` instance
  3. Call `this.session.spawnTask(task, ...)`
  4. Wire `onComplete`/`onAborted` callbacks to emit engine events
  5. For awaitable mode: resolve `completionResolvers[submissionId]`
- Handle errors: emit `TaskError` event, resolve completion with failure

### M1.4 Details
- Test: engine with mock Session verifies `spawnTask()` is called with correct task
- Test: `onComplete` callback emits `TaskComplete` event to EQ
- Test: `onAborted` callback emits `TaskAborted` event to EQ
- Test: awaitable `run()` returns `EngineResult` after task completes
- Test: error during `spawnTask()` emits `TaskError` and resolves completion

**Acceptance Criteria:**
- `RepublicAgentEngine.run(prompt)` executes through `Session.spawnTask()` → `TaskRunner.runLoop()`
- Engine events (`TaskStarted`, `TaskComplete`, `TaskError`) are emitted correctly
- Awaitable mode returns `EngineResult` with response text, token usage, turn count
- Existing engine tests still pass (if any)

---

## Phase 2: Move Execution Handlers to Engine

| Task | Status | File(s) | Description | Blocked By |
|------|--------|---------|-------------|------------|
| M2.1 | ✅ | `src/core/engine/RepublicAgentEngine.ts` | Implement real `handleInterrupt()` — clear SQ, abort tasks via Session | M1.3 |
| M2.2 | ✅ | `src/core/engine/RepublicAgentEngine.ts` | Implement real `handleExecApproval()` — dual routing (ApprovalManager + Session) | M1.3 |
| M2.3 | ✅ | `src/core/engine/RepublicAgentEngine.ts` | Implement real `handleCompact()` — delegate to Session.compact() | M1.3 |
| M2.4 | ✅ | `src/core/engine/RepublicAgentEngine.ts` | Implement `handleAddToHistory()` and `handlePatchApproval()` | M1.3 |
| M2.5 | ⬜ | `src/core/engine/__tests__/RepublicAgentEngine.test.ts` | Unit tests for all moved handlers | M2.1, M2.2, M2.3, M2.4 |

### M2.1 Details
- Move interrupt logic from `RepublicAgent.handleInterrupt()`:
  1. Clear `submissionQueue`
  2. Call `this.session.abortAllTasks('UserInterrupt')`
  3. Emit `TaskAborted` event with reason
- Note: User notification stays in RepublicAgent (orchestration concern)

### M2.2 Details
- Move approval logic from `RepublicAgent.handleExecApproval()`:
  1. Capture pending approval data from ApprovalManager
  2. Route to `ApprovalManager.handleDecision()` (if exists)
  3. Route to `Session.notifyApproval()` (protocol-level)
  4. Handle "remember decision" via `approvalGate.rememberDecision()`
  5. Emit `ExecApprovalHandled` event
- Engine needs `ApprovalManager` reference (add to config or create in `initialize()`)

### M2.3 Details
- Move compaction logic from `RepublicAgent.handleCompact()`:
  1. Determine mode ('auto' vs 'manual') from submission type
  2. Call `this.session.compact(mode)`
  3. Emit `CompactComplete` event with result (tokensBefore, tokensAfter, itemsTrimmed)

### M2.4 Details
- `handleAddToHistory()`: delegate to `this.session.addToHistory(items)`
- `handlePatchApproval()`: delegate to `this.session.notifyApproval(approvalId, decision)`
- Add `AddToHistory` to engine's EngineOp union type if not present

### M2.5 Details
- Test: interrupt clears SQ and calls `session.abortAllTasks`
- Test: exec approval routes to both ApprovalManager and Session
- Test: remember decision calls `approvalGate.rememberDecision`
- Test: compact delegates to `session.compact()` with correct mode
- Test: add-to-history delegates to `session.addToHistory()`

**Acceptance Criteria:**
- Each handler in the engine produces identical side effects to the RepublicAgent version
- Engine tests verify correct Session method calls for each operation type
- Approval dual-routing is preserved exactly

---

## Phase 3: RepublicAgent Delegates to Engine (Core Migration)

| Task | Status | File(s) | Description | Blocked By |
|------|--------|---------|-------------|------------|
| M3.1 | ✅ | `src/core/RepublicAgent.ts` | Create engine in `initialize()`, pass shared Session | M2.3 |
| M3.2 | ✅ | `src/core/RepublicAgent.ts` | Wire engine events to `eventDispatcher` (event bridge) | M3.1 |
| M3.3 | ✅ | `src/core/RepublicAgent.ts` | Replace `submitOperation()` dispatch — route to engine for execution ops, keep local for orchestration ops | M3.2 |
| M3.4 | ✅ | `src/core/RepublicAgent.ts` | Extract `preSubmitHooks()` — tab binding + pending model switch before forwarding UserInput to engine | M3.3 |
| M3.5 | ✅ | `src/core/__tests__/RepublicAgent.test.ts` | Update tests: verify delegation to engine, mock engine where needed | M3.4 |

### M3.1 Details
- In `RepublicAgent.initialize()`:
  1. After creating Session, ModelClientFactory, ToolRegistry (existing logic)
  2. Create `RepublicAgentEngine` with `{ session: this.session, ownsSession: false, ... }`
  3. Call `engine.initialize()`
  4. Store as `this.engine`
- Session creation logic stays in RepublicAgent (it knows about persistence, config, platform adapter)

### M3.2 Details
- Add `wireEngineEvents()` method:
  - Subscribe to engine's event stream
  - Convert `EngineEvent` types to existing channel message format
  - Call `this.dispatchEvent()` for each event
- This preserves the existing `setEventDispatcher()` API and UI contract

### M3.3 Details
- Replace the 12-case `handleSubmission()` switch with routing:
  - **Local ops**: `GetPath`, `OverrideTurnContext`, `GetHistoryEntryRequest` — handle directly
  - **Pre-processed ops**: `UserInput`, `UserTurn` — run preSubmitHooks, then forward to engine
  - **Forwarded ops**: `Interrupt`, `ExecApproval`, `PatchApproval`, `Compact`, `ManualCompact`, `AddToHistory` — forward to engine
  - **Lifecycle ops**: `Shutdown` — call `engine.dispose()` + `this.cleanup()`
- Remove `RepublicAgent.processSubmissionQueue()` — engine owns the queue now

### M3.4 Details
- Extract from `processUserInputWithTask()`:
  - `handleTabBinding(op)` — stays in RepublicAgent
  - `applyPendingModelSwitch()` — stays in RepublicAgent
- These run synchronously before `engine.submitOperation(op)` is called
- Remove `processUserInputWithTask()` — its logic is split between preSubmitHooks and engine

### M3.5 Details
- Tests that verify SQ behavior → verify engine.submitOperation() is called
- Tests that verify event dispatch → verify engine events bridge to eventDispatcher
- Tests for tab binding and model switch → unchanged (preSubmitHooks)
- Tests for approval/interrupt/compact → verify forwarded to engine
- Goal: all 72 existing RepublicAgent tests pass

**Acceptance Criteria:**
- RepublicAgent no longer has its own SQ/EQ
- All submissions route through engine's SQ
- Event bridge delivers engine events to UI eventDispatcher
- preSubmitHooks (tab binding + model apply) run before UserInput reaches engine
- All 72 RepublicAgent.test.ts tests pass
- All 21 BrowserxAgent.model-switch.test.ts tests pass
- Full suite (7339 tests) passes

---

## Phase 4: Remove Duplicate Queue (Cleanup)

| Task | Status | File(s) | Description | Blocked By |
|------|--------|---------|-------------|------------|
| M4.1 | ⬜ | `src/core/RepublicAgent.ts` | Remove `submissionQueue`, `eventQueue`, `isProcessing`, `processSubmissionQueue()`, `handleSubmission()` | M3.5 |
| M4.2 | ⬜ | `src/core/RepublicAgent.ts` | Remove handler methods that were moved to engine (`handleInterrupt`, `handleExecApproval`, `handleCompact`, etc.) | M4.1 |
| M4.3 | ⬜ | `src/core/__tests__/RepublicAgent.test.ts` | Clean up tests that tested removed internal methods | M4.2 |

### M4.1 Details
- Delete fields: `submissionQueue`, `eventQueue`, `isProcessing`, `nextId`
- Delete methods: `processSubmissionQueue()`, `handleSubmission()`, `emitEvent()`
- RepublicAgent.submitOperation() now directly routes (no queue) — the queue lives in the engine

### M4.2 Details
- Delete methods moved to engine:
  - `handleInterrupt()` (logic now in engine)
  - `handleExecApproval()` (logic now in engine)
  - `handlePatchApproval()` (logic now in engine)
  - `handleCompact()` (logic now in engine)
  - `handleAddToHistory()` (logic now in engine)
  - `processUserInputWithTask()` (replaced by preSubmitHooks + engine delegation)
- Keep: `handleTabBinding()`, `handleModelConfigChange()`, `handleGetPath()`, local query handlers

### M4.3 Details
- Remove tests for deleted internal methods
- Ensure coverage remains high through engine tests + delegation tests
- All remaining tests must pass

**Acceptance Criteria:**
- RepublicAgent has no SQ/EQ fields or processing methods
- No dead code remains
- Full test suite passes
- RepublicAgent is ~400 lines (down from ~1241)

---

## Phase 5: Sub-Agent End-to-End Validation

| Task | Status | File(s) | Description | Blocked By |
|------|--------|---------|-------------|------------|
| M5.1 | ⬜ | `src/core/engine/__tests__/RepublicAgentEngine.integration.test.ts` | Integration test: engine with real Session + mocked ModelClient executes multi-turn task | M3.5 |
| M5.2 | ⬜ | `src/core/__tests__/RepublicAgent.createChildEngine.test.ts` | Test: `createChildEngine()` returns engine that runs real tasks | M5.1 |
| M5.3 | ⬜ | `src/core/subagent/__tests__/SubAgentRunner.integration.test.ts` | Test: SubAgentRunner uses engine to execute sub-agent tasks end-to-end | M5.2 |

### M5.1 Details
- Create integration test with:
  - Real Session (non-persistent)
  - Mocked ModelClient that returns predefined responses
  - Mocked ToolRegistry with a test tool
  - Verify: `engine.run("test prompt")` → LLM called → tool executed → result returned
  - Verify: multi-turn works (tool call → tool result → LLM response)

### M5.2 Details
- Test `RepublicAgent.createChildEngine()`:
  - Returns a `RepublicAgentEngine` instance
  - Child engine has cloned ToolRegistry (restricted)
  - Child engine has own Session (non-persistent)
  - `childEngine.run("prompt")` returns `EngineResult` with real LLM response

### M5.3 Details
- Test full sub-agent flow:
  - `SubAgentRunner` creates engine via `createChildEngine()`
  - Runs sub-agent with specific system prompt and tools
  - Sub-agent executes tools and returns structured result
  - Parent receives result through `SubAgentTool`

**Acceptance Criteria:**
- `engine.run(prompt)` produces real LLM responses (with mocked ModelClient)
- Sub-agents can execute tools from their restricted registry
- Multi-turn sub-agent tasks work (tool call → tool result → final response)
- Sub-agent events route to parent via `SubAgentEventRouter`

---

## Dependency Graph

```
Phase 1 (Foundation)
  M1.1 ──► M1.2 ──► M1.3 ──► M1.4
                       │
                       ▼
Phase 2 (Move Handlers)
  M2.1 ◄──────────────┤
  M2.2 ◄──────────────┤
  M2.3 ◄──────────────┤
  M2.4 ◄──────────────┘
  M2.5 ◄── M2.1, M2.2, M2.3, M2.4
                       │
                       ▼
Phase 3 (Core Migration)
  M3.1 ──► M3.2 ──► M3.3 ──► M3.4 ──► M3.5
                                          │
                       ┌──────────────────┤
                       ▼                  ▼
Phase 4 (Cleanup)      Phase 5 (Validation)
  M4.1 ──► M4.2       M5.1 ──► M5.2 ──► M5.3
              │
              ▼
            M4.3
```

## Parallelization Opportunities

| Parallel Group | Tasks | Notes |
|---------------|-------|-------|
| Phase 2 handlers | M2.1, M2.2, M2.3, M2.4 | All independent, can be implemented in parallel |
| Phase 4 + Phase 5 | M4.x and M5.x | Independent after Phase 3 completes |
