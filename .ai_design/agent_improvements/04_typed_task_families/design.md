# Track 04: Typed Task Families

## Readiness

The original design was **not ready to implement**.

It had the right direction, but it still had several gaps that would have created churn during coding:

- It assumed BrowserX already had multiple `SessionTask` implementations. It does not. Today there is only [`RegularTask`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/tasks/RegularTask.ts).
- It treated concurrent tasks as a pure type-system change, but the real blocking seam is [`Session.spawnTask()`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/Session.ts:1316), which currently aborts all tasks before every spawn.
- It described storage as if adding one IndexedDB store were enough. In BrowserX, a new store must be reflected across `StorageAdapter`, [`IndexedDBAdapter`](/home/rich/dev/airepublic/open_source/s1/browserx/src/storage/IndexedDBAdapter.ts), [`NodeSQLiteAdapter`](/home/rich/dev/airepublic/open_source/s1/browserx/src/server/storage/NodeSQLiteAdapter.ts), and [`TauriSQLiteAdapter`](/home/rich/dev/airepublic/open_source/s1/browserx/src/desktop/storage/TauriSQLiteAdapter.ts).
- It proposed task events through `session.emitEvent(...)`, but BrowserX also has [`Session.sendEvent()`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/Session.ts:1061) for rollout persistence. The design must specify which path to use.
- It assumed output persistence could be modeled like filesystem append logs. In BrowserX the closest equivalent is append-only chunk aggregation in IndexedDB/SQLite, with quota pressure handled by [`StorageQuotaManager`](/home/rich/dev/airepublic/open_source/s1/browserx/src/storage/StorageQuotaManager.ts).

After the research below, the track is now ready to implement as a **vertical slice**:

1. Define the generic typed-task state model and registry.
2. Implement one real family first: `background_agent`.
3. Wire storage, polling, and lifecycle events for that family.
4. Add the remaining families on top of the same registry once the concurrency path is proven.

That sequencing matches the current codebase much better than trying to land all four families at once.

## Goal

Add typed task families to BrowserX without replacing its current execution stack.

The implementation must extend the existing:

- [`TaskRunner`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/TaskRunner.ts)
- [`AgentTask`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/AgentTask.ts)
- [`Session`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/Session.ts)
- [`ActiveTurn`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/session/state/ActiveTurn.ts)
- [`TurnManager`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/TurnManager.ts)

The design target is not "copy Claudy". The target is "borrow the parts of Claudy that fit BrowserX's browser-extension runtime".

## Claudy Findings That Matter

The useful Claudy patterns are these:

### 1. Typed task state is a discriminated union

Claudy defines a shared base task shape in `/home/rich/dev/study/claudy/src/Task.ts` and then unions concrete families in `/home/rich/dev/study/claudy/src/tasks/types.ts`.

The important properties are:

- Stable task ID independent from transport submission ID
- `type` discriminator
- terminal-state guard
- append-only output offset for delta reads
- `notified` flag for atomic completion notification

That pattern maps cleanly to BrowserX.

### 2. Terminal-state protection is explicit

Claudy's `isTerminalTaskStatus()` and its update helpers consistently reject terminal to non-terminal transitions. That matters because BrowserX already has multiple async paths:

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

The `isBackgrounded`, `retain`, `evictAfter`, and `pendingMessages` fields are the right pattern for BrowserX too, especially once sidepanel UI starts switching between foreground and background task views.

### 4. Output is append-only with delta polling

Claudy's filesystem implementation is not portable to BrowserX, but the behavior is:

- append asynchronously
- keep caller non-blocking
- track read offset
- return deltas
- evict in-memory buffers while preserving persisted output

BrowserX should keep those semantics and swap filesystem append for IndexedDB/SQLite chunk append.

### 5. Re-registration preserves UI-held state

Claudy's registry preserves `retain`, pending messages, and viewed transcript state on re-registration. BrowserX should do the same. Otherwise a resumed or reattached background task will flash, lose its UI state, or duplicate work.

## BrowserX Findings That Matter

### Current execution stack

BrowserX already has substantial task plumbing:

