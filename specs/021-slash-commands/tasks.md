# Tasks: Slash Command System

**Input**: Design documents from `/specs/021-slash-commands/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in specification. Test tasks omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/extension/sidepanel/` (shared UI layer for both extension and desktop builds)
- **Tests**: `tests/` at repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the commands module directory and placeholder files

- [x] T001 Create `src/extension/sidepanel/commands/` directory with empty files: `CommandRegistry.ts`, `builtinCommands.ts`, `index.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement the CommandRegistry singleton that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T002 Implement Command, CommandRegistration, FilteredCommand types and CommandRegistry singleton class (Map-based storage, register, get, getAll, filter, has methods with case-insensitive lowercase normalization) in `src/extension/sidepanel/commands/CommandRegistry.ts` per contract `specs/021-slash-commands/contracts/command-registry.ts`
- [ ] T003 Create public API module that exports the CommandRegistry singleton instance and re-exports types in `src/extension/sidepanel/commands/index.ts`

**Checkpoint**: CommandRegistry is importable and functional — user story implementation can now begin

---

## Phase 3: User Story 1 — Execute a Slash Command (Priority: P1) MVP

**Goal**: Users can type "/" into an empty input field, see available commands in a dropdown, filter by typing, and execute a command via Enter. Built-in commands /new, /help, /settings work end-to-end.

**Independent Test**: Type "/" into empty input → dropdown appears → type "new" → filtered to /new → press Enter → conversation resets

### Implementation for User Story 1

- [ ] T004 [P] [US1] Register built-in commands (/new, /help, /settings) with names, descriptions, argument hints, and action callbacks in `src/extension/sidepanel/commands/builtinCommands.ts`. Actions: /new calls a provided onNewConversation callback, /help calls a provided onCommandOutput callback with formatted command list, /settings calls a provided onOpenSettings callback. Export an `initBuiltinCommands(callbacks)` function.
- [ ] T005 [P] [US1] Create CommandDropdown.svelte in `src/extension/sidepanel/components/CommandDropdown.svelte` — renders a list of filtered Command objects showing /name, description, and argumentHint. Props: `commands` (FilteredCommand[]), `selectedIndex` (number), `visible` (boolean). First item selected by default (selectedIndex=0). Theme-aware styling (subscribe to uiTheme store, terminal green/black vs chatgpt light/dark). z-index 50.
- [ ] T006 [US1] Enhance `src/extension/sidepanel/components/MessageInput.svelte` — add command mode local state (isCommandMode, filterText, showDropdown, selectedIndex, filteredCommands, lastExecuted Map for debounce). Detect "/" as first character in empty field to enter command mode. Parse input on Enter: split on first space to get commandName and args (FR-020). Look up command via registry.get(), execute action with args, clear input. If no space, treat entire text after "/" as command name. Implement 500ms per-command debounce via lastExecuted timestamp check. Close dropdown on blur (FR-014) and when "/" is deleted (FR-015). Do NOT intercept "/" in non-empty fields (FR-019). Import CommandDropdown and render it when showDropdown is true. Filter commands via registry.filter(filterText) on each keystroke after "/". Dispatch new events: `commandOutput` (detail: {title, content}) and `openSettings` (no detail). Wire builtinCommands init with callbacks that use onNewConversation prop and dispatch().
- [ ] T007 [US1] Enhance `src/extension/sidepanel/pages/chat/Main.svelte` — add `on:commandOutput` event handler on the MessageInput component that creates a ProcessedEvent with `id: 'cmd_' + Date.now()`, `category: 'system'`, `title` from event detail, `content` from event detail, `style: STYLE_PRESETS.system` (or appropriate style), `streaming: false`, `collapsible: false`, and appends it to processedEvents array. Add `on:openSettings` event handler that calls the existing `toggleSettings()` function.

**Checkpoint**: User Story 1 is fully functional — "/" detection, dropdown, filtering, command execution, /new resets conversation, /help shows command list in chat, /settings opens settings panel

---

## Phase 4: User Story 2 — Navigate Commands with Keyboard (Priority: P2)

**Goal**: Users can navigate the command dropdown using Up/Down Arrow keys with wrap-around, confirm with Enter, and dismiss with Escape — all without touching the mouse.

**Independent Test**: Type "/" → press Down Arrow → highlight moves to second command → press Up Arrow → highlight moves back → press Escape → dropdown closes, input retains text

### Implementation for User Story 2

- [ ] T008 [US2] Add keyboard navigation support to `src/extension/sidepanel/components/CommandDropdown.svelte` — accept new props: `on:navigate` (dispatches {direction: 'up'|'down'}), `on:select` (dispatches selected command), `on:dismiss` (dispatches void). Add visual highlight styling for the selectedIndex item (distinct background color, theme-aware). Ensure highlighted item scrolls into view if list is longer than visible area.
- [ ] T009 [US2] Enhance keyboard handling in `src/extension/sidepanel/components/MessageInput.svelte` — when isCommandMode is true, intercept ArrowUp (decrement selectedIndex with wrap to last), ArrowDown (increment selectedIndex with wrap to first), Enter (execute command at selectedIndex from filteredCommands), Escape (exit command mode, close dropdown, retain input text and focus). Prevent default behavior for these keys when in command mode so they don't move the textarea cursor.

**Checkpoint**: User Stories 1 AND 2 are independently functional — full keyboard-driven command flow works

---

## Phase 5: User Story 3 — Navigate Commands with Mouse (Priority: P3)

**Goal**: Users can hover over commands to see them highlighted and click to execute, with seamless coordination between mouse and keyboard highlight states.

**Independent Test**: Type "/" → hover over a command → it highlights → click → command executes and dropdown closes

### Implementation for User Story 3

- [ ] T010 [US3] Add mouse interaction to `src/extension/sidepanel/components/CommandDropdown.svelte` — add `on:mouseenter` handler on each command item that dispatches a `hover` event with the item index (parent updates selectedIndex). Add `on:click` handler on each command item that dispatches the `select` event. Ensure hover highlight overrides keyboard highlight and vice versa (both update the same selectedIndex). Update `src/extension/sidepanel/components/MessageInput.svelte` to handle the `hover` event from dropdown by updating selectedIndex.

**Checkpoint**: User Stories 1, 2, AND 3 are all independently functional — keyboard and mouse navigation both work

---

## Phase 6: User Story 4 — See Errors for Invalid Commands (Priority: P3)

**Goal**: Users see a clear inline error message above the input when they submit an unrecognized command, with auto-dismiss after 60 seconds and immediate dismiss on new input.

**Independent Test**: Type "/foobar" + Enter → error message appears above input → wait 60s → error auto-dismisses. Or: type "/foobar" + Enter → error appears → start typing → error dismisses immediately.

### Implementation for User Story 4

- [ ] T011 [P] [US4] Create CommandError.svelte in `src/extension/sidepanel/components/CommandError.svelte` — renders an inline error message above the input field. Props: `message` (string), `visible` (boolean). Absolute positioning above the parent container. z-index 40. Theme-aware styling (red/error tones adapted to terminal and chatgpt themes). Fade-in animation on appear.
- [ ] T012 [US4] Enhance `src/extension/sidepanel/components/MessageInput.svelte` — when command mode submit fails (registry.get() returns undefined for the parsed command name), set errorMessage state to a descriptive string (e.g., "Unknown command: /foobar. Type / to see available commands."). Start a 60-second setTimeout to clear errorMessage (FR-008). On any new input (keydown that produces a character), immediately clear errorMessage and cancel the timeout (FR-009). Import and render CommandError.svelte when errorMessage is non-null. Clean up timeout on component destroy.

**Checkpoint**: User Stories 1–4 all work — invalid commands show helpful error messages

---

## Phase 7: User Story 5 — Add New Commands via Registration (Priority: P3)

**Goal**: Developers can add new slash commands with fewer than 10 lines of registration code, with validation preventing invalid or duplicate registrations.

**Independent Test**: Call `registry.register({name: 'test', description: 'A test command', action: () => {}})` → type "/" → "/test" appears in dropdown → type "/test" + Enter → action executes

### Implementation for User Story 5

- [ ] T013 [US5] Finalize registration validation in `src/extension/sidepanel/commands/CommandRegistry.ts` — ensure register() validates: name is non-empty (throw Error), name contains only alphanumeric characters and hyphens (throw Error with message showing invalid chars), description is non-empty (throw Error), action is a function (throw Error), duplicate name rejected with descriptive Error. Verify that registering a new command requires <10 lines (SC-004). Add a `reset()` method for testing purposes (clears all commands from the Map).

**Checkpoint**: All 5 user stories are complete and independently functional

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, adaptive positioning, and final quality improvements

- [ ] T014 [P] Add adaptive dropdown positioning in `src/extension/sidepanel/components/CommandDropdown.svelte` — calculate available space above and below the input field, render dropdown above if insufficient space below (FR-017). Use `getBoundingClientRect()` on the input container and compare against viewport height.
- [ ] T015 [P] Handle paste edge case in `src/extension/sidepanel/components/MessageInput.svelte` — add a `paste` event handler that detects if the field was empty before paste and the pasted content starts with "/", then enter command mode and trigger filtering with the pasted text after "/".
- [ ] T016 Add "no matching commands" empty state to `src/extension/sidepanel/components/CommandDropdown.svelte` — when filteredCommands is empty and the dropdown is visible, show a subtle "No matching commands" message instead of an empty dropdown. Theme-aware muted text styling.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — delivers MVP
- **US2 (Phase 4)**: Depends on Phase 3 (needs dropdown and command mode from US1)
- **US3 (Phase 5)**: Depends on Phase 3 (needs dropdown from US1). Can run in parallel with US2.
- **US4 (Phase 6)**: Depends on Phase 3 (needs command execution flow from US1). Can run in parallel with US2 and US3.
- **US5 (Phase 7)**: Depends on Phase 2 (needs CommandRegistry). Can run in parallel with US1-US4.
- **Polish (Phase 8)**: Depends on Phases 3–7 being complete

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational only — no other story dependencies
- **US2 (P2)**: Depends on US1 (needs CommandDropdown and command mode state)
- **US3 (P3)**: Depends on US1 (needs CommandDropdown). Independent of US2.
- **US4 (P3)**: Depends on US1 (needs command execution path). Independent of US2/US3.
- **US5 (P3)**: Depends on Foundational only — independent of all other stories

### Within Each User Story

- Models/types before services
- Registry before commands
- Components before integration
- Core implementation before edge cases

### Parallel Opportunities

- **Phase 3 (US1)**: T004 and T005 can run in parallel (different files)
- **Phase 4-7**: US3, US4, and US5 can all run in parallel with each other (different files, independent concerns)
- **Phase 6 (US4)**: T011 can run in parallel with earlier US4 work (separate file)
- **Phase 8**: T014 and T015 can run in parallel (different files)

---

## Parallel Example: User Story 1

```
# After Phase 2 completes, launch in parallel:
Task T004: "Register built-in commands in src/extension/sidepanel/commands/builtinCommands.ts"
Task T005: "Create CommandDropdown.svelte in src/extension/sidepanel/components/CommandDropdown.svelte"

