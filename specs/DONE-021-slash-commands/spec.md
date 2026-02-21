# Feature Specification: Slash Command System

**Feature Branch**: `021-slash-commands`
**Created**: 2026-02-16
**Status**: Draft
**Input**: User description: "Bring the slash command framework to the agent (for both Chrome extension and desktop app) like Claude Code agent. Implements an extensible slash command system for the side panel."

## Clarifications

### Session 2026-02-16

- Q: Should commands support arguments/parameters, or are they strictly zero-argument actions? → A: Optional string argument — commands receive the text after the command name as a single raw string. Each command decides how to interpret or ignore it (mirrors Claude Code's approach).
- Q: Which built-in commands should ship in v1 beyond "/new"? → A: Three built-in commands: `/new` (reset conversation), `/help` (list all available commands with descriptions), `/settings` (open the settings panel).
- Q: How should command filtering work when the user types after "/"? → A: Prefix match on command name, plus substring match on description. E.g., `/he` matches `/help` by name prefix; typing `reset` matches `/new` via its description containing "reset".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Execute a Slash Command (Priority: P1)

A user wants to quickly perform a common action (e.g., start a new conversation) without navigating menus or clicking buttons. They type "/" into the empty input field, see available commands, select one, and the action executes immediately.

**Why this priority**: This is the core value proposition — enabling quick keyboard-driven actions. Without command execution, no other feature matters.

**Independent Test**: Can be fully tested by typing "/" into an empty input, selecting "/new" from the dropdown, pressing Enter, and verifying the conversation resets. Delivers immediate value by replacing multi-click workflows with a single command.

**Acceptance Scenarios**:

1. **Given** the input field is empty and focused, **When** the user types "/", **Then** a dropdown appears showing all available commands with their descriptions.
2. **Given** the command dropdown is visible, **When** the user types "new" after the slash, **Then** the dropdown filters to show only matching commands (e.g., "/new").
3. **Given** a command is highlighted in the dropdown, **When** the user presses Enter, **Then** the command executes and the input field is cleared.
4. **Given** the user types "/new" and presses Enter (without using the dropdown), **When** the command is valid, **Then** the command executes directly.
5. **Given** the user types "/commandname some extra text" and presses Enter, **When** the command is valid, **Then** the command executes and receives "some extra text" as its argument string.
6. **Given** a command was just executed, **When** the user attempts the same command again within 500 milliseconds, **Then** the duplicate execution is prevented (debounced).

---

### User Story 2 - Navigate Commands with Keyboard (Priority: P2)

A power user wants to browse and select commands entirely via keyboard without reaching for the mouse. They use arrow keys to navigate the dropdown and Enter/Escape to confirm or dismiss.

**Why this priority**: Keyboard navigation is essential for the "quick actions without mouse interaction" goal. It makes the command system feel native and efficient.

**Independent Test**: Can be fully tested by typing "/", using Up/Down arrow keys to move through the list, verifying visual highlight changes, pressing Enter to execute, or pressing Escape to dismiss. Delivers value by enabling fully keyboard-driven command selection.

**Acceptance Scenarios**:

1. **Given** the command dropdown is visible, **When** the user presses the Down Arrow key, **Then** the next command in the list is highlighted.
2. **Given** the command dropdown is visible, **When** the user presses the Up Arrow key, **Then** the previous command in the list is highlighted.
3. **Given** the first command is highlighted, **When** the user presses Up Arrow, **Then** the highlight wraps to the last command.
4. **Given** the last command is highlighted, **When** the user presses Down Arrow, **Then** the highlight wraps to the first command.
5. **Given** the command dropdown is visible, **When** the user presses Escape, **Then** the dropdown closes and the input field retains focus with its current text.

---

### User Story 3 - Navigate Commands with Mouse (Priority: P3)

A casual user prefers mouse interaction. They type "/" to open the dropdown, hover over commands to see them highlighted, and click to execute.

**Why this priority**: Mouse support broadens accessibility and supports users who prefer point-and-click interaction. Less critical than keyboard flow but important for completeness.

**Independent Test**: Can be fully tested by typing "/", hovering over commands to see highlight changes, clicking a command, and verifying execution. Delivers value by providing an intuitive visual interaction model.

**Acceptance Scenarios**:

1. **Given** the command dropdown is visible, **When** the user hovers over a command, **Then** that command is visually highlighted.
2. **Given** a command is highlighted by hover, **When** the user clicks on it, **Then** the command executes and the dropdown closes.
3. **Given** the user has navigated via keyboard, **When** they hover over a different command with the mouse, **Then** the highlight moves to the hovered command.

---

### User Story 4 - See Errors for Invalid Commands (Priority: P3)

A user types an unrecognized command (e.g., "/foobar") and presses Enter. Instead of the system silently failing or sending the text as a chat message, a clear inline error message appears briefly above the input field.

**Why this priority**: Error feedback prevents confusion and teaches users the available command vocabulary. It's important for usability but not the core flow.

**Independent Test**: Can be fully tested by typing "/foobar" and pressing Enter, verifying an error message appears above the input indicating the command is unknown, and confirming the error auto-dismisses after 60 seconds.

**Acceptance Scenarios**:

1. **Given** the user types "/foobar" (an unrecognized command), **When** they press Enter, **Then** an inline error message appears above the input field stating the command is not recognized.
2. **Given** an error message is displayed, **When** 60 seconds have elapsed, **Then** the error message automatically dismisses.
3. **Given** an error message is displayed, **When** the user starts typing a new message, **Then** the error message dismisses immediately.

---

### User Story 5 - Add New Commands via Registration (Priority: P3)

A developer wants to extend the command system by adding a new slash command (e.g., "/help", "/settings"). They register the command with a name, description, and action, requiring minimal code.

**Why this priority**: Extensibility ensures long-term value and enables future features. Less urgent for initial delivery but foundational for the system's architecture.

**Independent Test**: Can be fully tested by registering a new command with a name, description, and callback, then verifying it appears in the dropdown and executes correctly when invoked.

**Acceptance Scenarios**:

1. **Given** a developer registers a new command with a name and description, **When** the user types "/" in the input field, **Then** the new command appears in the dropdown list.
2. **Given** a developer registers a command with duplicate name, **When** registration is attempted, **Then** the system prevents duplicate registration and signals an error.

---

### Edge Cases

- What happens when the user types "/" in a non-empty input field (e.g., "hello /")?
  - The system does NOT trigger command detection. The "/" is treated as normal text input.
- What happens when the user types "/" and then deletes it?
  - The dropdown closes immediately when the "/" is removed.
- What happens when the user types "/" followed by text that doesn't match any command, without pressing Enter?
  - The dropdown shows a "no matching commands" state or remains empty.
- What happens when the user pastes "/new" into the input field?
  - Command detection triggers on paste if the field was empty before paste and the pasted content starts with "/".
- What happens when the input field loses focus while the dropdown is open?
  - The dropdown closes.
- What happens when the user types "/" while a message is being processed (agent is responding)?
  - Command detection still triggers normally; commands are independent of conversation state.
- What happens on both Chrome extension and desktop app?
  - The slash command system works identically on both platforms. No platform-specific behavior differences.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST detect the "/" character as a command trigger ONLY when typed as the first character in an empty input field.
- **FR-002**: System MUST display a dropdown of available commands when command mode is triggered.
- **FR-003**: System MUST support real-time filtering of commands as the user types after the initial "/", using prefix matching on the command name and substring matching on the command description (both case-insensitive).
- **FR-004**: System MUST support keyboard navigation of the command dropdown using Up Arrow, Down Arrow, Enter, and Escape keys.
- **FR-005**: System MUST support mouse interaction with the command dropdown (hover to highlight, click to execute).
- **FR-006**: System MUST execute the selected command and clear the input field upon confirmation (Enter key or mouse click).
- **FR-007**: System MUST display an inline error message above the input field when an unrecognized command is submitted.
- **FR-008**: System MUST auto-dismiss error messages after 60 seconds.
- **FR-009**: System MUST dismiss error messages immediately when the user begins typing new input.
- **FR-010**: System MUST prevent rapid re-execution of the same command within a 500ms debounce window.
- **FR-011**: System MUST provide a command registration mechanism that allows new commands to be added with a name, description, optional argument hint, and action.
- **FR-012**: System MUST perform case-insensitive command matching (e.g., "/New" and "/new" are equivalent).
- **FR-013**: System MUST include the built-in "/new" command that resets the current conversation.
- **FR-023**: System MUST include the built-in "/help" command that displays a list of all registered commands with their names, descriptions, and argument hints (if defined).
- **FR-024**: System MUST include the built-in "/settings" command that opens the settings panel.
- **FR-014**: System MUST close the command dropdown when the input field loses focus.
- **FR-015**: System MUST close the command dropdown when the "/" character is deleted from the input.
- **FR-016**: System MUST work identically on both Chrome extension and desktop app platforms.
- **FR-017**: System MUST position the command dropdown adaptively (above or below the input) based on available screen space.
- **FR-018**: System MUST prevent duplicate command registration (same command name cannot be registered twice).
- **FR-019**: System MUST NOT intercept "/" characters typed into non-empty input fields, preserving normal text input for URLs and file paths.
- **FR-020**: System MUST parse user input as `/commandname [optional argument string]`, splitting on the first space to extract the command name and passing the remainder (if any) as a single raw argument string to the command's action.
- **FR-021**: System MUST allow commands to define an optional argument hint (e.g., "[issue-number]", "[query]") that is displayed alongside the command name in the dropdown to indicate expected input.
- **FR-022**: Commands that do not use arguments MUST silently ignore any trailing text provided by the user.

### Key Entities

- **Command**: A registered action with a unique name (string), human-readable description, optional argument hint (string describing expected input), and an executable action that receives an optional raw argument string. Commands are case-insensitive and globally available across the application.
- **Command Registry**: A centralized collection of all registered commands. Provides lookup by name, listing of all commands, and registration of new commands. Exists as a single shared instance.
- **Command Dropdown**: A visual list of available commands shown to the user during command entry. Supports filtering, highlighting, and selection. Positioned relative to the input field.
- **Error Message**: A transient notification displayed above the input field when a command fails or is unrecognized. Auto-dismisses after a timeout or on user interaction.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can invoke a slash command from empty input to completed action in under 2 seconds (including dropdown render, selection, and execution).
- **SC-002**: Command detection responds to the "/" keystroke with no perceptible delay (user perceives instant response).
- **SC-003**: The command dropdown renders and is interactive within a fraction of a second of the "/" keystroke.
- **SC-004**: Adding a new command to the system requires fewer than 10 lines of registration code.
- **SC-005**: 100% of built-in commands work identically on both Chrome extension and desktop app platforms without platform-specific workarounds.
- **SC-006**: Users can complete command selection using only the keyboard (no mouse required) with standard navigation conventions (arrows, Enter, Escape).
- **SC-007**: Invalid commands produce clear, user-friendly error messages that explain what went wrong.
- **SC-008**: The slash command system does not interfere with normal text input containing "/" characters (e.g., URLs, file paths, mid-sentence slashes).

## Assumptions

- The existing input field component will be enhanced rather than replaced. The current Enter-to-send and Shift+Enter-for-newline behavior is preserved for normal messages.
- The "/new" command reuses the existing conversation reset functionality already available in the application.
- The command system is client-side only — no server-side processing or persistence of commands is required.
- The command dropdown follows the application's existing visual theme (terminal theme or ChatGPT theme as configured by the user).
- Commands execute synchronously from the user's perspective (the action may trigger async operations, but the command itself resolves immediately).
- The debounce window of 500ms applies per-command (different commands can be executed in rapid succession).
