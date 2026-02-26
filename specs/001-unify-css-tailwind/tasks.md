# Tasks: Unify CSS Styling with Tailwind

**Input**: Design documents from `/specs/001-unify-css-tailwind/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md

**Tests**: Not explicitly requested in the spec. Test update tasks are included in the Polish phase to keep existing tests passing after migration.

**Organization**: Tasks are grouped by user story. US1 (CSS migration) is sub-divided into 3 waves by complexity.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (CSS Infrastructure)

**Purpose**: Consolidate CSS config files and define all Tailwind theme tokens that components will reference during migration.

- [x] T001 Extend the `@theme` block in `src/webfront/styles.css` with all BrowserX semantic color tokens (10 light + 10 dark: `--color-bx-primary`, `--color-bx-primary-dark`, etc.) and all ChatGPT theme color tokens (34 light + 34 dark: `--color-chat-bg`, `--color-chat-bg-dark`, etc.) per the mapping in `data-model.md`. Also add `--font-chat` token.
- [x] T002 Merge global styles from `src/webfront/sidepanel.css` into `src/webfront/styles.css`: move body styles, `#app` styles, scrollbar (`::-webkit-scrollbar`) styles, and `body.terminal-mode` override. Remove all `:root` CSS custom property definitions and the `@media (prefers-color-scheme: dark)` block. Remove the legacy `@tailwind base/components/utilities` directives. Delete `src/webfront/sidepanel.css`.
- [x] T003 Update all HTML entry points and Vite config to remove `sidepanel.css` imports — ensure only `src/webfront/styles.css` is imported. Verify the build still works with `npm run build`.
- [x] T004 Delete `tailwind.config.mjs` (redundant with `@theme` block in `styles.css`). Verify Tailwind utility classes still generate correctly by running `npm run build`.
- [x] T005 [P] Migrate `src/desktop/ui/desktop.css` to Tailwind utility classes — convert static CSS properties (font-size, padding, colors) to equivalent Tailwind classes. Keep any desktop-specific layout that can't be expressed as utilities.

**Checkpoint**: All theme tokens defined, single CSS entry point, build passes. Component migration can begin.

---

## Phase 2: User Story 1 — Consistent Utility-Based Styling (Priority: P1) 🎯 MVP

**Goal**: Convert all native CSS in scoped `<style>` blocks to Tailwind utility classes across all Svelte components. Replace `var(--chat-*)` and `var(--browserx-*)` references with named Tailwind tokens. Replace hardcoded hex colors with Tailwind token classes. Apply `dark:` variants for chatgpt theme colors during conversion (natural part of migration). Retain `<style>` blocks only for animations, `:global()`, and pseudo-elements.

**Independent Test**: Inspect any converted component — it should render identically using Tailwind classes in markup instead of scoped CSS. Run `npm test` to verify no regressions.

### Wave 1: Simple Components (no/minimal style blocks)

- [x] T006 [P] [US1] Verify and clean up simple components with no `<style>` blocks — ensure they use Tailwind classes consistently and have no static inline styles: `src/webfront/components/TerminalInput.svelte`, `src/webfront/components/event_display/ReasoningEvent.svelte`, `src/webfront/components/event_display/SystemEvent.svelte`, `src/webfront/components/event_display/OutputEvent.svelte`, `src/webfront/components/event_display/ErrorEvent.svelte`, `src/webfront/components/event_display/ApprovalEvent.svelte`, `src/webfront/components/event_display/ToolCallEvent.svelte`, `src/webfront/components/event_display/PlanEvent.svelte`, `src/webfront/components/common/Portal.svelte`

### Wave 2: Medium Components (6-15 CSS rules, theme-conditional)

