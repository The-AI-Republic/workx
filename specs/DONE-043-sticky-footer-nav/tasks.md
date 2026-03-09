# Tasks: Sticky Footer Navigation Bar

**Input**: Design documents from `/specs/043-sticky-footer-nav/`
**Prerequisites**: plan.md, spec.md

**Tests**: No tests requested — this is a layout restructuring with manual visual verification.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: No setup needed — this feature modifies existing files only. No new dependencies or project structure changes.

*(No tasks in this phase)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Move FooterBar from Chat page to AppShell — this must happen before page-specific adjustments.

- [x] T001 Add FooterBar import and rendering to AppShell layout in `src/webfront/components/layout/AppShell.svelte` — wrap the content slot in a flex-col container with FooterBar as a shrink-0 sibling below the content area
- [x] T002 Remove FooterBar import and `<FooterBar />` usage from Chat page in `src/webfront/pages/chat/Main.svelte` — delete the import statement and the `<FooterBar />` element from the fixed bottom controls container

**Checkpoint**: FooterBar now renders from AppShell on all pages. Chat page no longer duplicates it.

---

## Phase 3: User Story 1 — Persistent navigation across all pages (Priority: P1)

**Goal**: Footer nav bar visible and functional on every page in narrow mode.

**Independent Test**: Navigate to Chat, Scheduler, Skills, and SchedulerCalendar in narrow mode (<1500px). Verify the bottom nav bar is visible on each page with the correct active icon highlighted. Click each nav icon to confirm navigation works.

### Implementation for User Story 1

- [x] T003 [P] [US1] Change Chat page root div from `h-screen` to `h-full` in `src/webfront/pages/chat/Main.svelte` — the AppShell content area now constrains height, so pages should fill available space rather than claiming full viewport
- [x] T004 [P] [US1] Change Scheduler page root div from `h-screen` to `h-full` in `src/webfront/pages/scheduler/Scheduler.svelte` — same reason as T003
- [x] T005 [P] [US1] Change Skills page root div from `h-screen` to `h-full` in `src/webfront/pages/skills/Skills.svelte` — same reason as T003

**Checkpoint**: All pages show the footer nav bar in narrow mode. Navigation between pages works. Active state correctly highlights the current page.

---

## Phase 4: User Story 2 — Footer does not overlap page content (Priority: P2)

**Goal**: No page content is hidden behind the footer bar.

**Independent Test**: On each page in narrow mode, add enough content to require scrolling. Scroll to the very bottom and verify the last item is fully visible above the footer bar.

### Implementation for User Story 2

- [x] T006 [US2] Verify and adjust overflow handling on the AppShell content area in `src/webfront/components/layout/AppShell.svelte` — ensure the content div uses `flex-1 min-h-0 overflow-hidden` so child pages can scroll independently within the constrained space above the footer
- [x] T007 [US2] Verify Scheduler page scroll behavior in `src/webfront/pages/scheduler/Scheduler.svelte` — confirm `overflow-y-auto` still works correctly now that the page uses `h-full` instead of `h-screen`; adjust if content is cut off or scroll doesn't reach bottom

**Checkpoint**: All pages scroll correctly with no content hidden behind the footer.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [x] T008 Verify wide mode is unchanged — confirm the sidebar still renders, the footer remains minimal, and no layout regressions in wide mode (>=1500px) across all pages
- [x] T009 Verify both terminal and modern themes render the footer correctly in its new position across all pages
- [x] T010 Run `npm test && npm run lint` to ensure no regressions

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No dependencies — start immediately. T001 and T002 are sequential (T001 before T002 to avoid momentary duplication).
- **User Story 1 (Phase 3)**: Depends on Phase 2 completion. T003, T004, T005 can run in parallel.
- **User Story 2 (Phase 4)**: Depends on Phase 3 completion (need pages using h-full before verifying scroll).
- **Polish (Phase 5)**: Depends on Phase 4 completion.

### Parallel Opportunities

```bash
# After Phase 2 completes, launch all page height fixes in parallel:
T003: Chat page h-screen → h-full
T004: Scheduler page h-screen → h-full
T005: Skills page h-screen → h-full
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Move FooterBar to AppShell, remove from Chat (T001, T002)
2. Complete Phase 3: Fix page heights (T003, T004, T005)
3. **STOP and VALIDATE**: Footer visible on all pages, navigation works
4. This is a shippable MVP

### Full Delivery

1. Phases 2-3: MVP as above
2. Phase 4: Verify scroll/overlap behavior (T006, T007)
3. Phase 5: Cross-cutting verification (T008, T009, T010)

---

## Notes

- Total tasks: 10
- US1 tasks: 3 (T003-T005)
- US2 tasks: 2 (T006-T007)
- Foundational: 2 (T001-T002)
- Polish: 3 (T008-T010)
- Parallel opportunities: T003/T004/T005 can all run simultaneously
- No new files created — all changes are to existing files
- FooterBar.svelte requires zero modifications