- [`TaskRunner`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/TaskRunner.ts:90) owns the multi-turn execution loop, compaction, token accounting, and `TaskStarted` / `TaskComplete` / `TurnAborted` emission.
- [`AgentTask`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/AgentTask.ts:29) is a thin coordinator around `TaskRunner`.
- [`RegularTask`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/tasks/RegularTask.ts:21) is the only concrete `SessionTask` implementation today.
- [`Session.spawnTask()`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/Session.ts:1316) is the real concurrency bottleneck because it always calls `abortAllTasks('UserInterrupt')` first.
- [`ActiveTurn`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/session/state/ActiveTurn.ts:13) is foreground-turn state, not a general task registry.

### Important repo mismatches versus the old draft

- The doc previously mentioned `CompactTask`, but there is no `src/core/tasks/CompactTask.ts` in this repo.
- `TaskKind` currently has `Regular`, `Review`, and `Compact`, but only `RegularTask` actually exists as a concrete implementation right now.
- `Session.emitEvent()` exists, but BrowserX also has `Session.sendEvent()` for persisted event emission. New task lifecycle events should use `sendEvent()` when they matter to rollout history.
- `TurnManager` already has a clear tool-round seam in [`executeToolCall()`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/TurnManager.ts:622). That is the right insertion point for draining queued background-task messages between tool rounds.

### Storage implications

Adding task output persistence is a multi-backend change, not just an IndexedDB change.

At minimum this track must update:

- [`src/storage/StorageAdapter.ts`](/home/rich/dev/airepublic/open_source/s1/browserx/src/storage/StorageAdapter.ts)
- [`src/storage/IndexedDBAdapter.ts`](/home/rich/dev/airepublic/open_source/s1/browserx/src/storage/IndexedDBAdapter.ts)
- [`src/server/storage/NodeSQLiteAdapter.ts`](/home/rich/dev/airepublic/open_source/s1/browserx/src/server/storage/NodeSQLiteAdapter.ts)
- [`src/desktop/storage/TauriSQLiteAdapter.ts`](/home/rich/dev/airepublic/open_source/s1/browserx/src/desktop/storage/TauriSQLiteAdapter.ts)

For the extension build, a new IndexedDB object store requires a DB version bump and `onupgradeneeded` migration.

For the server build, the store name must be added to `ADAPTER_STORES`.

For the desktop build, the Tauri storage backend must accept the new collection name, even if no schema migration is needed in TypeScript.

## Decision

Implement typed task families in two layers:

### Layer 1: Generic registry and persistence

This layer introduces the shared typed-task model, storage, polling, notification guards, and UI retention semantics.

### Layer 2: Family-specific executors

This layer adds concrete execution behavior. Only `background_agent` is required in the first vertical slice. The other families should be typed and registrable immediately, but their execution adapters can land later.

That keeps the first implementation tractable and aligned with current BrowserX code.

## Proposed BrowserX Task Model

### Family types

```ts
export type BrowserXTaskType =
  | 'background_agent'
  | 'browser_automation'
  | 'tab_watcher'
  | 'data_extraction';

export type BrowserXTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed';
```

### Base state

```ts
export interface TaskStateBase {
  id: string;
  type: BrowserXTaskType;
  status: BrowserXTaskStatus;
  description: string;
  submissionId: string;
  sessionId: string;
  startTime: number;
  endTime?: number;
  outputStoreKey?: string;
  outputOffset: number;
  notified: boolean;
}
```

Notes:

- `id` is the task-family ID. It is separate from `submissionId`, which stays aligned with `TaskRunner`.
- `sessionId` must be stored explicitly so output cleanup can query by session.
- `outputStoreKey` should equal `id` initially. Keeping it separate allows future transcript sharding without changing task identity.

### Concrete states

