# Feature Specification: Calendar Slot Duration & New Button

**Feature Branch**: `040-calendar-slot-newbutton`
**Created**: 2026-03-07
**Status**: Draft
**Input**: User description: "1. Change time slot to 15 mins for calendar view. 2. Add a New button in the calendar page view on the top left of the page"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Shorter Calendar Event Blocks (Priority: P1)

When viewing the scheduler calendar (week or day view), scheduled events currently render as 30-minute blocks. This makes closely-spaced jobs (e.g., 5 minutes apart) overlap heavily, wasting visual space and reducing readability. Events should render as 15-minute blocks instead.

**Why this priority**: Directly improves calendar readability — the primary visual element users interact with.

**Independent Test**: Open the calendar in week or day view with at least one scheduled job. Verify the event block spans exactly 15 minutes on the time grid instead of 30.

**Acceptance Scenarios**:

1. **Given** a scheduled job at 2:00 PM, **When** viewing the calendar in timeGridWeek or timeGridDay, **Then** the event block spans from 2:00 PM to 2:15 PM (15 minutes).
2. **Given** two scheduled jobs 10 minutes apart (2:00 PM and 2:10 PM), **When** viewing the calendar, **Then** the two event blocks overlap by only 5 minutes instead of 20 minutes.
3. **Given** events from both legacy jobs and new-model instances, **When** rendered on the calendar, **Then** both use 15-minute visual duration.

---

### User Story 2 - New Schedule Button on Calendar Page (Priority: P1)

Users currently must click on a specific calendar date/time slot to create a new scheduled job. There should be an explicit "New" button in the top-left header area of the calendar page that opens the schedule creation modal with sensible defaults (next rounded hour).

**Why this priority**: Equally important — provides a discoverable, always-available entry point for creating schedules without requiring users to know about the click-to-create interaction.

**Independent Test**: Navigate to the calendar page. Verify a "New" button is visible in the header. Click it and confirm the schedule modal opens with defaults.

**Acceptance Scenarios**:

1. **Given** the user is on the calendar page, **When** they look at the header bar, **Then** a "New" button is visible next to the back button and "Calendar" title.
2. **Given** the user clicks the "New" button, **When** the current time is 2:37 PM, **Then** the schedule modal opens with the date set to today and time set to 3:00 PM (next rounded hour).
3. **Given** the user clicks "New" and completes the schedule form, **When** they submit, **Then** the new event appears on the calendar immediately.
4. **Given** both terminal and modern themes, **When** viewing the calendar page, **Then** the "New" button styling is consistent with the existing back button and theme conventions.

---

### Edge Cases

- What happens when the "New" button is clicked at 11:37 PM? → Time defaults to 12:00 AM next day (next rounded hour wraps to tomorrow).
- What happens when an event popover is open and the user clicks "New"? → Popover closes, modal opens.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Calendar event blocks MUST render with a 15-minute visual duration in all calendar views (timeGridWeek, timeGridDay, dayGridMonth).
- **FR-002**: Both legacy `jobToCalendarEvent()` and new-model `instanceToCalendarEvent()` MUST use 15-minute duration for the `end` time calculation.
- **FR-003**: The calendar page header MUST include a "New" button positioned after the back button and title.
- **FR-004**: Clicking the "New" button MUST open the ScheduleJobModal with `prefillDate` set to today and `prefillTime` set to the next rounded hour.
- **FR-005**: The "New" button MUST be styled consistently with the existing theme system (terminal and modern themes).
- **FR-006**: If an event popover is open when "New" is clicked, the popover MUST close before the modal opens.

### Key Entities

- **CalendarEvent**: Existing entity — `end` field calculation changes from +30min to +15min.
- No new entities required.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All calendar event blocks render as 15-minute spans (verifiable by visual inspection in week/day views).
- **SC-002**: The "New" button is visible and functional on the calendar page in both terminal and modern themes.
- **SC-003**: Clicking "New" opens the schedule modal with correct default date/time (next rounded hour from current time).
- **SC-004**: No regression in existing calendar interactions (date click, event click, event drag-and-drop, popover actions).
