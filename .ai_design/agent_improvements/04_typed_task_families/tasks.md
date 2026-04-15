# Track 04: Typed Task Families - Tasks

> **Important:** BrowserX already has substantial task infrastructure that must be extended, not replaced. `TaskRunner` (~765 lines) handles multi-turn loops, auto-compaction, abort handling, and token persistence. `Session.spawnTask()` creates `RunningTask` instances with `kind`, `abortController`, `task`, `promise`, `startTime`. `ActiveTurn` maintains `Map<string, RunningTask>` with full lifecycle management. All new task families must build on these existing abstractions.

## Phase 1: Extend Existing Task State Machine

- [ ] Define `TaskStateBase` interface **compatible with existing `TaskState` in `TaskRunner.ts`** — extend, don't replace the existing status enum
- [ ] Define `TaskStatus` type: 'pending' | 'running' | 'completed' | 'failed' | 'killed' (superset of existing 'idle' | 'running' | 'completed' | 'failed' | 'cancelled')
- [ ] Define `BrowserXTaskState` discriminated union using `RunningTask.kind` as the discriminator field
- [ ] Define `BrowserAutomationTaskState` with: tabId, steps, currentStepIndex, screenshots, progress
- [ ] Define `BackgroundAgentTaskState` with: prompt, model, isBackgrounded, progress, pendingMessages, retain, evictAfter
- [ ] Define `ScheduledTaskState` with: cronExpression, lastRunAt, nextRunAt, runCount
- [ ] Define `TabWatcherTaskState` with: tabId, watchCondition, checkIntervalMs, lastCheckedAt, matchFound
- [ ] Implement `isTerminalTaskStatus()` guard function
- [ ] Implement `TaskRegistry` class that integrates with existing `ActiveTurn` task map: register, unregister, get, list, update
- [ ] Add terminal state protection: reject transitions from completed/failed/killed
- [ ] Add `notified` flag with atomic check-and-set to prevent duplicate notifications
- [ ] Add type guard functions: `isBrowserAutomationTask()`, `isBackgroundAgentTask()`, etc.
- [ ] Write unit tests for state machine transitions and terminal state protection

## Phase 2: Disk Persistence

- [ ] Implement `DiskTaskOutput` class in `src/core/tasks/DiskTaskOutput.ts`:
  - Constructor takes file path
  - append(content: string) queues content
  - flush() awaits all pending writes
  - cancel() discards pending
  - Internal async drain loop (one writer per task)
- [ ] Add session-scoped output directory: `${dataDir}/sessions/${sessionId}/tasks/`
- [ ] Create output directory on first task registration
- [ ] Implement delta reads: `getTaskOutputDelta(taskId, offset)` returns content from offset
- [ ] Add configurable size cap (default 1GB): stop writing when cap reached, set `capped = true`
- [ ] Implement cleanup on session end: remove session task directory
- [ ] Wire DiskTaskOutput into TaskRegistry: auto-create on task registration
- [ ] Add queue-splice pattern for GC-friendly memory management
- [ ] Write tests for append-only writes, delta reads, and size capping

## Phase 3: Background Execution

- [ ] Add `isBackgrounded` field to BackgroundAgentTaskState
- [ ] Extend `Session.spawnTask()` to support background/foreground transitions (it already uses fire-and-forget async pattern with `AbortController`)
- [ ] Implement `backgroundTask(taskId)`: set isBackgrounded = true, release main loop
- [ ] Implement `foregroundTask(taskId)`: set isBackgrounded = false, attach to UI
- [ ] Add `retain` field: set to true when user views task, blocks eviction
- [ ] Add `evictAfter` field: set to now + 30s when user exits task view
- [ ] Implement eviction check in TaskRegistry: periodic scan for evictable tasks
- [ ] Add `pendingMessages` queue: messages sent to task while it's mid-turn
  - Drain at tool-round boundaries (between tool calls)
- [ ] Wire background task execution into RepublicAgent:
  - New submission type: BackgroundTaskSubmission
  - `TaskRunner` processes in separate execution context (coordinate with existing compaction logic for long-running tasks)
- [ ] ~~Add AbortController per task~~ **ALREADY EXISTS**: `Session.spawnTask()` creates `AbortController` per task (line 1326)
- [ ] Wire task lifecycle events via existing `Session`/`TurnManager` event emission: TaskStarted, TaskBackgrounded, TaskForegrounded, TaskCompleted
- [ ] Write tests for background/foreground transitions

## Phase 4: Progress & Notifications

- [ ] Define `AgentProgress` type: { toolUseCount, tokenCount, lastActivity, recentActivities, summary }
- [ ] Define `BrowserAutomationProgress` type: { stepsCompleted, totalSteps, currentAction, lastScreenshot }
- [ ] Implement delta tracking: store lastReportedToolCount/TokenCount, emit only deltas
- [ ] Implement task notification protocol:
  - Define TaskNotification type with taskId, status, summary, result, usage
  - Emit notification to parent session on task completion
  - Atomic notification guard (check-and-set notified flag)
- [ ] Wire progress events to EventBus (or hook system from Track 01)
- [ ] Add task progress UI component in webfront
- [ ] Implement background summary generation (optional LLM call for 1-2 sentence summary)
- [ ] Add task listing command: `/tasks` shows active/completed tasks with status
- [ ] Write tests for progress delta tracking and notification deduplication
