# Feature Specification: Tab Manager Refactoring

**Feature Branch**: `001-tab-manager`
**Created**: 2025-11-12
**Status**: Draft
**Input**: User description: "Improve the tab managing process.
1. TabBindingManager should be indepedent from BrowserAgent, its initialize should be in service worker level, and BrowserAgent is the one using TabBindingManager to bind related agent to target tab
2. Rename TabBindingManager to TabManager instead
3. When the session first created, the default tabId is the current active tab (if no active tab available, leave the tabId -1)
4. if the tabId currently is -1, TabBindingManager should be take care of create a new tab and bind the new created tabId to the session. The timing of creating the new tab when user send a message to agent while agent realize the current session associated tab id is -1, it call the TabManager to create a new tab tab
5. Split text area into a indepdent component named MessageInput.svelte and make it contain TabContext.svelte
6. In TabContext.svelte, we should allow it to be clicked, when it is clicked, it should pop up a tab selection list which list out all the opened tab currently in browser for user to select a tab to connect to the agent. The selection should have \"new tab\" is item which will turn the tabId to -1 to trigger the TabManager to create a new tab
7. Let's currently don't expose Tab Tool to LLM (the agent take care of create a tab for llm to work on instead of llm need to create a tab)
8. Merge the src/tools/tab/TabGroupManager.ts logic into TabManager and delete it.
9. TabGroup should always check if \"browserx\" group already exist, if exists, reuse the existing one, otherwise, create a new tab group named \"browserx\", then add all the tabs that connect to sessions to the group."

## Clarifications

### Session 2025-11-12

- Q: When TabManager creates a new tab (FR-007, User Story 2), what URL should the new tab initially load? → A: Start with a blank page (about:blank), letting the agent navigate as needed
- Q: When a user clicks TabContext to open the tab selection dropdown (User Story 3), what should happen when the user clicks outside the dropdown menu? → A: Close the menu without making any changes (standard dropdown behavior)
- Q: When a session previously had a tab bound (tabId = 123), but that tab was closed or the binding was lost to another session (last-write-wins), should the system attempt to automatically rebind to a new tab on the next user message? → A: No, keep tabId = -1 and require explicit user action via tab selection menu

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic Tab Assignment on Session Creation (Priority: P1)

When a user creates a new session, the system automatically assigns the currently active browser tab to that session, allowing the agent to immediately interact with the page the user is viewing without requiring manual tab selection.

**Why this priority**: This is the foundation of improved user experience - users expect the agent to work with their current tab by default, eliminating friction in starting a new session.

**Independent Test**: Can be fully tested by creating a new session while a browser tab is active and verifying that the session's tabId matches the active tab's ID. If no active tab exists, verifying tabId is set to -1.

**Acceptance Scenarios**:

1. **Given** a browser window with an active tab (ID: 123), **When** a user creates a new session, **Then** the session is initialized with tabId = 123
2. **Given** no active tab is available, **When** a user creates a new session, **Then** the session is initialized with tabId = -1
3. **Given** multiple browser windows with active tabs, **When** a user creates a new session, **Then** the session is bound to the active tab in the focused window

---

### User Story 2 - Automatic Tab Creation on First Message (Priority: P1)

When a user sends their first message to an agent that has no tab assigned (tabId = -1), the system automatically creates a new browser tab and binds it to the session, ensuring the agent always has a working context.

**Why this priority**: Essential for handling cases where no active tab exists or the user explicitly chose "new tab". Without this, agents cannot operate.

**Independent Test**: Can be fully tested by creating a session with tabId = -1, sending a message, and verifying a new tab is created and bound to the session before the agent processes the message.

**Acceptance Scenarios**:

1. **Given** a session with tabId = -1, **When** the user sends a message, **Then** a new browser tab is created with about:blank URL and bound to the session before agent processing begins
2. **Given** a newly created tab, **When** bound to a session, **Then** the tab is added to the "browserx" tab group
3. **Given** a session with tabId = -1, **When** tab creation fails, **Then** the user receives an error message and the message is not sent to the agent

---

### User Story 3 - Manual Tab Selection via UI (Priority: P2)

Users can click on the tab context display to open a selection menu showing all currently open browser tabs, allowing them to manually switch the agent to work with a different tab or create a new one.

**Why this priority**: Provides flexibility for users to redirect agent attention to different tabs, but not critical for basic operation since automatic tab assignment handles most cases.

**Independent Test**: Can be fully tested by clicking the TabContext component, verifying the tab list appears with all open tabs, selecting a tab, and confirming the session's tabId updates to the selected tab.

**Acceptance Scenarios**:

1. **Given** a session with an active tab binding, **When** the user clicks the tab context display, **Then** a dropdown menu appears showing all open browser tabs with their titles
2. **Given** the tab selection menu is open, **When** the user selects a different tab, **Then** the session's tabId is updated to the selected tab ID and the previous tab is unbound
3. **Given** the tab selection menu is open, **When** the user selects "New Tab", **Then** the session's tabId is set to -1, triggering automatic tab creation on the next message
4. **Given** multiple tabs in different windows, **When** the tab selection menu opens, **Then** all tabs across all windows are displayed with window information
5. **Given** the tab selection menu is open, **When** the user clicks outside the menu, **Then** the menu closes and the current tab binding remains unchanged

