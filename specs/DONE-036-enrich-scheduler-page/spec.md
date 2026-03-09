# Feature Specification: Enrich Scheduler Page

**Feature Branch**: `036-enrich-scheduler-page`
**Created**: 2026-03-05
**Status**: Draft
**Input**: User description: "Enrich the functionality and new design page of the scheduler system with active jobs module, job history with search/sort/filter, new job creation module, repeat/recurrence options, and responsive wide/short screen layout"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Scheduler Page with Three Modules Layout (Priority: P1)

The scheduler page (`/scheduler` route) is redesigned from a single schedule-a-job form into a full-featured page containing three distinct modules:

1. **Active Scheduled Jobs Module** - Shows all active (running, scheduled, queued, missed) jobs in a consolidated list
2. **Job History Module** - Shows completed/failed/cancelled jobs with search, sort, and filter capabilities
3. **New Job Module** - Inline form to create and schedule a new job directly from the page (replaces the current modal-only flow)

In **wide screen mode** (>= 1500px via `isWideMode`), the three modules display side by side in a multi-column layout. In **short/narrow screen mode**, the modules stack vertically with collapsible sections.

**Why this priority**: This is the foundational restructuring - all other stories build on this layout.

**Independent Test**: Navigate to `/scheduler`, verify all three modules render, resize the window to toggle between wide and narrow layouts, confirm module layout adapts correctly.

**Acceptance Scenarios**:

1. **Given** the user navigates to `/scheduler`, **When** the page loads, **Then** three distinct modules are visible: Active Jobs, Job History, and New Job
2. **Given** the viewport is >= 1500px wide, **When** viewing the scheduler page, **Then** modules display in a multi-column grid layout
3. **Given** the viewport is < 1500px wide, **When** viewing the scheduler page, **Then** modules stack vertically with collapsible headers
4. **Given** there are active jobs (running, scheduled, queued, missed), **When** the Active Jobs module loads, **Then** all active jobs display grouped by status with real-time updates

---

### User Story 2 - Job History with Search, Sort, and Filter (Priority: P2)

The Job History module enriches the current simple paginated archived jobs view with:

- **Fuzzy search** using Fuse.js (reusing the existing dependency and pattern from SettingsSearch) to search across job input text
- **Sort options**: Newest first (default) and Oldest first, based on `completedAt` timestamp
- **Status filter**: A multi-selection filter allowing users to filter by job status (completed, failed, cancelled). By default, all statuses are selected.

The search, sort, and filter controls appear in the module header. Results update reactively as filters change. Pagination ("Load More") is preserved.

**Why this priority**: Search and filter are core usability features for managing job history, but depend on the page layout from P1.

**Independent Test**: Create several jobs with different statuses, complete/fail them, then use search, sort, and filter controls to verify correct filtering behavior.

**Acceptance Scenarios**:

1. **Given** the Job History module is visible with jobs, **When** the user types a search query, **Then** results are filtered using Fuse.js fuzzy matching on the job input text with 150ms debounce
2. **Given** the Job History has jobs sorted newest first (default), **When** the user selects "Oldest" sort, **Then** jobs re-order by `completedAt` ascending
3. **Given** the status filter shows all statuses selected, **When** the user deselects "failed", **Then** only completed and cancelled jobs appear
4. **Given** search + filter are active, **When** paginating with "Load More", **Then** additional results respect the current search query and filters

---

### User Story 3 - Repeat/Recurrence Options for Scheduled Jobs (Priority: P3)

Jobs can be configured with a repeat/recurrence rule, borrowing patterns from calendar applications:

- **Repeat modes**: None (default, one-time), Daily, Weekly, Monthly, Custom interval
- **Custom interval**: Every N minutes/hours/days/weeks
- **End condition**: Never, After N occurrences, Until a specific date
- **Next run calculation**: When a recurring job completes, the scheduler automatically creates the next job instance based on the recurrence rule

The repeat configuration is available in both the New Job module and the ScheduleJobModal.

**Why this priority**: Repeat functionality adds significant value but requires data model changes and scheduler logic updates. It builds on P1's new job module.

**Independent Test**: Create a job with "Daily" repeat, let it execute, verify a new job is automatically created for the next day.

