# Feature Specification: Dual-Mode Architecture (BrowserX Extension + PI Desktop Agent)

**Feature Branch**: `001-dual-mode-architecture`
**Created**: 2026-02-03
**Status**: Draft
**Input**: User description: "Restructure BrowserX agent to support dual build modes: (1) Chrome extension app, (2) Personal computer daemon app (Windows/macOS/Linux). Follow existing design document at .ai_design/desktop_app_design.md"

## Clarifications

### Session 2026-02-03

- Q: What authentication is required for WebSocket API connections? → A: No auth for localhost, API key required for non-localhost connections
- Q: Should PI use Chrome DevTools MCP auto-connect as primary browser control? → A: Yes, with fallback chain: (1) Chrome DevTools MCP auto-connect, (2) check existing debug port, (3) profile-copy + launch, (4) graceful degradation without browser features

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chrome Extension Continues Working (Priority: P0)

As an existing BrowserX user, I want the Chrome extension to continue functioning exactly as before after the codebase restructuring, so that I don't experience any disruption to my current workflow.

**Why this priority**: This is the foundation - the restructuring must not break existing functionality. Without this, all other work is pointless.

**Independent Test**: Install the restructured extension, perform all existing extension functions (browser automation, side panel interactions, tab page operations), verify identical behavior to current version.

**Acceptance Scenarios**:

1. **Given** the restructured codebase, **When** I build the Chrome extension, **Then** it produces a valid Manifest V3 extension that installs without errors
2. **Given** the extension is installed, **When** I open the side panel and send a task, **Then** the agent processes it and controls the browser as expected
3. **Given** an active agent session, **When** I use any existing tool (DOM manipulation, navigation, screenshots), **Then** the tool behaves identically to the pre-restructure version

---

### User Story 2 - Code Structure Supports Dual Builds (Priority: P0)

As a developer, I want the codebase organized into shared core code and platform-specific code, so that I can build either the extension or native app from the same source.

**Why this priority**: This is the architectural foundation that enables all native app functionality. Must be in place before any native-specific features.

**Independent Test**: Run both build commands (`npm run build` for extension, `npm run build:pi` for native) and verify each produces valid output without including the other's platform-specific code.

**Acceptance Scenarios**:

1. **Given** the restructured codebase, **When** I run the extension build, **Then** it excludes all `src/desktop/` code and includes all `src/extension/` and `src/core/` code
2. **Given** the restructured codebase, **When** I run the native build, **Then** it excludes all `src/extension/` code and includes all `src/desktop/` and `src/core/` code
3. **Given** the build configuration, **When** I check the output bundles, **Then** the `__BUILD_MODE__` constant is correctly set to 'extension' or 'native'

---

### User Story 3 - Browser Control Abstraction (Priority: P1)

As a developer, I want browser control operations abstracted behind a unified interface, so that the same automation logic works with both chrome.debugger (extension) and CDP (native) backends.

**Why this priority**: Browser automation is the core functionality. The abstraction layer enables native mode to reuse all existing DOM manipulation, navigation, and screenshot logic.

**Independent Test**: Write a test that instantiates both `ExtensionBrowserController` and `CDPBrowserController`, call the same operations, verify both produce equivalent results.

**Acceptance Scenarios**:

1. **Given** the `BrowserController` interface, **When** I call `navigate(url)` on either implementation, **Then** the browser navigates to the specified URL
2. **Given** a page is loaded, **When** I call `click(selector)` or `type(selector, text)`, **Then** the element is interacted with correctly regardless of implementation
3. **Given** the `DebuggerClient` abstraction, **When** `DomService` sends CDP commands, **Then** it works transparently with both `ChromeDebuggerClient` and `CDPDebuggerClient`

---

### User Story 4 - Native App Entry Point with Tauri (Priority: P1)

As a user, I want to run PI as a native desktop application with a system tray icon, so that the agent runs in the background and is always accessible.

**Why this priority**: The native app shell is required before any native-specific features (terminal, MCP, messaging) can be exposed to users.

**Independent Test**: Launch the Tauri app, verify it appears in system tray, click tray icon to open main window, verify the agent UI loads.

**Acceptance Scenarios**:

