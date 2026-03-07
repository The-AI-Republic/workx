# Tasks: Svelte 5 Migration

**Input**: Design documents from `/specs/039-svelte5-migration/`
**Prerequisites**: plan.md, spec.md

**Tests**: No new test tasks - existing tests must pass after each migration step.

**Organization**: Tasks are organized by migration tier (bottom-up: leaf components first, page components last). Each task fully migrates a component across all applicable patterns (props, reactivity, events, slots, store subscriptions). User story labels indicate the PRIMARY pattern being addressed.

**Migration patterns per task**: `export let` -> `$props()`, `$:` -> `$derived()`/`$effect()`, `createEventDispatcher` -> callback props, `on:event` -> `onevent`, `<slot>` -> `{@render}`, `.subscribe()` -> `$store` auto-subscription, `afterUpdate` -> `$effect()`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1=Props, US2=Reactivity, US3=Events, US4=Slots, US5=StoreSubscriptions, US6=Lifecycle
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Establish baseline before migration begins

- [X] T001 Run `npm test` and `npm run type-check` to verify all tests and type-checks pass before starting migration
- [X] T002 Run `npm run build` to verify build succeeds as a pre-migration baseline

**Checkpoint**: Baseline established - all tests, types, and build pass

---

## Phase 3: Tier 1 - Simple Leaf Components (Priority: P1) MVP

**Goal**: Migrate the simplest leaf components that have no children and no event dispatchers. These only need `export let` -> `$props()`, `$:` -> `$derived()`/`$effect()`, `.subscribe()` -> `$store`, and `on:event` -> `onevent` for native HTML elements.

**Independent Test**: Run `npm test` and `npm run type-check` after this phase. All components render identically.

### Implementation

