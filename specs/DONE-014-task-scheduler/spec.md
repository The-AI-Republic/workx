# Feature Specification: Task Scheduler Queue System

**Feature Branch**: `014-task-scheduler`
**Created**: 2026-02-02
**Status**: Draft
**Input**: User description: "Task scheduler queue system for automatic sequential task execution"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Schedule Task for Later Execution (Priority: P1)

As a user, I want to schedule an AI task to run at a specific time so that I can queue up work to be done automatically without having to be present to trigger it.

**Why this priority**: This is the core value proposition - allowing users to queue tasks that execute automatically. Without this, the feature has no purpose.

**Independent Test**: Can be fully tested by scheduling a task for 1 minute in the future and verifying it executes automatically when the time arrives.

**Acceptance Scenarios**:

1. **Given** I have the sidepanel open and typed a task in the message input, **When** I long-press the send button and select "Schedule this task" and set a future time, **Then** the task is saved with "scheduled" status
2. **Given** I have scheduled a task for 2:30 PM, **When** 2:30 PM arrives (even if sidepanel is closed), **Then** the task begins execution automatically
3. **Given** I have scheduled a task, **When** I close the browser and reopen it after the scheduled time, **Then** the task executes upon browser restart

---

### User Story 2 - View and Manage Scheduler Tasks (Priority: P1)

As a user, I want to see all my scheduled tasks and their status so that I can understand what work is pending, running, or completed.

**Why this priority**: Users need visibility into their scheduled tasks to trust the system and make informed decisions about task management.

**Independent Test**: Can be fully tested by adding multiple tasks and verifying the scheduler display shows accurate status for each task.

**Acceptance Scenarios**:

1. **Given** I have multiple scheduled tasks, **When** I click the Scheduler button at the bottom of the sidepanel, **Then** a popup menu appears showing all upcoming tasks with their scheduled time and summary
2. **Given** a task is currently running, **When** I view the scheduler, **Then** I see the running task highlighted with progress indication
3. **Given** I have completed tasks, **When** I click "View archived" at the bottom of the scheduler popup, **Then** I can see execution history including completion time and outcome
4. **Given** I click on a completed task in the archive, **When** I select it, **Then** I can view the full session/conversation for that task execution

---

### User Story 3 - Interactive Task Execution via Tab UI (Priority: P2)

As a user, I want scheduled tasks to always open in a dedicated browser tab so that I can view progress, approve actions, and interact with tasks without interrupting my current sidepanel session.

**Why this priority**: Critical for tasks requiring user approval and for maintaining clear session separation.

**Independent Test**: Can be fully tested by scheduling a task while actively using the sidepanel, and verifying a new tab opens without disrupting the sidepanel.

**Acceptance Scenarios**:

1. **Given** a scheduled task triggers (regardless of sidepanel state), **When** the task starts, **Then** a new browser tab opens with the task interface showing task progress
2. **Given** a running task requires approval for a tool action, **When** the approval is needed, **Then** the tab UI displays the approval request and waits for my response
3. **Given** a task is running in the tab UI, **When** I interact with approval buttons, **Then** the task continues based on my decision
4. **Given** the sidepanel is open with my own conversation, **When** a scheduled task triggers, **Then** my sidepanel session remains untouched

---

### User Story 4 - Pause and Resume SchedulerTaskQueue Processing (Priority: P2)

As a user, I want to pause automatic task execution so that I can stop the SchedulerTaskQueue temporarily without losing my scheduled tasks.

**Why this priority**: Provides user control over automation, which is important for managing unexpected situations.

**Independent Test**: Can be fully tested by pausing the SchedulerTaskQueue, verifying tasks don't auto-execute, then resuming and verifying execution continues.

**Acceptance Scenarios**:

1. **Given** I have tasks in the scheduler, **When** I pause the SchedulerTaskQueue, **Then** no new tasks start automatically until I resume
2. **Given** a task is currently running and I pause the SchedulerTaskQueue, **When** the current task completes, **Then** the next task does not start automatically
3. **Given** the SchedulerTaskQueue is paused with pending tasks, **When** I resume the SchedulerTaskQueue, **Then** the next pending task begins execution

