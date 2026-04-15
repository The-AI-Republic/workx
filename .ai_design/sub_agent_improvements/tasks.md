# Sub-Agent Improvement Tasks

> Implementation tasks for the sub-agent improvements.
> See [design.md](./design.md) for full design details.

## Overview

| Phase | Description | Tasks | Blocked By |
|-------|-------------|-------|------------|
| Phase 1 | Safety & Correctness | 1.1 - 1.4 | — |
| Phase 2 | Background Execution | 2.1 - 2.5 | Phase 1 |
| Phase 3 | Cross-Agent Messaging | 3.1 - 3.4 | Phase 2 |
| Phase 4 | Custom Types from Config | 4.1 - 4.4 | — |

**Critical Path:** `1.1 → 1.2 → 2.1 → 2.2 → 2.4 → 3.1 → 3.3`

---

## Phase 1: Safety & Correctness

| Task | Status | Description | Blocked By |
|------|--------|-------------|------------|
| 1.1 | ⬜ | Recursion depth enforcement | — |
| 1.2 | ⬜ | Signal propagation wiring | — |
| 1.3 | ⬜ | Token usage aggregation | — |
| 1.4 | ⬜ | Phase 1 tests | 1.1, 1.2, 1.3 |

### 1.1 Recursion Depth Enforcement

**Files:** `RepublicAgentEngineConfig.ts`, `RepublicAgentEngine.ts`, `SubAgentRunner.ts`

- Add `depth: number` (default 0) and `maxDepth: number` (default 3) to `RepublicAgentEngineConfig`
- Store depth on `RepublicAgentEngine` instance, expose via `getDepth()` and `getMaxDepth()`
- In `createChildEngine()`: set child's `depth = this.depth + 1`, propagate `maxDepth`
- In `SubAgentRunner.run()`: check `parentEngine.getDepth() >= parentEngine.getMaxDepth()` before creating child; return error result if exceeded
- Remove reliance on tool deny list as the sole recursion prevention

### 1.2 Signal Propagation Wiring

**Files:** `SubAgentRunner.ts`, `RepublicAgentEngine.ts`

- In `SubAgentRunner.run()` for foreground agents: create a child `AbortController` linked to both the parent engine's lifecycle and `params.signal`
- Pass the child signal to `engine.run(input, { signal: childSignal })`
- Verify `engine.run()` propagates signal to `Session.spawnTask()` and `TaskRunner.runLoop()`
- On parent engine dispose: child controller aborts (foreground only)
- On `params.signal` abort: child controller aborts

### 1.3 Token Usage Aggregation

**Files:** `SubAgentRegistry.ts`, `SubAgentRunner.ts`, `types.ts`

- Add `SubAgentUsageSummary` interface to `types.ts`
- Add `recordUsage(runId, usage)` and `getUsageSummary()` to `SubAgentRegistry`
- In `SubAgentRunner.run()`: call `registry.recordUsage()` after engine completes
- Usage data stored alongside `ActiveSubAgent` entries

### 1.4 Phase 1 Tests

**Files:** `__tests__/SubAgentRunner.depth.test.ts`, `__tests__/SubAgentRunner.signal.test.ts`

- Test: sub-agent at depth 3 (maxDepth=3) returns error, does not create engine
- Test: sub-agent at depth 2 (maxDepth=3) succeeds
- Test: aborting parent signal cancels foreground sub-agent
- Test: aborting params.signal cancels sub-agent
- Test: token usage aggregated across multiple sub-agent runs

---

## Phase 2: Background Execution

| Task | Status | Description | Blocked By |
|------|--------|-------------|------------|
| 2.1 | ⬜ | Add `background` flag to SubAgentToolParams | 1.1, 1.2 |
| 2.2 | ⬜ | Background execution in SubAgentRunner | 2.1 |
| 2.3 | ⬜ | `list_sub_agents` and `cancel_sub_agent` tools | 2.2 |
| 2.4 | ⬜ | Task notification pipeline | 2.2 |
| 2.5 | ⬜ | Phase 2 tests | 2.2, 2.3, 2.4 |

### 2.1 Add `background` Flag

**Files:** `types.ts`, `SubAgentTool.ts`

- Add `background?: boolean` to `SubAgentToolParams`
- Update `buildSubAgentToolDefinition()` to include `background` parameter in tool schema
- Add `BackgroundSubAgentResult` type for immediate return: `{ status: 'launched', runId: string }`

### 2.2 Background Execution in SubAgentRunner

**Files:** `SubAgentRunner.ts`

- When `background: true`:
  - Create an independent `AbortController` (not linked to parent)
  - Override `approvalPolicy` to `'never'` (background agents cannot prompt)
  - Start `engine.run()` in a detached promise (do not await)
  - Register a completion handler on the detached promise (for notifications, cleanup)
  - Return `BackgroundSubAgentResult` immediately
- When `background: false` (default):
  - No change from current behavior

### 2.3 Management Tools

**Files:** new `src/core/subagent/managementTools.ts` or extend `register.ts`

- `list_sub_agents` tool:
  - No parameters
  - Returns JSON array of `{ runId, type, description, status, startTime, durationMs? }` from `SubAgentRegistry.getAll()`
