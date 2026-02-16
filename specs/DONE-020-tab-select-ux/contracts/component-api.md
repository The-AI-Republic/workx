# Component API Contract: TabContext.svelte

**Feature**: 020-tab-select-ux
**Date**: 2026-02-14

## Props (unchanged)

| Prop        | Type      | Default | Description                        |
| ----------- | --------- | ------- | ---------------------------------- |
| `tabId`     | `number`  | `-1`    | Session-bound tab ID               |
| `clickable` | `boolean` | `true`  | Enable dropdown for tab selection  |

## Events (unchanged)

| Event          | Payload                  | Description                    |
| -------------- | ------------------------ | ------------------------------ |
| `tabSelected`  | `{ tabId: number }`      | Fired when user selects a tab  |

## New Chrome API Usage

### `chrome.tabs.onActivated`

**Added**: Listener to track active tab changes.

```typescript
// On mount
chrome.tabs.onActivated.addListener(handleTabActivated);

// Handler
function handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
  if (activeInfo.windowId === currentWindowId) {
    activeTabId = activeInfo.tabId;
  }
}

// On destroy
chrome.tabs.onActivated.removeListener(handleTabActivated);
```

### `chrome.windows.getCurrent` (optional)

Used once on mount to capture `currentWindowId` for filtering `onActivated` events to the current window only.

## Dropdown Item Template Changes

### Before (current)
```html
<span class="tab-item-title">{tab.title || tab.url || 'Untitled'}</span>
```

### After
```html
<Tooltip content={tab.title || tab.url || 'Untitled'} placement="right">
  <span class="tab-item-title">
    {#if tab.id === activeTabId}(current) {/if}{tab.title || tab.url || 'Untitled'}
  </span>
</Tooltip>
```

## i18n Additions

| Key (source text) | Message key (generated)     | English value |
| ------------------ | --------------------------- | ------------- |
| `(current)`        | `_current_`                 | `(current)`   |
