# Track 08: Centralized Message Queue

## Problem

BrowserX has multiple independent messaging primitives scattered across the codebase:

1. **PriorityQueue / SubmissionQueue / EventQueue** (`src/core/QueueProcessor.ts`) — generic priority queue with typed specializations for Ops and Events, but no semantic awareness of what it's queuing
2. **ChannelManager** (`src/core/channels/ChannelManager.ts`) — routes submissions from UI channels to the agent and dispatches events back, but has no queue semantics (fire-and-forget dispatch)
3. **ServiceRegistry** (`src/core/channels/ServiceRegistry.ts`) — dotted-path RPC routing, but no message queue underneath (direct handler invocation)
4. **UIChannelClient** (`src/core/messaging/UIChannelClient.ts`) — frontend RPC client with 30s timeout and event subscription, but manages its own pending-request map independently
5. **EffectQueue** (`src/extension/content/ui_effect/utils/eventQueue.ts`) — FIFO queue for visual effects with adaptive speed boost, completely disconnected from the main event system
6. **Config messaging** (`src/core/protocol/config-messages.ts`) — separate request/response/broadcast protocol for configuration changes

This creates several problems:

- **No unified event bus**: Components that need to react to events must know which specific queue/manager to subscribe to. A tool execution event goes through EventQueue, but a config change goes through config-messages, and a service response goes through ServiceRegistry.
- **No command-type-aware batching**: The QueueProcessor uses generic tick-based batch processing. It doesn't know that interrupt ops should preempt everything, or that multiple read-only tool calls could be batched.
- **No cross-cutting observability**: There's no single point to tap into for logging, metrics, or debugging all message flow. Each subsystem logs independently.
- **No backpressure or flow control**: EventQueue has a maxSize cap but no backpressure signaling. If a channel is slow, events are silently dropped.
- **No replay or persistence**: Events are fire-and-forget. Late subscribers miss events. There's no event log for debugging or recovery.
- **Tight coupling between transport and semantics**: ChannelManager mixes "how to deliver" with "what to deliver". Adding a new channel type requires understanding the full event routing path.

## What Claudy Does

### Signal Primitive (Lightweight Notifications)

```typescript
// src/utils/signal.ts
function createSignal<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe: (fn: (...args: Args) => void) => {
      listeners.add(fn); return () => listeners.delete(fn)
    },
    emit: (...args: Args) => listeners.forEach(fn => fn(...args)),
    clear: () => listeners.clear(),
  }
}
```

Used ~15+ times across the codebase for simple "something happened" notifications without stored state. Examples: task updates, settings changes, fast mode toggling, hint state changes.

### Unified Command Queue (messageQueueManager)

```typescript
// src/utils/messageQueueManager.ts
// Module-level, transport-agnostic command queue

type CommandPriority = 'now' | 'next' | 'later'

enqueue(command, priority = 'next')           // User commands
enqueuePendingNotification(command, 'later')  // System notifications
dequeue(filter?)                               // Pop highest-priority
peek(filter?)                                  // Look without removing
dequeueAllMatching(predicate)                  // Batch drain by predicate
```

**Semantic priority tiers** instead of numeric:
- `'now'` — user interrupts, must preempt current processing
- `'next'` — mid-turn drains (tool results, approvals)
- `'later'` — end-of-turn processing (notifications, cleanup)

**React integration** via `useSyncExternalStore`:
```typescript
subscribeToCommandQueue()    // Subscribe to changes
getCommandQueueSnapshot()    // Frozen array snapshot
```

### Intelligent Queue Processor

```typescript
// src/utils/queueProcessor.ts
// Command-type-aware batching:
// - Slash commands (/cmd) → processed individually
// - Bash commands → processed individually (exit code isolation)
// - Prompts → batched together
// - Priority respected: 'now' interrupts > 'next' mid-turn > 'later' end-of-turn
```

### Mailbox Pattern (Cross-Component Async Handshakes)

```typescript
// src/utils/mailbox.ts
// Typed message queue with poll + await semantics:
send(msg)         // Queue or satisfy a waiting promise
poll(fn)          // Non-blocking check for matching message
receive(fn)       // Await a matching message
subscribe(fn)     // React to any enqueue/dequeue
// Tracks revision counter for dirty checks
```

