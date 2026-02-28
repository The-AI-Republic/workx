# Feature Specification: LLM Settings Tool

**Feature Branch**: `031-llm-settings-tool`
**Created**: 2026-02-23
**Status**: Draft
**Input**: User description: "Expose the settings to LLM. Currently we have to manually let users do the settings themselves. If a user wants to send a command to the agent to update the settings, we should allow that. 1) Create a new tool SettingTool to interact with the agent settings. 2) Disable the setting tool use in YOLO mode."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read Current Settings via Chat (Priority: P1)

A user wants to check their current agent settings without navigating to the settings panel. They type a natural language request like "What is my current approval mode?" or "Show me my tool configuration" in the chat, and the agent reads and reports the current settings values.

**Why this priority**: Reading settings is the safest operation and provides immediate value by letting users quickly inspect configuration without leaving the conversation flow.

**Independent Test**: Can be fully tested by sending a chat message asking about a specific setting and verifying the agent returns the correct current value.

**Acceptance Scenarios**:

1. **Given** a user is in a chat session with the agent, **When** the user asks "What is my current approval mode?", **Then** the agent reads the approval configuration and responds with the current mode (e.g., "Your current approval mode is balanced").
2. **Given** a user is in a chat session, **When** the user asks "Show me my tool settings", **Then** the agent lists which tools are enabled/disabled along with their current configuration.
3. **Given** a user is in a chat session, **When** the user asks about a setting that does not exist, **Then** the agent responds with a clear message that the setting is not recognized and suggests valid setting names.

---

### User Story 2 - Update Settings via Chat (Priority: P1)

A user wants to change a setting through natural language. They type something like "Enable the DOM tool" or "Switch my approval mode to high speed" and the agent modifies the setting accordingly, confirming the change back to the user.

**Why this priority**: This is the core value of the feature -- allowing users to modify their configuration conversationally rather than navigating the settings UI.

**Independent Test**: Can be fully tested by sending a chat message requesting a setting change, verifying the setting was updated in storage, and confirming the agent reports the change.

**Acceptance Scenarios**:

1. **Given** a user is in a chat session with the DOM tool currently disabled, **When** the user says "Enable the DOM tool", **Then** the agent updates the tool configuration to enable the DOM tool and confirms "DOM tool has been enabled".
2. **Given** a user is in a chat session, **When** the user says "Set my approval mode to high speed", **Then** the agent updates the approval mode and confirms the change.
3. **Given** a user requests a setting change that requires a value outside of allowed options, **When** the agent receives the request, **Then** it rejects the change with a clear error explaining the valid options.
4. **Given** a user is in a chat session, **When** the user says "Add example.com to my trusted domains", **Then** the agent updates the trusted domains list and confirms the addition.

---

### User Story 3 - Setting Tool Read-Only in YOLO Mode (Priority: P1)

When the system is running in YOLO mode (auto-approve everything), the SettingTool must be restricted to read-only operations. Users can still ask the agent to inspect their current settings, but any write operations are blocked. Users must switch out of YOLO mode to modify settings via chat.

**Why this priority**: This is a critical safety constraint. In YOLO mode, all tool calls are auto-approved -- if the SettingTool could write, the agent could change settings (including security settings) without any user confirmation, creating a dangerous feedback loop. Allowing reads is safe and keeps the tool useful for inspection.

**Independent Test**: Can be tested by setting the system to YOLO mode, verifying read requests succeed, and verifying write requests are blocked with an appropriate message.

**Acceptance Scenarios**:

1. **Given** the system is in YOLO mode, **When** the user asks the agent "What is my current approval mode?", **Then** the agent reads and reports the current setting value successfully.
2. **Given** the system is in YOLO mode, **When** the user asks the agent to change a setting, **Then** the agent informs the user that settings cannot be modified in YOLO mode and suggests switching to balanced or high-speed mode first.
3. **Given** the system switches from YOLO mode to balanced mode, **When** the user asks the agent to change a setting, **Then** full read-write access is restored and the change proceeds normally.

---

### User Story 4 - Confirmation Before Applying Changes (Priority: P2)

Before any setting is actually modified, the agent presents the proposed change to the user for confirmation. This adds a safety layer so users can review what will change before it takes effect.

**Why this priority**: While reading settings is safe, modifying them can have significant effects on system behavior. A confirmation step prevents accidental or misunderstood changes.

**Independent Test**: Can be tested by requesting a setting change and verifying the agent first describes what will change and waits for user confirmation before applying.

**Acceptance Scenarios**:

1. **Given** a user requests "Switch approval mode to high speed", **When** the agent processes the request, **Then** it first shows a summary of the change (e.g., "This will change your approval mode from balanced to high speed. Confirm?") before applying.
2. **Given** the agent presents a proposed change and the user declines, **When** the user says "No" or "Cancel", **Then** the setting remains unchanged and the agent acknowledges the cancellation.

---

### Edge Cases

