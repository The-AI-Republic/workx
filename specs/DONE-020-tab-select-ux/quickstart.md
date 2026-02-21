# Quickstart: Tab Select Menu UX Improvements

**Feature**: 020-tab-select-ux
**Date**: 2026-02-14

## What This Feature Does

Enhances the tab selection dropdown in the BrowserX side panel with two improvements:
1. **Tooltips**: Hovering over any tab option shows the full tab title via tooltip
2. **Active marker**: The browser's currently active tab is prefixed with "(current)"

## Files to Modify

| File | Change |
| ---- | ------ |
| `src/extension/sidepanel/components/common/TabContext.svelte` | Add tooltip wrapping for dropdown items, add `activeTabId` tracking, render "(current)" prefix |
| `_locales/en/messages.json` | Add `(current)` translation entry |
| `_locales/en_GB/messages.json` | Add `(current)` translation entry |
| `_locales/key_map.json` | Add key mapping for `(current)` |
| `tests/unit/TabContext.test.ts` | Add tests for tooltip rendering and "(current)" marker behavior |

## Key Implementation Notes

1. **Tooltip**: The existing `Tooltip` component is already imported in `TabContext.svelte`. Wrap each `.dropdown-item` content with `<Tooltip>` passing the full tab title as `content`.

2. **Active tab tracking**: Add a `chrome.tabs.onActivated` listener (same pattern as existing `chrome.tabs.onUpdated` listener). Store `activeTabId` as a local variable. Initialize on mount by querying active tab.

3. **"(current)" prefix**: Conditionally render `$_t("(current)")` before the tab title when `tab.id === activeTabId`.

4. **Cleanup**: Add `chrome.tabs.onActivated.removeListener()` in `onDestroy` alongside existing `onUpdated` cleanup.

## Testing Approach

- Unit tests mock `chrome.tabs.onActivated` (same pattern as existing `chrome.tabs.onUpdated` mock)
- Test tooltip renders with correct content prop
- Test "(current)" prefix appears for active tab and not for others
- Test reactivity when active tab changes
- Manual testing in both terminal and chatgpt themes