---

### User Story 5 - Add Tasks While Another is Running (Priority: P2)

As a user, I want to add new tasks while another task is running so that I can build up a queue of work without waiting for the current task to finish.

**Why this priority**: Enables efficient batch processing workflows without interrupting current work.

**Independent Test**: Can be fully tested by starting a task, adding more tasks during execution, and verifying they are added properly to the SchedulerTaskQueue.

**Acceptance Scenarios**:

1. **Given** a task is currently running, **When** I submit a new task, **Then** the new task is added with "waiting" status (in the SchedulerTaskQueue)
2. **Given** I have added multiple tasks while one is running, **When** each task completes, **Then** the next task in SchedulerTaskQueue starts automatically
3. **Given** I add a task while another is running, **When** I view the scheduler, **Then** I see both the running task and my newly added task

---

### User Story 6 - Cancel or Remove Scheduler Tasks (Priority: P3)

As a user, I want to cancel pending tasks or remove them from the scheduler so that I can change my mind about scheduled work.

**Why this priority**: Important for user control but less critical than core scheduling functionality.

**Independent Test**: Can be fully tested by adding tasks, canceling some, and verifying they are removed and don't execute.

**Acceptance Scenarios**:

1. **Given** I have a pending task in the scheduler, **When** I cancel/remove it, **Then** the task is removed and will not execute
2. **Given** I have a scheduled task for the future, **When** I cancel it, **Then** the scheduled alarm is cleared and the task won't trigger
3. **Given** a task is currently running, **When** I cancel it, **Then** the task stops and the next task in SchedulerTaskQueue can proceed (if SchedulerTaskQueue not paused)

---

### Edge Cases

- What happens when the browser is closed during task execution? Task state is saved, and execution can resume or report partial completion when browser restarts.
- What happens when a scheduled task fails (e.g., network error)? Task is marked as "failed" with error details, and the SchedulerTaskQueue continues to the next task.
- What happens when multiple tasks are scheduled for the exact same time? Tasks execute sequentially in the order they were scheduled (FIFO in the SchedulerTaskQueue).
- What happens if the system is offline when a scheduled task should run? Task is queued for execution when connectivity is restored.
- What happens if a task requires approval but no UI can be opened? Task pauses and waits; user is notified via browser notification to open the extension.
- What happens to scheduler state when the browser restarts? State persists and resumes from where it left off. Overdue tasks are marked as "missed" and require user action.
- What happens when a task is "missed"? Task status changes to "missed", user is notified, and must manually trigger or cancel the task.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow users to schedule tasks for execution at a specific future time
- **FR-002**: System MUST persist scheduled tasks across browser sessions and restarts
- **FR-003**: System MUST automatically execute scheduled tasks when their designated time arrives
- **FR-004**: System MUST execute tasks sequentially (one at a time) via the SchedulerTaskQueue
- **FR-005**: System MUST provide a "Scheduler" button on the bottom of the sidepanel (beside user center/login) that opens a popup menu
- **FR-005a**: Scheduler popup menu MUST display upcoming scheduled tasks showing time and task summary
- **FR-005b**: Clicking a scheduled task in the menu MUST show the full task details
- **FR-005c**: Scheduler popup MUST provide an option at the bottom to view archived (completed/failed) tasks
- **FR-017**: System MUST support long-press on the message send button to reveal a popup menu with "Schedule this task" option
- **FR-018**: System MUST create a NEW session/conversation for each scheduled task execution (tasks MUST NOT execute under the same session)
- **FR-006**: System MUST support task statuses: draft, scheduled, missed, waiting, running, completed, failed, cancelled
- **FR-007**: System MUST allow users to pause and resume automatic SchedulerTaskQueue processing
- **FR-008**: System MUST allow users to cancel pending or scheduled tasks
- **FR-009**: System MUST always open scheduled tasks in a new browser tab (never use or interrupt the sidepanel)
- **FR-010**: System MUST notify users via browser notification when a scheduled task starts or requires attention
- **FR-011**: System MUST allow users to add new tasks to the SchedulerTaskQueue while another task is running
- **FR-012**: System MUST automatically proceed to the next task in SchedulerTaskQueue when the current task completes (unless paused)
- **FR-013**: System MUST save task execution results and make them viewable in task history
- **FR-014**: System MUST add tasks to SchedulerTaskQueue in "waiting" status when their scheduled time arrives but another task is running
- **FR-015**: System MUST handle tasks that require user approval by pausing execution and requesting approval through the UI
- **FR-016**: System MUST wake from idle state to execute scheduled tasks (even if extension UI is closed)

