# Feature Specification: Multi-Agent Instances for Parallel Task Execution

**Feature Branch**: `015-multi-agent-instances`
**Created**: 2026-02-02
**Status**: Draft
**Input**: User description: "Currently the service worker only creates one agent instance, which may cause scheduled task and side panel task (user currently actively working on) execution conflict. We should allow multi-agent instances to be running under service worker."

## Problem Statement

The current browserx architecture uses a **singleton BrowserxAgent pattern** in the service worker. This creates conflicts when:

1. A user is actively chatting with the agent in the side panel
2. A scheduled task fires and needs to execute simultaneously
3. Multiple browser tabs need independent agent sessions

**Current Architecture Issues:**
- Single `agent` instance in service-worker.ts (global variable)
- Session has one `tabId` binding, overwritten on new tasks
- Sequential submission queue blocks concurrent operations
- Scheduled tasks share context with active user conversation
- Tab binding conflicts when switching between tasks

## Clarifications

### Session 2026-02-02

- Q: What lifecycle states should a session have? → A: 4 states: `initializing` (session being created), `active` (task running), `idle` (awaiting input), `terminated` (session ended). Note: Tasks within a session have their own lifecycle; session states apply to the session container, not individual tasks.
- Q: What happens when a session's bound tab is closed during execution? → A: Terminate session immediately and mark the task as failed.
- Q: What is the default maximum concurrent session limit? → A: Default 3 (1 user session + 2 scheduled tasks or edge cases), configurable by user.
- Q: How to visually distinguish tabs belonging to different sessions? → A: Each session gets its own Chrome tab group with naming convention `browserx_s_<letter>` (e.g., `browserx_s_a`, `browserx_s_b`, `browserx_s_c`). Tab groups can also have distinct colors for additional visual distinction.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Scheduled Task Runs Without Interrupting Active Session (Priority: P1)

A user is actively chatting with the AI agent in the side panel when a scheduled task fires. The scheduled task should execute in its own isolated session without interfering with the user's active conversation.

**Why this priority**: This is the core problem - scheduled tasks and active sessions currently conflict. Solving this unblocks the scheduler feature.

**Independent Test**: Can be fully tested by starting a conversation in the side panel, scheduling a task for 1 minute later, continuing the conversation, and verifying both complete successfully without interference.

**Acceptance Scenarios**:

1. **Given** a user has an active conversation in the side panel, **When** a scheduled task fires, **Then** the scheduled task executes in a separate agent instance without affecting the active conversation
2. **Given** a scheduled task is executing, **When** the user sends a message in the side panel, **Then** the user's message is processed immediately without waiting for the scheduled task
3. **Given** both a scheduled task and user session are running, **When** either completes, **Then** the other continues unaffected

---

### User Story 2 - Agent Registry Manages Multiple Sessions (Priority: P1)

The system maintains a registry of active agent instances, each identified by a unique session ID. Sessions can be created, retrieved, and cleaned up independently.

**Why this priority**: This is the foundational architecture change required for all other user stories.

**Independent Test**: Can be tested by creating multiple sessions via internal API and verifying each has independent state.

**Acceptance Scenarios**:

1. **Given** no active sessions, **When** a new session is requested, **Then** a new agent instance is created and registered with a unique ID
2. **Given** multiple sessions exist, **When** a session ID is provided, **Then** the correct session is retrieved
3. **Given** a session has completed, **When** cleanup is triggered, **Then** the session is removed from the registry and resources are released

---

### User Story 3 - Independent Tab Binding Per Session (Priority: P2)

Each agent session manages its own tab binding independently, preventing tab switching conflicts between sessions.

**Why this priority**: Tab binding conflicts are a major source of issues with the current design, but solving P1 stories first provides the foundation.

**Independent Test**: Can be tested by opening two tabs, starting sessions in each, and verifying each session operates only on its bound tab.

**Acceptance Scenarios**:

1. **Given** Session A is bound to Tab 1 and Session B is bound to Tab 2, **When** Session A performs a tab operation, **Then** only Tab 1 is affected
2. **Given** a session is bound to a tab, **When** that tab is closed, **Then** only that session receives the tab closed event
3. **Given** multiple sessions with different tab bindings, **When** a tool executes, **Then** it operates on the correct session's bound tab

---

### User Story 4 - Session Persistence and Resumption (Priority: P2)

Sessions can be persisted to storage and resumed after service worker restarts or browser restarts, preserving conversation history and state.

**Why this priority**: Important for reliability but not blocking core parallel execution functionality.

**Independent Test**: Can be tested by starting a session, restarting the service worker, and verifying the session can be resumed with its history intact.

**Acceptance Scenarios**:

1. **Given** a session with conversation history, **When** the service worker restarts, **Then** the session can be resumed with full history
2. **Given** a persisted session, **When** resumption is requested, **Then** the session state is restored including conversation context
3. **Given** multiple persisted sessions, **When** the extension loads, **Then** all sessions are available for resumption

---

### User Story 5 - Concurrent Execution Limits (Priority: P3)

The system limits the number of concurrent agent sessions to prevent resource exhaustion, with configurable maximum and proper queueing.

**Why this priority**: Important for stability but can be added after core functionality works.

**Independent Test**: Can be tested by attempting to create more sessions than the limit and verifying proper behavior.

**Acceptance Scenarios**:

1. **Given** the maximum concurrent sessions limit is reached, **When** a new session is requested, **Then** the request is queued or rejected with appropriate feedback
2. **Given** sessions are at capacity, **When** one session completes, **Then** a queued session can start
3. **Given** a configurable limit setting, **When** the setting is changed, **Then** the new limit is enforced