```ts
export interface BackgroundAgentTaskState extends TaskStateBase {
  type: 'background_agent';
  prompt: string;
  model?: string;
  isBackgrounded: boolean;
  retain: boolean;
  evictAfter?: number;
  pendingMessages: string[];
  progress?: AgentProgress;
  lastReportedToolCount: number;
  lastReportedTokenCount: number;
}

export interface BrowserAutomationTaskState extends TaskStateBase {
  type: 'browser_automation';
  tabId: number;
  steps: AutomationStep[];
  currentStepIndex: number;
  screenshotKeys: string[];
  progress?: BrowserAutomationProgress;
}

export interface TabWatcherTaskState extends TaskStateBase {
  type: 'tab_watcher';
  tabId: number;
  watchCondition: string;
  checkIntervalMs: number;
  lastCheckedAt?: number;
  matchFound: boolean;
}

export interface DataExtractionTaskState extends TaskStateBase {
  type: 'data_extraction';
  tabId: number;
  extractionConfig: ExtractionConfig;
  pagesProcessed: number;
  rowsExtracted: number;
  dataStoreKey?: string;
}

export type BrowserXTaskState =
  | BackgroundAgentTaskState
  | BrowserAutomationTaskState
  | TabWatcherTaskState
  | DataExtractionTaskState;
```

### State machine

Allowed transitions:

- `pending -> running`
- `running -> completed | failed | killed`

Rejected transitions:

- any terminal to anything else
- `pending -> completed` except through an explicit registry helper used by setup failures

Helper:

```ts
export function isTerminalTaskStatus(status: BrowserXTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}
```

### ID generation

Use the Claudy pattern with Web Crypto:

```ts
const TASK_ID_PREFIXES: Record<BrowserXTaskType, string> = {
  background_agent: 'a',
  browser_automation: 'b',
  tab_watcher: 'w',
  data_extraction: 'x',
};
```

Implementation detail:

- Use `crypto.getRandomValues(new Uint8Array(8))`
- Lowercase base36 alphabet only
- shape: `${prefix}${8 chars}`

## Registry Design

New file: `src/core/tasks/TaskRegistry.ts`

Responsibilities:

- own typed-task state for the session
- protect terminal transitions
- atomically mark notifications
- poll output deltas
- manage UI retention / eviction timing

### API

```ts
class TaskRegistry {
  register(task: BrowserXTaskState): void;
  update<T extends BrowserXTaskState>(taskId: string, updater: (task: T) => T): void;
  transitionToRunning(taskId: string): boolean;
  transitionToTerminal(taskId: string, status: 'completed' | 'failed' | 'killed'): boolean;
  markNotified(taskId: string): boolean;
  tryEvict(taskId: string): boolean;
  poll(): Promise<TaskAttachment[]>;
  get(taskId: string): BrowserXTaskState | undefined;
  list(): BrowserXTaskState[];
  listBackground(): BrowserXTaskState[];
}
```

### Required behavior

- Preserve `retain`, `pendingMessages`, and `startTime` on re-registration when replacing the same task ID.
- Skip no-op updates when the updater returns the same object reference.
- Set `endTime` only once, at terminal transition.
- Eviction requires all three:
  - terminal state
  - `notified === true`
  - if `retain` exists, `evictAfter <= Date.now()`

### Attachment payload

```ts
export interface TaskAttachment {
  taskId: string;
  taskType: BrowserXTaskType;
  status: BrowserXTaskStatus;
  description: string;
  deltaSummary: string | null;
}
```

### Polling constants

Carry over Claudy's timings:

- `POLL_INTERVAL_MS = 1000`
- `PANEL_GRACE_MS = 30000`
- `STOPPED_DISPLAY_MS = 3000`

## Output Persistence Design

New file: `src/core/tasks/TaskOutputStore.ts`

### Storage schema

Add a new store named `task_outputs`.

Record shape:

```ts
export interface TaskOutputRecord {
  taskId: string;
  sessionId: string;
  chunks: string[];
  totalBytes: number;
  capped: boolean;
  updatedAt: number;
}
```

### Backend changes required

#### `StorageAdapter`

- add `task_outputs: 'taskId'` to `STORE_KEY_PATHS`
- add `by_session` support for this store

#### `IndexedDBAdapter`

- add `STORE_NAMES.TASK_OUTPUTS`
- bump `DB_VERSION`
- create object store with keyPath `taskId`
- create `by_session` index on `sessionId`