### Key Entities

- **SchedulerTask**: Represents a user task in the scheduler. Contains: unique identifier, user input/description, scheduled time, creation time, status, execution result, dedicated session ID (each task runs in its own isolated session)
- **SchedulerTaskQueue**: The FIFO queue for tasks in "waiting" status - tasks blocked by a currently running task. Processed in createdAt order. Distinct from the user input queue within a session.
- **TaskResult**: The outcome of a completed task. Contains: task reference, completion status, execution transcript/log, completion time, any errors encountered
- **SchedulerState**: The persistent state of the scheduler, stored in IndexedDB/chrome.storage.local. Contains: pause state, current running task ID, execution history

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Scheduled tasks execute within 5 seconds of their designated time (when browser is running)
- **SC-002**: 100% of scheduler state persists correctly across browser restarts
- **SC-003**: Users can schedule, view, pause, resume, and cancel tasks without any guidance (intuitive UI)
- **SC-004**: Tasks requiring user interaction successfully open an interactive UI 100% of the time when the sidepanel is closed
- **SC-005**: SchedulerTaskQueue correctly processes 20+ sequential tasks without manual intervention
- **SC-006**: Users can add tasks to the SchedulerTaskQueue while another task is running without disrupting the running task
- **SC-007**: Failed tasks do not block SchedulerTaskQueue progression - the SchedulerTaskQueue continues to the next task

## Clarifications

### Session 2026-02-02

- Q: Where should scheduler metadata be stored and how should users access the scheduler UI? → A: Scheduler metadata stored in IndexedDB. New "Scheduler" button on bottom of sidepanel (beside user center/login). Clicking it pops up a menu showing all scheduled tasks (time + summary). Clicking a task shows details. Bottom of list has option to view archived (completed) tasks.
- Q: How do users schedule a task? → A: Long-press on the message send button pops up a menu with "Schedule this task" option. Each scheduled task creates a NEW session/conversation (tasks must not execute under the same session).
- Q: What happens when a scheduled task triggers while the sidepanel is already open? → A: Always open a new browser tab for the scheduled task. Never interrupt or switch the user's current sidepanel session. This ensures predictable behavior and clear session isolation.
- Q: What happens when a task's scheduled time passes while the browser/computer is shut down? → A: On browser restart, check for overdue tasks (scheduledTime < now). Mark them as "missed" status instead of auto-executing. Show notification to user about missed tasks. User must manually trigger or cancel missed tasks. This keeps user in control and avoids surprise executions.

## Assumptions

- Users have granted notification permissions to the extension for task alerts
- The browser will be running (even if minimized) for scheduled tasks to execute at their designated time
- Tasks scheduled while the browser is closed will be marked as "missed" when browser reopens (user must manually trigger)
- The existing BrowserxAgent and task execution infrastructure will be leveraged for running individual tasks
- Standard web application performance expectations apply (sub-second UI interactions)

## Out of Scope

- Recurring/repeating task schedules (e.g., "run every day at 9 AM")
- Task dependencies (e.g., "run task B only after task A completes successfully")
- Multi-browser synchronization of task queues
- Mobile browser support
- Collaborative/shared task queues between users