- [X] T003 [P] [US1] Migrate test mock components: replace `export let` with `$props()` and `on:event` with `onevent` in src/__test-utils__/mocks/MockAgentStatus.svelte, src/__test-utils__/mocks/MockSettingsPanel.svelte, src/__test-utils__/mocks/MockTaskDisplay.svelte, and src/tests/TestApp.svelte
- [X] T004 [P] [US1] Migrate src/welcome/Welcome.svelte: replace `export let` with `$props()` and `on:event` with `onevent`
- [X] T005 [P] [US1] Migrate simple event display components: replace `export let` with `$props()` in src/webfront/components/event_display/SystemEvent.svelte and src/webfront/components/event_display/ErrorEvent.svelte
- [X] T006 [P] [US2] Migrate reactive event display components: replace `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, and `.subscribe()` with `$uiTheme` in src/webfront/components/event_display/MessageEvent.svelte, src/webfront/components/event_display/ReasoningEvent.svelte, src/webfront/components/event_display/OutputEvent.svelte, and src/webfront/components/event_display/PlanEvent.svelte
- [X] T007 [P] [US1] Migrate terminal components: replace `export let` with `$props()` and `on:event` with `onevent` in src/webfront/components/TerminalInput.svelte and src/webfront/components/CommandError.svelte
- [X] T008 [P] [US5] Migrate src/webfront/components/TerminalMessage.svelte: replace `export let` with `$props()` and `.subscribe()` with `$uiTheme`
- [X] T009 [P] [US5] Migrate src/webfront/components/layout/footbar/Credits.svelte: replace `.subscribe()` with `$uiTheme` and `on:event` with `onevent`
- [X] T010 [P] [US1] Migrate src/webfront/settings/components/ModelInfoTooltip.svelte: replace `export let` with `$props()`
- [X] T011 [P] [US5] Migrate src/webfront/components/common/ApprovalModeIndicator.svelte: replace `export let` with `$props()`, `.subscribe()` with `$uiTheme`, and `on:event` with `onevent`
- [X] T012 [P] [US5] Migrate src/webfront/components/common/UserLoginStatus.svelte: replace `export let` with `$props()`, `.subscribe()` with `$uiTheme`, and `on:event` with `onevent`
- [X] T013 [P] [US2] Migrate src/webfront/components/event_display/ToolCallEvent.svelte: replace `export let` with `$props()`, `$:` with `$derived()`, and `on:click` with `onclick`

**Checkpoint**: All simple leaf components migrated. Run `npm test` to verify.

---

## Phase 4: Tier 2 - Interactive Components with Event Dispatchers (Priority: P2)

**Goal**: Migrate components that use `createEventDispatcher`. Each task replaces the dispatcher with callback props in the child AND updates parent call sites to pass callbacks instead of `on:event`.

**Independent Test**: Each component's callback props invoke correctly. Run `npm test` after each task.

### Implementation

- [X] T014 [P] [US3] Migrate src/webfront/components/common/Switch.svelte: replace `createEventDispatcher` with `onChange` callback prop, `export let` with `$props()`, `on:click`/`on:keydown` with `onclick`/`onkeydown`. Update all parent usages of `<Switch on:change=...>` to `<Switch onChange=...>` across settings panel files
- [X] T015 [P] [US3] Migrate src/webfront/settings/components/ModelOption.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `on:click` with `onclick`. Update parent src/webfront/settings/components/ModelSelector.svelte usage
- [X] T016 [P] [US3] Migrate src/webfront/components/layout/NavTab.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`, `on:click` with `onclick`. Update parent src/webfront/components/layout/LeftPanel.svelte usage
- [X] T017 [P] [US3] Migrate src/webfront/components/event_display/TaskEvent.svelte and src/webfront/components/event_display/ApprovalEvent.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `on:click` with `onclick`. Update parent src/webfront/components/event_display/EventDisplay.svelte if it listens to dispatched events
- [X] T018 [P] [US3] Migrate src/webfront/components/scheduler/SchedulerJobItem.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `on:click` with `onclick`. Update parent usages in src/webfront/components/scheduler/SchedulerPopup.svelte and src/webfront/components/scheduler/ArchivedJobsView.svelte
- [X] T019 [P] [US3] Migrate src/webfront/components/scheduler/SchedulerButton.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `on:click` with `onclick`. Update parent src/webfront/components/layout/FooterBar.svelte usage
- [X] T020 [P] [US3] Migrate src/extension/content/ui_effect/ControlButtons.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `on:click` with `onclick`. Update parent src/extension/content/ui_effect/VisualEffectController.svelte usage
- [X] T021 [P] [US3] Migrate src/webfront/components/vault/PinSetupDialog.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:click`/`on:input` with `onclick`/`oninput`. Update parent src/webfront/settings/SecuritySettings.svelte usage
- [X] T022 [P] [US3] Migrate src/webfront/components/vault/PinUnlockOverlay.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:click`/`on:keydown` with `onclick`/`onkeydown`. Update parent src/webfront/App.svelte usage of `<PinUnlockOverlay on:unlocked=...>`
- [X] T023 [P] [US3] Migrate src/webfront/components/chat/ModelSelection.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`, `on:click`/`on:change` with `onclick`/`onchange`. Update parent src/webfront/components/MessageInput.svelte usage
- [X] T024 [P] [US3] Migrate src/webfront/settings/components/SettingsSearch.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:input` with `oninput`. Update parent src/webfront/pages/settings/Settings.svelte usage
- [X] T025 [P] [US3] Migrate src/webfront/settings/components/SettingsMenu.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `on:click` with `onclick`. Update parent src/webfront/pages/settings/Settings.svelte usage
- [X] T026 [P] [US3] Migrate src/webfront/settings/components/UnsavedChangesDialog.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `on:click` with `onclick`. Update parent src/webfront/pages/settings/Settings.svelte usage
- [X] T027 [P] [US3] Migrate src/webfront/components/chat/ChatHistoryList.svelte: replace `export let` with `$props()`, `$:` with `$derived()`, `.subscribe()` with `$uiTheme`, `on:click` with `onclick`. Update parent src/webfront/components/chat/ChatHistoryPopup.svelte usage
- [X] T028 [US3] Migrate src/webfront/settings/components/ModelSelector.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:click`/`on:change` with `onclick`/`onchange`. Update parent usages in src/webfront/settings/ModelSettings.svelte and src/webfront/settings/AdvancedModelConfig.svelte
- [X] T029 [US6] Migrate src/webfront/components/CommandDropdown.svelte: replace `createEventDispatcher` with callback props, `afterUpdate` with `$effect()`, `export let` with `$props()`, `$:` with `$derived()`, `on:click` with `onclick`. Update parent src/webfront/components/MessageInput.svelte usage
- [X] T030 [US3] Migrate src/webfront/components/MessageInput.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:input`/`on:keydown` with `oninput`/`onkeydown`. Update parent src/webfront/pages/chat/Main.svelte usage

**Checkpoint**: All event dispatchers replaced with callback props. Zero `createEventDispatcher` imports remain. Run `npm test`.

---

## Phase 5: Tier 3 - Slot/Wrapper Components (Priority: P2)

**Goal**: Migrate `<slot>` to `{@render}` snippet syntax. Each component adds `Snippet` type import and `children`/named snippet props.

**Independent Test**: Content projection still works for all wrapper components. Run `npm test`.

### Implementation

