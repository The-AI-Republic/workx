# Track 04: Typed Task Families - Tasks

> Scope: ship the `background_agent` typed-task vertical slice **inside PR #191** (`design-sub-agent` -> `agent-improvements`). Each section maps to a section in `design.md`. Out-of-scope items are listed at the bottom.
>
> All file:line references verified against the working tree on 2026-05-13. See `design.md#verified-wiring-reference` for the flat grep table.

## 1. Type Alignment

### 1.1 Status rename (single commit)

The rename `initializing -> pending` and `cancelled -> killed` is 4 + 13 sites (verified). Land as its own commit so reviewers can read the diff cleanly. Touchpoints:

**`initializing` -> `pending`:**
- [ ] `src/core/AgentTask.ts:37` — `private status: TaskStatus = 'initializing'`.
- [ ] `src/core/AgentTask.ts:110` — comparison in `getStatus()` mapping.
- [ ] `src/core/__tests__/AgentTask.test.ts:378` — test assertion.
- [ ] `src/core/__tests__/multi-session.integration.test.ts:184` — integration-test state tracking.

**`cancelled` -> `killed`** (TaskStatus context only — **do NOT** rename `EngineResult.stopReason: 'cancelled' | 'interrupted'` in `RepublicAgentEngineConfig.ts:132`):
- [ ] `src/core/AgentTask.ts:19` — TaskStatus type union.
- [ ] `src/core/AgentTask.ts:86, 99` — assigned on abort and in `cancel()`.
- [ ] `src/core/TaskRunner.ts:30` — `TaskState.status` union.
- [ ] `src/core/TaskRunner.ts:153, 215, 245` — assignments in `cancel()`, aborted outcome, catch block.
- [ ] `src/core/__tests__/AgentTask.test.ts:296, 302, 334, 335, 407, 411` — test assertions.
- [ ] `src/core/__tests__/TaskRunner.test.ts:177, 499` — test assertions.

**Rollout reader compatibility:**
- [ ] If any persistence path serializes old strings, add a one-time read-side mapping (`'initializing' -> 'pending'`, `'cancelled' -> 'killed'`). Audit `src/core/__tests__/multi-session.integration.test.ts` for rollout state shape; if persistence does not include `TaskStatus`, skip this item.

### 1.2 Type Model (new file: `src/core/tasks/types.ts`)

- [ ] Define `TaskType = 'background_agent'` (single family for v1).
- [ ] Define `TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'`.
- [ ] Implement `isTerminalTaskStatus(status)`.
- [ ] **(Q4)** Define canonical `TaskTokenUsage = { input: number; output: number; cached?: number; total: number }`.
- [ ] Define `TaskStateBase` with `id`, `type`, `status`, `description`, `toolUseId?`, `startTime`, `endTime?`, `outputOffset`, `notified`, `isBackgrounded`, `retain` (UI hold), `evictAfter?` (deadline timestamp), `lastReadAt?` (poller heartbeat).
- [ ] Define `BackgroundAgentTaskState extends TaskStateBase` with: `runId` (joins back to `SubAgentRegistry`; equals `id` for v1), `parentSessionId`, `prompt`, `lastAgentMessage?`, `toolUseCount`, `tokenUsage: TaskTokenUsage`.
- [ ] **(Q5)** **Do NOT** add `pendingMessages: string[]` to `BackgroundAgentTaskState`. Queue stays on `SubAgentRegistry.pendingMessages` where it's already wired.
- [ ] Export `TaskState = BackgroundAgentTaskState` (union; grows in Phase 2).
- [ ] Implement Web-Crypto-based `generateTaskId('background_agent')` returning `a${8-char base36}`.
- [ ] Add type guard `isBackgroundAgentTask(t)`.
- [ ] Identity collapse: `runId === id` for `background_agent` tasks (matches BrowserX's existing convention in `SubAgentRegistry.register` and claudy's `LocalAgentTask.tsx:483, 487, 491`).

### 1.2b TaskRunner token-usage rename (Q4)

Part of the same status-rename commit:

- [ ] `src/core/TaskRunner.ts:28–44` — rename `TaskState.tokenUsage: { used: number; max: number }` to `TaskState.tokenBudget: { used: number; max: number; compactionThreshold: number }`.
- [ ] Update all assignments in `TaskRunner` that touch `tokenUsage` (lines 137–139, 210–212, 342–344) to write `tokenBudget` instead.
- [ ] `TaskRunner.TaskState.tokenUsageDetail` — change inner type from `TokenUsage` to `TaskTokenUsage`.
- [ ] `src/tools/AgentTool/types.ts:166–176` — `TaskNotification.tokenUsage` already shaped as `{ input, output, total }`; change type annotation to `TaskTokenUsage` for consistency.
- [ ] Update tests that reference `TaskState.tokenUsage` to use `TaskState.tokenBudget`.

