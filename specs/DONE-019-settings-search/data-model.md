# Data Model: Settings Search (019)

**Date**: 2026-02-14

## Entities

### SettingsSearchItem

Represents a single searchable settings entry in the registry.

| Field            | Type                | Description                                                        |
|------------------|---------------------|--------------------------------------------------------------------|
| id               | string              | Unique identifier for this setting (e.g., `"tools.timeout"`)      |
| labelKey         | string              | i18n key for the display label (e.g., `"Tool Timeout (ms)"`)      |
| descriptionKey   | string              | i18n key for the help text / description                           |
| section          | SettingsSection     | Which top-level section this setting belongs to                    |
| sectionLabelKey  | string              | i18n key for the section display name (e.g., `"Tools"`)           |
| keywords         | string[]            | Additional search terms not in label/description                   |
| navigationTarget | NavigationView      | The view ID to navigate to (e.g., `"tools"`, `"general"`)         |
| elementId        | string              | HTML element ID or data-setting-id for scroll-to targeting         |
| conditional      | ConditionalRule?    | Optional rule for when this item should be excluded from index     |

### SettingsSection (enum)

| Value              | Label Key                     | Navigation Target    |
|--------------------|-------------------------------|----------------------|
| MODEL_CONFIG       | `"Model Config"`              | `"model-config"`     |
| GENERAL            | `"General"`                   | `"general"`          |
| STORAGE            | `"Storage & Cache"`           | `"storage"`          |
| TOOLS              | `"Tools"`                     | `"tools"`            |
| MCP_SERVERS        | `"MCP Servers"`               | `"mcp-servers"`      |
| EXTENSION          | `"Extension & Permission"`    | `"extension"`        |

### ConditionalRule

Defines when a settings item should be excluded from the search index.

| Field     | Type                          | Description                                      |
|-----------|-------------------------------|--------------------------------------------------|
| type      | `"platform"` \| `"feature"`  | What kind of condition                           |
| value     | string                        | The condition value (e.g., `"desktop"`, `"disabled"`) |

Examples:
- Terminal Sandbox settings: `{ type: "platform", value: "desktop" }` — only show when running in Tauri desktop mode
- File Operations: `{ type: "feature", value: "disabled" }` — excluded because feature is not yet available

### FuseSearchResult

The result object returned by Fuse.js after a search query.

| Field     | Type               | Description                                 |
|-----------|--------------------|---------------------------------------------|
| item      | SettingsSearchItem | The matched settings item                   |
| score     | number             | Relevance score (0 = perfect match, 1 = no match) |
| refIndex  | number             | Original index in the source array          |

## Relationships

```
SettingsSearchItem  ──belongs to──>  SettingsSection
SettingsSearchItem  ──targets──>     NavigationView (existing type in Settings.svelte)
SettingsSearchItem  ──may have──>    ConditionalRule
```

## State Transitions

### Search State (within SettingsMenu)

```
IDLE ──(user types)──> SEARCHING ──(query cleared / Escape)──> IDLE
                           │
                           ├──(results found)──> RESULTS_SHOWN
                           └──(no results)──> EMPTY_STATE

RESULTS_SHOWN ──(query changed)──> SEARCHING
              ──(result clicked)──> NAVIGATING
              ──(query cleared)──> IDLE

EMPTY_STATE ──(query changed)──> SEARCHING
            ──(query cleared)──> IDLE
```

### Highlight State (within settings sub-page)

```
NONE ──(scrollToId prop set)──> SCROLLING ──(scroll complete)──> HIGHLIGHTING ──(animation ends, ~1.5s)──> NONE
```

## Validation Rules

- `id` must be unique across all registry entries
- `labelKey` and `descriptionKey` must be valid i18n translation keys
- `navigationTarget` must be a valid `NavigationView` type value
- `elementId` must correspond to an actual element in the target settings sub-page
- `keywords` array may be empty but must not contain duplicates
