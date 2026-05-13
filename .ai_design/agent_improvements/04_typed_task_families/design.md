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
}

export interface BackgroundAgentTaskState extends TaskStateBase {
  type: 'background_agent';
  parentSessionId: string;
  prompt: string;
  tokenBudget?: TokenBudget;
  lastAgentMessage?: string;
  toolUseCount: number;
  tokenUsage: { input: number; output: number };
}

export type TaskState = BackgroundAgentTaskState;  // union grows as families are added

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'killed';
}
```

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

This is the most load-bearing change in the PR. The current `Session.spawnTask` (`src/core/Session.ts:1316–1357`) unconditionally aborts every running task on every spawn (line 1323). Background sub-agent tasks introduced by PR #191 cannot survive that. Fix:

```ts
// src/core/Session.ts (changes summarized)
private activeTasks: Map<string, RunningTask> = new Map();
private foregroundTaskId: string | null = null;

async spawnTask(
  task: SessionTask,
  context: TurnContext,
  subId: string,
  input: InputItem[],
  opts: { background?: boolean } = {}
): Promise<void> {
  // REMOVED: await this.abortAllTasks('UserInterrupt');
  if (!opts.background) {
    if (this.foregroundTaskId) {
      // foreground replacement: abort just the prior foreground task
      await this.abortTask(this.foregroundTaskId, 'UserInterrupt');
    }
    this.foregroundTaskId = subId;
  }
  // ... existing AbortController + RunningTask creation, registerNewActiveTask ...
  this.activeTasks.set(subId, runningTask);
}

async abortTask(id: string, reason: TurnAbortReason): Promise<void> {
  const t = this.activeTasks.get(id);
  if (!t) return;
  await this.handleTaskAbort(id, t, reason);
  this.activeTasks.delete(id);
  if (this.foregroundTaskId === id) this.foregroundTaskId = null;
}

listActiveTasks(): RunningTask[] { return [...this.activeTasks.values()]; }
getTask(id: string): RunningTask | undefined { return this.activeTasks.get(id); }
```

The internal per-turn `Map<string, RunningTask>` already kept in `ActiveTurn.tasks` (`src/core/session/state/ActiveTurn.ts:15`) stays for foreground turn semantics (approvals / pending input). `Session.activeTasks` is the new authoritative cross-turn registry.

### `abortAllTasks` call sites

| Site | Action |
|---|---|
| `src/core/Session.ts:1323` (inside `spawnTask`) | **REMOVE** — this is the bottleneck |
| `src/core/Session.ts:1366` (`interruptTask`) | KEEP — narrow this later if needed; user-driven interrupt |
| `src/core/RepublicAgent.ts:443` (`handleInterrupt`) | KEEP — but only kill the foreground task; leave background tasks running. Implementation: replace with `if (session.foregroundTaskId) session.abortTask(session.foregroundTaskId, 'UserInterrupt')` |
| `src/core/RepublicAgent.ts:824` | KEEP — review during PR; likely safe to leave |
| `src/core/registry/AgentSession.ts:225` (tab closed) | KEEP — tab close is a hard shutdown |
| `src/core/registry/AgentSession.ts:454` (explicit stop) | KEEP — explicit stop is a hard shutdown |
| `src/service-worker.ts:126, 599` | KEEP — system cleanup paths |

`abortAllTasks` itself stays in `Session.ts` as a backward-compat shim used by the kept call sites; new background spawns simply do not trigger it.

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

`src/core/TaskRunner.ts`:

- Inject an optional `TaskOutputStore` via `TaskOptions`.
- At each turn boundary, call `taskOutputStore.appendChunk(taskId, 'event', JSON.stringify(turnSummary))` and `appendChunk(taskId, 'message', assistantMessage)` for the assistant text.
- On abort or thrown error, flush any in-memory queued chunks before resolving the run promise so polling consumers see the tail.
- Tool-call output (stdout/stderr from MCP tools etc.) routes through `appendChunk(..., 'stdout' | 'stderr', ...)`.

`src/core/AgentTask.ts`:

- Plumb the `TaskOutputStore` from `RepublicAgentEngineConfig.taskOutputStore` (new optional field) through to `TaskRunner` via `run()`.

## UI Surface

Minimum to ship in PR #191 (Svelte components in `src/webfront/`):

- `BackgroundTasksBadge.svelte` — subscribes to `engine.listTaskStates()` (polled at `POLL_INTERVAL_MS = 1000`); renders count + dropdown of background tasks with status pill.
- `BackgroundTaskPanel.svelte` — opens for a given `taskId`; polls `engine.getTaskOutput(taskId, lastSeq)` every `POLL_INTERVAL_MS = 1000`; renders chunks newest-first with `kind` styling.
- `usePolledTaskOutput(taskId)` Svelte store (in `src/webfront/lib/hooks/`) — returns `{ chunks, status, error }`.
- Hide the panel `STOPPED_DISPLAY_MS = 3000` after terminal state; evict from the UI list after `PANEL_GRACE_MS = 30000`.

These three constants must live in `src/core/tasks/timing.ts` so the engine and the UI share them.

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
