# Research: MCP Server Integration

**Feature**: 013-mcp-server-integration
**Date**: 2026-02-01

## Research Questions Resolved

### 1. MCP SDK Browser Compatibility

**Decision**: Use official MCP SDK (@modelcontextprotocol/sdk) with custom SSE transport

**Rationale**:
- Official SDK handles protocol negotiation, message formatting, and type definitions
- SDK is transport-agnostic; we provide custom `SSEClientTransport` for browser context
- Avoids reimplementing MCP protocol (error-prone, maintenance burden)

**Alternatives Considered**:
- **Implement MCP protocol from scratch**: Rejected - high complexity, divergence risk
- **Use community browser transport (@mcp-b/transports)**: Rejected - less maintained, adds dependency

**Key Findings**:
```typescript
// MCP SDK exports for client-side usage
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Client is transport-agnostic
const client = new Client(
  { name: "browserx", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// We provide custom transport
await client.connect(new SSEClientTransport({ url: serverUrl }));
```

### 2. Browser Transport Implementation

**Decision**: Implement `SSEClientTransport` using fetch + EventSource

**Rationale**:
- `fetch()` for client→server (POST JSON-RPC messages)
- `EventSource` for server→client (SSE stream for notifications/responses)
- Matches MCP "Streamable HTTP" transport specification
- Native browser APIs, no additional dependencies

**Alternatives Considered**:
- **WebSocket-based transport**: Rejected - not part of MCP spec, requires server support
- **Long-polling**: Rejected - inefficient, higher latency

**Implementation Pattern**:
```typescript
class SSEClientTransport implements Transport {
  private eventSource: EventSource | null = null;
  private sessionId: string | null = null;

  async start(): Promise<void> {
    // Open SSE connection for server→client
    this.eventSource = new EventSource(this.url);
    this.eventSource.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.onMessage?.(message);
    };
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // POST for client→server
    await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.sessionId && { 'Mcp-Session-Id': this.sessionId })
      },
      body: JSON.stringify(message)
    });
  }
}
```

### 3. Tool Integration with Existing ToolRegistry

**Decision**: Use `MCPToolAdapter` to convert MCP tools to `ToolDefinition` format

**Rationale**:
- ToolRegistry already supports dynamic registration via `register()`
- MCP tool schema (JSON Schema) matches `ResponsesApiTool.parameters`
- Adapter pattern isolates MCP-specific logic
- Server name prefix ensures uniqueness

**Implementation Pattern**:
```typescript
function adaptMCPTool(mcpTool: MCPTool, serverName: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: `${serverName}:${mcpTool.name}`,  // Prefixed name
      description: mcpTool.description,
      strict: false,
      parameters: mcpTool.inputSchema as JsonSchema
    }
  };
}

// Handler routes to correct MCP client
async function createMCPToolHandler(
  mcpManager: MCPManager,
  serverName: string,
  toolName: string
): ToolHandler {
  return async (params, context) => {
    const client = mcpManager.getClient(serverName);
    const result = await client.callTool({ name: toolName, arguments: params });

    if (result.isError) {
      throw new Error(result.content[0]?.text || 'MCP tool error');
    }

    return result.content.map(c => c.type === 'text' ? c.text : c).join('\n');
  };
}
```

### 4. Configuration Storage

**Decision**: Store MCP configs in `chrome.storage.local` under `mcpServers` key

**Rationale**:
- Consistent with existing `AgentConfig` storage pattern
- Persists across extension restarts
- API keys encrypted using existing `encryptApiKey()` utility

**Schema**:
```typescript
interface IMCPServerConfig {
  id: string;           // UUID
  name: string;         // Display name (used as tool prefix)
  url: string;          // Server URL
  apiKey?: string;      // Encrypted API key (if required)
  enabled: boolean;     // Whether to auto-connect
  timeout: number;      // Request timeout in ms (default 30000)
  createdAt: number;    // Timestamp
  updatedAt: number;    // Timestamp
}

// Storage structure
{
  mcpServers: IMCPServerConfig[]
}
```

### 5. Connection Lifecycle Management

**Decision**: Lazy connection with explicit user control

**Rationale**:
- Reduces extension startup time (no blocking MCP connections)
- Users control when to connect/disconnect
- Reconnection handled automatically on network recovery
- Service worker lifecycle requires reconnection strategy

**Lifecycle**:
1. Extension starts → Load configs from storage → No auto-connect
2. User opens Settings → See saved servers with "Disconnected" status
3. User clicks "Connect" → MCPManager connects → Discovers tools → Registers with ToolRegistry
4. Service worker suspended → Connections dropped
5. Service worker wakes (on message) → Reconnect if `enabled: true`

### 6. Error Handling Strategy

**Decision**: Structured error handling with user-visible messages

**Rationale**:
- MCP errors should not crash the extension
- Users need actionable feedback
- Logging for debugging

**Error Categories**:

| Category | Handling |
|----------|----------|
| Connection failed | Show in UI: "Failed to connect: {reason}" |
| Authentication error | Show in UI: "Authentication failed - check API key" |
| Tool execution error | Return to agent as tool error, include server context |
| Protocol error | Log, disconnect, show "Server error - reconnecting..." |
| Timeout | Retry once, then fail with "Server not responding" |
| Network lost | Auto-reconnect with exponential backoff |

### 7. SDK Version and Protocol Compatibility

**Decision**: Target MCP protocol version 2025-06-18 (latest stable)

**Rationale**:
- Latest features including Streamable HTTP transport
- Backward compatible with older servers
- Version negotiation happens during handshake

**npm Package**:
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

## Best Practices Identified

### From MCP Specification

1. **Session Management**: Use `Mcp-Session-Id` header for stateful connections
2. **Progress Notifications**: Handle long-running tools via progress events
3. **Capability Negotiation**: Only use features server advertises
4. **Error Codes**: Use JSON-RPC error codes (-32700 to -32099)

### From Existing Browserx Patterns

1. **Singleton Pattern**: MCPManager follows AgentConfig singleton pattern
2. **Event Emission**: Emit events for status changes (connect, disconnect, error)
3. **Encryption**: Use existing `encryptApiKey()`/`decryptApiKey()` for credentials
4. **Validation**: Use Zod schemas for config validation (existing pattern)

## Dependencies to Add

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

No peer dependencies required beyond existing (zod already present).

## Testing Strategy

### Unit Tests
- `SSEClientTransport`: Mock fetch/EventSource, test message serialization
- `MCPClient`: Mock transport, test tool/resource listing, error handling
- `MCPToolAdapter`: Test tool definition conversion, name prefixing
- `MCPManager`: Test multi-client management, config persistence

### Integration Tests
- Connect to local mock MCP server
- Execute tool calls end-to-end
- Test reconnection after disconnect

### Contract Tests
- Verify MCP protocol compliance
- Test against reference MCP server
