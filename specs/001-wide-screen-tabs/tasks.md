# Tasks: Wide Screen Mode with Left Tab Panel

**Input**: Design documents from `/specs/001-wide-screen-tabs/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/component-api.md, quickstart.md

**Tests**: Not explicitly requested in feature specification. Test tasks omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- **Project structure**: `src/webfront/` for all Svelte frontend code
- **Stores**: `src/webfront/stores/`
- **Components**: `src/webfront/components/layout/`
- **Pages**: `src/webfront/pages/`
- **Styles**: `src/webfront/styles.css`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the foundational store and shared data types that all user stories depend on.

- [ ] T001 Create layout store with `isWideMode` readable store and `NAV_ITEMS` constant array in `src/webfront/stores/layoutStore.ts`. The store must use `window.matchMedia('(min-width: 769px)')` with a `change` event listener. Export `NavItem` interface with fields: `id: string`, `label: string`, `icon: string` (SVG markup), `route: string`. Define 3 nav items: Chat (`/`), Settings (`/settings`), Scheduler (`/scheduler`). Guard `matchMedia` with `typeof window !== 'undefined'` for SSR/test safety. Follow the pattern in `src/webfront/stores/themeStore.ts`.

- [ ] T002 Create reusable `NavTab` component in `src/webfront/components/layout/NavTab.svelte`. Props: `item: NavItem` (required), `active: boolean` (required), `compact: boolean` (optional, default false). When `compact=false`, render icon + label side by side. When `compact=true`, render icon only. Dispatch `navigate` custom event with `{ route: string }` on click. Subscribe to `uiTheme` store and apply `{currentTheme}` class for theme support. Add base CSS: flex row, align-items center, gap 8px, padding 10px 16px, cursor pointer, border-radius 6px, full width. Active state: distinct highlight color. Compact mode: centered icon, padding 8px.

**Checkpoint**: Shared infrastructure ready — layoutStore and NavTab can be imported by all story components.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the AppShell layout wrapper and integrate it with the Router. This MUST be complete before any user story can be visually tested.

**CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 Create `AppShell` component in `src/webfront/components/layout/AppShell.svelte`. Subscribe to `isWideMode` from `layoutStore` and `uiTheme` from `themeStore`. Render a flex row container (100vh, overflow hidden). In wide mode: render a left-side container (220px fixed width, flex-shrink 0) and a main content `<slot />` (flex: 1, overflow hidden). In narrow mode: render only the `<slot />` at full width. Apply `{currentTheme}` class. The left-side container is a placeholder div for now — LeftPanel is added in Phase 3. Add theme-aware border-right on the left container: terminal = `1px solid #00cc00`, chatgpt = `1px solid var(--chat-border, #e5e5e5)`.

- [ ] T004 Modify `src/webfront/App.svelte` to wrap `<Router {routes} />` with the new `<AppShell>` component. Import `AppShell` from `../components/layout/AppShell.svelte` (adjust relative path). Replace `<Router {routes} />` with `<AppShell><Router {routes} /></AppShell>`. No other changes — auth logic, cookie handling, and route definitions remain untouched.

**Checkpoint**: Foundation ready. The app now has a responsive shell that shows a 220px left placeholder in wide mode and full-width content in narrow mode. User story implementation can begin.

---

## Phase 3: User Story 1 — Navigate Pages via Left Panel in Wide Mode (Priority: P1) MVP

**Goal**: In wide mode (>768px), display a vertical left panel with icon+label tabs for Chat, Settings, and Scheduler. User center (avatar/login) at the panel bottom. Clicking a tab switches pages.

**Independent Test**: Open app in a window wider than 769px. Verify left panel shows 3 labeled tabs and user center at bottom. Click each tab and confirm the correct page loads with the tab highlighted.

### Implementation for User Story 1

