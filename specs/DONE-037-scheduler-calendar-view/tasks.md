# Tasks: Scheduler Calendar View

**Input**: Design documents from `/specs/037-scheduler-calendar-view/`
**Prerequisites**: plan.md, spec.md

**Tests**: Not explicitly requested in the spec. Test tasks omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Install new npm dependencies required by the calendar feature.

- [X] T001 Install `@event-calendar/core@^5.4.1`, `@event-calendar/day-grid@^5.4.1`, `@event-calendar/time-grid@^5.4.1`, `@event-calendar/list@^5.4.1`, and `@event-calendar/interaction@^5.4.1` as dependencies via `npm install`. Verify all five packages resolve correctly in `package-lock.json`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Backend/core changes needed before any UI story can be implemented. Adds the `RESCHEDULE_JOB` message type, the `rescheduleJob()` scheduler method, the `getAllJobsInRange()` storage query, and fixes the nav active-state for sub-routes.

- [X] T002 [P] Add `RESCHEDULE_JOB` to `SchedulerMessageType` enum, add `RescheduleJobRequest` (`{ jobId: string; scheduledTime: number }`) and `RescheduleJobResponse` (`{ success: boolean; error?: string }`) interfaces, and add `GET_ALL_JOBS_IN_RANGE` message type with `GetAllJobsInRangeRequest` (`{ startTime: number; endTime: number }`) and `GetAllJobsInRangeResponse` (`{ jobs: SchedulerJobSummary[] }`) in `src/core/models/types/SchedulerContracts.ts`.
- [X] T003 [P] Add `getAllJobsInRange(startTime: number, endTime: number): Promise<SchedulerJobRecord[]>` method to `src/core/scheduler/SchedulerStorage.ts`. This queries the `scheduler_jobs` IndexedDB store using the `by_scheduled_time` index and returns all jobs whose `scheduledTime` falls within the given range (inclusive), regardless of status. Skip jobs with `scheduledTime === null` (drafts).
- [X] T004 [P] Add `rescheduleJob(jobId: string, newScheduledTime: number): Promise<void>` method to `src/core/scheduler/Scheduler.ts`. This method: (1) fetches the job, (2) validates status is `scheduled`, `missed`, or `draft`, (3) updates `scheduledTime` and sets status to `scheduled`, (4) clears the old alarm via `clearJobAlarm()`, (5) creates a new alarm via `createJobAlarm()`, (6) emits a `JOB_STATUS_CHANGED` event. Throw an error if the job status is not reschedulable.
- [X] T005 [P] Fix `isNavActive()` in `src/webfront/stores/layoutStore.ts` to use `startsWith` matching for non-root routes. Change line `return currentLocation === route;` to `return currentLocation.startsWith(route);` so that `/scheduler/calendar` correctly highlights the `/scheduler` nav item.
- [X] T006 Add `RESCHEDULE_JOB` and `GET_ALL_JOBS_IN_RANGE` message handlers in `src/extension/service-worker.ts` (or the equivalent message routing file). `RESCHEDULE_JOB` calls `scheduler.rescheduleJob(jobId, scheduledTime)`. `GET_ALL_JOBS_IN_RANGE` calls `schedulerStorage.getAllJobsInRange(startTime, endTime)` and maps results to `SchedulerJobSummary` format.

**Checkpoint**: Core API ready - calendar UI can now fetch jobs by date range and reschedule jobs.

---

## Phase 3: User Story 1 - Calendar View Page with Job Visualization (Priority: P1) MVP

**Goal**: Add a "Calendar View" button to the scheduler page and a new `/scheduler/calendar` route that renders an interactive calendar displaying all scheduled jobs as color-coded events across day/week/month views.

**Independent Test**: Navigate to `/scheduler`, click "Calendar View", verify calendar renders at `/scheduler/calendar` with job events. Switch between day/week/month views. Click back to return to `/scheduler`. Confirm real-time updates when job status changes.

### Implementation for User Story 1

