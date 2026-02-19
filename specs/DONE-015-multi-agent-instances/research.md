# Research: Multi-Agent Instances

**Feature**: 015-multi-agent-instances
**Date**: 2026-02-02

## Overview

Research findings to inform the implementation of multi-agent instance support in the browserx service worker.

---

## R1: Current Singleton Architecture

### Finding
The service-worker.ts uses a global singleton pattern for the agent:
```typescript
let agent: BrowserxAgent | null = null;           // Line 41
let router: MessageRouter | null = null;          // Line 42
let isInitialized = false;                        // Line 51
let initializationPromise: Promise<void> | null = null; // Line 52
```

Agent is created once during initialization and preserved across config updates.

### Decision
Replace with AgentRegistry pattern using `Map<sessionId, AgentSession>`

### Rationale
- Registry allows multiple agents while maintaining single initialization point
- Supports lazy creation of sessions on demand
- Enables session-specific lifecycle management
- Maintains backward compatibility (primary session as default)

### Alternatives Rejected
| Alternative | Why Rejected |
|-------------|--------------|
| Worker threads | Not supported in MV3 service workers |
| Separate extension contexts | Overly complex, poor isolation |
| Shared worker | MV3 doesn't support SharedWorker |

---

## R2: Session Independence

### Finding
Session class is already designed for multi-instance operation:
- Uses unique `conversationId` per session (constructor)
- Tab binding is per-session via `tabId` property (not global)
- IndexedDB storage already scoped by `sessionId`
- RolloutRecorder persists per-session history

Key Session components:
```typescript
private sessionState: SessionState;          // Pure data
private activeTurn: ActiveTurn | null;       // Task management
private turnContext: TurnContext;            // Model context
private services: SessionServices | null;    // Rollout/persistence
```

### Decision
Leverage existing Session design; wrap with AgentSession for lifecycle management

### Rationale
- Minimal changes to proven architecture
- Session already handles multi-instance via conversationId
- No new storage schema needed

### Alternatives Rejected
| Alternative | Why Rejected |
|-------------|--------------|
| New session class | Unnecessary duplication |
| Shared session pool | Violates isolation requirements |

---

## R3: Message Routing

### Finding
MessageRouter routes by MessageType only, no session context:
```typescript
router.on(MessageType.SUBMISSION, handler)  // No sessionId
```

Message flow:
```
Client → chrome.runtime.sendMessage() → MessageRouter.handleMessage()
       → handler lookup by MessageType → response back
```

### Decision
Add `sessionId` to message payload; lookup agent from registry

### Rationale
- Backward compatible - default to "primary" session if no ID provided
- Single router handles all sessions (efficient)
- Clear routing semantics

### Alternatives Rejected
| Alternative | Why Rejected |
|-------------|--------------|
| Separate router per agent | Wasteful memory, complex cleanup |
| Port-based routing | Adds complexity, chrome.runtime.sendMessage sufficient |

---

## R4: Tab Binding Strategy

### Finding
TabManager is stateless - only provides tab validation and event callbacks:
```typescript
validateTab(tabId): TabValidationState
createTab(options): Promise<number | null>
onTabClosure(callback)
```

Each Session manages its own `tabId` independently.

### Decision
Allow same tab binding to multiple sessions with last-write-wins for conflicting operations

### Rationale
- Simple implementation
- Matches user mental model (one visible tab = focused session)
- Scheduled tasks typically create their own tabs anyway

### Alternatives Rejected
| Alternative | Why Rejected |
|-------------|--------------|
| Exclusive binding | Complex locking, breaks scheduler use case |
| Tab pool management | Over-engineered for 3-session limit |

---

## R5: Scheduler Integration

### Finding
Scheduler currently reuses global agent for task execution:
```typescript
// Main.svelte line 905
await router.sendSubmission(submission);  // Goes to global agent
```

Scheduled tasks share context with active user conversation.

### Decision
Scheduler creates new AgentSession for each task, identified by `scheduledTaskId`

### Rationale
- Complete isolation between scheduled tasks and user session
- Clean lifecycle: session created on task start, destroyed on completion/failure
- No shared state conflicts

### Alternatives Rejected
| Alternative | Why Rejected |
|-------------|--------------|
| Queue behind user | Defeats purpose of parallel execution |
| Time-slice sharing | Complex, unpredictable latency |

---

## R6: IndexedDB Storage Patterns

### Finding
Storage already supports session-scoped data:
```typescript
// Stores
SESSIONS: 'sessions'           // Session metadata
CACHE_ITEMS: 'cache_items'     // Per-session cache
SCHEDULER_TASKS: 'scheduler_tasks'  // Task queue

// Indexes
BY_SESSION: on sessionId
BY_SESSION_TIMESTAMP: on [sessionId, timestamp]
```

### Decision
No storage schema changes needed - use existing sessionId scoping

### Rationale
- Proven, tested infrastructure
- SessionMetadata can be stored in existing SESSIONS store
- Minimal migration risk

---

## R7: Codex Reference Patterns

### Finding
Codex uses ThreadManager pattern with similar goals:
```rust
pub(crate) struct ThreadManagerState {
    threads: Arc<RwLock<HashMap<ThreadId, Arc<CodexThread>>>>,
    thread_created_tx: broadcast::Sender<ThreadId>,
}
```

Key patterns:
- Registry with Map storage
- Weak references to prevent cycles
- Broadcast notifications for lifecycle events
- RAII-style slot reservations for limits

### Decision
Adapt ThreadManager pattern for TypeScript/Chrome extension context

### Rationale
- Proven architecture from production system
- Clean separation of concerns
- Lifecycle management built-in

### Adaptations for Browser Context
| Codex Pattern | Browser Adaptation |
|---------------|-------------------|
| Arc<RwLock<HashMap>> | Map<string, AgentSession> |
| broadcast::Sender | chrome.runtime event dispatch |
| RAII reservations | try/finally cleanup |
| File-based rollout | IndexedDB storage |

---

## Summary: Minimal Changes Required

| Component | Change Level | Notes |
|-----------|--------------|-------|
| service-worker.ts | **High** | Agent registry + factory |
| BrowserxAgent.ts | **Low** | Add sessionId property |
| MessageRouter.ts | **Medium** | Extract/route by sessionId |
| Session.ts | **None** | Already multi-instance |
| TabManager.ts | **None** | Stateless design |
| IndexedDBAdapter.ts | **None** | sessionId scoping exists |
| Scheduler.ts | **Medium** | Create isolated sessions |
