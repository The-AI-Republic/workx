# Implementation Plan: Calendar Slot Duration & New Button

**Branch**: `040-calendar-slot-newbutton` | **Date**: 2026-03-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/040-calendar-slot-newbutton/spec.md`

## Summary

Two small UI changes to the scheduler calendar view: (1) reduce the visual event block duration from 30 minutes to 15 minutes for better readability when events are close together, and (2) add a "New" button to the calendar page header for quick schedule creation.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (strict mode, ES2020 target)
**Primary Dependencies**: Svelte 4/5, @event-calendar/core, Tailwind CSS
**Storage**: N/A (no storage changes)
**Testing**: Manual visual verification + existing test suite (`npm test`)
**Target Platform**: Browser (Chrome extension + Tauri desktop)
**Project Type**: Web frontend
**Constraints**: Must work with both terminal and modern themes

## Constitution Check

*No project constitution configured — using default practices.*

## Project Structure

### Documentation (this feature)

```text
specs/040-calendar-slot-newbutton/
├── spec.md              # Feature specification
└── plan.md              # This file
```

### Source Code (files to modify)

```text
src/webfront/lib/calendarUtils.ts               # Change event duration constant (30 → 15 min)
src/webfront/pages/scheduler/SchedulerCalendar.svelte  # Add "New" button + handler
```

**Structure Decision**: Pure modification of 2 existing files. No new files needed.

## Implementation Details

### Change 1: Event Duration (calendarUtils.ts)

**Lines 70 and 107** — replace `30 * 60 * 1000` with `15 * 60 * 1000`:

```typescript
// jobToCalendarEvent (line 70)
end: new Date(job.scheduledTime + 15 * 60 * 1000),

// instanceToCalendarEvent (line 107)
end: new Date(instance.instanceTime + 15 * 60 * 1000),
```

Consider extracting a constant `EVENT_DISPLAY_DURATION_MS = 15 * 60 * 1000` at the top of the file for maintainability.

### Change 2: "New" Button (SchedulerCalendar.svelte)

Add a "New" button in the header section (after line 296, before `</div>`):

- Position: In the header flex row, pushed to the right with `ml-auto`
- Click handler: `handleNewClick()` — sets `prefillDate` to today, `prefillTime` to next rounded hour, closes any open popover, opens the modal
- Styling: Matches existing theme conventions — green border/text for terminal, standard button for modern
- Icon: Plus icon (SVG) with "New" text label

**Handler logic:**
```typescript
function handleNewClick() {
  const now = new Date();
  now.setHours(now.getHours() + 1, 0, 0, 0);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  prefillDate = `${year}-${month}-${day}`;
  prefillTime = `${String(now.getHours()).padStart(2, '0')}:00`;
  showPopover = false;
  showScheduleModal = true;
}
```

## Complexity Tracking

> No violations — minimal two-file change with no new abstractions.
