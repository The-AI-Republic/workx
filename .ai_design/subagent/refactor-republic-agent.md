# Refactoring RepublicAgent: Extract AgentExecutor

## 1. Problem Statement

RepublicAgent is a 1319-line class that mixes **6 distinct responsibilities**:

| # | Responsibility | Lines | Description |
|---|---|---|---|
| 1 | Core execution | ~50 | Create task, delegate to Session → RegularTask → TurnManager → TaskRunner |
| 2 | Submission queue routing | ~200 | SQ/EQ architecture, 15-case op-type switch |
| 3 | Tab/browser management | ~220 | Create tabs, validate tabs, switch tabs, MCP browser connection |
| 4 | Approval routing | ~100 | ExecApproval, PatchApproval, remember-decision, dual-path resolution |
| 5 | Config/model reactivity | ~150 | Config subscriptions, model hot-swap, deferred model switch, PromptComposer |
| 6 | UI notifications/queries | ~200 | UserNotifier, progress, history queries, compaction, isReady |

The sub-agent system only needs responsibility #1. But today, calling the core execution path (`processUserInputWithTask`) unavoidably triggers tab binding (#3), pending model switch (#5), and routes through the submission queue (#2).

There is no way to run a prompt through the agentic loop without dragging in all the orchestration overhead.

## 2. Goal

Extract the **core execution logic** into a standalone `AgentExecutor` class that:

1. Can run a prompt to completion and return a result (awaitable)
2. Has no dependency on tabs, approvals, notifications, config subscriptions, or submission queues
3. Accepts injected dependencies (ToolRegistry, ModelClient, system prompt)
4. Is usable by both RepublicAgent (existing flow) and sub-agents (new flow)

## 3. Architecture: Composition

```
BEFORE:
┌─────────────────────────────────────────────┐
│ RepublicAgent (1319 lines)                  │
│                                             │
│  Everything in one class:                   │
│  SQ/EQ + Tabs + Approvals + Config +        │
│  Notifications + Core Execution             │
└─────────────────────────────────────────────┘

AFTER:
┌─────────────────────────────────────────────┐
│ RepublicAgent (~800 lines)                  │
│                                             │
│  SQ/EQ routing, tabs, approvals, config,    │
│  notifications, UI queries                  │
│                                             │
│  Uses AgentExecutor internally for          │
│  task execution via processUserInputWithTask│
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ AgentExecutor (~150 lines)            │  │
│  │                                       │  │
│  │  Session + TurnContext + ToolRegistry  │  │
│  │  + RegularTask.run() → result         │  │
│  │                                       │  │
│  │  Awaitable. No queues. No tabs.       │  │
│  │  No approvals. No config reactivity.  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ Sub-Agent (future)                          │
│                                             │
│  Uses AgentExecutor directly                │
│  Different config, restricted tools         │
│  No RepublicAgent overhead                  │
└─────────────────────────────────────────────┘
```

## 4. AgentExecutor Design

### 4.1 Interface

```typescript
// File: src/core/AgentExecutor.ts

export interface AgentExecutorConfig {
  /** AgentConfig instance (shared — for credentials and provider info) */
  agentConfig: AgentConfig;

  /** Pre-built ToolRegistry (caller controls which tools are available) */
  toolRegistry: ToolRegistry;

  /** System prompt (base instructions) for this executor */
  systemPrompt: string;

  /** Optional user instructions appended to system prompt */
  userInstructions?: string;

  /** Model to use. If omitted, uses agentConfig.selectedModelKey */
  model?: string;

  /** Shared ModelClientFactory (reuses parent's cached clients + auth) */
  modelClientFactory: ModelClientFactory;

  /** Max turns before forced stop. Default: 500 (TaskRunner.MAX_TURNS) */
  maxTurns?: number;

  /** Optional event callback for observing internal events */
  onEvent?: (event: Event) => void;

  /** Whether to persist session history. Default: false for sub-agents */
  persistent?: boolean;
}

export interface ExecutorResult {
  /** Whether execution completed successfully */
  success: boolean;

  /** Final assistant text response (last AgentMessage) */
  response: string | null;

  /** Number of turns executed */
  turnCount: number;

  /** Token usage for this execution */
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };

  /** Why execution stopped */
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled';

  /** Error message if stopReason is 'error' */
  error?: string;
}

export interface RunOptions {
  /** Override max turns for this specific run */
  maxTurns?: number;

  /** AbortSignal for external cancellation */
  signal?: AbortSignal;
}
```

### 4.2 Implementation Sketch