- [x] T007 [P] [US1] Migrate terminal core components — convert all scoped CSS to Tailwind utilities. For terminal theme: use `text-term-green`, `bg-term-bg`, `font-terminal` etc. For chatgpt theme: use `text-chat-text dark:text-chat-text-dark`, `bg-chat-bg dark:bg-chat-bg-dark` etc. Files: `src/webfront/components/TerminalMessage.svelte` (8 CSS rules), `src/webfront/components/TerminalContainer.svelte` (6 CSS rules)
- [x] T008 [P] [US1] Migrate command components — convert scoped CSS to Tailwind. Retain `fadeIn` keyframe animation in CommandError. Retain `:global()` selectors in CommandDropdown for dropdown option styling. Files: `src/webfront/components/CommandError.svelte` (12 CSS rules), `src/webfront/components/CommandDropdown.svelte` (11 CSS rules)
- [x] T009 [P] [US1] Migrate common utility components — convert scoped CSS to Tailwind. Retain `:global(.dark)` in Switch if needed for third-party integration. Files: `src/webfront/components/common/Switch.svelte` (11 CSS rules), `src/webfront/components/common/ApprovalModeIndicator.svelte` (14 CSS rules), `src/webfront/components/common/TabContext.svelte`
- [x] T010 [P] [US1] Migrate chat support and event display components — convert scoped CSS to Tailwind with `dark:` variants for chatgpt theme. Files: `src/webfront/components/chat/ChatHistoryPopup.svelte` (8 CSS rules), `src/webfront/components/event_display/TaskEvent.svelte` (8 CSS rules)
- [x] T011 [P] [US1] Migrate layout components — convert scoped CSS to Tailwind with `dark:` variants. Retain `pulse` keyframe in Credits. Files: `src/webfront/components/layout/FooterBar.svelte` (18 CSS rules), `src/webfront/components/layout/footbar/Credits.svelte` (67 CSS rules)

### Wave 3: Complex Components (16+ CSS rules, animations, :global, pseudo-elements)

- [x] T012 [P] [US1] Migrate `src/webfront/components/MessageInput.svelte` (102 CSS rules) — convert all theme-conditional styles (`.message-input-container.chatgpt .terminal-input-shell`, etc.) to conditional Tailwind classes. Replace `var(--color-term-*)` and `var(--chat-*)` with Tailwind tokens. Retain `::placeholder` and `::-webkit-calendar-picker-indicator` pseudo-element styles in `<style>` block.
- [x] T013 [P] [US1] Migrate markdown display components — convert convertible styles to Tailwind. Retain `:global()` selectors for rendered markdown content (h1-h6, p, code, blockquote, a, table, img) and `blink`/`streaming-bg` keyframe animations in `<style>` blocks. Files: `src/webfront/components/MessageDisplay.svelte` (65 CSS rules), `src/webfront/components/event_display/MessageEvent.svelte` (54 CSS rules)
- [x] T014 [P] [US1] Migrate chat list and selection components — convert all scoped CSS to Tailwind with `dark:` variants. Retain `spin` keyframe in ChatHistoryList. Files: `src/webfront/components/chat/ModelSelection.svelte` (87 CSS rules), `src/webfront/components/chat/ChatHistoryList.svelte` (57 CSS rules)
- [x] T015 [P] [US1] Migrate `src/webfront/components/event_display/EventDisplay.svelte` (53 CSS rules) — convert theme-conditional styles to Tailwind. Retain `pulse-subtle` and `slideDown` keyframe animations in `<style>` block.
- [x] T016 [P] [US1] Migrate `src/webfront/components/common/UserLoginStatus.svelte` (62 CSS rules) — convert all `.user-login-status.chatgpt` theme overrides to conditional Tailwind classes with `dark:` variants. Retain `pulse` and `spin` keyframe animations in `<style>` block.
- [x] T017 [P] [US1] Migrate overlay components — convert scoped CSS to Tailwind. Retain `fadeIn` keyframe in PopupCard. Retain `:global()` Tippy.js styles and `::before` arrow pseudo-element styling in Tooltip. Files: `src/webfront/components/common/PopupCard.svelte` (21 CSS rules), `src/webfront/components/common/Tooltip.svelte` (21 CSS rules)
- [x] T018 [P] [US1] Migrate scheduler components — convert all scoped CSS to Tailwind with `dark:` variants for chatgpt theme. Retain keyframe animations (`slideUp`, `slideIn`, `runningPulse`, `badgePulse`, `fadeIn`). Replace all `var(--color-term-*)` with `text-term-*`/`border-term-*` token classes. Files: `src/webfront/components/scheduler/SchedulerPopup.svelte` (317 CSS rules), `src/webfront/components/scheduler/ScheduleTaskModal.svelte` (128 CSS rules), `src/webfront/components/scheduler/SchedulerTaskItem.svelte` (80 CSS rules), `src/webfront/components/scheduler/SchedulerButton.svelte` (31 CSS rules), `src/webfront/components/scheduler/ArchivedTasksView.svelte` (58 CSS rules)
- [x] T019 [P] [US1] Migrate page components — convert scoped CSS to Tailwind. Replace all `var(--color-term-*)` and `var(--chat-*)` references with Tailwind token classes + `dark:` variants. Files: `src/webfront/pages/chat/Main.svelte`, `src/webfront/pages/scheduler/Scheduler.svelte`, `src/webfront/pages/skills/Skills.svelte`
- [x] T020 [P] [US1] Migrate settings components — convert theme preview styling and settings form CSS to Tailwind with `dark:` variants. Files: `src/webfront/settings/GeneralSettings.svelte`, `src/webfront/settings/ToolsSettings.svelte`

