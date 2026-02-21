# Tasks: A2A Agent-to-Agent Protocol Integration

**Input**: Design documents from `/specs/021-a2a-agent-protocol/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in feature specification. Skipped.

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Includes exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install dependencies and create directory structure

- [X] T001 Install `@a2a-js/sdk` package via `npm install @a2a-js/sdk`
- [X] T002 Create directory structure: `src/core/a2a/` and `src/core/a2a/__tests__/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, validation schemas, storage helpers, and message routing that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Define all A2A type interfaces (IA2AAgentConfig, IA2AAgentConfigCreate, IA2AAgentConfigUpdate, IA2AConnection, A2AConnectionStatus, IA2ASkill, IA2AToolResult, IA2AContent, A2AManagerEvent, A2AStreamEvent, A2AMessageType) in `src/core/a2a/types.ts` — use `specs/021-a2a-agent-protocol/contracts/a2a-manager-interface.ts` as the reference contract
- [X] T004 Implement Zod validation schemas (A2AAgentNameSchema, A2AAgentUrlSchema, A2ATimeoutSchema, A2AAuthTypeSchema, A2AAgentConfigSchema, A2AAgentConfigCreateSchema) and storage helpers (loadAgents, saveAgents, createAgentConfig, updateAgentConfig, isDebugLoggingEnabled, setDebugLogging) in `src/core/a2a/A2AConfig.ts` — mirror `src/core/mcp/MCPConfig.ts` patterns, storage key `'a2aAgents'`
- [X] T005 Add A2A message types (A2A_GET_AGENTS, A2A_ADD_AGENT, A2A_UPDATE_AGENT, A2A_REMOVE_AGENT, A2A_CONNECT, A2A_DISCONNECT, A2A_GET_CONNECTION, A2A_GET_CONNECTIONS, A2A_GET_ALL_SKILLS, A2A_EXECUTE_SKILL, A2A_CANCEL_TASK) to `MessageType` enum in `src/core/MessageRouter.ts`

**Checkpoint**: Foundation ready — user story implementation can now begin

---

## Phase 3: User Story 1 — Connect to a Remote A2A Agent (Priority: P1) MVP

**Goal**: Users can add, configure, connect to, and disconnect from remote A2A agents. Agent card is fetched and skills are displayed in settings.

**Independent Test**: Add a remote A2A agent URL in settings, verify agent card is fetched and displayed, confirm connection status shows "connected" and skills are listed.

### Implementation for User Story 1

- [X] T006 [US1] Implement A2AClient class with constructor (config, apiKey, callbacks), `createAuthFetch()` (bearer/apiKey/none auth injection via custom fetch wrapper), `connect()` (create ClientFactory with auth fetch, fetch agent card, extract skills from AgentSkill[]), `disconnect()` (cleanup), `getAgentCard()`, `getSkills()`, `getStatus()` in `src/core/a2a/A2AClient.ts` — wrap `@a2a-js/sdk` ClientFactory + Client, map SDK errors to consistent error strings
- [X] T007 [US1] Implement A2AManager singleton with: constructor (platform detection via `__BUILD_MODE__`), `getInstance()` async factory, `initialize()` (load configs from storage, init connection state), config CRUD (`addAgent`, `updateAgent`, `removeAgent`, `getAgents`, `getAgent`, `getAgentByName`), connection lifecycle (`connect` → creates A2AClient → discovers skills → emits events, `disconnect` → cleanup → emits events), `getConnection()`, `getConnections()`, `getAllSkills()`, event pub/sub (`on`, `off`, `emit`), `persistAgents()`, `ensureInitialized()` guard — max 5 agents, platform-aware filtering in `src/core/a2a/A2AManager.ts` — mirror `src/core/mcp/MCPManager.ts`
- [X] T008 [US1] Wire A2A message handlers for config CRUD and connection management in `src/extension/background/service-worker.ts`: add `setupA2AMessageHandlers()` function handling A2A_GET_AGENTS, A2A_ADD_AGENT, A2A_UPDATE_AGENT, A2A_REMOVE_AGENT, A2A_CONNECT, A2A_DISCONNECT, A2A_GET_CONNECTION, A2A_GET_CONNECTIONS, A2A_GET_ALL_SKILLS — register handlers on `router.on(MessageType.A2A_*)`, initialize A2AManager singleton in startup sequence after MCP setup
- [X] T009 [US1] Implement `autoConnectEnabledA2AAgents()` in `src/extension/background/service-worker.ts`: get all agents where `enabled === true`, call `a2aManager.connect()` for each with error handling (continue on failure), call during startup after A2AManager initialization
- [X] T010 [US1] Create A2ASettings.svelte component in `src/sidepanel/settings/A2ASettings.svelte` — mirror `src/sidepanel/settings/MCPSettings.svelte` layout: agent list with connection status badges (disconnected/connecting/connected/error), "Add Agent" button with modal form (Name, URL, Auth Type dropdown [none/apiKey/bearer], API Key field, Timeout, Trusted checkbox, Enabled checkbox), per-agent actions (Connect, Disconnect, Edit, Remove), expanded view showing agent card details (name, description, version, protocol version) and skills list, advanced settings section with debug logging toggle. Wire all actions via `chrome.runtime.sendMessage` using A2A_* message types.