1. **Given** the PI app is installed, **When** I launch it, **Then** it displays a system tray icon on Windows/macOS/Linux
2. **Given** the app is running, **When** I click the tray icon, **Then** the main GUI window opens showing the chat interface
3. **Given** the app is running, **When** I close the main window, **Then** the app continues running in the tray

---

### User Story 5 - Channel Adapter Architecture (Priority: P1)

As a developer, I want UI channels (side panel, tab page, Tauri, WebSocket) to implement a unified `ChannelAdapter` interface, so that the agent core can receive submissions and emit events without knowing the specific channel.

**Why this priority**: Multi-channel support is essential for both extension (side panel + tab pages) and native (Tauri + WebSocket + messaging) modes.

**Independent Test**: Create a mock channel adapter, register it with ChannelManager, send a UserTurn submission, verify the agent processes it and events are dispatched back to the channel.

**Acceptance Scenarios**:

1. **Given** the `ChannelAdapter` interface, **When** a channel sends an `Op` submission, **Then** the `ChannelManager` routes it to the agent
2. **Given** the agent emits an `EventMsg`, **When** the event is dispatched, **Then** the `ChannelManager` sends it to the correct originating channel
3. **Given** multiple channels are registered, **When** each sends submissions, **Then** responses are correctly routed back to their respective channels

---

### User Story 6 - Storage Provider Abstraction (Priority: P1)

As a developer, I want storage operations abstracted so the agent uses IndexedDB in extension mode and SQLite in native mode, without changing core logic.

**Why this priority**: Persistent storage for conversations, settings, and credentials is essential for both modes. Abstraction allows the agent to work identically regardless of storage backend.

**Independent Test**: Run the same storage operations (set, get, delete, query) against both providers, verify identical behavior.

**Acceptance Scenarios**:

1. **Given** the `StorageProvider` interface, **When** I call `set(collection, key, value)` and then `get(collection, key)`, **Then** the stored value is returned correctly
2. **Given** the extension build, **When** storage is initialized, **Then** `IndexedDBStorageProvider` is used
3. **Given** the native build, **When** storage is initialized, **Then** `SQLiteStorageProvider` is used with the database at `~/.pi/data/pi.db`

---

### User Story 7 - Native Terminal Tool (Priority: P2)

As a PI user, I want to ask the agent to run terminal commands on my computer, so that I can automate command-line tasks through natural language.

**Why this priority**: Terminal access is a key differentiator for the native app, enabling automation beyond browser tasks.

**Independent Test**: In the PI app, ask the agent to run `ls` or `dir`, verify the command output is returned in the response.

**Acceptance Scenarios**:

1. **Given** PI is running in native mode, **When** the agent calls `terminal_execute` tool, **Then** the command runs in a shell and output is captured
2. **Given** a dangerous command pattern (e.g., `rm -rf /`), **When** the agent attempts to execute it, **Then** the command is blocked by the security filter
3. **Given** a command requiring sudo, **When** the agent attempts to execute it, **Then** the user is prompted for explicit approval

---

### User Story 8 - Native Browser Control with Session Preservation (Priority: P2)

As a PI user, I want the native agent to control Chrome with all my login sessions preserved, so that I don't need to re-authenticate on every website.

**Why this priority**: Seamless browser control with existing logins is critical for practical browser automation tasks.

**Independent Test**: Launch PI, ask it to navigate to a site where you're normally logged in, verify your session is active without needing to log in.

**Acceptance Scenarios**:

1. **Given** Chrome has remote debugging enabled via `chrome://inspect/#remote-debugging`, **When** PI requests connection, **Then** Chrome shows a permission dialog and PI connects to the user's actual Chrome with all sessions intact
2. **Given** Chrome DevTools MCP is unavailable, **When** PI detects an existing Chrome debug port (9222), **Then** it connects to that instance
3. **Given** no debug connection is available, **When** PI falls back to profile-copy, **Then** it copies essential profile data, launches Chrome with debugging, and connects with preserved sessions
4. **Given** all browser connection methods fail, **When** PI starts, **Then** it operates in degraded mode with browser tools disabled but other tools (terminal, MCP) functional

---

### User Story 9 - WebSocket Remote Control API (Priority: P2)

As a developer, I want to send tasks to PI via WebSocket and receive streaming events, so that I can integrate PI with external applications and scripts.

**Why this priority**: Remote control enables automation, scripting, and integration with other tools - expanding PI's utility beyond direct interaction.

