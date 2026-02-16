# Data Model: Tab Select Menu UX Improvements

**Feature**: 020-tab-select-ux
**Date**: 2026-02-14

## Entities

This feature introduces no new data entities. It enhances existing UI behavior in the `TabContext` component.

### Modified State: TabContext Component

**New local state variable**:

| Variable      | Type     | Default | Description                                      |
| ------------- | -------- | ------- | ------------------------------------------------ |
| `activeTabId` | `number` | `-1`    | ID of the browser's currently active (focused) tab in the current window |

**Lifecycle**:
- Initialized on component mount via `chrome.tabs.query({ active: true, currentWindow: true })`
- Updated reactively via `chrome.tabs.onActivated` listener
- Used in dropdown template to conditionally render `(current)` prefix
- Cleaned up on component destroy (remove `onActivated` listener)

### Existing State (unchanged)

| Variable        | Type                  | Description                              |
| --------------- | --------------------- | ---------------------------------------- |
| `tabId`         | `number`              | Session-selected tab (prop from parent)  |
| `availableTabs` | `chrome.tabs.Tab[]`   | Tabs fetched on dropdown open            |
| `fullTitle`     | `string`              | Full title of session-selected tab       |
| `displayTitle`  | `string`              | Truncated display title (max 25 chars)   |
| `isDropdownOpen`| `boolean`             | Dropdown visibility state                |

### Relationship: Active vs Selected

- **Active tab** (`activeTabId`): The browser's focused tab — indicated by `(current)` prefix
- **Selected tab** (`tabId`): The tab bound to the BrowserX session — indicated by checkmark (✓)
- These are independent concepts: a tab can be active-only, selected-only, both, or neither