Used for cross-component async coordination: awaiting user input, permission decisions, inter-agent messages.

### SDK Event Queue (External Consumers)

```typescript
// src/utils/sdkEventQueue.ts
// Separate bounded event stream for SDK/IDE consumers:
enqueueSdkEvent(event)   // Bounded queue (max 1000)
drainSdkEvents()         // Flush all events with UUID + session ID
// Event types: TaskStarted, TaskProgress, TaskNotification, SessionStateChanged
```

### Hook Event System (Lifecycle Broadcasting)

```typescript
// src/utils/hooks/hookEvents.ts
// Queues up to 100 events before handler registration
// Selective emission based on feature flags
// Types: HookStarted, HookProgress, HookResponse
```

### Key Insight: Layered Message Flow

```
User Input → Command Queue (messageQueueManager)
    ↓
Queue Processor (decides batch/single based on command type)
    ↓
Query Engine (streaming loop)
    ↓
Session State Transitions (notifySessionStateChanged → 3 listener slots)
    ↓
SDK Events (sdkEventQueue drain for headless consumers)
    ↓
Bridge/Remote Transport (replBridgeTransport)
    ↓
WebSocket/SSE (physical transport)
```

Each layer has a clear responsibility. The command queue handles *what* to process, the processor handles *how* to batch, the session state handles *who* to notify, and the transport handles *where* to deliver.

## BrowserX Mapping

### Current Architecture (Fragmented)

```
User Input → ChannelAdapter.onSubmission()
    ↓
ChannelManager → routes to AgentHandler (direct invocation, no queue)
    ↓
RepublicAgent.handleSubmission() → SubmissionQueue (generic priority)
    ↓
QueueProcessor.processTick() → batch by count, not by type
    ↓
TurnManager → tool execution → EventQueue.emit()
    ↓
EventQueue → notifies listeners (synchronous, no backpressure)
    ↓
ChannelManager.dispatchEvent() → broadcast to channels (fire-and-forget)
```

**Problems with this flow:**

1. ChannelManager routes submissions directly — no queuing, ordering, or deduplication
2. QueueProcessor batches by count (`batchSize`), not by operation semantics
3. EventQueue listeners are synchronous — a slow listener blocks all others
4. No distinction between "must process now" vs "can wait" beyond numeric priority
5. Config changes, service responses, and agent events flow through different paths
6. No way to replay events for late-joining channels (e.g., a reconnecting WebSocket)

### Proposed Architecture: MessageBus

```
src/core/messaging/
├── MessageBus.ts            # Central event bus with topics and subscriptions
├── CommandQueue.ts          # Semantic command queue (replaces SubmissionQueue)
├── CommandProcessor.ts      # Type-aware batching (replaces QueueProcessor)
├── EventLog.ts              # Bounded event log with replay capability
├── Mailbox.ts               # Typed async poll/await for cross-component handshakes
├── Signal.ts                # Lightweight fire-and-forget notifications
├── types.ts                 # Shared message types
└── middleware/
    ├── LoggingMiddleware.ts  # Cross-cutting event logging
    ├── MetricsMiddleware.ts  # Throughput, latency, queue depth
    └── FilterMiddleware.ts   # Per-subscriber event filtering
```

### MessageBus (Central Event Bus)

The MessageBus unifies all event routing through a single observable pipeline. It does NOT replace ChannelManager (transport) or ServiceRegistry (RPC). It sits between them as the semantic routing layer.

