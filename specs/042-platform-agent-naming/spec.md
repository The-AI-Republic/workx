# Feature Specification: Platform-Specific Agent Naming

**Feature Branch**: `042-platform-agent-naming`
**Created**: 2026-03-07
**Status**: Draft
**Input**: User description: "Platform-specific agent naming: BrowserX for extension, Apple Pi for desktop, Apple Pi Server for server"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent Chat Label Reflects Platform (Priority: P1)

When the agent responds in the chat UI, the sender label must match the current platform:
- **Chrome Extension**: "BrowserX:"
- **Desktop App**: "Apple Pi:"
- **Server App**: "Apple Pi Server:"

Currently, the label is always "BrowserX:" regardless of platform.

**Why this priority**: The chat label is the most visible, highest-frequency touchpoint for agent identity. Users see it on every single message.

**Independent Test**: Send a message on each platform build and verify the agent response label matches the expected name.

**Acceptance Scenarios**:

1. **Given** the agent is running as a Chrome extension, **When** the agent responds, **Then** the message header displays "BrowserX:"
2. **Given** the agent is running as the desktop app, **When** the agent responds, **Then** the message header displays "Apple Pi:"
3. **Given** the agent is running as the server app, **When** the agent responds, **Then** the message header displays "Apple Pi Server:"

---

### User Story 2 - System Prompt Uses Correct Agent Name (Priority: P1)

The system prompt sent to the LLM must identify the agent with the correct name per platform:
- **Chrome Extension**: "You are BrowserX, a browser automation agent..."
- **Desktop App**: "You are Apple Pi, a desktop automation agent..." (note the space -- not "ApplePi")
- **Server App**: "You are Apple Pi Server, a ..."

Currently, `applepi_intro.md` says "You are ApplePi" (no space). Both desktop and server use agent type `'applepi'` without distinguishing between them.

**Why this priority**: The system prompt shapes the LLM's self-identity. A mismatch between what the agent calls itself and the UI label would be confusing.

**Independent Test**: Inspect the composed system prompt on each platform build and verify the agent name is correct.

**Acceptance Scenarios**:

1. **Given** the agent type is `'browserx'`, **When** the system prompt is composed, **Then** it begins with "You are BrowserX"
2. **Given** the agent type is `'applepi'`, **When** the system prompt is composed, **Then** it begins with "You are Apple Pi" (with space)
3. **Given** the agent type is `'applepi-server'`, **When** the system prompt is composed, **Then** it begins with "You are Apple Pi Server"

---

### User Story 3 - Server Gets Distinct Agent Identity (Priority: P2)

The server bootstrap currently uses agent type `'applepi'` (same as desktop). To differentiate "Apple Pi" from "Apple Pi Server", the server needs its own agent type (`'applepi-server'`) and corresponding intro fragment.

**Why this priority**: Without a separate type, the server cannot have a distinct system prompt identity. Lower priority because the server UI is less user-facing.

**Independent Test**: Boot the server agent and verify the composed prompt uses "Apple Pi Server" identity.

**Acceptance Scenarios**:

1. **Given** the server bootstrap calls `configurePromptComposer`, **When** using type `'applepi-server'`, **Then** the prompt composer selects the server-specific intro fragment

---

### Edge Cases

- Build mode `'mobile'` (future): should default to same behavior as desktop ("Apple Pi") until explicitly defined.
- If `__BUILD_MODE__` is undefined or unrecognized, the chat label should fall back to "BrowserX" (extension default).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The chat message sender label MUST display "BrowserX" when `__BUILD_MODE__ === 'extension'`
- **FR-002**: The chat message sender label MUST display "Apple Pi" when `__BUILD_MODE__ === 'desktop'`
- **FR-003**: The chat message sender label MUST display "Apple Pi Server" when `__BUILD_MODE__ === 'server'`
- **FR-004**: The system prompt fragment `applepi_intro.md` MUST use "Apple Pi" (with space) instead of "ApplePi"
- **FR-005**: A new system prompt fragment MUST exist for server mode using "Apple Pi Server" as the agent name
- **FR-006**: `AgentType` union MUST be extended to include `'applepi-server'`
- **FR-007**: `ServerAgentBootstrap` MUST pass `'applepi-server'` to `configurePromptComposer()`
- **FR-008**: `PromptComposer` MUST select the server intro fragment when agent type is `'applepi-server'`
- **FR-009**: `EventProcessor.ts` MUST use a platform-aware agent name instead of hardcoded `t('browserx')`
- **FR-010**: `EventDisplay.svelte` MUST use a platform-aware agent name instead of hardcoded `t('BrowserX')`

### Key Entities

- **AgentType**: Union type determining prompt composition -- extended from `'browserx' | 'applepi'` to `'browserx' | 'applepi' | 'applepi-server'`
- **PlatformCapabilities.platformName**: Already tracks `'extension' | 'desktop' | 'mobile'` -- used to derive the display name

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On extension build, agent messages display "BrowserX:" and system prompt says "You are BrowserX"
- **SC-002**: On desktop build, agent messages display "Apple Pi:" and system prompt says "You are Apple Pi"
- **SC-003**: On server build, system prompt says "You are Apple Pi Server"
- **SC-004**: No occurrences of "ApplePi" (without space) remain in user-facing text or system prompts
