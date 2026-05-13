# Track 04: Typed Task Families - Tasks

> Scope: ship the `background_agent` typed-task vertical slice **inside PR #191** (`design-sub-agent` -> `agent-improvements`). Each section maps to a section in `design.md`. Out-of-scope items are listed at the bottom.

## 1. Type Alignment

**Modify (status rename, single commit):**

- [ ] `src/core/AgentTask.ts` — rename `TaskStatus` literals: `initializing -> pending`, `cancelled -> killed`. Update all setters and consumers.
- [ ] `src/core/TaskRunner.ts` — same rename in `TaskState`, `TaskResult`, status writes.
- [ ] `src/core/engine/RepublicAgentEngine.ts` — update any string comparisons or event payloads that reference old literals.
- [ ] `src/tools/AgentTool/SubAgentRunner.ts` — update string comparisons against status literals.
- [ ] `src/core/__tests__/AgentTask.test.ts`, `src/core/__tests__/TaskRunner.test.ts` — update expectations.
- [ ] Rollout reader: add a one-time read-side mapping (old -> new) for any persisted `cancelled`/`initializing` strings.

**New file:** `src/core/tasks/types.ts`

- [ ] Define `TaskType = 'background_agent'` (single family for v1).
- [ ] Define `TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'`.
- [ ] Implement `isTerminalTaskStatus(status)`.
- [ ] Define `TaskStateBase` with `id`, `type`, `status`, `description`, `toolUseId?`, `startTime`, `endTime?`, `outputOffset`, `notified`, `isBackgrounded`.
- [ ] Define `BackgroundAgentTaskState extends TaskStateBase` (`parentSessionId`, `prompt`, `tokenBudget?`, `lastAgentMessage?`, `toolUseCount`, `tokenUsage`).
- [ ] Export `TaskState = BackgroundAgentTaskState` (union; grows in Phase 2).
- [ ] Implement Web-Crypto-based `generateTaskId('background_agent')` returning `a${8-char base36}`.
- [ ] Add type guard `isBackgroundAgentTask(t)`.

**New file:** `src/core/tasks/timing.ts`

- [ ] Export `POLL_INTERVAL_MS = 1000`, `STOPPED_DISPLAY_MS = 3000`, `PANEL_GRACE_MS = 30000`, `EVICTION_GRACE_MS = 5 * 60_000`, `TASK_OUTPUT_PER_TASK_CAP_BYTES = 50 * 1024 * 1024`.

## 2. Storage

**Modify:** `src/storage/StorageAdapter.ts`

- [ ] Add `task_output_chunks: 'chunkId'` to `STORE_KEY_PATHS` (lines 17–28).
- [ ] Add `task_output_chunks` to `VALID_STORE_NAMES`.

**Modify:** `src/storage/IndexedDBAdapter.ts`

- [ ] Bump `DB_VERSION` to 5.
- [ ] In `onupgradeneeded` (lines 166–196), create `task_output_chunks` object store with `keyPath: 'chunkId'`.
- [ ] Create indexes: `taskId`, `[taskId, seq]`, `createdAt`.

**Modify:** `src/server/storage/NodeSQLiteAdapter.ts`

- [ ] Add `CREATE TABLE task_output_chunks (chunk_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)` to the `CREATE TABLE` block (lines 62–86).
- [ ] Add `CREATE INDEX` for `task_id`, `(task_id, seq)`, `created_at`.

**Modify:** `src/desktop/storage/TauriSQLiteAdapter.ts`

- [ ] Coordinate the corresponding Rust-side migration in the desktop sidecar. Flag this in the PR description as the only Rust change.
- [ ] Verify the generic collection passthrough accepts `task_output_chunks`.

**New file:** `src/core/tasks/TaskOutputStore.ts`

- [ ] Define `TaskOutputChunk` (`chunkId`, `taskId`, `seq`, `createdAt`, `kind`, `data`).
- [ ] Implement `appendChunk(taskId, kind, data)` — split data >64 KiB into multiple consecutive `seq` rows; assign next `seq` per task.
- [ ] Implement `getDelta(taskId, fromSeq = 0)` — IndexedDB cursor / SQLite `WHERE task_id = ? AND seq > ? ORDER BY seq`.
- [ ] Implement `streamDelta(taskId, fromSeq, intervalMs = POLL_INTERVAL_MS)` as an async iterable atop polling.
- [ ] Implement `cleanupTask(taskId)` and `cleanupSession(sessionId)`.
- [ ] Internal: per-task in-memory write queue with splice-on-drain semantics.