- [X] T031 [P] [US4] Migrate src/webfront/components/TerminalContainer.svelte: replace `export let` with `$props()`, `<slot />` with `{@render children?.()}`, add `children: Snippet` to props
- [X] T032 [P] [US4] Migrate src/webfront/components/common/Portal.svelte: replace `export let` with `$props()`, `<slot />` with `{@render children?.()}`, add `children: Snippet` to props
- [X] T033 [P] [US4] Migrate src/webfront/components/common/Tooltip.svelte: replace `export let` with `$props()`, `<slot />` with `{@render children?.()}`, `$:` reactive updates with `$effect()`, `.subscribe()` with `$uiTheme`, add `children: Snippet` to props
- [X] T034 [US4] Migrate src/webfront/components/layout/AppShell.svelte: replace `<slot />` with `{@render children?.()}`, `.subscribe()` with `$uiTheme`, add `children: Snippet` to props
- [X] T035 [US4] Migrate src/webfront/components/common/PopupCard.svelte: replace `export let` with `$props()`, named `<slot name="trigger" />` and `<slot name="content" />` with `{@render trigger?.()}` and `{@render content?.()}` snippet props, `$:` with `$effect()`, `.subscribe()` with `$uiTheme`, `on:click|stopPropagation` with `onclick` wrapper, `<svelte:window on:click>` with `<svelte:window onclick>`. Update all parent usages to use snippet syntax

**Checkpoint**: Zero `<slot` tags remain. Run `npm test`.

---

## Phase 6: Tier 4 - Settings Panels (Priority: P2)

**Goal**: Fully migrate all settings panel components. Each panel uses `createEventDispatcher` for back/saved events, `export let`, `$:`, `.subscribe()`, and `on:event`. Migrate all patterns in each file.

**Independent Test**: Settings panels render correctly, back/save callbacks fire. Run `npm test`.

### Implementation

- [X] T036 [P] [US3] Migrate src/webfront/settings/GeneralSettings.svelte: replace `createEventDispatcher` with `onBack`/`onSaved` callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`/`$effect()`, `on:change`/`on:click` with `onchange`/`onclick`
- [X] T037 [P] [US3] Migrate src/webfront/settings/ModelSettings.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:click`/`on:change` with `onclick`/`onchange`
- [X] T038 [P] [US3] Migrate src/webfront/settings/AdvancedModelConfig.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:click`/`on:change` with `onclick`/`onchange`
- [X] T039 [P] [US3] Migrate src/webfront/settings/StorageSettings.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:click` with `onclick`
- [X] T040 [P] [US3] Migrate src/webfront/settings/ToolsSettings.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`/`$effect()`, `on:click` with `onclick`
- [X] T041 [P] [US3] Migrate src/webfront/settings/ExtensionSettings.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:change`/`on:click` with `onchange`/`onclick`
- [X] T042 [P] [US3] Migrate src/webfront/settings/MCPSettings.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`/`$effect()`, `on:click` with `onclick`
- [X] T043 [P] [US3] Migrate src/webfront/settings/A2ASettings.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:click` with `onclick`
- [X] T044 [P] [US3] Migrate src/webfront/settings/ApprovalSettings.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`/`$effect()`, `on:click` with `onclick`
- [X] T045 [P] [US3] Migrate src/webfront/settings/SecuritySettings.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `on:click` with `onclick`

**Checkpoint**: All settings panels migrated. Run `npm test`.

---

## Phase 7: Tier 5 - Container/Parent Components (Priority: P1)

**Goal**: Migrate container components that compose children. All children are now migrated, so parent updates focus on own props/reactivity/stores and updating child event handler call sites to use new callback prop APIs.

**Independent Test**: Parent-child composition works correctly. Events flow via callback props. Run `npm test`.

### Implementation

- [X] T046 [P] [US1] Migrate src/webfront/components/common/TabContext.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`, `<slot>` with `{@render children?.()}`. Update parent usages
- [X] T047 [P] [US1] Migrate src/webfront/components/event_display/EventDisplay.svelte: replace `export let` with `$props()`, `$:` with `$derived()`, `.subscribe()` with `$uiTheme`, `on:click`/`on:keydown` with `onclick`/`onkeydown`, update child component callback prop call sites
- [X] T048 [P] [US1] Migrate src/webfront/components/chat/ChatHistoryPopup.svelte: replace `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`, update child callback prop call sites
- [X] T049 [P] [US1] Migrate src/webfront/components/layout/FooterBar.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `on:click` with `onclick`. Update parent AppShell usage
- [X] T050 [P] [US1] Migrate src/webfront/components/layout/LeftPanel.svelte: replace `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`, `<slot>` with `{@render children?.()}`, update child callback prop call sites
- [X] T051 [P] [US1] Migrate src/webfront/components/MessageDisplay.svelte: replace `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`
- [X] T052 [US1] Migrate src/webfront/components/scheduler/ScheduleJobModal.svelte: replace `createEventDispatcher` with callback props, `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`/`$effect()`, `on:click`/`on:change`/`on:input` with `onclick`/`onchange`/`oninput`. Update parent usage
- [X] T053 [US1] Migrate src/webfront/components/scheduler/SchedulerPopup.svelte: replace `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`/`$effect()`, `on:click`/`on:mousedown` with `onclick`/`onmousedown`, update child callback prop call sites
- [X] T054 [US1] Migrate src/webfront/components/scheduler/ArchivedJobsView.svelte: replace `export let` with `$props()`, `.subscribe()` with `$uiTheme`, `$:` with `$derived()`, `on:click` with `onclick`, update child callback prop call sites

