# Tasks: Tab Select Menu UX Improvements

**Input**: Design documents from `/specs/020-tab-select-ux/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/component-api.md, quickstart.md

**Tests**: Included — existing test file `tests/unit/TabContext.test.ts` must be updated for both features.

**Organization**: Tasks are grouped by user story. Both stories modify `TabContext.svelte` but target different template sections (tooltip wrapping vs. active tab prefix), so US1 can be completed before US2 sequentially.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: No project initialization needed — this feature modifies an existing component in an existing project. No new dependencies required.

*(No tasks in this phase)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add i18n entry for "(current)" label — required before US2 can render the prefix.

- [X] T001 [P] Add "(current)" i18n entry to `_locales/en/messages.json` following existing key pattern (add key like `_current_` with message `(current)`)
- [X] T002 [P] Add "(current)" i18n entry to `_locales/en_GB/messages.json` with same key and message
- [X] T003 [P] Add "(current)" key mapping to `_locales/key_map.json` (map source text `(current)` to generated key)
- [X] T004 Add `chrome.tabs.onActivated` mock to `beforeEach` block in `tests/unit/TabContext.test.ts` (add `onActivated: { addListener: vi.fn(), removeListener: vi.fn() }` alongside existing `onUpdated` mock)

**Checkpoint**: i18n entries ready, test mocks prepared — user story implementation can begin.

---

## Phase 3: User Story 1 - Tooltip on Tab Option Hover (Priority: P1) 🎯 MVP

**Goal**: Show a tooltip with the full tab title when hovering over any tab option in the dropdown menu.

**Independent Test**: Open tab dropdown, hover over a tab with a long title, verify tooltip shows complete title.

### Implementation for User Story 1

- [X] T005 [US1] Wrap each regular tab dropdown item with `<Tooltip content={tab.title || tab.url || 'Untitled'} placement="right">` in `src/extension/sidepanel/components/common/TabContext.svelte` (lines 277-292: wrap the `.dropdown-item` div for each tab in the `{#each availableTabs as tab}` loop)
- [X] T006 [US1] Wrap the "Create New Tab" dropdown item with `<Tooltip content={$_t("Create New Tab")} placement="right">` in `src/extension/sidepanel/components/common/TabContext.svelte` (lines 258-271: wrap the `.dropdown-item.new-tab-option` div)
- [X] T007 [US1] Add tooltip unit tests in `tests/unit/TabContext.test.ts`: test that dropdown items render Tooltip components with correct `content` prop containing full tab title

**Checkpoint**: User Story 1 complete — tooltips appear on hover for all dropdown items. Can be tested independently.

---

## Phase 4: User Story 2 - Active Tab "(current)" Marker (Priority: P1)

**Goal**: Display "(current)" prefix on the browser's active tab in the dropdown, updating reactively when the active tab changes.

**Independent Test**: Open dropdown, verify active tab shows "(current)" prefix, switch tabs in browser, reopen dropdown, verify marker moved.

### Implementation for User Story 2

- [X] T008 [US2] Add `activeTabId` state variable and `activeTabListener` reference in `src/extension/sidepanel/components/common/TabContext.svelte` script section (add `let activeTabId: number = -1;` and listener ref after existing state variables around line 40)
- [X] T009 [US2] Add `handleTabActivated` function in `src/extension/sidepanel/components/common/TabContext.svelte` that sets `activeTabId = activeInfo.tabId` (follow pattern of existing `handleTabUpdate` function)
- [X] T010 [US2] Initialize active tab on mount: in the `onMount` block of `src/extension/sidepanel/components/common/TabContext.svelte`, query `chrome.tabs.query({ active: true, currentWindow: true })` to set initial `activeTabId`, and register `chrome.tabs.onActivated.addListener(handleTabActivated)`
- [X] T011 [US2] Add cleanup in `onDestroy` of `src/extension/sidepanel/components/common/TabContext.svelte`: call `chrome.tabs.onActivated.removeListener(activeTabListener)` alongside existing `onUpdated` cleanup
- [X] T012 [US2] Add "(current)" prefix rendering in dropdown template of `src/extension/sidepanel/components/common/TabContext.svelte`: in the tab item span (inside `{#each availableTabs as tab}`), prepend `{#if tab.id === activeTabId}{$_t("(current)")} {/if}` before `{tab.title || tab.url || 'Untitled'}`
- [X] T013 [US2] Add "(current)" marker unit tests in `tests/unit/TabContext.test.ts`: test that active tab shows "(current)" prefix, non-active tabs don't, "Create New Tab" never shows it, and marker updates when `onActivated` listener fires

**Checkpoint**: User Story 2 complete — active tab shows "(current)" prefix reactively. Both stories work independently.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Verify both features work together and across themes.

- [X] T014 Verify both tooltip and "(current)" prefix work together on the same dropdown item (active tab shows "(current)" in title AND tooltip shows full title without prefix) — manual verification in Chrome extension
- [X] T015 Run existing test suite to confirm no regressions: `npm test` from repository root

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Skipped — no initialization needed
- **Foundational (Phase 2)**: No dependencies — can start immediately
- **User Story 1 (Phase 3)**: Depends on Phase 2 (test mock setup)
- **User Story 2 (Phase 4)**: Depends on Phase 2 (i18n entries + test mock setup)
- **Polish (Phase 5)**: Depends on Phases 3 and 4

### User Story Dependencies

- **User Story 1 (Tooltip)**: Independent — only wraps existing elements with Tooltip
- **User Story 2 ((current) Marker)**: Independent — only adds state tracking and prefix rendering
- Both stories modify `TabContext.svelte` but target different sections (tooltip wrapping vs. prefix rendering), so they can be done sequentially without conflicts

### Within Each User Story

- Foundational tasks (i18n, mocks) before implementation
- Component logic before template changes
- Template changes before tests
- Story complete before moving to next

### Parallel Opportunities

- T001, T002, T003 can run in parallel (different locale files)
- US1 and US2 could be parallelized if working on separate branches, but since they modify the same file, sequential execution (US1 → US2) is recommended

---

## Parallel Example: Foundational Phase

```bash
# Launch all i18n tasks together (different files):
Task: T001 "Add (current) to _locales/en/messages.json"
Task: T002 "Add (current) to _locales/en_GB/messages.json"
Task: T003 "Add (current) to _locales/key_map.json"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational (i18n + test mocks)
2. Complete Phase 3: User Story 1 (tooltip wrapping)
3. **STOP and VALIDATE**: Test tooltips independently in Chrome extension
4. Deploy/demo if ready — users can already see full tab titles on hover

### Incremental Delivery

1. Complete Foundational → i18n and test infrastructure ready
2. Add User Story 1 (Tooltip) → Test independently → Commit (MVP!)
3. Add User Story 2 ((current) marker) → Test independently → Commit
4. Run full test suite → Polish → Final commit

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Both stories modify `TabContext.svelte` — recommend sequential implementation (US1 → US2) to avoid merge conflicts
- Commit after each user story for clean git history
- Total: 15 tasks (4 foundational, 3 US1, 6 US2, 2 polish)