**Checkpoint**: All components migrated to Tailwind utilities. Scoped `<style>` blocks only contain animations, `:global()`, and pseudo-element styles. Visual output identical to pre-migration (except font sizes addressed in US3).

---

## Phase 3: User Story 2 — Reliable Light and Dark Theme (Priority: P2)

**Goal**: Verify and fix that all UI elements correctly adapt to OS light/dark preference when the chatgpt theme is active, and that the terminal theme remains completely fixed. Fill any gaps where `dark:` variants were missed during US1 migration.

**Independent Test**: Toggle OS preference between light and dark. In chatgpt theme, all elements should adapt. In terminal theme, nothing should change.

- [x] T021 [US2] Audit all chatgpt-theme components for complete `dark:` variant coverage — search codebase for any remaining `var(--chat-*)`, `var(--browserx-*)`, or hardcoded hex colors that don't have corresponding `dark:` classes. Fix all gaps found. Run across all files in `src/webfront/`.
- [x] T022 [US2] Verify terminal theme isolation — ensure no component using the terminal theme applies `dark:` variants to terminal-specific elements. Terminal colors (`text-term-green`, `bg-term-bg`, etc.) must remain fixed regardless of OS preference. Test by toggling OS dark mode while terminal theme is active. Fix any elements that incorrectly respond to dark mode in terminal theme. Run across all files in `src/webfront/`.
- [x] T023 [US2] Verify WCAG AA contrast compliance — check all text color / background color combinations in both light and dark modes for both themes. Ensure minimum 4.5:1 contrast ratio for normal text (text-sm and above) and 3:1 for large text. Fix any failing combinations by adjusting the color tokens in `src/webfront/styles.css` `@theme` block.

**Checkpoint**: All chatgpt-theme elements respond to light/dark switching. Terminal theme is completely unaffected by OS preference. Contrast meets WCAG AA.

---

## Phase 4: User Story 3 — Minimum Font Size Enforcement (Priority: P3)

**Goal**: Ensure no text in the application is smaller than 14px (0.875rem / `text-sm`). Replace all `text-xs`, `font-size: 10px/11px/12px/0.75rem/0.7rem/0.6rem` with `text-sm`. Adjust layouts to accommodate.

**Independent Test**: Search entire codebase for any font-size declaration below 14px / 0.875rem — none should exist. Visually inspect UI to confirm no text appears too small.

- [x] T024 [US3] Replace all Tailwind `text-xs` classes with `text-sm` across all Svelte components and CSS files. Search pattern: `text-xs` in `src/webfront/`, `src/desktop/`. Verify visual hierarchy is preserved — headings remain larger than body text.
- [x] T025 [US3] Replace all native CSS font-size declarations below 14px — search for `font-size: 10px`, `font-size: 11px`, `font-size: 12px`, `font-size: 0.75rem`, `font-size: 0.7rem`, `font-size: 0.6rem` in any remaining `<style>` blocks or CSS files. Replace with `font-size: 0.875rem` (or convert to `text-sm` class if the property can be moved to markup). Search across `src/webfront/`, `src/desktop/`.
- [x] T026 [US3] Adjust layouts that overflow or clip after font-size increases — visually inspect all components that previously used 10px/11px/12px text (especially `src/webfront/components/scheduler/SchedulerPopup.svelte`, `src/webfront/components/scheduler/SchedulerTaskItem.svelte`, `src/webfront/components/chat/ModelSelection.svelte`, `src/webfront/components/common/Tooltip.svelte`). Increase container padding, width, or height where the larger text causes overflow or misalignment.

**Checkpoint**: Zero instances of text below 14px. All layouts accommodate the larger minimum size. Visual hierarchy preserved.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Update tests to match new class names, final verification, cleanup.

### Test Updates

- [ ] T027 [P] Update terminal component tests to match new Tailwind class names — files: `src/tests/theme-integration.test.ts`, `src/tests/terminal-container.test.ts`, `src/tests/terminal-message.test.ts`, `src/tests/terminal-input.test.ts`
- [ ] T028 [P] Update styles and visual tests to match @theme changes — files: `src/webfront/__tests__/styles.test.ts`, `src/webfront/__tests__/userMessages.visual.test.ts`, `src/webfront/__tests__/inputOutline.visual.test.ts`
- [ ] T029 [P] Update component-level tests to match new selectors — files: `src/webfront/components/__tests__/TerminalMessage.test.ts`, `src/webfront/components/__tests__/TerminalInput.test.ts`, `src/webfront/components/__tests__/MessageInput.test.ts`
- [ ] T030 [P] Update accessibility test to verify contrast ratios still pass with new color tokens — file: `src/tests/accessibility.test.ts`