```typescript
interface MessageBus {
  // Publishing
  publish(topic: string, message: BusMessage): void
  publishBatch(messages: Array<{ topic: string; message: BusMessage }>): void

  // Subscription
  subscribe(topic: string, handler: MessageHandler, options?: SubscribeOptions): Unsubscribe
  subscribePattern(pattern: string, handler: MessageHandler): Unsubscribe  // glob: 'tool.*'

  // Middleware
  use(middleware: BusMiddleware): void

  // Replay
  replay(topic: string, fromSequence: number, handler: MessageHandler): void

  // Diagnostics
  getStats(): BusStats
  getTopicStats(topic: string): TopicStats
}

interface BusMessage {
  id: string
  timestamp: number
  sequence: number        // Monotonic, per-topic
  source: string          // 'agent' | 'channel:sidepanel' | 'scheduler' | 'mcp:serverName'
  payload: unknown
  metadata?: Record<string, unknown>
}

interface SubscribeOptions {
  // Delivery guarantees
  mode: 'sync' | 'async' | 'batched'
  batchInterval?: number   // ms, for mode='batched'
  batchSize?: number

  // Backpressure
  maxPending?: number      // Max unprocessed messages before dropping
  onBackpressure?: 'drop-oldest' | 'drop-newest' | 'block'

  // Filtering
  filter?: (message: BusMessage) => boolean
}

type BusMiddleware = (
  topic: string,
  message: BusMessage,
  next: () => void
) => void
```

**Topic hierarchy** (maps to existing EventMsg types):

```
agent.turn.started          → TurnStarted
agent.turn.complete         → TurnComplete
agent.turn.aborted          → TurnAborted
agent.message               → AgentMessage
agent.message.delta         → AgentMessageDelta
agent.reasoning.*           → AgentReasoning, AgentReasoningDelta, ...

tool.execution.start        → ToolExecutionStart
tool.execution.end          → ToolExecutionEnd
tool.execution.error        → ToolExecutionError
tool.execution.timeout      → ToolExecutionTimeout

approval.requested          → ApprovalRequested
approval.granted            → ApprovalGranted
approval.denied             → ApprovalDenied
approval.auto               → ApprovalAutoApproved

task.started                → TaskStarted
task.complete               → TaskComplete
task.failed                 → TaskFailed
task.update                 → TaskUpdate

session.configured          → SessionConfigured
session.compacted           → CompactionCompleted

diff.change.added           → ChangeAdded
diff.rollback.*             → RollbackStarted, RollbackCompleted, ...

browser.dom.*               → DOMActionStart
browser.navigation.*        → NavigationActionStart
browser.storage.*           → StorageActionStart

mcp.tool.call.begin         → McpToolCallBegin
mcp.tool.call.end           → McpToolCallEnd

config.changed              → CONFIG_CHANGE (from config-messages.ts)
config.sync                 → CONFIG_SYNC

service.response            → ServiceResponse
```

### CommandQueue (Semantic Priority)

Replaces `SubmissionQueue` with semantic priority tiers inspired by Claudy:

```typescript
type CommandPriority = 'interrupt' | 'immediate' | 'normal' | 'deferred'

interface CommandQueue {
  enqueue(op: Op, context: SubmissionContext, priority?: CommandPriority): void
  dequeue(filter?: (op: Op) => boolean): QueuedCommand | null
  peek(filter?: (op: Op) => boolean): QueuedCommand | null
  drain(predicate: (op: Op) => boolean): QueuedCommand[]
  cancelByType(type: Op['type']): number
  size(): number
  isEmpty(): boolean

  // React/Svelte integration
  subscribe(listener: () => void): Unsubscribe
  getSnapshot(): readonly QueuedCommand[]
}
```

**Auto-priority mapping:**

| Op Type | Priority | Rationale |
|---------|----------|-----------|
| `Interrupt`, `Shutdown` | `interrupt` | Must preempt everything |
| `ExecApproval`, `PatchApproval` | `immediate` | Unblocks waiting tool execution |
| `UserTurn`, `UserInput` | `normal` | Standard user interaction |
| `ServiceRequest`, `ConfigSync` | `deferred` | Can wait for current processing |

### CommandProcessor (Type-Aware Batching)

Replaces `QueueProcessor` with intelligent batching:

```typescript
interface CommandProcessor {
  start(): void
  stop(): void
  processNext(): Promise<ProcessResult>

  // Configuration
  setBatchStrategy(strategy: BatchStrategy): void
}

type BatchStrategy = {
  // Commands that must be processed individually (never batched)
  isolateTypes: Set<Op['type']>    // e.g., Interrupt, Shutdown, ExecApproval

  // Commands that can be batched together
  batchableTypes: Set<Op['type']>  // e.g., multiple ServiceRequests

  // Max batch size for batchable types
  maxBatchSize: number

  // Max wait time before flushing a partial batch
  maxBatchWaitMs: number
}
```

