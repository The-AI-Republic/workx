# Feature Specification: A2A Agent-to-Agent Protocol Integration

**Feature Branch**: `021-a2a-agent-protocol`
**Created**: 2026-02-15
**Status**: Draft
**Input**: User description: "Integrate A2A (Google AI Agent Protocol) into the system so that the agent can communicate with other agents. Make sure the code change can work on both browserx and desktop Pi (one implementation to work on both agent apps instead of separately implementing them)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect to a Remote A2A Agent (Priority: P1)

A user wants their agent (browserx or desktop Pi) to delegate tasks to a remote A2A-compatible agent. The user adds a remote agent's endpoint URL in the settings, the system fetches the agent's card to discover its capabilities and skills, and the connection is established. The user can then see what the remote agent can do and invoke its skills during conversations.

**Why this priority**: This is the foundational capability — without being able to discover and connect to remote agents, no agent-to-agent communication is possible. It establishes the core client infrastructure that all other stories depend on.

**Independent Test**: Can be fully tested by adding a remote A2A agent URL in settings, verifying the agent card is fetched and displayed, and confirming the connection status shows as "connected."

**Acceptance Scenarios**:

1. **Given** the user is in Settings, **When** they add a remote agent URL (e.g., `https://agent.example.com`), **Then** the system fetches the agent card and displays the agent's name, description, and list of skills.
2. **Given** a remote agent is configured, **When** the user clicks "Connect," **Then** the connection status transitions from "disconnected" → "connecting" → "connected" and the agent's skills appear in the available tools list.
3. **Given** a remote agent is connected, **When** the user clicks "Disconnect," **Then** the connection status transitions to "disconnected" and the agent's skills are removed from the available tools list.
4. **Given** the user has configured multiple remote agents (up to 5), **When** viewing the settings, **Then** each agent shows its individual connection status and discovered skills.

---

### User Story 2 - Send Tasks to Remote Agents (Priority: P1)

During a conversation, the local agent determines that a remote A2A agent has the right skill to handle a request. The local agent sends a message to the remote agent, which creates a task. The remote agent processes the task and returns results (text, files, or structured data). The user sees the results seamlessly integrated into the conversation.

**Why this priority**: This is the core value proposition — actually using remote agents to accomplish work. Without task execution, connections are meaningless.

**Independent Test**: Can be fully tested by connecting to a remote A2A agent that has a known skill (e.g., a weather agent), asking the local agent a question that triggers delegation, and verifying the remote agent's response appears in the conversation.

**Acceptance Scenarios**:

1. **Given** a remote agent with a "search" skill is connected, **When** the local agent sends a message to it, **Then** a task is created on the remote agent and results are returned to the conversation.
2. **Given** a remote agent is processing a long-running task, **When** the task status updates to "working," **Then** the user sees a progress indicator and can continue to see status updates until the task completes.
3. **Given** a remote agent returns results containing text and file artifacts, **When** the task completes, **Then** both text content and file references are displayed in the conversation.
4. **Given** a remote agent task fails, **When** the failure status is received, **Then** the user sees a clear error message explaining what went wrong.

---

### User Story 3 - Streaming Responses from Remote Agents (Priority: P2)

When a remote A2A agent supports streaming, the user sees partial results as they are generated rather than waiting for the entire response. This provides a real-time, interactive experience similar to LLM streaming.

**Why this priority**: Streaming significantly improves user experience for long-running tasks, but the system can function without it by falling back to synchronous request/response.

**Independent Test**: Can be fully tested by connecting to a streaming-capable remote agent, sending a task, and verifying that partial results appear incrementally in the conversation UI.

**Acceptance Scenarios**:

1. **Given** a remote agent declares `streaming: true` in its agent card capabilities, **When** the local agent sends a message, **Then** the system uses streaming transport and displays partial results as they arrive.
2. **Given** a remote agent does not support streaming, **When** a message is sent, **Then** the system falls back to synchronous request/response and displays results once complete.
3. **Given** a streaming task is in progress, **When** the user requests cancellation, **Then** the stream is terminated and a cancel request is sent to the remote agent.

---

### User Story 4 - Expose Local Agent as A2A Server (Priority: P3)

The user wants other agents (on the network or locally) to be able to send tasks to their agent. The local agent exposes an A2A-compliant server endpoint that advertises its capabilities via an agent card. Remote agents can discover and invoke the local agent's skills.

**Why this priority**: Being a server enables true bidirectional agent collaboration, but the primary value (delegating to remote agents) is delivered by the client stories. Server mode adds advanced multi-agent orchestration.

**Independent Test**: Can be fully tested by enabling A2A server mode in settings, verifying the agent card is accessible at the well-known URL, and having an external A2A client send a task that the local agent processes.

**Acceptance Scenarios**:

1. **Given** the user enables A2A server mode, **When** a remote client fetches `/.well-known/agent.json`, **Then** it receives a valid agent card with the local agent's name, skills, and capabilities.
2. **Given** the A2A server is running, **When** a remote agent sends a message via JSON-RPC, **Then** the local agent processes it and returns results.
3. **Given** the A2A server is running on desktop Pi, **When** another agent on the same network sends a task, **Then** the task is processed and results are returned.

---

### Edge Cases

