# RepublicAgent Refactoring Tasks

> Implementation tasks for the RepublicAgentEngine & Platform Abstraction refactoring.
> See [refactor-republic-agent.md](./refactor-republic-agent.md) for full design details.

## Overview

| Phase | Description | Tasks | Critical Path |
|-------|-------------|-------|---------------|
| Phase 1 | Core Engine (Foundation) | E1.1 - E1.5 | ✅ Yes |
| Phase 2 | Platform Abstraction | P2.1 - P2.5 | ✅ Yes |
| Phase 3 | RepublicAgent Refactoring | R3.1 - R3.4 | ✅ Yes |
| Phase 4 | Tool Registry Cloning | T4.1 - T4.3 | No |
| Phase 5 | Sub-Agent Integration | S5.1 - S5.7 | ✅ Yes |

**Critical Path:** `E1.1 → E1.4 → R3.1 → R3.2 → S5.5`

---

## Phase 1: Core Engine (Foundation)

| Task | Status | File | Description | Blocked By |
|------|--------|------|-------------|------------|
| E1.1 | ✅ | `src/core/engine/RepublicAgentEngineConfig.ts` | Define config + result + operation types | — |
| E1.2 | ✅ | `src/core/events/IEventRouter.ts` | Define event routing interface | — |
| E1.3 | ✅ | `src/core/events/SubAgentEventRouter.ts` | Implement sub-agent router | E1.2 |
| E1.4 | ✅ | `src/core/engine/RepublicAgentEngine.ts` | Implement engine with SQ/EQ | E1.1, E1.3 |
| E1.5 | ⬜ | — | Unit tests for RepublicAgentEngine | E1.4 |

### E1.1 Details: RepublicAgentEngineConfig.ts
- `RepublicAgentEngineConfig` interface
- `EngineResult` interface
- `EngineOp` union type (UserInput, UserTurn, Interrupt, ExecApproval, PatchApproval, Compact, ClearHistory)
- `RunOptions` interface
- `ExecutionContext` interface
- `Submission` interface

### E1.4 Details: RepublicAgentEngine.ts (~400 lines)
- Submission Queue (SQ) management
- Event Queue (EQ) management
- `initialize()` - create model client, TurnContext, wire session
- `submitOperation()` - add to SQ, trigger processing
- `getNextEvent()` - pull from EQ (blocking)
- `run()` - awaitable single-prompt execution
- `runMultiple()` - awaitable multi-prompt execution
- `createChildEngine()` - factory for sub-agent engines
- Approval routing (if `approvalGate` provided)
- Lifecycle management (`dispose()`)

---

## Phase 2: Platform Abstraction

| Task | Status | File | Description | Blocked By |
|------|--------|------|-------------|------------|
| P2.1 | ✅ | `src/core/platform/IPlatformAdapter.ts` | Define interface + types | — |
| P2.2 | ✅ | `src/extension/platform/ExtensionPlatformAdapter.ts` | Implement for extension | P2.1 |
| P2.3 | ✅ | `src/desktop/platform/DesktopPlatformAdapter.ts` | Implement for desktop | P2.1 |
| P2.4 | ✅ | `src/server/platform/ServerPlatformAdapter.ts` | Implement for server | P2.1 |
| P2.5 | ⬜ | — | Unit tests for each adapter | P2.2, P2.3, P2.4 |

### P2.1 Details: IPlatformAdapter.ts
- `platformId`: 'extension' | 'desktop' | 'server'
- `hasRealTabs`: boolean
- `hasBrowserTools`: boolean
- Tab management: `createTab()`, `closeTab()`, `validateTab()`, `switchTab()`
- Browser: `getBrowserController()`
- Tools: `registerPlatformTools()`, `getApprovalPolicies()`
- Storage: `getConfigStorage()`, `getCredentialStore()`, `getStorageProvider()`
- Lifecycle: `initialize()`, `dispose()`

### P2.2 Details: ExtensionPlatformAdapter.ts
- Uses `chrome.tabs` API for real tab management
- Uses `ChromeDebuggerClient` for browser control
- Registers extension-specific browser tools (DOM, screenshot)
- Risk enhancers: DomainSensitivity, SemanticElement, SensitivePath

### P2.3 Details: DesktopPlatformAdapter.ts
- Sentinel tabId (MCP manages tabs internally)
- Uses `MCPBrowserController` via chrome-devtools-mcp
- Registers terminal tool, settings tool
- MCP connection handling in `initialize()`

### P2.4 Details: ServerPlatformAdapter.ts
- Sentinel tabId (no real tabs)
- Optional external browser MCP connection
- Registers user MCP servers via plugin system
- Environment-based browser endpoint configuration

---

## Phase 3: RepublicAgent Refactoring

| Task | Status | File | Description | Blocked By |
|------|--------|------|-------------|------------|
| R3.1 | ⬜ | `src/core/RepublicAgent.ts` | Refactor to use RepublicAgentEngine internally | E1.4, P2.2, P2.3, P2.4 |
| R3.2 | ⬜ | `src/core/RepublicAgent.ts` | Add `createChildEngine()` method | R3.1 |
| R3.3 | ⬜ | `src/*/bootstrap/*.ts` | Update bootstraps to create adapters | R3.1 |
| R3.4 | ⬜ | — | Integration tests for RepublicAgent | R3.2 |

