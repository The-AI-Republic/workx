# Data Model: Dual-Mode Architecture

**Feature**: 001-dual-mode-architecture
**Date**: 2026-02-03

## Core Entities

### 1. ChannelAdapter

Represents a UI channel that can send submissions and receive events.

| Field | Type | Description |
|-------|------|-------------|
| channelId | string | Unique identifier (e.g., "sidepanel-main", "ws-123456") |
| channelType | ChannelType | Type discriminator |
| capabilities | ChannelCapabilities | Feature support flags |

**ChannelType Values**:
- `sidepanel` - Chrome extension side panel
- `tabpage` - Chrome extension tab page
- `tauri` - Tauri desktop frontend
- `websocket` - Remote WebSocket API
- `telegram` - Telegram bot (future)
- `cli` - Terminal UI (future)

**ChannelCapabilities**:
| Field | Type | Description |
|-------|------|-------------|
| streaming | boolean | Supports streaming text deltas |
| approvals | boolean | Can handle approval dialogs |
| media | boolean | Can display images/media |

### 2. SubmissionContext

Context accompanying each Op submission from a channel.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| channelId | string | Yes | Originating channel ID |
| channelType | ChannelType | Yes | Channel type |
| userId | string | No | User identifier (for multi-user channels) |
| sessionId | string | No | Session ID for routing responses |
| tabId | number | No | Browser tab ID (extension mode) |
| replyCallback | function | No | Direct reply function (messaging channels) |

### 3. BrowserConnectionState

Tracks the current browser connection status in native mode.

| Field | Type | Description |
|-------|------|-------------|
| method | ConnectionMethod | How we connected |
| status | ConnectionStatus | Current status |
| port | number | Debug port (if applicable) |
| profilePath | string | Copied profile path (if used) |
| browser | BrowserInfo | Detected browser info |
| error | string | Last error message |

**ConnectionMethod Values**:
- `auto-connect` - Chrome DevTools MCP
- `existing-port` - Connected to existing debug port
- `profile-copy` - Launched with copied profile
- `none` - No browser connection (degraded mode)

**ConnectionStatus Values**:
- `disconnected` - Not connected
- `connecting` - Connection in progress
- `connected` - Active connection
- `error` - Connection failed

### 4. BrowserInfo

Information about detected/connected browser.

| Field | Type | Description |
|-------|------|-------------|
| name | BrowserName | Browser identifier |
| path | string | Executable path |
| profilePath | string | User profile directory |
| version | string | Browser version (if detected) |

**BrowserName Values**:
- `chrome` - Google Chrome
- `edge` - Microsoft Edge
- `chromium` - Chromium

### 5. ProfileCopyResult

Result of profile copy operation.

| Field | Type | Description |
|-------|------|-------------|
| targetPath | string | Where profile was copied |
| duration | number | Copy time in milliseconds |
| sizeBytes | number | Total bytes copied |
| skippedItems | string[] | Items skipped (locked/missing) |

### 6. TerminalCommand

Represents a terminal command execution request.

| Field | Type | Description |
|-------|------|-------------|
| command | string | Command to execute |
| workingDir | string | Working directory |
| timeout | number | Timeout in milliseconds |
| env | Record<string, string> | Environment variables |

### 7. TerminalResult

Result of terminal command execution.

| Field | Type | Description |
|-------|------|-------------|
| exitCode | number | Process exit code |
| stdout | string | Standard output |
| stderr | string | Standard error |
| duration | number | Execution time in milliseconds |
| timedOut | boolean | Whether command timed out |

### 8. SecurityDecision

Result of terminal security filter check.

| Field | Type | Description |
|-------|------|-------------|
| allowed | boolean | Whether command is allowed |
| reason | string | Explanation of decision |
| requiresApproval | boolean | Needs user confirmation |
| blockedPattern | string | Matched blocklist pattern (if blocked) |

### 9. WebSocketClient

Represents a connected WebSocket client.

| Field | Type | Description |
|-------|------|-------------|
| clientId | string | Unique client identifier |
| socket | WebSocket | Socket connection |
| authenticated | boolean | Auth status (for non-localhost) |
| remoteAddress | string | Client IP address |
| connectedAt | number | Connection timestamp |
| sessionId | string | Associated session (if any) |

