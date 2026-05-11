# Sub-Agent Improvement Tasks

> Implementation tasks for the sub-agent improvements.
> See [design.md](./design.md) for full design details.

## Status as of 2026-05-11

Legend: ✅ done · 🟡 partial · ❌ not started · ⛔ non-goal.

| Phase | Description | Status | Notes |
|-------|-------------|--------|-------|
| Phase 0 | Structural Refactoring | ✅ 6/6 + 🟡 tests | Pipeline split, child engine + drain hook + onProgress all landed |
| Phase 1 | Safety & Correctness | ✅ 3/3 + 🟡 tests | Depth, cancellation, usage retention all landed |
| Phase 2 | Background Execution | 🟡 2/5 (param + tools only) | **`SubAgentRunner.execute()` still always `await`s; notification injection never fires** |
| Phase 3 | Cross-Agent Messaging | ✅ 3/4 (plumbing) | `send_message` + queue + drain wired; end-to-end test blocked on Phase 2 |
| Phase 4 | Custom Types from Config | ✅ 3/3 + 🟡 tests | Config schema, load, merge precedence all landed |

**Remaining critical path:** `2.2 → 2.4 → 2.5 → 3.4 → 1.4 / 0.6 / 4.4`

Land 2.2 + 2.4 together — they are the single change that turns the background path from inert plumbing into a working feature. Everything else is test backfill or non-goal.

---

## Original Overview (preserved for reference)

| Phase | Description | Tasks | Blocked By |
|-------|-------------|-------|------------|
| Phase 0 | Structural Refactoring | 0.1 - 0.6 | — |
| Phase 1 | Safety & Correctness | 1.1 - 1.4 | Phase 0 |
| Phase 2 | Background Execution | 2.1 - 2.5 | Phase 1 |
| Phase 3 | Cross-Agent Messaging | 3.1 - 3.4 | Phase 2 |
| Phase 4 | Custom Types from Config | 4.1 - 4.4 | Phase 0 |

**Original critical path:** `0.1 → 0.2 → 0.3 → 1.1 → 1.2 → 2.1 → 2.2 → 2.4 → 3.1 → 3.3`

---

## Phase 0: Structural Refactoring

| Task | Status | Description | Blocked By |
|------|--------|-------------|------------|
| 0.1 | ✅ | Move sub-agent module to `src/tools/AgentTool/` | — |
| 0.2 | ✅ | Define `IAgentRunner`/`AgentContext` types and split `SubAgentRunner` into `prepare/execute/cleanup` | 0.1 |
| 0.3 | ✅ | Extend engine config for child metadata, lifecycle hooks, drain callbacks | 0.2 |
| 0.4 | ✅ | Add `drainPendingMessages` hook point to `TaskRunner.runLoop()` | 0.3 |
| 0.5 | ✅ | Add optional `onProgress` callback for sub-agent observability | 0.3 |
| 0.6 | 🟡 | Phase 0 regression tests — add explicit drain-noop / onProgress-noop assertions | 0.2, 0.3, 0.4, 0.5 |

### 0.1 Move Module

**Files:** `src/core/subagent/*` → `src/tools/AgentTool/*`

- Move the current sub-agent module under `src/tools/AgentTool/`
- Update all imports in server, desktop, registry, tests, and tool cloning code
- Do this first so every later task points at the final file layout

### 0.2 Define Interfaces and Split `SubAgentRunner`

**Files:** `SubAgentRunner.ts`, `types.ts`

- Define `IAgentRunner` interface with `prepare()`, `execute()`, `cleanup()` contract (design 2.6.1)
- Define `AgentContext` type holding runId, engine, abortController, registry, typeConfig, parentEngine, background flag
- Define `AgentRunResult` type matching current `SubAgentResult` shape
- Refactor `SubAgentRunner` to implement `IAgentRunner`: split `run()` into `prepare()`, `execute()`, and `cleanup()` stages
- Keep behavior identical before adding new features
- Make context explicit so background execution and retention state do not accrete into one method

### 0.3 Extend Engine Config

**Files:** `RepublicAgentEngineConfig.ts`, `RepublicAgentEngine.ts`

- Add child-engine metadata fields such as `depth`, `maxDepth`, and parent linkage
- Add lifecycle hook surface needed for foreground-child cancellation on parent teardown
- Add injected callback support for draining pending child messages between turns

