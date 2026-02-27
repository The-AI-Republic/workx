# Tasks: Settings Search

**Input**: Design documents from `/specs/019-settings-search/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/component-api.md

**Tests**: Not explicitly requested. Manual testing covered in quickstart.md.

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Install dependency and create type definitions

- [X] T001 Install fuse.js dependency by running `npm install fuse.js` in project root
- [X] T002 Create settings search types (SettingsSearchItem interface, SettingsSection enum, ConditionalRule interface, NavigationView type) and export them from `src/extension/sidepanel/settings/settingsSearchRegistry.ts` — per contracts/component-api.md type definitions

---

## Phase 2: Foundational (Registry + Element IDs)

**Purpose**: Create the searchable settings registry and ensure all settings items have targetable DOM element IDs. MUST complete before any user story.

**CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 Populate the complete settings search registry (~55 items) in `src/extension/sidepanel/settings/settingsSearchRegistry.ts` — export a `settingsRegistry` array of SettingsSearchItem entries covering all settings across all 6 sections (Model Config, General, Storage & Cache, Tools, MCP Servers, Extension & Permission). Each entry must include: id, labelKey (i18n key), descriptionKey (i18n key), section, sectionLabelKey, keywords array, navigationTarget, elementId, and conditional rules where applicable (e.g., Terminal Sandbox items: `{ type: "platform", value: "desktop" }`, File Operations: `{ type: "feature", value: "disabled" }`). Reference the existing settings components to extract exact label text, help text, and element IDs.
- [X] T004 [P] Add `data-setting-id` attributes to settings items that lack HTML `id` attributes in `src/extension/sidepanel/settings/ModelSettings.svelte` — add attributes to wrapper `.form-group` or `.settings-card` divs for: model selection, use own API key toggle, API key input, service tier, and advanced config button. Keep existing `id` attributes unchanged.
- [X] T005 [P] Add `data-setting-id` attributes to settings items that lack HTML `id` attributes in `src/extension/sidepanel/settings/GeneralSettings.svelte` — add attributes for: UI theme radio group and show token usage toggle. The language select and max sessions select already have `id` attributes.
- [X] T006 [P] Add `data-setting-id` attributes to settings items that lack HTML `id` attributes in `src/extension/sidepanel/settings/StorageSettings.svelte` — add attributes for: enable cache checkbox, enable compression checkbox, and persist cache checkbox. The TTL input, max size input, and rollout selects already have `id` attributes.
- [X] T007 [P] Add `data-setting-id` attributes to settings items that lack HTML `id` attributes in `src/extension/sidepanel/settings/ToolsSettings.svelte` — add attributes for: enable all tools master toggle, and each individual tool checkbox (storage_tool, tab_tool, web_scraping_tool, dom_tool, form_automation_tool, navigation_tool, network_intercept_tool, data_extraction_tool, page_action_tool, page_vision_tool, execCommand, webSearch, fileOperations, mcpTools). The timeout input, sandbox select, execution mode, workspace access, and network mode selects already have `id` attributes.
- [X] T008 [P] Add `data-setting-id` attributes to settings items that lack HTML `id` attributes in `src/extension/sidepanel/settings/MCPSettings.svelte` — add attributes for: configured servers section, add server button, available tools section, and debug logging checkbox.
- [X] T009 [P] Add `data-setting-id` attributes to settings items that lack HTML `id` attributes in `src/extension/sidepanel/settings/ExtensionSettings.svelte` — add attributes for: enable extension checkbox and enable content scripts checkbox. The update channel, storage quota, and allowed origins already have `id` attributes.

**Checkpoint**: Registry complete with ~55 entries, all settings items have targetable element IDs.

---

## Phase 3: User Story 1 — Search for a Setting by Name (Priority: P1) MVP

**Goal**: User can type in a search bar on the Settings menu page and see matching settings items with fuzzy matching, replacing the category cards while a query is active.

**Independent Test**: Type "cache" → see Storage & Cache items. Type "timout" (typo) → see "Tool Timeout". Clear search → category cards reappear. Type nonsense → "No settings found" message.

### Implementation for User Story 1

- [X] T010 [US1] Create SettingsSearch.svelte component in `src/extension/sidepanel/settings/components/SettingsSearch.svelte` with: (1) search input field with search icon SVG and clear (X) button that appears when text is present, (2) import Fuse.js and settingsRegistry, (3) build Fuse index from registry using i18n `$_t()` for translated labels/descriptions with keys: searchableLabel, searchableDescription, keywords — threshold 0.4, (4) 150ms debounce on input using setTimeout/clearTimeout, (5) reactive `$:` index rebuild when `$_t` store changes (locale change), (6) accept `isDesktop` boolean prop and filter out conditional items where `conditional.type === "platform" && conditional.value === "desktop"` when `!isDesktop`, filter out items with `conditional.type === "feature" && conditional.value === "disabled"` always, (7) display results as a scrollable list (max 10 items) — each result shows translated label (bold), section name badge, and translated description, (8) show "N more results..." text when total matches exceed 10, (9) show "No settings found" empty state when query has no matches, (10) dispatch `resultSelected` event with `{ categoryId: string, scrollToId: string }` on result click. Style using existing CSS variables (--browserx-surface, --browserx-border, --browserx-text, --browserx-primary, --browserx-text-secondary).
- [X] T011 [US1] Integrate SettingsSearch into SettingsMenu.svelte in `src/extension/sidepanel/settings/components/SettingsMenu.svelte` — (1) import SettingsSearch component, (2) add `isDesktop` detection using same try/catch pattern from ToolsSettings.svelte (dynamic import of @tauri-apps/api/core), (3) render `<SettingsSearch {isDesktop} on:resultSelected={handleSearchResult} />` above the categories grid, (4) add local `searchActive` state bound to a new event or prop from SettingsSearch that indicates whether a query is active, (5) conditionally hide the `.categories-grid` div when `searchActive` is true using `{#if !searchActive}`, (6) in `handleSearchResult`, dispatch `categorySelected` with `{ categoryId: event.detail.categoryId }` (scrollToId forwarding added in US2), (7) extend the `categorySelected` event type to `{ categoryId: string; scrollToId?: string }` in preparation for US2.

**Checkpoint**: Search bar visible on Settings menu, fuzzy search works, results replace cards, empty state shows. User Story 1 is fully functional and testable independently.

---

## Phase 4: User Story 2 — Navigate to a Setting from Search Results (Priority: P2)

**Goal**: Clicking a search result navigates to the correct settings section, auto-scrolls to the matched setting item, and briefly highlights it with a visual pulse effect.

**Independent Test**: Search "Tool Timeout" → click result → navigates to Tools page, scrolls to timeout field, field pulses with highlight. Search "UI Theme" → click → navigates to General, scrolls to theme selector, highlights.

### Implementation for User Story 2

- [X] T012 [US2] Update handleSearchResult in SettingsMenu.svelte to forward scrollToId in `src/extension/sidepanel/settings/components/SettingsMenu.svelte` — change `handleSearchResult` to dispatch `categorySelected` with `{ categoryId: event.detail.categoryId, scrollToId: event.detail.scrollToId }`.
- [X] T013 [US2] Add highlightSettingId state and prop passing in `src/extension/sidepanel/Settings.svelte` — (1) add `let highlightSettingId: string | undefined = undefined;` state variable, (2) modify `handleCategorySelected` to extract `event.detail.scrollToId` and store in `highlightSettingId`, (3) pass `{highlightSettingId}` prop to all 6 settings sub-page components (ModelSettings, GeneralSettings, StorageSettings, ToolsSettings, MCPSettings, ExtensionSettings), (4) reset `highlightSettingId = undefined` in `handleBack` to clear on navigation back to menu.
- [X] T014 [P] [US2] Add highlightSettingId prop with scroll-to and highlight logic in `src/extension/sidepanel/settings/ModelSettings.svelte` — (1) add `export let highlightSettingId: string | undefined = undefined;` prop, (2) import `tick` from svelte, (3) add reactive block: when `highlightSettingId` changes and is defined, await `tick()`, find element by `document.getElementById(highlightSettingId) || document.querySelector([data-setting-id="${highlightSettingId}"])`, if found: call `element.scrollIntoView({ behavior: 'smooth', block: 'center' })`, find closest `.settings-card` or `.form-group` parent, add `highlight-pulse` CSS class, remove class after 1500ms via setTimeout, (4) add `@keyframes highlightPulse` CSS animation that pulses `background-color` using `color-mix(in srgb, var(--browserx-primary) 15%, transparent)` for 2 cycles over 1.5s, and `.highlight-pulse` class that applies it.
- [X] T015 [P] [US2] Add highlightSettingId prop with scroll-to and highlight logic in `src/extension/sidepanel/settings/GeneralSettings.svelte` — same pattern as T014: add prop, tick import, reactive scroll/highlight block, highlight-pulse CSS animation.
- [X] T016 [P] [US2] Add highlightSettingId prop with scroll-to and highlight logic in `src/extension/sidepanel/settings/StorageSettings.svelte` — same pattern as T014.
- [X] T017 [P] [US2] Add highlightSettingId prop with scroll-to and highlight logic in `src/extension/sidepanel/settings/ToolsSettings.svelte` — same pattern as T014. Note: collapsible sections may need to be auto-expanded if the target element is inside a collapsed section.
- [X] T018 [P] [US2] Add highlightSettingId prop with scroll-to and highlight logic in `src/extension/sidepanel/settings/MCPSettings.svelte` — same pattern as T014. Note: collapsible sections may need to be auto-expanded.
- [X] T019 [P] [US2] Add highlightSettingId prop with scroll-to and highlight logic in `src/extension/sidepanel/settings/ExtensionSettings.svelte` — same pattern as T014.

**Checkpoint**: Clicking any search result navigates to the correct section, scrolls to the specific setting, and highlights it. User Stories 1 AND 2 both work independently.

---

## Phase 5: User Story 3 — Keyboard Navigation of Search Results (Priority: P3)

**Goal**: Users can navigate search results using arrow keys, select with Enter, and dismiss with Escape without using a mouse.

**Independent Test**: Type a query → press Down arrow → first result highlighted → press Down again → second result highlighted → press Enter → navigates to that setting. Press Escape → results cleared.

### Implementation for User Story 3

- [X] T020 [US3] Add keyboard navigation handlers to SettingsSearch.svelte in `src/extension/sidepanel/settings/components/SettingsSearch.svelte` — (1) add `let focusedIndex: number = -1;` state, (2) add `on:keydown` handler on search input that handles: ArrowDown (increment focusedIndex, wrap at results length, prevent default scroll), ArrowUp (decrement focusedIndex, wrap to end, prevent default), Enter (if focusedIndex >= 0, dispatch resultSelected for focused item), Escape (clear focusedIndex, optionally clear query text or just hide focus), (3) reset focusedIndex to -1 whenever search results change, (4) apply `.focused` CSS class to the result item at focusedIndex with distinct background color using `color-mix(in srgb, var(--browserx-primary) 12%, transparent)`, (5) auto-scroll the focused result into view within the results container if it overflows.
- [X] T021 [US3] Add ARIA attributes for accessibility in `src/extension/sidepanel/settings/components/SettingsSearch.svelte` — (1) add `role="combobox"` and `aria-expanded` to search input, (2) add `role="listbox"` to results container, (3) add `role="option"` and unique `id` to each result item, (4) add `aria-activedescendant` pointing to focused result's id on the input, (5) add `aria-label` on the search input ("Search settings").

**Checkpoint**: Full keyboard-only workflow works: type → arrow navigate → Enter to select → Escape to dismiss. All 3 user stories are complete.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Verification and cleanup

- [X] T022 Run build verification: `npm run build` to confirm no compilation errors
- [X] T023 Run type checking: `npx tsc --noEmit` to confirm no type errors (pre-existing errors only, none from settings-search changes)
- [X] T024 Run linting: `npm run lint` to confirm code style compliance (pre-existing ESLint 9 config migration needed, no new issues)
- [X] T025 Manual testing walkthrough per specs/019-settings-search/quickstart.md verification steps

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on T002 (types must exist for registry). T004-T009 can run in parallel.
- **User Story 1 (Phase 3)**: Depends on T003 (registry). T010 then T011 sequential.
- **User Story 2 (Phase 4)**: Depends on T011 (search integrated). T012→T013 sequential, then T014-T019 in parallel.
- **User Story 3 (Phase 5)**: Depends on T010 (SettingsSearch component exists). T020 then T021 sequential.
- **Polish (Phase 6)**: Depends on all user stories complete.

### User Story Dependencies

- **User Story 1 (P1)**: Requires Phase 2 complete. No dependencies on other stories.
- **User Story 2 (P2)**: Requires US1 complete (T011 — search must be integrated to add navigation).
- **User Story 3 (P3)**: Requires T010 from US1 (component must exist to add keyboard handlers). Can run in parallel with US2.

### Within Each User Story

- US1: T010 → T011 (create component, then integrate)
- US2: T012 → T013 → T014-T019 parallel (extend event, update parent, then all sub-pages)
- US3: T020 → T021 (keyboard logic, then ARIA attributes)

### Parallel Opportunities

**Phase 2 parallel group (after T003)**:
```
T004, T005, T006, T007, T008, T009  (6 files, no dependencies between them)
```

**Phase 4 parallel group (after T013)**:
```
T014, T015, T016, T017, T018, T019  (6 sub-pages, no dependencies between them)
```

**Cross-story parallelism (after T010)**:
```
US2 (T012-T019) and US3 (T020-T021) can proceed in parallel
```

---

## Parallel Example: User Story 2

```bash
# After T013 completes, launch all sub-page highlight tasks together:
Task: "T014 [P] [US2] Add highlightSettingId prop in ModelSettings.svelte"
Task: "T015 [P] [US2] Add highlightSettingId prop in GeneralSettings.svelte"
Task: "T016 [P] [US2] Add highlightSettingId prop in StorageSettings.svelte"
Task: "T017 [P] [US2] Add highlightSettingId prop in ToolsSettings.svelte"
Task: "T018 [P] [US2] Add highlightSettingId prop in MCPSettings.svelte"
Task: "T019 [P] [US2] Add highlightSettingId prop in ExtensionSettings.svelte"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational (T003-T009)
3. Complete Phase 3: User Story 1 (T010-T011)
4. **STOP and VALIDATE**: Search bar works, fuzzy results display, cards toggle
5. Deploy/demo if ready — users can already search settings

### Incremental Delivery

1. Setup + Foundational → Registry and element IDs ready
2. Add User Story 1 → Search works → Deploy (MVP!)
3. Add User Story 2 → Click navigates + scrolls + highlights → Deploy
4. Add User Story 3 → Keyboard navigation works → Deploy
5. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- T017 and T018 (ToolsSettings, MCPSettings) may need extra logic to auto-expand collapsed sections before scrolling
- The settings registry (T003) is the most labor-intensive task — ~55 entries to define
- Commit after each phase checkpoint