### Final Verification

- [ ] T031 Run full test suite (`npm test`) and fix any remaining failures
- [ ] T032 Final codebase audit — verify: (1) no `<style>` blocks remain except for animations/`:global()`/pseudo-elements, (2) no `var(--chat-*)` or `var(--browserx-*)` references remain in component files, (3) no font-size below `text-sm` exists, (4) no hardcoded hex colors in chatgpt theme without `dark:` variant
- [ ] T033 Remove any dead CSS — clean up utility classes in `src/webfront/styles.css` that are no longer needed (e.g., `.text-term-green` manual classes if now handled by @theme), remove `src/webfront/settings/utils/highlight-pulse.css` if absorbed into Tailwind

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately. BLOCKS all user stories (theme tokens must exist first).
- **US1 (Phase 2)**: Depends on Setup (Phase 1). T006 (Wave 1) can start first. T007-T011 (Wave 2) can follow. T012-T020 (Wave 3) after Wave 2 patterns are established.
- **US2 (Phase 3)**: Depends on US1 completion (all components must be migrated before auditing gaps).
- **US3 (Phase 4)**: Can start after US1 completion (needs Tailwind classes in place to replace). Can run in parallel with US2.
- **Polish (Phase 5)**: Depends on US1, US2, and US3 completion.

### User Story Dependencies

- **US1 (P1)**: Depends on Setup — no dependency on other stories
- **US2 (P2)**: Depends on US1 — verifies/fixes dark: variants applied during US1
- **US3 (P3)**: Depends on US1 — replaces font sizes in Tailwind classes. Can run parallel with US2.

### Within Each Phase

- All tasks marked [P] within the same wave can run in parallel (different files)
- Wave 2 tasks should complete before Wave 3 to establish migration patterns
- Wave 3 tasks can all run in parallel with each other

### Parallel Opportunities

**Within US1 Wave 2 — 5 tasks in parallel:**
```
T007 (terminal core) || T008 (commands) || T009 (common) || T010 (chat/events) || T011 (layout)
```

**Within US1 Wave 3 — 9 tasks in parallel:**
```
T012 (MessageInput) || T013 (markdown) || T014 (chat list) || T015 (EventDisplay)
|| T016 (UserLogin) || T017 (overlays) || T018 (scheduler) || T019 (pages) || T020 (settings)
```

**US2 and US3 can run in parallel after US1:**
```
T021-T023 (theme audit) || T024-T026 (font sizes)
```

**All test update tasks in parallel:**
```
T027 || T028 || T029 || T030
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001-T005)
2. Complete Phase 2: US1 Wave 1 (T006) — verify simple components
3. Complete Phase 2: US1 Wave 2 (T007-T011) — establish patterns
4. Complete Phase 2: US1 Wave 3 (T012-T020) — bulk migration
5. **STOP and VALIDATE**: All components use Tailwind utilities. Build passes. Visual output identical.

### Incremental Delivery

1. Setup → Foundation ready
2. US1 (Waves 1-3) → All components migrated → Validate (MVP!)
3. US2 → Theme audit → Dark/light verified → Validate
4. US3 → Font sizes normalized → Validate
5. Polish → Tests updated, final audit → Ship

### Parallel Strategy

With multiple agents/developers after Setup completes:
- **Agent A**: US1 Wave 2 + Wave 3 (chat & content components)
- **Agent B**: US1 Wave 3 (scheduler components)
- **Agent C**: US1 Wave 3 (settings & pages)
- After US1 completes: Agent A: US2, Agent B: US3 (parallel)
- After US2+US3: All agents: Polish (test updates in parallel)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Wave 2 establishes the migration pattern — complete before Wave 3 for consistency
- The largest single task is T018 (scheduler components, 614 combined CSS rules) — may need sub-splitting during implementation
- Terminal theme colors use Tailwind tokens directly (`text-term-green`) — no `dark:` variants needed
- ChatGPT theme colors always come in pairs (`text-chat-text dark:text-chat-text-dark`)
- Only retain `<style>` blocks for: keyframe animations, `:global()` selectors, `::before`/`::after` pseudo-elements, `::-webkit-scrollbar`
- Commit after each wave completion to create rollback points
