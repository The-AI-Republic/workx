# Tasks: Calendar Slot Duration & New Button

**Input**: Design documents from `/specs/040-calendar-slot-newbutton/`
**Prerequisites**: plan.md (required), spec.md (required)

**Tests**: Not explicitly requested — no test tasks included.

**Organization**: Tasks are grouped by user story. Both stories are P1 and can be implemented in parallel (they touch different files/sections).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: No setup needed — this feature modifies only existing files with no new dependencies.

*(No tasks)*

---

## Phase 2: Foundational

**Purpose**: No foundational/blocking work needed — both stories are self-contained UI changes.

*(No tasks)*

---

## Phase 3: User Story 1 - Shorter Calendar Event Blocks (Priority: P1) 🎯 MVP

**Goal**: Reduce visual event block duration from 30 minutes to 15 minutes so closely-spaced scheduled jobs are easier to distinguish on the calendar.

**Independent Test**: Open the calendar in week or day view with a scheduled job. Verify the event block spans 15 minutes, not 30.

### Implementation for User Story 1

- [x] T001 [P] [US1] Extract event display duration constant and update legacy job mapping in `src/webfront/lib/calendarUtils.ts` — add `const EVENT_DISPLAY_DURATION_MS = 15 * 60 * 1000;` near the top of the file, then replace `30 * 60 * 1000` with `EVENT_DISPLAY_DURATION_MS` on line 70 in `jobToCalendarEvent()`
- [x] T002 [P] [US1] Update new-model instance mapping in `src/webfront/lib/calendarUtils.ts` — replace `30 * 60 * 1000` with `EVENT_DISPLAY_DURATION_MS` on line 107 in `instanceToCalendarEvent()`

**Checkpoint**: Calendar events now render as 15-minute blocks. Verify visually in timeGridWeek and timeGridDay views.

---

## Phase 4: User Story 2 - New Schedule Button on Calendar Page (Priority: P1)

**Goal**: Add a "New" button to the calendar page header that opens the schedule creation modal with sensible defaults (today's date, next rounded hour).

**Independent Test**: Navigate to calendar page. Verify "New" button is visible in header. Click it and confirm the modal opens with correct defaults.

### Implementation for User Story 2

- [x] T003 [US2] Add `handleNewClick()` function in `src/webfront/pages/scheduler/SchedulerCalendar.svelte` — create handler that computes today's date and next rounded hour, sets `prefillDate`/`prefillTime`, closes any open popover (`showPopover = false`), and opens the modal (`showScheduleModal = true`)
- [x] T004 [US2] Add "New" button to header in `src/webfront/pages/scheduler/SchedulerCalendar.svelte` — insert a button with plus icon and "New" label after the `<h1>` title element (before the closing `</div>` of the header), using `ml-auto` to push it right, with theme-aware styling matching existing button conventions (terminal: green border/text, modern: standard button style), wired to `handleNewClick()`

**Checkpoint**: "New" button visible in both themes. Clicking it opens modal with correct date/time defaults. Submitting creates the event on the calendar.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [x] T005 Verify no regressions in existing calendar interactions — date click still opens modal, event click opens popover, drag-and-drop reschedules, both themes render correctly

---

## Dependencies & Execution Order

### Phase Dependencies

- **User Story 1 (Phase 3)**: No dependencies — can start immediately
- **User Story 2 (Phase 4)**: No dependencies — can start immediately
- **Polish (Phase 5)**: Depends on both stories being complete

### User Story Dependencies

- **User Story 1 (US1)**: Independent — modifies only `calendarUtils.ts`
- **User Story 2 (US2)**: Independent — modifies only `SchedulerCalendar.svelte`
- US1 and US2 touch **different files** and can be implemented fully in parallel

### Parallel Opportunities

- T001 and T002 can run in parallel (different functions in same file, but non-conflicting)
- US1 (T001-T002) and US2 (T003-T004) can run in parallel (different files entirely)

---

## Parallel Example

```bash
# Both stories can execute simultaneously:
# Story 1 (calendarUtils.ts):
Task T001: "Extract constant + update jobToCalendarEvent in calendarUtils.ts"
Task T002: "Update instanceToCalendarEvent in calendarUtils.ts"

# Story 2 (SchedulerCalendar.svelte):
Task T003: "Add handleNewClick() handler"
Task T004: "Add New button to header"
```

---

## Implementation Strategy

### MVP First (Either Story)

1. Complete US1 (T001-T002) — 15-minute event blocks
2. **STOP and VALIDATE**: Verify calendar renders correctly
3. Complete US2 (T003-T004) — New button
4. **STOP and VALIDATE**: Verify button works in both themes
5. Run T005 regression check

### Parallel Delivery

Both stories can be implemented simultaneously since they modify different files:
- US1: `src/webfront/lib/calendarUtils.ts`
- US2: `src/webfront/pages/scheduler/SchedulerCalendar.svelte`

---

## Notes

- Total tasks: **5** (2 for US1, 2 for US2, 1 polish)
- Both user stories are P1 and independent
- No new files, no new dependencies, no data model changes
- Commit after each story completion for clean history