**Tests:**

- [ ] `src/core/tasks/__tests__/types.test.ts` — `isTerminalTaskStatus` truth table; ID format; type guards.
- [ ] `src/core/tasks/__tests__/TaskOutputStore.test.ts` — chunk splitting at 64 KiB; `getDelta` from offset; multi-writer ordering.
- [ ] Extend `src/storage/__tests__/IndexedDBAdapter.test.ts` and `src/server/storage/__tests__/NodeSQLiteAdapter.test.ts` to cover the new store + range queries on `[taskId, seq]`.

## 3. Quota

**New file:** `src/core/tasks/TaskOutputManager.ts`

- [ ] Implement `evictOldestChunks(targetBytes): Promise<number>` — order by `(createdAt, taskId, seq)`; `batchDelete` until target reached; return bytes freed.
- [ ] Maintain in-memory `lastReadAt: Map<taskId, number>` updated on every `getDelta`.
- [ ] Eviction skip rule: skip taskIds whose `lastReadAt > now - EVICTION_GRACE_MS` AND whose status is non-terminal.

**Modify:** `src/storage/StorageQuotaManager.ts` (lines 131–162)

- [ ] Insert `TaskOutputManager.evictOldestChunks` as **tier 0**, before existing rollouts -> cache-expired -> cache-full-clear tiers.
- [ ] Pass remaining `targetBytes` to subsequent tiers if tier 0 underfills.

**Tests:**

- [ ] `src/storage/__tests__/StorageQuotaManager.task-output-eviction.test.ts` — fill with chunks across multiple tasks; trigger 95% cleanup; assert oldest evicted first; assert eviction-grace skip works.

## 4. Concurrency Seam

**Modify:** `src/core/Session.ts`

- [ ] Add `private activeTasks: Map<string, RunningTask> = new Map()`.
- [ ] Add `private foregroundTaskId: string | null = null`.
- [ ] In `spawnTask` (lines 1316–1357): **REMOVE** `await this.abortAllTasks('UserInterrupt')` at line 1323.
- [ ] Update `spawnTask` signature to accept `opts: { background?: boolean } = {}`.
- [ ] Foreground branch: if `foregroundTaskId` is set, `await this.abortTask(this.foregroundTaskId, 'UserInterrupt')` first; then set `foregroundTaskId = subId`.
- [ ] Background branch: do not touch `foregroundTaskId`; do not abort siblings.
- [ ] Insert created `RunningTask` into `this.activeTasks` (alongside existing `registerNewActiveTask`).
- [ ] Add `abortTask(id, reason)` — looks up in `activeTasks`, calls existing abort handler, removes from map, clears `foregroundTaskId` if it matches.
- [ ] Add `listActiveTasks(): RunningTask[]` and `getTask(id): RunningTask | undefined`.
- [ ] Update `onTaskFinished()` and `onTaskAborted()` to also remove from `activeTasks` and clear `foregroundTaskId` if matching.
- [ ] Keep `abortAllTasks` (lines 1272+) unchanged as a backward-compat shim for hard-shutdown paths.

**Modify:** `src/core/RepublicAgent.ts`

- [ ] At line 443 (`handleInterrupt`): replace `abortAllTasks` with `if (session.foregroundTaskId) await session.abortTask(session.foregroundTaskId, 'UserInterrupt')`. Background tasks must keep running.
- [ ] At line 824: review; keep `abortAllTasks` if it is a hard-shutdown path.

**Leave unchanged (kept hard-shutdown call sites):**

- [ ] `src/core/Session.ts:1366` (`interruptTask`)
- [ ] `src/core/registry/AgentSession.ts:225` (tab closed)
- [ ] `src/core/registry/AgentSession.ts:454` (explicit stop)
- [ ] `src/service-worker.ts:126, 599` (system cleanup)

**Tests:**

- [ ] `src/core/__tests__/Session.concurrency-seam.test.ts` — spawn 1 foreground + 2 background; user interrupt; assert only foreground transitions to `killed`.
- [ ] `src/core/__tests__/Session.spawn-replacement.test.ts` — spawn foreground A, then foreground B; assert A is `killed` and B is `running`.
- [ ] `src/core/__tests__/Session.background-isolation.test.ts` — spawn 3 background tasks; abort one by id; assert the other two still `running`.