**Acceptance Scenarios**:

1. **Given** the user is creating a new job, **When** they select "Daily" repeat, **Then** the recurrence rule is saved with the job and displayed in the job details
2. **Given** a recurring job completes successfully, **When** the scheduler processes completion, **Then** a new job is automatically created with the next scheduled time based on the recurrence rule
3. **Given** a recurring job has "After 3 occurrences" end condition, **When** the 3rd occurrence completes, **Then** no further jobs are created
4. **Given** a recurring job has "Until date" end condition, **When** the next calculated time exceeds the end date, **Then** no further jobs are created
5. **Given** the user views an active recurring job, **When** expanding job details, **Then** the repeat rule and remaining occurrences (if applicable) are displayed

---

### Edge Cases

- What happens when a recurring job fails? The next occurrence should still be created (failed jobs don't break the recurrence chain).
- What happens when a recurring job is cancelled? The recurrence chain stops; no further instances are created.
- What if the search query matches zero jobs? Show an empty state message "No jobs match your search".
- What if the user rapidly toggles sort order? The sort should be synchronous on the client-side cached data, not requiring new API calls.
- How does the filter interact with pagination? Filtered results should return correct `hasMore` and `total` counts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The scheduler page MUST display three modules: Active Jobs, Job History, and New Job
- **FR-002**: Modules MUST adapt layout between wide screen (multi-column) and narrow screen (vertical stack) using the existing `isWideMode` store (>= 1500px breakpoint)
- **FR-003**: The Active Jobs module MUST show all jobs with status: running, scheduled, queued, missed, waiting - grouped by status category
- **FR-004**: The Active Jobs module MUST update in real-time when job status changes via SCHEDULER_EVENT messages
- **FR-005**: The Job History module MUST support fuzzy text search using Fuse.js on job `input` field
- **FR-006**: The Job History module MUST support sort toggle between newest-first and oldest-first based on `completedAt`
- **FR-007**: The Job History module MUST support multi-select status filter (completed, failed, cancelled) with all selected by default
- **FR-008**: The New Job module MUST provide inline fields for: task input textarea, date picker, time picker, quick schedule buttons, and repeat configuration
- **FR-009**: The system MUST support recurrence rules with modes: None, Daily, Weekly, Monthly, Custom interval
- **FR-010**: Custom interval recurrence MUST allow specifying: every N units (minutes, hours, days, weeks)
- **FR-011**: Recurrence MUST support end conditions: Never, After N occurrences, Until a specific date
- **FR-012**: When a recurring job completes or fails, the scheduler MUST automatically create the next job instance if the recurrence rule permits
- **FR-013**: When a recurring job is cancelled, the recurrence chain MUST stop
- **FR-014**: The `SchedulerJobRecord` MUST be extended with a `recurrence` field to store the repeat configuration
- **FR-015**: Job History search results MUST update with 150ms debounce matching the existing SettingsSearch pattern
- **FR-016**: Both terminal and modern themes MUST be supported for all new UI components
- **FR-017**: The New Job module MUST validate that scheduled time is at least 30 seconds in the future (preserving existing validation)

### Key Entities

- **SchedulerJobRecord** (extended): Core job record, extended with optional `recurrence` field containing repeat mode, interval, and end condition
- **RecurrenceRule**: New entity describing repeat behavior - mode (none/daily/weekly/monthly/custom), interval (for custom), intervalUnit (minutes/hours/days/weeks), endCondition (never/after/until), endAfterCount, endUntilDate
- **JobHistoryFilter**: Client-side filter state containing search query, sort direction, and selected status set

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can view all active and historical jobs from a single scheduler page without navigating to separate views
- **SC-002**: Users can find a specific historical job using fuzzy search within 3 keystrokes of a meaningful query
- **SC-003**: Users can create and schedule a new job directly from the scheduler page without opening a modal
- **SC-004**: Users can configure recurring jobs that automatically create subsequent instances after completion
- **SC-005**: The scheduler page layout adapts correctly at the 1500px breakpoint, matching the existing `isWideMode` behavior used by AppShell
- **SC-006**: All new components render correctly in both terminal and modern themes
