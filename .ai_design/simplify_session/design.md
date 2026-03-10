# Unified Session ID Design Document

## 1. Problem Statement

The multi-thread feature currently uses **three separate UUIDs** with **three different variable names** to identify what is conceptually one thing — a single agent conversation:

| Variable Name | Layer | Generated At | Format | Purpose |
|---------------|-------|-------------|--------|---------|
| `thread.id` | UI (threadStore) | `threadStore.createThread()` | `<uuid>` | Key for UI state map, active thread tracking |
| `sessionId` | Registry (AgentSession) | `AgentSession` constructor | `session_<uuid>` | Route messages to correct agent instance |
| `conversationId` | Runtime (Session) | `Session` constructor | `<uuid>` | Persist/resume conversation history |

All three have a strict **1:1:1 relationship**. A thread always maps to exactly one agent session, which always maps to exactly one conversation. Yet each layer generates its own ID independently and uses its own variable name, creating unnecessary complexity:

- UI must store `sessionId` as a foreign key on each thread
- `AgentSession` copies `conversationId` from `Session` into its metadata
- Resume flow must carefully preserve `conversationId` while creating a new `sessionId`
- Developers must understand three variable names and three ID namespaces for the same entity

## 2. Proposed Design

**Eliminate `thread.id` and `conversationId` entirely. Use `sessionId` as the single variable name and single value at every layer.**

```
Before:                              After:

Thread.id = "aaa"                    Thread.sessionId = "xyz-789"
Thread.sessionId = "session_bbb"     (id field removed, sessionId is the key)
  │                                    │
  ▼                                    ▼
AgentSession.sessionId = "session_bbb" AgentSession.sessionId = "xyz-789"
AgentSession.conversationId = "ccc"    (conversationId field removed)
  │                                    │
  ▼                                    ▼
Session.conversationId = "ccc"       Session.sessionId = "xyz-789"
                                     (conversationId renamed to sessionId)
```

One variable name (`sessionId`), one value, generated once, used everywhere.

## 3. ID Lifecycle

### 3.1 New Session

```
1. UI requests: serviceRequest('session.create')
2. AgentRegistry.createSession():
   a. Session created → generates sessionId (UUID)
   b. AgentSession created with same sessionId
   c. Returns { sessionId }
3. UI receives sessionId, creates thread:
   threadStore.createThread(sessionId)  // thread.sessionId = sessionId
```

### 3.2 Resume Session

```
1. UI requests: serviceRequest('session.resume', { sessionId })
2. Backend loads history via RolloutRecorder.getRolloutHistory(sessionId)
3. Session created with mode:'resumed', reuses same sessionId
4. AgentSession created with same sessionId
5. UI creates thread with same sessionId
```

Resume is trivial — the same `sessionId` identifies everything across restarts.

### 3.3 Reset Session

Reset = close old session + create new session. No ID mutation needed. The old `sessionId` is retired, a new one is generated.

## 4. Changes Required

### 4.1 `Session` (Session.ts) — rename `conversationId` → `sessionId`

```typescript
// Before:
export class Session {
  readonly conversationId: string;
  constructor(...) {
    if (initialHistory?.mode === 'resumed' && initialHistory.conversationId) {
      this.conversationId = initialHistory.conversationId;
    } else {
      this.conversationId = uuidv4();
    }
  }
}

// After:
export class Session {
  readonly sessionId: string;
  constructor(...) {
    if (initialHistory?.mode === 'resumed' && initialHistory.sessionId) {
      this.sessionId = initialHistory.sessionId;
    } else {
      this.sessionId = uuidv4();
    }
  }
}
```

All references to `conversationId` in Session and its callers become `sessionId`.

### 4.2 `AgentSession` (AgentSession.ts) — adopt sessionId from Session

```typescript
// Before:
constructor(config: SessionConfig) {
  this._sessionId = `session_${uuidv4()}`;  // generates its own ID
}
attachAgent(agent) {
  this._metadata.conversationId = agent.getSession().conversationId;  // copies
}

// After:
constructor(config: SessionConfig & { sessionId: string }) {
  this._sessionId = config.sessionId;  // receives ID from caller
}
attachAgent(agent) {
  // No conversationId copy needed — sessionId is already the same
}
```

- Remove `session_` prefix (no functional value)
- Remove `conversationId` from `SessionMetadata`
- ID is passed in, not generated

### 4.3 `AgentRegistry` (AgentRegistry.ts) — wire the flow

```typescript
// Before:
async createSession(config: SessionConfig) {
  const session = new AgentSession(config);  // AgentSession generates sessionId
  // later: agent created, session.conversationId copied to metadata
}

// After:
async createSession(config: SessionConfig) {
  const agent = new RepublicAgent(...);
  await agent.initialize();
  const sessionId = agent.getSession().sessionId;  // Session generates the ID
  const agentSession = new AgentSession({ ...config, sessionId });
  this._sessions.set(sessionId, agentSession);
}
```

Session is the single source of truth for `sessionId`.

### 4.4 `SidePanelThread` (threadStore.ts) — use sessionId as key

```typescript
// Before:
interface SidePanelThread {
  id: string;        // UI-generated UUID
  sessionId: string; // foreign key to AgentSession
  title: string;
  createdAt: number;
}

// After:
interface SidePanelThread {
  sessionId: string; // the universal ID, also used as map key
  title: string;
  createdAt: number;
}
```