- `cancel_sub_agent` tool:
  - Parameter: `runId: string`
  - Validates agent exists and is running
  - Calls `engine.dispose()` on the target agent
  - Returns `{ success: boolean, message: string }`
- Register both tools alongside `sub_agent` in `registerSubAgentTool()`

### 2.4 Task Notification Pipeline

**Files:** `RepublicAgentEngine.ts`, `SubAgentRunner.ts`, new `types.ts` additions

- Add `TaskNotification` interface to `types.ts`
- Add `injectNotification(notification)` to `RepublicAgentEngine`:
  - Formats notification as XML text
  - Calls `submitOperation({ type: 'AddToHistory', text })` on the parent engine
- In `SubAgentRunner`: attach a `.then()` handler on the background engine's detached promise:
  - On success: call `parentEngine.injectNotification({ status: 'completed', result, ... })`
  - On failure: call `parentEngine.injectNotification({ status: 'failed', error, ... })`
  - On cancel: call `parentEngine.injectNotification({ status: 'cancelled', ... })`
- Always include token usage and duration in the notification

### 2.5 Phase 2 Tests

**Files:** `__tests__/SubAgentRunner.background.test.ts`, `__tests__/notification.test.ts`

- Test: background=true returns immediately with `{ status: 'launched', runId }`
- Test: background agent runs to completion and injects notification
- Test: background agent failure injects error notification
- Test: `cancel_sub_agent` aborts running background agent
- Test: `list_sub_agents` returns correct status for foreground and background agents
- Test: background agent uses `approvalPolicy: 'never'` regardless of type config
- Test: background agent's AbortController is independent from parent

---

## Phase 3: Cross-Agent Messaging

| Task | Status | Description | Blocked By |
|------|--------|-------------|------------|
| 3.1 | ⬜ | Pending message queue in SubAgentRegistry | 2.2 |
| 3.2 | ⬜ | `send_message` tool | 3.1 |
| 3.3 | ⬜ | Message drain hook in TaskRunner | 3.1 |
| 3.4 | ⬜ | Phase 3 tests | 3.2, 3.3 |

### 3.1 Pending Message Queue

**Files:** `SubAgentRegistry.ts`

- Add `pendingMessages: Map<string, string[]>` to `SubAgentRegistry`
- Add `queueMessage(runId, message)`: validates agent exists and is running, appends to queue
- Add `drainMessages(runId): string[]`: returns and clears pending messages for agent
- Messages are plain text strings

### 3.2 `send_message` Tool

**Files:** extend `register.ts` or `managementTools.ts`

- Parameters: `to: string` (runId), `message: string`
- Validates target agent exists and has `status === 'running'`
- Calls `registry.queueMessage(to, message)`
- Returns `{ success: true, message: 'Message queued' }`

### 3.3 Message Drain Hook in TaskRunner

**Files:** `TaskRunner.ts`, `SubAgentRunner.ts`

- Add an optional `getPendingMessages?: () => string[]` callback to `TaskRunner` or `RegularTask`
- In `TaskRunner.runLoop()`, after each turn completes:
  - Check `getPendingMessages()` for queued messages
  - If messages exist: inject as a user message into the session, continue the loop
- `SubAgentRunner` wires this callback to `registry.drainMessages(runId)` when creating the child engine's task

### 3.4 Phase 3 Tests

**Files:** `__tests__/SubAgentRunner.messaging.test.ts`

- Test: `send_message` to running background agent queues the message
- Test: queued messages are drained and injected between turns
- Test: `send_message` to non-existent agent returns error
- Test: `send_message` to completed agent returns error
- Test: multiple messages are joined and injected as one user message

---

## Phase 4: Custom Types from Config

| Task | Status | Description | Blocked By |
|------|--------|-------------|------------|
| 4.1 | ⬜ | Config schema for `subAgentTypes` | — |
| 4.2 | ⬜ | Load and validate in registerSubAgentTool() | 4.1 |
| 4.3 | ⬜ | Merge precedence logic | 4.2 |
| 4.4 | ⬜ | Phase 4 tests | 4.2, 4.3 |

### 4.1 Config Schema

**Files:** `config/types.ts`

- Add `SubAgentTypeConfigSchema` matching `SubAgentTypeConfig` interface
- Add `subAgentTypes?: SubAgentTypeConfig[]` to the agent config type
- Validate: `id` must be non-empty string, `systemPrompt` required, `maxTurns >= 1`

### 4.2 Load and Validate

**Files:** `register.ts`

- In `registerSubAgentTool()`: read `subAgentTypes` from `AgentConfig`
- Validate each entry against schema
- Log warnings for invalid entries (don't throw — skip gracefully)

### 4.3 Merge Precedence

**Files:** `register.ts`

- Order: built-in types (lowest) < config types < programmatic `customTypes` (highest)
- Merge by `id`: later entries replace earlier entries with same `id`
- Log when a config type overrides a built-in type

### 4.4 Phase 4 Tests

**Files:** `__tests__/register.config.test.ts`

- Test: config-defined type is available via sub_agent tool
- Test: config type overrides built-in type with same id
- Test: programmatic customTypes overrides config type
- Test: invalid config entry is skipped with warning
