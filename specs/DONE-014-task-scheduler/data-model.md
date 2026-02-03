# Data Model: Task Scheduler

**Feature**: 014-task-scheduler
**Date**: 2026-02-02

## Entities

### SchedulerTask

Represents a task managed by the Scheduler.

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| `id` | `string` | Unique task identifier | UUID v4, primary key |
| `input` | `string` | User's task description/prompt | Required, non-empty |
| `scheduledTime` | `number \| null` | Unix timestamp (ms) when task should execute | Null for draft, required for scheduled |
| `createdAt` | `number` | Unix timestamp (ms) when task was created | Required, auto-set |
| `status` | `SchedulerTaskStatus` | Current task state | Required, enum |
| `sessionId` | `string \| null` | Associated conversation session ID | Set when task starts |
| `completedAt` | `number \| null` | Unix timestamp (ms) when task finished | Set on completion/failure |
| `error` | `string \| null` | Error message if task failed | Set on failure |

```typescript
type SchedulerTaskStatus =
  | 'draft'       // Task created, no scheduled time set
  | 'scheduled'   // Has scheduled time, alarm is set
  | 'missed'      // Scheduled time passed while browser was closed, awaiting user action
  | 'waiting'     // In SchedulerTaskQueue - triggered but blocked by running task
  | 'running'     // Currently executing
  | 'completed'   // Successfully finished
  | 'failed'      // Execution failed
  | 'cancelled';  // User cancelled
```

### State Transitions

```
                                                    ┌──► completed
                                                    │
[Created] ──► draft ──► scheduled ──► waiting ──► running ──┤
                │           │    │       │           │       └──► failed
                │           │    │       │           │
                │           │    ▼       │           │
                │           │  missed ───┴───────────┴──► cancelled
                │           │    │
                │           │    └──► waiting/running (user triggers)
                │           │
                └───────────┴──► cancelled
```

| From | To | Trigger |
|------|------|---------|
| - | draft | User creates task without time |
| - | scheduled | User creates task with time |
| draft | scheduled | User sets scheduled time |
| draft | waiting | User manually triggers (another task running) → enters SchedulerTaskQueue |
| draft | running | User manually triggers (no task running) |
| draft | cancelled | User cancels |
| scheduled | waiting | Alarm fires, another task running → enters SchedulerTaskQueue |
| scheduled | running | Alarm fires, no task running |
| scheduled | missed | Browser starts and scheduledTime is in the past (catch-up detection) |
| scheduled | cancelled | User cancels |
| missed | waiting | User triggers missed task (another task running) |
| missed | running | User triggers missed task (no task running) |
| missed | cancelled | User cancels/dismisses missed task |
| waiting | running | SchedulerTaskQueue processes this task (previous task completed) |
| waiting | cancelled | User cancels |
| running | completed | Task finishes successfully |
| running | failed | Task encounters error |
| running | cancelled | User cancels (aborts execution) |

---

### SchedulerState

Represents the global Scheduler state (stored in chrome.storage.local for fast access).

| Field | Type | Description |
|-------|------|-------------|
| `isPaused` | `boolean` | Whether SchedulerTaskQueue processing is paused |
| `currentTaskId` | `string \| null` | ID of currently running task |
| `lastProcessedTime` | `number` | Timestamp of last SchedulerTaskQueue processing |

```typescript
interface SchedulerState {
  isPaused: boolean;
  currentTaskId: string | null;
  lastProcessedTime: number;
}
```

---

### TaskResult

Embedded in SchedulerTask after completion. Links to session for full conversation.

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Reference to Session for full transcript |
| `summary` | `string` | Brief outcome summary (first 200 chars of response) |
| `tokenUsage` | `TokenUsageInfo` | Token consumption stats |
| `duration` | `number` | Execution time in milliseconds |

---

## IndexedDB Schema

### Object Store: `scheduler_tasks`

```typescript
{
  name: 'scheduler_tasks',
  options: { keyPath: 'id' },
  indexes: [
    { name: 'by_status', keyPath: 'status', options: { unique: false } },
    { name: 'by_scheduled_time', keyPath: 'scheduledTime', options: { unique: false } },
    { name: 'by_status_time', keyPath: ['status', 'scheduledTime'], options: { unique: false } },
    { name: 'by_created_at', keyPath: 'createdAt', options: { unique: false } }
  ]
}
```

### Migration

