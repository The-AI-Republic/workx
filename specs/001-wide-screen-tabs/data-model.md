# Data Model: Wide Screen Mode with Left Tab Panel

**Feature**: 001-wide-screen-tabs
**Date**: 2026-02-23

## Overview

This feature is primarily a UI layout feature with no persistent data model changes. The "entities" are runtime UI state objects and component configuration. No database, API, or storage schema changes are required.

## Runtime Entities

### NavItem

Represents a navigable page destination. Shared configuration between LeftPanel and FooterBar.

| Field   | Type     | Description                                      |
|---------|----------|--------------------------------------------------|
| id      | string   | Unique identifier (e.g., 'chat', 'settings', 'scheduler') |
| label   | string   | Display label (i18n key), e.g., 'Chat', 'Settings', 'Scheduler' |
| icon    | string   | SVG path data or component reference for the icon |
| route   | string   | Router path (e.g., '/', '/settings', '/scheduler') |

**Constraints**:
- `id` must be unique across all nav items
- `route` must match a defined route in `App.svelte`
- `label` should be an i18n-translatable string

**Lifecycle**: Static — defined once at module level, never changes at runtime.

### LayoutState

Reactive state managed by `layoutStore.ts`.

| Field      | Type    | Description                                    |
|------------|---------|------------------------------------------------|
| isWideMode | boolean | `true` when window width > 768px, `false` otherwise |

**Lifecycle**:
- Initialized on app mount based on current window width
- Updated reactively when window crosses the 769px threshold (via `matchMedia`)
- Read-only from consuming components (no setter exposed)

### ActiveRoute

Derived from svelte-spa-router's `location` store.

| Field    | Type   | Description                             |
|----------|--------|-----------------------------------------|
| location | string | Current hash-based path (e.g., '/', '/settings') |

**Lifecycle**: Managed by svelte-spa-router. Updated on every route change via `push()`.

## Relationships

```text
NavItem[] ──referenced by──> LeftPanel (wide mode)
NavItem[] ──referenced by──> FooterBar (narrow mode)
LayoutState.isWideMode ──controls──> AppShell (which layout to render)
ActiveRoute.location ──compared to──> NavItem.route (active highlighting)
```

## State Transitions

```text
Layout Mode:
  narrow ──[window width crosses above 769px]──> wide
  wide ──[window width crosses below 769px]──> narrow

Active Route (unchanged from current):
  / ──[click Settings tab/icon]──> /settings
  / ──[click Scheduler tab/icon]──> /scheduler
  /settings ──[click Chat tab/icon]──> /
  /scheduler ──[click Chat tab/icon]──> /
  (any route) ──[resize window]──> (same route, no change)
```

## No Persistent Data Changes

- No new storage keys added to `chrome.storage.local` or `AgentConfig`
- No API endpoint changes
- No schema migrations needed
- User's layout mode preference is not persisted (determined by current window width)