**Independent Test**: Connect a WebSocket client to `ws://localhost:8765`, send a UserTurn submission, receive TaskStarted, AssistantTextDelta, and TaskComplete events.

**Acceptance Scenarios**:

1. **Given** PI is running with WebSocket enabled, **When** a client connects, **Then** it receives a `connected` message with client ID
2. **Given** a connected client, **When** it sends a `submission` message with a `UserTurn` op, **Then** the agent processes the task
3. **Given** the agent is processing, **When** it generates responses, **Then** `EventMsg` events are streamed to the connected client

---

### User Story 10 - MCP Server Integration (Priority: P3)

As a PI user, I want the agent to use tools from MCP servers (filesystem, git, etc.), so that I have extensible capabilities beyond built-in tools.

**Why this priority**: MCP support enables a rich ecosystem of tools without modifying PI's core code.

**Independent Test**: Configure a filesystem MCP server in config, ask the agent to read a file, verify it uses the MCP tool.

**Acceptance Scenarios**:

1. **Given** MCP servers are configured in `~/.pi/config.yaml`, **When** PI starts, **Then** it connects to configured servers and discovers their tools
2. **Given** an MCP tool is available, **When** the agent decides to use it, **Then** the tool call is routed through the MCP client
3. **Given** an MCP server becomes unavailable, **When** the agent tries to use its tools, **Then** a graceful error is returned

---

### Edge Cases

- What happens when user denies Chrome DevTools MCP permission dialog? (Fall back to profile-copy strategy, inform user of alternative)
- What happens when Chrome doesn't have remote debugging enabled? (Prompt user to enable it at `chrome://inspect/#remote-debugging`, or fall back to profile-copy)
- What happens when Chrome profile is locked by the user's running Chrome instance? (Retry with backoff, skip locked files, warn user - only applies to profile-copy fallback)
- What happens when CDP connection drops mid-operation? (Auto-reconnect, retry operation up to 3 times)
- What happens when an MCP server takes too long to respond? (Timeout after configured limit, return error to agent)
- What happens when user starts both extension and native app simultaneously? (They operate independently - no conflict expected)
- What happens when storage migration fails? (Preserve original data, log error, prompt user for manual intervention)
- What happens when all browser connection methods fail? (Graceful degradation - PI works with terminal/MCP/file tools, browser tools disabled)

## Requirements *(mandatory)*

### Functional Requirements

**Code Structure**
- **FR-001**: System MUST organize code into `src/core/` (shared), `src/extension/` (Chrome-specific), and `src/desktop/` (native-specific) directories
- **FR-002**: Build system MUST produce separate outputs for extension and native app from the same source
- **FR-003**: Build system MUST define `__BUILD_MODE__` constant as 'extension' or 'native' at compile time

**Browser Control Abstraction**
- **FR-004**: System MUST define a `BrowserController` interface with methods: navigate, click, type, screenshot, evaluate, getSnapshot
- **FR-005**: System MUST implement `ExtensionBrowserController` using `chrome.debugger` API
- **FR-006**: System MUST implement `CDPBrowserController` using `puppeteer-core` for CDP connection
- **FR-007**: System MUST define a `DebuggerClient` interface for low-level CDP command abstraction
- **FR-008**: Existing `DomService` MUST work with both `DebuggerClient` implementations without modification

**Browser Connection Strategy (Native)**
- **FR-009**: Native mode MUST attempt Chrome DevTools MCP auto-connect as the primary browser control method (requires user to enable `chrome://inspect/#remote-debugging`)
- **FR-009a**: If auto-connect fails, system MUST check for existing Chrome instance with debugging port open (localhost:9222)
- **FR-009b**: If no debug port available, system MUST fall back to profile-copy strategy: copy essential Chrome profile data (Cookies, Login Data, Local Storage, Preferences) to `~/.pi/chrome-profile/` and launch Chrome with `--remote-debugging-port`
- **FR-010**: Profile copy (when used as fallback) MUST skip large non-essential data (Cache, History, GPUCache) to keep copy time under 20 seconds
- **FR-011**: System MUST detect installed browsers (Chrome, Edge on Windows, Chromium on Linux) and use appropriate one
- **FR-012**: System MUST handle file locking gracefully with retry logic on Windows
- **FR-012a**: If browser connection fails entirely, system MUST operate in graceful degradation mode (terminal, MCP, file tools work; browser tools disabled)