## 5. Engine API

**Modify:** `src/core/engine/RepublicAgentEngine.ts`

- [ ] Add `async getTaskOutput(taskId, fromSeq = 0): Promise<TaskOutputChunk[]>` — wraps `TaskOutputStore.getDelta`.
- [ ] Add `listTaskStates(): TaskState[]` — projects `session.activeTasks` plus terminal-but-unevicted entries.

**Modify:** `src/core/engine/RepublicAgentEngineConfig.ts`

- [ ] Add optional `taskOutputStore?: TaskOutputStore` field.

**Modify:** `src/core/events/SubAgentEventRouter.ts`

- [ ] Route four new events through the existing `_subAgent` namespace: `TaskStarted`, `TaskOutputDelta` (metadata only), `TaskStateChanged`, `TaskTerminated`.
- [ ] Default-suppress `TaskOutputDelta` for non-debug consumers (mirrors existing Delta suppression).

## 6. TaskRunner Wiring

**Modify:** `src/core/TaskRunner.ts`

- [ ] Accept optional `taskOutputStore` via `TaskOptions`.
- [ ] At each turn boundary, `await taskOutputStore.appendChunk(taskId, 'event', JSON.stringify(turnSummary))`.
- [ ] After assistant text emitted, `await taskOutputStore.appendChunk(taskId, 'message', assistantMessage)`.
- [ ] Tool call output (stdout / stderr) routes through `appendChunk(..., 'stdout' | 'stderr', ...)`.
- [ ] On abort or thrown error, flush in-memory queue before resolving the run promise.

**Modify:** `src/core/AgentTask.ts`

- [ ] Plumb `taskOutputStore` from engine config through to `TaskRunner.run()`.

## 7. UI

**New files in `src/webfront/`:**

- [ ] `lib/hooks/usePolledTaskOutput.ts` — Svelte store; polls `engine.getTaskOutput(taskId, lastSeq)` every `POLL_INTERVAL_MS`; returns `{ chunks, status, error }`.
- [ ] `components/BackgroundTasksBadge.svelte` — count + dropdown driven by polled `engine.listTaskStates()`.
- [ ] `components/BackgroundTaskPanel.svelte` — opens for a `taskId`; renders chunks newest-first with `kind` styling; auto-hides `STOPPED_DISPLAY_MS` after terminal status; evicts after `PANEL_GRACE_MS`.
- [ ] Mount `BackgroundTasksBadge` in the existing top-bar surface (verify exact mount point during implementation).

## 8. Tests (consolidated checklist — referenced from sections above)

- [ ] `src/core/tasks/__tests__/types.test.ts`
- [ ] `src/core/tasks/__tests__/TaskOutputStore.test.ts`
- [ ] `src/storage/__tests__/IndexedDBAdapter.test.ts` (extend)
- [ ] `src/server/storage/__tests__/NodeSQLiteAdapter.test.ts` (extend)
- [ ] `src/storage/__tests__/StorageQuotaManager.task-output-eviction.test.ts`
- [ ] `src/core/__tests__/Session.concurrency-seam.test.ts`
- [ ] `src/core/__tests__/Session.spawn-replacement.test.ts`
- [ ] `src/core/__tests__/Session.background-isolation.test.ts`
- [ ] `src/core/engine/__tests__/RepublicAgentEngine.background-task.integration.test.ts`

## 9. Migration / Cleanup

- [ ] Audit any references to `RegularTask` that are no longer reachable once background-agent state lives in `Session.activeTasks`; do **not** delete `RegularTask` itself — it remains the foreground default.
- [ ] Document explicitly **not** touched (other tracks): the `TaskRegistry` extraction (deferred until a second family lands), `AgentTask.injectUserInput` real implementation, scheduler-triggered spawning.
- [ ] PR description must call out the Rust migration in `TauriSQLiteAdapter` and the `DB_VERSION` bump for IndexedDB.

## Later Follow-Ups (Phase 2, NOT in PR #191)

- [ ] Implement real executors for `browser_automation`, `tab_watcher`, `data_extraction`.
- [ ] Extract `TaskRegistry` once a second family exists.
- [ ] Implement real `AgentTask.injectUserInput()` and drain `pendingMessages` between tool rounds in `TurnManager.executeToolCall()`.
- [ ] Service-worker restart recovery for in-flight background tasks.
- [ ] Cross-task `SendMessage` coordination (Track 06).
