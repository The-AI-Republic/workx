# Research: Task Scheduler Queue System

**Feature**: 014-task-scheduler
**Date**: 2026-02-02

## Research Summary

All technical unknowns have been resolved through codebase exploration. No external research required as existing patterns provide clear guidance.

---

## 1. Chrome Alarms API for Persistent Scheduling

**Decision**: Use `chrome.alarms` API for all scheduled task timing

**Rationale**:
- Only MV3-compliant method for persistent timers that survive service worker termination
- Already used in codebase for rollout cleanup (`src/background/rollout-cleanup.ts`)
- Alarms persist across browser restarts
- Minimum granularity: 1 minute (sufficient for user-facing scheduling)

**Alternatives Considered**:
- `setTimeout`/`setInterval`: Rejected - lost when service worker terminates
- Web Workers: Rejected - not available in MV3 service workers
- External service: Rejected - adds complexity, requires network

**Implementation Pattern** (from existing code):
```typescript
// Create alarm
chrome.alarms.create(`scheduler-task-${taskId}`, {
  when: scheduledTimestamp  // Unix timestamp in ms
});

// Listen for alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('scheduler-task-')) {
    const taskId = alarm.name.replace('scheduler-task-', '');
    await executeSchedulerTask(taskId);
  }
});

// Clear alarm
chrome.alarms.clear(`scheduler-task-${taskId}`);
```

---

## 2. IndexedDB Storage Pattern for Scheduler

**Decision**: Extend existing `IndexedDBAdapter` with new `scheduler_tasks` object store

**Rationale**:
- Consistent with existing storage patterns (sessions, cache_items, rollout_cache)
- Already handles versioning, migrations, and error handling
- Supports indexes for efficient queries (by status, by scheduled time)

**Alternatives Considered**:
- `chrome.storage.local`: Rejected - 10MB limit, no indexing, synchronous reads block
- New separate database: Rejected - unnecessary complexity, adapter already handles this

**Schema Addition**:
```typescript
// Add to IndexedDBAdapter.ts DB_VERSION increment
const SCHEDULER_TASKS_STORE = 'scheduler_tasks';

// Object store config
{
  name: 'scheduler_tasks',
  keyPath: 'id',
  indexes: [
    { name: 'by_status', keyPath: 'status' },
    { name: 'by_scheduled_time', keyPath: 'scheduledTime' },
    { name: 'by_status_time', keyPath: ['status', 'scheduledTime'] },
    { name: 'by_created_at', keyPath: 'createdAt' }
  ]
}
```

---

## 3. Session Isolation for Scheduler Tasks

**Decision**: Create new `Session` instance for each scheduler task execution

**Rationale**:
- Explicit requirement from spec clarification
- Prevents context bleed between unrelated tasks
- Each task gets clean conversation history
- Allows viewing individual task execution in archive

**Implementation Pattern**:
```typescript
async function executeSchedulerTask(task: SchedulerTaskRecord): Promise<void> {
  // Create dedicated session for this task
  const session = new Session({
    conversationId: task.sessionId,  // Pre-generated UUID
    // ... other config
  });

  // Store session reference in task for later retrieval
  await updateTask(task.id, { sessionId: session.conversationId });

  // Execute via existing agent infrastructure
  await agent.executeWithSession(session, task.input);
}
```

---

## 4. Long-Press Gesture Detection

**Decision**: Use `pointerdown`/`pointerup` events with 500ms threshold

**Rationale**:
- Works for both mouse and touch
- 500ms is standard mobile long-press duration
- Doesn't interfere with normal click behavior

**Alternatives Considered**:
- Touch-only events: Rejected - doesn't work for desktop
- Context menu (`contextmenu` event): Rejected - right-click conflicts, mobile inconsistent
- Third-party gesture library: Rejected - overkill for single gesture

**Implementation Pattern**:
```typescript
let pressTimer: number | null = null;
const LONG_PRESS_DURATION = 500;

function handlePointerDown(event: PointerEvent) {
  pressTimer = window.setTimeout(() => {
    showScheduleMenu();
  }, LONG_PRESS_DURATION);
}

function handlePointerUp() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function handlePointerLeave() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}
```

---

## 5. UI Tab Opening for Scheduled Task Execution

**Decision**: Always open sidepanel UI as a new browser tab for scheduled tasks (regardless of whether sidepanel is open)

