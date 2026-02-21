# Implementation Plan: A2A Agent-to-Agent Protocol Integration

**Branch**: `021-a2a-agent-protocol` | **Date**: 2026-02-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/021-a2a-agent-protocol/spec.md`

## Summary

Integrate the A2A (Agent-to-Agent) protocol into the system so the agent can communicate with other A2A-compatible agents. The implementation mirrors the existing MCP module architecture (`src/core/mcp/`) to create a parallel `src/core/a2a/` module. Uses the `@a2a-js/sdk` npm package for JSON-RPC transport (browser-compatible). A single shared module works on both browserx (Chrome extension) and desktop Pi via the existing `__BUILD_MODE__` platform abstraction.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (ES2020 target)
**Primary Dependencies**: `@a2a-js/sdk` (v0.3.10), Svelte 4.2.20, Vite 5.4.20, Zod 3.23.8
**Storage**: `chrome.storage.local` (persisted config), in-memory (connections, contexts)
**Testing**: Vitest (existing test runner)
**Target Platform**: Chrome Extension (Manifest V3) + Tauri Desktop (both via `__BUILD_MODE__`)
**Project Type**: Single codebase, dual-platform build
**Performance Goals**: <2s overhead per A2A call, <1s streaming first-byte, <30s agent discovery
**Constraints**: Browser-compatible transports only (no gRPC), max 5 remote agents, shared module (zero platform forks in A2A code)
**Scale/Scope**: 5 concurrent remote agents, multiple active tasks per agent

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution is a template (not customized with specific principles). No gate violations to check. Proceeding.

## Project Structure

### Documentation (this feature)

```text
specs/021-a2a-agent-protocol/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── a2a-manager-interface.ts
│   └── a2a-tool-adapter-interface.ts
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/rr.tasks)
```

### Source Code (repository root)

```text
src/core/a2a/
├── types.ts                    # All A2A type definitions
├── A2AManager.ts               # Singleton manager (connections, skills, events)
├── A2AClient.ts                # @a2a-js/sdk wrapper with auth injection
├── A2AConfig.ts                # Zod schemas, storage helpers
├── A2AToolAdapter.ts           # Skill → ToolDefinition, risk assessor, handlers
└── __tests__/
    ├── A2AManager.test.ts
    ├── A2AClient.test.ts
    ├── A2AToolAdapter.test.ts
    └── A2AConfig.test.ts

src/sidepanel/settings/
└── A2ASettings.svelte          # Settings UI for remote agent management

src/core/MessageRouter.ts       # Extended with A2A message types
src/extension/background/
└── service-worker.ts           # A2A handlers, tool registration, auto-connect
```

**Structure Decision**: Placed in `src/core/a2a/` as a peer to `src/core/mcp/`, following the established pattern for protocol integrations. This keeps A2A and MCP cleanly separated while sharing the same integration points (ToolRegistry, MessageRouter, ApprovalGate, service worker).

## Architecture Overview

### Module Dependency Graph

```
┌─────────────────────────────────────────────────────────┐
│                    Settings UI                          │
│   A2ASettings.svelte ←──→ MessageRouter (A2A_* types)  │
└───────────────────────────────┬──────────────────────────┘
                                │ chrome.runtime messages
                                ▼
┌─────────────────────────────────────────────────────────┐
│                  Service Worker                         │
│  setupA2AMessageHandlers() ←──→ A2AManager singleton   │
│  setupA2AToolRegistration() ──→ ToolRegistry           │
│  autoConnectEnabledA2AAgents() (on startup)            │
└───────────────────────────────┬──────────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
     A2AManager          A2AToolAdapter       ApprovalGate
     (singleton)          (adaptation)        (risk check)
            │                   │
            ▼                   │
       A2AClient ───────────────┘
       (SDK wrapper)
            │
            ▼
    @a2a-js/sdk Client
    (JSON-RPC transport)
            │
            ▼
    Remote A2A Agent
    (HTTP/HTTPS)
