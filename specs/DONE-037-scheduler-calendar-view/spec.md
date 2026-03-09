# Feature Specification: Scheduler Calendar View

**Feature Branch**: `037-scheduler-calendar-view`
**Created**: 2026-03-05
**Status**: Draft
**Input**: User description: "Add calendar view to the scheduler using @event-calendar/core, add a new button named 'Calendar View' in scheduler page, and when user clicks it, it goes to the secondary layer page (/scheduler/calendar) with calendar feature to allow user to view, edit and create new scheduled jobs"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Calendar View Page with Job Visualization (Priority: P1)

A user navigates to the scheduler page and clicks a "Calendar View" button. This opens a new page at `/scheduler/calendar` that renders a full calendar using `@event-calendar/core` v5.x (Svelte 5 native). The calendar displays all scheduled jobs as events on their respective dates/times. The user can see jobs across day, week, and month views. A back button returns to the main scheduler page.

Jobs are mapped to calendar events: the job `input` becomes the event title (truncated), `scheduledTime` becomes the event start, job `status` determines the event color (green=scheduled, blue=running, yellow=missed, red=failed, gray=completed/cancelled).

**Why this priority**: The read-only calendar visualization is the core value proposition - users see their schedule at a glance.

**Independent Test**: Navigate to `/scheduler`, click "Calendar View", verify the calendar renders at `/scheduler/calendar` with existing scheduled jobs displayed as colored events. Switch between day/week/month views. Click back to return to `/scheduler`.

**Acceptance Scenarios**:

1. **Given** the user is on the scheduler page, **When** they click the "Calendar View" button, **Then** they navigate to `/scheduler/calendar` showing a calendar with their scheduled jobs as events
2. **Given** the calendar page is open, **When** the user switches between day, week, and month views, **Then** the calendar updates to show the appropriate time range with job events
3. **Given** jobs exist with different statuses, **When** viewing the calendar, **Then** events are color-coded by status (green=scheduled, blue=running/queued, yellow=missed, red=failed, gray=completed/cancelled)
4. **Given** the calendar page is open, **When** the user clicks the back button, **Then** they return to `/scheduler`
5. **Given** a job status changes while the calendar is open, **When** a `SCHEDULER_EVENT` is received, **Then** the calendar updates the affected event in real-time

---

### User Story 2 - Create Jobs from Calendar (Priority: P2)

The user can create new scheduled jobs directly from the calendar by clicking on an empty time slot. This opens the `ScheduleJobModal` (existing component) pre-filled with the clicked date/time. After scheduling, the new event appears on the calendar.

Uses `@event-calendar/interaction` plugin for click/select interactions on the calendar.

**Why this priority**: Creating jobs from the calendar is the natural next step after viewing, but depends on the calendar being rendered first.

**Independent Test**: On the calendar page, click an empty time slot in the week/day view. Verify the schedule modal opens with the correct date/time pre-filled. Submit a job, verify it appears on the calendar.

**Acceptance Scenarios**:

1. **Given** the user is on the calendar page in day or week view, **When** they click on an empty time slot, **Then** the `ScheduleJobModal` opens with the clicked date and time pre-filled
2. **Given** the schedule modal is open from a calendar click, **When** the user fills in the task and clicks Schedule, **Then** the job is created and immediately appears as a new event on the calendar
3. **Given** the user is on the calendar page in month view, **When** they click on a day cell, **Then** the `ScheduleJobModal` opens with that date pre-filled (time defaults to next hour)

---

### User Story 3 - Edit Jobs from Calendar (Priority: P3)

The user can click on an existing job event on the calendar to view its details and take actions (trigger, cancel, edit time). Clicking an event opens a detail popover or the existing job details panel showing the full job info. The user can also drag-and-drop events to reschedule them (changing `scheduledTime`).

**Why this priority**: Editing builds on both viewing (P1) and the interaction plugin (P2), making it the natural final layer.

**Independent Test**: Click on a scheduled job event on the calendar, verify details popover appears. Drag a scheduled job to a different time slot, verify the scheduled time is updated.