- [X] T007 [P] [US1] Create `src/webfront/lib/calendarUtils.ts` with the following exports: (1) `jobToCalendarEvent(job: SchedulerJobRecord, theme: 'modern' | 'terminal'): object | null` - maps a `SchedulerJobRecord` to an `@event-calendar/core` event object (`{ id, start, end, title, backgroundColor, extendedProps: { job } }`). Returns `null` for jobs without `scheduledTime`. Title is `job.input.slice(0, 50)`. End time defaults to `scheduledTime + 30min`. (2) `statusToColor(status: SchedulerJobStatus, theme: 'modern' | 'terminal'): string` - returns the color for each status per the plan's color mapping table. (3) `jobsToCalendarEvents(jobs: SchedulerJobRecord[], theme: 'modern' | 'terminal'): object[]` - batch mapper that filters nulls.
- [X] T008 [P] [US1] Create `src/webfront/components/scheduler/CalendarWrapper.svelte`. This component wraps `@event-calendar/core` with theme integration. Props: `events: object[]` (calendar events array), `initialView: string` (e.g., `'timeGridWeek'`). It imports `Calendar` from `@event-calendar/core`, plugins from `@event-calendar/day-grid`, `@event-calendar/time-grid`, and `@event-calendar/list`. Import the base CSS from `@event-calendar/core/index.css`. Configure the calendar with `headerToolbar` showing view switcher buttons (dayGridMonth, timeGridWeek, timeGridDay). Subscribe to `uiTheme` store and apply theme-specific CSS overrides: for terminal theme, set CSS custom properties on a wrapper `<div>` to override calendar colors (dark background, green text/borders, monospace font); for modern theme, use `--chat-*` variables. Forward `dateClick`, `eventClick`, `eventDrop`, and `datesSet` events via Svelte `createEventDispatcher`. Expose a `getApi()` method to access the calendar instance for programmatic updates.
- [X] T009 [US1] Create `src/webfront/pages/scheduler/SchedulerCalendar.svelte` as the calendar page component. This is the route-level page for `/scheduler/calendar`. It: (1) imports `CalendarWrapper`, `calendarUtils`, `isWideMode` from `layoutStore`, `sendMessage`/`MessageType` from messaging, and `uiTheme`; (2) on mount, determines initial view (`timeGridWeek` if `$isWideMode`, else `timeGridDay`); (3) fetches jobs via `GET_ALL_JOBS_IN_RANGE` using the visible calendar date range, maps them with `jobsToCalendarEvents()`; (4) subscribes to `SCHEDULER_EVENT` messages to re-fetch and update events in real-time; (5) renders a header with a back button (navigates to `/scheduler` via `push('/scheduler')`) and the page title "Calendar"; (6) renders `<CalendarWrapper>` with the events and initial view; (7) listens for `datesSet` event from CalendarWrapper to re-fetch when the visible range changes. Support both terminal and modern themes.
- [X] T010 [US1] Add the `/scheduler/calendar` route in `src/webfront/App.svelte`. Import `SchedulerCalendar` from `./pages/scheduler/SchedulerCalendar.svelte`. Add the route entry `'/scheduler/calendar': SchedulerCalendar` to the `routes` object. Ensure it is listed BEFORE the `'/scheduler'` entry to prevent prefix-matching issues with svelte-spa-router.
- [X] T011 [US1] Add a "Calendar View" button to `src/webfront/pages/scheduler/Scheduler.svelte`. Import `push` from `svelte-spa-router`. Add a button with a calendar icon and text "Calendar View" that calls `push('/scheduler/calendar')` on click. Place it in the page header area. Style it consistently with existing buttons for both terminal and modern themes. Use `$_t('Calendar View')` for i18n.

**Checkpoint**: Calendar page is accessible from the scheduler, displays all jobs as color-coded events, supports day/week/month views, and updates in real-time.

---

## Phase 4: User Story 2 - Create Jobs from Calendar (Priority: P2)

**Goal**: Allow users to create new scheduled jobs by clicking on empty time slots in the calendar. Clicking opens the existing `ScheduleJobModal` pre-filled with the clicked date/time.

**Independent Test**: On the calendar page in day or week view, click an empty time slot. Verify `ScheduleJobModal` opens with the clicked date/time. Submit a new job, verify the event appears on the calendar immediately.

### Implementation for User Story 2

- [X] T012 [P] [US2] Modify `src/webfront/components/scheduler/ScheduleJobModal.svelte` to accept optional `prefillDate` and `prefillTime` props (`export let prefillDate: string = '';` and `export let prefillTime: string = '';`). In `initializeDefaults()`, if `prefillDate` is provided, use it instead of computing from current time. If `prefillTime` is provided, use it instead of the default next-hour. This allows the calendar to pre-fill the modal with the clicked slot's date/time.
- [X] T013 [US2] Add `@event-calendar/interaction` plugin to `CalendarWrapper.svelte` in `src/webfront/components/scheduler/CalendarWrapper.svelte`. Import `Interaction` from `@event-calendar/interaction` and add it to the plugins array. Configure `dateClick` callback to dispatch a `'dateClick'` event with `{ date, dateStr, view }`. Configure `select` callback (for time-range selection in day/week views) to dispatch a `'select'` event with `{ start, end, startStr, endStr }`.
- [X] T014 [US2] Integrate job creation into `SchedulerCalendar.svelte` in `src/webfront/pages/scheduler/SchedulerCalendar.svelte`. Add: (1) import `ScheduleJobModal`; (2) state variables `showScheduleModal`, `prefillDate`, `prefillTime`; (3) handle `dateClick` event from `CalendarWrapper` - extract the clicked date/time, format as `YYYY-MM-DD` and `HH:MM`, set `prefillDate`/`prefillTime`, set `showScheduleModal = true`; (4) for month view clicks, default `prefillTime` to next rounded hour; (5) handle `schedule` event from `ScheduleJobModal` - call `SCHEDULER_SCHEDULE_JOB`, then re-fetch events to update the calendar; (6) render `<ScheduleJobModal>` with the `show`, `prefillDate`, `prefillTime`, and `input=""` props.

