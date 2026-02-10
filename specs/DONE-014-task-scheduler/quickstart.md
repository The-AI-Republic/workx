# Quickstart: Task Scheduler Queue System

**Feature**: 014-task-scheduler
**Date**: 2026-02-02

## Overview

This guide provides the essential information needed to implement the task scheduler feature. The scheduler allows users to queue AI tasks for automatic sequential execution.

---

## Core Components

### 1. Scheduler (src/core/scheduler/Scheduler.ts)

Main orchestrator class. Responsibilities:
- Schedule new tasks
- Process SchedulerTaskQueue when tasks are due
- Handle task lifecycle (start, complete, fail, cancel)
- Coordinate with alarms and storage

```typescript
class Scheduler {
  constructor(
    private storage: ISchedulerStorage,
    private alarms: ISchedulerAlarms,
    private agent: BrowserxAgent
  ) {}

  async createDraftTask(input: string): Promise<string>;
  async scheduleTask(input: string, scheduledTime: number): Promise<string>;
  async scheduleExistingTask(taskId: string, scheduledTime: number): Promise<void>;
  async triggerTask(taskId: string): Promise<void>;  // Manually run draft/scheduled
  async cancelTask(taskId: string): Promise<void>;
  async pauseSchedulerTaskQueue(): Promise<void>;
  async resumeSchedulerTaskQueue(): Promise<void>;
  async handleAlarm(alarmName: string): Promise<void>;
}
```

### 2. SchedulerStorage (src/core/scheduler/SchedulerStorage.ts)

IndexedDB persistence layer. Extends existing `IndexedDBAdapter`.

```typescript
class SchedulerStorage implements ISchedulerStorage {
  async createTask(input: string, scheduledTime?: number): Promise<SchedulerTaskRecord>;  // No time = draft
  async getDraftTasks(): Promise<SchedulerTaskRecord[]>;
  async getScheduledTasks(): Promise<SchedulerTaskRecord[]>;
  async getSchedulerTaskQueueTasks(): Promise<SchedulerTaskRecord[]>;  // Tasks with 'waiting' status
  async getNextTaskInSchedulerTaskQueue(): Promise<SchedulerTaskRecord | null>;  // FIFO by createdAt
  async updateTask(id: string, updates: Partial<SchedulerTaskRecord>): Promise<void>;
  async getSchedulerState(): Promise<SchedulerState>;
}
```

### 3. SchedulerAlarms (src/background/scheduler-alarms.ts)

Chrome alarms API wrapper.

```typescript
class SchedulerAlarms implements ISchedulerAlarms {
  async createTaskAlarm(taskId: string, scheduledTime: number): Promise<void>;
  async clearTaskAlarm(taskId: string): Promise<void>;
  async startSchedulerTaskQueueProcessor(): Promise<void>;
}
```

---

## Key Flows

### Scheduling a Task

```
User long-presses send button
    ↓
ScheduleTaskModal opens
    ↓
User sets time, confirms
    ↓
router.send(SCHEDULE_TASK, { input, scheduledTime })
    ↓
Scheduler.scheduleTask()
    ├── storage.createTask() → IndexedDB
    ├── alarms.createTaskAlarm() → chrome.alarms
    └── return taskId
    ↓
UI updates to show scheduled task
```

### Executing a Scheduled Task

```
chrome.alarms.onAlarm fires (task alarm)
    ↓
service-worker.ts handles alarm
    ↓
scheduler.handleAlarm(alarmName)
    ↓
Scheduler.triggerTask(taskId)
    ├── Check if another task is running
    │   ├── Yes: storage.updateTask(status: 'waiting') → added to SchedulerTaskQueue
    │   └── No: proceed to execute
    ↓
Scheduler.executeTask(task)
    ├── storage.updateTask(status: 'running')
    ├── Create new Session (isolated)
    ├── Always open sidepanel as new browser tab (never interrupt user's current sidepanel)
    ├── agent.executeWithSession()
    └── storage.updateTask(status: 'completed'|'failed')
    ↓
Emit TASK_STATUS_CHANGED event
    ↓
Scheduler.processSchedulerTaskQueue()
    ├── Get next task from SchedulerTaskQueue (FIFO by createdAt)
    └── Execute if SchedulerTaskQueue not paused
```

### Manually Triggering a Draft Task

```
User clicks "Run Now" on draft task
    ↓
router.send(TRIGGER_TASK, { taskId })
    ↓
Scheduler.triggerTask(taskId)
    ├── Check if another task is running
    │   ├── Yes: draft → waiting (added to SchedulerTaskQueue)
    │   └── No: draft → running → execute
```

### Viewing the Scheduler

```
User clicks Scheduler button
    ↓
SchedulerPopup opens
    ↓
router.send(GET_SCHEDULED_TASKS)
    ↓
Display list of upcoming tasks
    ↓
User clicks "View archived"
    ↓
router.send(GET_ARCHIVED_TASKS)
    ↓
ArchivedTasksView opens
```

---

## UI Components

### MessageInput.svelte Changes

Add long-press detection to send button:

```svelte
<script>
  let pressTimer: number | null = null;
  const LONG_PRESS_DURATION = 500;

  function handlePointerDown(e: PointerEvent) {
    if (!value.trim()) return;
    pressTimer = window.setTimeout(() => {
      dispatch('showScheduleModal');
    }, LONG_PRESS_DURATION);
  }

  function handlePointerUp() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }
</script>

<button
  on:pointerdown={handlePointerDown}
  on:pointerup={handlePointerUp}
  on:pointerleave={handlePointerUp}
  on:click={handleButtonClick}
>
  ...
</button>
```

### FooterBar.svelte Changes

Add Scheduler button beside UserLoginStatus:

```svelte
<div class="footer-bar {currentTheme}">
  <UserLoginStatus on:openSettings={handleOpenSettings} />

  <!-- NEW: Scheduler Button -->
  <SchedulerButton on:click={() => showSchedulerPopup = true} />

  <div class="flex-grow"></div>
  ...
</div>
```

### New Components

| Component | Purpose |
|-----------|---------|
| `SchedulerButton.svelte` | Calendar icon button in footer |
| `SchedulerPopup.svelte` | Popup showing upcoming tasks |
| `SchedulerTaskItem.svelte` | Single task row in popup |
| `ScheduleTaskModal.svelte` | Date/time picker for scheduling |
| `ArchivedTasksView.svelte` | History of completed tasks |

---

## Service Worker Integration

### Add to service-worker.ts

```typescript
import { Scheduler } from '../core/scheduler/Scheduler';
import { SchedulerStorage } from '../core/scheduler/SchedulerStorage';
import { SchedulerAlarms } from './scheduler-alarms';

let scheduler: Scheduler;

async function initialize() {
  // ... existing init ...

  const schedulerStorage = new SchedulerStorage(indexedDBAdapter);
  const schedulerAlarms = new SchedulerAlarms();
  scheduler = new Scheduler(schedulerStorage, schedulerAlarms, agent);

  // Start SchedulerTaskQueue processor
  await schedulerAlarms.startSchedulerTaskQueueProcessor();
}

// Add alarm listener
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Existing rollout cleanup handling...

  // Scheduler handling
  if (alarm.name.startsWith('scheduler-')) {
    await scheduler.handleAlarm(alarm.name);
  }
});

// Add message handlers
router.on(SchedulerMessageType.SCHEDULE_TASK, async (payload) => {
  const taskId = await scheduler.scheduleTask(payload.input, payload.scheduledTime);
  return { success: true, taskId };
});

// ... other handlers
```

---

## IndexedDB Migration

### Bump DB_VERSION in IndexedDBAdapter.ts

```typescript
const DB_VERSION = 2; // Was 1

// In onupgradeneeded:
if (oldVersion < 2) {
  const store = db.createObjectStore('scheduler_tasks', { keyPath: 'id' });
  store.createIndex('by_status', 'status', { unique: false });
  store.createIndex('by_scheduled_time', 'scheduledTime', { unique: false });
  store.createIndex('by_status_time', ['status', 'scheduledTime'], { unique: false });
  store.createIndex('by_created_at', 'createdAt', { unique: false });
}
```

---

## Testing Strategy

### Unit Tests

```typescript
// Scheduler.test.ts
describe('Scheduler', () => {
  it('should create task with draft status when no time provided');
  it('should create task with scheduled status when time provided');
  it('should transition draft → scheduled when time is set');
  it('should transition draft → running when manually triggered (no task running)');
  it('should transition draft → waiting when manually triggered (task running)');
  it('should transition scheduled → running when alarm fires (no task running)');
  it('should transition scheduled → waiting when alarm fires (task running)');
  it('should process SchedulerTaskQueue FIFO after task completes');
  it('should not execute when paused');
  it('should handle task failure without blocking SchedulerTaskQueue');
});
```

### Integration Tests

```typescript
// Scheduler.integration.test.ts
describe('Scheduler Integration', () => {
  it('should persist task across storage reload');
  it('should create alarm for scheduled task');
  it('should execute task when alarm fires');
  it('should create isolated session for each task');
});
```

---

## Critical Implementation Notes

1. **Session Isolation**: Each scheduled task MUST create a new `Session` instance. Do not reuse sessions.

2. **Always Open New Tab**: Scheduled tasks ALWAYS open in a new browser tab, even if the sidepanel is already open. Never interrupt the user's current sidepanel session.

3. **Alarm Minimum**: Chrome alarms have a 1-minute minimum. Tasks scheduled less than 1 minute out should use immediate execution (trigger directly).

4. **Service Worker Wake**: The service worker may be killed between scheduling and execution. All state must be in IndexedDB/chrome.storage.

5. **UI Context Detection**: Check `window.location.search` for `scheduledTask` param to detect if running as a scheduled task in a tab.

6. **SchedulerTaskQueue FIFO**: Tasks in "waiting" status are processed in `createdAt` order (first-in-first-out). No manual reordering.

7. **Draft vs Scheduled**: Draft tasks have no alarm set. They must be manually triggered or have a time set to become scheduled. Only scheduled tasks have alarms.

8. **Missed Tasks**: On browser startup, check for tasks where `scheduledTime < now` and status is still 'scheduled'. Mark these as 'missed' and notify user. User must manually trigger or cancel missed tasks - never auto-execute.
