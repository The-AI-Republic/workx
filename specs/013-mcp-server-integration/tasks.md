# Tasks: MCP Server Integration

**Input**: Design documents from `/specs/013-mcp-server-integration/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Tests are included per Constitution Check (TDD requirement).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- **Single project** (Chrome Extension): `src/` at repository root
- Tests in `src/**/__tests__/` (colocated) or `tests/` at root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install dependencies and create MCP module structure

- [x] T001 Install @modelcontextprotocol/sdk dependency via `npm install @modelcontextprotocol/sdk`
- [x] T002 [P] Create MCP module directory structure: `src/mcp/`, `src/mcp/transports/`, `src/mcp/__tests__/`
- [x] T003 [P] Copy type definitions from `specs/013-mcp-server-integration/contracts/mcp-types.ts` to `src/mcp/types.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core MCP infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Implement SSEClientTransport class in `src/mcp/transports/SSEClientTransport.ts` (fetch for POST, EventSource for SSE, session management)
- [x] T005 [P] Create Zod validation schemas for MCPServerConfig in `src/mcp/MCPConfig.ts` (based on data-model.md)
- [x] T006 [P] Implement MCP storage helpers in `src/mcp/MCPConfig.ts` (loadServers, saveServers using chrome.storage.local)
- [x] T007 Create MCPClient class in `src/mcp/MCPClient.ts` wrapping MCP SDK Client with SSEClientTransport
- [x] T008 Implement MCPManager singleton in `src/mcp/MCPManager.ts` with event emission pattern (follows AgentConfig pattern)
- [x] T009 Add MCP message types to `src/protocol/types.ts` (MCP_GET_SERVERS, MCP_CONNECT, etc.)
- [x] T010 Add MCP message handlers in `src/background/service-worker.ts` (initialize MCPManager, handle MCP_* messages)

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Connect to MCP Server (Priority: P1) 🎯 MVP

**Goal**: User can configure MCP server connection, connect, and see discovered tools

**Independent Test**: Configure a single MCP server connection and verify tools appear in available tool list

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T011 [P] [US1] Unit test for SSEClientTransport in `src/mcp/__tests__/SSEClientTransport.test.ts` (mock fetch/EventSource)
- [x] T012 [P] [US1] Unit test for MCPClient in `src/mcp/__tests__/MCPClient.test.ts` (mock transport, test connect/disconnect/listTools)
- [x] T013 [P] [US1] Unit test for MCPConfig validation in `src/mcp/__tests__/MCPConfig.test.ts` (Zod schemas)
- [x] T014 [P] [US1] Unit test for MCPManager in `src/mcp/__tests__/MCPManager.test.ts` (singleton, addServer, connect, getConnection)

### Implementation for User Story 1

- [x] T015 [US1] Implement MCPClient.connect() method in `src/mcp/MCPClient.ts` (create transport, SDK client, call initialize)
- [x] T016 [US1] Implement MCPClient.disconnect() method in `src/mcp/MCPClient.ts` (graceful close, cleanup)
- [x] T017 [US1] Implement MCPClient.listTools() method in `src/mcp/MCPClient.ts` (call SDK client.listTools)
- [x] T018 [US1] Implement MCPManager.addServer() in `src/mcp/MCPManager.ts` (validate, generate UUID, persist to storage)
- [x] T019 [US1] Implement MCPManager.updateServer() in `src/mcp/MCPManager.ts` (validate, update, persist)
- [x] T020 [US1] Implement MCPManager.removeServer() in `src/mcp/MCPManager.ts` (disconnect if connected, remove from storage)
- [x] T021 [US1] Implement MCPManager.connect() in `src/mcp/MCPManager.ts` (create MCPClient, connect, discover tools, emit events)
- [x] T022 [US1] Implement MCPManager.disconnect() in `src/mcp/MCPManager.ts` (close client, update status, emit events)
- [x] T023 [US1] Implement MCPManager.getConnection() in `src/mcp/MCPManager.ts` (return IMCPConnection state)
- [x] T024 [US1] Create MCPSettings.svelte component in `src/sidepanel/settings/MCPSettings.svelte` (add/edit/remove server form)
- [x] T025 [US1] Add server list display in MCPSettings.svelte with connection status indicators (connected/disconnected/error badges)
- [x] T026 [US1] Add connect/disconnect buttons to MCPSettings.svelte (call MCP_CONNECT/MCP_DISCONNECT messages)
- [x] T027 [US1] Add tool list display in MCPSettings.svelte (read-only list showing tool name, description, source server)
- [x] T028 [US1] Integrate MCPSettings.svelte into existing Settings page in `src/sidepanel/Settings.svelte`
- [x] T029 [US1] Implement error display in MCPSettings.svelte (show connection failures with actionable messages)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Use MCP-Provided Tools in Conversations (Priority: P2)

**Goal**: Agent can call MCP tools and use results in responses

**Independent Test**: Connect to MCP server with simple tool, ask agent to use that tool, verify tool called and results used

### Tests for User Story 2