```

### Data Flow: Skill Invocation

```
1. LLM selects tool "weather-agent__get_forecast"
2. ToolRegistry.execute() → approval gate check
   - If untrusted: score=45, ask_user
   - If trusted: score=10, auto_approve
3. A2AToolAdapter handler called with args
4. Handler extracts 'message' parameter
5. A2AManager.executeSkill("weather-agent__get_forecast", args, sessionCtx)
6. Manager parses prefix → finds agent "weather-agent"
7. Manager gets/creates contextId for this agent+session
8. A2AClient.sendMessage() or sendMessageStream()
9. SDK sends JSON-RPC to remote agent
10. Response processed → IA2AToolResult
11. A2AToolAdapter.formatA2AResult() → string for LLM
```

### Data Flow: Agent Discovery & Connection

```
1. User adds agent URL in A2ASettings.svelte
2. UI sends A2A_ADD_AGENT message → service worker
3. Service worker → A2AManager.addAgent()
4. Config created with UUID, persisted to chrome.storage.local
5. User clicks "Connect"
6. UI sends A2A_CONNECT message → service worker
7. A2AManager.connect(id):
   a. Creates A2AClient with config URL + auth
   b. A2AClient creates ClientFactory → Client
   c. Client fetches agent card from URL
   d. Skills extracted from agent card
   e. Connection status → 'connected'
   f. Emits 'skills-updated' event
