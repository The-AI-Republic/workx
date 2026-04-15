# Track 04: Typed Task Families

## Problem

BrowserX has a basic `TaskRunner` with a single task type and no disk persistence. There is no:

- Typed task families (browser automation vs. background agent vs. scheduled)
- Disk persistence for task output (results lost on crash/restart)
- Background/foreground transitions (tasks always block the main loop)
- Progress tracking with delta reads
- Task state machine with terminal state protection

Claudy has 7 typed task families with append-only disk output, background/foreground transitions, progress delta tracking, and a protected state machine.

## What Claudy Does

### Typed Task Families (Discriminated Union)

```typescript
type TaskState =
  | LocalShellTaskState        // Background shell commands
  | LocalAgentTaskState        // Background AI agents
  | RemoteAgentTaskState       // Cloud-hosted agents
  | InProcessTeammateTaskState // In-process team members (swarm)
  | LocalWorkflowTaskState     // YAML workflow scripts
  | MonitorMcpTaskState        // Long-running MCP monitoring
  | DreamTaskState             // Speculative pre-computation
```

Each family has unique fields but shares a base:
```typescript
type TaskStateBase = {
  id: string
  type: TaskType
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  description: string
  startTime: number
  endTime?: number
  outputFile?: string        // Path to disk output
  outputOffset?: number      // Current read offset for delta reads
  notified: boolean          // Has parent been notified of completion?
}
```

### Disk Persistence (Append-Only)

```typescript
class DiskTaskOutput {
  #path: string
  #fileHandle: FileHandle | null
  #queue: string[] = []         // Flat array write queue (GC-friendly)
  #bytesWritten = 0
  #capped = false               // 5GB max per task

  append(content: string): void    // Queue content (non-blocking)
  flush(): Promise<void>          // Wait for writes to complete
  cancel(): void                  // Discard pending writes
}
```

Key patterns:
- Session-scoped directory: `${tempDir}/${sessionId}/tasks/${taskId}.output`
- Append-only (no seek/truncate)
- Delta reads via `outputOffset` (never loads full file)
- 5GB cap per task (prevents runaway output)
- Queue-splice pattern for aggressive GC

### Background/Foreground Transitions

```typescript
type LocalAgentTaskState = TaskStateBase & {
  isBackgrounded: boolean       // true = running in background
  retain: boolean               // true = block eviction (user viewing)
  diskLoaded: boolean           // bootstrap sync complete?
  evictAfter?: number           // grace period timestamp
  pendingMessages: string[]     // messages queued mid-turn
  progress?: AgentProgress      // {toolUseCount, tokenCount, lastActivity, summary}
}
```

Lifecycle:
1. **Spawn**: `isBackgrounded = true` (starts in background)
2. **User views**: `retain = true` (block eviction, stream to UI)
3. **User exits view**: `evictAfter = now + 30s` (grace period)
4. **Terminal state + grace expired**: evict from memory (disk output preserved)

### Progress Delta Tracking

```typescript
type AgentProgress = {
  toolUseCount: number
  tokenCount: number
  lastActivity: string         // "Reading src/foo.ts"
  recentActivities: string[]   // Last 5 activities
  summary?: string             // 1-2 sentence progress (from background summarization)
}
```

Delta computed from `lastReportedToolCount` / `lastReportedTokenCount` to avoid sending full state on every update.

### Task Notifications (to parent/coordinator)

```xml
<task-notification>
  <task-id>{taskId}</task-id>
  <status>completed</status>
  <summary>{human-readable summary}</summary>
  <result>{final response}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

Notifications are atomically guarded (`notified` flag prevents duplicates).

## BrowserX Mapping

### Current State

```typescript
// TaskRunner.ts - Basic task execution
type TaskState = {
  submissionId: string
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  currentTurnIndex: number
  tokenUsage: { used: number; max: number }
  compactionPerformed: boolean
  abortReason?: string
}
```

- Single task type
- No disk persistence (results in memory only)
- No background execution (always blocks main loop)
- No progress tracking
- No task family discrimination

### Proposed Task Families for BrowserX

```typescript
type BrowserXTaskState =
  | BrowserAutomationTaskState   // Multi-step browser automation
  | BackgroundAgentTaskState     // Background AI agent (research, analysis)
  | ScheduledTaskState           // Cron-style scheduled tasks
  | TabWatcherTaskState          // Monitor tab for changes
  | DataExtractionTaskState      // Long-running data extraction
```

```typescript
type BrowserAutomationTaskState = TaskStateBase & {
  type: 'browser_automation'
  tabId: number
  steps: AutomationStep[]
  currentStepIndex: number
  screenshots: string[]           // Paths to step screenshots
  progress: BrowserAutomationProgress
}

type BackgroundAgentTaskState = TaskStateBase & {
  type: 'background_agent'
  prompt: string
  model?: string
  isBackgrounded: boolean
  progress?: AgentProgress
  pendingMessages: string[]
  retain: boolean
  evictAfter?: number
}

type ScheduledTaskState = TaskStateBase & {
  type: 'scheduled'
  cronExpression: string
  lastRunAt?: number
  nextRunAt: number
  runCount: number
}

type TabWatcherTaskState = TaskStateBase & {
  type: 'tab_watcher'
  tabId: number
  watchCondition: string          // "price < $100", "status changed"
  checkIntervalMs: number
  lastCheckedAt?: number
  matchFound: boolean
}
```

### Phase Plan

**Phase 1: Task State Machine** (Week 1-2)
- Define discriminated union `BrowserXTaskState`
- Implement state machine with terminal state protection
- Add `notified` flag for atomic notification guard
- Implement `TaskRegistry` for tracking active tasks

**Phase 2: Disk Persistence** (Week 2-3)
- Implement `DiskTaskOutput` class (append-only, queue-based)
- Add session-scoped output directory
- Implement delta reads via offset tracking
- Add size cap (configurable, default 1GB)

**Phase 3: Background Execution** (Week 3-4)
- Add `isBackgrounded` flag and background/foreground transitions
- Implement `retain` and `evictAfter` for UI lifecycle
- Add `pendingMessages` queue for mid-turn messages
- Wire background tasks into EventBus for progress notifications

**Phase 4: Progress & Notifications** (Week 4-5)
- Implement `AgentProgress` type with delta tracking
- Add task notification protocol (XML or JSON to parent session)
- Wire progress events to UI components
- Add task summary generation (background LLM summarization)

## BrowserX-Specific Task Types

### BrowserAutomationTask

Multi-step browser workflows (e.g., "fill out this form, submit, verify confirmation"):
- Step tracking with screenshot at each step
- Rollback capability (navigate back if step fails)
- Parallel tab operations (open multiple tabs, compare)

### TabWatcherTask

Monitor a tab for changes (e.g., "notify me when the price drops"):
- Periodic DOM checks against condition
- Background execution with configurable interval
- Notification on match

### DataExtractionTask

Long-running data extraction across paginated results:
- Progress tracking (pages processed, rows extracted)
- Disk persistence for extracted data
- Resume capability after interruption

## Risks

- **Memory**: Multiple background tasks with message buffers can consume significant memory. Use the `evictAfter` pattern with message caps (50 messages for UI, full on disk).
- **Tab conflicts**: Multiple tasks operating on the same tab can conflict. Add tab locking or use separate tabs for concurrent tasks.
