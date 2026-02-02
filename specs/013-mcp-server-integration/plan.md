# Implementation Plan: MCP Server Integration

**Branch**: `013-mcp-server-integration` | **Date**: 2026-02-01 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-mcp-server-integration/spec.md`

## Summary

Enable browserx to connect to MCP (Model Context Protocol) servers via HTTP/SSE transport, discover tools and resources from those servers, and integrate them into the agent's existing ToolRegistry. This extends the agent's capabilities with external tools without modifying core agent logic.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (ES2020 target)
**Primary Dependencies**: @modelcontextprotocol/sdk, Svelte 4.2.20, Chrome Extension APIs
**Storage**: chrome.storage.local for MCP server configurations
**Testing**: Vitest for unit/integration tests
**Target Platform**: Chrome Extension (Manifest V3)
**Project Type**: Chrome Extension (service worker + sidepanel)
**Performance Goals**: Tool discovery <5s, tool execution within configured timeout (default 30s)
**Constraints**: No subprocess spawning (browser sandbox), SSE/HTTP transport only
**Scale/Scope**: Up to 5 concurrent MCP server connections

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| **I. Privacy-First Architecture** | ✅ PASS | All MCP connections originate from user's browser; configs stored in local chrome.storage; API keys encrypted per existing pattern |
| **II. Test-Driven Development** | ✅ PASS | Plan includes unit tests for MCP client, integration tests for tool execution, contract tests for MCP protocol compliance |
| **III. Multi-Provider Compatibility** | ✅ PASS | MCP integration follows existing provider patterns; MCPToolAdapter wraps MCP tools in standard ToolDefinition format |
| **IV. Reliability & Graceful Degradation** | ✅ PASS | MCP failures don't affect built-in tools; connection errors surface clear messages; auto-reconnect on disconnection |
| **V. Simplicity & YAGNI** | ✅ PASS | Uses official MCP SDK (no custom protocol implementation); single MCPClient class per connection; no premature abstractions |

**Security Requirements Check**:
- ✅ API keys encrypted in chrome.storage (existing pattern)
- ✅ MCP server URLs validated before connection
- ✅ No inline script injection (uses message passing)

## Project Structure

### Documentation (this feature)

```text
specs/013-mcp-server-integration/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── mcp-types.ts     # MCP-related TypeScript interfaces
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── mcp/                          # NEW: MCP integration module
│   ├── MCPClient.ts              # MCP SDK wrapper for single server connection
│   ├── MCPManager.ts             # Manages multiple MCP connections
│   ├── MCPToolAdapter.ts         # Converts MCP tools to ToolDefinition format
│   ├── MCPConfig.ts              # MCP server configuration types and storage
│   ├── transports/
│   │   └── SSEClientTransport.ts # Custom SSE transport for browser context
│   └── __tests__/
│       ├── MCPClient.test.ts
│       ├── MCPManager.test.ts
│       └── MCPToolAdapter.test.ts
│
├── config/
│   └── types.ts                  # MODIFY: Add IMCPServerConfig interface
│
├── sidepanel/
│   └── settings/
│       └── MCPSettings.svelte    # NEW: MCP server management UI
│
├── tools/
│   └── index.ts                  # MODIFY: Register MCP tools from connected servers
│
└── background/
    └── service-worker.ts         # MODIFY: Initialize MCPManager on startup

tests/
├── unit/
│   └── mcp/
│       ├── MCPClient.test.ts
│       ├── MCPToolAdapter.test.ts
│       └── SSEClientTransport.test.ts
├── integration/
│   └── mcp/
│       └── mcp-tool-execution.test.ts
└── contract/
    └── mcp/
        └── mcp-protocol.test.ts
