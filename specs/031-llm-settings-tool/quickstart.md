# Quickstart: LLM Settings Tool

**Feature**: 031-llm-settings-tool

## What This Feature Does

Adds a new `setting_tool` to the agent's toolkit that allows the LLM to read and modify user settings via natural language chat. Settings access is gated by an allowlist (security boundary) and write operations are blocked in YOLO mode.

## Key Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `src/tools/SettingTool.ts` | Main tool implementation (extends BaseTool) |
| `src/tools/settingsAllowlist.ts` | Allowlist constant + validation helpers |
| `src/core/approval/assessors/SettingToolRiskAssessor.ts` | Risk scorer (read=0, write=50) |
| `src/tools/__tests__/SettingTool.test.ts` | Unit tests for SettingTool |
| `src/tools/__tests__/settingsAllowlist.test.ts` | Unit tests for allowlist validation |

### Modified Files

| File | Change |
|------|--------|
| `src/tools/index.ts` | Register SettingTool in `registerTools()` (always enabled, like PlanningTool) |
| `src/config/types.ts` | Add `setting_tool?: boolean` to `IToolsConfig` (optional, for future toggle) |

## Implementation Order

1. **settingsAllowlist.ts** — Define the allowlist data structure and initial entries
2. **SettingToolRiskAssessor.ts** — Simple risk assessor (get/list → 0, set → 50)
3. **SettingTool.ts** — Tool class with get/set/list actions, allowlist check, YOLO write block
4. **index.ts** — Register the SettingTool (always enabled)
5. **Tests** — Unit tests for all new files

## Architecture Decisions

- **Allowlist-first security**: Only explicitly listed settings are accessible. API keys and secrets are never exposed.
- **YOLO read-only**: In YOLO mode, reads work normally but writes are blocked inside `executeImpl()`.
- **Same storage path**: Writes go to the same `chrome.storage.local` / Tauri storage keys used by the settings UI, ensuring automatic synchronization.
- **Single tool, three actions**: `get`, `set`, `list` — follows the DOMTool pattern.
- **Risk assessment**: Reads auto-approve (score 0). Writes require user confirmation (score 50, triggers `ask_user` in balanced/high-speed mode).

## How It Works

```
User: "Enable the DOM tool"
  ↓
LLM invokes: setting_tool({ action: "set", key: "tools.dom_tool", value: true })
  ↓
SettingTool.executeImpl():
  1. Validate key in allowlist ✓
  2. Check YOLO mode → not YOLO ✓
  3. Validate value type (boolean) ✓
  4. Return to ToolRegistry for ApprovalGate check
  ↓
ApprovalGate: risk score 50 → ask_user
  ↓
User approves in approval UI
  ↓
SettingTool writes to chrome.storage.local
  ↓
Storage change event → UI settings panel updates
  ↓
LLM responds: "DOM tool has been enabled"
```

## Testing Strategy

- **Unit tests**: Test each action (get/set/list), allowlist validation, YOLO blocking, invalid key handling, type validation
- **Risk assessor tests**: Verify correct scores for get/set/list actions
- **Integration consideration**: Storage read/write roundtrip (mocked storage)