- [ ] T005 [US1] Create `LeftPanel` component in `src/webfront/components/layout/LeftPanel.svelte`. Import `NAV_ITEMS` from `layoutStore`, `location` from `svelte-spa-router`, `push` from `svelte-spa-router`, `uiTheme` from `themeStore`, `UserLoginStatus` from `../common/UserLoginStatus.svelte`, and `NavTab` from `./NavTab.svelte`. Render a flex column container (height 100%, width 100%). Top section: iterate `NAV_ITEMS` and render a `NavTab` for each, passing `active={$location === item.route}` (handle catch-all: for Chat item, also match when `$location` starts with `/` and isn't `/settings` or `/scheduler`). On `NavTab` navigate event, call `push(event.detail.route)`. Bottom section: use `flex-grow` spacer then render `<UserLoginStatus />`. Apply `{currentTheme}` class. Add padding: 12px on all sides. Add gap of 4px between tabs.

- [ ] T006 [US1] Integrate `LeftPanel` into `AppShell` in `src/webfront/components/layout/AppShell.svelte`. Replace the placeholder left-side div content with `<LeftPanel />`. Import `LeftPanel` from `./LeftPanel.svelte`. The LeftPanel only renders inside the wide-mode container, so it's automatically hidden in narrow mode.

- [ ] T007 [US1] Modify `src/webfront/components/layout/FooterBar.svelte` to hide `UserLoginStatus` in wide mode. Import `isWideMode` from `../../stores/layoutStore`. Wrap the existing `<UserLoginStatus />` with `{#if !$isWideMode}...{/if}` so it only renders in narrow mode (when UserLoginStatus is shown in the left panel instead). Keep all other FooterBar content unchanged for now.

- [ ] T008 [US1] Handle Settings and Scheduler page layout within AppShell. Currently `Settings.svelte` and `Scheduler.svelte` use `height: 100vh` and centered overlay styling. In `src/webfront/pages/settings/Settings.svelte`, change `.settings-page` height from `100vh` to `100%` so it fills the AppShell content area instead of the full viewport. In `src/webfront/pages/scheduler/Scheduler.svelte`, change `.scheduler-page` height from `100vh` to `100%` for the same reason. This ensures these pages render correctly within the AppShell content area alongside the left panel.

**Checkpoint**: User Story 1 complete. In wide mode, the left panel shows 3 icon+label tabs and user center at bottom. Clicking tabs switches pages and highlights the active tab. Settings and Scheduler pages render within the content area.

---

## Phase 4: User Story 2 — Navigate Pages via Footer Bar in Narrow Mode (Priority: P2)

**Goal**: In narrow mode (<=768px), display navigation icons for Chat, Settings, and Scheduler in the footer bar. Clicking an icon switches pages with the active icon highlighted.

**Independent Test**: Open app in a window narrower than 769px. Verify footer bar shows 3 navigation icons. Click each icon and confirm the correct page loads with the icon highlighted. Verify left panel is NOT visible.

### Implementation for User Story 2

- [ ] T009 [US2] Add navigation icons to `FooterBar` in `src/webfront/components/layout/FooterBar.svelte`. Import `NAV_ITEMS` from `../../stores/layoutStore`, `location` and `push` from `svelte-spa-router`, and `NavTab` from `./NavTab.svelte`. In narrow mode (`{#if !$isWideMode}`), render a nav container with `NavTab` components for each nav item in compact mode (`compact={true}`). Pass `active={$location === item.route}` (with the same catch-all handling as LeftPanel for the Chat route). On `NavTab` navigate event, call `push(event.detail.route)`. Position the navigation icons group between `UserLoginStatus` and `ApprovalModeIndicator`. Style the nav icons container as flex row with gap 4px, centered vertically.

- [ ] T010 [US2] Adjust FooterBar layout for narrow mode in `src/webfront/components/layout/FooterBar.svelte`. In narrow mode, the footer should display: `[UserLoginStatus] [NavIcons: Chat|Settings|Scheduler] [flex-spacer] [ApprovalModeIndicator] [SettingsButton(if logged out)]`. Remove the existing standalone settings button for logged-out users when nav icons are present (since Settings is now accessible via the nav icon). In wide mode, simplify the footer to: `[ApprovalModeIndicator] [flex-spacer]` (UserLoginStatus is in the panel, navigation is in the panel, settings button not needed).

**Checkpoint**: User Story 2 complete. In narrow mode, footer bar shows compact navigation icons. Clicking icons switches pages. In wide mode, footer is minimal (no nav icons, no UserLoginStatus).

---

## Phase 5: User Story 3 — Seamless Transition Between Wide and Narrow Mode (Priority: P3)

**Goal**: Resizing the window across the 769px breakpoint instantly transitions the navigation layout (left panel ↔ footer icons) without losing the current page or triggering a reload.

**Independent Test**: Open app wide (>769px), navigate to Settings via left panel, resize below 769px. Verify: left panel disappears, footer icons appear, Settings icon is highlighted. Resize back above 769px. Verify: left panel returns with Settings tab highlighted.

### Implementation for User Story 3

- [ ] T011 [US3] Verify active route preservation during mode transition. In `src/webfront/stores/layoutStore.ts`, confirm the `isWideMode` store only tracks window width and does NOT trigger any route changes. The `location` store from svelte-spa-router is independent of layout changes, so the active page is automatically preserved. No code changes expected — this task is a verification/validation that the existing implementation from US1+US2 correctly preserves state during transitions.

- [ ] T012 [US3] Handle edge case: exact breakpoint behavior in `src/webfront/stores/layoutStore.ts`. Verify that `matchMedia('(min-width: 769px)')` correctly assigns 768px to narrow mode and 769px to wide mode (as per spec edge case: "exactly at breakpoint → narrow mode"). Test by resizing to exactly 768px and confirming narrow mode is active.

- [ ] T013 [US3] Handle edge case: rapid resize debounce. The `matchMedia` `change` event only fires on threshold crossing (not on every pixel), so rapid resizing naturally produces at most one transition event per crossing. Verify no visual glitching occurs during rapid resize. If needed, add a CSS `will-change: contents` or minimal transition property to `src/webfront/components/layout/AppShell.svelte` to ensure smooth layout reflow. The layout switch must be instant (no animation per spec clarification).

**Checkpoint**: User Story 3 complete. Resizing across the breakpoint transitions navigation instantly and preserves the active page in both directions.

---

## Phase 6: User Story 4 — Theme Consistency Across Both Modes (Priority: P4)

**Goal**: Both the left panel (wide mode) and footer navigation icons (narrow mode) visually match the active theme (terminal or ChatGPT). All navigation elements use theme-appropriate colors, fonts, and styles.

**Independent Test**: Switch to terminal theme in wide mode — verify left panel uses dark bg with green accents. Switch to ChatGPT theme — verify left panel uses light bg with standard accents. Repeat in narrow mode for footer icons.

### Implementation for User Story 4

- [ ] T014 [P] [US4] Add terminal theme styles to `LeftPanel` in `src/webfront/components/layout/LeftPanel.svelte`. Terminal theme (default): background `#000000`, tab text `var(--color-term-dim-green, #00cc00)`, active tab text `var(--color-term-green, #00ff00)` with left border accent `2px solid var(--color-term-green)`, user center area border-top `1px solid rgba(0, 204, 0, 0.3)`. Use monospace font family matching `var(--font-terminal)`.

- [ ] T015 [P] [US4] Add ChatGPT theme styles to `LeftPanel` in `src/webfront/components/layout/LeftPanel.svelte`. ChatGPT theme (`.left-panel.chatgpt`): background `var(--chat-bg, #ffffff)` or `var(--chat-card-bg, #f7f7f8)`, tab text `var(--chat-text-secondary, #6e6e80)`, active tab text `var(--chat-text, #0d0d0d)` with left border accent using `var(--chat-primary, #60a5fa)`, hover background `var(--chat-button-hover, #ececec)`. Use sans-serif font via `var(--font-chat)`. User center area border-top `1px solid var(--chat-border, #e5e5e5)`.

- [ ] T016 [P] [US4] Add terminal and ChatGPT theme styles to `NavTab` in `src/webfront/components/layout/NavTab.svelte`. Terminal default: text color `#00cc00`, active text `#00ff00`, hover bg `rgba(0, 255, 0, 0.1)`, active bg `rgba(0, 255, 0, 0.05)`, font family monospace. ChatGPT (`.nav-tab.chatgpt`): text `var(--chat-text-secondary)`, active text `var(--chat-text)`, hover bg `var(--chat-button-hover, #ececec)`, active bg `rgba(96, 165, 250, 0.1)`, font family sans-serif. Icon color should inherit `currentColor`.

- [ ] T017 [P] [US4] Add theme styles to `AppShell` in `src/webfront/components/layout/AppShell.svelte`. Terminal default: left panel container has border-right `1px solid #00cc00`, background matches `--color-term-bg`. ChatGPT (`.app-shell.chatgpt`): left panel container has border-right `1px solid var(--chat-border, #e5e5e5)`, background `var(--chat-bg, #ffffff)`. Ensure the main content area background is transparent (inherits from TerminalContainer/page).

- [ ] T018 [US4] Verify theme styles for FooterBar navigation icons in `src/webfront/components/layout/FooterBar.svelte`. The `NavTab` components in the footer should automatically pick up their theme styles from T016. Verify that compact NavTab icons in the footer bar visually match the terminal and ChatGPT theme patterns. If the footer's existing theme class context differs from NavTab's expectations, add appropriate CSS overrides in FooterBar's style block.

**Checkpoint**: User Story 4 complete. All navigation elements render correctly in both terminal and ChatGPT themes, in both wide and narrow modes.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Finalization, validation, and cross-cutting improvements.

- [ ] T019 [P] Add i18n support for navigation labels in `src/webfront/stores/layoutStore.ts`. The `NAV_ITEMS` label strings should use i18n keys. If the `_t()` function from `src/webfront/lib/i18n` can be called at store initialization time, use it. Otherwise, store raw keys and have `NavTab.svelte` call `$_t(item.label)` at render time. Ensure "Chat", "Settings", and "Scheduler" labels are translatable.

- [ ] T020 [P] Verify popup/dropdown z-index in wide mode. Open the `UserLoginStatus` dropdown menu from the left panel bottom. Ensure the `PopupCard` popup renders above the left panel and is not clipped by overflow. If clipped, adjust the LeftPanel's `overflow` property or the PopupCard's `z-index`/`position` strategy in `src/webfront/components/layout/LeftPanel.svelte`.

- [ ] T021 [P] Add CSS custom properties for left panel dimensions in `src/webfront/styles.css`. Add `--left-panel-width: 220px` to the `@theme` block so the width is configurable in one place. Update `AppShell.svelte` to use `var(--left-panel-width)` instead of hardcoded `220px`.

- [ ] T022 Run type checking (`npm run type-check`) and fix any TypeScript errors introduced by new files and modifications. Ensure all imports resolve correctly and interfaces match.

- [ ] T023 Run linting (`npm run lint`) and fix any ESLint or formatting issues in new and modified files.

- [ ] T024 Manual validation against `specs/001-wide-screen-tabs/quickstart.md` testing checklist. Walk through each item and confirm it passes.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion (T001, T002) — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 completion — MVP target
- **US2 (Phase 4)**: Depends on Phase 2 completion — can run in parallel with US1
- **US3 (Phase 5)**: Depends on Phase 3 AND Phase 4 (needs both modes implemented to test transitions)
- **US4 (Phase 6)**: Depends on Phase 3 AND Phase 4 (needs both modes to apply themes)
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational (Phase 2). No dependencies on other stories. **This is the MVP.**
- **US2 (P2)**: Can start after Foundational (Phase 2). Can run in parallel with US1.
- **US3 (P3)**: Depends on US1 AND US2 completion (transition requires both modes).
- **US4 (P4)**: Depends on US1 AND US2 completion (theme styling requires both modes to exist).

### Within Each User Story

- Follow task order sequentially (tasks within a phase are ordered by dependency)
- Tasks marked [P] within the same phase can run in parallel

### Parallel Opportunities

- **Phase 1**: T001 and T002 are sequential (T002 depends on NavItem type from T001)
- **Phase 2**: T003 and T004 are sequential (T004 imports AppShell from T003)
- **Phase 3 + Phase 4**: US1 and US2 can be developed in parallel after Phase 2
- **Phase 6**: T014, T015, T016, T017 can all run in parallel (different files)
- **Phase 7**: T019, T020, T021 can all run in parallel (different concerns)

---

## Parallel Example: User Story 1 + User Story 2

```bash
# After Phase 2 (Foundational) is complete, launch US1 and US2 in parallel:

# Developer A (US1 - Wide Mode):
Task: T005 "Create LeftPanel component in src/webfront/components/layout/LeftPanel.svelte"
Task: T006 "Integrate LeftPanel into AppShell"
Task: T007 "Hide UserLoginStatus in FooterBar during wide mode"
Task: T008 "Adjust Settings/Scheduler page height to 100%"

# Developer B (US2 - Narrow Mode):
Task: T009 "Add navigation icons to FooterBar"
Task: T010 "Adjust FooterBar layout for narrow mode"
```

## Parallel Example: User Story 4 (Theme Styling)

```bash
# All theme tasks can run in parallel (different files):
Task: T014 "Terminal theme for LeftPanel"
Task: T015 "ChatGPT theme for LeftPanel"
Task: T016 "Terminal + ChatGPT theme for NavTab"
Task: T017 "Theme styles for AppShell"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T004)
3. Complete Phase 3: User Story 1 (T005–T008)
4. **STOP and VALIDATE**: Open app in wide window, verify left panel works with all 3 tabs
5. This delivers the core wide-screen navigation experience

### Incremental Delivery

1. Phase 1 + Phase 2 → App shell ready with responsive layout structure
2. Phase 3 (US1) → Wide mode navigation works → **MVP Demo**
3. Phase 4 (US2) → Narrow mode navigation works → Full responsive navigation
4. Phase 5 (US3) → Transition validated → Polished resize behavior
5. Phase 6 (US4) → Theme consistency → Visual polish complete
6. Phase 7 → Final validation → Ready for release

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently testable after completion
- No test tasks generated (not requested in spec)
- The 769px breakpoint in `matchMedia` ensures 768px → narrow mode (spec edge case)
- Settings and Scheduler pages need height adjustment (100vh → 100%) for AppShell compatibility
- UserLoginStatus moves between LeftPanel (wide) and FooterBar (narrow) via conditional rendering
- All new components follow the existing `{currentTheme}` class pattern for theming
- SVG icons are inline (no new icon library dependency)
- i18n labels use existing `_t()` / `t()` function pattern