8. Event handler → registerA2ASkills() → ToolRegistry
9. Skills now available to LLM agent
```

## Component Specifications

### 1. types.ts

Defines all A2A type interfaces. Mirrors `src/core/mcp/types.ts` structure.

**Key types**:
- `IA2AAgentConfig`, `IA2AAgentConfigCreate`, `IA2AAgentConfigUpdate` — configuration CRUD
- `IA2AConnection`, `A2AConnectionStatus` — runtime connection state
- `IA2ASkill` — skill metadata from agent card
- `IA2AToolResult`, `IA2AContent` — tool execution results
- `A2AManagerEvent` — event union for pub/sub
- `A2AStreamEvent` — streaming event types
- `A2AMessageType` — Chrome runtime message type discriminators

See `contracts/a2a-manager-interface.ts` for full type definitions.

### 2. A2AConfig.ts

Zod validation schemas and storage helpers. Mirrors `src/core/mcp/MCPConfig.ts`.

**Schemas**:
- `A2AAgentNameSchema`: 1-50 chars, `[a-zA-Z0-9-]`
- `A2AAgentUrlSchema`: valid HTTP(S) URL
- `A2ATimeoutSchema`: 5000-180000, default 30000
- `A2AAuthTypeSchema`: `'apiKey' | 'bearer' | 'none'`
- `A2AAgentConfigSchema`: full config validation
- `A2AAgentConfigCreateSchema`: input validation

**Storage helpers**:
- `loadAgents()`: Load from `chrome.storage.local` key `'a2aAgents'`
- `saveAgents(configs)`: Persist validated configs
- `createAgentConfig(input, existing)`: Generate UUID, validate uniqueness
- `updateAgentConfig(existing, update, all)`: Merge and validate

### 3. A2AClient.ts

Wraps `@a2a-js/sdk` `ClientFactory` + `Client` with authentication and error mapping.

**Constructor**:
```typescript
constructor(options: {
  config: IA2AAgentConfig;
  apiKey?: string;         // Decrypted
  onStatusChange?: (status, error?) => void;
  onSkillsChange?: (skills) => void;
})
```

**Key methods**:
- `connect()`: Create `ClientFactory`, fetch agent card, discover skills
- `disconnect()`: Clean up client instance
- `sendMessage(message, contextId?, taskId?)`: Synchronous request
- `sendMessageStream(message, contextId?, onEvent?)`: Streaming request
- `cancelTask(taskId)`: Cancel a running task
- `getTask(taskId)`: Get task state

**Authentication injection**:
```typescript
private createAuthFetch(): typeof fetch {
  if (this.options.config.authType === 'none') return fetch;

  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (this.options.config.authType === 'bearer') {
      headers.set('Authorization', `Bearer ${this.options.apiKey}`);
    } else if (this.options.config.authType === 'apiKey') {
      headers.set('X-API-Key', this.options.apiKey!);
    }
    return fetch(input, { ...init, headers });
  };
}
```

**Error mapping**: Catch SDK errors (`TaskNotFoundError`, `UnsupportedOperationError`, etc.) and map to consistent error strings for the manager.

### 4. A2AManager.ts

Singleton manager for all A2A agent connections. Mirrors `src/core/mcp/MCPManager.ts`.

**Singleton pattern**:
```typescript
static async getInstance(platform?: A2APlatformScope): Promise<A2AManager>
```

**State**:
- `servers: Map<string, IA2AAgentConfig>` — persisted configurations
- `clients: Map<string, A2AClient>` — active client instances
- `connections: Map<string, IA2AConnection>` — runtime connection state
- `sessionContexts: Map<string, string>` — agentName → contextId per session
- `eventHandlers: Set<(event) => void>` — event subscribers

**Key behaviors**:
- `connect(id)`: Creates A2AClient, fetches agent card, discovers skills, emits events
- `disconnect(id)`: Cleans up client, removes skills, emits events
- `executeSkill(prefixedName, args, sessionCtxId?)`: Parses prefix, routes to correct client, manages contextId
- `executeSkillStream(...)`: Same as executeSkill but uses streaming transport
- `cancelTask(agentName, taskId)`: Routes cancel to correct client
- `setSessionContextId(agentName, contextId)`: Set context for agent+session
- `clearSessionContexts()`: Clear all contexts (called when conversation ends)

**Context ID management**:
- On first invocation to an agent in a session: generate UUID, store in `sessionContexts`
- On subsequent invocations: reuse stored contextId
- On conversation end: `clearSessionContexts()` called by session cleanup

### 5. A2AToolAdapter.ts

Adapts A2A skills to ToolDefinition format. Mirrors `src/core/mcp/MCPToolAdapter.ts`.

**Skill → ToolDefinition adaptation**:
- Tool name: `${agentName}__${skill.id}`
- Description: `[${agentName}] ${skill.description}`
- Parameters: Single `message` text field (A2A skills accept natural language, unlike MCP tools with JSON Schema)

```typescript
function adaptSkill(skill: IA2ASkill, agentName: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: `${agentName}__${skill.id}`,
      description: `[${agentName}] ${skill.description}`,
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: `Message to send to the ${agentName} agent for the "${skill.name}" skill`,
          },
        },
        required: ['message'],
      },
    },
  };
}
```

**Risk Assessor**:
```typescript
class A2ARiskAssessor implements IRiskAssessor {
  constructor(private trusted: boolean) {}

  assess(toolName, parameters, context): RiskAssessment {
    const score = this.trusted ? 10 : 45;
    const level = this.trusted ? RiskLevel.Low : RiskLevel.Medium;
    return {
      score,
      level,
      factors: this.trusted
        ? ['Trusted A2A agent']
        : ['External A2A agent call', 'Network boundary crossing'],
      action: this.trusted ? 'auto_approve' : 'ask_user',
    };
  }
}
```

**Result formatting**:
- TextPart → text as-is
- FilePart → `"[File: name] (mimeType) uri"`
- DataPart → `JSON.stringify(data, null, 2)`

### 6. Service Worker Integration

Add to `src/extension/background/service-worker.ts`:

**Initialization** (in startup sequence, after MCP setup):
```typescript
// Initialize A2AManager singleton
a2aManager = await A2AManager.getInstance();

// Subscribe to events for tool registration
setupA2AToolRegistration();

// Auto-connect enabled agents
await autoConnectEnabledA2AAgents();

