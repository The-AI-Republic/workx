# Tasks: Enrich Scheduler Page

**Input**: Design documents from `/specs/036-enrich-scheduler-page/`
**Prerequisites**: plan.md, spec.md, data-model.md

**Tests**: Not explicitly requested in the spec. Test tasks omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: No new project setup needed - this feature builds entirely on the existing codebase. Existing dependencies (Svelte 4, Fuse.js 7.1.0, Tailwind CSS, svelte-spa-router) are already installed.

_(No tasks in this phase)_

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Extend shared type definitions that multiple user stories depend on. These changes are additive and backwards-compatible.

- [X] T001 Extend `SchedulerJobRecord` with optional `recurrence` field and add `RecurrenceRule`, `RecurrenceMode`, `RecurrenceIntervalUnit`, `RecurrenceEndCondition` type definitions in `src/core/models/types/Scheduler.ts`. Also add `isRecurrenceRule` type guard and `createScheduledJobRecordWithRecurrence` factory function.
- [X] T002 Extend message payloads in `src/core/models/types/SchedulerContracts.ts`: add `recurrence?: RecurrenceRule` to `ScheduleJobRequest` and `ArchivedJobSummary`, add `sortDirection?: 'newest' | 'oldest'` and `statusFilter?: SchedulerJobStatus[]` to `GetArchivedJobsRequest`, add `'cancelled'` to the `ArchivedJobSummary.status` union type.

**Checkpoint**: Type definitions extended - user story implementation can now begin

---

## Phase 3: User Story 1 - Scheduler Page with Three Modules Layout (Priority: P1) MVP

**Goal**: Redesign the scheduler page from a single schedule-a-job form into a full-featured page with three distinct modules (Active Jobs, Job History, New Job) that adapt between wide-screen multi-column and narrow-screen vertical-stack layouts.

**Independent Test**: Navigate to `/scheduler`, verify all three modules render with correct content, resize the window past the 1500px breakpoint to confirm layout switches between grid and vertical stack.

### Implementation for User Story 1

- [X] T003 [P] [US1] Create `ActiveJobsModule.svelte` in `src/webfront/components/scheduler/ActiveJobsModule.svelte`. This component fetches and displays all active jobs (running, missed, queued, scheduled) grouped by status category using `SchedulerJobItem`. It subscribes to `SCHEDULER_EVENT` messages for real-time updates. Props: none (self-contained, fetches own data). Support both terminal and modern themes via `uiTheme` store. Include collapsible header for narrow mode (prop `collapsible: boolean`, `initialExpanded: boolean`).
- [X] T004 [P] [US1] Create `NewJobModule.svelte` in `src/webfront/components/scheduler/NewJobModule.svelte`. This is an inline job creation form extracted from the existing `ScheduleJobModal.svelte` / `Scheduler.svelte` logic: task input textarea, date/time pickers, quick schedule buttons (2m, 5m, 15m, 30m, 1h, 3h, 24h), schedule preview with relative time, validation (30s minimum future), and a Schedule button that calls `SCHEDULER_SCHEDULE_JOB`. Props: `collapsible: boolean`, `initialExpanded: boolean`. Support both themes. Dispatch `'scheduled'` event on success.
- [X] T005 [P] [US1] Create `JobHistoryModule.svelte` shell in `src/webfront/components/scheduler/JobHistoryModule.svelte`. For US1, this is a basic version that fetches archived jobs via `SCHEDULER_GET_ARCHIVED_JOBS` and displays them using `SchedulerJobItem` with pagination ("Load More"). Props: `collapsible: boolean`, `initialExpanded: boolean`. Include a header area with placeholder slots for search/sort/filter controls (to be filled in US2). Support both themes.
- [X] T006 [US1] Rewrite `src/webfront/pages/scheduler/Scheduler.svelte` as the three-module container page. Import `isWideMode` from `layoutStore.ts`, `ActiveJobsModule`, `JobHistoryModule`, and `NewJobModule`. In wide mode (`$isWideMode`): render a 3-column CSS grid layout - Active Jobs (left column), New Job (center column), Job History (right column). In narrow mode: render a vertical stack with New Job (top, expanded by default), Active Jobs (middle, expanded), Job History (bottom, collapsed by default). Pass `collapsible` and `initialExpanded` props accordingly. Support both terminal and modern themes. Remove the old single-form schedule UI entirely.