- Remove `id` field — `sessionId` is the key
- Remove `generateUUID()` — ID comes from backend
- `createThread(sessionId, title)` — sessionId provided by caller
- `getThreadBySessionId(sessionId)` → `getThread(sessionId)` (direct lookup)
- `activeThreadId` → `activeSessionId` everywhere in the store
- ThreadBar/ThreadTab events pass `sessionId` instead of `threadId`

### 4.5 `SessionMetadata` (registry/types.ts)

```typescript
// Before:
interface SessionMetadata {
  sessionId: string;
  conversationId: string;  // redundant copy
  type: SessionType;
  // ...
}

// After:
interface SessionMetadata {
  sessionId: string;       // the only ID
  type: SessionType;
  // ...
}
```

### 4.6 `Main.svelte` — simplify thread state management

```typescript
// Before:
let threadStates: Map<string, ThreadConversationState> = new Map();
let activeSessionId: string | null = null;

// threadStore.getThreadBySessionId(sessionId) needed to bridge thread.id ↔ sessionId
// Thread events used threadId, backend calls used sessionId — two names for same thing

// After:
let threadStates: Map<string, ThreadConversationState> = new Map();
let activeSessionId: string | null = null;

// threadStore.getThread(sessionId) — direct lookup, no bridging needed
// All events and backend calls use sessionId consistently
```

- `handleThreadSelect` receives `sessionId` directly
- `switchToThread(sessionId)` — no translation between threadId and sessionId
- `saveThreadState(sessionId)` / `loadThreadState(sessionId)` — keyed by sessionId
- `handleEventForSession` — `threadStore.getThread(sessionId)` instead of `getThreadBySessionId`

### 4.7 `ThreadBar.svelte` / `ThreadTab.svelte` — events use sessionId

```typescript
// Before:
dispatch('threadSelect', { threadId: thread.id });
dispatch('threadClose', { threadId: thread.id });

// After:
dispatch('threadSelect', { sessionId: thread.sessionId });
dispatch('threadClose', { sessionId: thread.sessionId });
```

### 4.8 RolloutRecorder / Persistence

```typescript
// Before:
RolloutRecorder.create(conversationId, ...)
RolloutRecorder.getRolloutHistory(conversationId)

// After:
RolloutRecorder.create(sessionId, ...)
RolloutRecorder.getRolloutHistory(sessionId)
```

The parameter name changes, the storage key format stays the same (plain UUID).

### 4.9 `session-services.ts` — no structural change

```typescript
// 'session.create' response:
return { success: true, sessionId };  // same as before, value now matches everywhere

// 'session.close' params:
const { sessionId } = params;  // same key used for registry lookup AND history lookup
```

### 4.10 `SessionStorage` (registry/SessionStorage.ts)

Remove `conversationId` field from stored records. `sessionId` is the only key.

## 5. Variable Name Rename Reference

Global rename map (all layers):

| Before | After |
|--------|-------|
| `thread.id` | `thread.sessionId` |
| `Thread.id` / `SidePanelThread.id` | `SidePanelThread.sessionId` |
| `activeThreadId` (threadStore) | `activeSessionId` |
| `threadId` (in events/handlers) | `sessionId` |
| `conversationId` (Session) | `sessionId` |
| `conversationId` (SessionMetadata) | removed (redundant) |
| `conversationId` (RolloutRecorder) | `sessionId` |
| `conversationId` (resume params) | `sessionId` |
| `session_<uuid>` format | `<uuid>` (drop prefix) |

## 6. Risks and Edge Cases

### 6.1 Session Reset

Reset = close old session + create new session. Old `sessionId` is retired, fresh one generated. No ID mutation needed.

### 6.2 Scheduled Sessions

Scheduled jobs create sessions with `type: 'scheduled'`. These have no UI thread. Still works — `AgentSession.sessionId` is the only ID, whether or not a thread exists.

### 6.3 Event Routing

Events are already routed by `sessionId`. No change.

### 6.4 `Session.conversationId` Referenced Externally

The `conversationId` property on `Session` is accessed by:
- `AgentSession.attachAgent()` — copies to metadata (will be removed)
- `RolloutRecorder` — uses as persistence key (rename parameter)
- `session.getState` service — returns to UI (rename field)
- Resume flow — looks up history (rename parameter)

All are mechanical renames from `conversationId` → `sessionId`.

## 7. Summary

| Aspect | Before | After |
|--------|--------|-------|
| Variable names | 3 (`thread.id`, `sessionId`, `conversationId`) | 1 (`sessionId`) |
| ID values per session | 3 different UUIDs | 1 UUID |
| ID generation points | 3 (threadStore, AgentSession, Session) | 1 (Session only) |
| Foreign keys | Thread.sessionId → AgentSession, metadata.conversationId → Session | None |
| `SidePanelThread` fields | `id`, `sessionId`, `title`, `createdAt` | `sessionId`, `title`, `createdAt` |
| `SessionMetadata` fields | `sessionId`, `conversationId`, ... | `sessionId`, ... |
| Resume complexity | Preserve conversationId + generate new sessionId | Reuse sessionId |

One name. One value. Every layer.
