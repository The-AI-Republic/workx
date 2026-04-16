# Track 04: Typed Task Families - Tasks

> This track is now implementation-ready only as a `background_agent` vertical slice built on a generic typed-task registry. Do not start by trying to land all four family executors at once.

## Phase 1: Generic Task Types

**New file:** `src/core/tasks/types.ts`

- [ ] Define `BrowserXTaskType` as `'background_agent' | 'browser_automation' | 'tab_watcher' | 'data_extraction'`
- [ ] Define `BrowserXTaskStatus` as `'pending' | 'running' | 'completed' | 'failed' | 'killed'`
- [ ] Implement `isTerminalTaskStatus(status)`
- [ ] Define `TaskStateBase` with `id`, `type`, `status`, `description`, `submissionId`, `sessionId`, `startTime`, `endTime?`, `outputStoreKey?`, `outputOffset`, `notified`
- [ ] Implement Web Crypto based `generateTaskId(type)`
- [ ] Add concrete state interfaces for:
- [ ] `BackgroundAgentTaskState`
- [ ] `BrowserAutomationTaskState`
- [ ] `TabWatcherTaskState`
- [ ] `DataExtractionTaskState`
- [ ] Export `BrowserXTaskState` discriminated union
- [ ] Add type guards for each family
- [ ] Add `isBackgroundTask(task)` using Claudy's `isBackgrounded === false` exclusion rule
- [ ] Add unit tests for ID prefixes, uniqueness, terminal guard, and type guards

## Phase 2: Session State Extensions

**Modify:** `src/core/session/state/types.ts`

- [ ] Extend `TaskKind` with `BackgroundAgent`, `BrowserAutomation`, `TabWatcher`, `DataExtraction`
- [ ] Extend `RunningTask` with optional `taskId` and `background`
- [ ] Add tests covering the new `TaskKind` values and `RunningTask` shape

## Phase 3: Task Registry

**New file:** `src/core/tasks/TaskRegistry.ts`

- [ ] Implement in-memory typed task registry keyed by task ID
- [ ] Add `register(task)` with re-registration merge for `retain`, `pendingMessages`, and `startTime`
- [ ] Add generic `update(taskId, updater)` with same-reference no-op optimization
- [ ] Add `transitionToRunning(taskId)`
- [ ] Add `transitionToTerminal(taskId, status)` with terminal-state protection
- [ ] Add atomic `markNotified(taskId)`
- [ ] Add `tryEvict(taskId)` enforcing:
- [ ] terminal state
- [ ] `notified === true`
- [ ] `evictAfter <= now` when the task has retain semantics
- [ ] Add `poll()` for output delta scans and eviction checks
- [ ] Add getters: `get`, `list`, `listBackground`
- [ ] Add unit tests for transition guards, notification dedupe, re-registration, and eviction rules

## Phase 4: Task Output Persistence

**New file:** `src/core/tasks/TaskOutputStore.ts`

- [ ] Define `TaskOutputRecord` with `taskId`, `sessionId`, `chunks`, `totalBytes`, `capped`, `updatedAt`
- [ ] Implement non-blocking `append(taskId, sessionId, content)`
- [ ] Implement queue-splice drain logic so written chunks are released promptly
- [ ] Implement `flush(taskId)`
- [ ] Implement `getOutputDelta(taskId, fromOffset)`
- [ ] Implement `getOutput(taskId, maxBytes?)`
- [ ] Implement `evict(taskId)` for in-memory buffers only
- [ ] Implement `cleanup(taskId)` and `cleanupSession(sessionId)`
- [ ] Enforce 100 MB default per-task output cap
- [ ] Add quota-aware behavior using `StorageQuotaManager` at drain boundaries
- [ ] Add unit tests for append, flush, multiple deltas, truncation marker, and session cleanup

## Phase 5: Storage Backend Wiring

**Modify:** `src/storage/StorageAdapter.ts`

- [ ] Add `task_outputs: 'taskId'` to `STORE_KEY_PATHS`
- [ ] Ensure `by_session` is valid for `task_outputs`

**Modify:** `src/storage/IndexedDBAdapter.ts`