- What happens when the user requests multiple setting changes in a single message (e.g., "Enable DOM tool and switch to high-speed mode")? The agent should handle each change individually, presenting each for confirmation.
- What happens when a setting change would conflict with another setting (e.g., enabling a tool that requires another tool to be enabled first)? The agent should notify the user of the dependency.
- What happens when the settings storage is unavailable or fails to persist? The agent should inform the user that the change could not be saved and suggest retrying.
- What happens when the user tries to change the approval mode to YOLO via the SettingTool? The agent should allow it but warn that the SettingTool will become read-only (write access disabled) once YOLO mode is active.
- What happens when the user asks the agent to read or change a setting not on the allowlist (e.g., API key, secrets, or any new unreviewed setting)? The SettingTool must reject the request with a message directing the user to the settings UI.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a SettingTool that the agent can invoke to read settings that are explicitly included in a maintained allowlist. Only allowlisted settings are accessible; all others are invisible to the tool.
- **FR-002**: System MUST provide a SettingTool that the agent can invoke to update allowlisted settings only, with the change persisted to storage.
- **FR-011**: System MUST enforce an allowlist safe check -- a maintained list of setting keys that are permitted for SettingTool access. Any setting not on the allowlist MUST be rejected with a clear message indicating the setting can only be managed through the settings UI. New settings added to the system are inaccessible by default until explicitly added to the allowlist.
- **FR-012**: The initial allowlist MUST include non-sensitive operational settings: approval mode, tool toggles (enable/disable individual tools), trusted domains, blocked domains, UI theme, language, and model selection (provider and model name, but not API keys or secrets).
- **FR-003**: System MUST restrict the SettingTool to read-only operations when the system is operating in YOLO mode. Write operations MUST be blocked with a message directing the user to switch to balanced or high-speed mode first.
- **FR-004**: System MUST restore full read-write access to the SettingTool when the system switches from YOLO mode to any other approval mode.
- **FR-005**: System MUST require user confirmation via the standard approval flow before applying any setting modification (write operations). Read operations do not require confirmation.
- **FR-006**: System MUST return clear, human-readable responses when settings are read, showing the setting name and its current value.
- **FR-007**: System MUST validate all setting values against their allowed ranges/options before applying changes, and return descriptive error messages for invalid values.
- **FR-008**: System MUST support listing all allowlisted settings and their current values in a single request.
- **FR-009**: System MUST notify the user when a requested setting change to YOLO mode will result in the SettingTool becoming read-only (write access disabled).
- **FR-010**: System MUST update the UI settings panel in real time to reflect changes made via the SettingTool, so the settings panel and chat-driven changes stay synchronized.

### Key Entities

- **Setting**: A named configuration value belonging to a category (model, general, tools, approval, extension). Has a name, current value, allowed values/range, and a human-readable description.
- **SettingTool**: An agent tool registered in the tool registry that exposes read and write operations for allowlisted settings only. Subject to the same risk assessment and approval flow as other tools.
- **Setting Category**: A logical grouping of related settings (e.g., "tools", "approval", "model") that users can query as a group.
- **Settings Allowlist**: A maintained list of setting keys that the SettingTool is permitted to access. Acts as a security boundary -- any setting not on the list is invisible to the tool. New settings are excluded by default until explicitly reviewed and added.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can read any individual setting value via chat in under 2 seconds from sending the message.
- **SC-002**: Users can update any setting via chat and see the change reflected in both the chat response and the settings panel within 3 seconds of confirming.
- **SC-003**: 100% of setting modification (write) attempts in YOLO mode are blocked with a clear explanation, while 100% of read requests in YOLO mode succeed normally.
- **SC-004**: All setting changes made via chat are correctly persisted and survive a page refresh or session restart.
- **SC-005**: 100% of invalid setting values are rejected with a descriptive error before any change is applied.
- **SC-006**: Users can discover available settings by asking the agent, receiving a complete categorized list of configurable options.

## Clarifications

### Session 2026-02-23

- Q: Should the SettingTool have access to sensitive credential-type settings (API keys)? → A: Use an allowlist approach -- only settings explicitly added to a maintained allowlist are exposed to the LLM conversation. All other settings (including API keys, secrets, and any new settings not yet reviewed) are inaccessible by default. A safe check must be enforced in code to prevent access to non-allowlisted settings.
- Q: In YOLO mode, should the SettingTool be fully blocked or should read-only access still be permitted? → A: Read-only in YOLO mode -- the SettingTool remains available but restricted to read operations only. Write operations are blocked with a message directing the user to switch out of YOLO mode first.

## Assumptions

- The existing settings registry provides a comprehensive catalog of all user-facing settings that the SettingTool can reference.
- The existing approval flow (approval gate) is sufficient for gating SettingTool write operations -- no new approval mechanism is needed.
- The SettingTool will follow the same registration pattern as existing tools (e.g., DOM tool, navigation tool) using the tool registry.
- Settings changes made via the SettingTool use the same storage mechanisms as settings changes made via the UI, ensuring consistency.
- The confirmation step for write operations relies on the existing risk assessment and approval system rather than introducing a separate confirmation mechanism.

## Scope Boundaries

**In Scope**:
- Reading and writing allowlisted settings via a new agent tool
- Allowlist-based safe check to prevent access to sensitive settings
- Restricting the SettingTool to read-only in YOLO mode
- Validation of setting values
- Synchronization between chat-driven changes and the settings UI

**Out of Scope**:
- Creating new settings categories or settings that don't already exist
- Changing system-level or internal configuration not exposed in the settings panel
- Bulk import/export of settings configurations
- Settings change history or undo functionality