**Checkpoint**: All container components migrated. Run `npm test`.

---

## Phase 8: Tier 6 - Page Components & Extension Components (Priority: P1)

**Goal**: Migrate top-level page components and extension overlay components. These are the final tier - all their children are already migrated. Focus on updating child callback prop call sites, own store subscriptions, and `on:event` -> `onevent`.

**Independent Test**: Full application renders and functions correctly. Run `npm test` and `npm run type-check`.

### Implementation

- [X] T055 [P] [US1] Migrate src/webfront/pages/settings/Settings.svelte: replace `.subscribe()` with `$uiTheme`, update ALL child settings panel usages from `on:back`/`on:saved` to `onBack`/`onSaved` callback props, update SettingsSearch/SettingsMenu/UnsavedChangesDialog callback prop call sites
- [X] T056 [P] [US1] Migrate src/webfront/pages/skills/Skills.svelte: replace `.subscribe()` with `$uiTheme`, `on:click` with `onclick`
- [X] T057 [P] [US5] Migrate src/webfront/pages/scheduler/Scheduler.svelte: replace `$:` with `$derived()`, `.subscribe()` with `$store` auto-subscriptions, `on:click` with `onclick`, update child callback prop call sites
- [X] T058 [US1] Migrate src/webfront/pages/chat/Main.svelte: replace `$:` with `$derived()`, `.subscribe()` with `$uiTheme`, update child callback prop call sites for MessageInput and other children
- [X] T059 [US1] Migrate src/webfront/App.svelte: replace `<PinUnlockOverlay on:unlocked=...>` with callback prop syntax, ensure `$vaultStore` auto-subscription works correctly
- [X] T060 [P] [US5] Migrate src/extension/content/ui_effect/VisualEffectController.svelte: replace `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `.subscribe()` calls with `$store` or managed subscriptions in `onMount`/`onDestroy`, update child callback prop call sites
- [X] T061 [P] [US5] Migrate src/extension/content/ui_effect/Overlay.svelte: replace `export let` with `$props()`, `<slot>` with `{@render children?.()}`, `.subscribe()` with `$store` auto-subscription
- [X] T062 [P] [US5] Migrate src/extension/content/ui_effect/CursorAnimator.svelte: replace `export let` with `$props()`, `$:` with `$derived()`/`$effect()`, `.subscribe()` calls with `$store` or managed subscriptions

**Checkpoint**: All components migrated. Run `npm test` and `npm run type-check`.

---

## Phase 9: Polish & Validation

**Purpose**: Final verification that all Svelte 4 patterns are eliminated and the app works correctly.

- [X] T063 Run `grep -r "export let" src/**/*.svelte`, `grep -r "createEventDispatcher" src/**/*.svelte`, `grep -r "\$:" src/**/*.svelte`, `grep -r "on:" src/**/*.svelte`, `grep -r "<slot" src/**/*.svelte`, `grep -r "afterUpdate\|beforeUpdate" src/**/*.svelte` to verify zero remaining Svelte 4 patterns. Fix any missed occurrences
- [X] T064 Run full test suite (`npm test`) and fix any remaining failures
- [X] T065 Run `npm run type-check` and `npm run build` to verify TypeScript and build still succeed
- [X] T066 Run `npm run lint` and fix any linting issues introduced by migration

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - must complete first to establish baseline
- **Tier 1 Leaf Components (Phase 3)**: Depends on Phase 1. All tasks are [P] - fully parallel
- **Tier 2 Interactive Components (Phase 4)**: Depends on Phase 3 (leaf children migrated first). Most tasks [P] except T029/T030 which depend on earlier Phase 4 tasks updating shared parent files
- **Tier 3 Slot Components (Phase 5)**: Depends on Phase 3. Can run in parallel with Phase 4
- **Tier 4 Settings Panels (Phase 6)**: Depends on Phase 4 (Switch.svelte and other shared children migrated). All tasks [P]
- **Tier 5 Container Components (Phase 7)**: Depends on Phases 4, 5, 6 (all children migrated)
- **Tier 6 Pages & Extension (Phase 8)**: Depends on Phase 7 (all children migrated)
- **Polish (Phase 9)**: Depends on Phase 8

### User Story Coverage

- **US1 (Props)**: Addressed in every task - all components have `export let`
- **US2 (Reactivity)**: Addressed in T006, T013, and all tasks for components with `$:` declarations
- **US3 (Events)**: Addressed primarily in Phase 4 (T014-T030) and Phase 6 (T036-T045)
- **US4 (Slots)**: Addressed in Phase 5 (T031-T035) plus T046 (TabContext), T050 (LeftPanel), T061 (Overlay)
- **US5 (Store Subscriptions)**: Addressed across all phases wherever `.subscribe()` appears
- **US6 (Lifecycle)**: Addressed in T029 (CommandDropdown - `afterUpdate`)

### Parallel Opportunities

**Phase 3** - All 11 tasks (T003-T013) can run in parallel
**Phase 4** - T014-T028 can run in parallel (different files); T029-T030 are sequential (shared MessageInput.svelte)
**Phase 5** - T031-T033 parallel; T034-T035 sequential (AppShell is root wrapper)
**Phase 6** - All 10 tasks (T036-T045) can run in parallel
**Phase 7** - T046-T051 parallel; T052-T054 sequential (scheduler component hierarchy)
**Phase 8** - T055-T057, T060-T062 parallel; T058-T059 sequential (Main/App are top-level)

---

## Parallel Example: Phase 3 (Leaf Components)

```bash
# All leaf component tasks can launch together:
Task T003: "Migrate mock components in src/__test-utils__/mocks/*.svelte"
Task T004: "Migrate src/welcome/Welcome.svelte"
Task T005: "Migrate SystemEvent.svelte and ErrorEvent.svelte"
Task T006: "Migrate MessageEvent, ReasoningEvent, OutputEvent, PlanEvent"
Task T007: "Migrate TerminalInput.svelte and CommandError.svelte"
Task T008: "Migrate TerminalMessage.svelte"
Task T009: "Migrate Credits.svelte"
Task T010: "Migrate ModelInfoTooltip.svelte"
Task T011: "Migrate ApprovalModeIndicator.svelte"
Task T012: "Migrate UserLoginStatus.svelte"
Task T013: "Migrate ToolCallEvent.svelte"
```

---

## Implementation Strategy

### MVP First (Phase 3 Only)

1. Complete Phase 1: Setup (baseline verification)
2. Complete Phase 3: Tier 1 leaf components (simplest, lowest risk)
3. **STOP and VALIDATE**: Run `npm test` - all tests pass with migrated leaf components
4. This proves the migration approach works before tackling complex components

### Incremental Delivery

1. Phase 1 (Setup) -> Baseline established
2. Phase 3 (Leaf Components) -> ~18 components migrated, approach validated
3. Phase 4 (Event Dispatchers) -> ~17 components migrated, all dispatchers eliminated
4. Phase 5 (Slots) -> ~6 slot components migrated
5. Phase 6 (Settings) -> ~10 settings panels migrated
6. Phase 7 (Containers) -> ~9 container components migrated
7. Phase 8 (Pages) -> ~8 page/extension components migrated
8. Phase 9 (Polish) -> Final validation, zero Svelte 4 patterns remain

Each phase leaves the codebase in a working state - tests pass after every phase.

---

## Notes

- [P] tasks = different files, no shared dependencies
- Each task fully migrates a component across ALL applicable Svelte 5 patterns
- When migrating `createEventDispatcher`, update BOTH the child component AND all parent call sites in the same task
- `.subscribe()` -> `$store` is safe for webfront components; for extension content scripts, evaluate if `$store` auto-subscription works correctly given the component lifecycle
- `svelte-spa-router` (Router.svelte in node_modules) is NOT migrated - it's a third-party dependency
- Stores in `src/webfront/stores/` use `writable`/`derived` from `svelte/store` which are fully supported in Svelte 5 - no store file changes needed
- `on:click|stopPropagation={handler}` becomes `onclick={(e) => { e.stopPropagation(); handler(e); }}`
- Commit after each phase or logical group of tasks
