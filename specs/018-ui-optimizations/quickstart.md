# Quickstart: UI Optimizations

**Feature**: 018-ui-optimizations

## Changes Overview

Two CSS modifications in the sidepanel UI:

### Change 1: Widen Content Container

**File**: `src/extension/sidepanel/pages/chat/Main.svelte`
**Line**: ~1128

```css
/* Before */
.content-container {
    max-width: 900px;
}

/* After */
.content-container {
    max-width: 1200px;
}
```

### Change 2: Fix Terminal Sandbox Dropdown Dark Mode

**File**: `src/extension/sidepanel/pages/chat/Main.svelte`
**Lines**: ~1473-1510 (settings modal container styles)

Add `color-scheme: dark` to the terminal-themed settings modal container, and `color-scheme: light` to the ChatGPT-themed variant:

```css
/* Terminal theme (default) - add color-scheme */
.settings-modal-container {
    color-scheme: dark;
    /* ... existing properties ... */
}

/* ChatGPT theme - ensure light scheme */
.settings-modal-container.chatgpt {
    color-scheme: light;
    /* ... existing properties ... */
}
```

## Verification

1. **Content width**: Open the app in a window wider than 1200px. The conversation area should span up to 1200px and center.
2. **Dropdown dark mode**: Open Settings > Tools Settings > Advanced Configuration > Sandbox Policy dropdown. All options should be readable with dark background.
3. **Light theme check**: Switch to ChatGPT theme. The dropdown should render with light styling. The content container should still respect 1200px.

## Build & Test

```bash
npm run build          # Extension build
npm run build:desktop  # Desktop build
npm run test:all       # Run all tests
```
