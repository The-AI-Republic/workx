# Track 04: Typed Task Families

## Readiness

This track is implementation-ready as a **single vertical slice** that ships in PR #191 (`design-sub-agent` -> `agent-improvements`).

PR #191 already lands the engine, sub-agent runner, registry, and event-routing scaffolding (see "What PR #191 already provides" below). The work remaining for Track 04 is the **typed-task layer** sitting on top of that scaffolding plus the **`Session.spawnTask` concurrency-seam fix** so background sub-agent tasks can run concurrently. Other task families (`browser_automation`, `tab_watcher`, `data_extraction`) are deferred to Phase 2; they remain as typed placeholders only.

## PR #191 Finishing Checklist

To make Track 04 mergeable inside PR #191, the following must land in this PR (each item maps to a section below):

- [ ] Add `TaskType` discriminated union, `TaskStateBase`, and `BackgroundAgentTaskState` (see [Type Model](#type-model)). Status enum unified to `pending|running|completed|failed|killed`.
- [ ] Add `TaskOutputStore` (chunked, indexed by `taskId`) wired through all three storage adapters and `STORE_KEY_PATHS` (see [TaskOutputStore](#taskoutputstore-storage-layer)).
- [ ] Add `Session.activeTasks: Map<string, RunningTask>` and `foregroundTaskId: string | null`; **remove** the unconditional `abortAllTasks('UserInterrupt')` call from `Session.spawnTask` (`src/core/Session.ts:1323`) (see [Concurrency Seam](#concurrency-seam-patch)).
- [ ] Add per-task abort/list/get methods on `Session`: `abortTask(id)`, `listActiveTasks()`, `getTask(id)`.
- [ ] Wire `TaskRunner` (`src/core/TaskRunner.ts`) to emit chunks into `TaskOutputStore` at each turn boundary and on abort flush.
- [ ] Add `getTaskOutput(runId, fromOffset?)` and `listTaskStates()` polling APIs on `RepublicAgentEngine` (`src/core/engine/RepublicAgentEngine.ts`).
- [ ] Add UI surface (background-tasks badge + panel) consuming the polling API in `src/webfront/`.
- [ ] Tests covering: concurrent spawn, output persistence + delta polling, kill-one-without-killing-others, quota eviction tier 0 (see [Test Plan](#test-plan)).

Anything outside this list is explicitly Phase 2 (see [Out of Scope for PR #191](#out-of-scope-for-pr-191)).

## What PR #191 Already Provides

PR #191 (`origin/design-sub-agent`) already exposes the scaffolding Track 04 builds on. Track 04 must **not** rewrite these; it extends them.

| File | Already exposes | Open for Track 04 |
|---|---|---|
| `src/core/AgentTask.ts` | `TaskStatus = initializing\|running\|completed\|failed\|cancelled`; `TokenBudget`; `AgentTask` class with `run()`, `cancel()`, `submissionId` | needs typed-state union + output-persistence wiring |
| `src/core/TaskRunner.ts` | `TaskState`, `TaskResult`, `TaskOptions`; `run_task()` loop with token-budget tracking, abort signal, compaction-on-threshold | needs output emission to `TaskOutputStore` |
| `src/core/engine/RepublicAgentEngine.ts` | submission/event queues; `submitOperation()`, `getNextEvent()`, `initialize/dispose`, approval gate; `parentEngineId/depth/maxDepth` | needs `getTaskOutput(runId)`, `listTaskStates()` |
| `src/core/engine/RepublicAgentEngineConfig.ts` | model, approvalPolicy, eventRouter, depth, `drainPendingMessages?` callback | needs `taskOutputStore` wiring |
| `src/core/events/SubAgentEventRouter.ts` | namespaces sub-agent events with `_subAgent` metadata; suppresses Delta events by default | output-channel routing still open |
| `src/core/registry/AgentRegistry.ts` | multi-`AgentSession` registry, concurrency caps (default 3, max 10), persistence | does NOT track per-task state — that lives on `Session.activeTasks` |
| `src/tools/AgentTool/SubAgentRunner.ts` | foreground/background modes; `<task-notification>` injection on settle; `prepare/execute/cleanup` pipeline | output is injected as raw string in notification, not persisted |
| `src/tools/AgentTool/SubAgentRegistry.ts` | `ActiveSubAgent` tracking, atomic register/unregister, `cancelAll()`, `recordUsage()` | per-task output not stored |

PR #191 does **not** modify `src/core/Session.ts`. The concurrency seam is the responsibility of Track 04 inside this PR.

## Family Taxonomy Note (BrowserX-specific)

The BrowserX families proposed here — `background_agent` and the deferred `browser_automation`, `tab_watcher`, `data_extraction` — are **BrowserX-specific** and do **NOT** correspond to claudy's runtime task families.

Claudy's actual `TaskType` (see `Task.ts`) is:

```ts
type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream';
```

What we borrow from claudy is the **registry + state-machine pattern** (typed discriminated union, terminal-state guards, append-only output offset, `notified` flag, retention semantics), not the family taxonomy itself.

## Goal

Add typed task families to BrowserX without replacing its current execution stack.

The implementation must extend the existing:

- `src/core/TaskRunner.ts`
- `src/core/AgentTask.ts`
- `src/core/Session.ts`
- `src/core/session/state/ActiveTurn.ts`
- `src/core/TurnManager.ts`
- `src/core/engine/RepublicAgentEngine.ts` (PR #191)

The design target is not "copy claudy". The target is "borrow the parts of claudy that fit BrowserX's browser-extension runtime".

## Claudy Findings That Matter

The useful claudy patterns are these:

### 1. Typed task state is a discriminated union

Claudy defines a shared base task shape in `Task.ts` and unions concrete families in `tasks/types.ts`.

The important properties are:

- Stable task ID independent from transport submission ID
- `type` discriminator
- terminal-state guard
- append-only output offset for delta reads
- `notified` flag for atomic completion notification

That pattern maps cleanly to BrowserX.

### 2. Terminal-state protection is explicit

Claudy's `isTerminalTaskStatus()` and its update helpers consistently reject terminal-to-non-terminal transitions. That matters because BrowserX already has multiple async paths:

- normal completion from `TaskRunner`
- abort from `AbortController`
- UI-driven interruption
- future background polling updates

Without terminal guards, the same task can be "completed" and then "aborted" afterward by a stale callback.

### 3. Background visibility is separate from task existence

Claudy distinguishes:

- task exists
- task is running
- task is background-visible
- UI is retaining task details

The `isBackgrounded`, `retain`, `evictAfter`, and `pendingMessages` fields are the right pattern for BrowserX too.

**Storage shape**: claudy keeps all tasks in a **single flat dict** on `AppState.tasks` keyed by id, with per-task metadata flags such as `isBackgrounded` (see `tasks/LocalAgentTask/LocalAgentTask.tsx:134`). It does **not** use two separate containers for foreground vs background. BrowserX adopts the same single-container approach: one `Session.activeTasks` map plus a `foregroundTaskId` pointer, instead of an `ActiveTurn` + `backgroundTasks` split. (`ActiveTurn` continues to own foreground-only turn state — approvals and pending input — but per-task running state moves to `Session.activeTasks`.)

### 3b. No central scheduler in claudy

Claudy has **no `TaskRunner` / `TaskScheduler` orchestrator** for cross-task scheduling. Tasks are inserted into `AppState.tasks` and run on their own. There is no "abort all on spawn" rule — multiple `local_agent` and `in_process_teammate` tasks run concurrently by default.

BrowserX's current `Session.spawnTask()` calling `abortAllTasks('UserInterrupt')` before every spawn (`src/core/Session.ts:1323`) is a **BrowserX-specific bottleneck**, not something inherited from claudy. This track removes it (see [Concurrency Seam](#concurrency-seam-patch)).

### 4. Output is append-only with delta polling

Claudy's storage model (see `utils/task/TaskOutput.ts`) is **filesystem append + an in-memory pipe buffer (default 8 MB)**, not IndexedDB chunk aggregation. There is no `TaskOutputStore` class in claudy to port directly — BrowserX must invent the chunked-storage layer for IndexedDB/SQLite from scratch.

What **is** portable is the **delta-polling pattern**: an offset-tracked `getOutputDelta(fromOffset)` that returns only new content since the last read.

### 5. Re-registration preserves UI-held state

Claudy's registry preserves `retain`, pending messages, and viewed transcript state on re-registration. BrowserX should do the same.

## Type Model

New file: `src/core/tasks/types.ts`.

```ts
// src/core/tasks/types.ts
export type TaskType = 'background_agent';  // single family for v1; expand later
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed';

/** Canonical token-usage shape — used in TaskState, TaskNotification, and TaskRunner. */
export interface TaskTokenUsage {
  input: number;
  output: number;
  cached?: number;   // cache-hit tokens, if the model supports caching
  total: number;     // derived but stored to avoid re-summing
}

export interface TaskStateBase {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  outputOffset: number;     // last seen chunk seq for delta polling
  notified: boolean;        // has parent agent been notified of terminal state
  isBackgrounded: boolean;  // foreground vs background flag (replaces two-container idea)
  retain: boolean;          // UI is holding this task — blocks eviction
  evictAfter?: number;      // ms timestamp; eviction allowed once Date.now() >= evictAfter
  lastReadAt?: number;      // poller heartbeat for eviction-grace
}

export interface BackgroundAgentTaskState extends TaskStateBase {
  type: 'background_agent';
  runId: string;             // joins back to SubAgentRegistry; runId === id for v1
  parentSessionId: string;
  prompt: string;
  lastAgentMessage?: string;
  toolUseCount: number;
  tokenUsage: TaskTokenUsage;
  // pendingMessages is NOT here — stays on SubAgentRegistry (decision: see Resolved
  // Design Decisions, Q5). Look up via SubAgentRegistry.peekMessages(runId) if needed.
}

export type TaskState = BackgroundAgentTaskState;  // union grows as families are added

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'killed';
}
```

### Token-usage shape consolidation

Today BrowserX has three different token-usage shapes:

- `TaskRunner.TaskState.tokenUsage: { used: number; max: number }` — budget tracking.
- `TaskRunner.TaskState.tokenUsageDetail: { total?: TokenUsage; last?: TokenUsage }` — raw usage detail.
- `TaskNotification.tokenUsage: { input, output, total }` — XML notification payload.

Track 04 unifies the "raw usage" concept under `TaskTokenUsage` (above) and **renames** `TaskRunner.TaskState.tokenUsage` to `tokenBudget` so the names match what each thing actually means:

- **`tokenUsage`** — cumulative consumed tokens (input/output/cached/total). Lives on `BackgroundAgentTaskState`, `TaskNotification`, and the inner type of `tokenUsageDetail.total` / `tokenUsageDetail.last`.
- **`tokenBudget`** — remaining-capacity / compaction tracking (`{ used, max, compactionThreshold }`). Lives on `TaskRunner.TaskState`.

This rename is part of the status-rename commit so all the type churn lands together.

Allowed transitions:

- `pending -> running`
- `running -> completed | failed | killed`

Rejected transitions:

- any terminal to anything else
- `pending -> completed` except through an explicit registry helper used by setup failures

ID generation (Web Crypto, lowercase base36, 8 chars, type prefix `a` for `background_agent`).

### Status alignment with PR #191

PR #191 today uses `TaskStatus = 'initializing' | 'running' | 'completed' | 'failed' | 'cancelled'` in `src/core/AgentTask.ts` and `src/core/TaskRunner.ts`. As part of this PR, rename:

- `initializing -> pending`
- `cancelled -> killed`

The `running | completed | failed` literals stay the same. Touchpoints for the find-and-replace:

- `src/core/AgentTask.ts` (`TaskStatus` declaration + status setters)
- `src/core/TaskRunner.ts` (`TaskState`, `TaskResult`, status writes)
- `src/core/engine/RepublicAgentEngine.ts` (anywhere `cancelled`/`initializing` appears in event payloads)
- `src/core/__tests__/AgentTask.test.ts` and `src/core/__tests__/TaskRunner.test.ts`
- `src/tools/AgentTool/SubAgentRunner.ts` (string comparisons against status literals)

If any external caller serializes the old strings (rollouts), add a one-time migration shim in the rollout reader that maps old -> new on read. No write-path migration needed because no on-disk format change for the task state itself happens in this PR (the new `task_output_chunks` store is additive).

### Concrete state for the only family in v1

`BackgroundAgentTaskState` is shown above. Future families (`browser_automation`, `tab_watcher`, `data_extraction`) will extend `TaskStateBase` and join the `TaskState` union; they are intentionally **not** declared in v1 to keep the union narrow and the `isBackgroundAgentTask` guard trivial.

## TaskOutputStore (Storage Layer)

New file: `src/core/tasks/TaskOutputStore.ts`.

### Store shape

- New store name: `task_output_chunks`
- Key: `${taskId}:${seq.toString().padStart(8, '0')}` (lex-sortable so range queries work in IndexedDB cursors and SQLite `ORDER BY`).
- Row:
  ```ts
  interface TaskOutputChunk {
    chunkId: string;     // ${taskId}:${seq}
    taskId: string;
    seq: number;
    createdAt: number;
    kind: 'stdout' | 'stderr' | 'event' | 'message';
    data: string;        // UTF-8, <= 64 KiB
  }
  ```
- Chunk size: <= 64 KiB of `data` (UTF-8). Larger payloads split across consecutive `seq` values.
- Indexes: `taskId`, `[taskId, seq]`, `createdAt` (for FIFO eviction).

### APIs

- `appendChunk(taskId, kind, data: string): Promise<TaskOutputChunk>` — assigns next `seq`, splits >64 KiB into N rows, writes via `put`, returns the **last** chunk written.
- `getDelta(taskId, fromSeq: number = 0): Promise<TaskOutputChunk[]>` — range query `[taskId, fromSeq] -> [taskId, +inf]`.
- `streamDelta(taskId, fromSeq, intervalMs = 1000): AsyncIterable<TaskOutputChunk[]>` — built atop polling for the UI hook.
- `cleanupTask(taskId): Promise<void>` — delete all chunks for a task (used at terminal + grace).
- `cleanupSession(sessionId): Promise<void>` — bulk delete by joining with `Session.activeTasks` snapshot at call time.

Append is non-blocking from the caller's perspective: writes go through a per-task in-memory queue that drains via the storage adapter, mirroring claudy's queue-splice semantics.

### Storage adapter touchpoints

A new store must be reflected in three places (plus a Rust migration for desktop):

1. `src/storage/StorageAdapter.ts` — add `task_output_chunks: 'chunkId'` to `STORE_KEY_PATHS` (lines 17–28) and to `VALID_STORE_NAMES`.
2. `src/storage/IndexedDBAdapter.ts` — bump `DB_VERSION` to 5; in `onupgradeneeded` (around lines 166–196) create the object store with `keyPath: 'chunkId'` and the three indexes above.
3. `src/server/storage/NodeSQLiteAdapter.ts` — add a `CREATE TABLE task_output_chunks (chunk_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)` to the `CREATE TABLE` block (lines 62–86), plus `CREATE INDEX` statements for `task_id`, `(task_id, seq)`, and `created_at`.
4. `src/desktop/storage/TauriSQLiteAdapter.ts` — add a Rust-side migration in the desktop sidecar. **This is the only file that requires a Rust change**; flag it explicitly in the PR description.

### Quota integration

- Per-task soft cap: 50 MiB (configurable via `TASK_OUTPUT_PER_TASK_CAP_BYTES`).
- New helper `TaskOutputManager.evictOldestChunks(targetBytes: number): Promise<number>` — iterate `task_output_chunks` ordered by `(createdAt, taskId, seq)`, `batchDelete` oldest until `targetBytes` reclaimed; return bytes freed.
- Modify `src/storage/StorageQuotaManager.ts:131–162` to call `TaskOutputManager.evictOldestChunks` as **tier 0**, before the existing tiers (rollouts -> cache expired -> cache full clear).
- Eviction never deletes chunks of a non-terminal task that has been read in the last `EVICTION_GRACE_MS` (default 5 minutes). Implementation: `TaskOutputManager` keeps an in-memory `lastReadAt: Map<taskId, number>` updated on `getDelta`; eviction skips taskIds whose `lastReadAt > now - EVICTION_GRACE_MS` AND whose status is non-terminal.

## Concurrency Seam Patch

This is the most load-bearing change in the PR. The current `Session.spawnTask` (`src/core/Session.ts:1332–1394`) unconditionally aborts every running task on every spawn (`abortAllTasks('UserInterrupt')` at line 1339). Background sub-agent tasks introduced by PR #191 cannot survive that. The implementation of `abortAllTasks` itself lives at `Session.ts:1288–1300` and remains unchanged — only the call site inside `spawnTask` is removed; other call sites stay (see table below).

### Existing `spawnTask` shape (verified)

For reference, today's body (paraphrased from `Session.ts:1332–1394`):

1. **Line 1339** — `await this.abortAllTasks('UserInterrupt')` (the bottleneck to remove).
2. **Line 1342** — `new AbortController()`.
3. **Lines 1345–1351** — fire `TaskCreated` hook (fire-and-forget).
4. **Lines 1355–1378** — wrap execution: call `task.run(this, context, subId, input)`, on success `onTaskFinished(subId, result)`, on error `onTaskAborted(subId, error)`; fire `TaskCompleted` on success.
5. **Lines 1381–1387** — build `RunningTask` (shape verified at `src/core/session/state/types.ts:23–38`):
   ```ts
   interface RunningTask {
     kind: TaskKind;             // 'Regular' | 'Review' | 'Compact'
     abortController: AbortController;
     task: SessionTask;
     promise: Promise<string | null>;  // resolves to last assistant message
     startTime: number;
   }
   ```
6. **Line 1390** — `registerNewActiveTask(subId, runningTask)` (creates the per-turn `ActiveTurn` and inserts the task).

### Patch

```ts
// src/core/Session.ts (changes summarized)
private activeTasks: Map<string, RunningTask> = new Map();
private foregroundTaskId: string | null = null;
private evictionTimerId: ReturnType<typeof setInterval> | null = null;

async spawnTask(
  task: SessionTask,
  context: TurnContext,
  subId: string,
  input: InputItem[],
  opts: { background?: boolean; scopedTabIds?: number[] } = {}
): Promise<void> {
  // REMOVED: await this.abortAllTasks('UserInterrupt');   ← was Session.ts:1339
  if (!opts.background) {
    if (this.foregroundTaskId) {
      // foreground replacement: abort just the prior foreground task
      await this.abortTask(this.foregroundTaskId, 'UserInterrupt');
    }
    this.foregroundTaskId = subId;
  }
  // ... existing AbortController + RunningTask creation, registerNewActiveTask ...
  // RunningTask now carries taskState alongside the machinery (Q1).
  const runningTask: RunningTask = {
    kind: task.kind(),
    abortController,
    task,
    promise,
    startTime: Date.now(),
    scopedTabIds: opts.scopedTabIds,
    // taskState is populated separately for sub-agents via registerTaskState (Q2);
    // foreground RegularTasks build it inline here.
  };
  this.activeTasks.set(subId, runningTask);
}

/**
 * Thin registration method called by SubAgentRunner.prepare (Q2). The runner
 * already owns the prompt, description, parent-session-id, and type config;
 * the Session just owns the map mutation.
 */
registerTaskState(
  state: BackgroundAgentTaskState,
  bits: { context: AgentContext; scopedTabIds?: number[] }
): void {
  const existing = this.activeTasks.get(state.id);
  if (existing) {
    existing.taskState = state;
    existing.context = bits.context;
    existing.scopedTabIds = bits.scopedTabIds;
  } else {
    // Future: standalone background-only spawn not going through spawnTask.
    // For PR #191 this branch isn't expected; sub-agents always come through
    // spawnTask -> RegularTask -> AgentTask -> SubAgentRunner.
  }
}

async abortTask(id: string, reason: TurnAbortReason): Promise<void> {
  const t = this.activeTasks.get(id);
  if (!t) return;
  await this.handleTaskAbort(id, t, reason);
  this.activeTasks.delete(id);
  if (this.foregroundTaskId === id) this.foregroundTaskId = null;
}

/**
 * Tab-scoped abort (Q9). Used by service-worker on chrome.tabs.onRemoved when
 * the closing tab is NOT the chat-panel tab.
 */
async abortTasksForTab(tabId: number, reason: TurnAbortReason): Promise<void> {
  const toAbort: string[] = [];
  for (const [id, t] of this.activeTasks) {
    if (t.scopedTabIds?.includes(tabId)) toAbort.push(id);
  }
  await Promise.all(toAbort.map(id => this.abortTask(id, reason)));
}

listActiveTasks(): RunningTask[] { return [...this.activeTasks.values()]; }
listTaskStates(): TaskState[] {
  return [...this.activeTasks.values()]
    .map(t => t.taskState)
    .filter((s): s is TaskState => s !== undefined);
}
getTask(id: string): RunningTask | undefined { return this.activeTasks.get(id); }

/**
 * Mount/unmount toggle from BackgroundTaskPanel.svelte (Q10 UI wiring).
 * Re-arms evictAfter when retain flips false.
 */
retainTask(id: string, retain: boolean): void {
  const t = this.activeTasks.get(id);
  if (!t?.taskState) return;
  t.taskState.retain = retain;
  if (!retain && isTerminalTaskStatus(t.taskState.status)) {
    t.taskState.evictAfter = Date.now() + PANEL_GRACE_MS;
  } else if (retain) {
    t.taskState.evictAfter = undefined;
  }
}
```

`handleTaskAbort` is the existing private method already used by `abortAllTasks` (see `Session.ts:1288–1300` for how `abortAllTasks` walks `takeAllRunningTasks()` and awaits each `handleTaskAbort` in parallel). For the per-task path it must:

1. **(Q7) Resolve pending approvals with `'deny'`** before signaling abort. Look up `ActiveTurn.pendingApprovals` entries belonging to `subId`; call each resolver with `{ decision: 'denied', reason: 'task aborted' }` so the awaiting tool call sees the denial and unwinds cleanly. Don't just dismiss — that leaves the awaiter hanging.
2. **(Q7) Drop pending input** if the aborted task is foreground: clear `ActiveTurn.pendingInput`. The user's new submission is what they want sent; older buffered input represented a different intent.
3. **(Q5/AgentContext.cancelled)** If `t.context` is present (i.e., a `background_agent`), set `t.context.cancelled = true`. This suppresses the misleading `<task-notification>` that the IIFE in `SubAgentRunner.ts:127` would otherwise enqueue.
4. **Abort the controller**: `t.abortController.abort(reason)`.
5. **Await graceful completion**: `await t.promise.catch(() => {})`.
6. **Emit `TurnAborted` event** and update `t.taskState.status = 'killed'`, set `endTime` and `evictAfter = Date.now() + PANEL_GRACE_MS` (unless `retain === true`).
7. **Remove from `ActiveTurn`**: call `ActiveTurn.removeTask(subId)` and clear `this.activeTurn` if empty (mirrors today's `onTaskAborted` at `Session.ts:1845–1871`).
8. **Schedule output cleanup**: `taskOutputStore.cleanupTask(id)` is run by the eviction timer once the grace period expires — *not* here, so reload-recovery / late-poller reads still work.

### Relationship to `ActiveTurn.tasks` and `SubAgentRegistry`

Two existing maps overlap with the new `Session.activeTasks`. Both stay:

- **`ActiveTurn.tasks: Map<string, RunningTask>`** (`src/core/session/state/ActiveTurn.ts:13–128`) — keeps foreground-only turn state: approvals (`insertPendingApproval`/`removePendingApproval`), pending input (`pushPendingInput`/`takePendingInput`), turn-scoped abort. Lifecycle is per-turn: created in `registerNewActiveTask`, torn down in `onTaskFinished`/`onTaskAborted`. **Source of truth for "is the foreground turn live?"**
- **`SubAgentRegistry.activeAgents: Map<string, ActiveSubAgent>`** (`src/tools/AgentTool/SubAgentRegistry.ts:46–150+`) — keeps sub-agent-specific lifecycle (engine handle, runId, type, description, status, pending-message queue via `queueMessage`/`drainMessages`). **Source of truth for "is this specific sub-agent runnable?"** and gates the `maxConcurrent=3` cap.

`Session.activeTasks` is **above both** — the cross-turn, cross-family registry. Mapping:

| Concern | Lives in | Why |
|---|---|---|
| Turn-scoped approvals + pending user input | `ActiveTurn` | Foreground UX only; unchanged |
| Sub-agent engine handle + per-sub-agent message queue | `SubAgentRegistry` | Sub-agent specifics; unchanged |
| Cross-turn, typed task state with `TaskStatus` + output offset | `Session.activeTasks` | NEW — what Track 04 introduces |

When a `background_agent` task spawns, all three are populated: `SubAgentRegistry.register(...)` for sub-agent specifics, `Session.activeTasks.set(...)` for the typed `BackgroundAgentTaskState`, and (only if foreground) `ActiveTurn` for turn UI state. The `RunningTask` in `Session.activeTasks` carries a `runId` field that joins back to `SubAgentRegistry` for engine operations.

### `abortAllTasks` call sites (verified)

| Site | Action |
|---|---|
| `src/core/Session.ts:1339` (inside `spawnTask`) | **REMOVE** — this is the bottleneck |
| `src/core/Session.ts:1403` (`interruptTask`, body `1402–1404`) | KEEP — but rewrite to kill only the foreground task; leave background tasks running. Implementation: `if (this.foregroundTaskId) await this.abortTask(this.foregroundTaskId, 'UserInterrupt')` |
| `src/core/RepublicAgent.ts:699` (`handleInterrupt`) | KEEP — same narrow-to-foreground pattern as above |
| `src/core/services/agent-services.ts:84` | KEEP — review per call path; likely the same narrow pattern |
| `src/extension/background/service-worker.ts:128` (tab closed → `'TabClosed'`) | KEEP — tab close is a hard shutdown of the whole session |
| `src/extension/background/service-worker.ts:601` (user interrupt) | KEEP — re-route to foreground-only abort or leave as hard shutdown; decide during PR |

`abortAllTasks` itself stays in `Session.ts:1288–1300` as a backward-compat path used by the kept call sites; new background spawns simply do not trigger it.

### Invariants to assert in tests

- At most one foreground task at a time (`foregroundTaskId` is single-valued).
- Background tasks can spawn without aborting siblings (foreground or background).
- User interrupt (`RepublicAgent.handleInterrupt`) kills the foreground task and emits `TurnAborted`; background tasks keep running.
- Tab close / explicit stop kills all (still routes through `abortAllTasks`).

## Engine API Additions

Additions to `src/core/engine/RepublicAgentEngine.ts`:

```ts
// New methods on RepublicAgentEngine
async getTaskOutput(taskId: string, fromSeq = 0): Promise<TaskOutputChunk[]>;
listTaskStates(): TaskState[];   // projection of session.activeTasks + terminal-but-unevicted
```

`getTaskOutput` wraps `TaskOutputStore.getDelta`. `listTaskStates` projects `Session.activeTasks` plus any terminal entries still inside the eviction grace window.

### New events on the existing channel

Emitted via the existing event channel and routed through `SubAgentEventRouter` (`src/core/events/SubAgentEventRouter.ts`) so the `_subAgent` metadata namespace already in PR #191 carries them:

- `TaskStarted { taskId, type, description, startTime }`
- `TaskOutputDelta { taskId, fromSeq, toSeq, kindCounts }`  *(metadata only — chunk payload stays in store)*
- `TaskStateChanged { taskId, prevStatus, status }`
- `TaskTerminated { taskId, status, endTime, durationMs, summary? }`

The router default-suppresses `TaskOutputDelta` for non-debug consumers (same pattern as existing Delta suppression) so the foreground UI stays quiet unless a panel is open.

## TaskRunner Wiring

`TaskRunner.runLoop` lives at `src/core/TaskRunner.ts:267–393`. The loop already exposes the exact injection points we need:

| Anchor in current `runLoop` | Line | What to do for Track 04 |
|---|---|---|
| Top of loop, abort check | 276 | If `signal?.aborted`, flush in-memory chunks via `taskOutputStore.flush(taskId)` before returning the aborted outcome |
| Max-turn guard | 288 | (no change) |
| `drainPendingMessages` callback fires | 304–310 | (already wired — see `TaskOptions.drainPendingMessages` at `TaskRunner.ts:67`; this is where queued cross-task notifications get injected as `InputItem`s) |
| Pending-input pull from session | 313 | (no change) |
| Pre-request compaction check | 318 | If compaction triggers, `appendChunk(taskId, 'event', JSON.stringify({ kind: 'compaction', turn: turnCount }))` |
| Run turn (model call + tool round) | 338 | (no change; this is the only awaited tool/model boundary) |
| `processTurnResult` returns | 339 | `appendChunk(taskId, 'message', processResult.lastAgentMessage)` if present; `appendChunk(taskId, 'event', JSON.stringify(turnSummary))` with `{ kind: 'turn', index: turnCount, tokens: lastTokenUsage }` |
| Turn counter increment | 347 | (no change) |
| Post-turn compaction trigger | 350 | Same chunk emission as line 318 |
| Task-complete branch | 357 | Final flush, then `appendChunk(taskId, 'event', JSON.stringify({ kind: 'complete' }))` |

`TaskState` already has `lastAgentMessage`, `currentTurnIndex`, `tokenUsage`, `tokenUsageDetail`, `compactionPerformed` (see `TaskRunner.ts:28–44`) — every field needed for the chunked event payload is already populated. The wiring is **read-only against existing state**; no extra bookkeeping inside the loop.

### TaskOptions extension

`TaskOptions` at `TaskRunner.ts:59–68` currently has `timeoutMs`, `autoCompact`, `maxTurns`, `drainPendingMessages`. Add:

```ts
export interface TaskOptions {
  // ...existing fields
  taskOutputStore?: TaskOutputStore;
  taskId?: string;  // separate from submissionId; the stable TaskStateBase.id
}
```

`taskId` is distinct from `state.submissionId` (which is the transport-layer id) — see [Type Model](#type-model) note on identity separation. If `taskOutputStore` is omitted (e.g., legacy callers, foreground main-thread loop), all `appendChunk` calls are no-ops; the loop behavior is unchanged.

### AgentTask + RepublicAgentEngineConfig plumbing

- `src/core/AgentTask.ts:33–158` — extend the constructor to accept an optional `taskOutputStore` and pass it through to `TaskRunner` in `run()` (`AgentTask.ts:72–92`).
- `src/core/engine/RepublicAgentEngineConfig.ts` — add `taskOutputStore?: TaskOutputStore` (sibling to `drainPendingMessages`, which is already at lines 103–106).
- `RepublicAgentEngine.createChildEngine` — pass `taskOutputStore` through to the child engine config so background sub-agents inherit the store. Wiring point is the existing call in `SubAgentRunner.prepare` at `SubAgentRunner.ts:251–261`.

### Output emission on abort path

`TaskRunner.run_task` (`TaskRunner.ts:167–265`) currently has try/finally at lines 191/256. Inside the `catch` block (lines 244–253), before re-throwing:

```ts
} catch (error) {
  this.state.status = this.cancelled ? 'cancelled' : 'failed';
  if (this.options.taskOutputStore && this.options.taskId) {
    await this.options.taskOutputStore.flush(this.options.taskId);
  }
  // ... existing emit + throw
}
```

`flush` drains the in-memory append queue. Without this, polling consumers may miss the tail of a long-running task that died mid-turn.

## UI Surface

BrowserX's webfront is **Svelte** (`.svelte` files; writable/derived stores in `src/webfront/stores/`). Events from the engine flow through `ThreadEventRouter` (`src/webfront/routing/`) into stores — that's the existing pattern, not direct engine subscriptions from components.

Minimum to ship in PR #191:

- **`src/webfront/stores/backgroundTaskStore.ts`** — new Svelte writable store: `{ tasks: Record<runId, TaskState>, outputs: Record<runId, TaskOutputChunk[]> }`. Polls `engine.listTaskStates()` at `POLL_INTERVAL_MS = 1000` for the list; subscribes to `TaskStateChanged`/`TaskTerminated` events from `ThreadEventRouter` for the cheap delta path. The chunk array per task is filled by `BackgroundTaskPanel` when it mounts (not eagerly — output chunks can be large).
- **`src/webfront/components/BackgroundTasksBadge.svelte`** — subscribes to `backgroundTaskStore`; renders count + dropdown of running/terminal-but-unevicted tasks with status pill (`pending|running|completed|failed|killed`). Filter matches claudy's `isBackgroundTask` (`tasks/types.ts:37–46` in claudy): show iff `(status === 'running' || status === 'pending') && isBackgrounded !== false`, plus terminal tasks still inside `PANEL_GRACE_MS`. **Mount point (Q10)**: in the existing top-bar component of the chat page (`src/webfront/pages/chat/...`), next to the title/model-selector area. Not the global app shell — background tasks are scoped to a chat conversation. Implementer follows the existing model-selector pill's layout pattern.
- **`src/webfront/components/BackgroundTaskPanel.svelte`** — opens for a `runId`; polls `engine.getTaskOutput(runId, lastSeq)` every `POLL_INTERVAL_MS = 1000`; renders chunks newest-first with `kind` styling (`stdout` / `stderr` / `event` / `message`). Setting the panel open should set the task's `retain` flag to `true` so eviction is blocked while the user is looking (matches claudy's behavior at `LocalAgentTask.tsx:139–140`).
- **`src/webfront/lib/hooks/usePolledTaskOutput.ts`** — Svelte store factory: `(runId: string) => Readable<{ chunks, status, error, lastSeq }>`. Internally manages the polling interval, cancels on unsubscribe.
- **`src/webfront/components/MessageInput.svelte`** or the chat page — wire the foreground turn's task-id awareness so the user knows a "send" replaces only the foreground task, not background ones. No UI change needed beyond the badge.

Hide the panel `STOPPED_DISPLAY_MS = 3000` after terminal state; evict from the UI list after `PANEL_GRACE_MS = 30000`.

These three constants must live in `src/core/tasks/timing.ts` so the engine and the UI share them:

```ts
// src/core/tasks/timing.ts
export const POLL_INTERVAL_MS = 1_000;
export const STOPPED_DISPLAY_MS = 3_000;
export const PANEL_GRACE_MS = 30_000;
```

The values match claudy verbatim (claudy's are in `utils/task/framework.ts:24–28`).

### Event routing wiring

The four new events (`TaskStarted`, `TaskOutputDelta`, `TaskStateChanged`, `TaskTerminated` — see [Engine API Additions](#engine-api-additions)) must be added to the `EventMsg` union at `src/core/protocol/events.ts:28–115+` and handled in `ThreadEventRouter`. `SubAgentEventRouter` (`src/core/events/SubAgentEventRouter.ts:6–46`) already handles namespacing — its default-suppressed list currently is `['AgentMessageDelta', 'AgentReasoningDelta']` and should be extended to include `'TaskOutputDelta'` so it doesn't fan out to the foreground UI unless a panel is actively listening.

## Notification Format Reconciliation

BrowserX and claudy disagree on the task-notification XML shape today. The design must pick one before merging.

**BrowserX today** (`src/tools/AgentTool/SubAgentRunner.ts:602–624`, `formatTaskNotification` at `:559–583`, injection via `parentEngine.enqueueSyntheticUserTurn` at `:178–194`):

```xml
<task-notification>
  <run-id>{runId}</run-id>
  <type>{type}</type>
  <status>completed|failed|cancelled</status>
  <summary>{description}</summary>
  <result>{result}</result>            <!-- optional -->
  <error>{error}</error>               <!-- optional -->
  <usage>
    <total_tokens>{total}</total_tokens>
    <turn_count>{turnCount}</turn_count>
    <duration_ms>{durationMs}</duration_ms>
  </usage>
</task-notification>
```

**Claudy today** (`src/constants/xml.ts:27–38`, template at `LocalAgentTask.tsx:246–262`):

```xml
<task-notification>
  <task-id>{taskId}</task-id>
  <tool-use-id>{toolUseId}</tool-use-id>   <!-- optional -->
  <output-file>{outputPath}</output-file>
  <status>completed|failed|stopped</status>
  <summary>{summary}</summary>
  <result>{result}</result>                <!-- optional -->
  <usage>...</usage>                       <!-- different inner shape -->
  <worktree>...</worktree>                 <!-- optional, claudy-specific -->
</task-notification>
```

**Decision**: keep BrowserX's existing `<run-id>` tag and treat it as the `TaskStateBase.id` for the typed-state union — i.e., `runId === taskId`. Add a new optional `<output-offset>{lastSeq}</output-offset>` element so the parent agent can hint at "pick up output from seq X" if it wants to delta-poll inside its own turn. Drop the `<output-file>` element (BrowserX has no filesystem path).

Rationale:
- BrowserX's `<run-id>` is already in production behavior for PR #191; renaming breaks every consumer that's already parsing it.
- Identity collapse (`runId = taskId`) matches claudy's `LocalAgentTask` pattern where `agentId === taskId` (verified at `LocalAgentTask.tsx:483, 487, 491`).
- Inserting `<output-offset>` is additive — old parsers ignore unknown elements.

Update `serializeTaskNotification` (`SubAgentRunner.ts:602–624`) to emit `<output-offset>` from `lastSeq` if the task wrote to `taskOutputStore` at all; omit otherwise. The `TaskNotification` interface (`types.ts:166–176`) gains one optional field:

```ts
export interface TaskNotification {
  // ...existing fields
  outputOffset?: number;  // last seq written to TaskOutputStore
}
```

## AgentContext.cancelled coordination

There's a subtle correctness requirement that the existing `cancel_sub_agent` tool already implements and Track 04 must preserve.

`SubAgentRunner.run` (`src/tools/AgentTool/SubAgentRunner.ts:121–163`) detaches an async IIFE for background sub-agents. Inside the IIFE (lines 125–129):

```ts
const result = await this.execute(context, params);
if (!context.cancelled) {
  this.safeEnqueueNotification(
    context,
    this.formatTaskNotification(context, params, result),
  );
}
```

The `if (!context.cancelled)` gate suppresses the task-notification when the user explicitly cancelled the sub-agent. The flag is set by `cancel_sub_agent` (`managementTools.ts:91–120`, line 110) **before** `engine.dispose()`, so the racing IIFE sees the flag during its `await this.execute(...)` and skips the notification.

Track 04 must preserve this gate when `Session.abortTask` (or `abortTasksForTab`) is called on a background sub-agent task. The full ordering inside `handleTaskAbort` for the per-task path (also enumerated in [Concurrency Seam Patch](#concurrency-seam-patch)):

1. Resolve pending approvals with `'denied'` (Q7).
2. Drop `ActiveTurn.pendingInput` if the task being aborted is foreground (Q7).
3. **Set `runningTask.context.cancelled = true`** if `context` is present (i.e., a `background_agent`) — **before** calling `abortController.abort(reason)`.
4. `abortController.abort(reason)`.
5. Await `t.promise.catch(...)`.
6. Emit `TurnAborted`, update `taskState` to terminal.
7. Remove from `ActiveTurn`.

The atomic check inside the IIFE at `SubAgentRunner.ts:127` remains the source of truth; Track 04 does not change the IIFE. Without step 3, killing a background sub-agent via `Session.abortTask` would emit a misleading `failed`/`cancelled` task-notification into the parent's message stream. The flag-then-abort sequence is the same ordering used by `cancel_sub_agent` today (`managementTools.ts:110`).

## Eviction Mechanism

The design references `PANEL_GRACE_MS` and `STOPPED_DISPLAY_MS` but does not specify *who* runs the eviction or what gates it. Claudy's model (`utils/task/framework.ts`, `evictTerminalTask` at lines 138–139) is:

> Delete the task from the registry iff: `notified === true` AND `isTerminalTaskStatus(status)` AND `(retain === false || Date.now() >= evictAfter)`.

BrowserX adopts the same gate. Implementation:

- **Where**: a single timer on `Session`, set lazily when the first task transitions to terminal. Re-checks every `STOPPED_DISPLAY_MS = 3000` until `Session.activeTasks` has no terminal entries.
- **What it does** for each terminal task in `activeTasks`:
  1. If `!task.notified` → skip (parent hasn't been told yet).
  2. If `task.retain === true` (UI panel open) → skip.
  3. If `Date.now() < task.evictAfter` → skip.
  4. Else: `taskOutputStore.cleanupTask(taskId)` → `activeTasks.delete(taskId)` → `SubAgentRegistry.unregister(runId)`.
- **`notified` flag** is set when:
  - `SubAgentRunner` successfully calls `safeEnqueueNotification` (background path) — set inside `safeEnqueueNotification` after `enqueueSyntheticUserTurn` returns.
  - Foreground tasks: set immediately on terminal transition (no async notification needed; the result is the tool's return value).
- **`retain` flag** is set by the UI (`BackgroundTaskPanel.svelte` mount/unmount):
  - `onMount` → call `engine.retainTask(taskId, true)`.
  - `onDestroy` → call `engine.retainTask(taskId, false)`; this re-arms `evictAfter = Date.now() + PANEL_GRACE_MS`.

Engine API addition (sibling to the others in [Engine API Additions](#engine-api-additions)):

```ts
async retainTask(taskId: string, retain: boolean): Promise<void>;
```

Forwards to `Session` which mutates the `RunningTask` and re-computes `evictAfter`.

### Tab close / hard shutdown

`AgentSession`'s shutdown paths (`extension/background/service-worker.ts:128`, `:601`) call `abortAllTasks` synchronously. Eviction-grace is irrelevant on hard shutdown — `Session.dispose` should `taskOutputStore.cleanupSession(sessionId)` regardless of `retain`/`evictAfter` so output chunks don't leak across sessions on disk.

## StorageQuotaManager Tier Extension

The design references "tier 0 eviction" but `StorageQuotaManager` today (`src/storage/StorageQuotaManager.ts`) is **threshold-only**, not tier-based:

- `warningThreshold = 80`
- `criticalThreshold = 95`
- Public API: `getQuota()`, `getDetailedStats()`, `startQuotaMonitoring()`, `requestPersistentStorage()`.
- No `evictTier(n: number, targetBytes: number)` method exists.

Track 04 introduces the tier concept via **constructor-injected eviction** (Q8) so `StorageQuotaManager` doesn't gain upward dependencies on `TaskOutputManager` or other specific stores:

```ts
// src/storage/StorageQuotaManager.ts
type EvictionTier = 0 | 1 | 2;
// Tier 0: ephemeral task output chunks (this PR adds this tier)
// Tier 1: cache_items (existing — least important persistent data)
// Tier 2: anything else (rollouts, sessions, config — never auto-evict)

interface TieredEvictor {
  evictTier(tier: EvictionTier, target: number): Promise<number>;  // returns bytes freed
}

class StorageQuotaManager {
  constructor(opts: {
    warningThreshold?: number;
    criticalThreshold?: number;
    tieredEvictor?: TieredEvictor;  // optional — without it, no auto-eviction
  });
}
```

Behavior:
- The existing quota-monitor loop (the one that polls `navigator.storage.estimate()`) gains an "act" step: when usage crosses `criticalThreshold` AND `tieredEvictor` is set, call `tieredEvictor.evictTier(0, bytesNeeded)`. If under-fills, escalate to `evictTier(1, remaining)`.
- The concrete `TieredEvictor` is wired once at **service-worker startup** with knowledge of `TaskOutputManager` (tier 0) and `cache_items` (tier 1). `StorageQuotaManager` stays unaware of specifics.
- Without `tieredEvictor`, behavior is identical to today — monitor warns, no automatic action. This keeps the constructor backward-compatible for tests and non-extension contexts.

The tier-0 implementation delegates to a new `TaskOutputManager.evictOldestChunks` (already specified in [Quota integration](#quota-integration)).

**Eviction-grace guard**: skip chunks belonging to a task with `notified === false` (the parent hasn't seen any output yet — evicting it would silently lose data) OR `Date.now() - lastReadAt < EVICTION_GRACE_MS` (a poller just read these chunks; evicting them would make the next poll see a gap). `EVICTION_GRACE_MS = 5_000` is sufficient given `POLL_INTERVAL_MS = 1_000`.

## Status Rename Touchpoint Table

Renaming `initializing → pending` and `cancelled → killed` (per [Status alignment with PR #191](#status-alignment-with-pr-191)) needs to land as one atomic commit. The verified touchpoints are:

**`initializing` literal**:
| File | Line | Context |
|---|---|---|
| `src/core/AgentTask.ts` | 37 | `private status: TaskStatus = 'initializing';` |
| `src/core/AgentTask.ts` | 110 | comparison in `getStatus()` mapping |
| `src/core/__tests__/AgentTask.test.ts` | 378 | test assertion |
| `src/core/__tests__/multi-session.integration.test.ts` | 184 | integration-test state tracking |

**`cancelled` literal** (TaskStatus context only — not `'cancelled'` as a `stopReason`):
| File | Line | Context |
|---|---|---|
| `src/core/AgentTask.ts` | 19 | `TaskStatus` type union declaration |
| `src/core/AgentTask.ts` | 86 | assigned when abort signal fires |
| `src/core/AgentTask.ts` | 99 | assigned in `cancel()` method |
| `src/core/TaskRunner.ts` | 30 | `TaskState.status` union declaration |
| `src/core/TaskRunner.ts` | 153 | assigned in `TaskRunner.cancel()` |
| `src/core/TaskRunner.ts` | 215 | assigned on aborted outcome |
| `src/core/TaskRunner.ts` | 245 | assigned in catch block |
| `src/core/__tests__/AgentTask.test.ts` | 296, 302, 334, 335, 407, 411 | multiple test assertions |
| `src/core/__tests__/TaskRunner.test.ts` | 177, 499 | test assertions |

**Do NOT rename**: `stopReason: 'cancelled' | 'interrupted'` in `EngineResult` (`RepublicAgentEngineConfig.ts:132`). That's a separate concept (why the engine stopped, not the task's status) and downstream parsers may depend on it.

Order the rename commit so the type union is first, then assignments, then tests — TypeScript will catch any miss.

## Verified Wiring Reference

A flat reference of every file:line involved in Track 04, validated against the working tree on 2026-05-13. Useful for grepping during implementation.

### Session layer
| Concern | File | Lines |
|---|---|---|
| `spawnTask` body | `src/core/Session.ts` | 1332–1394 |
| `abortAllTasks('UserInterrupt')` call inside `spawnTask` | `src/core/Session.ts` | 1339 |
| `abortAllTasks` impl | `src/core/Session.ts` | 1288–1300 |
| `interruptTask` | `src/core/Session.ts` | 1402–1404 |
| `registerNewActiveTask` | `src/core/Session.ts` | 1829–1836 |
| `onTaskAborted` / `onTaskFinished` | `src/core/Session.ts` | 1312–1319, 1845–1871 |
| `ActiveTurn` class | `src/core/session/state/ActiveTurn.ts` | 13–128 |
| `RunningTask` shape | `src/core/session/state/types.ts` | 23–38 |

### Task / runner layer
| Concern | File | Lines |
|---|---|---|
| `AgentTask` class | `src/core/AgentTask.ts` | 33–158 |
| `AgentTask.run` | `src/core/AgentTask.ts` | 72–92 |
| `AgentTask.cancel` | `src/core/AgentTask.ts` | 99 |
| `AgentTask.injectUserInput` (stub) | `src/core/AgentTask.ts` | 143–149 |
| `TaskRunner` class | `src/core/TaskRunner.ts` | 94–265 |
| `TaskRunner.runLoop` | `src/core/TaskRunner.ts` | 267–393 |
| `TaskState` / `TaskResult` / `TaskOptions` | `src/core/TaskRunner.ts` | 28–68 |
| `drainPendingMessages` callback fires | `src/core/TaskRunner.ts` | 304–310 |

### Sub-agent layer
| Concern | File | Lines |
|---|---|---|
| `SubAgentRunner.run` | `src/tools/AgentTool/SubAgentRunner.ts` | 63–172 |
| Background detach IIFE | `src/tools/AgentTool/SubAgentRunner.ts` | 121–163 |
| `context.cancelled` gate | `src/tools/AgentTool/SubAgentRunner.ts` | 127 |
| `SubAgentRunner.prepare` | `src/tools/AgentTool/SubAgentRunner.ts` | 205–349 |
| `drainPendingMessages` wiring | `src/tools/AgentTool/SubAgentRunner.ts` | 260 |
| `enqueueSyntheticUserTurn` call | `src/tools/AgentTool/SubAgentRunner.ts` | 178–194 |
| `formatTaskNotification` | `src/tools/AgentTool/SubAgentRunner.ts` | 559–583 |
| `serializeTaskNotification` | `src/tools/AgentTool/SubAgentRunner.ts` | 602–624 |
| `SubAgentRegistry` class | `src/tools/AgentTool/SubAgentRegistry.ts` | 46–150+ |
| `ActiveSubAgent` shape | `src/tools/AgentTool/SubAgentRegistry.ts` | 12–33 |
| `TaskNotification` interface | `src/tools/AgentTool/types.ts` | 166–176 |
| `cancel_sub_agent` handler (sets `context.cancelled`) | `src/tools/AgentTool/managementTools.ts` | 91–120 (esp. 110) |
| `send_message` handler (`queueMessage`) | `src/tools/AgentTool/managementTools.ts` | 122–138 |

### Engine + events
| Concern | File | Lines |
|---|---|---|
| `submitOperation` | `src/core/engine/RepublicAgentEngine.ts` | 116–126 |
| `getNextEvent` | `src/core/engine/RepublicAgentEngine.ts` | 128–135 |
| `dispose` | `src/core/engine/RepublicAgentEngine.ts` | 211–228 |
| `createChildEngine` | `src/core/engine/RepublicAgentEngine.ts` | (search; called from `SubAgentRunner.prepare:251–261`) |
| `RepublicAgentEngineConfig` interface | `src/core/engine/RepublicAgentEngineConfig.ts` | 13–112 |
| `drainPendingMessages` field | `src/core/engine/RepublicAgentEngineConfig.ts` | 103–106 |
| `EventMsg` union | `src/core/protocol/events.ts` | 28–115+ |
| `SubAgentEventRouter` | `src/core/events/SubAgentEventRouter.ts` | 6–46 |
| Default suppressed delta types | `src/core/events/SubAgentEventRouter.ts` | 18–21 |

### Storage layer
| Concern | File | Lines |
|---|---|---|
| `STORE_KEY_PATHS` (must add `task_output_chunks`) | `src/storage/StorageAdapter.ts` | 17–28 |
| `VALID_STORE_NAMES` | `src/storage/StorageAdapter.ts` | 34 |
| IndexedDB `DB_VERSION` (currently 4, bump to 5) | `src/storage/IndexedDBAdapter.ts` | 24 |
| `onupgradeneeded` block | `src/storage/IndexedDBAdapter.ts` | 166–269+ |
| NodeSQLite `CREATE TABLE` + indexes | `src/server/storage/NodeSQLiteAdapter.ts` | 63–86 |
| TauriSQLite migration | `src/desktop/storage/TauriSQLiteAdapter.ts` | (sidecar Rust file — coordinate with desktop maintainer) |
| `StorageQuotaManager` thresholds (extend to tiers) | `src/storage/StorageQuotaManager.ts` | (top of file) |

### Webfront
| Concern | File | Lines |
|---|---|---|
| Store pattern reference | `src/webfront/stores/threadStore.ts` | 10, 48 |
| Event router | `src/webfront/routing/ThreadEventRouter.ts` | (whole file) |
| New: `backgroundTaskStore.ts` | `src/webfront/stores/backgroundTaskStore.ts` | (new) |
| New: badge + panel | `src/webfront/components/BackgroundTasks*.svelte` | (new) |
| New: poll hook | `src/webfront/lib/hooks/usePolledTaskOutput.ts` | (new) |

## Test Plan

For PR #191 to merge, add the following tests:

- **Unit**:
  - `src/core/tasks/__tests__/types.test.ts` — `isTerminalTaskStatus` truth table; type guards.
  - `src/core/tasks/__tests__/TaskOutputStore.test.ts` — chunk splitting at 64 KiB; `getDelta` from offset; eviction; truncation marker behavior.
- **Integration**:
  - `src/core/engine/__tests__/RepublicAgentEngine.background-task.integration.test.ts` — spawn 3 background tasks concurrently, poll outputs, kill one, assert the other two continue and their chunks keep appending.
  - `src/core/__tests__/Session.concurrency-seam.test.ts` — spawn 1 foreground + 2 background tasks; send user interrupt via `RepublicAgent.handleInterrupt`; assert only the foreground task transitioned to `killed`, both background tasks still `running`.
- **Storage**:
  - Extend `src/storage/__tests__/IndexedDBAdapter.test.ts` and `src/server/storage/__tests__/NodeSQLiteAdapter.test.ts` to cover the new `task_output_chunks` store, the three indexes, and `[taskId, seq]` range queries.
- **Quota**:
  - `src/storage/__tests__/StorageQuotaManager.task-output-eviction.test.ts` — fill with chunks across multiple tasks, trigger cleanup at 95%, assert tier 0 evicts oldest first and that the eviction-grace guard skips recently-read non-terminal tasks.

## Out of Scope for PR #191

The following are deferred to Phase 2 and must **not** land in this PR:

- Additional task families (`browser_automation`, `tab_watcher`, `data_extraction`) — designed as Phase 2; types are not even declared in v1's union.
- Retry policy, task TTL, task DAG / parent-child dependency tracking.
- Cross-session task migration / resume after service-worker restart.
- Coordinator-style `SendMessage` between concurrent tasks (handled by Track 06).
- Generic `TaskRegistry` class — v1 keeps task state on `Session.activeTasks` directly. Extracting it becomes worthwhile only when a second family lands.
- Queued-message mid-task injection (`AgentTask.injectUserInput()` real implementation). The stub stays as-is; draining `pendingMessages` between tool rounds is its own follow-up PR.

## What Is Explicitly Out Of Scope (carried over)

- a second execution engine besides `TaskRunner`
- **systematic retry policy** — claudy does not implement automatic retry; failed tasks stay terminal
- **TTL-based cleanup** — claudy has no time-to-live sweep; eviction happens only after `notified === true` AND terminal status (plus the optional `evictAfter` grace window)
- **task DAGs / dependency graphs** — claudy has no parent/child task linkage or dependency tracking; tasks are flat and independent

## Risks

- **Concurrency regression**: relaxing the "abort before spawn" rule in `Session.spawnTask` is the highest-risk change. The `Session.concurrency-seam.test.ts` integration test gates this.
- **Storage pressure**: task outputs compete with rollout persistence and cache. The 50 MiB per-task cap and tier-0 eviction in `StorageQuotaManager` are the mitigations.
- **Stale async callbacks**: without terminal guards, completion and abort paths will race. The `isTerminalTaskStatus` guard in every `Session.activeTasks` mutation site is the mitigation.
- **Status-rename churn**: renaming `initializing -> pending` and `cancelled -> killed` touches several files; do the rename in its own commit inside the PR so reviewers can read the diff cleanly.
- **Rust migration coupling**: the Tauri/Rust migration for `task_output_chunks` ships in the same PR — coordinate with the desktop sidecar maintainer before merging.

## Resolved Design Decisions

The following decisions were made during the 2026-05-13 design pass after gap analysis of the verified-wiring research. Each shapes a specific section of the implementation.

### Q1 — `RunningTask` enriched with `taskState` field (one record per task)

`Session.activeTasks` holds enriched `RunningTask` records that carry both the runtime handles **and** the typed task state side-by-side:

```ts
interface RunningTask {
  kind: TaskKind;
  abortController: AbortController;
  task: SessionTask;
  promise: Promise<string | null>;
  startTime: number;
  taskState: BackgroundAgentTaskState;  // NEW — typed state alongside the machinery
  context?: AgentContext;               // present for background_agent tasks
  scopedTabIds?: number[];              // see Q9 — for tab-scoped abort
}
```

`Session.listActiveTasks(): RunningTask[]` returns the full records (internal). `Session.listTaskStates(): TaskState[]` projects just the `taskState` half (for UI and `engine.listTaskStates()`). This matches claudy's pattern where `LocalAgentTaskState.abortController?` is a field on the typed state, cleared on terminal (`LocalAgentTask.tsx:495`).

### Q2 — `SubAgentRunner.prepare` instantiates `BackgroundAgentTaskState`

`SubAgentRunner.prepare` (`src/tools/AgentTool/SubAgentRunner.ts:205–349`) is the place where `BackgroundAgentTaskState` gets built — it already has every input in scope (`prompt`, `description`, `parentEngine`, `typeConfig`). It then calls a thin new `Session.registerTaskState(state, runningTaskBits)` to insert into `Session.activeTasks`:

```ts
// inside SubAgentRunner.prepare, after creating AgentContext
const taskState: BackgroundAgentTaskState = {
  id: runId,                          // identity collapse: runId === taskState.id
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
parentEngine.getSession().registerTaskState(taskState, { context, scopedTabIds });
```

`Session.registerTaskState` is a thin method that builds the `RunningTask` and inserts into `activeTasks`. SubAgentRunner stays responsible for the sub-agent-specific fields; Session owns the map mutation (single transaction boundary).

### Q3 — Foreground tasks do NOT write to `TaskOutputStore`

Only background sub-agent tasks write chunks. The main session's output is already in the conversation message stream the user sees — persisting it again to `task_output_chunks` would be pure duplication. Concrete wiring: when `RegularTask.run` (foreground) creates an `AgentTask`, it passes `taskOutputStore: undefined`. When `SubAgentRunner.prepare` (background) builds the child engine config, it passes `taskOutputStore: this.parentEngine.getTaskOutputStore()`. The `TaskOptions.taskOutputStore?` is optional precisely so foreground can skip it; all `appendChunk` calls in `TaskRunner` are guarded.

### Q4 — `TaskTokenUsage` canonical shape; rename `TaskState.tokenUsage` → `tokenBudget`

See [Type Model > Token-usage shape consolidation](#token-usage-shape-consolidation). Two clearly-named concepts replace the four overlapping shapes today:

- **`tokenUsage: TaskTokenUsage`** = cumulative consumption (input/output/cached/total).
- **`tokenBudget`** = remaining-capacity / compaction trigger.

Rename ships in the same commit as the status-rename so all type churn is in one diff.

### Q5 — `pendingMessages` stays on `SubAgentRegistry`

`SubAgentRegistry.pendingMessages: Map<runId, string[]>` is already wired through `queueMessage` (used by the `send_message` tool) and `drainMessages` (called via `RepublicAgentEngineConfig.drainPendingMessages` at `SubAgentRunner.ts:260`). Track 04 does **not** add a `pendingMessages` field to `BackgroundAgentTaskState` — would create two queues to keep in sync for no behavioral gain. If the UI needs a count, it queries `registry.peekMessages(runId).length`.

This deviates from claudy's pattern (which has `pendingMessages` on `LocalAgentTaskState`), but BrowserX's existing wiring is correct and migrating it has zero functional payoff in PR #191.

### Q6 — Background tasks resolve `promise` to `null` immediately

`SessionTask.run()` keeps its `Promise<string | null>` signature unchanged. Background tasks resolve the promise to `null` synchronously upon launch — there's no "final assistant message" to return because the task is still running. The actual result flows through:

1. **Output chunks** written to `TaskOutputStore` (pollable via `engine.getTaskOutput`).
2. **The `<task-notification>` XML** injected into the parent's message stream when the task settles.
3. **The `TaskTerminated` event** for UI subscribers.

Callers waiting on `RunningTask.promise` for a background task get `null` right away and must read chunks / wait for the notification for actual results. This matches claudy's model where results flow through the inbox, not return values.

### Q7 — `handleTaskAbort` pending-state policy

When `Session.abortTask` (or the new `abortTasksForTab`) interrupts a task, the old task's pending state is handled as follows:

- **Pending approvals** (`ActiveTurn.pendingApprovals` for the task being aborted): resolve each one with `'deny'` before calling `abortController.abort()`. This lets the task's runner see the denial, propagate it back to the tool call, and shut down cleanly instead of being torn down mid-await.
- **Pending user input** (`ActiveTurn.pendingInput` if the aborted task is foreground): drop it. The user's *new* submission is what they intended; older buffered input represented a different intent.

Both cases happen synchronously inside `handleTaskAbort`, before the abort signal fires.

### Q8 — `StorageQuotaManager` calls a constructor-injected `tieredEvictor`

`StorageQuotaManager` does not gain a hard dependency on `TaskOutputManager`. Instead it accepts an injected `tieredEvictor`:

```ts
interface TieredEvictor {
  evictTier(tier: 0 | 1 | 2, target: number): Promise<number>;
}

new StorageQuotaManager({
  warningThreshold: 80,
  criticalThreshold: 95,
  tieredEvictor: appLevelEvictor,  // wired at service-worker startup
});
```

When the quota monitor crosses `criticalThreshold`, it calls `tieredEvictor.evictTier(0, bytesNeeded)` and escalates to tier 1 only if tier 0 under-fills. The concrete `tieredEvictor` is wired once at service-worker startup with knowledge of `TaskOutputManager` and `cache_items` — `StorageQuotaManager` stays unaware of specifics.

### Q9 — Tab-close granularity: `scopedTabIds` + `abortTasksForTab`

The current `service-worker.ts:128` does a blanket `abortAllTasks('TabClosed')` whenever any tab the session uses closes. That's too aggressive — closing a working tab shouldn't kill an unrelated background research task. Track 04 introduces:

- New field on `RunningTask.scopedTabIds: number[]` recording which tabs the task actively uses (populated at spawn from `params.browserContext.tabId`, and updated by tools that change tabs).
- New method `Session.abortTasksForTab(tabId, reason): Promise<void>` — walks `activeTasks` and aborts only those where `scopedTabIds.includes(tabId)`.
- The service worker's `chrome.tabs.onRemoved` handler:
  - If the closing tab is the **chat-panel tab** (the one holding the AgentSession's UI) → keep `abortAllTasks('TabClosed')` (session itself is going away).
  - If the closing tab is a **working tab** (referenced by `scopedTabIds`) → call `abortTasksForTab(tabId, 'TabClosed')` so unrelated tasks survive.

Detection of "is this the chat-panel tab" comes from `AgentSession.uiTabId` (chat panel registers this on session start). The `abortAllTasks` call at `service-worker.ts:128` becomes a switch on `tabId === session.uiTabId`.

### Q10 — Badge mounted in top of chat page

`BackgroundTasksBadge.svelte` mounts in the existing top-bar component in `src/webfront/pages/chat/` (specifically next to the title/model area — typically a `ChatHeader.svelte` or equivalent layout component). Not the global app shell — background tasks are conceptually scoped to a chat conversation; showing the badge on settings/scheduler/etc. is noise. Not the message input area — too cramped. Not floating — fights other UI patterns.

Implementer follows existing top-bar component patterns in the chat page (look at where the model-selector pill currently lives) rather than inventing layout.

## Implementation Sequence (inside PR #191)

1. Status rename (`initializing -> pending`, `cancelled -> killed`) as a standalone commit.
2. Add `src/core/tasks/types.ts` (`TaskType`, `TaskStateBase`, `BackgroundAgentTaskState`, `isTerminalTaskStatus`, ID generation).
3. Add storage store across all three adapters + Rust migration; add `TaskOutputStore` and unit tests.
4. Wire quota tier 0 + eviction grace; add `StorageQuotaManager` test.
5. Patch `Session.spawnTask` concurrency seam + add `activeTasks`/`foregroundTaskId`/`abortTask`/`listActiveTasks`; update call sites per the table above; add `Session.concurrency-seam.test.ts`.
6. Add `RepublicAgentEngine.getTaskOutput` / `listTaskStates` and the four new event types via `SubAgentEventRouter`.
7. Wire `TaskRunner` chunk emission + on-abort flush.
8. Add UI badge + panel + `usePolledTaskOutput`.
9. Final integration test sweep (`background-task.integration.test.ts`).

## Validation Notes (re-checked vs both codebases 2026-05-13)

The doc was re-validated against the BrowserX working tree on 2026-05-13. The following corrections / additions were applied beyond the original 2026-05-11 claudy pass:

1. **Line-number drift fixed**. `Session.spawnTask` is at `1332–1394` (not `1316–1357`); the `abortAllTasks` call inside it is at line `1339` (not `1323`); `abortAllTasks` impl is at `1288–1300`; `interruptTask` is at `1402–1404`. All other tables updated to match.
2. **Call-site table corrected**. `abortAllTasks` is called from `Session.ts:1339,1403`, `RepublicAgent.ts:699`, `services/agent-services.ts:84`, `extension/background/service-worker.ts:128,601`. Earlier doc had `RepublicAgent.ts:443,824` and `registry/AgentSession.ts:225,454` — those references don't match the current tree.
3. **`RunningTask` shape sourced**. Defined at `src/core/session/state/types.ts:23–38`. Quoted verbatim in [Concurrency Seam Patch](#concurrency-seam-patch).
4. **`drainPendingMessages` is already partially wired**. `TaskOptions.drainPendingMessages` exists at `TaskRunner.ts:67`; it's called at `runLoop` line 304–310; `SubAgentRunner.prepare` wires it to `registry.drainMessages(runId)` at `SubAgentRunner.ts:260`. Track 04 does not need to add this — only the output-store side is new.
5. **BrowserX's notification XML differs from claudy's**. BrowserX uses `<run-id>` (not `<task-id>`), and the injection mechanism is `parentEngine.enqueueSyntheticUserTurn(text)` (not a global command queue). Added [Notification Format Reconciliation](#notification-format-reconciliation) section with the merged shape and the decision to keep `<run-id>`.
6. **`AgentContext.cancelled` is the existing suppression gate**. Set by `cancel_sub_agent` at `managementTools.ts:110` before `engine.dispose()`; checked inside the IIFE at `SubAgentRunner.ts:127`. Track 04 must preserve this ordering in `Session.abortTask`'s handle-abort path. Added [AgentContext.cancelled coordination](#agentcontextcancelled-coordination).
7. **`StorageQuotaManager` is threshold-only today, not tier-based**. Added [StorageQuotaManager Tier Extension](#storagequotamanager-tier-extension) with the minimal `evictTier(n, targetBytes)` API to introduce.
8. **Eviction mechanism was under-specified**. Added [Eviction Mechanism](#eviction-mechanism) with the timer location, gate conditions (`notified && terminal && (!retain || past evictAfter)`), and the `retainTask` engine API needed by `BackgroundTaskPanel.svelte` mount/unmount.
9. **Status-rename touchpoints enumerated**. Full file:line table added at [Status Rename Touchpoint Table](#status-rename-touchpoint-table). The TaskStatus rename is 4 `'initializing'` sites + 13 `'cancelled'` sites; ~17 lines plus tests. A separate commit is recommended so the diff is reviewable.
10. **DB_VERSION is currently 4**, not 5 — the design's "bump to 5" is correct; just flagging the starting point.
11. **Webfront is Svelte, not React**. UI section updated to use Svelte stores (`writable`/`derived`), `ThreadEventRouter`, and `onMount`/`onDestroy` lifecycle for `retain` flag management.
12. **`TaskRunner` injection points enumerated by line**. The `runLoop` (`267–393`) has clearly demarcated anchors at lines 276, 288, 304, 313, 318, 338, 339, 347, 350, 357 — every chunk emission goes at a specific one. See [TaskRunner Wiring](#taskrunner-wiring).

## Validation Notes (re-checked vs claudy 2026-05-11)

The doc was re-validated against claudy source on 2026-05-11. The following corrections were applied:

1. **Family taxonomy clarified** — Added a "Family Taxonomy Note" up front. BrowserX's `background_agent` / `browser_automation` / `tab_watcher` / `data_extraction` are BrowserX-specific. Claudy's actual `TaskType` is `'local_bash' | 'local_agent' | 'remote_agent' | 'in_process_teammate' | 'local_workflow' | 'monitor_mcp' | 'dream'`. What we borrow is the registry + state-machine pattern, not the family list. (Source: `Task.ts`, `tasks/types.ts`.)

2. **Storage model corrected** — Claudy uses **filesystem append + an in-memory pipe buffer (~8 MB default)**, not IndexedDB chunk aggregation. There is no `TaskOutputStore` class to port. BrowserX must invent the chunked-storage layer itself; only the delta-polling API (offset-tracked `getOutputDelta()`) is portable. (Source: `utils/task/TaskOutput.ts`.)

3. **No central scheduler in claudy** — Added section 3b clarifying claudy stores all tasks in a flat `AppState.tasks` dict with no orchestrator and no "abort all on spawn." Multiple `local_agent` / `in_process_teammate` tasks run concurrently. BrowserX's `Session.spawnTask()` abort behavior is a BrowserX-specific bottleneck. (Source: `Task.ts`, `tasks/LocalAgentTask/LocalAgentTask.tsx`.)

4. **Single dict vs two containers** — Added a note that claudy uses one flat dict + an `isBackgrounded` flag (`LocalAgentTask.tsx:134`). BrowserX's two-container approach is justified by `ActiveTurn` already owning foreground-only state (approvals, pending input), but the simpler alternative was called out.

5. **Polling constants confirmed** — `POLL_INTERVAL_MS = 1000`, `STOPPED_DISPLAY_MS = 3000`, `PANEL_GRACE_MS = 30000` all match `utils/task/framework.ts`.

6. **Queued-message draining pattern** — Added a note that claudy uses a `pendingMessages` array drained at turn boundaries via `drainPendingMessages()`, mutated through `updateTaskState()` for atomicity. BrowserX should match by draining inside `TaskRegistry.update()`.

7. **Out-of-scope items confirmed** — Claudy does **not** implement systematic retry, TTL cleanup, or task DAGs. Eviction is gated only on `notified === true` + terminal status. BrowserX's design correctly scopes these out; the out-of-scope list was extended to make this explicit.

**Sources cited**: `Task.ts`, `tasks/types.ts`, `utils/task/TaskOutput.ts`, `utils/task/framework.ts`, `tasks/LocalAgentTask/LocalAgentTask.tsx`.
