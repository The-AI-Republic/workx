# Tasks: UI Optimizations

**Input**: Design documents from `/specs/018-ui-optimizations/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, quickstart.md

**Tests**: Not explicitly requested in the feature specification. Omitted per convention.

**Organization**: Tasks are grouped by user story. Both stories are P1 and independent.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: User Story 1 - Wider Conversation Layout (Priority: P1)

**Goal**: Extend the main conversation content container max-width from 900px to 1200px so wider displays use more horizontal space.

**Independent Test**: Open the application in a window wider than 1200px and verify the conversation area extends to 1200px before centering. Narrow the window below 1200px and verify it fills 100% width with no horizontal scrollbar.

### Implementation for User Story 1

- [ ] T001 [US1] Change `.content-container` max-width from `900px` to `1200px` in `src/extension/sidepanel/pages/chat/Main.svelte` (line ~1128)

**Checkpoint**: Content area should now span up to 1200px on wide viewports and remain centered.

---

## Phase 2: User Story 2 - Terminal Sandbox Dark Mode Fix (Priority: P1)

**Goal**: Fix the Sandbox Policy dropdown in Tools Settings so native `<option>` elements render with dark-themed colors in the terminal theme by applying `color-scheme` CSS property.

**Independent Test**: Open Settings > Tools Settings > Advanced Configuration > Sandbox Policy dropdown in the terminal (dark) theme. All three options should be readable with dark background and contrasting text. Switch to ChatGPT theme and verify the dropdown renders with light styling.

### Implementation for User Story 2

- [ ] T002 [US2] Add `color-scheme: dark;` to `.settings-modal-container` CSS rule (terminal theme default) in `src/extension/sidepanel/pages/chat/Main.svelte` (line ~1474)
- [ ] T003 [US2] Add `color-scheme: light;` to `.settings-modal-container.chatgpt` CSS rule in `src/extension/sidepanel/pages/chat/Main.svelte` (line ~1495)

**Checkpoint**: Sandbox Policy dropdown options should be readable in both terminal and ChatGPT themes.

---

## Phase 3: Polish & Cross-Cutting Concerns

**Purpose**: Build verification across both platforms.

- [ ] T004 Run `npm run build` to verify extension build succeeds
- [ ] T005 Run `npm run build:desktop` to verify desktop build succeeds
- [ ] T006 Run `npm run test:all` to verify no test regressions
- [ ] T007 Run quickstart.md verification steps (content width, dropdown dark mode, light theme check)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (US1)**: No dependencies — can start immediately
- **Phase 2 (US2)**: No dependencies — can start immediately (different CSS blocks in same file)
- **Phase 3 (Polish)**: Depends on Phase 1 and Phase 2 completion

### User Story Dependencies

- **User Story 1 (P1)**: Independent — single CSS value change
- **User Story 2 (P1)**: Independent — separate CSS blocks from US1

### Parallel Opportunities

- T001, T002, and T003 edit different CSS rule blocks in the same file. They can be applied sequentially within a single editing session with no conflicts.
- T004 and T005 (builds) can run in parallel after implementation is complete.

---

## Implementation Strategy

### MVP First

1. Complete T001 (US1) — wider content container
2. Complete T002 + T003 (US2) — dropdown dark mode fix
3. Run T004–T007 — verify builds and visual correctness

### Total Scope

All changes are in a single file (`Main.svelte`), modifying 3 CSS properties across 2 rule blocks. Estimated implementation: ~5 minutes of editing.

---

## Notes

- All tasks edit `src/extension/sidepanel/pages/chat/Main.svelte` — coordinate edits to avoid conflicts
- No new files or dependencies introduced
- No test tasks generated (not requested in spec)
- Commit after all implementation tasks (T001–T003) for a single atomic change
