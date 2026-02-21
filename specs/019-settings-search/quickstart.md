# Quickstart: Settings Search (019)

**Date**: 2026-02-14

## Prerequisites

- Node.js (version per existing project)
- npm (package manager used by project)

## Setup

```bash
# Install new dependency
npm install fuse.js
```

## New Files to Create

1. **`src/extension/sidepanel/settings/settingsSearchRegistry.ts`**
   - Centralized registry of all ~55 searchable settings items
   - Each entry: id, label key, description key, section, navigation target, element ID, keywords, conditional rules

2. **`src/extension/sidepanel/settings/components/SettingsSearch.svelte`**
   - Search bar component with input, icon, clear button
   - Fuse.js integration with debounced search
   - Results list (replaces category cards when query is active)
   - Keyboard navigation (arrow keys, Enter, Escape)
   - Empty state display

## Files to Modify

1. **`src/extension/sidepanel/Settings.svelte`**
   - Add `highlightSettingId` state variable
   - Modify `handleCategorySelected` to extract `scrollToId`
   - Pass `highlightSettingId` prop to all 6 settings sub-pages

2. **`src/extension/sidepanel/settings/components/SettingsMenu.svelte`**
   - Import and render `SettingsSearch` component above category cards
   - Extend `categorySelected` event to include `scrollToId`
   - Conditionally hide category cards when search query is active

3. **`src/extension/sidepanel/settings/ModelSettings.svelte`**
   - Add `highlightSettingId` prop
   - Add scroll-to + highlight logic on mount
   - Add `data-setting-id` attributes to form groups missing HTML IDs

4. **`src/extension/sidepanel/settings/GeneralSettings.svelte`**
   - Same changes as ModelSettings

5. **`src/extension/sidepanel/settings/StorageSettings.svelte`**
   - Same changes as ModelSettings

6. **`src/extension/sidepanel/settings/ToolsSettings.svelte`**
   - Same changes as ModelSettings

7. **`src/extension/sidepanel/settings/MCPSettings.svelte`**
   - Same changes as ModelSettings

8. **`src/extension/sidepanel/settings/ExtensionSettings.svelte`**
   - Same changes as ModelSettings

## Verification

```bash
# Build check
npm run build

# Type check
npx tsc --noEmit

# Lint
npm run lint

# Manual testing
# 1. Open settings page
# 2. Type "cache" in search bar → verify Storage & Cache results appear
# 3. Type "timout" (typo) → verify "Tool Timeout" still appears
# 4. Click a result → verify navigation + scroll + highlight
# 5. Use arrow keys + Enter → verify keyboard navigation works
# 6. Press Escape → verify results clear
# 7. Clear search → verify category cards reappear
```