```typescript
export class AgentExecutor {
  private session: Session;
  private toolRegistry: ToolRegistry;
  private turnContext: TurnContext;
  private config: AgentExecutorConfig;

  constructor(config: AgentExecutorConfig) {
    this.config = config;
    this.toolRegistry = config.toolRegistry;

    // Create a lightweight Session (no persistence for sub-agents)
    this.session = new Session(
      config.agentConfig,
      config.persistent ?? false,  // non-persistent by default
      undefined,                   // no services
      config.toolRegistry          // inject restricted registry
    );
  }

  /**
   * Initialize the executor (async setup)
   * - Creates ModelClient
   * - Sets up TurnContext with system prompt and model
   */
  async initialize(): Promise<void> {
    // Create model client (reuses parent's factory + auth)
    const modelClient = config.model
      ? await this.config.modelClientFactory.createClient(config.model)
      : await this.config.modelClientFactory.createClientForCurrentModel();

    // Create TurnContext with custom system prompt
    this.turnContext = new TurnContext(modelClient, {
      sessionId: this.session.conversationId,
      approvalPolicy: 'never',  // auto-approve everything
    });
    this.turnContext.setBaseInstructions(this.config.systemPrompt);
    if (this.config.userInstructions) {
      this.turnContext.setUserInstructions(this.config.userInstructions);
    }

    this.session.setTurnContext(this.turnContext);

    // Wire event collection
    this.session.setEventEmitter(async (event) => {
      this.config.onEvent?.(event);
    });
  }

  /**
   * Run a prompt to completion. Awaitable.
   *
   * This is the core agentic loop:
   *   prompt → TurnManager → tool calls → ... → final text response
   *
   * Calls RegularTask.run() directly — NO submission queue,
   * NO tab binding, NO approval UI, NO config subscriptions.
   */
  async run(input: InputItem[], options?: RunOptions): Promise<ExecutorResult> {
    const subId = uuidv4();
    const task = new RegularTask();
    const startTime = Date.now();

    // Wire abort signal to session
    const abortController = new AbortController();
    if (options?.signal) {
      options.signal.addEventListener('abort', () => abortController.abort());
    }

    try {
      // RegularTask.run() IS awaitable and returns the final message
      const result = await task.run(
        this.session,
        this.turnContext,
        subId,
        input
      );

      return {
        success: true,
        response: result,
        turnCount: this.getTurnCount(),
        tokenUsage: this.getTokenUsage(),
        stopReason: 'completed',
      };
    } catch (error) {
      const isCancel = abortController.signal.aborted;
      return {
        success: false,
        response: null,
        turnCount: this.getTurnCount(),
        tokenUsage: this.getTokenUsage(),
        stopReason: isCancel ? 'cancelled' : 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Cancel execution */
  cancel(): void {
    this.session.abortAllTasks('UserInterrupt');
  }

  /** Get the internal session (for advanced inspection) */
  getSession(): Session {
    return this.session;
  }
}
```

### 4.3 What AgentExecutor Does NOT Have

| Feature | Why excluded |
|---|---|
| Submission Queue (SQ/EQ) | One prompt, one run. No queue needed. |
| Event Queue + getNextEvent() | Events are pushed via `onEvent` callback, not queued for pull. |
| handleTabBinding() | No browser interaction. Tools that need tabs use tabId from their own context. |
| setupConfigSubscriptions() | Fixed model for the run. No mid-execution model switching. |
| pendingModelKey | No deferred model switching. |
| ApprovalManager | Auto-approve everything. Tool restrictions via ToolRegistry deny list. |
| UserNotifier | No user-facing notifications. Silent execution. |
| handleExecApproval/PatchApproval | No interactive approval flow. |
| handleCompact (manual) | Short-lived execution. Auto-compact in TaskRunner handles context limits. |
| handleGetPath/GetHistoryEntry | No UI queries. |
| isReady() | Caller validates readiness before creating executor. |
| refreshModelClient/hotSwap | Fixed model. No runtime changes. |
| configurePromptComposer() | Already configured by parent bootstrap. |
| registerPlatformTools() | ToolRegistry is injected pre-built. |

## 5. Changes to RepublicAgent

### 5.1 Strategy: Gradual Adoption

RepublicAgent gains an `AgentExecutor` as an internal component but continues using its current `Session.spawnTask()` flow for the UI path. This is intentional:

- `Session.spawnTask()` is fire-and-forget (async), which matches the UI's event-driven architecture
- `AgentExecutor.run()` is awaitable, which matches sub-agent needs
- Both ultimately call `RegularTask.run()` → `AgentTask.run()` → `TaskRunner.run_task()`

We do NOT rewrite RepublicAgent's main flow. We extract, not restructure.

### 5.2 What Changes

**Constructor** — Create AgentExecutor alongside existing components:

```typescript
// BEFORE (current)
constructor(config: AgentConfig, ...) {
  this.modelClientFactory = new ModelClientFactory();
  this.toolRegistry = new ToolRegistry();
  this.approvalManager = new ApprovalManager(...);
  this.session = new Session(...);
  this.setupNotificationHandlers();
  this.setupConfigSubscriptions();
}

// AFTER (refactored)
constructor(config: AgentConfig, ...) {
  this.modelClientFactory = new ModelClientFactory();
  this.toolRegistry = new ToolRegistry();
  this.approvalManager = new ApprovalManager(...);
  this.session = new Session(...);
  this.setupNotificationHandlers();
  this.setupConfigSubscriptions();

  // NEW: Executor is available for programmatic use
  // (initialized lazily or in initialize())
}
```

**Expose executor factory** — For sub-agent creation:

```typescript
/**
 * Create a standalone AgentExecutor with custom config.
 * Used by sub-agent system to spawn lightweight execution instances.
 */
createExecutor(config: Partial<AgentExecutorConfig>): AgentExecutor {
  return new AgentExecutor({
    agentConfig: this.config,
    modelClientFactory: this.modelClientFactory,
    toolRegistry: config.toolRegistry ?? this.toolRegistry,
    systemPrompt: config.systemPrompt ?? '',
    ...config,
  });
}
```

**processUserInputWithTask()** — Remains unchanged for now. It continues using `Session.spawnTask()` for the existing UI flow. Future optimization: delegate to internal executor.

### 5.3 Public API Impact

| Method | Change |
|---|---|
| `submitOperation()` | No change |
| `getNextEvent()` | No change |
| `setEventDispatcher()` | No change |
| `getSession()` | No change |
| `getToolRegistry()` | No change |
| `getApprovalManager()` | No change |
| `getModelClientFactory()` | No change |
| `createExecutor()` | **NEW** — factory for standalone executors |
| `initialize()` | No change (still registers platform tools, creates model client) |
| All handler methods | No change |

**Zero breaking changes to existing consumers.**

## 6. How Sub-Agents Will Use AgentExecutor

```typescript
// In SubAgentRunner (future)
async run(params: SubAgentToolParams, parentAgent: RepublicAgent): Promise<SubAgentResult> {
  const typeConfig = getSubAgentType(params.type);

  // Create restricted tool registry
  const childRegistry = createSubAgentToolRegistry(
    parentAgent.getToolRegistry(),
    typeConfig
  );

  // Create executor via parent's factory
  const executor = parentAgent.createExecutor({
    toolRegistry: childRegistry,
    systemPrompt: typeConfig.systemPrompt,
    model: typeConfig.model,       // optional override
    persistent: false,             // no history persistence
    maxTurns: typeConfig.maxTurns,
    onEvent: (event) => {
      // Collect events for result extraction / parent notification
    },
  });

  await executor.initialize();

  // Run the prompt — awaitable, returns structured result
  const input: InputItem[] = [{ type: 'text', text: params.prompt }];
  const result = await executor.run(input, {
    maxTurns: typeConfig.maxTurns,
    signal: parentAbortSignal,  // cancel if parent cancels
  });

  return {
    success: result.success,
    response: result.response ?? '',
    runId: uuidv4(),
    turnCount: result.turnCount,
    tokenUsage: result.tokenUsage,
    stopReason: result.stopReason,
    error: result.error,
  };
}
```

## 7. Session Considerations

### 7.1 Lightweight Session for Executors

AgentExecutor creates a Session with `persistent: false`. This means:
- No RolloutRecorder (no disk writes)
- No title generation
- No session index entry
- Fresh empty history
- Still fully functional for turn execution

### 7.2 Session.spawnTask() vs Direct task.run()

| | Session.spawnTask() | task.run() directly |
|---|---|---|
| Used by | RepublicAgent (UI flow) | AgentExecutor |
| Blocking | Fire-and-forget | Awaitable |
| Lifecycle | Session tracks running tasks | Caller manages lifecycle |
| Abort existing | Aborts all existing tasks first | N/A — single execution |
| Events | Via Session.onTaskFinished/Aborted | Via onEvent callback |