---

### User Story 4 - Unified Tab Group Management (Priority: P2)

All tabs created or used by BrowserX agents are automatically added to a single "browserx" tab group, making it easy for users to identify and manage agent-related tabs visually in their browser.

**Why this priority**: Improves user experience through better organization, but the core functionality works without grouping.

**Independent Test**: Can be fully tested by creating multiple sessions with different tabs, then verifying all bound tabs belong to the same "browserx" tab group with consistent color and title.

**Acceptance Scenarios**:

1. **Given** no "browserx" tab group exists, **When** the first tab is bound to a session, **Then** a new tab group named "browserx" is created with blue color
2. **Given** a "browserx" tab group already exists, **When** a new tab is bound to a session, **Then** the tab is added to the existing group without creating a duplicate
3. **Given** a tab is added to the "browserx" group, **When** the tab is unbound from all sessions, **Then** the tab remains in the group (manual removal by user)
4. **Given** the browser is restarted, **When** sessions are restored, **Then** the existing "browserx" tab group is reused for newly bound tabs

---

### User Story 5 - Service Worker Level Initialization (Priority: P3)

The TabManager is initialized at the service worker level independently from individual agent instances, ensuring tab management state persists across agent lifecycles and multiple concurrent sessions can share the same tab management infrastructure.

**Why this priority**: Architectural improvement that enables better scalability and consistency, but doesn't directly impact single-session user workflows.

**Independent Test**: Can be fully tested by initializing the service worker, creating multiple agent instances, and verifying they all share the same TabManager singleton instance and state.

**Acceptance Scenarios**:

1. **Given** the service worker starts, **When** TabManager is initialized, **Then** it exists as a singleton independent of any agent instances
2. **Given** multiple BrowserAgent instances, **When** they request TabManager, **Then** all instances share the same TabManager singleton
3. **Given** an agent is terminated, **When** a new agent is created, **Then** the TabManager retains all existing tab bindings
4. **Given** concurrent sessions, **When** each binds to different tabs, **Then** TabManager maintains separate bindings without conflicts

---

### User Story 6 - Component Restructuring for MessageInput (Priority: P3)

The message input area is extracted into an independent MessageInput.svelte component that contains the TabContext.svelte component, improving code organization and reusability.

**Why this priority**: Code quality improvement that makes the UI more maintainable but doesn't change user-facing functionality.

**Independent Test**: Can be fully tested by rendering the MessageInput component in isolation and verifying it displays TabContext and handles message submission correctly.

**Acceptance Scenarios**:

1. **Given** the MessageInput component is rendered, **When** the component loads, **Then** it displays the TabContext component showing the current tab information
2. **Given** a user types in the MessageInput field, **When** they press Enter, **Then** the onSubmit callback is invoked with the message text
3. **Given** the MessageInput component, **When** the session's tabId changes, **Then** the embedded TabContext automatically updates to reflect the new tab

---

### Edge Cases