**Checkpoint**: Scheduler page shows three functional modules with responsive layout. Active jobs display in real-time, new jobs can be created inline, and job history is browsable with pagination.

---

## Phase 4: User Story 2 - Job History with Search, Sort, and Filter (Priority: P2)

**Goal**: Enrich the Job History module with fuzzy search (Fuse.js), sort toggle (newest/oldest), and multi-select status filter (completed/failed/cancelled).

**Independent Test**: Create several jobs with different statuses (complete some, fail some, cancel some). Open the scheduler page, use the search bar to find a job by partial input text, toggle sort between newest/oldest, and filter by specific statuses.

### Implementation for User Story 2

- [X] T007 [P] [US2] Create `StatusFilter.svelte` in `src/webfront/components/scheduler/StatusFilter.svelte`. A multi-select pill/chip toggle component. Props: `statuses: string[]` (available statuses), `selected: Set<string>` (currently selected). Dispatches `'change'` event with updated `Set<string>`. Each status renders as a toggleable pill button. All selected by default. Support both themes.
- [X] T008 [P] [US2] Extend `SchedulerStorage.getArchivedJobs()` in `src/core/scheduler/SchedulerStorage.ts` to accept optional `sortDirection` (`'newest' | 'oldest'`) and `statusFilter` (`SchedulerJobStatus[]`) parameters. Sort by `completedAt` ascending or descending. Filter results to only include jobs whose status is in the `statusFilter` array. Include `'cancelled'` jobs in archived queries (currently only `'completed'` and `'failed'` are returned). Update `getArchivedJobsCount()` to also accept `statusFilter`.
- [X] T009 [US2] Enrich `JobHistoryModule.svelte` in `src/webfront/components/scheduler/JobHistoryModule.svelte` with search, sort, and filter functionality. Add: (1) A search input with Fuse.js integration - build a Fuse index on the `input` field (weight: 2) and `status` field (weight: 1) of fetched archived jobs, with 150ms debounced search matching the pattern from `src/webfront/settings/components/SettingsSearch.svelte`. (2) A sort toggle button (Newest/Oldest) that re-sorts the client-side cached array by `completedAt`. (3) Import and use `StatusFilter.svelte` with statuses `['completed', 'failed', 'cancelled']`. Apply search, then status filter, then sort, then render. Pass `sortDirection` and `statusFilter` to the `SCHEDULER_GET_ARCHIVED_JOBS` message for server-side filtering on "Load More". Show "No jobs match your search" empty state when filters yield zero results.
- [X] T010 [US2] Update the archived jobs message handler in `src/extension/service-worker.ts` (or equivalent message handler) to pass `sortDirection` and `statusFilter` from `GetArchivedJobsRequest` through to `SchedulerStorage.getArchivedJobs()`.

**Checkpoint**: Job History module supports fuzzy search, sort toggle, and multi-select status filter. Pagination works correctly with active filters.

---

## Phase 5: User Story 3 - Repeat/Recurrence Options for Scheduled Jobs (Priority: P3)

**Goal**: Add repeat/recurrence configuration to scheduled jobs with modes (Daily, Weekly, Monthly, Custom), end conditions (Never, After N, Until date), and automatic next-job creation on completion/failure.

**Independent Test**: Create a job with "Daily" repeat and "After 3 occurrences" end condition. Let it execute (or manually trigger). Verify a new scheduled job is automatically created for the next day. Repeat until 3 occurrences complete, then verify no more jobs are created.

### Implementation for User Story 3