**Checkpoint**: User Story 1 is fully functional — users can add/edit/remove remote agents and see agent cards with skills

---

## Phase 4: User Story 2 — Send Tasks to Remote Agents (Priority: P1)

**Goal**: The LLM agent can invoke remote A2A agent skills during conversations. Skills are registered as tools, approved through the approval system, executed via the A2A protocol, and results returned to the conversation.

**Independent Test**: Connect to a remote A2A agent with a known skill, ask the local agent a question that triggers delegation, verify the remote agent's response appears in the conversation.

### Implementation for User Story 2

- [X] T011 [US2] Implement `sendMessage(messageText, contextId?, taskId?)` in `src/core/a2a/A2AClient.ts`: build A2A Message object with `role: 'user'`, `parts: [{ kind: 'text', text: messageText }]`, generate `messageId` via uuid, set `contextId` and optional `taskId`, call SDK `client.sendMessage({ message, configuration: { blocking: true } })`, map SendMessageResult (Message | Task) to IA2AToolResult with IA2AContent[] extraction (TextPart → text, FilePart → file, DataPart → data), handle all TaskState values (completed, failed, input-required, etc.)
- [X] T012 [P] [US2] Implement `adaptSkill(skill, agentName)` function in `src/core/a2a/A2AToolAdapter.ts`: return ToolDefinition with `type: 'function'`, `name: '${agentName}__${skill.id}'`, `description: '[${agentName}] ${skill.description}'`, `strict: false`, `parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }` — also implement `parsePrefixedName(prefixedName)` returning `{ agentName, skillId }` and `formatA2AResult(content: IA2AContent[])` formatting text/file/data parts joined by `\n\n`
- [X] T013 [P] [US2] Implement `A2ARiskAssessor` class implementing `IRiskAssessor` interface in `src/core/a2a/A2AToolAdapter.ts`: constructor takes `{ trusted: boolean }`, `assess()` returns score 10 + level Low + action auto_approve for trusted agents, score 45 + level Medium + action ask_user for untrusted agents, factors array includes 'Trusted A2A agent' or ['External A2A agent call', 'Network boundary crossing']
- [X] T014 [US2] Implement `createHandler(manager, agentName, skillId)` returning ToolHandler, `registerA2ASkills(manager, agentName, skills, registry, trusted)` and `unregisterA2ASkills(agentName, skills, registry)` functions in `src/core/a2a/A2AToolAdapter.ts` — handler extracts `message` param from args, calls `manager.executeSkill('${agentName}__${skillId}', args)`, formats result via `formatA2AResult()`, returns string for LLM. Registration creates A2ARiskAssessor per agent trust level.
- [X] T015 [US2] Wire `setupA2AToolRegistration()` event handler in `src/extension/background/service-worker.ts`: subscribe to A2AManager 'event', on 'skills-updated' → unregister previous skills then call `registerA2ASkills()` with ToolRegistry, on 'connection-status-changed' to disconnected/error → call `unregisterA2ASkills()`, track registered skill names per agent in a Map
- [X] T016 [US2] Implement `executeSkill(prefixedName, args, sessionContextId?)` in `src/core/a2a/A2AManager.ts`: parse prefix via `parsePrefixedName()`, find agent by name, get A2AClient, get or create contextId for this agent+session (generate UUID on first call, store in `sessionContexts` Map), call `client.sendMessage(args.message, contextId)`, return IA2AToolResult
- [X] T017 [US2] Implement session context lifecycle in `src/core/a2a/A2AManager.ts`: `setSessionContextId(agentName, contextId)`, `getSessionContextId(agentName)` returning stored contextId or undefined, `clearSessionContexts()` clearing the Map — hook clearSessionContexts into conversation session cleanup
- [X] T018 [US2] Handle `input-required` task state in `src/core/a2a/A2AClient.ts`: when sendMessage result has `status.state === 'input-required'`, return IA2AToolResult with `taskStatus: 'input-required'` and `content` containing the agent's request message, so the LLM can surface it to the user and respond with a follow-up sendMessage using the same taskId
- [X] T019 [US2] Implement `cancelTask(agentName, taskId)` in `src/core/a2a/A2AManager.ts`: find agent client, call `client.cancelTask(taskId)`, handle TaskNotCancelableError gracefully. Wire A2A_EXECUTE_SKILL and A2A_CANCEL_TASK message handlers in `src/extension/background/service-worker.ts`