### 0.4 Add Drain Hook

**Files:** `TaskRunner.ts`

- Add an optional `getPendingMessages?: () => string[]` hook
- Drain it after each turn and queue any returned messages into the child's pending-input path

### 0.5 Add `onProgress`

**Files:** `RepublicAgentEngine.ts`, `TaskRunner.ts`, related types

- Add optional progress callback for turn-complete and usage reporting
- Keep the existing `Promise<EngineResult>` API intact

### 0.6 Phase 0 Tests

- Test: refactored runner still produces the same synchronous results as before
- Test: drain hook is a no-op when unset
- Test: progress callback does not affect existing callers

---

## Phase 1: Safety & Correctness

| Task | Status | Description | Blocked By |
|------|--------|-------------|------------|
| 1.1 | ✅ | Recursion depth enforcement | — |
| 1.2 | ✅ | Parent-lifecycle cancellation wiring | — |
| 1.3 | ✅ | Retained token usage summaries | — |
| 1.4 | 🟡 | Phase 1 tests — add the named tests below | 1.1, 1.2, 1.3 |

### 1.1 Recursion Depth Enforcement

**Files:** `RepublicAgentEngineConfig.ts`, `RepublicAgentEngine.ts`, `SubAgentRunner.ts`, `ToolRegistryCloner.ts`

- Add `depth: number` (default 0) and `maxDepth: number` (default 3) to `RepublicAgentEngineConfig`
- Store depth on `RepublicAgentEngine` instance, expose via `getDepth()` and `getMaxDepth()`
- In `createChildEngine()`: set child's `depth = this.depth + 1`, propagate `maxDepth`
- In `SubAgentRunner.run()`: check `parentEngine.getDepth() >= parentEngine.getMaxDepth()` before creating child; return error result if exceeded
- Keep `sub_agent` excluded from child tool registries; depth enforcement is defense-in-depth, not a replacement for the denylist

### 1.2 Parent-Lifecycle Cancellation Wiring

**Files:** `SubAgentRunner.ts`, `RepublicAgentEngine.ts`

- Do not reimplement the existing `params.signal -> engine.run() -> TaskRunner` wiring
- In `SubAgentRunner.prepare()` for foreground agents: create a child `AbortController` linked to both the parent engine's lifecycle and `params.signal`
- Link to parent lifecycle via `parentEngine.onEvent()` — listen for `EngineDisposed` event type and abort the child controller (there is no `onDispose()` method; the engine emits `EngineDisposed` through the existing event listener API which returns an unsubscribe function)
- Link to `params.signal` via `addEventListener('abort', ...)`
- Pass the child signal to `engine.run(input, { signal: childSignal })`
- Store the `onEvent` unsubscribe function in `AgentContext` for cleanup

### 1.3 Retained Token Usage Summaries

**Files:** `SubAgentRegistry.ts`, `SubAgentRunner.ts`, `types.ts`

- Add `SubAgentUsageSummary` interface to `types.ts`
- Add `recordUsage(runId, usage)` and `getUsageSummary()` to `SubAgentRegistry`
- In `SubAgentRunner.run()`: call `registry.recordUsage()` after engine completes
- Store usage data in retained run summaries; do not assume completed runs stay in `activeAgents`

### 1.4 Phase 1 Tests

**Files:** `__tests__/SubAgentRunner.depth.test.ts`, `__tests__/SubAgentRunner.signal.test.ts`

- Test: sub-agent at depth 3 (maxDepth=3) returns error, does not create engine
- Test: sub-agent at depth 2 (maxDepth=3) succeeds
- Test: child tool registry still excludes `sub_agent` even below max depth
- Test: aborting parent signal cancels foreground sub-agent
- Test: aborting params.signal cancels sub-agent
- Test: token usage aggregated across multiple sub-agent runs

---

## Phase 2: Background Execution — THE BLOCKING GAP

| Task | Status | Description | Blocked By |
|------|--------|-------------|------------|
| 2.1 | ✅ | Add `background` flag to SubAgentToolParams | 1.1, 1.2 |
| 2.2 | ❌ | **Background execution in SubAgentRunner — branch on `context.background`, detach, return `BackgroundSubAgentResult`** | 2.1 |
| 2.3 | ✅ | Retained run summaries and management tools | 2.2 |
| 2.4 | ❌ | **Task notification pipeline — call `parentEngine.enqueueSyntheticUserTurn()` from detached-promise handlers with `<task-notification>` XML** | 2.2 |
| 2.5 | ❌ | Phase 2 tests | 2.2, 2.3, 2.4 |