- What happens when a remote agent's endpoint is unreachable during connection? The system displays an error with the specific failure reason and transitions to "error" status.
- What happens when a remote agent's agent card is malformed or missing required fields? The system rejects the connection with a validation error explaining which fields are missing or invalid.
- What happens when a task is in "input_required" state and the remote agent needs additional information? The system surfaces the request to the user and allows them to provide the additional input, which is forwarded back to the remote agent.
- What happens when the network connection drops during a streaming task? The system detects the disconnection, notifies the user, and allows retry.
- What happens when two configured remote agents have skills with the same name? The system prefixes skills with the agent name (e.g., `weather-agent:get_forecast`) to avoid conflicts, following the same pattern as MCP tool naming.
- What happens when the maximum number of remote agents (5) is already configured? The system prevents adding more and displays a clear message about the limit.
- What happens when a trusted remote agent's behavior changes (e.g., new skills added)? The trust setting persists but only applies to skills that were visible when trust was granted; newly discovered skills after a reconnect still require initial approval.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support discovering remote A2A agents by fetching their agent card from a provided URL.
- **FR-002**: System MUST validate agent cards against the A2A specification and display agent name, description, version, and skills.
- **FR-003**: System MUST support connecting to and disconnecting from remote A2A agents with clear status transitions (disconnected → connecting → connected, and reverse).
- **FR-004**: System MUST support sending messages to remote agents via the A2A `SendMessage` method and receiving task results.
- **FR-005**: System MUST support the A2A task lifecycle (working, input_required, completed, failed, canceled) and surface task status to the user.
- **FR-006**: System MUST support streaming responses from remote agents via `SendStreamingMessage` when the remote agent declares streaming capability.
- **FR-007**: System MUST fall back to synchronous request/response when the remote agent does not support streaming.
- **FR-008**: System MUST prefix remote agent skills with the agent name to avoid naming conflicts (e.g., `agent-name:skill-name`), consistent with the existing MCP tool naming convention.
- **FR-008a**: System MUST maintain a shared A2A contextId per remote agent within a conversation session, enabling remote agents to retain state across multiple invocations within the same conversation. A new conversation session starts a fresh contextId.
- **FR-009**: System MUST support canceling in-progress remote tasks via the A2A `CancelTask` method.
- **FR-010**: System MUST persist remote agent configurations (URL, name, authentication, enabled status) across sessions.
- **FR-011**: System MUST support a maximum of 5 user-configured remote A2A agents.
- **FR-012**: System MUST support authentication when connecting to remote agents, including API key and bearer token methods at minimum.
- **FR-013**: System MUST use a single shared module that works on both browserx (Chrome extension) and desktop Pi without platform-specific forks, using the existing platform abstraction pattern (`__BUILD_MODE__`).
- **FR-014**: System MUST provide a settings UI for managing remote A2A agent connections (add, edit, remove, connect, disconnect) consistent with the existing MCP settings UI pattern.
- **FR-015**: System MUST register discovered remote agent skills as tools in the tool registry so the LLM agent can invoke them during conversations.
- **FR-015a**: Remote A2A skill invocations MUST require user approval by default through the existing approval system. Users MUST be able to mark individual remote agents as "trusted" to auto-approve their skill invocations without prompting.
- **FR-016**: System MUST handle remote agent responses containing text, file artifacts, and structured data.
- **FR-017**: System MUST handle the "input_required" task state by surfacing the remote agent's request to the user and forwarding their response.
- **FR-018**: System MUST support the A2A server role, exposing an agent card and accepting incoming tasks from remote agents.

### Key Entities

- **Remote Agent Configuration**: The stored settings for a remote A2A agent — includes URL, display name, authentication credentials, enabled/disabled status, timeout, and auto-connect preference.
- **Agent Card**: The A2A discovery document describing an agent's identity (name, description, version), capabilities (streaming, push notifications), and skills (list of operations the agent can perform).
- **A2A Task**: A unit of work exchanged between agents — has an ID, context ID, lifecycle status, messages, and artifacts. Tasks can be short-lived (immediate response) or long-running (with status updates).
- **A2A Message**: A communication unit within a task, containing a role (user/agent) and an array of content parts (text, files, artifacts).
- **A2A Skill**: A declared capability of a remote agent — has a name, description, and input/output modes. Mapped to the local tool registry when connected.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can discover and connect to a remote A2A agent within 30 seconds of entering its URL.
- **SC-002**: Remote agent skill invocation completes and returns results within the remote agent's own processing time plus less than 2 seconds of overhead from the A2A communication layer.
- **SC-003**: 100% of the A2A client module code is shared between browserx and desktop Pi with zero platform-specific forks in the A2A module itself.
- **SC-004**: Streaming responses from remote agents display first partial content within 1 second of the remote agent beginning to stream.
- **SC-005**: Failed remote agent connections display a user-understandable error message within 5 seconds of the failure.
- **SC-006**: The system correctly handles all A2A task states (working, input_required, completed, failed, canceled) and surfaces appropriate feedback for each.
- **SC-007**: Users can manage up to 5 remote A2A agents simultaneously without performance degradation.

## Clarifications

### Session 2026-02-15

- Q: Should remote A2A skill invocations require user approval, and how? → A: Require approval by default, with per-agent trust override to auto-approve.
- Q: Should multiple invocations to the same remote agent within a conversation share context? → A: Yes, share a single contextId per remote agent within a conversation session.

### Assumptions

- Remote A2A agents implement the A2A protocol specification (v0.2 or v0.3) and expose a valid agent card at the configured URL.
- The `@a2a-js/sdk` npm package provides the TypeScript client implementation with browser-compatible HTTP/JSON-RPC transport.
- Authentication for remote agents follows standard HTTP patterns (API key in header or bearer token), consistent with the agent card's declared security schemes.
- The A2A server role (P3) will bind to a local HTTP port on desktop Pi; on browserx, it will operate within the extension's service worker context.
- gRPC transport is not required for the initial implementation since it is Node.js only and not compatible with browser environments.