- [X] T011 [P] [US3] Create `src/core/scheduler/recurrence.ts` with recurrence calculation utilities. Implement: (1) `calculateNextRunTime(lastScheduledTime: number, rule: RecurrenceRule): number | null` - calculates the next scheduled time based on mode (daily=+24h, weekly=+7d, monthly=same day next month via Date arithmetic, custom=interval*unitToMs). Returns `null` if end condition is met (`after` and completedCount >= endAfterCount, or `until` and next time > endUntilDate). (2) `shouldContinueRecurrence(rule: RecurrenceRule): boolean` - checks if another occurrence should be created. (3) `createNextRecurrenceRule(rule: RecurrenceRule): RecurrenceRule` - returns a new rule with `completedCount` incremented by 1. (4) `formatRecurrenceRule(rule: RecurrenceRule): string` - human-readable description (e.g., "Every day", "Every 2 hours, 3 of 5 completed").
- [X] T012 [P] [US3] Create `RecurrenceSelector.svelte` in `src/webfront/components/scheduler/RecurrenceSelector.svelte`. A form component for configuring recurrence. Props: `recurrence: RecurrenceRule | null` (current value). Dispatches `'change'` event with updated `RecurrenceRule | null`. UI includes: (1) Mode selector: None / Daily / Weekly / Monthly / Custom (dropdown or segmented control). (2) When Custom selected: interval number input + unit selector (minutes/hours/days/weeks). (3) End condition: Never / After N occurrences (number input) / Until date (date picker). Default: mode=None (disabled state showing "Does not repeat"). Support both themes.
- [X] T013 [US3] Modify `src/core/scheduler/Scheduler.ts` to handle recurrence in `completeJob()` and `failJob()` methods. After marking a job as completed/failed, check if the job has a `recurrence` rule. If so, call `shouldContinueRecurrence()` and `calculateNextRunTime()` from `recurrence.ts`. If a next run time is returned, create a new `SchedulerJobRecord` with the same `input`, the calculated `scheduledTime`, status `'scheduled'`, and an updated recurrence rule (via `createNextRecurrenceRule()`). Set `parentJobId` to the original job's ID (or inherit from parent). Call `createJobAlarm()` for the new job. In `cancelJob()`, do NOT create next occurrence (recurrence chain stops on cancel).
- [X] T014 [US3] Modify `src/core/scheduler/Scheduler.ts` `scheduleJob()` method to accept and store the optional `recurrence` field from `ScheduleJobRequest`. Pass it through to `SchedulerStorage.createJob()` / `updateJob()`.
- [X] T015 [US3] Add `RecurrenceSelector` to `NewJobModule.svelte` in `src/webfront/components/scheduler/NewJobModule.svelte`. Import and render `RecurrenceSelector` below the date/time pickers. Bind its value to a local `recurrence` variable. Include the `recurrence` field in the `SCHEDULER_SCHEDULE_JOB` message payload when scheduling.
- [X] T016 [US3] Add `RecurrenceSelector` to `ScheduleJobModal.svelte` in `src/webfront/components/scheduler/ScheduleJobModal.svelte`. Import and render `RecurrenceSelector` below the date/time pickers. Include `recurrence` in the dispatched `'schedule'` event detail. Update `SchedulerPopup.svelte`'s `handleScheduleJob` to pass `recurrence` through to the `SCHEDULER_SCHEDULE_JOB` message.
- [X] T017 [US3] Add recurrence badge to `SchedulerJobItem.svelte` in `src/webfront/components/scheduler/SchedulerJobItem.svelte`. If the job has a `recurrence` field, display a small repeat icon/badge next to the status badge showing the recurrence mode (e.g., a circular arrow icon with "Daily" / "Weekly" / etc.). Use `formatRecurrenceRule()` from `recurrence.ts` for the tooltip/title text. Update the component's props to accept the optional `recurrence` field.
- [X] T018 [US3] Update the schedule job message handler in `src/extension/service-worker.ts` (or equivalent) to pass the `recurrence` field from `ScheduleJobRequest` through to `Scheduler.scheduleJob()`.

**Checkpoint**: Recurring jobs can be created, automatically spawn next occurrences on completion/failure, respect end conditions, and display recurrence info in the UI.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final integration, edge cases, and quality improvements