**2.2 and 2.4 land together.** Until both ship, the `background` parameter is parsed and stored but never changes execution semantics; `enqueueSyntheticUserTurn()` exists on the engine but is never invoked; the management tools and pending-message queue have nothing to observe. See `design.md` §1.6 step 1 for the precise code shape.

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

**Files:** new `src/tools/AgentTool/managementTools.ts` or extend `register.ts`, `SubAgentRegistry.ts`

- `list_sub_agents` tool:
  - No parameters
  - Returns JSON array of `{ runId, type, description, status, startTime, durationMs?, tokenUsage?, resultPreview? }` from retained registry summaries
- `cancel_sub_agent` tool:
  - Parameter: `runId: string`
  - Validates agent exists and is running
  - Calls `engine.dispose()` on the target agent
  - Returns `{ success: boolean, message: string }`
- Add retained summary/tombstone entries for completed background runs so `list_sub_agents` can report on them after completion
- Register both tools alongside `sub_agent` in `registerSubAgentTool()`

### 2.4 Task Notification Pipeline

**Files:** `RepublicAgentEngine.ts`, `Session.ts`, `SubAgentRunner.ts`, new `types.ts` additions

- Add `TaskNotification` interface to `types.ts`
- Add `enqueueSyntheticUserTurn(notificationText)` to `RepublicAgentEngine`:
  - Formats notification as XML text
  - Queues it into the parent session's pending-input path
  - Emits a lightweight event for UI/consumers if needed
- In `SubAgentRunner`: attach a `.then()` handler on the background engine's detached promise:
  - On success: call `parentEngine.enqueueSyntheticUserTurn(...)`
  - On failure: call `parentEngine.enqueueSyntheticUserTurn(...)`
  - On cancel: call `parentEngine.enqueueSyntheticUserTurn(...)`
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
- Test: notifications are delivered through pending input, not just appended to history

---

## Phase 3: Cross-Agent Messaging

| Task | Status | Description | Blocked By |
|------|--------|-------------|------------|
| 3.1 | ✅ | Pending message queue in SubAgentRegistry | 2.2 |
| 3.2 | ✅ | `send_message` tool | 3.1 |
| 3.3 | ✅ | Wire drain hook (from 0.4) to SubAgentRegistry for child pending-input delivery | 3.1 |
| 3.4 | ❌ | Phase 3 tests — only meaningful once background runs exist | 3.2, 3.3, 2.2 |

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

### 3.3 Wire Drain Hook to SubAgentRegistry

**Files:** `SubAgentRunner.ts`, `SubAgentRegistry.ts`

- The `drainPendingMessages` hook point in `TaskRunner.runLoop()` already exists from Phase 0.4 — this task wires it up
- In `SubAgentRunner.prepare()`: create a drain callback that calls `registry.drainMessages(runId)` and pass it through engine config to TaskRunner
- Messages returned by the drain callback are queued into the child's pending-input path via `session.addPendingInput()` (the hook in TaskRunner handles this)
- No changes to `TaskRunner.ts` needed — only wiring in SubAgentRunner and the registry drain method

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
| 4.1 | ✅ | Config schema for `subAgentTypes` | — |
| 4.2 | ✅ | Load and validate in registerSubAgentTool() | 4.1 |
| 4.3 | ✅ | Merge precedence logic | 4.2 |
| 4.4 | 🟡 | Phase 4 tests | 4.2, 4.3 |

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

---

## Appendix A — Concrete shape for the 2.2 + 2.4 change

This appendix is what an implementer needs to land the only remaining functional gap. See `design.md` §1.5 and §1.6 for context.

**Files:** `src/tools/AgentTool/SubAgentRunner.ts`, `src/tools/AgentTool/types.ts`, `src/tools/AgentTool/__tests__/`.

### A.1 Branch `run()` on `context.background`

Current `run()` always does `await execute → cleanup` in a `try/finally`. Change it so background runs detach. Keep foreground behavior byte-identical.