**Checkpoint**: User Story 2 is fully functional — LLM can invoke remote agent skills with approval, results appear in conversation

---

## Phase 5: User Story 3 — Streaming Responses from Remote Agents (Priority: P2)

**Goal**: When a remote agent supports streaming, partial results appear incrementally in the conversation UI, providing real-time feedback for long-running tasks.

**Independent Test**: Connect to a streaming-capable remote agent, send a task, verify partial results appear incrementally before the task completes.

### Implementation for User Story 3

- [X] T020 [US3] Implement `sendMessageStream(messageText, contextId?, onEvent?)` in `src/core/a2a/A2AClient.ts`: build A2A Message (same as sendMessage), call SDK `client.sendMessageStream({ message })` returning `AsyncGenerator<A2AStreamEventData>`, iterate events with `for await`, map each event kind ('status-update' → A2AStreamEvent status-update, 'artifact-update' → A2AStreamEvent artifact-update with IA2AContent extraction, 'message' → A2AStreamEvent message, 'task' → check final state) to A2AStreamEvent, call `onEvent` callback for each, collect final result into IA2AToolResult on completion
- [X] T021 [US3] Implement `executeSkillStream(prefixedName, args, sessionContextId?, onEvent?)` in `src/core/a2a/A2AManager.ts`: same prefix parsing and context management as executeSkill, check agent card `capabilities.streaming`, if true call `client.sendMessageStream()`, if false fall back to `client.sendMessage()` (FR-007 fallback), route stream events via onEvent callback
- [X] T022 [US3] Update `createHandler()` in `src/core/a2a/A2AToolAdapter.ts` to check if the connected agent supports streaming: read agent card capabilities from A2AManager connection, if streaming supported call `manager.executeSkillStream()` instead of `manager.executeSkill()`, pass through stream events for UI consumption
- [X] T023 [US3] Implement stream cancellation in `src/core/a2a/A2AClient.ts`: create AbortController per stream request, pass `signal` to SDK via `RequestOptions`, expose `abortStream(taskId)` method that calls `controller.abort()` then sends `cancelTask()` to remote agent, handle abort gracefully in the AsyncGenerator iteration loop

**Checkpoint**: User Story 3 is fully functional — streaming works when supported, falls back to sync when not

---

## Phase 6: User Story 4 — Expose Local Agent as A2A Server (Priority: P3)

**Goal**: The local agent can accept incoming tasks from remote A2A agents, enabling bidirectional agent collaboration.

**Independent Test**: Enable A2A server mode, verify agent card is accessible at well-known URL, send a task from an external A2A client and verify it's processed.

**Note**: This is P3 priority. Implementation can be deferred until P1/P2 stories are stable.

### Implementation for User Story 4

- [X] T024 [US4] Design and document A2A server architecture — determine HTTP server approach per platform (desktop: Tauri HTTP plugin or bundled micro-server on configurable port, extension: service worker fetch event interception for agent card, limitations for full JSON-RPC), define local agent card generation from registered tools/skills, document in `specs/021-a2a-agent-protocol/server-design.md`
- [X] T025 [US4] Implement local AgentCard generation in `src/core/a2a/A2AServer.ts`: build AgentCard from local tool registry (name, description from config, skills from registered tools, capabilities based on platform), serve at `/.well-known/agent.json`
- [X] T026 [US4] Implement A2A JSON-RPC request handler in `src/core/a2a/A2AServer.ts`: use `@a2a-js/sdk/server` DefaultRequestHandler and InMemoryTaskStore, implement AgentExecutor interface with `execute()` routing to local tool execution and `cancelTask()`, handle incoming SendMessage and SendStreamingMessage requests
- [X] T027 [US4] Add server mode toggle and port configuration to `src/sidepanel/settings/A2ASettings.svelte`: "Enable A2A Server" toggle, port number input (desktop only), server status indicator, display the local agent card URL when active

**Checkpoint**: User Story 4 is functional — local agent can accept incoming tasks

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Quality improvements that affect multiple user stories