---

### User Story 6 - Session Status Visibility (Priority: P3)

Users can see the status of all active sessions, including which ones are running, idle, or queued.

**Why this priority**: Nice-to-have for user visibility, not blocking core functionality.

**Independent Test**: Can be tested by checking the scheduler popup shows accurate status for multiple running tasks.

**Acceptance Scenarios**:

1. **Given** multiple sessions are active, **When** the user views the scheduler popup, **Then** all session statuses are displayed
2. **Given** a session changes state, **When** the UI is open, **Then** the status updates in real-time
3. **Given** a session is queued due to capacity limits, **Then** the queue position is visible to the user

---

### Edge Cases

- When a session's bound tab is closed while executing → Session terminates immediately, task marked as failed
- How does the system handle service worker termination during active sessions?
- What happens if two sessions try to bind to the same tab?
- How are sessions cleaned up if they become orphaned (no client connected)?
- What happens when storage quota is exceeded while persisting sessions?

## Requirements *(mandatory)*

### Functional Requirements

**Agent Registry**
- **FR-001**: System MUST maintain a registry of active agent instances, keyed by unique session ID
- **FR-002**: System MUST support creating new agent sessions on demand
- **FR-003**: System MUST support retrieving existing sessions by session ID
- **FR-004**: System MUST support removing sessions when they complete or are explicitly closed
- **FR-005**: System MUST broadcast session lifecycle events (created, destroyed) to interested clients

**Session Isolation**
- **FR-006**: Each session MUST have its own conversation history, independent of other sessions
- **FR-007**: Each session MUST have its own tab binding, independent of other sessions
- **FR-008**: Each session MUST have its own model client instance to prevent state conflicts
- **FR-009**: Sessions MUST NOT share mutable state that could cause race conditions

**Concurrent Execution**
- **FR-010**: System MUST support at least 2 concurrent active sessions (user session + scheduled task)
- **FR-011**: System MUST allow sessions to execute operations in parallel without blocking each other
- **FR-012**: System MUST route messages to the correct session based on session ID in the message

**Persistence**
- **FR-013**: System MUST persist session metadata to storage for resumption after restarts
- **FR-014**: System MUST persist conversation history per session
- **FR-015**: System MUST support resuming a session from persisted state

**Resource Management**
- **FR-016**: System MUST enforce a configurable maximum number of concurrent sessions (default: 3)
- **FR-017**: System MUST clean up session resources when sessions are removed
- **FR-018**: System MUST handle service worker termination gracefully, preserving session state

**Scheduler Integration**
- **FR-019**: Scheduler MUST create a new session for each scheduled task execution
- **FR-020**: Scheduler MUST NOT reuse the user's active session for scheduled tasks
- **FR-021**: Scheduled task sessions MUST be independent and not affect user sessions
- **FR-022**: When a session's bound tab is closed, the system MUST terminate that session immediately and mark any running task as failed

### Key Entities

- **AgentRegistry**: Central registry managing all active agent sessions. Tracks sessions by ID, handles creation/destruction, enforces limits.

- **AgentSession**: Wrapper around BrowserxAgent providing session isolation. Contains session ID, agent instance, tab binding, and lifecycle state. Lifecycle states: `initializing` (session being created), `active` (task running), `idle` (awaiting input), `terminated` (session ended).

- **SessionMetadata**: Persisted information about a session including ID, creation time, last activity, conversation ID, and resumption data.

- **SessionConfig**: Configuration for creating a new session including model settings, tool configuration, and optional initial history for resumption.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can continue active conversations while scheduled tasks execute without any interruption or delay
- **SC-002**: System supports at least 2 concurrent sessions executing operations simultaneously
- **SC-003**: Session isolation prevents 100% of state conflicts between concurrent sessions
- **SC-004**: Sessions can be resumed after service worker restart with full conversation history preserved
- **SC-005**: Tab operations in one session never affect tabs bound to other sessions
- **SC-006**: Response time for user input is not degraded when scheduled tasks are running (less than 100ms overhead)

## Assumptions

- The existing IndexedDB infrastructure can support multi-session storage without modification
- Chrome extension service worker can handle multiple async operations without significant performance impact
- The OpenAI/model client can be instantiated multiple times without conflict
- Existing message routing infrastructure can be extended to include session IDs

## Dependencies

- Depends on existing IndexedDB storage infrastructure
- Depends on existing message routing system (MessageRouter)
- Depends on existing tab management (TabManager)
- Should be compatible with existing scheduler implementation (014-task-scheduler)

## Out of Scope

- Multi-user support (all sessions belong to the same extension user)
- Session sharing between browser profiles
- Remote session synchronization
- Session forking/branching (can be added later)
- Visual multi-session management UI beyond status display

## Technical Context (For Planning Phase)

The following technical insights from research should inform the planning phase:

### Current Architecture (Single Agent)
- `service-worker.ts`: Global singleton `agent` variable
- `BrowserxAgent.ts`: Main agent class with single Session
- `Session.ts`: Manages single conversation with single tab binding
- `TurnContext.ts`: Per-turn context (model client, instructions)
- Message flow: Side Panel → MessageRouter → agent.submitOperation() → Session

### Codex-Inspired Patterns (Reference)
- **ThreadManager pattern**: Registry with `Map<SessionId, AgentSession>`
- **Session isolation**: Each session has independent state and channels
- **RAII reservations**: Slot-based concurrency control with automatic cleanup
- **Persistence**: JSONL-style rollout files (adaptable to IndexedDB)
- **Weak references**: Prevent reference cycles between registry and sessions