**Checkpoint**: Users can click empty time slots to create new jobs directly from the calendar.

---

## Phase 5: User Story 3 - Edit Jobs from Calendar (Priority: P3)

**Goal**: Allow users to click on job events to see details/take actions, and drag-and-drop events to reschedule jobs.

**Independent Test**: Click on a scheduled job event, verify detail popover shows with actions. Drag a scheduled event to a new time, verify `scheduledTime` is updated. Try dragging a completed job, verify it's rejected.

### Implementation for User Story 3

- [X] T015 [P] [US3] Create `src/webfront/components/scheduler/EventPopover.svelte`. A themed popover component for displaying job details when a calendar event is clicked. Props: `job: SchedulerJobRecord`, `show: boolean`, `position: { x: number; y: number }` (for absolute positioning near the clicked event). Displays: job status badge (color-coded), full input text, scheduled time, created time, and action buttons depending on status: (a) for scheduled/missed/draft: "Trigger" and "Cancel" buttons; (b) for completed/failed with `sessionId`: "View Session" link that navigates to `index.html?sessionId=...`; (c) for completed/failed without sessionId: read-only info. Dispatch `'trigger'`, `'cancel'`, and `'close'` events. Support both terminal and modern themes. Include a close button and close on outside click.
- [X] T016 [US3] Add drag-and-drop support to `CalendarWrapper.svelte` in `src/webfront/components/scheduler/CalendarWrapper.svelte`. Configure the `@event-calendar/interaction` plugin with: (1) `eventDragStart` - check `event.extendedProps.job.status`; if status is not `scheduled`, `missed`, or `draft`, prevent the drag (set `editable: false` on non-reschedulable events via the `eventClassNames` or `eventContent` callback, or use `eventAllow` callback to reject); (2) `eventDrop` callback - dispatch `'eventDrop'` event with `{ event, oldEvent }` containing the job ID and new start time. Set `editable` per-event based on job status in the event mapping (add `editable: isReschedulable(job.status)` in `calendarUtils.ts`).
- [X] T017 [US3] Add `isReschedulable(status: SchedulerJobStatus): boolean` to `src/webfront/lib/calendarUtils.ts`. Returns `true` for `scheduled`, `missed`, `draft`; `false` for all other statuses. Update `jobToCalendarEvent()` to include `editable: isReschedulable(job.status)` in the returned event object.
- [X] T018 [US3] Integrate event click and drag-and-drop into `SchedulerCalendar.svelte` in `src/webfront/pages/scheduler/SchedulerCalendar.svelte`. Add: (1) import `EventPopover`; (2) state for `showPopover`, `popoverJob`, `popoverPosition`; (3) handle `eventClick` from `CalendarWrapper` - extract the job from `event.extendedProps.job`, compute popover position from the click event coordinates, set state to show popover; (4) handle `eventDrop` from `CalendarWrapper` - extract `jobId` and new `start` time, call `sendMessage(MessageType.SCHEDULER_RESCHEDULE_JOB, { jobId, scheduledTime: start.getTime() })`, then re-fetch events; (5) handle popover `trigger`/`cancel` events - call respective `SCHEDULER_TRIGGER_JOB` / `SCHEDULER_CANCEL_JOB` messages and re-fetch; (6) render `<EventPopover>` with the state props.

**Checkpoint**: Users can click events to view details, take actions, and drag-and-drop to reschedule jobs.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final integration, i18n, and quality verification.