- [x] T030 [P] [US2] Unit test for MCPToolAdapter in `src/mcp/__tests__/MCPToolAdapter.test.ts` (adaptTool, createHandler, parsePrefixedName)
- [x] T031 [P] [US2] Integration test for MCP tool execution in `src/mcp/__tests__/MCPToolExecution.test.ts` (end-to-end tool call)

### Implementation for User Story 2

- [x] T032 [US2] Create MCPToolAdapter class in `src/mcp/MCPToolAdapter.ts` implementing IMCPToolAdapter interface
- [x] T033 [US2] Implement MCPToolAdapter.adaptTool() in `src/mcp/MCPToolAdapter.ts` (convert IMCPTool to ToolDefinition with prefixed name)
- [x] T034 [US2] Implement MCPToolAdapter.createHandler() in `src/mcp/MCPToolAdapter.ts` (return ToolHandler that calls MCPManager.executeTool)
- [x] T035 [US2] Implement MCPToolAdapter.parsePrefixedName() in `src/mcp/MCPToolAdapter.ts` (parse "server:tool" format)
- [x] T036 [US2] Implement MCPManager.executeTool() in `src/mcp/MCPManager.ts` (route to correct MCPClient, call tools/call, return result)
- [x] T037 [US2] Implement MCPClient.callTool() in `src/mcp/MCPClient.ts` (call SDK client.callTool with timeout)
- [x] T038 [US2] Add registerMCPTools() function in `src/mcp/MCPToolAdapter.ts` (register all MCP tools with ToolRegistry)
- [x] T039 [US2] Add unregisterMCPTools() function in `src/mcp/MCPToolAdapter.ts` (remove server's tools from ToolRegistry)
- [x] T040 [US2] Modify MCPManager.connect() to call registerMCPTools() after tool discovery in `src/mcp/MCPManager.ts`
- [x] T041 [US2] Modify MCPManager.disconnect() to call unregisterMCPTools() before closing in `src/mcp/MCPManager.ts`
- [x] T042 [US2] Handle tool execution errors in MCPToolAdapter handler (return error to agent with context)
- [x] T043 [US2] Add timeout handling for tool calls in MCPClient.callTool() (use config.timeout, default 30s)

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Manage Multiple MCP Servers (Priority: P3)

**Goal**: User can connect to multiple MCP servers simultaneously with tools from all servers available

**Independent Test**: Configure two MCP servers, verify tools from both appear with correct prefixes

### Tests for User Story 3

- [x] T044 [P] [US3] Unit test for multi-server management in `src/mcp/__tests__/MCPManager.multi.test.ts` (add multiple, connect multiple, tool aggregation)

### Implementation for User Story 3

- [x] T045 [US3] Update MCPManager to support concurrent connections (Map<string, MCPClient> instead of single client) in `src/mcp/MCPManager.ts`
- [x] T046 [US3] Implement MCPManager.getAllTools() in `src/mcp/MCPManager.ts` (aggregate tools from all connected servers)
- [x] T047 [US3] Implement MCPManager.getConnections() in `src/mcp/MCPManager.ts` (return all connection states)
- [x] T048 [US3] Update MCPSettings.svelte to display multiple servers with individual status in `src/sidepanel/settings/MCPSettings.svelte`
- [x] T049 [US3] Add enable/disable toggle per server in MCPSettings.svelte (enabled flag controls auto-connect)
- [x] T050 [US3] Implement auto-reconnect on connection loss in MCPManager (exponential backoff for enabled servers)
- [x] T051 [US3] Handle server unavailability gracefully in MCPToolAdapter handler (return clear error, don't affect other servers)
- [x] T052 [US3] Enforce 5-server limit in MCPManager.addServer() (return error if limit reached)

**Checkpoint**: User Stories 1, 2, AND 3 should all work independently

---

## Phase 6: User Story 4 - Access MCP Resources (Priority: P4)

**Goal**: Agent can discover and retrieve resources from MCP servers

**Independent Test**: Connect to MCP server providing resources, verify resources discoverable and retrievable

### Tests for User Story 4

- [x] T053 [P] [US4] Unit test for resource methods in `src/mcp/__tests__/MCPClient.resources.test.ts` (listResources, readResource)

### Implementation for User Story 4

- [x] T054 [US4] Implement MCPClient.listResources() in `src/mcp/MCPClient.ts` (call SDK client.listResources if capability present)
- [x] T055 [US4] Implement MCPClient.readResource() in `src/mcp/MCPClient.ts` (call SDK client.readResource)
- [x] T056 [US4] Implement MCPManager.getAllResources() in `src/mcp/MCPManager.ts` (aggregate resources from all connected servers)
- [x] T057 [US4] Implement MCPManager.readResource() in `src/mcp/MCPManager.ts` (route to correct MCPClient)
- [x] T058 [US4] Update MCPManager.connect() to discover resources after tool discovery in `src/mcp/MCPManager.ts`
- [x] T059 [US4] Add resource list display in MCPSettings.svelte (read-only, showing uri, name, mimeType)
- [x] T060 [US4] Handle large resources with truncation in MCPClient.readResource() (respect token limits)

**Checkpoint**: All user stories should now be independently functional

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T061 [P] Add debug logging toggle to MCPSettings.svelte (mcpDebugLogging in chrome.storage.local)
- [x] T062 [P] Implement MCP protocol message logging when debug enabled in MCPClient
- [x] T063 [P] Add connection status change notifications in MCPManager (emit events for UI updates)
- [x] T064 Implement service worker lifecycle handling in `src/background/service-worker.ts` (reconnect enabled servers on wake)
- [x] T065 Add input validation for server name (alphanumeric + hyphens, 1-50 chars, unique) in MCPConfig.ts
- [x] T066 Add URL validation for server URL (must be valid http/https URL) in MCPConfig.ts
- [x] T067 Encrypt API keys before storage using existing encryptApiKey() in MCPManager.addServer/updateServer
- [x] T068 Decrypt API keys when connecting using existing decryptApiKey() in MCPClient.connect
- [ ] T069 [P] Run quickstart.md validation (test with local MCP server) - **Requires manual testing**
- [x] T070 [P] Update CLAUDE.md with MCP integration documentation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3 → P4)
- **Polish (Phase 7)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Depends on US1 (needs connection to work with tools)
- **User Story 3 (P3)**: Can start after Foundational - Extends US1 with multi-server
- **User Story 4 (P4)**: Can start after Foundational - Independent resource feature

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Core classes before managers
- Managers before UI
- UI integration last

### Parallel Opportunities

**Phase 1 (Setup)**:
```
T002 (create directories) || T003 (copy types)
```

**Phase 2 (Foundational)**:
```
T005 (Zod schemas) || T006 (storage helpers)
```

**Phase 3 (US1 Tests)**:
```
T011 || T012 || T013 || T014 (all tests in parallel)
```

**Phase 4 (US2 Tests)**:
```
T030 || T031 (tests in parallel)
```

**Different Stories in Parallel** (with multiple developers):
```
Developer A: US1 (core connection)
Developer B: US3 (multi-server - after US1 T021-T023)
Developer C: US4 (resources - independent)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (~3 tasks)
2. Complete Phase 2: Foundational (~7 tasks)
3. Complete Phase 3: User Story 1 (~19 tasks)
4. **STOP and VALIDATE**: Test with local MCP server
5. Deploy/demo if ready - single server connection works!

### Incremental Delivery

1. **MVP**: Setup + Foundational + US1 → Single server connection with tool discovery
2. **+Tool Execution**: Add US2 → Agent can use MCP tools in conversations
3. **+Multi-Server**: Add US3 → Multiple servers with aggregated tools
4. **+Resources**: Add US4 → Resource discovery and retrieval
5. **+Polish**: Add Phase 7 → Debug logging, reconnection, validation

### Task Counts by Phase

| Phase | Description | Tasks | Completed |
|-------|-------------|-------|-----------|
| 1 | Setup | 3 | 3 ✅ |
| 2 | Foundational | 7 | 7 ✅ |
| 3 | User Story 1 (P1) | 19 | 19 ✅ |
| 4 | User Story 2 (P2) | 14 | 14 ✅ |
| 5 | User Story 3 (P3) | 9 | 9 ✅ |
| 6 | User Story 4 (P4) | 8 | 8 ✅ |
| 7 | Polish | 10 | 9 ✅ (T069 manual) |
| **Total** | | **70** | **69/70** |

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD per Constitution)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- MCP SDK handles protocol details; focus on transport and integration

## Completion Status

**Implementation Complete**: 2026-02-02

- All 140 MCP tests pass
- Build succeeds
- All code implemented and integrated
- T069 (quickstart validation) requires manual testing with a local MCP server

### Files Created/Modified

**New Files (MCP Module)**:
- `src/mcp/types.ts` - Type definitions
- `src/mcp/MCPConfig.ts` - Zod schemas, storage helpers
- `src/mcp/MCPClient.ts` - Client wrapper for MCP SDK
- `src/mcp/MCPManager.ts` - Singleton manager
- `src/mcp/MCPToolAdapter.ts` - Tool registry integration
- `src/mcp/transports/SSEClientTransport.ts` - SSE/HTTP transport

**Test Files**:
- `src/mcp/__tests__/SSEClientTransport.test.ts`
- `src/mcp/__tests__/MCPClient.test.ts`
- `src/mcp/__tests__/MCPClient.resources.test.ts`
- `src/mcp/__tests__/MCPConfig.test.ts`
- `src/mcp/__tests__/MCPManager.test.ts`
- `src/mcp/__tests__/MCPManager.multi.test.ts`
- `src/mcp/__tests__/MCPToolAdapter.test.ts`
- `src/mcp/__tests__/MCPToolExecution.test.ts`

**Modified Files**:
- `src/protocol/types.ts` - MCP message types
- `src/background/service-worker.ts` - MCP handlers, auto-connect
- `src/sidepanel/settings/MCPSettings.svelte` - UI component
- `src/sidepanel/Settings.svelte` - Integration
- `CLAUDE.md` - Documentation