# Then sequentially (both modify MessageInput.svelte):
Task T006: "Enhance MessageInput.svelte with command mode"
Task T007: "Enhance Main.svelte with command event handlers"
```

## Parallel Example: User Stories 3, 4, 5 (after US1 complete)

```
# These can all run in parallel since they touch different files:
Task T010: "Add mouse interaction to CommandDropdown.svelte" (US3)
Task T011: "Create CommandError.svelte" (US4)
Task T013: "Finalize registration validation in CommandRegistry.ts" (US5)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002–T003)
3. Complete Phase 3: User Story 1 (T004–T007)
4. **STOP and VALIDATE**: Type "/" → see dropdown → type "new" → press Enter → conversation resets
5. Deploy/demo if ready — core value delivered

### Incremental Delivery

1. Setup + Foundational → Registry ready
2. Add US1 → Test independently → Deploy/Demo (MVP!)
3. Add US2 → Keyboard navigation works → Deploy/Demo
4. Add US3 + US4 + US5 in parallel → Mouse nav, errors, extensibility → Deploy/Demo
5. Polish → Adaptive positioning, paste handling, empty state → Final release

### Single Developer Strategy

1. T001 → T002 → T003 (Setup + Foundation)
2. T004 + T005 in parallel → T006 → T007 (US1 complete — MVP)
3. T008 → T009 (US2 complete)
4. T010 (US3), T011 → T012 (US4), T013 (US5) — interleave as needed
5. T014 + T015 in parallel → T016 (Polish)

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable after its phase
- Commands module is pure TypeScript (no Svelte dependency) for easy testing
- All new components follow existing theme-aware patterns (terminal + chatgpt)
- No new npm dependencies required
- Commit after each phase completion for clean git history