**Channel Architecture**
- **FR-013**: System MUST define `ChannelAdapter` interface with methods: initialize, shutdown, onSubmission, sendEvent, and capability checks
- **FR-014**: System MUST implement `ChannelManager` to route submissions to agent and dispatch events to channels
- **FR-015**: Extension MUST implement `SidePanelChannel` and `TabPageChannel` adapters
- **FR-016**: Native app MUST implement `TauriChannel` and `WebSocketChannel` adapters
- **FR-017**: WebSocket channel MUST listen on configurable port (default 8765) for remote control
- **FR-017a**: WebSocket connections from localhost MUST be allowed without authentication; connections from non-localhost addresses MUST require API key authentication

**Storage Abstraction**
- **FR-018**: System MUST define `StorageProvider` interface with CRUD, query, and transaction operations
- **FR-019**: Extension MUST use `IndexedDBStorageProvider` with `idb` library
- **FR-020**: Native app MUST use `SQLiteStorageProvider` with `better-sqlite3`
- **FR-021**: Credentials MUST be stored securely: `chrome.storage.local` for extension, OS keychain via `keytar` for native

**Native Tools**
- **FR-022**: Native mode MUST provide `terminal_execute` tool for running shell commands
- **FR-023**: Terminal tool MUST implement security layers: blocklist, sudo detection, optional allowlist
- **FR-024**: Native mode MUST implement MCP client for connecting to stdio and HTTP+SSE MCP servers

**Tauri Application**
- **FR-025**: Native app MUST be built with Tauri framework for cross-platform support
- **FR-026**: App MUST display system tray icon and run as background daemon
- **FR-027**: App MUST support global hotkey for quick access (configurable, default Ctrl+Shift+P)

### Key Entities

- **ChannelAdapter**: Interface representing a UI channel that can send submissions and receive events. Key attributes: channelId, channelType, streaming/approval/media capabilities
- **Op (Submission)**: Input message to agent. Types include UserTurn, Interrupt, ExecApproval, PatchApproval, Compact
- **EventMsg**: Output message from agent. Types include TaskStarted, TaskComplete, ToolCall, ToolResult, AssistantText, AssistantTextDelta, RequestApproval
- **BrowserController**: Interface for browser automation. Abstracts over chrome.debugger and CDP implementations
- **DebuggerClient**: Low-level interface for sending CDP commands. Bridges DomService to platform-specific debugger APIs
- **StorageProvider**: Interface for persistent storage. Abstracts over IndexedDB (extension) and SQLite (native)
- **Session**: Maintains conversation state, history, and tool usage statistics across turns
- **ChannelManager**: Orchestrator that routes submissions to agent and dispatches events to appropriate channels

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Chrome extension builds and passes all existing tests with no regressions
- **SC-002**: Native app builds successfully for Windows, macOS, and Linux from single codebase
- **SC-003**: Chrome DevTools MCP auto-connect completes in under 3 seconds; profile-copy fallback completes in under 20 seconds for typical profiles
- **SC-004**: Browser automation tasks complete successfully with user's login sessions preserved (via auto-connect or profile-copy)
- **SC-005**: WebSocket API supports at least 10 concurrent client connections without performance degradation
- **SC-006**: All shared core code has zero direct dependencies on platform-specific APIs (chrome.*, Tauri-specific)
- **SC-007**: Build size: Extension under 5MB, Native app installer under 30MB
- **SC-008**: Native app starts and connects to Chrome within 5 seconds via auto-connect, or within 30 seconds when using profile-copy fallback

## Assumptions

- Users have Chrome (or Edge on Windows, Chromium on Linux) installed on their system
- Users run PI under the same OS user account that owns their Chrome profile
- For native mode, users are willing to have a separate Chrome instance managed by PI
- MCP servers referenced in configuration are available and respond within reasonable timeouts
- The existing SQ/EQ (Submission Queue/Event Queue) pattern in the codebase is suitable for multi-channel communication

## Dependencies

- Existing BrowserX extension codebase and architecture
- Design document: `.ai_design/desktop_app_design.md`
- Tauri v1.x framework
- puppeteer-core for CDP browser control
- better-sqlite3 for native storage
- keytar for OS keychain access
- @anthropic/sdk for MCP client implementation