AgentExecutor calls `task.run(session, context, subId, input)` directly, which internally creates `TurnManager` → `AgentTask` → `TaskRunner`. The full multi-turn loop runs synchronously (from the caller's perspective) until the LLM produces a response with no tool calls.

### 7.3 ToolRegistry Injection

Currently, `RegularTask.run()` gets the ToolRegistry from Session:

```typescript
// RegularTask.ts line 46
const turnManager = new TurnManager(
  session,
  context,
  session.getToolRegistry() as ToolRegistry
);
```

AgentExecutor passes the restricted ToolRegistry into Session's constructor, so `session.getToolRegistry()` returns the correct restricted set. No change to RegularTask needed.

## 8. What Does NOT Change

These files are untouched by this refactoring:

| File | Reason |
|---|---|
| `Session.ts` | Session already supports optional config, optional persistence, injected ToolRegistry |
| `TurnManager.ts` | Already takes Session, TurnContext, ToolRegistry as constructor params |
| `TaskRunner.ts` | Already takes Session, TurnContext, TurnManager as constructor params |
| `AgentTask.ts` | Already takes Session, TurnContext, TurnManager as constructor params |
| `RegularTask.ts` | Already implements `SessionTask.run()` which is what AgentExecutor calls |
| `TurnContext.ts` | Already supports custom system prompt, model, approval policy |
| `ToolRegistry.ts` | Already instanceable, per-agent |
| `AgentConfig.ts` | Shared singleton — no changes needed |
| `ModelClientFactory.ts` | Already creates clients by model key — sharable across instances |

## 9. Implementation Tasks

### T01: Create AgentExecutorConfig types
**File:** `src/core/AgentExecutorConfig.ts` (new)
- [ ] Define `AgentExecutorConfig` interface
- [ ] Define `ExecutorResult` interface
- [ ] Define `RunOptions` interface
**Blocked by:** nothing

### T02: Implement AgentExecutor
**File:** `src/core/AgentExecutor.ts` (new, ~150 lines)
- [ ] Constructor: create Session with injected ToolRegistry, non-persistent
- [ ] `initialize()`: create ModelClient, TurnContext, wire event callback
- [ ] `run()`: create RegularTask, call task.run() directly, return ExecutorResult
- [ ] `cancel()`: abort session tasks
- [ ] `getSession()`: expose for inspection
- [ ] Handle abort signal wiring
**Blocked by:** T01

### T03: Add createExecutor() to RepublicAgent
**File:** `src/core/RepublicAgent.ts` (modify, ~15 lines added)
- [ ] Add `createExecutor(config)` method
- [ ] Passes shared AgentConfig, ModelClientFactory
- [ ] Allows override of ToolRegistry, systemPrompt, model
**Blocked by:** T02

### T04: Add getToolEntry() to ToolRegistry
**File:** `src/tools/ToolRegistry.ts` (modify, ~5 lines)
- [ ] Expose `getToolEntry(name): ToolRegistryEntry | undefined`
- [ ] Needed by tool subsetting (sub-agent copies tools from parent)
**Blocked by:** nothing

### T05: Unit tests for AgentExecutor
- [ ] Test: run() returns final assistant message
- [ ] Test: restricted ToolRegistry is respected
- [ ] Test: cancel() aborts execution
- [ ] Test: maxTurns enforcement
- [ ] Test: onEvent callback receives events
- [ ] Test: non-persistent Session doesn't write to disk
**Blocked by:** T02

### T06: Integration test — AgentExecutor with RepublicAgent
- [ ] Test: parentAgent.createExecutor() produces working executor
- [ ] Test: executor shares parent's ModelClientFactory (same auth)
- [ ] Test: executor uses restricted ToolRegistry
- [ ] Test: executor runs independently of parent's session
**Blocked by:** T03

### Dependency graph

```
T01 ── T02 ── T03 ── T06
              T05
T04 (parallel, independent)
```

**Critical path:** T01 → T02 → T03 → T06

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Session constructor side effects (RolloutRecorder, title gen) | `persistent: false` skips rollout init. Title gen is lazy. |
| PromptComposer global state | AgentExecutor does NOT call configurePromptComposer(). It's already set by bootstrap. |
| Session dummy ModelClient in constructor | Session creates a dummy client in constructor (lines 115-128). AgentExecutor replaces it in `initialize()` via `session.setTurnContext()`. Same pattern RepublicAgent uses. |
| Tool handlers closing over parent state | Tool handlers are functions. They reference `tabId` from the execution request, not from a captured closure. Safe to copy. |
| AgentExecutor creates another Session | Each Session has its own conversationId and empty history. No conflict with parent's Session. |

## 11. Future: Unifying RepublicAgent's Execution Path

After AgentExecutor is proven stable, RepublicAgent's `processUserInputWithTask()` could be refactored to delegate to an internal AgentExecutor:

```typescript
// Future optimization (NOT part of this refactoring)
private async processUserInputWithTask(items, overrides, newTask, context) {
  await this.handleTabBinding(context);     // tab management stays
  await this.applyPendingModelSwitch();     // config reactivity stays

  // Delegate core execution to internal executor
  const result = await this.executor.run(inputItems);

  // Route result to event queue for UI
  this.emitEvent({ type: 'TaskComplete', data: { ... } });
}
```

This would unify the execution path (one code path for both UI and sub-agents) but is a separate, lower-priority refactoring. The current design keeps RepublicAgent's existing flow untouched.
