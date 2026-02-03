# Data Model: Multi-Agent Instances

**Feature**: 015-multi-agent-instances
**Date**: 2026-02-02

## Entity Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      AgentRegistry                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  sessions: Map<sessionId, AgentSession>              │   │
│  │  maxConcurrent: number (default: 3)                  │   │
│  │  primarySessionId: string | null                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│           ┌───────────────┼───────────────┐                │
│           ▼               ▼               ▼                │
│    ┌──────────┐    ┌──────────┐    ┌──────────┐           │
│    │AgentSession   │AgentSession   │AgentSession          │
│    │(primary)│    │(scheduled)│    │(scheduled)│          │
│    └──────────┘    └──────────┘    └──────────┘           │
└─────────────────────────────────────────────────────────────┘
```

---

## Entity: AgentRegistry

Central registry managing all active agent sessions.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `sessions` | `Map<string, AgentSession>` | Active sessions keyed by sessionId |
| `maxConcurrent` | `number` | Maximum allowed concurrent sessions (default: 3) |
| `primarySessionId` | `string \| null` | ID of the user's main session (if active) |

### Validation Rules

- `maxConcurrent` must be >= 1 and <= 10
- `primarySessionId` must reference an existing session or be null
- Session IDs must be unique UUIDs

### Methods

| Method | Description |
|--------|-------------|
| `createSession(config)` | Creates new session, enforces limit |
| `getSession(id)` | Returns session by ID or undefined |
| `getPrimarySession()` | Returns primary user session |
| `removeSession(id)` | Removes and cleans up session |
| `listSessions()` | Returns metadata for all sessions |
| `getActiveCount()` | Returns count of non-terminated sessions |

---

## Entity: AgentSession

Wrapper around BrowserxAgent providing lifecycle management.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Unique identifier (UUID) |
| `state` | `SessionState` | Current lifecycle state |
| `agent` | `BrowserxAgent` | Underlying agent instance |
| `metadata` | `SessionMetadata` | Persisted session info |
| `tabId` | `number \| null` | Bound browser tab |
| `createdAt` | `number` | Creation timestamp (ms) |
| `lastActivityAt` | `number` | Last activity timestamp (ms) |

### Lifecycle States

```
┌──────────────┐
│ initializing │ ─── Session being created, agent starting
└──────┬───────┘
       │ (agent ready)
       ▼
┌──────────────┐     (task submitted)    ┌──────────────┐
│     idle     │ ◄─────────────────────► │    active    │
└──────┬───────┘     (task completed)    └──────┬───────┘
       │                                        │
       │ (close/error)                          │ (tab closed/error)
       ▼                                        ▼
┌──────────────────────────────────────────────────────────┐
│                       terminated                          │
└──────────────────────────────────────────────────────────┘
```

| State | Description |
|-------|-------------|
| `initializing` | Session being created, agent starting up |
| `idle` | Session ready, waiting for user input |
| `active` | Task currently executing |
| `terminated` | Session ended, resources released |

### Validation Rules

- State transitions must follow the lifecycle diagram
- `tabId` can only be set when state is `idle` or `active`
- Terminated sessions cannot transition to any other state

### Methods

| Method | Description |
|--------|-------------|
| `submit(operation)` | Forward operation to agent |
| `getState()` | Returns current lifecycle state |
| `setState(state)` | Transitions to new state |
| `bindTab(tabId)` | Binds session to browser tab |
| `terminate()` | Clean shutdown, release resources |

---

## Entity: SessionMetadata

Persisted information for session resumption.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Unique identifier |
| `conversationId` | `string` | Conversation ID for history lookup |
| `type` | `SessionType` | 'primary' or 'scheduled' |
| `createdAt` | `number` | Creation timestamp (ms) |
| `lastActivityAt` | `number` | Last activity timestamp (ms) |
| `tabId` | `number \| null` | Last bound tab ID |
| `scheduledTaskId` | `string \| null` | Associated scheduled task (if any) |

### Session Types

| Type | Description |
|------|-------------|
| `primary` | User's main interactive session |
| `scheduled` | Session created for scheduled task execution |

### Storage

- Stored in IndexedDB `sessions` store
- Indexed by `sessionId` (primary key)
- Indexed by `type` for listing

---

## Entity: SessionConfig

Configuration for creating a new session.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `SessionType` | 'primary' or 'scheduled' |
| `tabId` | `number \| null` | Initial tab binding (optional) |
| `scheduledTaskId` | `string \| null` | Task ID for scheduled sessions |
| `resumeFrom` | `string \| null` | Conversation ID to resume from |

### Validation Rules

- `type` is required
- `scheduledTaskId` required when type is 'scheduled'
- `resumeFrom` must reference existing conversation or be null

---

## Relationships

```
AgentRegistry 1 ──────── * AgentSession
     │                         │
     │                         │ 1:1
     │                         ▼
     │                   BrowserxAgent
     │                         │
     │                         │ 1:1
     │                         ▼
     │                      Session
     │                         │
     │                         │ 1:1
     └─────────────────► SessionMetadata
                           (persisted)
```

- AgentRegistry contains 0..maxConcurrent AgentSessions
- Each AgentSession wraps exactly one BrowserxAgent
- Each BrowserxAgent owns exactly one Session
- SessionMetadata is persisted independently for resumption

---

## State Transitions

### Valid Transitions

| From | To | Trigger |
|------|----|---------|
| `initializing` | `idle` | Agent initialization complete |
| `initializing` | `terminated` | Initialization error |
| `idle` | `active` | Task/submission received |
| `idle` | `terminated` | Session closed by user/system |
| `active` | `idle` | Task completed successfully |
| `active` | `terminated` | Error, tab closed, or force stop |

### Invalid Transitions

- `terminated` → any other state (terminal)
- `active` → `initializing` (cannot reinitialize)
- `idle` → `initializing` (cannot reinitialize)

---

## IndexedDB Schema

No schema changes required. Existing stores support multi-session:

```typescript
// Existing stores (no changes)
SESSIONS: 'sessions'           // SessionMetadata storage
CACHE_ITEMS: 'cache_items'     // Per-session cache
SCHEDULER_TASKS: 'scheduler_tasks'

// Existing indexes (no changes)
BY_SESSION: 'sessionId'
BY_SESSION_TIMESTAMP: ['sessionId', 'timestamp']
```

New SessionMetadata records use existing SESSIONS store with schema:
```typescript
interface StoredSessionMetadata {
  sessionId: string;      // Primary key
  conversationId: string;
  type: 'primary' | 'scheduled';
  createdAt: number;
  lastActivityAt: number;
  tabId: number | null;
  scheduledTaskId: string | null;
}
```