**Rationale**:
- Sidepanel cannot be opened programmatically (Chrome restriction)
- Never interrupt user's current sidepanel session
- Predictable, consistent behavior
- Clear session isolation (each scheduled task = its own tab)
- Same UI code works in both contexts
- Existing pattern: extension pages can be opened as tabs

**Implementation Pattern**:
```typescript
// Always open a new tab for scheduled task execution
async function openSchedulerTaskTab(taskId: string): Promise<chrome.tabs.Tab> {
  const url = chrome.runtime.getURL(
    `sidepanel/index.html?scheduledTask=${taskId}`
  );

  // Always create new tab - never check sidepanel state
  return chrome.tabs.create({
    url,
    active: true  // Bring to user's attention
  });
}

// In sidepanel/Main.svelte - detect scheduled task mode
onMount(async () => {
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get('scheduledTask');
  if (taskId) {
    // Running as scheduled task in a tab
    await loadAndExecuteSchedulerTask(taskId);
  }
});
```

---

## 6. Scheduler State Persistence

**Decision**: Store task records in IndexedDB, sync critical state to chrome.storage.local

**Rationale**:
- IndexedDB for full task records (efficient queries, large storage)
- chrome.storage.local for `isPaused` flag and `currentTaskId` (fast sync access)
- Ensures scheduler resumes correctly after service worker restart

**Implementation Pattern**:
```typescript
// Quick state in chrome.storage.local
interface SchedulerState {
  isPaused: boolean;
  currentTaskId: string | null;
  lastProcessedTime: number;
}

// Full records in IndexedDB scheduler_tasks store
interface SchedulerTaskRecord {
  id: string;
  input: string;
  scheduledTime: number | null;  // Null for draft tasks
  createdAt: number;
  status: SchedulerTaskStatus;  // draft, scheduled, waiting, running, completed, failed, cancelled
  sessionId: string | null;
  result: TaskResultRecord | null;
  error: string | null;
}
```

---

## 7. SchedulerTaskQueue Processing

**Decision**: FIFO processing of tasks in "waiting" status by `createdAt` timestamp

**Rationale**:
- Simple, predictable execution order
- Distinct from user input queue within a session
- When task completes, automatically process next waiting task
- Respects `isPaused` state

**Implementation Pattern**:
```typescript
async function processSchedulerTaskQueue(): Promise<void> {
  const state = await getSchedulerState();
  if (state.isPaused || state.currentTaskId) {
    return; // Don't process if paused or task running
  }

  const nextTask = await getNextTaskInSchedulerTaskQueue();
  if (nextTask) {
    await executeSchedulerTask(nextTask);
  }
}
```

---

## 8. Browser Notification Pattern

**Decision**: Use `chrome.notifications` API for task alerts

**Rationale**:
- Already available in extension context
- Supports action buttons (limited to 2)
- Works when sidepanel is closed

**Implementation Pattern**:
```typescript
chrome.notifications.create(`task-${taskId}`, {
  type: 'basic',
  iconUrl: chrome.runtime.getURL('icons/icon128.png'),
  title: 'Scheduled Task Started',
  message: task.input.substring(0, 100),
  buttons: [
    { title: 'View' }
  ],
  requireInteraction: true
});

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (notifId.startsWith('task-') && btnIdx === 0) {
    openTaskUI(notifId.replace('task-', ''));
  }
});
```

---

## Existing Patterns Leveraged

| Pattern | Source File | Reuse For |
|---------|-------------|-----------|
| Alarm management | `src/background/rollout-cleanup.ts` | Task scheduling |
| IndexedDB adapter | `src/storage/IndexedDBAdapter.ts` | Scheduler persistence |
| Session creation | `src/core/Session.ts` | Task isolation |
| Message routing | `src/core/MessageRouter.ts` | Scheduler events |
| Footer button | `src/sidepanel/components/layout/FooterBar.svelte` | Scheduler button |
| Popup components | Various existing popups | Scheduler popup |

---

## Open Questions Resolved

| Question | Resolution |
|----------|------------|
| How to persist across SW restarts? | chrome.alarms + IndexedDB |
| How to isolate task sessions? | New Session instance per task |
| How to detect long-press? | pointerdown/pointerup with timer |
| How to show UI when headless? | Open sidepanel as browser tab |
| Where to store scheduler state? | IndexedDB + chrome.storage.local |
| How to differentiate from user input queue? | Named "SchedulerTaskQueue" specifically for waiting tasks |