- [X] T019 Add i18n translation keys for all new UI strings. Ensure all user-facing text uses `$_t()` or `t()` wrappers across all new/modified components. Key strings: "Calendar View", "Calendar", "Back to Scheduler", "Trigger", "Cancel", "View Session", "No scheduled jobs yet. Click a time slot to create one.", "Scheduled", "Running", "Missed", "Failed", "Completed", "Cancelled".
- [X] T020 [P] Add `SCHEDULER_RESCHEDULE_JOB` and `SCHEDULER_GET_JOBS_IN_RANGE` to the `MessageType` enum in `src/webfront/lib/messaging.ts` (or `src/core/MessageRouter.ts`, wherever the UI-facing message type constants are defined) so the frontend can reference them. Verify the message type strings match between the frontend `MessageType` enum and the backend `SchedulerMessageType` enum.
- [X] T021 [P] Run `npm run type-check` and fix any TypeScript errors in new/modified files: `calendarUtils.ts`, `CalendarWrapper.svelte`, `SchedulerCalendar.svelte`, `EventPopover.svelte`, `ScheduleJobModal.svelte`, `SchedulerContracts.ts`, `Scheduler.ts`, `SchedulerStorage.ts`, `App.svelte`, `layoutStore.ts`.
- [X] T022 [P] Run `npm run lint` on all new/modified files and fix any linting errors.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 - no dependencies, can start immediately
- **Foundational (Phase 2)**: T002-T006 - depends on T001 (npm install). BLOCKS all UI stories.
- **User Story 1 (Phase 3)**: T007-T011 - depends on Phase 2 completion
- **User Story 2 (Phase 4)**: T012-T014 - depends on Phase 2 + US1 (T008 CalendarWrapper, T009 SchedulerCalendar)
- **User Story 3 (Phase 5)**: T015-T018 - depends on Phase 2 + US1 (T008 CalendarWrapper, T009 SchedulerCalendar) + T007 (calendarUtils)
- **Polish (Phase 6)**: T019-T022 - depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Depends only on Phase 2. This is the MVP.
- **User Story 2 (P2)**: Depends on US1 (needs CalendarWrapper and SchedulerCalendar page). Can run in parallel with US3.
- **User Story 3 (P3)**: Depends on US1 (needs CalendarWrapper and SchedulerCalendar page). Can run in parallel with US2.

### Within Each User Story

- Utility files ([P]) can be created in parallel with components
- Page-level integration tasks come after their component dependencies
- Checkpoint validation before moving to next story

### Parallel Opportunities

**Phase 2**: T002, T003, T004, T005 all touch different files - can run in parallel. T006 depends on T002-T004.

**Phase 3 (US1)**: T007 and T008 are independent new files - can run in parallel. T009 depends on T007 and T008. T010 and T011 depend on T009 (route needs the component to exist).

**Phase 4 (US2)**: T012 is independent (ScheduleJobModal modification). T013 depends on T008 (CalendarWrapper exists). T014 depends on T012 and T013.

**Phase 5 (US3)**: T015 and T017 are independent new files - can run in parallel. T016 depends on T008 + T017. T018 depends on T015 and T016.

**Phase 6**: T020, T021, T022 can all run in parallel.

---

## Parallel Example: User Story 1

```bash
# Launch utilities and calendar wrapper in parallel (different files):
Task T007: "Create calendarUtils.ts mapping utilities"
Task T008: "Create CalendarWrapper.svelte with theme integration"

# Then build the page (depends on T007, T008):
Task T009: "Create SchedulerCalendar.svelte page component"

# Then wire up route and button (depends on T009):
Task T010: "Add /scheduler/calendar route to App.svelte"
Task T011: "Add Calendar View button to Scheduler.svelte"
```

## Parallel Example: User Story 3

```bash
# Launch popover and utility update in parallel (different files):
Task T015: "Create EventPopover.svelte"
Task T017: "Add isReschedulable() to calendarUtils.ts"

# Then add drag-and-drop (depends on T017):
Task T016: "Add drag-and-drop support to CalendarWrapper.svelte"

# Then integrate into page (depends on T015, T016):
Task T018: "Integrate event click and drag-and-drop into SchedulerCalendar.svelte"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Install npm packages (T001)
2. Complete Phase 2: Foundational core changes (T002-T006)
3. Complete Phase 3: Calendar view page (T007-T011)
4. **STOP and VALIDATE**: Navigate to `/scheduler`, click "Calendar View", verify calendar renders with events, switch views, click back
5. Deploy/demo if ready - this delivers the core calendar visualization

### Incremental Delivery

1. Phase 1 (T001) -> Packages installed
2. Phase 2 (T002-T006) -> Core API ready (reschedule, range query, nav fix)
3. Phase 3 US1 (T007-T011) -> Calendar view page with read-only visualization (MVP!)
4. Phase 4 US2 (T012-T014) -> Create jobs by clicking time slots
5. Phase 5 US3 (T015-T018) -> Click events for details, drag-and-drop reschedule
6. Phase 6 (T019-T022) -> i18n, type-check, lint
7. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies on each other
- [Story] label maps task to specific user story for traceability
- `@event-calendar/core` v5.x is used (Svelte 5 native) since project targets Svelte 5
- Base CSS must be imported: `import '@event-calendar/core/index.css'` in CalendarWrapper
- No data model changes - jobs are mapped to calendar events at render time via `calendarUtils.ts`
- The `isNavActive()` fix (T005) ensures `/scheduler/calendar` highlights the scheduler nav item
- All new UI components must support both `terminal` and `modern` themes
- All user-facing strings must use i18n wrappers (`$_t()` / `t()`)
- US2 and US3 can run in parallel after US1 completes