Increment `DB_VERSION` in `IndexedDBAdapter.ts` and add store creation in `onupgradeneeded`:

```typescript
if (!db.objectStoreNames.contains('scheduler_tasks')) {
  const store = db.createObjectStore('scheduler_tasks', { keyPath: 'id' });
  store.createIndex('by_status', 'status', { unique: false });
  store.createIndex('by_scheduled_time', 'scheduledTime', { unique: false });
  store.createIndex('by_status_time', ['status', 'scheduledTime'], { unique: false });
  store.createIndex('by_created_at', 'createdAt', { unique: false });
}
```

---

## Chrome Storage Schema

### Key: `scheduler_state`

```typescript
// chrome.storage.local
{
  scheduler_state: {
    isPaused: false,
    currentTaskId: null,
    lastProcessedTime: 0
  }
}
```

---

## Relationships

```
┌─────────────────┐         ┌─────────────────┐
│ SchedulerTask   │────────►│ Session         │
│                 │ 1:1     │ (existing)      │
│ sessionId ──────┼─────────│ conversationId  │
└─────────────────┘         └─────────────────┘
         │
         │ references
         ▼
┌─────────────────┐
│ chrome.alarms   │
│ (browser API)   │
│                 │
│ name: task-{id} │
└─────────────────┘
```

---

## Validation Rules

### SchedulerTask

| Field | Rule |
|-------|------|
| `id` | Must be valid UUID v4 |
| `input` | Non-empty string, max 10000 chars |
| `scheduledTime` | Null for draft; must be in the future when set |
| `status` | Must be valid SchedulerTaskStatus enum value |
| `createdAt` | Auto-set to current timestamp on creation |

### SchedulerState

| Field | Rule |
|-------|------|
| `isPaused` | Boolean only |
| `currentTaskId` | Null or valid task ID that exists |

---

## Query Patterns

### Get draft tasks

```typescript
// Index: by_status - get draft tasks, ordered by createdAt
const drafts = await db.queryByIndex('scheduler_tasks', 'by_status', 'draft');
const sorted = drafts.sort((a, b) => a.createdAt - b.createdAt);
```

### Get scheduled tasks (for Scheduler popup)

```typescript
// Index: by_status - get scheduled tasks, ordered by scheduledTime
const scheduled = await db.queryByIndex('scheduler_tasks', 'by_status', 'scheduled');
const upcoming = scheduled.sort((a, b) => a.scheduledTime - b.scheduledTime);
```

### Get missed tasks

```typescript
// Index: by_status - get missed tasks (overdue, awaiting user action)
const missed = await db.queryByIndex('scheduler_tasks', 'by_status', 'missed');
const sorted = missed.sort((a, b) => a.scheduledTime - b.scheduledTime);
```

### Detect overdue scheduled tasks (on browser startup)

```typescript
// Find tasks that should have run but browser was closed
const scheduled = await db.queryByIndex('scheduler_tasks', 'by_status', 'scheduled');
const now = Date.now();
const overdue = scheduled.filter(task => task.scheduledTime && task.scheduledTime < now);
// Mark each as 'missed'
for (const task of overdue) {
  await db.update('scheduler_tasks', task.id, { status: 'missed' });
}
```

### Get SchedulerTaskQueue (tasks with 'waiting' status)

```typescript
// Index: by_status - get tasks in SchedulerTaskQueue, ordered by createdAt (FIFO)
const schedulerTaskQueue = await db.queryByIndex('scheduler_tasks', 'by_status', 'waiting');
const sorted = schedulerTaskQueue.sort((a, b) => a.createdAt - b.createdAt);
```

### Get next task from SchedulerTaskQueue

```typescript
// Get oldest waiting task (FIFO order by createdAt)
const schedulerTaskQueue = await db.queryByIndex('scheduler_tasks', 'by_status', 'waiting');
const nextTask = schedulerTaskQueue.sort((a, b) => a.createdAt - b.createdAt)[0] || null;
```

### Get archived tasks (completed/failed)

```typescript
// Index: by_status, filter for completed or failed
const completed = await db.queryByIndex('scheduler_tasks', 'by_status', 'completed');
const failed = await db.queryByIndex('scheduler_tasks', 'by_status', 'failed');
const archived = [...completed, ...failed].sort((a, b) => b.completedAt - a.completedAt);
```

### Get task by ID

```typescript
const task = await db.get('scheduler_tasks', taskId);
```
