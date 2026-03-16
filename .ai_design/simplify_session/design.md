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

## 7. Event Routing with `sessionId` (Channel Envelope)

### 7.1 Problem

Events flow from agent to UI without any session identification:

```
RepublicAgent.emitEvent()
  → EventDispatcher(event: Event)           // Event = { id, msg: EventMsg }
    → channelManager.dispatchEvent(event.msg)  // EventMsg = { type, data }
      → channel.sendEvent(eventMsg)
        → UI receives EventMsg               // no sessionId — can't route to thread
```

`EventMsg` is a core protocol type (discriminated union of ~30 event types). It describes *what happened* (agent message, task started, tool call, etc.). Session routing is a *transport concern*, not a protocol concern. `EventMsg` should stay pure.

### 7.2 Design: `ChannelEvent` Envelope

Introduce a `ChannelEvent` wrapper at the channel layer that adds routing metadata around `EventMsg`:

```typescript
// src/core/channels/types.ts

/**
 * Event envelope for channel transport.
 * Wraps EventMsg with routing metadata (sessionId, channelId, etc.).
 * EventMsg stays pure protocol; ChannelEvent adds transport concerns.
 */
export interface ChannelEvent {
  /** The protocol event payload */
  msg: EventMsg;
  /** Session that produced this event (for multi-session routing) */
  sessionId?: string;
}
```

### 7.3 Changes to Channel Layer

**`ChannelAdapter.sendEvent()`** — change signature:

```typescript
// Before:
sendEvent(event: EventMsg, targetClientId?: string): Promise<void>;

// After:
sendEvent(event: ChannelEvent, targetClientId?: string): Promise<void>;
```

**`ChannelManager.dispatchEvent()` / `broadcastEvent()`** — change signature:

```typescript
// Before:
async dispatchEvent(event: EventMsg, channelId: string): Promise<void>;
async broadcastEvent(event: EventMsg): Promise<void>;

// After:
async dispatchEvent(event: ChannelEvent, channelId: string): Promise<void>;
async broadcastEvent(event: ChannelEvent): Promise<void>;
```

**All callers** wrap `EventMsg` in `ChannelEvent` before dispatching:

```typescript
// Before (DesktopAgentBootstrap.setupEventForwarding):
agent.setEventDispatcher((event) => {
  channelManager.dispatchEvent(event.msg, channelId);
});

// After:
agent.setEventDispatcher((event) => {
  channelManager.dispatchEvent({ msg: event.msg, sessionId }, channelId);
});
```

### 7.4 Changes to Transport Layer

**`TauriChannel.sendEvent()`** — wraps `ChannelEvent` into the `pi:event` Tauri event:

```typescript
// Before:
async sendEvent(event: EventMsg): Promise<void> {
  await emit('pi:event', event);
}

// After:
async sendEvent(event: ChannelEvent): Promise<void> {
  await emit('pi:event', event);  // ChannelEvent { msg, sessionId } sent to UI
}
```

**`TauriTransport.onEvent()`** — receives `ChannelEvent`, passes to listeners:

```typescript
// Before:
onEvent(handler: (event: EventMsg) => void): () => void;

// After:
onEvent(handler: (event: ChannelEvent) => void): () => void;
```

**`UIChannelClient.onEvent()`** — receives `ChannelEvent`:

```typescript
// Before:
onEvent(type: string, handler: (data: any) => void): () => void;

// After:
onEvent(type: string, handler: (event: ChannelEvent) => void): () => void;
// Or keep backward compat: handler receives ChannelEvent, can destructure { msg, sessionId }
```

### 7.5 Changes to UI (Main.svelte)

```typescript
// Before:
client.onEvent('*', (eventMsg: any) => {
  const event: Event = { id: `evt_${Date.now()}`, msg: eventMsg };
  handleEvent(event);  // always routes to active thread
});

// After:
client.onEvent('*', (channelEvent: ChannelEvent) => {
  const { msg, sessionId } = channelEvent;
  const event: Event = { id: `evt_${Date.now()}`, msg };

  if (!sessionId || sessionId === activeSessionId) {
    // Active thread — render immediately
    handleEvent(event);
  } else {
    // Background thread — buffer in threadStates
    handleEventForSession(event, sessionId);
  }
});
```

