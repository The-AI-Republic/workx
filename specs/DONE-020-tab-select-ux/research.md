# Research: Tab Select Menu UX Improvements

**Feature**: 020-tab-select-ux
**Date**: 2026-02-14

## R-001: Tooltip for Dropdown Items

**Decision**: Reuse the existing `Tooltip` component (Tippy.js wrapper) from `src/extension/sidepanel/components/common/Tooltip.svelte`.

**Rationale**: The Tooltip component is already imported and used in `TabContext.svelte` for the main tab context display. It supports all required features: theme-aware styling (terminal/chatgpt), configurable placement, content reactivity, and `appendTo: document.body` to escape overflow constraints. Each dropdown item will be wrapped with `<Tooltip content={tab.title || tab.url || 'Untitled'}>`.

**Alternatives considered**:
- Native HTML `title` attribute: Simpler but inconsistent styling, no theme support, browser-controlled delay.
- Custom CSS tooltip: More work, would duplicate existing Tippy.js functionality.

## R-002: Active Tab Detection via `chrome.tabs.onActivated`

**Decision**: Use `chrome.tabs.onActivated` event listener to track the active tab ID reactively.

**Rationale**: The `chrome.tabs.onActivated` event fires whenever the user switches tabs within a window. It provides `activeInfo.tabId` and `activeInfo.windowId`. Combined with the `active` property already present on `chrome.tabs.Tab` objects from `chrome.tabs.query()`, this provides both initial state (on dropdown open) and reactive updates (while dropdown is open or closed). The codebase already uses `chrome.tabs.onUpdated` in the same component — `onActivated` follows the same pattern.

**Alternatives considered**:
- Polling `chrome.tabs.query()`: Wasteful, introduces latency, not reactive.
- Only checking `tab.active` on dropdown open: Doesn't support live updates while dropdown is open.

## R-003: i18n for "(current)" Label

**Decision**: Use `$_t("(current)")` to make the label translatable, consistent with existing i18n patterns.

**Rationale**: The codebase uses `$_t()` for all user-facing strings (e.g., `$_t("Create New Tab")`, `$_t("No tabs available")`). The "(current)" label should follow the same pattern. New entries needed in `_locales/en/messages.json` and `_locales/key_map.json`.

**Alternatives considered**:
- Hardcoded string: Breaks i18n consistency, would fail localization for non-English users.

## R-004: Tooltip Placement in Dropdown Context

**Decision**: Use `placement="right"` for dropdown item tooltips.

**Rationale**: The dropdown is a vertical list. Tooltips appearing to the right avoid obscuring other items in the list and don't interfere with the dropdown's scroll area. The Tippy.js library handles overflow detection and flipping automatically.

**Alternatives considered**:
- `placement="top"`: Would overlap with items above in the list.
- `placement="left"`: Side panel is typically on the right edge; tooltip would point toward content area.

## R-005: Active Tab State Management

**Decision**: Store `activeTabId` as a local reactive variable in `TabContext.svelte`, updated by `chrome.tabs.onActivated` listener.

**Rationale**: The active tab state is only needed within the TabContext component for display purposes. No global store is needed since it's purely a UI indicator. The variable is set on component mount via `chrome.tabs.query()` (checking `tab.active`) and kept in sync via the `onActivated` listener. Cleanup follows the same pattern as the existing `onUpdated` listener.

**Alternatives considered**:
- Svelte store: Unnecessary complexity for component-local state.
- Passing as prop from parent: Parent doesn't currently track active tab; would require upstream changes.