```

**Structure Decision**: Follows existing project structure with new `src/mcp/` module for MCP-specific code. Integrates with existing `src/config/`, `src/tools/`, and `src/sidepanel/` modules.

## Complexity Tracking

No Constitution Check violations requiring justification.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Sidepanel UI                                 │
│  ┌─────────────────┐  ┌──────────────────────────────────────┐  │
│  │ MCPSettings.svelte│ │ Existing Settings (API keys, etc.)  │  │
│  │ - Add/edit/remove│ │                                      │  │
│  │ - Show status    │ │                                      │  │
│  │ - List tools     │ └──────────────────────────────────────┘  │
│  └────────┬─────────┘                                           │
└───────────┼─────────────────────────────────────────────────────┘
            │ chrome.runtime.sendMessage
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Service Worker                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     MCPManager                               ││
│  │  - Manages multiple MCPClient instances                     ││
│  │  - Persists/restores configs from chrome.storage            ││
│  │  - Handles reconnection on extension restart                ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         ││
│  │  │ MCPClient 1 │  │ MCPClient 2 │  │ MCPClient N │         ││
│  │  │ (server A)  │  │ (server B)  │  │ (server N)  │         ││
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         ││
│  └─────────┼────────────────┼────────────────┼─────────────────┘│
│            │                │                │                  │
│  ┌─────────▼────────────────▼────────────────▼─────────────────┐│
│  │                   ToolRegistry                               ││
│  │  ┌──────────────┐  ┌────────────────────────────────┐       ││
│  │  │ Built-in     │  │ MCP Tools (via MCPToolAdapter) │       ││
│  │  │ - dom_tool   │  │ - serverA:tool1                │       ││
│  │  │ - navigate   │  │ - serverA:tool2                │       ││
│  │  │ - etc.       │  │ - serverB:tool1                │       ││
│  │  └──────────────┘  └────────────────────────────────┘       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
            │
            │ HTTP/SSE (fetch + EventSource)
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   External MCP Servers                          │
│  ┌─────────────────┐  ┌─────────────────┐                      │
│  │ MCP Server A    │  │ MCP Server B    │  ...                 │
│  │ (e.g., GitHub)  │  │ (e.g., Files)   │                      │
│  └─────────────────┘  └─────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Custom SSE Transport
The official MCP SDK doesn't include a browser-compatible transport. We'll create `SSEClientTransport` that:
- Uses `fetch()` for client→server messages (POST to MCP endpoint)
- Uses `EventSource` for server→client messages (SSE stream)
- Handles session management via `Mcp-Session-Id` header

### 2. Tool Name Prefixing
MCP tools are registered with server name prefix to avoid conflicts:
- `github:search_repositories` instead of `search_repositories`
- Allows same tool name from different servers
- Clear provenance for debugging

### 3. Lazy Connection
MCP servers connect lazily on first tool use OR explicitly via settings UI:
- Extension startup restores configurations but doesn't auto-connect
- User can trigger connect/disconnect from settings
- Reduces startup latency

### 4. Graceful Degradation
MCP failures are isolated from core functionality:
- If MCP server is unavailable, built-in tools continue working
- Tool execution errors include server context
- Connection status visible in UI

## Implementation Phases

### Phase 1: Core Infrastructure (P1 User Story)
1. Create `SSEClientTransport` class
2. Create `MCPClient` class wrapping MCP SDK
3. Create `MCPConfig` types and storage helpers
4. Create `MCPManager` singleton for connection management
5. Add message handlers in service-worker.ts

### Phase 2: Tool Integration (P2 User Story)
1. Create `MCPToolAdapter` to convert MCP tools to ToolDefinition
2. Modify ToolRegistry to support dynamic registration/unregistration
3. Integrate MCP tools into agent's tool list
4. Handle tool execution routing to correct MCP client

### Phase 3: Settings UI (P1/P3 User Stories)
1. Create `MCPSettings.svelte` component
2. Add MCP section to Settings page
3. Show connection status, available tools
4. Enable add/edit/remove server configurations

### Phase 4: Resources Support (P4 User Story)
1. Add resource discovery to MCPClient
2. Create resource retrieval method
3. Integrate resources into agent context (if applicable)

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| MCP SDK browser incompatibility | Custom SSE transport; fallback to raw fetch if SDK issues |
| CORS issues with MCP servers | Document requirement for CORS headers; test with local servers |
| Extension service worker lifecycle | Persist connection configs; reconnect on wake |
| Tool name conflicts | Server name prefixing enforced |
| Large resource responses | Truncation/streaming with token limit awareness |