- [X] T028 Add debug logging support in `src/core/a2a/A2AClient.ts`: read debug flag via `isDebugLoggingEnabled()` from A2AConfig, log `[A2A:agentName]` prefixed messages for connect, disconnect, sendMessage, sendMessageStream, errors — mirror `src/core/mcp/MCPClient.ts` debugLog pattern
- [X] T029 Harden error handling across all A2A modules: ensure all async operations have try/catch, network errors include agent name and URL in messages, timeout errors are distinct from connection errors, SDK-specific errors (TaskNotFoundError, UnsupportedOperationError, ContentTypeNotSupportedError) are mapped to user-friendly messages
- [X] T030 Validate dual-platform build: run `npm run build` for extension target and desktop target, verify zero A2A-specific build errors, confirm no platform-specific imports in `src/core/a2a/` modules (no direct chrome.* or Tauri imports — use storage abstraction)
- [X] T031 Integration smoke test: connect to a real or mock A2A agent, invoke a skill, verify end-to-end flow (settings UI → service worker → A2AManager → A2AClient → SDK → remote agent → response → tool result → LLM)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — establishes connection infrastructure
- **US2 (Phase 4)**: Depends on Phase 3 (US1) — needs connection to send tasks
- **US3 (Phase 5)**: Depends on Phase 4 (US2) — extends sync execution with streaming
- **US4 (Phase 6)**: Depends on Phase 2 only — can be built independently of US1-US3 but recommended after US2 is stable
- **Polish (Phase 7)**: Depends on Phases 3-5 minimum

### User Story Dependencies

- **US1 (P1)**: Foundation → US1 (connection infrastructure, MVP starting point)
- **US2 (P1)**: US1 → US2 (task execution builds on established connections)
- **US3 (P2)**: US2 → US3 (streaming extends synchronous execution)
- **US4 (P3)**: Foundation → US4 (independent server, but recommended after US2)

### Within Each User Story

- Types and config before client wrapper
- Client wrapper before manager
- Manager before service worker wiring
- Service worker wiring before settings UI
- Core execution before edge case handling

### Parallel Opportunities

**Phase 2 (Foundational)**:
- T003 (types.ts) and T005 (MessageRouter) can start in parallel — T004 (config) depends on T003

**Phase 4 (US2)**:
- T012 (adaptSkill/parsePrefixedName/formatA2AResult) and T013 (A2ARiskAssessor) can run in parallel — both are in same file but independent functions
- T011 (client sendMessage) can run in parallel with T012+T013

**Phase 5 (US3)**:
- T020 (client streaming) and T023 (AbortController) are in same file but T023 depends on T020

---

## Parallel Example: Phase 2 (Foundational)

```
# These can run in parallel (different files):
Task T003: "Define A2A types in src/core/a2a/types.ts"
Task T005: "Add A2A message types to src/core/MessageRouter.ts"

# Then sequentially:
Task T004: "Implement Zod schemas in src/core/a2a/A2AConfig.ts" (depends on T003)
```

## Parallel Example: Phase 4 (US2)

```
# These can run in parallel (different functions, T012/T013 in same file but independent):
Task T011: "Implement sendMessage in src/core/a2a/A2AClient.ts"
Task T012: "Implement adaptSkill/parsePrefixedName/formatA2AResult in src/core/a2a/A2AToolAdapter.ts"
Task T013: "Implement A2ARiskAssessor in src/core/a2a/A2AToolAdapter.ts"

# Then sequentially:
Task T014: "Implement createHandler/register/unregister in A2AToolAdapter.ts" (depends on T012, T013)
Task T015: "Wire tool registration events in service-worker.ts" (depends on T014)
Task T016: "Implement executeSkill in A2AManager.ts" (depends on T011)
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup (install SDK, create dirs)
2. Complete Phase 2: Foundational (types, config, message router)
3. Complete Phase 3: US1 — Connect to Remote Agents
4. **VALIDATE**: Test connection/disconnection with a real or mock A2A agent
5. Complete Phase 4: US2 — Send Tasks to Remote Agents
6. **VALIDATE**: Test skill invocation end-to-end with approval flow
7. Deploy/demo MVP

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 → Agent discovery and connection UI (demo-able)
3. US2 → Full skill invocation pipeline (core value delivered!)
4. US3 → Streaming for better UX on long tasks
5. US4 → Server mode for bidirectional collaboration (advanced)
6. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- US1 and US2 are both P1 but sequential (US2 needs US1's connection infrastructure)
- US4 (server mode, P3) is intentionally thin — needs more design when prioritized
- All A2A module code in `src/core/a2a/` must use storage abstractions (no direct chrome.* or Tauri imports) to maintain platform independence per FR-013
- Tool naming uses double underscore (`agentName__skillId`) matching MCP convention
- Approval risk scores: untrusted=45 (ask_user), trusted=10 (auto_approve)