### R3.1 Details: RepublicAgent Refactoring (~350 lines)
- Accept `IPlatformAdapter` in constructor
- Create internal `RepublicAgentEngine` instance
- Delegate all execution operations to engine
- Keep orchestration concerns:
  - Tab binding (via platform adapter)
  - Config subscriptions (model hot-swap)
  - Channel dispatch (setEventDispatcher)
  - Session queries (history, compaction, isReady)
- Remove all `__BUILD_MODE__` checks

### R3.2 Details: createChildEngine()
- Clone tool registry with restrictions
- Create child engine with:
  - No `approvalGate` (auto-approve)
  - Ephemeral session (`persistent: false`)
  - Optional browser context
  - Event router for namespacing

### R3.3 Details: Bootstrap Updates
- `src/extension/bootstrap/*.ts` → use `ExtensionPlatformAdapter`
- `src/desktop/bootstrap/*.ts` → use `DesktopPlatformAdapter`
- `src/server/bootstrap/*.ts` → use `ServerPlatformAdapter`

---

## Phase 4: Tool Registry Cloning

| Task | Status | File | Description | Blocked By |
|------|--------|------|-------------|------------|
| T4.1 | ✅ | `src/tools/ToolRegistry.ts` | Add `entries()` method | — |
| T4.2 | ✅ | `src/tools/ToolRegistryCloner.ts` | Implement cloning utilities | T4.1 |
| T4.3 | ⬜ | — | Unit tests for cloning | T4.2 |

### T4.2 Details: ToolRegistryCloner.ts
- `cloneForSubAgent(registry, options)`:
  - `allow?: string[]` - only include these tools
  - `deny?: string[]` - exclude these tools
  - Always exclude `sub_agent` tool (prevent nesting)
- Shallow clone tool definitions (handlers reference parent context)

---

## Phase 5: Sub-Agent Integration

| Task | Status | File | Description | Blocked By |
|------|--------|------|-------------|------------|
| S5.1 | ✅ | `src/core/subagent/types.ts` | Define type config interface | — |
| S5.2 | ✅ | `src/core/subagent/builtinTypes.ts` | Define built-in sub-agent types | S5.1 |
| S5.3 | ✅ | `src/core/subagent/SubAgentTool.ts` | Build tool definition | S5.2 |
| S5.4 | ✅ | `src/core/subagent/SubAgentRegistry.ts` | Track active sub-agents | — |
| S5.5 | ✅ | `src/core/subagent/SubAgentRunner.ts` | Implement runner | R3.2, T4.2, S5.3, S5.4 |
| S5.6 | ✅ | `src/core/subagent/register.ts` | Bootstrap registration helper | S5.5 |
| S5.7 | ⬜ | — | Integration tests | S5.6 |

### S5.1 Details: types.ts
```typescript
interface SubAgentTypeConfig {
  name: string;
  description: string;
  systemPromptTemplate: string;
  tools?: { allow?: string[]; deny?: string[] };
  maxTurns?: number;
  model?: string;
}

interface SubAgentResult {
  success: boolean;
  response: string | null;
  turnCount: number;
  tokenUsage?: TokenUsage;
  error?: string;
}
```

### S5.2 Details: builtinTypes.ts
- `researcher`: Web search + read-only tools, high maxTurns
- `planner`: Planning + reasoning tools, low maxTurns
- `worker`: Full tool access except sub_agent, medium maxTurns

### S5.3 Details: SubAgentTool.ts
- Tool name: `sub_agent`
- Parameters: `type`, `prompt`, `maxTurns?`, `model?`
- Returns: `SubAgentResult` as JSON string

### S5.4 Details: SubAgentRegistry.ts
- Track active sub-agents by ID
- Concurrency limiting (`maxConcurrent`)
- Cleanup on completion/error

### S5.5 Details: SubAgentRunner.ts
- Resolve type config
- Clone tool registry with restrictions
- Create child engine via `createChildEngine()`
- Execute with `engine.run()`
- Route events to parent
- Return result

---

## Dependency Graph

```
Phase 1 (Engine):
E1.1 ──┬── E1.4 ── E1.5
E1.2 ──┼── E1.3 ──┘
       └──────────┘

Phase 2 (Platform) - parallel with Phase 1:
P2.1 ─┬─ P2.2 ─┐
      ├─ P2.3 ─┼─ P2.5
      └─ P2.4 ─┘

Phase 3 (RepublicAgent):
E1.4 + P2.2/3/4 ─── R3.1 ── R3.2 ── R3.3 ── R3.4

Phase 4 (Cloning) - can start anytime:
T4.1 ── T4.2 ── T4.3

Phase 5 (Sub-Agent):
S5.1 ── S5.2 ── S5.3 ─┐
S5.4 ─────────────────┼── S5.5 ── S5.6 ── S5.7
R3.2 + T4.2 ──────────┘
```

---

## Parallelization Opportunities

| Parallel Track | Tasks |
|----------------|-------|
| Track A | E1.1, E1.2, E1.3, E1.4, E1.5 |
| Track B | P2.1, P2.2, P2.3, P2.4, P2.5 |
| Track C | T4.1, T4.2, T4.3 |
| Track D | S5.1, S5.2, S5.3, S5.4 |

**Sync Points:**
- R3.1 requires E1.4 + P2.2/3/4
- S5.5 requires R3.2 + T4.2 + S5.3 + S5.4

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Completed |
| ⏸️ | Blocked |
| ❌ | Cancelled |