### 10. PIConfig

Native app configuration structure.

| Field | Type | Description |
|-------|------|-------------|
| general | GeneralConfig | General settings |
| llm | LLMConfig | LLM provider settings |
| agent | AgentConfig | Agent behavior settings |
| channels | ChannelsConfig | Channel configurations |
| mcp | MCPConfig | MCP server settings |
| security | SecurityConfig | Security settings |
| ui | UIConfig | UI preferences |

## Relationships

```
┌─────────────────┐         ┌─────────────────┐
│ ChannelManager  │────────►│ ChannelAdapter  │ (1:N)
└────────┬────────┘         └─────────────────┘
         │
         │ routes to
         ▼
┌─────────────────┐         ┌─────────────────┐
│ BrowserxAgent   │────────►│    Session      │ (1:1)
└────────┬────────┘         └─────────────────┘
         │
         │ uses
         ▼
┌─────────────────┐         ┌─────────────────┐
│  ToolRegistry   │────────►│ BrowserController│ (1:1)
└─────────────────┘         └────────┬────────┘
                                     │
                                     │ uses
                                     ▼
                            ┌─────────────────┐
                            │ DebuggerClient  │
                            └─────────────────┘
```

## State Transitions

### BrowserConnectionState

```
                    ┌──────────────┐
                    │ disconnected │
                    └──────┬───────┘
                           │ initialize()
                           ▼
                    ┌──────────────┐
              ┌─────│  connecting  │─────┐
              │     └──────────────┘     │
              │                          │
     success  │                          │ failure
              ▼                          ▼
       ┌──────────────┐           ┌──────────────┐
       │  connected   │           │    error     │
       └──────┬───────┘           └──────┬───────┘
              │                          │
     dropped  │                          │ retry
              ▼                          │
       ┌──────────────┐                  │
       │ disconnected │◄─────────────────┘
       └──────────────┘
```

### WebSocket Client Lifecycle

```
       connect
          │
          ▼
   ┌──────────────┐
   │  connected   │
   └──────┬───────┘
          │
          │ localhost?
          ▼
    ┌─────┴─────┐
    │           │
   yes          no
    │           │
    ▼           ▼
┌────────┐  ┌────────────┐
│ ready  │  │ awaiting   │
│        │  │ auth       │
└────────┘  └─────┬──────┘
                  │
            auth message
                  │
           ┌──────┴──────┐
           │             │
         valid       invalid
           │             │
           ▼             ▼
     ┌────────┐    ┌────────┐
     │ ready  │    │ closed │
     └────────┘    └────────┘
```

## Storage Collections

### Extension Mode (IndexedDB)

| Collection | Key | Indexes | Description |
|------------|-----|---------|-------------|
| conversations | id | userId, timestamp | Chat sessions |
| messages | id | conversationId, timestamp | Chat messages |
| memory | id | type, embedding | Long-term memory |
| settings | key | - | User preferences |
| cache | key | expiresAt | Temporary cache |

### Native Mode (SQLite)

| Table | Primary Key | Indexes | Description |
|-------|-------------|---------|-------------|
| conversations | id | user_id, created_at | Chat sessions |
| messages | id | conversation_id, timestamp | Chat messages |
| memory | id | type | Long-term memory |
| settings | key | - | User preferences |
| cache | key | expires_at | Temporary cache |
| credentials | key | - | Encrypted credentials |

## Validation Rules

### ChannelAdapter
- `channelId` must be unique across all registered channels
- `channelType` must be a valid enum value

### TerminalCommand
- `command` must not match any blocklist pattern
- `timeout` must be positive, max 600000ms (10 min)
- `workingDir` must exist and be accessible

### WebSocketClient
- Non-localhost clients must authenticate within 30 seconds
- `clientId` must be unique
- Maximum 10 concurrent clients per server

### PIConfig
- `channels.websocket.port` must be 1024-65535
- `security.terminal.timeout` must be positive
- `llm.providers` must have at least one valid provider