**Default strategy:**

```typescript
const defaultStrategy: BatchStrategy = {
  isolateTypes: new Set(['Interrupt', 'Shutdown', 'ExecApproval', 'PatchApproval']),
  batchableTypes: new Set(['ServiceRequest', 'ConfigSync']),
  maxBatchSize: 10,
  maxBatchWaitMs: 50,
}
```

### EventLog (Bounded Replay)

New capability — enables late-joining subscribers and debugging:

```typescript
interface EventLog {
  // Append (called by MessageBus middleware)
  append(topic: string, message: BusMessage): void

  // Replay
  replay(topic: string, fromSequence: number): BusMessage[]
  replayAll(fromSequence: number): Array<{ topic: string; message: BusMessage }>

  // Retention
  setMaxEntries(max: number): void    // Default: 5000
  setMaxAgeMs(maxAge: number): void   // Default: 5 minutes

  // Diagnostics
  getOldestSequence(): number
  getNewestSequence(): number
  getEntryCount(): number
}
```

**Use cases:**
- Reconnecting WebSocket channel replays missed events
- Debugging: "what happened in the last 30 seconds?"
- Late-initialized UI components catch up on current state

### Signal (Lightweight Notifications)

Import Claudy's signal primitive for simple fire-and-forget:

```typescript
function createSignal<Args extends unknown[]>(): Signal<Args>

interface Signal<Args extends unknown[]> {
  subscribe(fn: (...args: Args) => void): Unsubscribe
  emit(...args: Args): void
  clear(): void
}
```

**Use cases** (replace scattered ad-hoc patterns):
- Settings change notifications
- Theme toggle events
- Connection state changes
- UI effect triggers

### Mailbox (Async Handshakes)

Import Claudy's mailbox for cross-component coordination:

```typescript
interface Mailbox<T> {
  send(msg: T): void
  poll(predicate: (msg: T) => boolean): T | null
  receive(predicate: (msg: T) => boolean): Promise<T>
  subscribe(listener: (event: 'enqueue' | 'dequeue', msg: T) => void): Unsubscribe
  readonly revision: number
}
```

**Use cases:**
- Approval flow: tool execution awaits approval decision
- Inter-agent messaging: coordinator awaits worker completion
- User input prompts: agent awaits user response

## Integration with Existing Architecture

### What Changes

| Current | New | Migration |
|---------|-----|-----------|
| `EventQueue.emit()` | `messageBus.publish('topic', msg)` | EventQueue becomes a thin wrapper that publishes to MessageBus |
| `EventQueue.on(type, cb)` | `messageBus.subscribe('topic', cb)` | Direct replacement |
| `SubmissionQueue` | `CommandQueue` | Replace with semantic priorities |
| `QueueProcessor` | `CommandProcessor` | Replace with type-aware batching |
| `ChannelManager.dispatchEvent()` | `messageBus.subscribe('*', channelDispatcher)` | ChannelManager subscribes to MessageBus instead of being called directly |
| Config messaging protocol | `messageBus.publish('config.*', ...)` | Config changes flow through MessageBus |

### What Stays the Same

- **ChannelAdapter interface** — channels still implement the same adapter contract
- **ServiceRegistry** — RPC routing stays as-is (request/response, not pub/sub)
- **EventMsg type** — the 80+ event union type remains the payload contract
- **Op type** — submission operations unchanged
- **UIChannelClient** — frontend client keeps its RPC pattern, subscribes via MessageBus

### Wiring Diagram