**Acceptance Scenarios**:

1. **Given** the user clicks on a job event on the calendar, **When** the event is in a modifiable status (scheduled/missed/draft), **Then** a detail popover shows job info with Trigger, Cancel, and Reschedule actions
2. **Given** the user clicks on a completed/failed job event, **When** the detail popover opens, **Then** it shows job result summary and a "View Session" link (if sessionId exists)
3. **Given** a scheduled/missed job event on the calendar, **When** the user drags it to a different time slot, **Then** the job's `scheduledTime` is updated and the event moves to the new position
4. **Given** the user drags a completed or running job, **When** they attempt to drop it, **Then** the drag is rejected (only scheduled/missed/draft jobs can be rescheduled)

---

### Edge Cases

- What happens when there are no scheduled jobs? The calendar renders empty with a subtle hint to create a job by clicking a time slot.
- What if a job has no `scheduledTime` (draft)? Draft jobs are not shown on the calendar (they have no time to place them).
- What if many jobs are scheduled at the same time? The calendar library handles overlapping events natively with stacked/side-by-side rendering.
- What if the calendar page is opened on a narrow screen? The calendar should default to day view on narrow screens and week view on wide screens.
- How do recurring jobs (from feature 036) display? Each instance shows as a separate event. If a job has a recurrence rule, a small repeat icon appears on the event.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The scheduler page (`/scheduler`) MUST include a "Calendar View" button that navigates to `/scheduler/calendar`
- **FR-002**: The `/scheduler/calendar` route MUST render a full calendar using `@event-calendar/core` v5.x (Svelte 5 native)
- **FR-003**: The calendar MUST support day, week, and month view modes with a view switcher
- **FR-004**: All scheduled jobs with a `scheduledTime` MUST appear as events on the calendar
- **FR-005**: Calendar events MUST be color-coded by job status (scheduled=green, running/queued=blue, missed=yellow, failed=red, completed/cancelled=gray)
- **FR-006**: The calendar page MUST include a back navigation button to return to `/scheduler`
- **FR-007**: The calendar MUST update in real-time when job status changes via `SCHEDULER_EVENT` messages
- **FR-008**: Clicking an empty time slot on the calendar MUST open the `ScheduleJobModal` with the clicked date/time pre-filled
- **FR-009**: Clicking an existing job event MUST show a detail popover with job information and available actions
- **FR-010**: Drag-and-drop of scheduled/missed/draft job events MUST update the job's `scheduledTime`
- **FR-011**: Drag-and-drop MUST be rejected for completed, failed, running, and cancelled jobs
- **FR-012**: The calendar MUST use `@event-calendar/day-grid` (month view), `@event-calendar/time-grid` (day/week views), and `@event-calendar/interaction` (click/drag) plugins
- **FR-013**: Both terminal and modern themes MUST be supported via CSS variable overrides on the calendar
- **FR-014**: The calendar MUST default to day view on narrow screens and week view on wide screens
- **FR-015**: A new `RESCHEDULE_JOB` message type MUST be added to update a job's `scheduledTime` without cancelling/recreating it

### Key Entities

- **CalendarEvent**: Mapping from `SchedulerJobRecord` to `@event-calendar/core` event format (`id`, `start`, `end`, `title`, `backgroundColor`, `extendedProps`)
- **SchedulerJobRecord** (unchanged): Existing job record - no schema changes needed. Jobs are mapped to events at render time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can visualize their entire job schedule on a calendar at `/scheduler/calendar` in day, week, or month view
- **SC-002**: Users can create a new scheduled job by clicking a time slot on the calendar in under 3 clicks
- **SC-003**: Users can reschedule a job by drag-and-drop in a single interaction
- **SC-004**: The calendar updates within 1 second when a job status changes
- **SC-005**: Both terminal and modern themes render the calendar with appropriate colors and styles
- **SC-006**: The "Calendar View" button is accessible from the scheduler page in both wide and narrow layouts
