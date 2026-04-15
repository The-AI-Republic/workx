# Track 04: Typed Task Families - Tasks

## Phase 1: Task State Machine

- [ ] Define `TaskStateBase` interface with: id, type, status, description, startTime, endTime, outputFile, outputOffset, notified
- [ ] Define `TaskStatus` type: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
- [ ] Define `BrowserXTaskState` discriminated union with type field as discriminator
- [ ] Define `BrowserAutomationTaskState` with: tabId, steps, currentStepIndex, screenshots, progress
- [ ] Define `BackgroundAgentTaskState` with: prompt, model, isBackgrounded, progress, pendingMessages, retain, evictAfter
- [ ] Define `ScheduledTaskState` with: cronExpression, lastRunAt, nextRunAt, runCount
- [ ] Define `TabWatcherTaskState` with: tabId, watchCondition, checkIntervalMs, lastCheckedAt, matchFound
- [ ] Implement `isTerminalTaskStatus()` guard function
- [ ] Implement `TaskRegistry` class: register, unregister, get, list, update
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
- [ ] Implement `backgroundTask(taskId)`: set isBackgrounded = true, release main loop
- [ ] Implement `foregroundTask(taskId)`: set isBackgrounded = false, attach to UI
- [ ] Add `retain` field: set to true when user views task, blocks eviction
- [ ] Add `evictAfter` field: set to now + 30s when user exits task view
- [ ] Implement eviction check in TaskRegistry: periodic scan for evictable tasks
- [ ] Add `pendingMessages` queue: messages sent to task while it's mid-turn
  - Drain at tool-round boundaries (between tool calls)
- [ ] Wire background task execution into RepublicAgent:
  - New submission type: BackgroundTaskSubmission
  - TaskRunner processes in separate execution context
- [ ] Add AbortController per task for cancellation
- [ ] Wire task lifecycle events: TaskStarted, TaskBackgrounded, TaskForegrounded, TaskCompleted
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