#### `NodeSQLiteAdapter`

- add `task_outputs` to `ADAPTER_STORES`
- include `by_session` index generation for the new store

#### `TauriSQLiteAdapter`

- no new TS schema object, but all calls must permit `task_outputs` as a valid collection

### Runtime behavior

`append(taskId, content)` must be non-blocking.

Use Claudy's queue-drain semantics, adapted for string chunks:

- maintain `writeQueues: Map<string, string[]>`
- splice the queue during drain so memory can be released early
- append to persisted `chunks`
- if more content arrives during drain, immediately schedule another drain

### Size cap

Use `100 MB` per task by default, not Claudy's `5 GB`.

Reason:

- extension quotas are much smaller
- BrowserX already has quota monitoring
- large outputs must not crowd out rollouts and cache

When the cap is exceeded, append one truncation marker and stop accepting new chunks for that task.

### Read APIs

Required methods:

- `append(taskId, sessionId, content): void`
- `flush(taskId): Promise<void>`
- `getOutputDelta(taskId, fromOffset): Promise<{ content: string; newOffset: number }>`
- `getOutput(taskId, maxBytes?): Promise<string>`
- `evict(taskId): void`
- `cleanup(taskId): Promise<void>`
- `cleanupSession(sessionId): Promise<void>`

### Quota integration

`TaskOutputStore` should accept an optional `StorageQuotaManager`.

Required behavior:

- call quota manager only on drain boundaries, not per append
- if quota is already critical, reject new large writes with a truncation marker instead of continuing to grow

## Session Integration

This is the core implementation seam.

### Keep `ActiveTurn` as foreground-only state

Do not try to make `ActiveTurn` the general concurrent task store.

`ActiveTurn` already bundles:

- running foreground tasks
- pending approvals
- pending input

That is good foreground-turn state, but it is the wrong abstraction for long-lived background tasks.

### Add a second task container to `Session`

Add:

```ts
private backgroundTasks: Map<string, RunningTask> = new Map();
private taskRegistry: TaskRegistry;
```

### Change `spawnTask`

New signature:

```ts
async spawnTask(
  task: SessionTask,
  context: TurnContext,
  subId: string,
  input: InputItem[],
  options?: { background?: boolean; taskId?: string }
): Promise<void>
```

Rules:

- foreground spawn:
  - call `abortForegroundTasks()`
  - register in `ActiveTurn`
- background spawn:
  - do not abort current foreground turn
  - store in `backgroundTasks`

### Do not remove `abortAllTasks()`

Keep it for shutdown / hard interrupt semantics.

Add:

- `abortForegroundTasks()`
- `abortBackgroundTask(taskId)`
- `getBackgroundTasks()`

### RunningTask shape

Extend `RunningTask` with typed-task linkage:

```ts
interface RunningTask {
  kind: TaskKind;
  abortController: AbortController;
  task: SessionTask;
  promise: Promise<string | null>;
  startTime: number;
  taskId?: string;
  background?: boolean;
}
```

That lets `Session.onTaskFinished()` and `onTaskAborted()` update the registry correctly.

### Completion path

On successful completion:

- remove from `ActiveTurn` or `backgroundTasks`
- transition the typed task to `completed`
- schedule `evictAfter` if relevant
- emit completion event through `Session.sendEvent()`

On failure or abort:

- remove from the correct container
- transition to `failed` or `killed`
- preserve terminal guard

## `background_agent` Vertical Slice

This is the only family that must be executable in the first implementation.

### New task kind

Extend [`TaskKind`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/session/state/types.ts) with:

- `BackgroundAgent`
- `BrowserAutomation`
- `TabWatcher`
- `DataExtraction`

### New concrete executor

Create `src/core/tasks/BackgroundAgentTask.ts`.

Implementation approach:

- mirror `RegularTask`
- still use `AgentTask -> TaskRunner`
- register a `BackgroundAgentTaskState` before starting
- mark it running when execution begins
- append output / progress during execution
- on completion, update registry and emit typed lifecycle event

### Why this works

It reuses the current tested execution path instead of inventing a second runner.

