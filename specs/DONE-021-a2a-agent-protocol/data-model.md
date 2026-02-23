# Data Model: A2A Agent-to-Agent Protocol Integration

**Date**: 2026-02-15
**Feature**: 021-a2a-agent-protocol

## Entities

### 1. A2AAgentConfig (Persisted)

Storage key: `'a2aAgents'` in `chrome.storage.local`

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| id | string (UUID v4) | Yes | Unique | Auto-generated identifier |
| name | string | Yes | 1-50 chars, `[a-zA-Z0-9-]` | Display name, used as tool prefix |
| url | string | Yes | Valid HTTP(S) URL | Remote agent's base endpoint |
| apiKey | string | No | Encrypted (Base64+reverse) | Authentication credential |
| authType | `'apiKey' \| 'bearer' \| 'none'` | Yes | Default: `'none'` | Authentication method |
| enabled | boolean | Yes | Default: `true` | Auto-connect on startup |
| trusted | boolean | Yes | Default: `false` | Auto-approve skill invocations |
| timeout | number | Yes | 5000-180000, default 30000 | Request timeout in ms |
| platform | `'shared' \| 'extension' \| 'desktop'` | Yes | Default: `'shared'` | Platform visibility scope |
| createdAt | number | Yes | Epoch ms | Creation timestamp |
| updatedAt | number | Yes | Epoch ms | Last modification timestamp |

**Validation rules**:
- `name` must be unique across all configured agents
- `url` must be a valid HTTP or HTTPS URL
- `timeout` clamped to 5000-180000 range
- Maximum 5 user-configured agents

### 2. A2AConnection (In-Memory Runtime)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| configId | string | Yes | Reference to A2AAgentConfig.id |
| status | `A2AConnectionStatus` | Yes | Current connection state |
| agentCard | AgentCard | No | Fetched agent card (from SDK) |
| skills | A2ASkill[] | Yes | Discovered skills (default: []) |
| lastConnected | number | No | Epoch ms of last successful connection |
| lastError | string | No | Error message if status='error' |

**A2AConnectionStatus**: `'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error'`

### 3. A2ASkill (Derived from AgentCard)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Skill identifier from agent card |
| name | string | Yes | Human-readable skill name |
| description | string | Yes | What the skill does |
| tags | string[] | Yes | Keywords/categories |
| inputModes | string[] | No | Accepted MIME types |
| outputModes | string[] | No | Produced MIME types |

### 4. A2ATaskContext (In-Memory, per Conversation Session)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| agentName | string | Yes | Key: remote agent name |
| contextId | string | Yes | UUID shared across invocations |
| activeTasks | Map<string, A2ATaskState> | Yes | Active task tracking |

### 5. A2ATaskState (In-Memory, per Active Task)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| taskId | string | Yes | A2A task ID from remote agent |
| status | TaskState | Yes | Current lifecycle state |
| createdAt | number | Yes | When task was initiated |
| lastUpdate | number | Yes | Last status update timestamp |

**TaskState** (from A2A protocol): `'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'rejected' | 'auth-required'`

## State Transitions

### A2AConnection Lifecycle

```
disconnected ──connect()──→ connecting ──success──→ connected
     ↑                         │                       │
     │                         │error                  │disconnect()
     │                         ↓                       ↓
     └──────────────────── error ←──────────── disconnecting
```

### A2A Task Lifecycle (Remote Agent Controlled)

```
submitted ──→ working ──→ completed
                │   ↑
                │   │
                ↓   │
          input-required
                │
                ↓
          [user responds] ──→ working (resumes)

Any state ──→ canceled (client-initiated)
Any state ──→ failed (remote agent error)
Any state ──→ rejected (remote agent refused)
```

## Relationships

```
A2AAgentConfig (1) ←──→ (1) A2AConnection
A2AConnection (1) ──→ (0..*) A2ASkill
A2ATaskContext (1) ──→ (0..*) A2ATaskState
A2AAgentConfig.name ──→ A2ATaskContext.agentName (keyed by agent name per session)
A2ASkill ──→ ToolDefinition (via A2AToolAdapter, registered in ToolRegistry)
```

## Storage Schema

### chrome.storage.local

| Key | Type | Description |
|-----|------|-------------|
| `a2aAgents` | A2AAgentConfig[] | Persisted agent configurations |
| `a2aDebugLogging` | boolean | Debug logging toggle |