```
                    ┌─────────────────────────────────────────┐
                    │              MessageBus                  │
                    │                                         │
User Input ────►    │  CommandQueue ──► CommandProcessor       │
                    │       │              │                   │
                    │       │         ┌────┴────┐             │
                    │       │         │ Batched │             │
                    │       ▼         │ vs Solo │             │
                    │  ┌─────────┐    └────┬────┘             │
                    │  │ EventLog│◄────────┘                  │
                    │  └────┬────┘                            │
                    │       │                                 │
                    │  topic subscriptions                    │
                    │       │                                 │
                    │  ┌────┴─────────────────────────┐       │
                    │  │                              │       │
                    └──┼──────────────────────────────┼───────┘
                       │                              │
               ┌───────┴───────┐              ┌──────┴──────┐
               │ ChannelManager│              │ AgentSession │
               │ (transport)   │              │ (processing) │
               └───────┬───────┘              └──────────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
     SidePanel     WebSocket     Tauri
     Channel       Channel      Channel
```

### Dependency on Other Tracks

- **Track 01 (Hook & Event System)**: Hooks subscribe to MessageBus topics (`tool.execution.*`, `approval.*`) instead of ad-hoc event wiring
- **Track 04 (Typed Task Families)**: Task lifecycle events publish to `task.*` topics
- **Track 06 (Multi-Agent Coordination)**: Cross-agent messages flow through Mailbox pattern
- **Track 07 (Centralized State)**: State changes publish to `state.*` topics; AgentStateStore subscribes to MessageBus for automatic updates

## Risks

- **Migration complexity**: Existing code subscribes to EventQueue directly. Migration must be incremental — EventQueue wraps MessageBus initially, then direct subscriptions migrate.
- **Performance**: Adding a middleware pipeline to every event adds latency. Mitigate with fast-path for events with no middleware and lazy message serialization.
- **Over-engineering**: Not every notification needs the full MessageBus. Keep Signal for simple fire-and-forget cases. The rule: if it has subscribers across module boundaries, use MessageBus. If it's within a single module, use Signal.
- **Topic explosion**: 80+ EventMsg types mapped to topics is a lot. Use wildcard subscriptions (`tool.*`) to keep subscriber code manageable.

## Phase Plan

**Phase 1: Signal + Mailbox** (Week 1)
- Implement Signal primitive (port from Claudy)
- Implement Mailbox with poll/receive/subscribe
- Replace 3-5 existing ad-hoc notification patterns with Signal
- Wire Mailbox into approval flow as proof of concept

**Phase 2: MessageBus Core** (Week 2)
- Implement MessageBus with topic-based pub/sub
- Implement EventLog with bounded replay
- Add logging middleware
- Wire EventQueue.emit() to publish through MessageBus (backward-compatible wrapper)

**Phase 3: CommandQueue + CommandProcessor** (Week 3)
- Implement CommandQueue with semantic priorities
- Implement CommandProcessor with type-aware batching
- Replace SubmissionQueue and QueueProcessor
- Wire ChannelManager to subscribe via MessageBus for event dispatch

**Phase 4: Migration + Middleware** (Week 4)
- Migrate remaining direct EventQueue subscribers to MessageBus topics
- Add metrics middleware (queue depth, throughput, latency)
- Add filter middleware for per-channel event filtering
- Wire config-messages through MessageBus
- Add replay support for reconnecting channels
- Remove EventQueue direct usage (keep as thin wrapper if needed)

## Comparison Summary

| Aspect | BrowserX (Current) | Claudy | BrowserX (Proposed) |
|--------|-------------------|--------|-------------------|
| Event routing | EventQueue + ChannelManager (separate) | Signal + messageQueueManager + sdkEventQueue (layered) | MessageBus (unified) with Signal for simple cases |
| Command priority | Numeric (0/1/2) | Semantic ('now'/'next'/'later') | Semantic ('interrupt'/'immediate'/'normal'/'deferred') |
| Batching | Generic tick-based (count) | Command-type-aware (slash/bash/prompt) | Op-type-aware (isolate/batchable) |
| Cross-component handshakes | Ad-hoc callbacks | Mailbox (poll/receive) | Mailbox (ported from Claudy) |
| Simple notifications | Direct callbacks | Signal primitive | Signal primitive (ported) |
| Event replay | None | Partial (sdkEventQueue drain) | Full (EventLog with bounded replay) |
| Observability | Scattered console.log | OpenTelemetry | Middleware pipeline (logging, metrics, filtering) |
| Backpressure | Silent drop at maxSize | Bounded queue (1000) | Configurable per-subscriber (drop-oldest/newest/block) |
