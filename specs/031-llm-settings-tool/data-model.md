# Data Model: LLM Settings Tool

**Feature**: 031-llm-settings-tool
**Date**: 2026-02-23

## Entities

### AllowlistEntry

Represents a single setting that is permitted for SettingTool access.

| Field | Type | Description |
|-------|------|-------------|
| key | string | Unique setting identifier (e.g., `approval.mode`, `tools.dom_tool`) |
| category | string | Setting category: `model`, `general`, `tools`, `approval`, `storage` |
| label | string | Human-readable name for display (e.g., "Approval Mode") |
| description | string | Brief explanation of what this setting controls |
| type | `boolean` \| `string` \| `number` \| `string[]` | Value type for validation |
| allowedValues | array \| null | Enum of valid values (null if any value of the type is valid) |
| readPath | string | Dot-notation path to read from stored config (e.g., `preferences.uiTheme`) |
| writePath | string | Dot-notation path to write in stored config |
| storageKey | string | Storage key where this setting lives: `agent_config` or `approval_config` |

### SettingToolRequest

Input parameters the LLM passes to the SettingTool.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| action | `get` \| `set` \| `list` | Yes | Operation to perform |
| key | string | For `get`/`set` | Setting key from allowlist |
| value | any | For `set` | New value to apply |

### SettingToolResponse

Output returned to the LLM from the SettingTool.

| Field | Type | Description |
|-------|------|-------------|
| success | boolean | Whether the operation succeeded |
| action | string | The action that was performed |
| key | string \| null | The setting key (null for `list`) |
| value | any | Current value (for `get`) or new value (for `set`) |
| settings | AllowlistEntry[] \| null | All allowlisted settings with current values (for `list` only) |
| error | string \| null | Error message if operation failed |

## Initial Allowlist

Based on FR-012, the following settings are included in the initial allowlist:

### Approval Category (`approval_config` storage key)

| Key | Type | Allowed Values | Read/Write Path |
|-----|------|----------------|-----------------|
| `approval.mode` | string | `balanced`, `high_speed`, `yolo` | `mode` |
| `approval.trustedDomains` | string[] | any valid domain | `trustedDomains` |
| `approval.blockedDomains` | string[] | any valid domain | `blockedDomains` |

### Tools Category (`agent_config` storage key)

| Key | Type | Allowed Values | Read/Write Path |
|-----|------|----------------|-----------------|
| `tools.enable_all_tools` | boolean | `true`, `false` | `tools.enable_all_tools` |
| `tools.storage_tool` | boolean | `true`, `false` | `tools.storage_tool` |
| `tools.tab_tool` | boolean | `true`, `false` | `tools.tab_tool` |
| `tools.web_scraping_tool` | boolean | `true`, `false` | `tools.web_scraping_tool` |
| `tools.dom_tool` | boolean | `true`, `false` | `tools.dom_tool` |
| `tools.form_automation_tool` | boolean | `true`, `false` | `tools.form_automation_tool` |
| `tools.navigation_tool` | boolean | `true`, `false` | `tools.navigation_tool` |
| `tools.network_intercept_tool` | boolean | `true`, `false` | `tools.network_intercept_tool` |
| `tools.data_extraction_tool` | boolean | `true`, `false` | `tools.data_extraction_tool` |
| `tools.page_action_tool` | boolean | `true`, `false` | `tools.page_action_tool` |
| `tools.page_vision_tool` | boolean | `true`, `false` | `tools.page_vision_tool` |
| `tools.execCommand` | boolean | `true`, `false` | `tools.execCommand` |
| `tools.webSearch` | boolean | `true`, `false` | `tools.webSearch` |
| `tools.fileOperations` | boolean | `true`, `false` | `tools.fileOperations` |
| `tools.mcpTools` | boolean | `true`, `false` | `tools.mcpTools` |

### General Category (`agent_config` storage key)

| Key | Type | Allowed Values | Read/Write Path |
|-----|------|----------------|-----------------|
| `general.uiTheme` | string | `chatgpt`, `terminal` | `preferences.uiTheme` |
| `general.theme` | string | `light`, `dark`, `system` | `preferences.theme` |
| `general.language` | string | valid language codes | `preferences.language` |

### Model Category (`agent_config` storage key)

| Key | Type | Allowed Values | Read/Write Path |
|-----|------|----------------|-----------------|
| `model.selection` | string | valid `provider:modelKey` format | `selectedModelKey` |

**Explicitly excluded** (not in allowlist): API keys, secrets, provider credentials, organization IDs, internal version fields, extension permissions, sandbox policy.

## State Transitions

### SettingTool Availability State

```
Non-YOLO Mode (balanced / high_speed)
  → SettingTool: read + write enabled
  → Write actions go through ApprovalGate risk assessment (score 50 → ask_user)

YOLO Mode
  → SettingTool: read enabled, write blocked
  → Write actions return error with guidance to switch mode
  → Read actions execute normally (risk 0 → auto_approve in YOLO)
```

### Setting Value Lifecycle

```
1. User sends chat message requesting setting change
2. LLM invokes SettingTool with action: "set", key, value
3. SettingTool validates:
   a. Key exists in allowlist → if not, error "Setting not accessible"
   b. YOLO mode check → if YOLO, error "Write blocked in YOLO mode"
   c. Value matches allowed type/values → if not, error with valid options
4. ApprovalGate evaluates risk (score 50 → ask_user)
5. User confirms via approval UI
6. SettingTool writes to storage (chrome.storage.local / Tauri)
7. Storage change event fires → UI updates reactively
8. SettingTool returns success response to LLM
9. LLM formats confirmation message to user
```
