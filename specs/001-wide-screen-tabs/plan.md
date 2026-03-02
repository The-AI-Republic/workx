# Implementation Plan: Wide Screen Mode with Left Tab Panel

**Branch**: `001-wide-screen-tabs` | **Date**: 2026-02-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-wide-screen-tabs/spec.md`

## Summary

Add responsive layout navigation to the Browserx application. When the window width exceeds 768px (wide mode), display a fixed vertical left panel with icon+label tabs for Chat, Settings, and Scheduler pages, with the user center relocated to the panel bottom. Below 768px (narrow mode), display page navigation icons in the existing footer bar. The transition between modes is instant (no animation) and preserves the active page. Both modes must support terminal and ChatGPT themes.

## Technical Context

**Language/Version**: TypeScript 5.9.2 + Svelte 4.2.20
**Primary Dependencies**: svelte-spa-router 4.0.1, Tailwind CSS 4.1.13, PostCSS
**Storage**: N/A (no data persistence changes — layout-only feature)
**Testing**: Vitest 3.2.4, @testing-library/svelte 5.2.8
**Target Platform**: Chrome Extension (side panel) + Tauri Desktop (macOS/Windows/Linux)
**Project Type**: Web application (single Svelte SPA)
**Performance Goals**: Layout mode switch within 200ms, 60fps during resize
**Constraints**: Must work within Chrome extension side panel (~400px default width) and Tauri desktop windows (variable width). No new runtime dependencies.
**Scale/Scope**: 3 pages (Chat, Settings, Scheduler), 2 themes (terminal, chatgpt), 2 platforms (extension, desktop)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution file contains only template placeholders (no project-specific principles defined). No gates to evaluate. Proceeding to Phase 0.

**Post-Phase 1 re-check**: No violations. Design uses existing patterns (Svelte stores, CSS theming, component composition) and introduces no new dependencies or abstractions beyond what's necessary.

## Project Structure

### Documentation (this feature)

```text
specs/001-wide-screen-tabs/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── component-api.md # Component interface contracts
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/webfront/
├── App.svelte                              # MODIFY: Wrap Router with responsive layout shell
├── stores/
│   └── layoutStore.ts                      # NEW: Reactive store for wide/narrow mode state
├── components/
│   └── layout/
│       ├── AppShell.svelte                 # NEW: Top-level responsive layout (left panel + main content)
│       ├── LeftPanel.svelte                # NEW: Wide-mode vertical sidebar with tabs + user center
│       ├── FooterBar.svelte                # MODIFY: Add narrow-mode navigation icons
│       └── NavTab.svelte                   # NEW: Reusable tab/icon component (shared by panel & footer)
├── pages/
│   ├── chat/Main.svelte                    # MODIFY: Remove FooterBar (moved to AppShell)
│   ├── settings/Settings.svelte            # NO CHANGE (standalone full-page route)
│   └── scheduler/Scheduler.svelte          # NO CHANGE (standalone full-page route)
└── styles.css                              # MODIFY: Add CSS custom properties for left panel

tests/
└── unit/
    └── webfront/
        └── stores/
            └── layoutStore.test.ts         # NEW: Tests for layout mode detection
```

**Structure Decision**: Single Svelte SPA — all changes are within `src/webfront/`. The feature introduces a new layout shell component (`AppShell.svelte`) that wraps the existing router, a new `LeftPanel.svelte` component, a shared `NavTab.svelte`, and a `layoutStore.ts` for reactive window-width detection. The existing `FooterBar.svelte` is modified to include navigation icons in narrow mode.

## Design Decisions

### D1: Layout Architecture — AppShell wrapping Router

**Decision**: Introduce an `AppShell.svelte` component that wraps the svelte-spa-router `<Router>`. The AppShell handles the responsive layout: in wide mode it renders `LeftPanel + <slot>` side by side; in narrow mode it renders `<slot>` with the enhanced `FooterBar` at the bottom.

**Rationale**: The current `App.svelte` contains auth logic and cookie management. Inserting layout logic there would violate separation of concerns. A dedicated shell component keeps auth and layout decoupled, and the router continues to manage page rendering independently.

**Alternative rejected**: Putting layout logic in each page component. This would duplicate the left panel in Chat/Settings/Scheduler and create inconsistency.

### D2: Mode Detection — CSS media query + Svelte store

**Decision**: Use a Svelte writable store (`layoutStore.ts`) that listens to `window.matchMedia('(min-width: 768px)')` and exposes a reactive `isWideMode` boolean. Components subscribe to this store to conditionally render wide/narrow layouts.

**Rationale**: `matchMedia` is the standard web API for responsive detection, it fires a single event on threshold crossing (no continuous resize listener needed), and it aligns with CSS `@media` queries for consistency. A Svelte store makes the value reactive across all subscribed components.

**Alternative rejected**: Pure CSS `@media` queries for showing/hiding. While simpler, this wouldn't allow moving the `UserLoginStatus` component between different DOM locations (panel bottom vs footer). The JavaScript store is needed for conditional rendering.

### D3: Navigation Data — Centralized route definition

**Decision**: Define a shared `NAV_ITEMS` array (in `layoutStore.ts` or a shared constants file) containing `{ label, icon, route, id }` for each page. Both `LeftPanel` and `FooterBar` iterate over this array to render tabs/icons.

**Rationale**: Single source of truth prevents the left panel and footer bar from going out of sync. Adding a new page in the future only requires adding one entry.

### D4: Active Route Detection — svelte-spa-router's `$location`

**Decision**: Use the `location` readable store from `svelte-spa-router` to determine which route is active. Compare `$location` against each nav item's route to apply the active highlight.

**Rationale**: The router already manages location state. Re-using it avoids duplicating routing logic or managing a separate "active page" state.

### D5: FooterBar Enhancement — Conditional navigation icons

**Decision**: In narrow mode, `FooterBar.svelte` renders navigation icons (Chat, Settings, Scheduler) as clickable buttons alongside existing elements (ApprovalModeIndicator, settings button for logged-out users). In wide mode, FooterBar omits navigation icons (the left panel handles navigation).

**Rationale**: Preserves the existing FooterBar behavior while enhancing it for narrow mode. Avoids creating a completely separate narrow-mode footer component.

### D6: UserLoginStatus Placement

**Decision**: In wide mode, `UserLoginStatus` is rendered at the bottom of `LeftPanel`. In narrow mode, it stays in the `FooterBar` (current location). The component itself is unchanged — only its mount point differs based on mode.

**Rationale**: Spec requirement (FR-003, FR-005). The component is self-contained and works identically regardless of parent container.

### D7: Theme Support — Follow existing pattern

**Decision**: All new components (`AppShell`, `LeftPanel`, `NavTab`) subscribe to `uiTheme` store and apply theme-specific CSS classes (`.terminal` / `.chatgpt`), following the identical pattern used by `FooterBar`, `TerminalContainer`, and all other themed components.

**Rationale**: Consistency with existing codebase. No new theming infrastructure needed.

## Complexity Tracking

> No constitution violations to justify. The design adds the minimum necessary components (1 store, 3 components) with no new dependencies.