// Register message handlers
setupA2AMessageHandlers();
```

**Message handlers** (mirror MCP pattern):
- `A2A_GET_AGENTS` → `a2aManager.getAgents()`
- `A2A_ADD_AGENT` → `a2aManager.addAgent(payload)`
- `A2A_UPDATE_AGENT` → `a2aManager.updateAgent(id, update)`
- `A2A_REMOVE_AGENT` → `a2aManager.removeAgent(id)`
- `A2A_CONNECT` → `a2aManager.connect(id)`
- `A2A_DISCONNECT` → `a2aManager.disconnect(id)`
- `A2A_GET_CONNECTION` → `a2aManager.getConnection(id)`
- `A2A_GET_CONNECTIONS` → `a2aManager.getConnections()`
- `A2A_GET_ALL_SKILLS` → `a2aManager.getAllSkills()`
- `A2A_EXECUTE_SKILL` → `a2aManager.executeSkill(prefixedName, args)`
- `A2A_CANCEL_TASK` → `a2aManager.cancelTask(agentName, taskId)`

**Tool registration** (event-driven):
```typescript
function setupA2AToolRegistration() {
  a2aManager.on('event', async (event) => {
    if (event.type === 'skills-updated') {
      const config = a2aManager.getAgent(event.configId);
      if (event.skills.length > 0) {
        await registerA2ASkills(a2aManager, config.name, event.skills, toolRegistry, config.trusted);
      }
    }
    if (event.type === 'connection-status-changed') {
      if (event.status === 'disconnected' || event.status === 'error') {
        await unregisterA2ASkills(config.name, previousSkills, toolRegistry);
      }
    }
  });
}
```

### 7. MessageRouter Extension

Add A2A message types to `src/core/MessageRouter.ts` `MessageType` enum:

```typescript
// A2A message types
A2A_GET_AGENTS = 'A2A_GET_AGENTS',
A2A_ADD_AGENT = 'A2A_ADD_AGENT',
A2A_UPDATE_AGENT = 'A2A_UPDATE_AGENT',
A2A_REMOVE_AGENT = 'A2A_REMOVE_AGENT',
A2A_CONNECT = 'A2A_CONNECT',
A2A_DISCONNECT = 'A2A_DISCONNECT',
A2A_GET_CONNECTION = 'A2A_GET_CONNECTION',
A2A_GET_CONNECTIONS = 'A2A_GET_CONNECTIONS',
A2A_GET_ALL_SKILLS = 'A2A_GET_ALL_SKILLS',
A2A_EXECUTE_SKILL = 'A2A_EXECUTE_SKILL',
A2A_CANCEL_TASK = 'A2A_CANCEL_TASK',
```

### 8. Settings UI (A2ASettings.svelte)

Mirror `src/sidepanel/settings/MCPSettings.svelte` layout:

- Agent list with connection status badges (disconnected/connecting/connected/error)
- "Add Agent" button → modal with fields: Name, URL, Auth Type, API Key, Timeout, Trusted
- Per-agent actions: Connect, Disconnect, Edit, Remove
- Expanded view: shows agent card details (name, description, version, skills list)
- Debug logging toggle (advanced settings)

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SDK | `@a2a-js/sdk` ClientFactory + Client | Official SDK, browser-compatible, ESM |
| Transport | JSON-RPC (auto HTTP+JSON fallback) | A2A default, both browser-safe |
| Module location | `src/core/a2a/` | Parallel to `src/core/mcp/`, proven pattern |
| Tool naming | `agentName__skillId` | Matches MCP convention (double underscore) |
| Skill parameters | Single `message` text field | A2A skills take natural language, not structured JSON |
| Context lifecycle | Per agent per session | Enables multi-turn, cleared on session end |
| Approval default | Score 45 (medium, ask_user) | External network call warrants approval |
| Trust override | Score 10 (low, auto_approve) | Per-agent `trusted` flag in config |
| Auth injection | Custom fetch wrapper | SDK supports `fetchImpl`, works in both platforms |

## Complexity Tracking

No constitution violations to justify.