### 1.3 Timing constants (new file: `src/core/tasks/timing.ts`)

- [ ] Export `POLL_INTERVAL_MS = 1_000`, `STOPPED_DISPLAY_MS = 3_000`, `PANEL_GRACE_MS = 30_000`, `EVICTION_GRACE_MS = 5_000`, `TASK_OUTPUT_PER_TASK_CAP_BYTES = 50 * 1024 * 1024`.
- [ ] Values match claudy verbatim (claudy's are in `utils/task/framework.ts:24–28`).

## 2. Storage

### 2.1 Modify: `src/storage/StorageAdapter.ts`

- [ ] Add `task_output_chunks: 'chunkId'` to `STORE_KEY_PATHS` (lines 17–28).
- [ ] Add `task_output_chunks` to `VALID_STORE_NAMES` (line 34).

### 2.2 Modify: `src/storage/IndexedDBAdapter.ts`

- [ ] Bump `DB_VERSION` from 4 to 5 (line 24).
- [ ] In `onupgradeneeded` (lines 166–269+), add a Version 5 branch that creates `task_output_chunks` object store with `keyPath: 'chunkId'`.
- [ ] Create indexes: `taskId`, `[taskId, seq]`, `createdAt`.

### 2.3 Modify: `src/server/storage/NodeSQLiteAdapter.ts`

- [ ] Add to `CREATE TABLE` block (lines 63–70 follow the generic `(key, value, created_at, updated_at)` pattern; `task_output_chunks` needs a custom shape):
  ```sql
  CREATE TABLE IF NOT EXISTS task_output_chunks (
    chunk_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  )
  ```
- [ ] Add `CREATE INDEX` for `task_id`, `(task_id, seq)`, `created_at` (lines 73–86 show the existing JSON-extract index pattern; these are non-JSON columns).

### 2.4 Modify: `src/desktop/storage/TauriSQLiteAdapter.ts`

- [ ] Coordinate the corresponding Rust-side migration in the desktop sidecar. **This is the only Rust change in PR #191 — flag in PR description.**
- [ ] Verify the generic collection passthrough accepts `task_output_chunks`.

### 2.5 New file: `src/core/tasks/TaskOutputStore.ts`

- [ ] Define `TaskOutputChunk` (`chunkId`, `taskId`, `seq`, `createdAt`, `kind`, `data`).
- [ ] Implement `appendChunk(taskId, kind, data)` — split data >64 KiB into multiple consecutive `seq` rows; assign next `seq` per task; track per-task `lastSeq` counter in memory.
- [ ] Implement `getDelta(taskId, fromSeq = 0)` — IndexedDB cursor / SQLite `WHERE task_id = ? AND seq > ? ORDER BY seq`. Update `lastReadAt: Map<taskId, number>` on every call.
- [ ] Implement `streamDelta(taskId, fromSeq, intervalMs = POLL_INTERVAL_MS)` as an async iterable atop polling.
- [ ] Implement `cleanupTask(taskId)` and `cleanupSession(sessionId)`.
- [ ] Implement `flush(taskId)` — drain in-memory write queue immediately (used by `TaskRunner.run_task` catch block).
- [ ] Internal: per-task in-memory write queue with splice-on-drain semantics.

### 2.6 Tests

- [ ] `src/core/tasks/__tests__/types.test.ts` — `isTerminalTaskStatus` truth table; ID format (`a` prefix + 8 base36); type guards.
- [ ] `src/core/tasks/__tests__/TaskOutputStore.test.ts` — chunk splitting at 64 KiB; `getDelta` from offset; multi-writer ordering; `flush` drains the queue; `cleanupTask` removes all rows for a taskId.
- [ ] Extend `src/storage/__tests__/IndexedDBAdapter.test.ts` and `src/server/storage/__tests__/NodeSQLiteAdapter.test.ts` to cover the new store + range queries on `[taskId, seq]`.

## 3. Quota

### 3.1 New file: `src/core/tasks/TaskOutputManager.ts`

- [ ] Implement `evictOldestChunks(targetBytes): Promise<number>` — order by `(createdAt, taskId, seq)`; `batchDelete` until target reached; return bytes freed.
- [ ] Eviction skip rule: skip chunks belonging to a task where:
  - `notified === false` (parent hasn't seen any output yet — evicting silently loses data), OR
  - `lastReadAt > Date.now() - EVICTION_GRACE_MS` AND `status` is non-terminal (a poller just touched these chunks).

### 3.2 Modify: `src/storage/StorageQuotaManager.ts`

**Current state**: threshold-only (`warningThreshold = 80`, `criticalThreshold = 95`). No tier concept exists.

**(Q8) Add constructor-injected `tieredEvictor`:**

- [ ] Introduce `interface TieredEvictor { evictTier(tier: 0 | 1 | 2, target: number): Promise<number> }`.
- [ ] Add `tieredEvictor?: TieredEvictor` as a constructor option.
- [ ] In the existing quota-monitor loop, when usage crosses `criticalThreshold` AND `tieredEvictor` is set, call `tieredEvictor.evictTier(0, bytesNeeded)`. If under-fills, escalate to `evictTier(1, remaining)`.
- [ ] Without `tieredEvictor`: behavior is identical to today (monitor warns, no automatic action). Constructor stays backward-compatible for tests / non-extension contexts.
- [ ] **Do NOT** make `StorageQuotaManager` aware of `TaskOutputManager` or any specific store. Tier knowledge lives in the injected `tieredEvictor` impl.

### 3.3 Wire concrete `TieredEvictor` at service-worker startup

- [ ] In the service-worker startup path (`src/extension/background/service-worker.ts`), construct:
  ```ts
  const tieredEvictor: TieredEvictor = {
    async evictTier(tier, target) {
      if (tier === 0) return taskOutputManager.evictOldestChunks(target);
      if (tier === 1) return cacheManager.evictExpiredAndLeastUsed(target);
      return 0;  // tier 2 is never auto-evicted
    }
  };
  const quotaManager = new StorageQuotaManager({ tieredEvictor, /* thresholds */ });
  ```
- [ ] Tier 0 = `task_output_chunks` via `TaskOutputManager`. Tier 1 = `cache_items`. Tier 2 = anything else (rollouts, sessions, config — never auto-evict).

### 3.3 Tests

- [ ] `src/storage/__tests__/StorageQuotaManager.task-output-eviction.test.ts` — fill with chunks across multiple tasks; trigger 95% cleanup; assert oldest evicted first; assert eviction-grace skip works; assert tier escalation when tier 0 underfills.

## 4. Concurrency Seam

### 4.1 Modify: `src/core/Session.ts`

**Verified shape of current `spawnTask` (lines 1332–1394):** abort-all at line 1339, `new AbortController()` at 1342, hooks at 1345–1351, task wrap at 1355–1378, `RunningTask` build at 1381–1387 (shape: `{ kind, abortController, task, promise, startTime }` from `src/core/session/state/types.ts:23–38`), `registerNewActiveTask` at 1390.

**(Q1) Extend `RunningTask` shape** in `src/core/session/state/types.ts:23–38` to carry typed state side-by-side:
- [ ] Add `taskState?: BackgroundAgentTaskState` field.
- [ ] Add `context?: AgentContext` field (present for `background_agent` tasks).
- [ ] **(Q9)** Add `scopedTabIds?: number[]` field — records which tabs the task actively uses.

**Session changes:**
- [ ] Add `private activeTasks: Map<string, RunningTask> = new Map()`.
- [ ] Add `private foregroundTaskId: string | null = null`.
- [ ] Add `private evictionTimerId: ReturnType<typeof setInterval> | null = null`.
- [ ] In `spawnTask` (lines 1332–1394): **REMOVE** `await this.abortAllTasks('UserInterrupt')` at line 1339.
- [ ] **(Q9)** Update `spawnTask` signature to `opts: { background?: boolean; scopedTabIds?: number[] } = {}`. Pass `scopedTabIds` into the constructed `RunningTask`.
- [ ] Foreground branch: if `foregroundTaskId` is set, `await this.abortTask(this.foregroundTaskId, 'UserInterrupt')` first; then set `foregroundTaskId = subId`.
- [ ] Background branch: do not touch `foregroundTaskId`; do not abort siblings.
- [ ] Insert created `RunningTask` into `this.activeTasks` (alongside existing `registerNewActiveTask` at line 1390).
- [ ] **(Q2)** Add `registerTaskState(state: BackgroundAgentTaskState, bits: { context: AgentContext; scopedTabIds?: number[] }): void` — looks up the `RunningTask` by `state.id`, sets `taskState`, `context`, `scopedTabIds`. Called by `SubAgentRunner.prepare` after building the typed state.
- [ ] Add `abortTask(id, reason)` — looks up in `activeTasks`, calls `handleTaskAbort` (existing internal used by `abortAllTasks`), removes from map, clears `foregroundTaskId` if it matches.
- [ ] **(Q9)** Add `abortTasksForTab(tabId, reason): Promise<void>` — walks `activeTasks`, aborts only those where `scopedTabIds?.includes(tabId)`.
- [ ] Add `listActiveTasks(): RunningTask[]` (internal full records).
- [ ] Add `listTaskStates(): TaskState[]` — projects `taskState` halves, filters undefined (foreground without state).
- [ ] Add `getTask(id): RunningTask | undefined`.
- [ ] **(Q10)** Add `retainTask(id, retain: boolean): void` — flips `taskState.retain`; re-arms `evictAfter = Date.now() + PANEL_GRACE_MS` when retain flips false on a terminal task; clears `evictAfter` when retain flips true. Called by UI panel mount/unmount.
- [ ] Update `onTaskFinished()` (lines 1312–1319) and `onTaskAborted()` (lines 1845–1871) to also remove from `activeTasks` and clear `foregroundTaskId` if matching.
- [ ] Keep `abortAllTasks` (lines 1288–1300) unchanged as a backward-compat shim for hard-shutdown paths.

### 4.2 `handleTaskAbort` per-task implementation

The existing `handleTaskAbort` is private and walked-over by `abortAllTasks`. For the per-task path, the ordering must be exact (steps numbered as in design.md):

- [ ] **(Q7) Step 1 — resolve pending approvals with `'denied'`**: look up `ActiveTurn.pendingApprovals` entries belonging to `subId`; call each resolver with `{ decision: 'denied', reason: 'task aborted' }`. The awaiting tool call sees the denial and unwinds; do NOT just dismiss — that leaves the awaiter hanging.
- [ ] **(Q7) Step 2 — drop pending input** if the aborted task is foreground: clear `ActiveTurn.pendingInput`.
- [ ] **(Q5) Step 3 — set `context.cancelled = true`** if `t.context` is present (i.e., a `background_agent`) — **before** calling abort. Matches `cancel_sub_agent` ordering at `managementTools.ts:110`; suppresses the misleading task-notification from `SubAgentRunner.ts:127`.
- [ ] **Step 4** — call `t.abortController.abort(reason)`.
- [ ] **Step 5** — await `t.promise.catch(() => {})` so cleanup completes.
- [ ] **Step 6** — emit `TurnAborted` event; update `t.taskState.status = 'killed'`, set `endTime` and `evictAfter` (unless `retain === true`).
- [ ] **Step 7** — call `ActiveTurn.removeTask(subId)` and clear `this.activeTurn` if empty (mirrors today's `onTaskAborted` at `Session.ts:1845–1871`).
- [ ] **Step 8** — do NOT call `taskOutputStore.cleanupTask` here. The eviction timer (section 4.4) handles it once the grace period expires. Cleaning up immediately would prevent reload-recovery / late-poller reads.

### 4.3 Other call-site updates (verified locations)

- [ ] `src/core/Session.ts:1403` (`interruptTask`, body 1402–1404): rewrite to kill only the foreground task — `if (this.foregroundTaskId) await this.abortTask(this.foregroundTaskId, 'UserInterrupt')`. Background tasks must keep running.
- [ ] `src/core/RepublicAgent.ts:699` (`handleInterrupt`): same narrow-to-foreground pattern.
- [ ] `src/core/services/agent-services.ts:84`: review per call path; likely the same narrow pattern as `handleInterrupt`.

### 4.3b Tab-close handler (Q9)

- [ ] `src/extension/background/service-worker.ts:128` (tab closed → `'TabClosed'`): replace blanket `abortAllTasks` with **switch on tab role**:
  - If `tabId === agentSession.uiTabId` (the chat panel itself is closing) → still call `abortAllTasks('TabClosed')`.
  - Otherwise (a working tab is closing) → call `session.abortTasksForTab(tabId, 'TabClosed')`.
- [ ] `AgentSession` needs a way to know its `uiTabId`. Add `private uiTabId: number | undefined` populated when the chat panel registers/opens. (Find the existing chat-panel-startup handler and have it call `agentSession.setUiTabId(tabId)`.)
- [ ] Each spawn that has `browserContext.tabId` populates `RunningTask.scopedTabIds` so `abortTasksForTab` matches correctly. Most sub-agents inherit `browserContext` from `RepublicAgentEngineConfig`; verify spawn paths populate it.
- [ ] `src/extension/background/service-worker.ts:601` (user interrupt): leave to PR-time decision; likely converts to foreground-only abort the same way `handleInterrupt` does.

### 4.4 Eviction timer

- [ ] Add `private evictionTimerId: ReturnType<typeof setInterval> | null = null` to `Session`.
- [ ] Lazily start the timer when the first task transitions to terminal; tick every `STOPPED_DISPLAY_MS = 3_000`.
- [ ] Per tick, for each terminal task in `activeTasks`:
  1. Skip if `!task.notified`.
  2. Skip if `task.retain === true`.
  3. Skip if `Date.now() < task.evictAfter`.
  4. Else: `taskOutputStore.cleanupTask(taskId)` → `activeTasks.delete(taskId)` → `SubAgentRegistry.unregister(runId)`.
- [ ] Stop the timer when `activeTasks` has zero terminal entries.
- [ ] On `Session.dispose`, call `taskOutputStore.cleanupSession(sessionId)` unconditionally (eviction-grace is irrelevant on hard shutdown).

### 4.5 `notified` flag wiring

- [ ] **Foreground tasks** (`isBackgrounded === false`): set `notified = true` immediately on terminal transition — the result is the tool's return value, no async notification needed.
- [ ] **Background tasks** (`isBackgrounded === true`): set `notified = true` inside `safeEnqueueNotification` (`SubAgentRunner.ts:178–194`) after `enqueueSyntheticUserTurn(text)` returns successfully.

### 4.6 Tests

- [ ] `src/core/__tests__/Session.concurrency-seam.test.ts` — spawn 1 foreground + 2 background; user interrupt; assert only foreground transitions to `killed`, both background remain `running`.
- [ ] `src/core/__tests__/Session.spawn-replacement.test.ts` — spawn foreground A, then foreground B; assert A is `killed` and B is `running`; assert pending approval on A resolved with `denied`; assert A's pending input dropped.
- [ ] `src/core/__tests__/Session.background-isolation.test.ts` — spawn 3 background tasks; abort one by id; assert the other two still `running`; assert the aborted one did **not** enqueue a task-notification (because `context.cancelled` was set).
- [ ] `src/core/__tests__/Session.eviction.test.ts` — terminate a task; assert eviction holds until `evictAfter` AND `notified === true`; assert `retain = true` blocks eviction indefinitely; assert `retainTask(id, false)` re-arms `evictAfter`.
- [ ] **(Q7)** `src/core/__tests__/Session.handle-task-abort.test.ts` — verify ordering: pending approval resolved with `'denied'` *before* abortController.abort() fires; pending input cleared for foreground; `context.cancelled = true` set before abort for background_agent tasks.
- [ ] **(Q9)** `src/core/__tests__/Session.tab-close-granularity.test.ts` — spawn 2 tasks (one with `scopedTabIds: [42]`, one with `scopedTabIds: [99]`); call `abortTasksForTab(42, 'TabClosed')`; assert only the first is killed.
- [ ] **(Q9)** `src/extension/background/__tests__/service-worker.tab-close.test.ts` — simulate `chrome.tabs.onRemoved` for a working tab vs the chat-panel tab; assert working-tab close calls `abortTasksForTab`, chat-panel close calls `abortAllTasks`.

## 5. Engine API

### 5.1 Modify: `src/core/engine/RepublicAgentEngine.ts`

- [ ] Add `async getTaskOutput(taskId: string, fromSeq = 0): Promise<TaskOutputChunk[]>` — wraps `TaskOutputStore.getDelta`.
- [ ] Add `listTaskStates(): TaskState[]` — projects `session.activeTasks` plus terminal-but-unevicted entries.
- [ ] Add `async retainTask(taskId: string, retain: boolean): Promise<void>` — forwards to `Session`; mutates the `RunningTask.retain` flag and re-arms `evictAfter` (`= Date.now() + PANEL_GRACE_MS` when retain flips false).

### 5.2 Modify: `src/core/engine/RepublicAgentEngineConfig.ts`

- [ ] Add optional `taskOutputStore?: TaskOutputStore` field (sibling to `drainPendingMessages` at lines 103–106).

### 5.3 Modify: `src/core/events/SubAgentEventRouter.ts`

The router is at `src/core/events/SubAgentEventRouter.ts:6–46`. Default-suppressed list is at lines 18–21 (`['AgentMessageDelta', 'AgentReasoningDelta']`).

- [ ] Add four new event types to `EventMsg` union at `src/core/protocol/events.ts:28–115+`:
  - `TaskStarted { taskId, type, description, startTime }`
  - `TaskOutputDelta { taskId, fromSeq, toSeq, kindCounts }` (metadata only — chunk payload stays in store)
  - `TaskStateChanged { taskId, prevStatus, status }`
  - `TaskTerminated { taskId, status, endTime, durationMs, summary? }`
- [ ] Extend the default-suppressed list in `SubAgentEventRouter` constructor (lines 18–21) to include `'TaskOutputDelta'`. Mirrors existing Delta suppression so the foreground UI stays quiet unless a panel actively subscribes.

## 6. TaskRunner Wiring

`TaskRunner.runLoop` is at `src/core/TaskRunner.ts:267–393`. Existing anchors verified by line number:

### 6.1 Modify: `src/core/TaskRunner.ts`

**TaskOptions extension (lines 59–68):**
- [ ] Add `taskOutputStore?: TaskOutputStore` and `taskId?: string` to `TaskOptions` (next to existing `drainPendingMessages` at line 67 — note: `drainPendingMessages` is already wired today; this is purely additive).

**Chunk emission in `runLoop`:**
- [ ] Line 276 (top-of-loop abort check): if aborted, `await this.options.taskOutputStore?.flush(this.options.taskId)` before returning aborted outcome.
- [ ] Line 318 (pre-request compaction trigger): `appendChunk(taskId, 'event', JSON.stringify({ kind: 'compaction', turn: turnCount }))`.
- [ ] Line 339 (after `processTurnResult`): `appendChunk(taskId, 'event', JSON.stringify({ kind: 'turn', index: turnCount, tokens: lastTokenUsage }))`; if `processResult.lastAgentMessage`, also `appendChunk(taskId, 'message', processResult.lastAgentMessage)`.
- [ ] Line 350 (post-turn compaction trigger): same emission as line 318.
- [ ] Line 357 (task-complete branch): final `flush`, then `appendChunk(taskId, 'event', JSON.stringify({ kind: 'complete' }))`.

**run_task catch block (lines 244–253):**
- [ ] Before re-throwing, `if (this.options.taskOutputStore && this.options.taskId) await this.options.taskOutputStore.flush(this.options.taskId)` so polling consumers see the tail of a task that died mid-turn.

### 6.2 Modify: `src/core/AgentTask.ts`

- [ ] Plumb `taskOutputStore` from engine config through to `TaskRunner.run()` (the existing wiring is at `AgentTask.ts:72–92`).

### 6.3 Modify: `src/tools/AgentTool/SubAgentRunner.ts`

- [ ] **(Q2)** After building `AgentContext` in `prepare` (lines 205–349) and before the existing `registry.register(...)` call (lines 314–328), construct the `BackgroundAgentTaskState`:
  ```ts
  const taskState: BackgroundAgentTaskState = {
    id: runId,
    type: 'background_agent',
    status: 'pending',
    description: params.description ?? params.type,
    startTime: Date.now(),
    outputOffset: 0,
    notified: false,
    isBackgrounded: params.background ?? false,
    retain: false,
    runId,
    parentSessionId,
    prompt: params.prompt,
    toolUseCount: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
  };
  parentEngine.getSession().registerTaskState(taskState, {
    context,
    scopedTabIds: params.browserContext?.tabId ? [params.browserContext.tabId] : undefined,
  });
  ```
- [ ] **(Q3)** When constructing the child engine via `parentEngine.createChildEngine(...)` at lines 251–261: pass `taskOutputStore: parentEngine.getTaskOutputStore()` through so the background sub-agent's `TaskRunner` writes chunks. Foreground's `RegularTask` will pass `undefined`.
- [ ] **(Q1)** When the background IIFE finishes (lines 125–129), update `taskState.status` to terminal via the existing `SubAgentRegistry.updateStatus(runId, ...)` *and* mirror the status onto `taskState.status` so the typed-state record reflects reality. Also populate `taskState.lastAgentMessage`, `tokenUsage`, `toolUseCount`, `endTime`.
- [ ] **(Q4)** When formatting `TaskNotification` (line 559–583), build `tokenUsage` as `TaskTokenUsage` (input/output/cached?/total).
- [ ] **(Q6)** The detached IIFE doesn't need to return anything — the synchronous `return { kind: 'background', ... }` at line 164–171 already satisfies the SessionTask layer because background tasks resolve `promise` to `null` immediately via the wrapper described in section 6.4 below.

### 6.4 Background task → SessionTask wiring (Q6)

The path `Session.spawnTask` → `RegularTask.run` → `AgentTask.run` returns `Promise<string | null>`. For background sub-agents we need the `RunningTask.promise` to resolve to `null` immediately at launch, not after the sub-agent finishes.

- [ ] When SubAgentRunner's `run` returns a `BackgroundSubAgentResult` (`{ kind: 'background', ... }`), the **calling tool handler** (the Agent tool's execute path) must NOT await the background completion. The detached IIFE already runs separately. The tool handler returns immediately to the parent TaskRunner with a string indicating the launch ("Spawned background task X. Will notify on completion.").
- [ ] No change to `SessionTask.run()` signature. Background tasks' `promise` resolves with the launch-confirmation string; chunks + notification carry the actual result. This matches the `BackgroundSubAgentResult` already returned today.
- [ ] Document this contract at `src/core/tasks/SessionTask.ts:30` (the JSDoc on `run()` return value): "For background tasks, resolves immediately with a launch confirmation; actual output flows through TaskOutputStore + task-notification."

## 7. Notification Format Reconciliation

Existing notification format in BrowserX (`SubAgentRunner.ts:602–624`) uses `<run-id>` and is already in production behavior. Decision: keep `<run-id>` as the `TaskStateBase.id` (i.e., `runId === taskId`); add an optional `<output-offset>` element.

### 7.1 Modify: `src/tools/AgentTool/types.ts`

- [ ] Add optional `outputOffset?: number` to `TaskNotification` interface (lines 166–176).

### 7.2 Modify: `src/tools/AgentTool/SubAgentRunner.ts`

- [ ] In `formatTaskNotification` (lines 559–583): pass through `outputOffset` from the task's `lastSeq` (read from `taskOutputStore` per task) — set only when the task actually wrote chunks.
- [ ] In `serializeTaskNotification` (lines 602–624): emit `<output-offset>{n.outputOffset}</output-offset>` between `<usage>` and the closing tag, omit entirely if undefined.

### 7.3 Tests

- [ ] `src/tools/AgentTool/__tests__/SubAgentRunner.notification-format.test.ts` — assert `<run-id>` is preserved; assert `<output-offset>` appears when set, is absent otherwise.

## 8. UI

### 8.1 New file: `src/webfront/stores/backgroundTaskStore.ts`

- [ ] Svelte writable store: `{ tasks: Record<runId, TaskState>, outputs: Record<runId, TaskOutputChunk[]> }`.
- [ ] Polls `engine.listTaskStates()` at `POLL_INTERVAL_MS = 1000` for the task list.
- [ ] Subscribes to `TaskStateChanged` / `TaskTerminated` via the existing `ThreadEventRouter` (`src/webfront/routing/`) for the cheap delta path.
- [ ] Output chunks per task are filled lazily by `BackgroundTaskPanel` on mount (not eagerly — chunks can be large).

### 8.2 New file: `src/webfront/lib/hooks/usePolledTaskOutput.ts`

- [ ] Svelte store factory: `(runId: string) => Readable<{ chunks, status, error, lastSeq }>`.
- [ ] Internally manages the polling interval against `engine.getTaskOutput(runId, lastSeq)`.
- [ ] Cancels the interval on unsubscribe.

### 8.3 New file: `src/webfront/components/BackgroundTasksBadge.svelte`

- [ ] Subscribes to `backgroundTaskStore`.
- [ ] Renders count + dropdown of background tasks with status pill.
- [ ] Filter matches `isBackgroundTask` semantics: `(status === 'running' || status === 'pending') && isBackgrounded !== false`, plus terminal-but-unevicted (still inside `PANEL_GRACE_MS`).
- [ ] **(Q10) Mount point**: in the existing top-bar component of the chat page (`src/webfront/pages/chat/...`), next to the title / model-selector area. NOT the global app shell (background tasks are conversation-scoped). NOT the message input area (too cramped). Follow the existing model-selector pill's layout pattern.

### 8.4 New file: `src/webfront/components/BackgroundTaskPanel.svelte`

- [ ] Opens for a `runId`; renders chunks newest-first with `kind` styling (`stdout` / `stderr` / `event` / `message`).
- [ ] **`onMount`**: call `engine.retainTask(runId, true)` so eviction is blocked while the user is looking.
- [ ] **`onDestroy`**: call `engine.retainTask(runId, false)` so eviction re-arms.
- [ ] Auto-hides `STOPPED_DISPLAY_MS = 3000` after terminal status; evicts from UI list after `PANEL_GRACE_MS = 30000`.

### 8.5 Event routing wiring

- [ ] Extend `ThreadEventRouter` to handle the four new event types (`TaskStarted`, `TaskOutputDelta`, `TaskStateChanged`, `TaskTerminated`) and dispatch into `backgroundTaskStore`.

## 9. Tests (consolidated checklist — referenced from sections above)

- [ ] `src/core/tasks/__tests__/types.test.ts`
- [ ] `src/core/tasks/__tests__/TaskOutputStore.test.ts`
- [ ] `src/storage/__tests__/IndexedDBAdapter.test.ts` (extend)
- [ ] `src/server/storage/__tests__/NodeSQLiteAdapter.test.ts` (extend)
- [ ] `src/storage/__tests__/StorageQuotaManager.task-output-eviction.test.ts`
- [ ] `src/core/__tests__/Session.concurrency-seam.test.ts`
- [ ] `src/core/__tests__/Session.spawn-replacement.test.ts`
- [ ] `src/core/__tests__/Session.background-isolation.test.ts`
- [ ] `src/core/__tests__/Session.eviction.test.ts`
- [ ] `src/tools/AgentTool/__tests__/SubAgentRunner.notification-format.test.ts`
- [ ] `src/core/engine/__tests__/RepublicAgentEngine.background-task.integration.test.ts`

## 10. Migration / Cleanup

- [ ] Audit any references to `RegularTask` that are no longer reachable once background-agent state lives in `Session.activeTasks`; do **not** delete `RegularTask` itself — it remains the foreground default.
- [ ] Document explicitly **not** touched (other tracks): the `TaskRegistry` extraction (deferred until a second family lands), `AgentTask.injectUserInput` real implementation, scheduler-triggered spawning.
- [ ] PR description must call out:
  - The Rust migration in `TauriSQLiteAdapter`.
  - The `DB_VERSION` bump (4 → 5) for IndexedDB.
  - The TaskStatus rename (`initializing → pending`, `cancelled → killed`).
  - The behavior change: foreground turns no longer abort background tasks.

## 11. Implementation Sequence (suggested commits inside PR #191)

1. **Status rename + token-usage rename** (Q4) — TaskStatus literals + `TaskState.tokenUsage → tokenBudget`. Standalone commit; easy to review.
2. **Add `src/core/tasks/types.ts`** (Q4: `TaskTokenUsage`) + `timing.ts` (no consumers yet — pure additions).
3. **Storage layer**: `StorageAdapter` + IndexedDB (DB_VERSION → 5) + NodeSQLite + Tauri Rust migration + `TaskOutputStore` + unit tests.
4. **Quota tier extension** (Q8): `StorageQuotaManager` constructor-injected `tieredEvictor` + `TaskOutputManager` + service-worker startup wiring + tests.
5. **`RunningTask` shape extension** (Q1): add `taskState`, `context`, `scopedTabIds` fields to `src/core/session/state/types.ts:23–38`. Pure type addition, no behavior change.
6. **Concurrency seam** (Q1, Q2, Q5, Q7): `Session.activeTasks`, `foregroundTaskId`, `abortTask`, `registerTaskState`, `retainTask`, `handleTaskAbort` with full Q7 ordering (approvals→deny, input→drop, context.cancelled, abort, await, terminal-state update, ActiveTurn cleanup), eviction timer, narrow `handleInterrupt`/`interruptTask` to foreground-only; tests.
7. **Tab-close granularity** (Q9): `Session.abortTasksForTab`, `AgentSession.uiTabId`, service-worker switch on tab role; tests.
8. **Engine API**: `getTaskOutput`, `listTaskStates`, `retainTask` + four new event types via `SubAgentEventRouter`.
9. **TaskRunner wiring** (Q3): chunk emission at the 5 anchors + on-abort flush. Foreground path passes `taskOutputStore: undefined`; background path inherits from parent engine.
10. **SubAgentRunner** (Q2, Q6): `prepare` builds `BackgroundAgentTaskState` and calls `Session.registerTaskState`; pass `taskOutputStore` through `createChildEngine`; document the `null`-on-launch contract for background `SessionTask.run()`.
11. **Notification format**: add `<output-offset>`; preserve `<run-id>`; use `TaskTokenUsage` shape.
12. **UI** (Q10): `backgroundTaskStore` + badge mounted in chat top-bar + panel + `usePolledTaskOutput` + `ThreadEventRouter` extension.
13. **Final integration test sweep**: `RepublicAgentEngine.background-task.integration.test.ts`.

## Later Follow-Ups (Phase 2, NOT in PR #191)

- [ ] Implement real executors for `browser_automation`, `tab_watcher`, `data_extraction`.
- [ ] Extract `TaskRegistry` once a second family exists.
- [ ] Implement real `AgentTask.injectUserInput()` and drain `pendingMessages` between tool rounds in `TurnManager.executeToolCall()`.
- [ ] Service-worker restart recovery for in-flight background tasks.
- [ ] Cross-task `SendMessage` coordination (Track 06).
- [ ] Reconsider whether `<task-notification>` should additionally carry claudy-style `<tool-use-id>` for richer parent-side correlation.