## Tool-Round Message Injection

Queued user messages for background agents should drain at tool boundaries.

Integration point:

- [`TurnManager.executeToolCall()`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/TurnManager.ts:622)

Required behavior:

- after each tool execution, check whether the running task has queued `pendingMessages`
- if yes, hand them back to the active task loop through a small injected-input API on `AgentTask` / `TaskRunner`

Important note:

`AgentTask.injectUserInput()` currently exists only as a stub in [`AgentTask`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/AgentTask.ts:121). This track must either implement it or explicitly defer queued-message draining. The previous doc did not call that out.

## Event Design

Use [`Session.sendEvent()`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/Session.ts:1061) for new typed-task lifecycle events so they are both emitted and rollout-persisted.

New event types in [`src/core/protocol/events.ts`](/home/rich/dev/airepublic/open_source/s1/browserx/src/core/protocol/events.ts):

- `BackgroundTaskRegistered`
- `BackgroundTaskProgress`
- `BackgroundTaskCompleted`
- `BackgroundTaskKilled`
- `TaskBackgrounded`
- `TaskForegrounded`

Suggested payloads:

```ts
interface BackgroundTaskRegisteredEvent {
  taskId: string;
  taskType: BrowserXTaskType;
  description: string;
  submissionId: string;
}

interface BackgroundTaskProgressEvent {
  taskId: string;
  taskType: BrowserXTaskType;
  summary?: string;
  toolUseCount?: number;
  tokenCount?: number;
}

interface BackgroundTaskCompletedEvent {
  taskId: string;
  taskType: BrowserXTaskType;
  status: 'completed' | 'failed' | 'killed';
  summary: string;
  durationMs: number;
}
```

## UI Lifecycle Semantics

Carry over Claudy's behavior for background agents:

- `isBackgrounded`
  - `false` for foreground-running task
  - `true` once detached to background
- `retain`
  - `true` while sidepanel is actively holding the task detail view
- `evictAfter`
  - `undefined` while running or retained
  - `Date.now() + PANEL_GRACE_MS` when terminal and not retained

This is a registry concern, not a `TaskRunner` concern.

## What Is Explicitly Out Of Scope For The First Slice

- implementing all family-specific executors at once
- full service-worker restart recovery for in-flight background tasks
- scheduler-triggered spawning of every family
- a second execution engine besides `TaskRunner`

Those can come after the `background_agent` path is stable.

## Implementation Sequence

### Phase 1: Generic types and tests

- add `src/core/tasks/types.ts`
- add ID generation, status helpers, and type guards
- extend `RunningTask` and `TaskKind`

### Phase 2: Registry and output store

- add `TaskRegistry`
- add `TaskOutputStore`
- wire `task_outputs` into all storage backends

### Phase 3: Session concurrency seam

- add `backgroundTasks` map to `Session`
- split `abortForegroundTasks()` from `abortAllTasks()`
- update `spawnTask()` to accept `background`

### Phase 4: `background_agent` executor

- add `BackgroundAgentTask`
- register typed state before running
- update terminal status and events on completion

### Phase 5: UI retention and polling

- add `retain` / `evictAfter`
- start registry polling on session init
- expose background task list to sidepanel

### Phase 6: queued-message drain

- implement actual `AgentTask.injectUserInput()` / runner support
- drain `pendingMessages` between tool rounds

## Risks

- **Concurrency regression**: the highest-risk change is relaxing the current "abort before spawn" rule in `Session.spawnTask()`.
- **Storage pressure**: task outputs compete with rollout persistence and cache.
- **Stale async callbacks**: without terminal guards, completion and abort paths will race.
- **UI drift**: if `retain` and eviction rules are not centralized in the registry, the sidepanel will become inconsistent quickly.
- **Tool-round injection complexity**: queued-message support touches `AgentTask`, `TaskRunner`, and `TurnManager`; it should not be mixed into the first concurrency PR unless the boundary is clean.

## Start Condition

After this research, the track is ready to start implementation **only if we begin with the `background_agent` vertical slice** and treat the other families as typed placeholders until the registry and concurrency seam are proven.