```ts
async run(params: SubAgentToolParams): Promise<SubAgentResult | BackgroundSubAgentResult> {
  // ... existing type resolution + early-return error cases unchanged ...

  let context: AgentContext;
  try {
    context = await this.prepare(params, typeConfig);
  } catch (error) { /* unchanged */ }

  if (!context.background) {
    try {
      const result = await this.execute(context, params);
      return this.toSubAgentResult(context, result);
    } finally {
      await this.cleanup(context);
    }
  }

  // Background: detach. Do NOT await execute(); do NOT call cleanup() here.
  void this.execute(context, params)
    .then((result) =>
      context.parentEngine.enqueueSyntheticUserTurn(
        formatTaskNotification(context, params, result),
      ),
    )
    .catch((error) =>
      context.parentEngine.enqueueSyntheticUserTurn(
        formatTaskNotification(context, params, {
          success: false,
          response: '',
          turnCount: 0,
          stopReason: 'error',
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    )
    .finally(() => this.cleanup(context));

  return {
    status: 'launched',
    runId: context.runId,
    type: params.type,
    description: params.description ?? '',
  };
}
```

### A.2 Add `BackgroundSubAgentResult`

```ts
// src/tools/AgentTool/types.ts
export interface BackgroundSubAgentResult {
  status: 'launched';
  runId: string;
  type: string;
  description: string;
}
```

The `sub_agent` tool's result type becomes a discriminated union: foreground returns `SubAgentResult` (existing); background returns `BackgroundSubAgentResult`. The parent LLM should be able to distinguish.

### A.3 Notification formatter

```ts
function formatTaskNotification(
  ctx: AgentContext,
  params: SubAgentToolParams,
  result: AgentRunResult,
): string {
  const durationMs = Date.now() - ctx.startTime;
  return [
    '<task-notification>',
    `  <run-id>${ctx.runId}</run-id>`,
    `  <type>${params.type}</type>`,
    `  <status>${result.success ? 'completed' : result.stopReason === 'cancelled' ? 'cancelled' : 'failed'}</status>`,
    `  <summary>${escapeXml(params.description ?? params.type)}</summary>`,
    result.response ? `  <result>${escapeXml(result.response)}</result>` : '',
    result.error ? `  <error>${escapeXml(result.error)}</error>` : '',
    '  <usage>',
    result.tokenUsage ? `    <total_tokens>${result.tokenUsage.total}</total_tokens>` : '',
    `    <turn_count>${result.turnCount}</turn_count>`,
    `    <duration_ms>${durationMs}</duration_ms>`,
    '  </usage>',
    '</task-notification>',
  ].filter(Boolean).join('\n');
}
```

Match the XML shape to design.md §2.2. Keep escaping minimal but correct (`&`, `<`, `>` at least).

### A.4 Tests to land alongside (covers Phase 2.5 + Phase 3.4)

`__tests__/SubAgentRunner.background.test.ts`:
- background=true returns `{ status: 'launched', runId, ... }` synchronously
- detached run still records token usage in registry on completion
- success path: parent's pending input contains `<task-notification>` with `<status>completed</status>` and token usage
- failure path: notification has `<status>failed</status>` and `<error>` block
- cancellation path: `cancel_sub_agent` aborts the detached run; notification has `<status>cancelled</status>`
- foreground path is unchanged (synchronous result, no notification emitted)
- `cleanup()` runs exactly once for background (in `.finally`), not twice

`__tests__/SubAgentRunner.messaging.test.ts` (Phase 3 end-to-end):
- launch background agent → `send_message(runId, "X")` → assert that the child's next turn sees "X" as user input (via the drain hook → pending input path)
- `send_message` to non-existent runId returns error
- `send_message` to completed agent returns error
- multiple queued messages are joined into one user message at the next drain boundary

### A.5 Small tightening — `approvalPolicy` override for background

The audit flagged this as 🟡. In `SubAgentRunner.prepare()`, where the approval policy is resolved for background runs, ensure that a type with `approvalPolicy: 'inherit'` is **forced** to `'never'` when `background: true`, not silently inherited from the parent. Add a one-liner test that asserts a background `worker` (which inherits by default) ends up with `'never'`.

This is the audit's only finding that survives independently of the 2.2 + 2.4 work.