- [X] T019 Verify the `SchedulerPopup` in `src/webfront/components/scheduler/SchedulerPopup.svelte` still works correctly with all changes - existing popup flow should be unaffected. The popup's "Add Job" button opens `ScheduleJobModal` which now includes recurrence. Test that the popup's job lists correctly show recurrence badges.
- [X] T020 Add i18n translation keys for all new UI strings across all new components. Ensure all user-facing text uses `$_t()` or `t()` wrappers. Key strings: "Active Jobs", "Job History", "New Job", "Search jobs...", "Newest", "Oldest", "Completed", "Failed", "Cancelled", "Does not repeat", "Daily", "Weekly", "Monthly", "Custom", "Never", "After", "occurrences", "Until", "No jobs match your search", "Repeat", "Every".
- [X] T021 [P] Verify type-check passes by running `npm run type-check` and fix any TypeScript errors introduced by the new/modified files.
- [X] T022 [P] Verify lint passes by running `npm run lint` on all new/modified files in `src/core/scheduler/`, `src/core/models/types/`, and `src/webfront/components/scheduler/` and `src/webfront/pages/scheduler/`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: N/A - no setup tasks needed
- **Foundational (Phase 2)**: T001, T002 - type extensions that all stories reference. BLOCKS all user stories.
- **User Story 1 (Phase 3)**: T003-T006 - depends on Phase 2 completion
- **User Story 2 (Phase 4)**: T007-T010 - depends on Phase 2 + US1 (T005 JobHistoryModule shell)
- **User Story 3 (Phase 5)**: T011-T018 - depends on Phase 2 + US1 (T004 NewJobModule, T006 page layout)
- **Polish (Phase 6)**: T019-T022 - depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Depends only on Phase 2. This is the MVP.
- **User Story 2 (P2)**: Depends on Phase 2 + T005 (JobHistoryModule shell from US1).
- **User Story 3 (P3)**: Depends on Phase 2 + T004 (NewJobModule from US1). Can run in parallel with US2.

### Within Each User Story

- Components marked [P] can be created in parallel (different files)
- Integration tasks (page wiring, message handler updates) come after component creation
- Checkpoint validation before moving to next story

### Parallel Opportunities

**Phase 2**: T001 and T002 touch different files - can run in parallel

**Phase 3 (US1)**: T003, T004, T005 are independent new components - all three can run in parallel. T006 (page rewrite) depends on all three.

**Phase 4 (US2)**: T007 and T008 touch different files - can run in parallel. T009 depends on T007 and T008. T010 depends on T008.

**Phase 5 (US3)**: T011 and T012 are independent new files - can run in parallel. T013-T014 depend on T011. T015-T016 depend on T012. T017 depends on T011. T018 depends on T013/T014.

**Phase 6**: T021 and T022 can run in parallel.

---

## Parallel Example: User Story 1

```bash
# Launch all new module components in parallel (different files):
Task T003: "Create ActiveJobsModule.svelte"
Task T004: "Create NewJobModule.svelte"
Task T005: "Create JobHistoryModule.svelte shell"

# Then wire them together (depends on T003, T004, T005):
Task T006: "Rewrite Scheduler.svelte as three-module container"
```

## Parallel Example: User Story 3

```bash
# Launch recurrence logic and UI in parallel (different files):
Task T011: "Create recurrence.ts calculation utilities"
Task T012: "Create RecurrenceSelector.svelte UI component"

# Then integrate (depends on T011, T012):
Task T013: "Add recurrence handling to Scheduler.ts completeJob/failJob"
Task T015: "Add RecurrenceSelector to NewJobModule.svelte"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational type extensions (T001-T002)
2. Complete Phase 3: Three-module layout (T003-T006)
3. **STOP and VALIDATE**: Navigate to `/scheduler`, verify three modules render, test responsive layout at 1500px breakpoint
4. Deploy/demo if ready - this delivers the core page restructuring

### Incremental Delivery

1. Phase 2 (T001-T002) -> Foundation ready
2. Phase 3 US1 (T003-T006) -> Three-module page with responsive layout (MVP!)
3. Phase 4 US2 (T007-T010) -> Job History gains search, sort, filter
4. Phase 5 US3 (T011-T018) -> Recurrence system with auto-scheduling
5. Phase 6 (T019-T022) -> Polish, i18n, verification
6. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies on each other
- [Story] label maps task to specific user story for traceability
- Existing components (`SchedulerPopup`, `ArchivedJobsView`, `SchedulerButton`) remain unchanged and functional
- The `recurrence` field is optional on `SchedulerJobRecord` - full backwards compatibility with existing jobs
- All new UI components must support both `terminal` and `modern` themes using `uiTheme` store
- All user-facing strings must use i18n wrappers (`$_t()` / `t()`)