- What happens when the active tab is closed after being bound to a session? (Session's tabId should be reset to -1; user must explicitly rebind via tab selection menu or send a message to trigger new tab creation)
- How does the system handle permission-restricted tabs (e.g., chrome:// URLs)? (Display error message, allow user to select a different tab)
- What happens when a user attempts to bind two sessions to the same tab? (Last-write-wins: the new session takes ownership, previous session's tabId is reset to -1; user must explicitly rebind the previous session via tab selection menu)
- How does the system handle tab creation failure (e.g., browser limits)? (Display error to user, keep session's tabId as -1)
- What happens when the "browserx" tab group is manually deleted by the user? (Recreate group automatically on next tab binding)
- How does manual tab selection handle tabs in different browser windows? (Display all tabs with window context, allow cross-window selection)
- What happens when the service worker is restarted while sessions are active? (TabManager reinitializes, reuses existing "browserx" group, sessions maintain their tabId values)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST rename TabBindingManager to TabManager across the entire codebase
- **FR-002**: System MUST initialize TabManager at the service worker level before any agent instances are created
- **FR-003**: System MUST implement TabManager as a singleton pattern accessible to all agent instances
- **FR-004**: When a session is created, system MUST attempt to retrieve the currently active browser tab
- **FR-005**: When a session is created with an active tab available, system MUST set the session's tabId to the active tab's ID
- **FR-006**: When a session is created with no active tab available, system MUST set the session's tabId to -1
- **FR-007**: When a user sends a message to a session with tabId = -1, TabManager MUST create a new browser tab before message processing begins
- **FR-007a**: When TabManager creates a new tab, the tab MUST initially load about:blank to provide a neutral starting state
- **FR-008**: When TabManager creates a new tab, system MUST bind the new tab's ID to the session
- **FR-009**: TabManager MUST merge all functionality from TabGroupManager into its implementation
- **FR-010**: System MUST delete the TabGroupManager.ts file after migration is complete
- **FR-011**: When binding a tab to a session, TabManager MUST check if a "browserx" tab group exists
- **FR-012**: If "browserx" tab group exists, TabManager MUST add the tab to the existing group
- **FR-013**: If "browserx" tab group does not exist, TabManager MUST create a new group named "browserx" with blue color
- **FR-014**: System MUST create a new MessageInput.svelte component as an independent UI component
- **FR-015**: MessageInput component MUST contain the TabContext.svelte component
- **FR-016**: MessageInput component MUST handle user text input and submission
- **FR-017**: TabContext component MUST be clickable and respond to user clicks
- **FR-018**: When TabContext is clicked, system MUST display a dropdown menu listing all currently open browser tabs
- **FR-019**: Tab selection menu MUST include each tab's title and URL information
- **FR-020**: Tab selection menu MUST include a "New Tab" option at the top or bottom of the list
- **FR-021**: When user selects a tab from the menu, system MUST update the session's tabId to the selected tab's ID
- **FR-022**: When user selects "New Tab", system MUST set the session's tabId to -1
- **FR-022a**: When the tab selection menu is open and user clicks outside the menu, system MUST close the menu without changing the current tab binding
- **FR-023**: System MUST NOT expose TabTool to the LLM's available tools list
- **FR-024**: When a tab bound to a session is closed, system MUST reset the session's tabId to -1
- **FR-024a**: When a session's tabId is reset to -1 due to tab closure or binding loss, system MUST NOT automatically rebind to a different tab without explicit user action
- **FR-025**: When multiple sessions attempt to bind to the same tab, TabManager MUST implement last-write-wins logic
- **FR-026**: TabManager MUST handle tab creation failures gracefully with error reporting
- **FR-027**: Tab selection menu MUST display tabs from all browser windows, not just the active window

### Key Entities

- **TabManager**: Singleton manager that handles all tab lifecycle operations, including binding tabs to sessions, creating new tabs, managing the "browserx" tab group, and tracking tab-to-session mappings. Replaces both TabBindingManager and TabGroupManager.
- **Session**: Represents an agent conversation session with a tabId property (number) that indicates the bound tab (-1 means no tab, positive numbers are valid tab IDs).
- **TabBinding**: A mapping between a session ID and a tab ID, including metadata like tab title, URL, and binding timestamp.
- **TabGroup**: A browser tab group entity named "browserx" that visually organizes all tabs associated with BrowserX sessions.
- **MessageInput**: UI component that captures user message input and displays the current tab context.
- **TabContext**: UI component that displays the current tab information and provides the tab selection interface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a user creates a new session with an active browser tab, the session is bound to that tab within 100ms
- **SC-002**: When a user sends a message to a session with no tab (tabId = -1), a new tab is created and bound within 500ms before agent processing begins
- **SC-003**: 95% of sessions are automatically assigned a valid tab without requiring manual user selection
- **SC-004**: All tabs used by BrowserX agents appear in a single "browserx" tab group, improving visual organization
- **SC-005**: Users can switch an agent's target tab within 3 seconds using the tab selection menu
- **SC-006**: The tab selection menu displays all open tabs (across all windows) within 200ms of being opened
- **SC-007**: Zero instances of TabTool being exposed to LLM agents (agents rely on automatic tab management)
- **SC-008**: System handles tab closure events within 100ms, preventing agents from attempting operations on closed tabs
- **SC-009**: When multiple sessions attempt to bind to the same tab, the system resolves conflicts within 50ms using last-write-wins logic
- **SC-010**: The refactored architecture reduces tab management code duplication by eliminating TabGroupManager (estimated 360 lines merged into TabManager)

## Assumptions

1. The service worker has necessary permissions to access and create browser tabs
2. The chrome.tabs API is available and functional in the extension environment
3. Users have at least one browser window open (edge case of zero windows is handled by creating a new window)
4. The existing TabContext.svelte component's display logic can be preserved while adding click interaction
5. The current TerminalInput.svelte usage will be replaced by MessageInput.svelte without breaking existing functionality
6. BrowserAgent instances are created after the service worker initialization completes
7. Tab group functionality is supported in the target Chromium-based browsers
8. Existing tests for TabBindingManager can be adapted to TabManager with minimal changes
9. The session persistence mechanism already includes tabId serialization

## Dependencies

- Chrome Extensions API (chrome.tabs, chrome.tabGroups, chrome.windows)
- Existing TabBindingManager implementation as the foundation for TabManager
- Existing TabGroupManager implementation to be merged into TabManager
- SessionState class that stores and manages the tabId property
- Existing TabContext.svelte component to be enhanced with click interaction
- Service worker lifecycle management to ensure TabManager initializes before agent instances

## Out of Scope

- Cross-browser support for non-Chromium browsers (Firefox, Safari)
- Syncing tab bindings across multiple devices or browser profiles
- Advanced tab management features like tab pinning, tab reordering, or tab snapshots
- History or undo functionality for tab binding changes
- Permissions management UI for restricted tabs (chrome://, file://, etc.)
- Tab search or filtering in the selection menu (basic list only)
- Custom tab group colors or names per session (all use single "browserx" group)
- Tab session persistence across browser restarts (sessions restart with tabId = -1)
- Multi-tab binding (one session per tab limit remains)
