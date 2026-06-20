# Migrate RepublicAgent to Delegate to RepublicAgentEngine

## 1. Problem Statement

After Phase 3 of the sub-agent refactoring, the codebase has **two separate execution loops**:

| Loop | Location | Lines | Used By |
|------|----------|-------|---------|
| **RepublicAgent loop** | `Session.spawnTask()` → `RegularTask` → `AgentTask` → `TaskRunner.runLoop()` → `TurnManager` | ~2500+ across files | Main agent (interactive UI) |
| **RepublicAgentEngine loop** | `RepublicAgentEngine.handleUserInput()` | ~50 (stub) | Sub-agents (not yet real) |

### 1.1 The Dual-Loop Problem

The engine's `handleUserInput()` is currently a **stub** — it echoes input back instead of executing the real agentic loop. Meanwhile, the real loop lives in `TaskRunner.runLoop()` + `TurnManager.tryRunTurn()`, accessed only through `Session.spawnTask()`.

This creates immediate problems:

1. **Sub-agents can't run real tasks** — `RepublicAgentEngine.run()` returns echo output, not LLM responses
2. **Two paths to maintain** — any loop fix must be applied in two places (or will be, once the engine's stub is replaced)
3. **Divergence risk** — as features are added to either path, they'll drift apart
4. **Duplicated queue logic** — both `RepublicAgent` and `RepublicAgentEngine` implement SQ/EQ processing with near-identical code

### 1.2 Current Execution Chain

```
RepublicAgent.submitOperation(UserInput)
  → submissionQueue.push()
  → processSubmissionQueue()
    → handleSubmission()
      → handleUserInput()
        → processUserInputWithTask()
          → handleTabBinding()          ← orchestration
          → apply pendingModelKey       ← orchestration
          → Session.spawnTask()         ← delegates to execution layer
            → RegularTask.run()
              → AgentTask.run()
                → TaskRunner.runLoop()  ← THE REAL LOOP
                  → TurnManager.tryRunTurn()
                    → modelClient.stream()
                    → handleResponseItem() (tool calls)
                    → processTurnResult()
                  → [loop until task complete]
```

The real execution lives 6 layers deep. `RepublicAgentEngine` needs to reach this same execution path.

### 1.3 What RepublicAgentEngine Stubs Today

```typescript
// RepublicAgentEngine.handleUserInput() — current stub
private async handleUserInput(submission: Submission): Promise<void> {
  this.emitEvent({ type: 'TaskStarted', ... });
  // Echo input back — NO real execution
  const responseText = items.map(i => i.text).join('\n');
  this.emitEvent({ type: 'TaskComplete', ... });
}
```

vs. what it needs to do:

```typescript
// What it should do: delegate to the same TaskRunner loop
private async handleUserInput(submission: Submission): Promise<void> {
  this.emitEvent({ type: 'TaskStarted', ... });
  await this.session.spawnTask(task, submission);
  // TaskRunner.runLoop() handles multi-turn execution
  // Events flow through to EQ via eventRouter
}
```

## 2. Goals

### 2.1 Single Execution Loop

Eliminate the stub in `RepublicAgentEngine` and wire it to the real execution layer (`Session` → `RegularTask` → `TaskRunner` → `TurnManager`). After this change, there is exactly **one loop** for both the main agent and sub-agents.

### 2.2 RepublicAgent Delegates, Engine Executes

`RepublicAgent` becomes a thin orchestration wrapper that:
- Owns the `RepublicAgentEngine` instance
- Handles tab binding, config subscriptions, model hot-swap, channel dispatch
- Forwards `UserInput`/`UserTurn` operations to the engine
- Listens to engine events and re-dispatches to the UI channel

The engine handles:
- SQ/EQ queue management
- Session lifecycle (spawnTask, abort, approval routing)
- Task execution delegation
- Event emission

### 2.3 Preserve Fire-and-Forget + Awaitable Modes

- **Interactive mode** (RepublicAgent → UI): `submitOperation()` is fire-and-forget, events flow through `eventDispatcher`
- **Awaitable mode** (sub-agents): `engine.run(prompt)` returns `EngineResult` when task completes

Both modes use the same engine and the same `TaskRunner.runLoop()`.

### 2.4 Zero Behavior Change for Existing Callers

All existing tests (7339) must pass without modification to test assertions. Bootstrap callers, service-worker, AgentRegistry — all unchanged. The refactor is internal to `RepublicAgent` ↔ `RepublicAgentEngine`.

### 2.5 Incremental, Phase-Based Migration

The migration happens in small, independently testable steps. Each phase produces a working system where all tests pass.

## 3. Architecture Overview

### 3.1 Before (Current)

```
┌─────────────────────────────────────────────────────────────┐
│  RepublicAgent                                               │
│                                                              │
│  ┌──────────┐  ┌──────────────────────────┐                 │
│  │ SQ / EQ  │  │ handleSubmission()       │                 │
│  │ (own)    │──│ 12 operation types       │                 │
│  └──────────┘  │ processUserInputWithTask │                 │
│                │ handleCompact            │                 │
│                │ handleInterrupt          │                 │
│                │ handleExecApproval       │                 │
│                │ ... 8 more handlers      │                 │
│                └───────────┬──────────────┘                 │
│                            │                                 │
│                            ▼                                 │
│                ┌──────────────────────┐                      │
│                │ Session.spawnTask()  │─► TaskRunner.runLoop()│
│                └──────────────────────┘                      │
└──────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  RepublicAgentEngine (separate, stub)                        │
│                                                              │
│  ┌──────────┐  ┌──────────────────────────┐                 │
│  │ SQ / EQ  │  │ handleSubmission()       │                 │
│  │ (own)    │──│ 6 operation types (stub) │                 │
│  └──────────┘  │ handleUserInput (echo)   │ ← NOT REAL     │
│                └──────────────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 After (Target)

```
┌─────────────────────────────────────────────────────────────┐
│  RepublicAgent (thin orchestrator, ~400 lines)              │
│                                                              │
│  Responsibilities:                                           │
│  • Tab binding (delegates to platformAdapter)                │
│  • Config subscriptions (model hot-swap, pendingModelKey)    │
│  • Channel dispatch (setEventDispatcher → UI)                │
│  • Orchestration-only ops (GetPath, OverrideTurnContext)     │
│  • Pre-submission hooks (tab bind, model apply)              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  RepublicAgentEngine (owned instance)                   │ │
│  │                                                         │ │
│  │  ┌──────────┐  ┌──────────────────────────────────┐    │ │
│  │  │ SQ / EQ  │  │ handleSubmission()               │    │ │
│  │  │ (single) │──│ UserInput → Session.spawnTask()  │    │ │
│  │  └──────────┘  │ Interrupt → Session.abortAll()   │    │ │
│  │                │ ExecApproval → approval routing   │    │ │
│  │                │ PatchApproval → session notify    │    │ │
│  │                │ Compact → session compact         │    │ │
│  │                │ AddToHistory → session record     │    │ │
│  │                │ Shutdown → cleanup                │    │ │
│  │                └──────────────┬───────────────────┘    │ │
│  │                               │                        │ │
│  │                               ▼                        │ │
│  │                   Session.spawnTask()                   │ │
│  │                        │                               │ │
│  │                        ▼                               │ │
│  │               TaskRunner.runLoop()  ← SINGLE LOOP     │ │
│  │                        │                               │ │
│  │                        ▼                               │ │
│  │               TurnManager.tryRunTurn()                 │ │
│  │                                                         │ │
│  │  Modes:                                                 │ │
│  │  • Interactive: submitOperation() + eventDispatcher     │ │
│  │  • Awaitable: run(prompt) → EngineResult               │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  Sub-agent engines (via createChildEngine):                  │
│  • Same RepublicAgentEngine class                            │
│  • Own Session (non-persistent), own ToolRegistry (cloned)   │
│  • Same TaskRunner.runLoop() path                            │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 Responsibility Matrix

| Concern | Before (owner) | After (owner) |
|---------|----------------|---------------|
| SQ/EQ queue processing | RepublicAgent + Engine (duplicated) | Engine only |
| UserInput → spawnTask | RepublicAgent.processUserInputWithTask | Engine.handleUserInput |
| Tab binding | RepublicAgent.handleTabBinding | RepublicAgent (pre-submit hook) |
| Model hot-swap | RepublicAgent.handleModelConfigChange | RepublicAgent (pre-submit hook) |
| Interrupt handling | RepublicAgent.handleInterrupt | Engine.handleInterrupt |
| Approval routing | RepublicAgent.handleExecApproval | Engine.handleExecApproval |
| Compaction | RepublicAgent.handleCompact | Engine.handleCompact |
| History add/query | RepublicAgent | Engine |
| Config subscriptions | RepublicAgent | RepublicAgent (unchanged) |
| Channel dispatch | RepublicAgent.setEventDispatcher | RepublicAgent subscribes to engine EQ |
| GetPath, OverrideTurnContext | RepublicAgent | RepublicAgent (local, no engine involvement) |
| Shutdown | RepublicAgent.handleShutdown | RepublicAgent calls engine.dispose() |

## 4. Detailed Design

### 4.1 Engine Initialization with Session

The key missing piece is wiring `RepublicAgentEngine` to a real `Session`. Currently the engine creates its own lightweight session. Instead, it should accept an externally-provided session (for the main agent) or create its own (for sub-agents).

```typescript
// RepublicAgentEngineConfig — additions
interface RepublicAgentEngineConfig {
  // ... existing fields ...

  /**
   * Externally-managed Session instance.
   * If provided, the engine uses this session for task execution.
   * If omitted, the engine creates its own Session during initialize().
   */
  session?: Session;

  /**
   * Whether this engine manages the session lifecycle (dispose on engine dispose).
   * true when session is internally created (sub-agents).
   * false when session is externally provided (main agent).
   * Default: true if session is not provided, false if session is provided.
   */
  ownsSession?: boolean;
}
```

### 4.2 Engine.handleUserInput — Real Execution

Replace the stub with real task spawning:

```typescript
private async handleUserInput(submission: Submission): Promise<void> {
  const { items, submissionId } = submission;

  this.emitEvent({
    type: 'TaskStarted',
    submissionId,
    timestamp: Date.now(),
  });

  try {
    // Build input items for the task
    const inputItems = this.buildInputItems(items);

    // Apply context overrides if present
    if (submission.contextOverrides) {
      this.applyContextOverrides(submission.contextOverrides);
    }

    // Spawn task through session (same path as RepublicAgent today)
    const task = new RegularTask(inputItems);
    await this.session.spawnTask(task, {
      onComplete: (result) => {
        this.emitEvent({
          type: 'TaskComplete',
          submissionId,
          result,
          timestamp: Date.now(),
        });
        this.resolveCompletion(submissionId, result);
      },
      onAborted: (reason) => {
        this.emitEvent({
          type: 'TaskAborted',
          submissionId,
          reason,
          timestamp: Date.now(),
        });
        this.resolveCompletion(submissionId, { success: false, reason });
      },
    });
  } catch (error) {
    this.emitEvent({
      type: 'TaskError',
      submissionId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    this.resolveCompletion(submissionId, { success: false, error });
  }
}
```

### 4.3 Engine Interrupt, Approval, Compact — Real Handlers

Move the real logic from RepublicAgent's handlers into the engine:

```typescript
// Engine.handleInterrupt — real abort logic
private async handleInterrupt(): Promise<void> {
  this.submissionQueue.length = 0; // Clear pending submissions
  await this.session.abortAllTasks('UserInterrupt');
  this.emitEvent({ type: 'TaskAborted', reason: 'UserInterrupt', timestamp: Date.now() });
}

// Engine.handleExecApproval — real approval routing
private async handleExecApproval(submission: Submission): Promise<void> {
  const { approvalId, decision, remember } = submission;

  // Dual routing: ApprovalManager + Session
  if (this.approvalManager) {
    await this.approvalManager.handleDecision(approvalId, decision);
  }
  this.session.notifyApproval(approvalId, decision);

  // Remember decision if requested
  if (remember && this.config.approvalGate) {
    this.config.approvalGate.rememberDecision(approvalId, decision);
  }

  this.emitEvent({
    type: 'ExecApprovalHandled',
    approvalId,
    decision,
    timestamp: Date.now(),
  });
}

// Engine.handleCompact — real compaction
private async handleCompact(submission: Submission): Promise<void> {
  const mode = submission.type === 'ManualCompact' ? 'manual' : 'auto';
  const result = await this.session.compact(mode);
  this.emitEvent({
    type: 'CompactComplete',
    result,
    timestamp: Date.now(),
  });
}
```

### 4.4 RepublicAgent Becomes Thin Wrapper

After the engine owns execution, RepublicAgent's `submitOperation()` becomes:

```typescript
async submitOperation(op: AgentOp): Promise<void> {
  switch (op.type) {
    // === Orchestration-only ops (handled locally) ===
    case 'GetPath':
      return this.handleGetPath(op);
    case 'OverrideTurnContext':
      return this.handleOverrideTurnContext(op);
    case 'GetHistoryEntryRequest':
      return this.handleGetHistoryEntryRequest(op);

    // === UserInput/UserTurn: pre-process then delegate ===
    case 'UserInput':
    case 'UserTurn':
      await this.preSubmitHooks(op);  // tab binding + model apply
      return this.engine.submitOperation(op);

    // === Everything else: forward directly to engine ===
    case 'Interrupt':
    case 'ExecApproval':
    case 'PatchApproval':
    case 'Compact':
    case 'ManualCompact':
    case 'AddToHistory':
      return this.engine.submitOperation(op);

    case 'Shutdown':
      await this.engine.dispose();
      return this.cleanup();
  }
}

private async preSubmitHooks(op: UserInputOp | UserTurnOp): Promise<void> {
  // 1. Tab binding (platform adapter)
  await this.handleTabBinding(op);

  // 2. Apply pending model switch
  if (this.pendingModelKey) {
    await this.applyPendingModelSwitch();
  }
}
```

### 4.5 Event Bridge: Engine EQ → RepublicAgent eventDispatcher

RepublicAgent subscribes to the engine's events and re-dispatches them to the UI:

```typescript
// During RepublicAgent.initialize()
private wireEngineEvents(): void {
  this.engine.onEvent((event: EngineEvent) => {
    // Convert engine events to channel messages and dispatch
    this.dispatchEvent(this.toChannelMessage(event));
  });
}
```

This preserves the existing `setEventDispatcher` API that the UI depends on.

### 4.6 Session Sharing

RepublicAgent creates the `Session` and passes it to the engine:

```typescript
// RepublicAgent.initialize()
async initialize(): Promise<void> {
  // Create session (same as today)
  this.session = new Session({ persistent: true, ... });
  await this.session.initializeSession();

  // Create engine with shared session
  this.engine = new RepublicAgentEngine({
    agentConfig: this.config,
    modelClientFactory: this.modelClientFactory,
    session: this.session,           // ← shared, engine doesn't own lifecycle
    ownsSession: false,
    toolRegistry: this.toolRegistry,
    approvalGate: this.approvalGate,
    eventRouter: this.engineEventRouter,
  });
  await this.engine.initialize();

  // Wire engine events to UI dispatch
  this.wireEngineEvents();
}
```

Sub-agents get their own session:

```typescript
// createChildEngine() — no external session, engine creates its own
const childEngine = new RepublicAgentEngine({
  agentConfig: childConfig,
  modelClientFactory: this.modelClientFactory,
  // session: omitted → engine creates its own (non-persistent)
  toolRegistry: clonedRegistry,
  approvalGate: autoApproveGate,
});
```

## 5. Migration Phases

### Phase 1: Wire Engine to Real Session (Foundation)

Make `RepublicAgentEngine.handleUserInput()` spawn real tasks through `Session`, replacing the echo stub. The engine gains real execution capability.

**Risk: Low.** Engine is only used by sub-agents (not yet in production). Changing the stub to real execution is additive.

### Phase 2: Move Execution Handlers to Engine

Move `handleInterrupt`, `handleExecApproval`, `handlePatchApproval`, `handleCompact`, `handleAddToHistory` from RepublicAgent into the engine. RepublicAgent forwards these ops to the engine.

**Risk: Medium.** These handlers interact with Session state. Tests must verify identical behavior.

### Phase 3: RepublicAgent Delegates UserInput to Engine

Replace `RepublicAgent.processUserInputWithTask()` with `preSubmitHooks()` + `engine.submitOperation()`. The engine's SQ/EQ becomes the single queue.

**Risk: Medium.** This is the core migration step. RepublicAgent's own SQ is removed. All 72 RepublicAgent tests must pass.

### Phase 4: Remove Duplicate Queue from RepublicAgent

Delete `RepublicAgent.submissionQueue`, `processSubmissionQueue()`, `handleSubmission()`, and the duplicated dispatch logic. RepublicAgent becomes a thin wrapper with `submitOperation()` doing routing + hooks only.

**Risk: Low.** This is cleanup after Phase 3 proves the delegation works.

### Phase 5: Validate Sub-Agent End-to-End

With the engine now executing real tasks, validate `createChildEngine()` → `engine.run(prompt)` works end-to-end. Sub-agents can run LLM calls, execute tools, and return results.

**Risk: Low.** This validates the original sub-agent goal is met.

## 6. Operation Routing After Migration

| Operation | Handler Location | Notes |
|-----------|-----------------|-------|
| `UserInput` | RepublicAgent → preSubmitHooks → Engine | Tab bind + model apply before forwarding |
| `UserTurn` | RepublicAgent → preSubmitHooks → Engine | Same as UserInput |
| `Interrupt` | Engine | Clears SQ, aborts tasks |
| `ExecApproval` | Engine | Dual routing: ApprovalManager + Session |
| `PatchApproval` | Engine | Session.notifyApproval |
| `Compact` | Engine | Session.compact |
| `ManualCompact` | Engine | Session.compact('manual') |
| `AddToHistory` | Engine | Session.addToHistory |
| `Shutdown` | RepublicAgent | engine.dispose() + cleanup |
| `GetPath` | RepublicAgent (local) | No engine involvement |
| `OverrideTurnContext` | RepublicAgent (local) | Updates TurnContext directly |
| `GetHistoryEntryRequest` | RepublicAgent (local) | Session query, no queue needed |

## 7. Key Design Decisions

### 7.1 Session Ownership: External vs. Internal

The engine supports both modes:
- **External session** (main agent): RepublicAgent creates and owns the Session, passes it to the engine. Engine doesn't dispose it.
- **Internal session** (sub-agents): Engine creates its own non-persistent Session. Engine disposes it on `dispose()`.

This avoids duplicating Session creation logic while keeping sub-agents self-contained.

### 7.2 Pre-Submit Hooks vs. Engine Middleware

Tab binding and model switching stay in RepublicAgent as **pre-submit hooks**, not engine middleware. Rationale:
- Tab binding requires `IPlatformAdapter` — the engine is platform-agnostic
- Model hot-swap requires `AgentConfig` subscriptions — the engine doesn't subscribe to config events
- These are orchestration concerns, not execution concerns
- Sub-agents don't need tab binding or model switching

### 7.3 Event Bridge vs. Direct Dispatch

The engine emits events to its EQ. RepublicAgent subscribes and re-dispatches to the UI's `eventDispatcher`. This maintains the existing channel-based event model without the engine needing to know about channels.

### 7.4 ApprovalManager Stays in Engine

The `ApprovalManager` is an execution concern (tools need approval during execution). It lives in the engine, not in RepublicAgent. The "remember decision" feature is part of the approval routing logic.

### 7.5 No New Abstractions

This migration does not introduce new interfaces, middleware patterns, or plugin systems. It moves existing logic from RepublicAgent into RepublicAgentEngine, using the same classes (`Session`, `RegularTask`, `ApprovalManager`).

## 8. Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `src/core/engine/RepublicAgentEngine.ts` | Major | Replace stubs with real Session-based execution |
| `src/core/engine/RepublicAgentEngineConfig.ts` | Minor | Add `session?`, `ownsSession?` to config |
| `src/core/RepublicAgent.ts` | Major | Remove execution handlers, delegate to engine |
| `src/core/__tests__/RepublicAgent.test.ts` | Medium | Update tests for delegation pattern |
| `src/core/engine/__tests__/RepublicAgentEngine.test.ts` | New | Tests for real engine execution |

Files **not** changed:
- Bootstrap files (DesktopAgentBootstrap, ServerAgentBootstrap, service-worker)
- Platform adapters
- TaskRunner, TurnManager, Session, RegularTask
- AgentRegistry
- Tool registration

## 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Session state shared between RepublicAgent and Engine causes race conditions | Low | High | Engine is single-threaded (SQ processes one at a time). RepublicAgent's preSubmitHooks run synchronously before forwarding to engine. |
| Event ordering changes break UI | Medium | Medium | Engine emits events in same order as current RepublicAgent handlers. Integration tests verify event sequence. |
| Approval routing dual-path (ApprovalManager + Session) breaks during migration | Low | High | Move approval handlers atomically in Phase 2. Test both paths. |
| TaskRunner/TurnManager assumptions about caller | Low | Low | These are already decoupled via Session.spawnTask(). Engine uses the same interface. |
