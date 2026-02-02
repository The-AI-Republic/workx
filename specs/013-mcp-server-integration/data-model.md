# Data Model: MCP Server Integration

**Feature**: 013-mcp-server-integration
**Date**: 2026-02-01

## Entities

### MCPServerConfig

Persisted configuration for a single MCP server connection.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | UUID v4 identifier |
| name | string | Yes | Display name, also used as tool prefix (e.g., "github" → "github:search") |
| url | string | Yes | Server endpoint URL (must be HTTPS in production) |
| apiKey | string | No | Encrypted API key for authentication |
| enabled | boolean | Yes | Whether to auto-connect on extension startup |
| timeout | number | Yes | Request timeout in milliseconds (default: 30000) |
| createdAt | number | Yes | Unix timestamp of creation |
| updatedAt | number | Yes | Unix timestamp of last update |

**Validation Rules**:
- `name`: 1-50 characters, alphanumeric + hyphens, must be unique across configs
- `url`: Valid URL starting with `http://` or `https://`
- `timeout`: 5000-120000 ms (5 seconds to 2 minutes)

**Storage Location**: `chrome.storage.local` under key `mcpServers`

### MCPConnection

Runtime state for an active MCP server connection (not persisted).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| configId | string | Yes | Reference to MCPServerConfig.id |
| status | MCPConnectionStatus | Yes | Current connection status |
| protocolVersion | string | No | Negotiated MCP protocol version |
| serverInfo | MCPServerInfo | No | Server metadata from handshake |
| capabilities | MCPCapabilities | No | Server capabilities from handshake |
| tools | MCPTool[] | No | Discovered tools |
| resources | MCPResource[] | No | Discovered resources |
| lastConnected | number | No | Unix timestamp of last successful connection |
| lastError | string | No | Last error message (if status is 'error') |

**State Transitions**:
```
disconnected → connecting → connected
                    ↓
connected → disconnecting → disconnected
     ↓
connected → error → disconnected (auto-reconnect) → connecting
```

### MCPConnectionStatus

Enumeration of connection states.

| Value | Description |
|-------|-------------|
| `disconnected` | Not connected, no connection attempt in progress |
| `connecting` | Connection attempt in progress |
| `connected` | Successfully connected, ready for tool calls |
| `disconnecting` | Graceful disconnect in progress |
| `error` | Connection failed or was lost, error details in `lastError` |

### MCPServerInfo

Server metadata returned during initialization.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Server implementation name |
| version | string | Yes | Server version |

### MCPCapabilities

Server capabilities advertised during initialization.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tools | { listChanged?: boolean } | No | Tool capability flags |
| resources | { subscribe?: boolean } | No | Resource capability flags |
| prompts | { listChanged?: boolean } | No | Prompt capability flags |

### MCPTool

Tool definition from MCP server (matches MCP spec).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Tool name (e.g., "search_repositories") |
| description | string | Yes | Human-readable description |
| inputSchema | JSONSchema | Yes | JSON Schema for tool arguments |
| outputSchema | JSONSchema | No | JSON Schema for tool result |

**Derived Field (runtime only)**:
- `prefixedName`: `${serverConfig.name}:${tool.name}` (e.g., "github:search_repositories")

### MCPResource

Resource definition from MCP server (matches MCP spec).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| uri | string | Yes | Resource URI (e.g., "file:///path/to/file") |
| name | string | Yes | Human-readable name |
| description | string | No | Resource description |
| mimeType | string | No | MIME type of resource content |

### MCPToolResult

Result of an MCP tool execution.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| content | MCPContent[] | Yes | Array of content items |
| isError | boolean | No | True if tool execution failed |

### MCPContent

Content item in tool result (union type).

| Variant | Fields | Description |
|---------|--------|-------------|
| TextContent | `type: "text"`, `text: string` | Plain text content |
| ImageContent | `type: "image"`, `data: string`, `mimeType: string` | Base64-encoded image |
| ResourceContent | `type: "resource"`, `resource: MCPResource` | Embedded resource |

## Relationships

```
┌─────────────────────┐
│  MCPServerConfig    │ (persisted in chrome.storage.local)
│  - id               │
│  - name             │
│  - url              │
│  - apiKey           │
│  - enabled          │
└─────────┬───────────┘
          │ 1:1 (runtime only)
          ▼
┌─────────────────────┐
│  MCPConnection      │ (in-memory)
│  - configId ────────┼──► references MCPServerConfig.id
│  - status           │
│  - serverInfo       │
│  - capabilities     │
│  - tools[]  ────────┼──► list of MCPTool
│  - resources[] ─────┼──► list of MCPResource
└─────────────────────┘
          │
          │ N:1 (tools belong to connection)
          ▼
┌─────────────────────┐
│  ToolRegistry       │ (existing)
│  - tools            │
│                     │
│  MCP tools added as:│
│  "{serverName}:     │
│    {toolName}"      │
└─────────────────────┘
```

## Storage Schema

### chrome.storage.local

```typescript
interface MCPStorageSchema {
  // Array of MCP server configurations
  mcpServers: IMCPServerConfig[];

  // Debug logging enabled
  mcpDebugLogging?: boolean;
}
```

### Example Stored Data

```json
{
  "mcpServers": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "github",
      "url": "https://mcp.github.example.com",
      "apiKey": "encrypted:abc123...",
      "enabled": true,
      "timeout": 30000,
      "createdAt": 1706745600000,
      "updatedAt": 1706745600000
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "files",
      "url": "http://localhost:3000/mcp",
      "enabled": false,
      "timeout": 60000,
      "createdAt": 1706745700000,
      "updatedAt": 1706745700000
    }
  ],
  "mcpDebugLogging": false
}
```

## Validation Schemas (Zod)

```typescript
import { z } from 'zod';

export const MCPServerConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9-]+$/, 'Name must be alphanumeric with hyphens'),
  url: z.string().url(),
  apiKey: z.string().optional(),
  enabled: z.boolean(),
  timeout: z.number().min(5000).max(120000).default(30000),
  createdAt: z.number(),
  updatedAt: z.number()
});

export const MCPServerConfigCreateSchema = MCPServerConfigSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export const MCPServerConfigUpdateSchema = MCPServerConfigCreateSchema.partial();

export const MCPToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.any()), // JSON Schema
  outputSchema: z.record(z.any()).optional()
});

export const MCPResourceSchema = z.object({
  uri: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional()
});
```

## Migration

No migration required - new feature with new storage keys. Existing chrome.storage.local data is unaffected.

## Data Lifecycle

| Event | Action |
|-------|--------|
| Extension installed | Empty `mcpServers` array |
| User adds server | Append to `mcpServers`, generate UUID |
| User edits server | Update in array, set `updatedAt` |
| User removes server | Remove from array, disconnect if connected |
| Extension starts | Load `mcpServers`, create MCPConnection instances (disconnected) |
| User connects server | Transition status, populate tools/resources |
| User disables server | Set `enabled: false`, disconnect |
| Connection lost | Set status to `error`, attempt reconnect if `enabled` |
