# Research: LLM Settings Tool

**Feature**: 031-llm-settings-tool
**Date**: 2026-02-23

## Decision 1: Tool Implementation Pattern

**Decision**: Follow the existing `BaseTool` abstract class pattern (same as DOMTool, NavigationTool, etc.)

**Rationale**: All tools in the codebase extend `BaseTool`, define a `toolDefinition` via `createToolDefinition()`, and implement `executeImpl()`. The SettingTool must follow this pattern for consistency and compatibility with the ToolRegistry.

**Alternatives considered**:
- Custom tool class outside BaseTool hierarchy: Rejected -- would not integrate with ToolRegistry.register() or risk assessment pipeline.
- Inline handler without a class: Rejected -- all other tools use class-based approach; consistency matters.

## Decision 2: Settings Access via Allowlist

**Decision**: Define a `SETTINGS_ALLOWLIST` constant that maps allowlisted setting keys to their metadata (category, type, allowed values, storage path). Only settings in this list are accessible via the SettingTool.

**Rationale**: The allowlist acts as a security boundary. New settings are blocked by default until explicitly reviewed and added. This prevents accidental exposure of sensitive data (API keys, secrets) and follows the principle of least privilege.

**Alternatives considered**:
- Denylist (block specific sensitive keys): Rejected -- new settings would be exposed by default, creating security risk.
- Dynamic introspection from settingsSearchRegistry: Rejected -- that registry is a UI search index, not a security boundary. It includes all settings including sensitive ones.

## Decision 3: Settings Storage Read/Write Mechanism

**Decision**: Use the existing storage layer -- `chrome.storage.local` (extension) / Tauri storage (desktop) via the same `STORAGE_KEYS.CONFIG` and `STORAGE_KEYS.APPROVAL_CONFIG` paths used by the settings UI.

**Rationale**: The settings UI already reads/writes to `agent_config` and `approval_config` storage keys. The SettingTool must use the same storage paths to ensure changes are synchronized. The `buildRuntimeConfig()` / `extractStoredConfig()` pattern in `src/config/defaults.ts` handles merge logic.

**Alternatives considered**:
- Separate storage key for tool-managed settings: Rejected -- would cause desync between UI and tool-managed values.
- Direct Svelte store manipulation: Rejected -- tools run in service worker/background context, not in the UI layer.

## Decision 4: YOLO Mode Read-Only Enforcement

**Decision**: Implement YOLO restriction inside the SettingTool's `executeImpl()` method by checking the current approval mode before executing write operations. The tool itself remains registered; write actions are blocked at execution time.

**Rationale**: The SettingTool needs to remain in the tool list for reads in YOLO mode. Removing it entirely from the registry would block reads too. The check must happen within the tool's execution logic.

**Alternatives considered**:
- Exclude tool from registry in YOLO mode: Rejected -- would block read operations too.
- Modify ApprovalGate to have per-action checks: Rejected -- over-engineering; the ApprovalGate operates at tool level, not action level. Simpler to check in the tool itself.

## Decision 5: Risk Assessment for SettingTool

**Decision**: Create a `SettingToolRiskAssessor` that assigns risk scores based on action type:
- `get` / `list` actions: risk 0 (read-only, auto-approve)
- `set` / `update` actions: risk 50 (medium, ask user in balanced/high-speed mode)

**Rationale**: Read operations are safe and should always auto-approve. Write operations modify system behavior and should require user confirmation in non-YOLO modes. Risk score 50 ensures `ask_user` in balanced mode (threshold > 30) and high-speed mode (threshold > 60 would auto-approve -- but 50 is below 60 so it would also ask). Setting to 50 ensures ask in both balanced and high-speed modes.

**Alternatives considered**:
- StaticRiskAssessor (fixed score): Rejected -- reads and writes have fundamentally different risk levels.
- Risk score 70+ for writes: Rejected -- too aggressive; settings changes are user-requested, not inherently dangerous.

## Decision 6: UI Synchronization

**Decision**: After a successful write, the SettingTool dispatches a storage change event that the Svelte stores already listen to. The existing `chrome.storage.onChanged` listener (extension) or equivalent Tauri mechanism handles UI updates.

**Rationale**: The settings UI already reacts to storage changes. No new event system is needed. Writing to the same storage keys triggers the existing reactive update pipeline.

**Alternatives considered**:
- Direct Svelte store update from tool: Rejected -- tools don't have access to Svelte store context.
- Custom event bus: Rejected -- unnecessary complexity when storage change listeners already exist.

## Decision 7: Tool Actions Schema

**Decision**: The SettingTool exposes three actions via a single tool:
- `get`: Read a single setting by key
- `set`: Update a single setting by key and value
- `list`: List all allowlisted settings with current values

**Rationale**: Follows the DOMTool pattern of a single tool with an `action` parameter. Three actions cover all spec requirements (FR-001, FR-002, FR-008). Keeping it as one tool simplifies registration and the LLM's tool selection.

**Alternatives considered**:
- Separate tools (SettingReadTool, SettingWriteTool): Rejected -- more registration complexity, harder for LLM to choose between.
- Five actions (get, set, list, add_to_list, remove_from_list): Rejected -- `set` can handle list operations by passing the updated list; keeping actions minimal reduces schema complexity.
