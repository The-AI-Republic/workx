# Tasks: Task Scheduler Queue System

**Input**: Design documents from `/specs/014-task-scheduler/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested - test tasks omitted. Add manually if TDD is desired.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Project structure and type definitions

- [x] T001 Create scheduler type definitions in src/models/types/Scheduler.ts (SchedulerTaskRecord, SchedulerTaskStatus, SchedulerState, TaskResultRecord)
- [x] T002 [P] Copy contract interfaces from specs to src/models/types/SchedulerContracts.ts (ISchedulerStorage, ISchedulerAlarms, SchedulerMessageType)
- [x] T003 [P] Create scheduler directory structure: src/core/scheduler/, src/sidepanel/components/scheduler/, src/background/scheduler-alarms.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Add scheduler_tasks object store to IndexedDB migration in src/storage/IndexedDBAdapter.ts (increment DB_VERSION, add store with indexes: by_status, by_scheduled_time, by_status_time, by_created_at)
- [x] T005 Implement SchedulerStorage class in src/core/scheduler/SchedulerStorage.ts (implements ISchedulerStorage - createTask, getTask, updateTask, deleteTask, getDraftTasks, getScheduledTasks, getSchedulerTaskQueueTasks, getArchivedTasks, getNextTaskInSchedulerTaskQueue, getSchedulerState, setSchedulerState)
- [x] T006 Implement SchedulerAlarms class in src/background/scheduler-alarms.ts (implements ISchedulerAlarms - createTaskAlarm, clearTaskAlarm, hasTaskAlarm, startSchedulerTaskQueueProcessor, stopSchedulerTaskQueueProcessor, getAllAlarms, parseAlarmName, getTaskAlarmName)
- [x] T007 Implement core Scheduler class in src/core/scheduler/Scheduler.ts (constructor with storage/alarms/agent dependencies, createDraftTask, scheduleTask, scheduleExistingTask, triggerTask, executeTask, processSchedulerTaskQueue, handleAlarm)
- [x] T008 Add scheduler message handlers to service worker in src/background/service-worker.ts (import Scheduler, SchedulerStorage, SchedulerAlarms; initialize scheduler; add chrome.alarms.onAlarm listener for scheduler- prefix; register message handlers for all SchedulerMessageType)
- [x] T009 Add SchedulerMessageType to existing MessageRouter in src/core/MessageRouter.ts (extend MessageType enum with scheduler message types)

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Schedule Task for Later Execution (Priority: P1)

**Goal**: Allow users to long-press send button to schedule a task for future execution

**Independent Test**: Schedule a task for 1 minute in future, verify it executes automatically when time arrives

### Implementation for User Story 1

- [x] T010 [US1] Add long-press detection to send button in src/sidepanel/components/MessageInput.svelte (pointerdown/pointerup handlers, 500ms threshold, dispatch showScheduleModal event)
- [x] T011 [US1] Create ScheduleTaskModal.svelte in src/sidepanel/components/scheduler/ScheduleTaskModal.svelte (date/time picker, confirm/cancel buttons, dispatch scheduleTask event with input and scheduledTime)
- [x] T012 [US1] Integrate ScheduleTaskModal into Main.svelte in src/sidepanel/pages/chat/Main.svelte (handle showScheduleModal event, show modal, handle scheduleTask event, call router.send SCHEDULE_TASK)
- [x] T013 [US1] Add browser notification on task scheduled in src/core/scheduler/Scheduler.ts (chrome.notifications.create after successful scheduleTask)

**Checkpoint**: User Story 1 complete - users can schedule tasks for future execution

---

## Phase 4: User Story 2 - View and Manage Scheduler Tasks (Priority: P1)

**Goal**: Provide UI to view all scheduled tasks, their status, and archived history

**Independent Test**: Add multiple tasks, verify scheduler popup shows accurate status for each

### Implementation for User Story 2

- [x] T014 [P] [US2] Create SchedulerButton.svelte in src/sidepanel/components/scheduler/SchedulerButton.svelte (calendar icon button, click handler dispatches openScheduler)
- [x] T015 [P] [US2] Create SchedulerTaskItem.svelte in src/sidepanel/components/scheduler/SchedulerTaskItem.svelte (displays task summary, scheduled time, status badge, click handler for details)
- [x] T016 [US2] Create SchedulerPopup.svelte in src/sidepanel/components/scheduler/SchedulerPopup.svelte (fetch GET_SCHEDULED_TASKS, GET_SCHEDULER_TASK_QUEUE, GET_SCHEDULER_STATE; list SchedulerTaskItem components; running task highlight; "View archived" link)
- [x] T017 [US2] Create ArchivedTasksView.svelte in src/sidepanel/components/scheduler/ArchivedTasksView.svelte (fetch GET_ARCHIVED_TASKS with pagination; list completed/failed tasks; click to view session)
- [x] T018 [US2] Add SchedulerButton to FooterBar in src/sidepanel/components/layout/FooterBar.svelte (import SchedulerButton, add beside UserLoginStatus, handle openScheduler event to show SchedulerPopup)
- [x] T019 [US2] Add task details view in SchedulerPopup (click task to expand/show full input, option to navigate to session for completed tasks)
- [x] T020 [US2] Subscribe to TASK_STATUS_CHANGED and SCHEDULER_STATE_CHANGED events in SchedulerPopup for real-time updates

**Checkpoint**: User Story 2 complete - users can view and manage all scheduler tasks

---

## Phase 5: User Story 3 - Interactive Task Execution via Tab UI (Priority: P2)

**Goal**: Scheduled tasks always open in a new browser tab for execution with full UI interaction

**Independent Test**: Schedule a task while sidepanel is open, verify new tab opens without disrupting sidepanel

### Implementation for User Story 3

- [x] T021 [US3] Implement openSchedulerTaskTab in src/core/scheduler/Scheduler.ts (chrome.tabs.create with sidepanel/index.html?scheduledTask={taskId}, active: true)
- [x] T022 [US3] Add scheduled task detection in Main.svelte src/sidepanel/pages/chat/Main.svelte (onMount check URLSearchParams for scheduledTask param, if present call loadAndExecuteSchedulerTask)
- [x] T023 [US3] Implement loadAndExecuteSchedulerTask in Main.svelte (fetch task details via GET_TASK_DETAILS, create new Session, set up UI for task execution, call agent execution)
- [x] T024 [US3] Add session isolation in Scheduler.executeTask in src/core/scheduler/Scheduler.ts (generate new sessionId UUID, create new Session instance, update task with sessionId before execution)
- [x] T025 [US3] Add browser notification when task starts in src/core/scheduler/Scheduler.ts (chrome.notifications.create with "View" button linking to task tab)

**Checkpoint**: User Story 3 complete - scheduled tasks execute in dedicated tabs

---

## Phase 6: User Story 4 - Pause and Resume SchedulerTaskQueue Processing (Priority: P2)

**Goal**: Allow users to pause automatic task execution without losing scheduled tasks

**Independent Test**: Pause queue, verify tasks don't auto-execute, resume and verify execution continues

### Implementation for User Story 4

- [x] T026 [US4] Implement pauseSchedulerTaskQueue in src/core/scheduler/Scheduler.ts (setSchedulerState isPaused: true, stopSchedulerTaskQueueProcessor)
- [x] T027 [US4] Implement resumeSchedulerTaskQueue in src/core/scheduler/Scheduler.ts (setSchedulerState isPaused: false, startSchedulerTaskQueueProcessor, call processSchedulerTaskQueue)
- [x] T028 [US4] Add pause/resume toggle button in SchedulerPopup.svelte (show current isPaused state, call PAUSE_SCHEDULER_TASK_QUEUE or RESUME_SCHEDULER_TASK_QUEUE on click)
- [x] T029 [US4] Update processSchedulerTaskQueue to respect isPaused state (check state.isPaused before executing next task)

**Checkpoint**: User Story 4 complete - users can pause and resume queue processing

---

## Phase 7: User Story 5 - Add Tasks While Another is Running (Priority: P2)

**Goal**: Allow users to add new tasks to queue while another task is executing

**Independent Test**: Start a task, add more tasks during execution, verify they queue properly with "waiting" status

### Implementation for User Story 5

- [x] T030 [US5] Update triggerTask in Scheduler.ts to handle running task scenario (if currentTaskId exists, set new task status to 'waiting' instead of 'running')
- [x] T031 [US5] Update SchedulerPopup to show waiting tasks section (display tasks with status 'waiting' in separate "Queued" section)
- [x] T032 [US5] Ensure processSchedulerTaskQueue is called after task completion in executeTask (on success or failure, call processSchedulerTaskQueue to start next waiting task)

**Checkpoint**: User Story 5 complete - users can queue tasks while another runs

---

## Phase 8: User Story 6 - Cancel or Remove Scheduler Tasks (Priority: P3)

**Goal**: Allow users to cancel pending, scheduled, or running tasks

**Independent Test**: Add tasks, cancel some, verify they are removed and don't execute

### Implementation for User Story 6

- [x] T033 [US6] Implement cancelTask in src/core/scheduler/Scheduler.ts (update task status to 'cancelled', clearTaskAlarm if scheduled, abort execution if running, call processSchedulerTaskQueue)
- [x] T034 [US6] Add cancel button to SchedulerTaskItem.svelte (show cancel/remove icon, call CANCEL_TASK on click, confirm dialog for running tasks)
- [x] T035 [US6] Implement task execution abort mechanism (track AbortController per task, signal abort on cancel, handle abort in agent execution)
- [x] T036 [US6] Add cancel confirmation dialog in SchedulerPopup (warn user when canceling running task, explain implications)

**Checkpoint**: User Story 6 complete - users can cancel any task

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T037 [P] Add error handling and user-friendly error messages throughout scheduler UI components
- [x] T038 [P] Add loading states to SchedulerPopup and ArchivedTasksView during data fetching
- [x] T039 Add missed task detection on browser restart in src/background/service-worker.ts (in initialize, query tasks with status 'scheduled' where scheduledTime < now, update status to 'missed', show notification)
- [x] T040 Add "Run Now" and "Dismiss" buttons for missed tasks in SchedulerTaskItem.svelte (different UI treatment for missed status)
- [x] T041 Show missed tasks section in SchedulerPopup.svelte (highlight missed tasks at top with warning style, count badge)
- [x] T042 Handle offline scenario (queue tasks for execution when connectivity restored)
- [x] T043 [P] Add CSS styling to scheduler components matching existing theme
- [x] T044 Validate scheduler functionality via quickstart.md test scenarios
- [x] T045 [P] Add scheduler-specific logging throughout core classes for debugging

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-8)**: All depend on Foundational phase completion
  - US1 and US2 are both P1 and can proceed in parallel
  - US3, US4, US5 depend on US1 (need scheduling to exist)
  - US6 can start after foundational but benefits from US1-US5
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational - No dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational - No dependencies on other stories
- **User Story 3 (P2)**: Depends on US1 (needs scheduled tasks to execute)
- **User Story 4 (P2)**: Depends on US1 (needs scheduled tasks and queue)
- **User Story 5 (P2)**: Depends on US1 and US3 (needs task execution working)
- **User Story 6 (P3)**: Can start after Foundational, integrates with all other stories

### Within Each User Story

- Foundational components before UI
- Core logic before integration
- Story complete before moving to next priority

### Parallel Opportunities

**Phase 1 (Setup):**
```
T002 and T003 can run in parallel (different files)
```

**Phase 2 (Foundational):**
```
After T004 (DB migration), T005-T007 can be worked on, but T008-T009 depend on them
```

**Phase 4 (US2):**
```
T014 and T015 can run in parallel (different component files)
```

**Phase 9 (Polish):**
```
T037, T038, T041, T043 can all run in parallel (different concerns)
```

**Cross-Story Parallel:**
```
US1 and US2 can be worked on in parallel by different developers
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (scheduling capability)
4. Complete Phase 4: User Story 2 (visibility into scheduled tasks)
5. **STOP and VALIDATE**: Test scheduling and viewing independently
6. Deploy/demo if ready - users can schedule and view tasks

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 → Can schedule tasks (MVP!)
3. Add US2 → Can view/manage tasks (MVP complete!)
4. Add US3 → Tasks execute in tabs
5. Add US4 → Can pause/resume queue
6. Add US5 → Can queue while running
7. Add US6 → Can cancel tasks
8. Polish → Production ready

### Suggested MVP Scope

**Minimum Viable Product**: User Stories 1 + 2 (both P1)
- Schedule tasks for future execution
- View all scheduled tasks and their status
- This provides core value - automated task scheduling with visibility

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Chrome alarms have 1-minute minimum - handle tasks scheduled <1 min separately
- Always open scheduled tasks in new tab (never interrupt sidepanel)
- Each scheduled task creates isolated Session instance
