# Component API Contracts: Settings Search (019)

**Date**: 2026-02-14

This feature is entirely frontend (Svelte components). No REST/GraphQL endpoints are involved. The contracts below define the component interfaces (props, events, types).

## New Types

### `settingsSearchRegistry.ts`

```typescript
export interface SettingsSearchItem {
  id: string;
  labelKey: string;
  descriptionKey: string;
  section: SettingsSection;
  sectionLabelKey: string;
  keywords: string[];
  navigationTarget: NavigationView;
  elementId: string;
  conditional?: ConditionalRule;
}

export enum SettingsSection {
  MODEL_CONFIG = 'model-config',
  GENERAL = 'general',
  STORAGE = 'storage',
  TOOLS = 'tools',
  MCP_SERVERS = 'mcp-servers',
  EXTENSION = 'extension',
}

export interface ConditionalRule {
  type: 'platform' | 'feature';
  value: string;
}

export type NavigationView = 'menu' | 'model-config' | 'advanced-model-config' | 'general' | 'storage' | 'tools' | 'mcp-servers' | 'extension';
```

## Modified Components

### Settings.svelte

**New state variables**:
```typescript
let highlightSettingId: string | undefined = undefined;
```

**Modified `handleCategorySelected`**:
```typescript
// Before:
function handleCategorySelected(event: CustomEvent<{ categoryId: string }>) {
  navigateTo(event.detail.categoryId as NavigationView);
}

// After:
function handleCategorySelected(event: CustomEvent<{ categoryId: string; scrollToId?: string }>) {
  highlightSettingId = event.detail.scrollToId;
  navigateTo(event.detail.categoryId as NavigationView);
}
```

**Modified sub-component rendering** (all 6 sub-pages):
```svelte
<ModelSettings
  {settingsConfig}
  {highlightSettingId}
  on:back={handleBack}
  ...
/>
```

### SettingsMenu.svelte

**Modified event type**:
```typescript
// Before:
const dispatch = createEventDispatcher<{
  categorySelected: { categoryId: string };
}>();

// After:
const dispatch = createEventDispatcher<{
  categorySelected: { categoryId: string; scrollToId?: string };
}>();
```

## New Components

### SettingsSearch.svelte

**Props**:
```typescript
export let isDesktop: boolean = false;  // For conditional settings filtering
```

**Events**:
```typescript
const dispatch = createEventDispatcher<{
  resultSelected: { categoryId: string; scrollToId: string };
}>();
```

**Behavior**:
- Renders search input with search icon and clear button
- On input: debounce 150ms, run Fuse.js search, display results (max 10)
- On result click: dispatch `resultSelected` event
- On Escape: clear results, retain query text
- On ArrowDown/ArrowUp: move keyboard focus through results
- On Enter (with highlighted result): dispatch `resultSelected`

## Prop Additions to Settings Sub-pages

All 6 settings sub-pages receive a new optional prop:

```typescript
// Added to: ModelSettings, GeneralSettings, StorageSettings, ToolsSettings, MCPSettings, ExtensionSettings
export let highlightSettingId: string | undefined = undefined;
```

**Behavior**: On mount (or when prop changes), if `highlightSettingId` is set:
1. Wait for DOM to render (`tick()`)
2. Find element by `id` or `data-setting-id` matching `highlightSettingId`
3. Scroll element into view (`scrollIntoView({ behavior: 'smooth', block: 'center' })`)
4. Add CSS class `highlight-pulse` to the element's closest `.settings-card` or `.form-group` parent
5. Remove `highlight-pulse` after 1.5s animation completes
6. Clear `highlightSettingId` after highlighting