- [ ] Add `STORE_NAMES.TASK_OUTPUTS`
- [ ] Bump `DB_VERSION`
- [ ] Create `task_outputs` object store with keyPath `taskId`
- [ ] Create `by_session` index on `sessionId`
- [ ] Add tests proving the store and index exist after migration

**Modify:** `src/server/storage/NodeSQLiteAdapter.ts`

- [ ] Add `task_outputs` to `ADAPTER_STORES`
- [ ] Add `by_session` index support for the new store
- [ ] Add tests for CRUD and `queryByIndex('by_session')`

**Modify:** `src/desktop/storage/TauriSQLiteAdapter.ts`

- [ ] Verify `task_outputs` works through the generic collection path
- [ ] Add or update tests if desktop storage tests exist for collection passthrough

## Phase 6: Session Concurrency Seam

**Modify:** `src/core/Session.ts`

- [ ] Add `backgroundTasks: Map<string, RunningTask>`
- [ ] Add `taskRegistry: TaskRegistry`
- [ ] Add `abortForegroundTasks()` without removing `abortAllTasks()`
- [ ] Add `abortBackgroundTask(taskId)`
- [ ] Add `getBackgroundTasks()`
- [ ] Update `spawnTask(...)` to accept `options?: { background?: boolean; taskId?: string }`
- [ ] Foreground path must still abort current foreground tasks
- [ ] Background path must not abort existing foreground work
- [ ] Update `onTaskFinished()` to remove the task from the correct container and transition typed state
- [ ] Update `onTaskAborted()` to remove the task from the correct container and transition typed state
- [ ] Start registry polling during session lifecycle and stop it on shutdown/dispose
- [ ] Add tests for:
- [ ] foreground spawn still replacing foreground work
- [ ] background spawn preserving foreground work
- [ ] multiple concurrent background tasks
- [ ] targeted background abort

## Phase 7: `background_agent` Executor

**New file:** `src/core/tasks/BackgroundAgentTask.ts`

- [ ] Implement `SessionTask`
- [ ] Return `TaskKind.BackgroundAgent`
- [ ] Reuse `AgentTask -> TaskRunner` execution path
- [ ] Register `BackgroundAgentTaskState` before running
- [ ] Mark task running when execution starts
- [ ] Emit terminal transition and lifecycle event on completion/failure
- [ ] Ensure task output and progress updates route through `TaskRegistry` / `TaskOutputStore`
- [ ] Add tests covering execution, cancellation, and terminal event emission

## Phase 8: Event Protocol

**Modify:** `src/core/protocol/events.ts`

- [ ] Add event variants:
- [ ] `BackgroundTaskRegistered`
- [ ] `BackgroundTaskProgress`
- [ ] `BackgroundTaskCompleted`
- [ ] `BackgroundTaskKilled`
- [ ] `TaskBackgrounded`
- [ ] `TaskForegrounded`
- [ ] Add payload interfaces for the new events
- [ ] Route new typed-task events through `Session.sendEvent()` instead of raw emitter-only calls
- [ ] Add protocol guard tests if the repo has matching event guard coverage

## Phase 9: UI Retention Semantics

**Registry-backed behavior, initially for `background_agent` only**

- [ ] Implement `isBackgrounded`
- [ ] Implement `retain`
- [ ] Implement `evictAfter`
- [ ] On terminal transition:
- [ ] set `evictAfter = Date.now() + PANEL_GRACE_MS` when not retained
- [ ] keep `evictAfter = undefined` when retained
- [ ] Add tests for eviction delay and retain blocking eviction

## Phase 10: Queued Message Injection

**Modify:** `src/core/AgentTask.ts`, `src/core/TaskRunner.ts`, `src/core/TurnManager.ts`

- [ ] Decide whether this phase is in-scope for the first implementation PR or a follow-up PR
- [ ] If in scope, replace the `AgentTask.injectUserInput()` stub with a real queue/injection path
- [ ] After each tool call in `TurnManager.executeToolCall()`, drain any `pendingMessages` for the running background task
- [ ] Add tests for mid-task queued user input delivered between tool rounds

## Later Follow-Ups

- [ ] Implement real executors for `browser_automation`
- [ ] Implement real executors for `tab_watcher`
- [ ] Implement real executors for `data_extraction`
- [ ] Integrate scheduler-triggered typed task spawning
- [ ] Add service-worker restart recovery for persisted background tasks