This connects the existing dead code (`handleEventForSession`) to the event flow.

### 7.6 AgentRegistry Event Dispatcher Wiring

**Desktop path** — `eventDispatcherFactory` now includes `sessionId`:

```typescript
// DesktopAgentBootstrap — registry config
this.registry = AgentRegistry.getInstance({
  maxConcurrent: maxConcurrentSessions,
  agentFactory: async (config) => { ... },
  eventDispatcherFactory: (sessionId) => (event) => {
    channelManager.dispatchEvent(
      { msg: event.msg, sessionId },
      this.channel!.channelId
    );
  },
});
```

**Extension path** — `AgentRegistry.createSession()` wraps with sessionId:

```typescript
// Before (no sessionId):
agent.setEventDispatcher((event) => {
  getChannelManager().broadcastEvent(event.msg);
});

// After:
agent.setEventDispatcher((event) => {
  getChannelManager().broadcastEvent({ msg: event.msg, sessionId: session.sessionId });
});
```

**Primary agent** — `setupEventForwarding()` uses primary session's ID:

```typescript
// DesktopAgentBootstrap.setupEventForwarding():
this.agent.setEventDispatcher((event) => {
  channelManager.dispatchEvent(
    { msg: event.msg, sessionId: this.agent.getSession().sessionId },
    this.channel!.channelId
  );
});
```

### 7.7 Submission Side Fix

`Main.svelte.sendMessage()` must also include `activeSessionId` in the submission context:

```typescript
// Before:
await client.submitOp(op, { tabId: currentTabId });

// After:
await client.submitOp(op, { tabId: currentTabId, sessionId: activeSessionId });
```

This ensures the `agentHandler` in `DesktopAgentBootstrap` routes the message to the correct session's agent.

### 7.8 Affected Implementations

All `ChannelAdapter` implementations need signature update for `sendEvent`:

| File | Channel | Change |
|------|---------|--------|
| `src/desktop/channels/TauriChannel.ts` | TauriChannel | `EventMsg` → `ChannelEvent` |
| `src/extension/channels/SidePanelChannel.ts` | SidePanelChannel | `EventMsg` → `ChannelEvent` |
| `src/extension/channels/TabPageChannel.ts` | TabPageChannel | `EventMsg` → `ChannelEvent` |
| `src/server/channels/ServerChannel.ts` | ServerChannel | `EventMsg` → `ChannelEvent` |

All transport implementations:

| File | Transport | Change |
|------|-----------|--------|
| `src/core/messaging/transports/TauriTransport.ts` | TauriTransport | `EventMsg` → `ChannelEvent` |
| `src/core/messaging/transports/ChromeExtensionTransport.ts` | ChromeExtensionTransport | `EventMsg` → `ChannelEvent` |
| `src/core/messaging/transports/WebSocketTransport.ts` | WebSocketTransport | `EventMsg` → `ChannelEvent` |

## 8. Summary

### ID Unification

| Aspect | Before | After |
|--------|--------|-------|
| Variable names | 3 (`thread.id`, `sessionId`, `conversationId`) | 1 (`sessionId`) |
| ID values per session | 3 different UUIDs | 1 UUID |
| ID generation points | 3 (threadStore, AgentSession, Session) | 1 (Session only) |
| Foreign keys | Thread.sessionId → AgentSession, metadata.conversationId → Session | None |
| `SidePanelThread` fields | `id`, `sessionId`, `title`, `createdAt` | `sessionId`, `title`, `createdAt` |
| `SessionMetadata` fields | `sessionId`, `conversationId`, ... | `sessionId`, ... |
| Resume complexity | Preserve conversationId + generate new sessionId | Reuse sessionId |

### Event Routing

| Aspect | Before | After |
|--------|--------|-------|
| Event type | `EventMsg` (protocol + routing mixed) | `ChannelEvent { msg: EventMsg, sessionId? }` (separated) |
| Session in events | Not present | `ChannelEvent.sessionId` |
| Session in submissions | Not sent by UI | `submitOp(op, { sessionId })` |
| Background thread events | Lost (routed to active thread) | Buffered in `threadStates` via `handleEventForSession()` |
| `EventMsg` purity | N/A | Unchanged — stays as pure protocol type |

One ID. One name. Clean routing. Protocol and transport separated.
