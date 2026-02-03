# Implementation Plan: Multi-Agent Instances for Parallel Task Execution

**Branch**: `015-multi-agent-instances` | **Date**: 2026-02-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/015-multi-agent-instances/spec.md`

## Summary

Enable multiple concurrent BrowserxAgent instances in the service worker to allow scheduled tasks and user sessions to execute in parallel without conflicts. The solution implements an AgentRegistry pattern (inspired by Codex ThreadManager) that manages agent lifecycle, provides session isolation, and routes messages by session ID.

**Key Changes:**
1. Replace singleton `agent` with `AgentRegistry<sessionId, AgentSession>`
2. Extend MessageRouter to route by session ID
3. Update Scheduler to create isolated sessions for scheduled tasks
4. Add session lifecycle states: `initializing`, `active`, `idle`, `terminated`

## Technical Context

**Language/Version**: TypeScript 5.9.2 (target: ES2020)
**Primary Dependencies**: Svelte 4.2.20, Chrome Extension APIs (Manifest V3), Vite 5.4.20, OpenAI SDK
**Storage**: IndexedDB (via IndexedDBAdapter), chrome.storage.local
**Testing**: Vitest 3.2.4
**Target Platform**: Chrome Extension (Manifest V3 Service Worker)
**Project Type**: Chrome Extension (browser)
**Performance Goals**: <100ms overhead when concurrent sessions running (per SC-006)
**Constraints**: Max 3 concurrent sessions (default), service worker lifecycle management
**Scale/Scope**: 3 concurrent agent sessions, existing scheduler integration

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

No formal constitution defined for this project. Proceeding with standard best practices:
- ✅ Test coverage for new components
- ✅ No breaking changes to existing APIs
- ✅ Backward compatibility with current single-agent behavior

## Project Structure

### Documentation (this feature)

```text
specs/015-multi-agent-instances/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── BrowserxAgent.ts      # Add agentId property
│   ├── Session.ts            # No changes (already multi-instance)
│   ├── TurnContext.ts        # No changes
│   ├── MessageRouter.ts      # Route by sessionId
│   ├── TabManager.ts         # No changes (stateless)
│   ├── registry/             # NEW: Agent registry module
│   │   ├── AgentRegistry.ts  # Session registry + factory
│   │   ├── AgentSession.ts   # Session wrapper with lifecycle
│   │   └── types.ts          # SessionConfig, SessionMetadata
│   └── scheduler/
│       └── Scheduler.ts      # Create isolated sessions for tasks
├── background/
│   └── service-worker.ts     # Replace singleton with registry
├── storage/
│   └── IndexedDBAdapter.ts   # No changes (sessionId scoping exists)
└── models/
    └── types/
        └── SessionContracts.ts  # Add session lifecycle types

tests/
├── unit/
│   └── registry/
│       ├── AgentRegistry.test.ts
│       └── AgentSession.test.ts
└── integration/
    └── multi-session.test.ts
```

**Structure Decision**: Chrome extension single-project structure. New `registry/` module under `src/core/` for agent management. Existing modules modified in-place with minimal changes.

## Complexity Tracking

No constitution violations to justify.

---

## Phase 0: Research Findings

### R1: Current Singleton Architecture

**Finding**: The service-worker.ts uses a global singleton pattern:
```typescript
let agent: BrowserxAgent | null = null;  // Line 41
let router: MessageRouter | null = null; // Line 42
```

**Decision**: Replace with AgentRegistry pattern
**Rationale**: Registry allows multiple agents while maintaining single initialization point
**Alternatives Rejected**:
- Worker threads (not supported in MV3 service workers)
- Separate extension contexts (overly complex)

### R2: Session Independence

**Finding**: Session class already designed for multi-instance operation:
- Uses unique conversationId per session
- Tab binding is per-session (not global)
- IndexedDB storage already scoped by sessionId

**Decision**: Leverage existing Session design, wrap with AgentSession for lifecycle management
**Rationale**: Minimal changes, proven architecture
**Alternatives Rejected**: New session class (unnecessary, existing works)

### R3: Message Routing

**Finding**: MessageRouter routes by MessageType only, no session context:
```typescript
router.on(MessageType.SUBMISSION, handler)  // No sessionId
```

**Decision**: Add sessionId to message payload, lookup agent from registry
**Rationale**: Backward compatible - default to "primary" session if no ID
**Alternatives Rejected**: Separate router per agent (wasteful)

### R4: Tab Binding Strategy

**Finding**: TabManager is stateless - each Session manages its own tabId.

**Decision**: Allow same tab binding to multiple sessions with last-write-wins for conflicting operations
**Rationale**: Simple, matches user mental model (one active tab = one session)
**Alternatives Rejected**: Exclusive binding (complex, breaks scheduler use case)

### R5: Scheduler Integration

**Finding**: Scheduler currently reuses global agent for task execution (Main.svelte line 905).

**Decision**: Scheduler creates new AgentSession for each task, identified by scheduledTaskId
**Rationale**: Complete isolation between scheduled tasks and user session
**Alternatives Rejected**: Queue behind user (defeats purpose)

---

## Phase 1: Design Artifacts

### Data Model

See [data-model.md](./data-model.md) for full entity definitions.

**Key Entities:**
- `AgentRegistry`: Map<sessionId, AgentSession> + factory methods
- `AgentSession`: BrowserxAgent wrapper with lifecycle state
- `SessionMetadata`: Persisted session info for resumption
- `SessionConfig`: Creation parameters

**Lifecycle States:**
```
initializing → active ↔ idle → terminated
                ↑                    ↓
                └────────────────────┘ (on error/tab close)
```

### API Contracts

See [contracts/](./contracts/) for full definitions.

**Internal Message Extensions:**
```typescript
interface SessionAwareMessage {
  type: MessageType;
  sessionId?: string;  // NEW: defaults to 'primary' if omitted
  payload: unknown;
}
```

**Registry API:**
```typescript
interface IAgentRegistry {
  createSession(config: SessionConfig): Promise<AgentSession>;
  getSession(sessionId: string): AgentSession | undefined;
  getPrimarySession(): AgentSession | undefined;
  removeSession(sessionId: string): Promise<void>;
  listSessions(): SessionMetadata[];
  getActiveCount(): number;
}
```

### Quickstart

See [quickstart.md](./quickstart.md) for developer onboarding guide.

---

## Implementation Phases (for /rr.tasks)

### Phase 1: AgentRegistry Core (P1 - Foundation)
- Create AgentRegistry class with Map storage
- Create AgentSession wrapper with lifecycle states
- Add sessionId to BrowserxAgent constructor
- Unit tests for registry operations

### Phase 2: Message Routing (P1 - Foundation)
- Extend message types with sessionId field
- Update service-worker handlers to route by sessionId
- Backward compatibility: default to primary session
- Integration tests for routing

### Phase 3: Scheduler Integration (P1 - Core Use Case)
- Modify Scheduler to create AgentSession for each task
- Update Main.svelte scheduled task detection
- Session cleanup on task completion
- End-to-end test: user session + scheduled task parallel

### Phase 4: Session Persistence (P2)
- Persist SessionMetadata to IndexedDB
- Resume sessions on service worker restart
- Handle orphaned session cleanup

### Phase 5: Concurrent Limits (P3)
- Enforce max session limit (default: 3)
- Queue or reject when at capacity
- Settings UI for limit configuration

### Phase 6: Status Visibility (P3)
- Expose session list via message API
- Update SchedulerPopup to show session states
- Real-time status updates
