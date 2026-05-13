# Track 08: Centralized Message Queue

## Problem

BrowserX has multiple independent messaging primitives scattered across the codebase:

1. **PriorityQueue / SubmissionQueue / EventQueue** (`src/core/QueueProcessor.ts`) — generic priority queue with typed specializations for Ops and Events, but no semantic awareness of what it's queuing
2. **ChannelManager** (`src/core/channels/ChannelManager.ts`) — routes submissions from UI channels to the agent and dispatches events back, but has no queue semantics (fire-and-forget dispatch)
3. **ServiceRegistry** (`src/core/channels/ServiceRegistry.ts`) — dotted-path RPC routing, but no message queue underneath (direct handler invocation)
4. **UIChannelClient** (`src/core/messaging/UIChannelClient.ts`) — frontend RPC client with 30s timeout and event subscription, but manages its own pending-request map independently
5. **EffectQueue** (`src/extension/content/ui_effect/utils/eventQueue.ts`) — FIFO queue for visual effects with adaptive speed boost, completely disconnected from the main event system
6. **Config messaging** (`src/core/protocol/config-messages.ts`) — separate request/response/broadcast protocol for configuration changes

### Critical Finding: QueueProcessor Classes Are Unused

Code inspection reveals that **RepublicAgent does NOT use the `QueueProcessor`, `SubmissionQueue`, or `EventQueue` classes** from `QueueProcessor.ts`. Instead, `RepublicAgent` manages two plain arrays:

```typescript
// src/core/RepublicAgent.ts (actual code)
private submissionQueue: Submission[] = [];   // Plain array, FIFO only
private eventQueue: Event[] = [];             // Plain array, no priority

async submitOperation(op: Op, context?: { tabId?: number }): Promise<string> {
  const id = `sub_${this.nextId++}`;
  const submission: Submission = { id, op, context };
  this.submissionQueue.push(submission);      // Push to end
  if (!this.isProcessing) {
    this.processSubmissionQueue();            // Start sequential processing
  }
  return id;
}

private async processSubmissionQueue(): Promise<void> {
  this.isProcessing = true;
  while (this.submissionQueue.length > 0) {
    const submission = this.submissionQueue.shift()!;  // FIFO, no priority
    await this.handleSubmission(submission);            // One at a time
  }
  this.isProcessing = false;
}
```

This means:
- **No priority ordering**: Interrupts wait behind regular submissions
- **No batching**: Each submission processed individually in sequence
- **No filtering**: No way to drain specific operation types
- **No mid-turn drain**: Unlike claudy, queued commands cannot be injected mid-turn
- The `QueueProcessor.ts` classes (`SubmissionQueue`, `EventQueue`, `QueueProcessor`) are dead code — defined but never instantiated by the agent

Similarly, event emission is fire-and-forget:

```typescript
// src/core/RepublicAgent.ts (actual code)
emitEvent(msg: EventMsg): void {
  const event: Event = { id: `evt_${this.nextId++}`, msg };
  this.eventQueue.push(event);           // Push to plain array
  if (this.eventDispatcher) {
    this.eventDispatcher(event);          // Fire-and-forget to channels
  }
}
```

This creates several problems:

- **No unified event bus**: Components that need to react to events must know which specific queue/manager to subscribe to. A tool execution event goes through the eventDispatcher callback, but a config change goes through config-messages, and a service response goes through ServiceRegistry.
- **No command-type-aware batching**: Submissions are processed strictly FIFO with no awareness that interrupt ops should preempt everything.
- **No cross-cutting observability**: There's no single point to tap into for logging, metrics, or debugging all message flow. Each subsystem logs independently.
- **No backpressure or flow control**: The event array grows unbounded. If a channel is slow, events pile up with no signaling.
- **No replay or persistence**: Events are fire-and-forget. Late subscribers miss events. There's no event log for debugging or recovery.
- **Tight coupling between transport and semantics**: ChannelManager mixes "how to deliver" with "what to deliver". Adding a new channel type requires understanding the full event routing path.

## What Claudy Does

### Claudy Foundation (Validated 2026-05-11)

Re-validation against the claudy source confirms the following set of primitives actually exist, and clarifies what the design above should *not* assume claudy already provides:

- ✅ `utils/messageQueueManager.ts` — semantic priority queue (`now` / `next` / `later`) with mid-turn drain in the query loop
- ✅ `utils/signal.ts` — lightweight 1:N fire-and-forget primitive
- ✅ `utils/mailbox.ts` — async handshakes with direct-handoff optimization
- ❌ **No unified event bus** — events flow through independent channels (`messageQueueManager` for input, `sdkEventQueue` for headless, `hookEvents` for lifecycle). There is no single MessageBus or topic registry in claudy.
- ❌ **No EventLog with replay** — only bounded buffers (`sdkEventQueue` 1000 max, drop-oldest; `hookEvents` 100 pending then flush-on-handler-register).
- ❌ **No middleware pipeline** — event delivery is direct, not chained through middleware.
- ❌ **No backpressure signaling** — overflow is handled with drop-oldest, never with producer-side back-pressure.

Anything in this design beyond the three ✅ primitives is a deliberate BrowserX extension, not a port. See "Why BrowserX Extends Beyond Claudy" below.

### Signal Primitive (Lightweight Notifications)

```typescript
// src/utils/signal.ts — Full implementation
export type Signal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
```

Used ~15+ times across the codebase for simple "something happened" notifications without stored state:
- `messageQueueManager.ts` — `const queueChanged = createSignal()` signals queue mutations
- `QueryGuard.ts` — `private _changed = createSignal()` for query state transitions
- `mailbox.ts` — `private changed = createSignal()` for message arrivals
- `tasks.ts` — `const tasksUpdated = createSignal()` for task list updates
- `fastMode.ts` — `cooldownTriggered = createSignal<[resetAt: number, reason]>()`
- `keybindings/loadUserBindings.ts` — keybinding update notifications
- `skills/loadSkillsDir.ts` — skill loading completion
- `bootstrap/state.ts` — `const sessionSwitched = createSignal<[id: SessionId]>()`

**Key design pattern**: Signal acts as the subscription bridge for React's `useSyncExternalStore`. In BrowserX, it will serve the same role for Svelte stores via the `subscribe` contract.

### Unified Command Queue (messageQueueManager)

```typescript
// src/utils/messageQueueManager.ts — Key implementation details (548 lines)

// Module-level state (singleton pattern via module scope)
const commandQueue: QueuedCommand[] = []
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,    // Interrupt immediately
  next: 1,   // Mid-turn drain (after current tool finishes)
  later: 2,  // End-of-turn drain
}
```

**Priority-based dequeue (critical algorithm):**
```typescript
function dequeue(filter?: (cmd: QueuedCommand) => boolean): QueuedCommand | undefined {
  if (commandQueue.length === 0) return undefined

  // Linear scan: find first item with lowest priority value
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }

  if (bestIdx === -1) return undefined
  const [dequeued] = commandQueue.splice(bestIdx, 1)
  notifySubscribers()
  return dequeued
}
```

**Batch dequeue:**
```typescript
function dequeueAllMatching(predicate: (cmd: QueuedCommand) => boolean): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of commandQueue) {
    if (predicate(cmd)) matched.push(cmd)
    else remaining.push(cmd)
  }
  if (matched.length === 0) return []
  commandQueue.length = 0
  commandQueue.push(...remaining)
  notifySubscribers()
  return matched
}
```

**React integration** via `useSyncExternalStore`:
```typescript
subscribeToCommandQueue = queueChanged.subscribe  // Subscription function
getCommandQueueSnapshot()                          // Frozen array snapshot
// Snapshot only changes reference on mutation (optimization)
```

**Enqueue variants:**
```typescript
enqueue(command)                                   // Default priority: 'next'
enqueuePendingNotification(command)                // Default priority: 'later'
```

**QueuedCommand type** (from `types/textInputTypes.ts`):
```typescript
type QueuedCommand = {
  value: string | Array<ContentBlockParam>
  mode: PromptInputMode  // 'bash' | 'prompt' | 'orphaned-permission' | 'task-notification'
  priority?: QueuePriority  // 'now' | 'next' | 'later'
  uuid?: UUID
  agentId?: AgentId         // Subagent routing (undefined = main thread)
  origin?: MessageOrigin    // Provenance tracking
  // ... other fields for images, bridge origin, meta flags
}
```

### Intelligent Queue Processor

```typescript
// src/utils/queueProcessor.ts — Full implementation (96 lines)

function processQueueIfReady({ executeInput }): ProcessQueueResult {
  // Filter for main-thread commands only
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  const next = peek(isMainThread)
  if (!next) return { processed: false }

  // DECISION: Process individually vs batch
  if (isSlashCommand(next) || next.mode === 'bash') {
    // Slash commands and bash: individual processing (error isolation)
    const cmd = dequeue(isMainThread)!
    void executeInput([cmd])
    return { processed: true }
  }

  // Batch all same-mode, non-slash commands together
  const targetMode = next.mode
  const commands = dequeueAllMatching(
    cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) return { processed: false }

  void executeInput(commands)
  return { processed: true }
}
```

**Key design decisions:**
1. **Slash/Bash isolation**: Individual processing preserves exit codes and progress UI
2. **Mode batching**: All same-mode, non-slash commands drain together into a single user message
3. **No mode mixing**: `'prompt'` and `'task-notification'` never combine
4. **Main thread filter**: `agentId === undefined` prevents subagent notifications from stalling main thread

### Mid-Turn Queue Drain (Critical Pattern)

Claudy drains queued commands **during** the query processing loop, injecting queued prompts/task-notifications as **attachments between tool executions** (see `utils/query.ts` around the tool-execution boundary, ~line 1570). The drain filters by `agentId` (main thread vs subagent), excludes slash commands, and converts each queued command into a tool-result attachment that the next model call sees as if it were part of the prior turn.

BrowserX cannot mirror this today because `Session.spawnTask` is not generator-based — once it is, the same drain hook can be inserted at the inter-tool boundary.

```typescript
// src/utils/query.ts — Mid-turn drain between tool execution rounds
const queuedCommandsSnapshot = getCommandsByMaxPriority(
  sleepRan ? 'later' : 'next'  // Post-Sleep: drain 'later'; otherwise 'next' only
).filter(cmd => {
  if (isSlashCommand(cmd)) return false
  if (isMainThread) return cmd.agentId === undefined
  return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
})

// Convert queued commands to tool result attachments → sent to model
for await (const attachment of getAttachmentMessages(..., queuedCommandsSnapshot, ...)) {
  yield attachment
}

// Remove consumed commands from queue
removeFromQueue(consumedCommands)
```

This allows new user messages or notifications to be injected into the current turn without waiting for it to complete.

### Mailbox Pattern (Cross-Component Async Handshakes)

```typescript
// src/utils/mailbox.ts — Full implementation (74 lines)

class Mailbox {
  private queue: Message[] = []
  private waiters: Waiter[] = []  // { fn: predicate, resolve: Promise resolver }
  private changed = createSignal()
  private _revision = 0

  get revision(): number { return this._revision }

  send(msg: Message): void {
    this._revision++
    // Direct handoff: check if a receiver is already waiting
    const idx = this.waiters.findIndex(w => w.fn(msg))
    if (idx !== -1) {
      const waiter = this.waiters.splice(idx, 1)[0]
      waiter.resolve(msg)  // Satisfy waiting promise directly
      this.notify()
      return
    }
    // No receiver waiting — queue the message
    this.queue.push(msg)
    this.notify()
  }

  poll(fn?: (msg: Message) => boolean): Message | undefined {
    const idx = this.queue.findIndex(fn ?? (() => true))
    if (idx === -1) return undefined
    return this.queue.splice(idx, 1)[0]
  }

  receive(fn?: (msg: Message) => boolean): Promise<Message> {
    // Check queue first
    const idx = this.queue.findIndex(fn ?? (() => true))
    if (idx !== -1) {
      const msg = this.queue.splice(idx, 1)[0]
      this.notify()
      return Promise.resolve(msg)
    }
    // Block in a Promise until a matching message arrives
    return new Promise<Message>(resolve => {
      this.waiters.push({ fn: fn ?? (() => true), resolve })
    })
  }

  subscribe = this.changed.subscribe
}
```

**Design patterns:**
- **Dual mode**: Poll (nonblocking) or Receive (Promise-based blocking)
- **Direct handoff**: If a waiter is waiting, deliver directly without queuing — avoids unnecessary queue/dequeue
- **Revision counter**: Monotonic increment on every `send()` — used for cache invalidation / dirty checks
- **Predicate-based**: Both `poll()` and `receive()` accept optional filter function

### SDK Event Queue (External Consumers)

```typescript
// src/utils/sdkEventQueue.ts — Separate bounded queue for headless mode

const MAX_QUEUE_SIZE = 1000
const queue: SdkEvent[] = []

function enqueueSdkEvent(event: SdkEvent): void {
  if (!getIsNonInteractiveSession()) return  // Only in headless mode
  if (queue.length >= MAX_QUEUE_SIZE) queue.shift()  // Drop oldest on overflow
  queue.push(event)
}

function drainSdkEvents(): SdkEvent[] {
  if (queue.length === 0) return []
  const events = queue.splice(0)  // Clear and return all
  return events.map(e => ({ ...e, uuid: randomUUID(), session_id: getSessionId() }))
}
```

### Hook Event System (Lifecycle Broadcasting)

```typescript
// src/utils/hooks/hookEvents.ts — Buffered events with late handler registration

const MAX_PENDING_EVENTS = 100
const pendingEvents: HookExecutionEvent[] = []
let eventHandler: HookEventHandler | null = null

function registerHookEventHandler(handler: HookEventHandler | null): void {
  eventHandler = handler
  if (handler && pendingEvents.length > 0) {
    for (const event of pendingEvents.splice(0)) handler(event)  // Flush buffer
  }
}

function emit(event: HookExecutionEvent): void {
  if (eventHandler) {
    eventHandler(event)
  } else {
    pendingEvents.push(event)  // Buffer until handler registered
    if (pendingEvents.length > MAX_PENDING_EVENTS) pendingEvents.shift()
  }
}
```

### Key Insight: Layered Message Flow

```
User Input → Command Queue (messageQueueManager)
    ↓
Queue Processor (decides batch/single based on command type)
    ↓
Query Engine (streaming loop)
    ↓ ← mid-turn drain: pull 'next' priority commands from queue
Session State Transitions (notifySessionStateChanged → 3 listener slots)
    ↓
SDK Events (sdkEventQueue drain for headless consumers)
    ↓
Bridge/Remote Transport (replBridgeTransport)
    ↓
WebSocket/SSE (physical transport)
```

Each layer has a clear responsibility. The command queue handles *what* to process, the processor handles *how* to batch, the session state handles *who* to notify, and the transport handles *where* to deliver.

### Claudy Wiring: How Primitives Connect

```
User Input
    ↓
handlePromptSubmit() (REPL.tsx)
    ├─ Immediate commands (local-jsx) → execute synchronously
    └─ Queued commands:
         ├─ enqueue(QueuedCommand)
         ├─ signal queueChanged
         └─ return
    ↓
useQueueProcessor Hook (REPL.tsx)
    ├─ Subscribes to: subscribeToCommandQueue + QueryGuard.subscribe
    ├─ useEffect triggers when queue changes OR query becomes idle
    └─ processQueueIfReady({ executeInput: executeQueuedInput })
    ↓
processQueueIfReady() (queueProcessor.ts)
    ├─ peek(isMainThread) → check what's next
    ├─ Decision:
    │   ├─ Slash command? → dequeue(1) → executeInput([cmd])
    │   ├─ Bash command? → dequeue(1) → executeInput([cmd])
    │   └─ Other? → dequeueAllMatching(same mode) → executeInput([cmd1,cmd2,...])
    └─ { processed: true/false }
    ↓
executeQueuedInput() → onQuery()
    ↓
query() generator loop
    ├─ Stream from Claude API
    ├─ Execute tools
    ├─ Mid-turn: drain 'next' priority commands from queue → inject as attachments
    ├─ Generate tool use summary
    └─ Loop: continue if toolUseBlocks, else return

QueryGuard State Machine:
  idle → dispatching → running → idle
  isActive = (status !== 'idle') → prevents queue processor from firing
```

### Patterns Worth Porting

These are the patterns that earn their keep when ported to BrowserX:

1. **Module-level singleton command queue with frozen-snapshot mutation** — `Object.freeze([...queue])` is recreated on every mutation so subscribers can use shallow reference equality (matches Svelte/React store semantics).
2. **Linear-scan priority dequeue** with a `PRIORITY_ORDER` map — small, allocation-free, and good enough for queue depths in the tens. Avoids a full heap implementation.
3. **Mailbox direct-handoff for approval flows** — when a `receive()` is already pending, `send()` resolves it directly without going through the queue. Removes an entire class of "did the resolver get registered before the message arrived?" bugs.
4. **Bounded circular buffer with drop-oldest** for sdk-style event queues — simple, predictable, no producer-side coordination needed.

### Patterns NOT Worth Porting

Claudy carries several patterns that are tightly coupled to its REPL/Ink delivery model and should be skipped:

- **Ink TUI rendering** (entire `src/ink/` tree) — BrowserX has no terminal UI surface.
- **REPL XML printing of `<task-notification>`** — BrowserX uses structured `ChannelEvent` / `EventMsg` envelopes; XML stringification is unnecessary and lossy.
- **`SessionState` transition machine tied to REPL interaction model** — BrowserX's session lifecycle is driven by channel events, not REPL key handling.
- **CCR remote-bridge transport** — BrowserX already has its own multi-channel transport (sidepanel / websocket / tauri / server).
- **Growthbook feature-flag wiring** — out of scope for a messaging refactor.

### Why BrowserX Extends Beyond Claudy

Claudy ships a single REPL and an SDK output stream — one consumer model, one event direction. BrowserX has to deliver the same event stream into **four** independent channels (sidepanel, websocket, tauri, server), each with its own connect/disconnect lifecycle and replay semantics. That is the justification for the parts of this design that are *not* in claudy:

- **MessageBus with topics** — needed because multiple subscribers per event are the norm, not the exception.
- **EventLog with replay** — needed because a reconnecting WebSocket or a freshly-opened sidepanel must catch up; claudy never reconnects anything.
- **Middleware pipeline** — needed because cross-cutting logging/metrics/filtering must apply uniformly across channels; claudy can hard-code logging at the REPL render layer.

These are deliberate BrowserX-specific extensions, not gold-plating.

## BrowserX Mapping

### Current Architecture (Actual Implementation)

```
User Input → ChannelAdapter.onSubmission()
    ↓
ChannelManager → routes to AgentHandler (direct invocation, no queue)
    ↓ (ServiceRequest ops routed to ServiceRegistry instead)
RepublicAgent.submitOperation()
    → this.submissionQueue.push(submission)    // Plain array, no priority
    → processSubmissionQueue() if not already running
    ↓
processSubmissionQueue() → while loop
    → this.submissionQueue.shift()             // FIFO only, no priority
    → handleSubmission(submission)             // One at a time, sequential
    → switch on op.type → handleUserTurn / handleExecApproval / handleInterrupt / ...
    ↓
handleUserTurn() → creates RegularTask → Session.spawnTask()
    → task runs agent loop (model streaming, tool execution)
    ↓
emitEvent(msg) → this.eventQueue.push(event)
    → eventDispatcher(event)                   // Fire-and-forget callback
    ↓
Event dispatcher (set by bootstrap) → ChannelManager.dispatchEvent() or broadcastEvent()
    ↓
ChannelAdapter.sendEvent() → chrome.runtime / WebSocket / Tauri
```

**Problems with this flow:**

1. RepublicAgent uses plain `Submission[]` array — no priority, no filtering, no batch drain
2. QueueProcessor classes exist in `QueueProcessor.ts` but are **never instantiated** by the agent (dead code)
3. Processing is strictly sequential FIFO — interrupts wait behind user turns
4. Event dispatch is a direct callback chain with no backpressure or middleware
5. No mid-turn drain — new submissions wait until current submission fully completes
6. ApprovalManager uses manual Promise/resolver handshake (exactly what Mailbox replaces)
7. Config changes, service responses, and agent events flow through completely different paths
8. No way to replay events for late-joining channels (e.g., a reconnecting WebSocket)

### Cross-Check With Already-Merged BrowserX Work

PRs **#174, #181, #185, #187, #193** have already landed the **transport** layer:

- `ChannelManager` + `ServiceRegistry`
- `sessionId` plumbing through `ChannelEvent`
- Scheduler dispatch
- Channel-thread routing

What those PRs did **not** address is the **semantic** layer. Track 08 closes exactly that gap:

- `RepublicAgent.submissionQueue: Submission[]` is still a plain FIFO array → **CommandQueue** replaces it.
- `RepublicAgent.emitEvent` is still array-push + a single callback → **MessageBus** replaces it.
- `ApprovalManager` still hand-rolls a pending-Promise map → **Mailbox** replaces it.

In other words, transport = solved; semantic queue/bus/handshake = the remaining work.

### Scope Boundary

MessageBus does **not** replace `ChannelManager`. It sits **between** `RepublicAgent` and `ChannelManager`:

```
RepublicAgent ──► MessageBus (semantic: topics, priorities, replay)
                       │
                       ▼
                 ChannelManager (transport: channel selection, framing)
                       │
                       ▼
              SidePanel / WS / Tauri / Server channels
```

`ServiceRegistry` also stays unchanged — it remains a request/response (RPC) router, not a queue-based pub/sub. MessageBus is for one-to-many event flow; ServiceRegistry is for one-to-one method calls. They coexist.

### Proposed Architecture: MessageBus

```
src/core/messaging/
├── MessageBus.ts            # Central event bus with topics and subscriptions
├── CommandQueue.ts          # Semantic command queue (replaces plain Submission[])
├── CommandProcessor.ts      # Type-aware batching (replaces sequential while loop)
├── EventLog.ts              # Bounded event log with replay capability
├── Mailbox.ts               # Typed async poll/await for cross-component handshakes
├── Signal.ts                # Lightweight fire-and-forget notifications
├── types.ts                 # Shared message types
└── middleware/
    ├── LoggingMiddleware.ts  # Cross-cutting event logging
    ├── MetricsMiddleware.ts  # Throughput, latency, queue depth
    └── FilterMiddleware.ts   # Per-subscriber event filtering
```

### Signal (Lightweight Notifications)

Port Claudy's signal primitive for simple fire-and-forget notifications:

```typescript
// src/core/messaging/Signal.ts

export type Signal<Args extends unknown[] = []> = {
  subscribe: (listener: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
```

**Svelte store integration**: Signal's `subscribe` returns an unsubscribe function, which matches Svelte's store contract. A Signal can be used directly with Svelte's `$` syntax via a thin adapter:

```typescript
// Svelte-compatible readable store backed by Signal
function signalStore<T>(signal: Signal<[T]>, initialValue: T): Readable<T> {
  return readable(initialValue, (set) => {
    return signal.subscribe((value) => set(value))
  })
}
```

**Replacement targets in BrowserX** (candidates for Phase 1):
1. `AgentConfig.on('config-changed', ...)` — replace EventEmitter pattern with `configChanged = createSignal<[IConfigChangeEvent]>()`
2. `ChannelAdapter` connection state notifications — replace ad-hoc callbacks
3. `EffectQueue` event triggers in `src/extension/content/ui_effect/stores.ts`
4. Tab manager state changes
5. Session lifecycle notifications

### Mailbox (Async Handshakes)

Port Claudy's mailbox for cross-component async coordination:

```typescript
// src/core/messaging/Mailbox.ts

import { createSignal } from './Signal'

export class Mailbox<T = unknown> {
  private queue: T[] = []
  private waiters: Array<{ fn: (msg: T) => boolean; resolve: (msg: T) => void }> = []
  private changed = createSignal()
  private _revision = 0

  get length(): number { return this.queue.length }
  get revision(): number { return this._revision }

  send(msg: T): void {
    this._revision++
    // Direct handoff if someone is already waiting
    const idx = this.waiters.findIndex(w => w.fn(msg))
    if (idx !== -1) {
      const waiter = this.waiters.splice(idx, 1)[0]!
      waiter.resolve(msg)
      this.notify()
      return
    }
    this.queue.push(msg)
    this.notify()
  }

  poll(fn?: (msg: T) => boolean): T | undefined {
    const idx = this.queue.findIndex(fn ?? (() => true))
    if (idx === -1) return undefined
    return this.queue.splice(idx, 1)[0]
  }

  receive(fn?: (msg: T) => boolean, timeoutMs?: number): Promise<T> {
    // Check queue first
    const idx = this.queue.findIndex(fn ?? (() => true))
    if (idx !== -1) {
      const msg = this.queue.splice(idx, 1)[0]!
      this.notify()
      return Promise.resolve(msg)
    }
    // Block until matching message arrives
    return new Promise<T>((resolve, reject) => {
      const waiter = { fn: fn ?? (() => true), resolve }
      this.waiters.push(waiter)

      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          const i = this.waiters.indexOf(waiter)
          if (i !== -1) {
            this.waiters.splice(i, 1)
            reject(new Error(`Mailbox receive timed out after ${timeoutMs}ms`))
          }
        }, timeoutMs)
      }
    })
  }

  subscribe = this.changed.subscribe

  private notify(): void {
    this.changed.emit()
  }
}
```

**Approval flow migration** — Replace ApprovalManager's manual Promise/resolver pattern:

```typescript
// BEFORE (current ApprovalManager.requestApproval):
const userDecisionPromise = new Promise<ApprovalResponse>((resolve) => {
  pendingApproval.resolver = resolve;     // Store resolver, wait for handleDecision() to call it
});

// AFTER (with Mailbox):
const approvalMailbox = new Mailbox<ApprovalResponse>()

// In requestApproval():
this.emitEvent({ type: 'ApprovalRequested', data: { id: request.id, ... } })
const response = await approvalMailbox.receive(
  msg => msg.id === request.id,
  timeout  // Built-in timeout support
)

// In handleDecision() (called when ExecApproval op arrives):
approvalMailbox.send(response)  // Direct handoff to waiting requestApproval()
```

This replaces the manual `pendingRequests` Map, resolver storage, timeout management, and `resolved` guard flag with a single Mailbox. The `receive()` predicate `msg => msg.id === request.id` handles correlation.

### MessageBus (Central Event Bus)

The MessageBus unifies all event routing through a single observable pipeline. It does NOT replace ChannelManager (transport) or ServiceRegistry (RPC). It sits between them as the semantic routing layer.

```typescript
// src/core/messaging/MessageBus.ts

import { createSignal, type Signal } from './Signal'
import type { EventLog } from './EventLog'

type Unsubscribe = () => void
type MessageHandler = (topic: string, message: BusMessage) => void

interface BusMessage {
  id: string
  timestamp: number
  sequence: number        // Monotonic, per-topic
  source: string          // 'agent' | 'channel:sidepanel' | 'scheduler' | 'mcp:serverName'
  payload: unknown
  metadata?: Record<string, unknown>
}

interface SubscribeOptions {
  mode: 'sync' | 'async' | 'batched'
  batchInterval?: number
  batchSize?: number
  maxPending?: number
  onBackpressure?: 'drop-oldest' | 'drop-newest' | 'block'
  filter?: (message: BusMessage) => boolean
}

type BusMiddleware = (
  topic: string,
  message: BusMessage,
  next: () => void
) => void

class MessageBus {
  private subscriptions = new Map<string, Set<{ handler: MessageHandler; options?: SubscribeOptions }>>()
  private patternSubscriptions: Array<{ pattern: RegExp; handler: MessageHandler }> = []
  private middlewares: BusMiddleware[] = []
  private sequenceCounters = new Map<string, number>()
  private eventLog: EventLog | null = null
  private stats = { publishCount: 0, subscribeCount: 0 }

  // Publish with middleware pipeline
  publish(topic: string, payload: unknown, source: string, metadata?: Record<string, unknown>): void {
    const sequence = (this.sequenceCounters.get(topic) ?? 0) + 1
    this.sequenceCounters.set(topic, sequence)

    const message: BusMessage = {
      id: `${topic}:${sequence}`,
      timestamp: Date.now(),
      sequence,
      source,
      payload,
      metadata,
    }

    // Run middleware chain
    let index = 0
    const next = () => {
      if (index < this.middlewares.length) {
        this.middlewares[index++]!(topic, message, next)
      } else {
        this.deliver(topic, message)
      }
    }
    next()

    this.stats.publishCount++
  }

  private deliver(topic: string, message: BusMessage): void {
    // Log to EventLog if attached
    if (this.eventLog) {
      this.eventLog.append(topic, message)
    }

    // Exact topic subscribers
    const subs = this.subscriptions.get(topic)
    if (subs) {
      for (const { handler, options } of subs) {
        if (options?.filter && !options.filter(message)) continue
        this.invokeHandler(handler, topic, message, options)
      }
    }

    // Pattern subscribers (e.g., 'tool.*')
    for (const { pattern, handler } of this.patternSubscriptions) {
      if (pattern.test(topic)) {
        this.invokeHandler(handler, topic, message)
      }
    }
  }

  private invokeHandler(handler: MessageHandler, topic: string, message: BusMessage, options?: SubscribeOptions): void {
    const mode = options?.mode ?? 'sync'
    if (mode === 'sync') {
      handler(topic, message)
    } else if (mode === 'async') {
      queueMicrotask(() => handler(topic, message))
    }
    // 'batched' mode: collect and flush on interval (see BatchedSubscription helper)
  }

  subscribe(topic: string, handler: MessageHandler, options?: SubscribeOptions): Unsubscribe {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set())
    }
    const entry = { handler, options }
    this.subscriptions.get(topic)!.add(entry)
    this.stats.subscribeCount++
    return () => { this.subscriptions.get(topic)?.delete(entry) }
  }

  subscribePattern(pattern: string, handler: MessageHandler): Unsubscribe {
    // Convert glob pattern to regex: 'tool.*' → /^tool\.[^.]+$/
    // 'tool.**' → /^tool\..+$/
    const regexStr = '^' + pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^.]+')
      + '$'
    const entry = { pattern: new RegExp(regexStr), handler }
    this.patternSubscriptions.push(entry)
    return () => {
      const idx = this.patternSubscriptions.indexOf(entry)
      if (idx !== -1) this.patternSubscriptions.splice(idx, 1)
    }
  }

  use(middleware: BusMiddleware): void {
    this.middlewares.push(middleware)
  }

  setEventLog(log: EventLog): void {
    this.eventLog = log
  }

  replay(topic: string, fromSequence: number, handler: MessageHandler): void {
    if (!this.eventLog) return
    for (const msg of this.eventLog.replay(topic, fromSequence)) {
      handler(topic, msg)
    }
  }

  getStats() { return { ...this.stats } }
}

// Module-level singleton
let _bus: MessageBus | null = null
export function getMessageBus(): MessageBus {
  if (!_bus) _bus = new MessageBus()
  return _bus
}
```

**Topic hierarchy** (maps EventMsg types to topics):

```
agent.turn.started          → TurnStarted
agent.turn.complete         → TurnComplete
agent.turn.aborted          → TurnAborted
agent.turn.retry            → TurnRetry
agent.message               → AgentMessage
agent.message.delta         → AgentMessageDelta
agent.reasoning             → AgentReasoning
agent.reasoning.delta       → AgentReasoningDelta
agent.reasoning.raw         → AgentReasoningRawContent
agent.reasoning.raw.delta   → AgentReasoningRawContentDelta
agent.reasoning.section     → AgentReasoningSectionBreak
agent.reasoning.summary.delta → ReasoningSummaryDelta
agent.reasoning.content.delta → ReasoningContentDelta

tool.execution.start        → ToolExecutionStart
tool.execution.end          → ToolExecutionEnd
tool.execution.error        → ToolExecutionError
tool.execution.timeout      → ToolExecutionTimeout
tool.registered             → ToolRegistered
tool.unregistered           → ToolUnregistered

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
session.context.updated     → ContextUpdated

exec.command.begin          → ExecCommandBegin
exec.command.output.delta   → ExecCommandOutputDelta
exec.command.end            → ExecCommandEnd

diff.change.added           → ChangeAdded
diff.changes.retrieved      → ChangesRetrieved
diff.changes.cleared        → ChangesCleared
diff.rollback.started       → RollbackStarted
diff.rollback.batch.started → BatchRollbackStarted
diff.rollback.session.started → SessionRollbackStarted
diff.rollback.completed     → RollbackCompleted
diff.snapshot.created       → SnapshotCreated
diff.snapshot.restored      → SnapshotRestored

browser.dom.action          → DOMActionStart
browser.navigation.action   → NavigationActionStart
browser.storage.action      → StorageActionStart

mcp.tool.call.begin         → McpToolCallBegin
mcp.tool.call.end           → McpToolCallEnd

patch.apply.begin           → PatchApplyBegin
patch.apply.end             → PatchApplyEnd

config.changed              → CONFIG_CHANGE (from config-messages.ts)
config.sync                 → CONFIG_SYNC

service.response            → ServiceResponse
state.update                → StateUpdate
```

**EventMsg-to-topic mapping function:**

```typescript
// src/core/messaging/topicMap.ts

const EVENT_TYPE_TO_TOPIC: Record<string, string> = {
  TurnStarted: 'agent.turn.started',
  TurnComplete: 'agent.turn.complete',
  TurnAborted: 'agent.turn.aborted',
  AgentMessage: 'agent.message',
  AgentMessageDelta: 'agent.message.delta',
  ToolExecutionStart: 'tool.execution.start',
  ToolExecutionEnd: 'tool.execution.end',
  ToolExecutionError: 'tool.execution.error',
  ToolExecutionTimeout: 'tool.execution.timeout',
  ApprovalRequested: 'approval.requested',
  ApprovalGranted: 'approval.granted',
  ApprovalDenied: 'approval.denied',
  ApprovalAutoApproved: 'approval.auto',
  TaskStarted: 'task.started',
  TaskComplete: 'task.complete',
  TaskFailed: 'task.failed',
  TaskUpdate: 'task.update',
  // ... all 50+ EventMsg types
}

export function eventTypeToTopic(eventType: string): string {
  return EVENT_TYPE_TO_TOPIC[eventType] ?? `unknown.${eventType}`
}
```

### CommandQueue (Semantic Priority)

Replaces the plain `Submission[]` array in RepublicAgent:

```typescript
// src/core/messaging/CommandQueue.ts

import { createSignal } from './Signal'
import type { Op, Submission } from '../protocol/types'
import type { SubmissionContext } from '../channels/types'

type CommandPriority = 'interrupt' | 'immediate' | 'normal' | 'deferred'
type Unsubscribe = () => void

const PRIORITY_ORDER: Record<CommandPriority, number> = {
  interrupt: 0,   // Must preempt everything (Interrupt, Shutdown)
  immediate: 1,   // Unblocks waiting execution (ExecApproval, PatchApproval)
  normal: 2,      // Standard user interaction (UserTurn, UserInput)
  deferred: 3,    // Can wait (ServiceRequest, ConfigSync, AddToHistory)
}

interface QueuedCommand {
  id: string
  submission: Submission
  priority: CommandPriority
  timestamp: number
}

class CommandQueue {
  private queue: QueuedCommand[] = []
  private queueChanged = createSignal()
  private snapshot: readonly QueuedCommand[] = Object.freeze([])
  private nextId = 1

  enqueue(submission: Submission, priority?: CommandPriority): void {
    const resolved = priority ?? this.autoPriority(submission.op)
    this.queue.push({
      id: `cmd_${this.nextId++}`,
      submission,
      priority: resolved,
      timestamp: Date.now(),
    })
    this.notifyChange()
  }

  // Priority-based dequeue (linear scan like claudy)
  dequeue(filter?: (cmd: QueuedCommand) => boolean): QueuedCommand | null {
    if (this.queue.length === 0) return null

    let bestIdx = -1
    let bestPriority = Infinity
    for (let i = 0; i < this.queue.length; i++) {
      const cmd = this.queue[i]!
      if (filter && !filter(cmd)) continue
      const p = PRIORITY_ORDER[cmd.priority]
      if (p < bestPriority) {
        bestIdx = i
        bestPriority = p
      }
    }

    if (bestIdx === -1) return null
    const [dequeued] = this.queue.splice(bestIdx, 1)
    this.notifyChange()
    return dequeued!
  }

  peek(filter?: (cmd: QueuedCommand) => boolean): QueuedCommand | null {
    if (this.queue.length === 0) return null
    let bestIdx = -1
    let bestPriority = Infinity
    for (let i = 0; i < this.queue.length; i++) {
      const cmd = this.queue[i]!
      if (filter && !filter(cmd)) continue
      const p = PRIORITY_ORDER[cmd.priority]
      if (p < bestPriority) {
        bestIdx = i
        bestPriority = p
      }
    }
    return bestIdx === -1 ? null : this.queue[bestIdx]!
  }

  // Batch drain by predicate (like claudy's dequeueAllMatching)
  drain(predicate: (cmd: QueuedCommand) => boolean): QueuedCommand[] {
    const matched: QueuedCommand[] = []
    const remaining: QueuedCommand[] = []
    for (const cmd of this.queue) {
      if (predicate(cmd)) matched.push(cmd)
      else remaining.push(cmd)
    }
    if (matched.length === 0) return []
    this.queue.length = 0
    this.queue.push(...remaining)
    this.notifyChange()
    return matched
  }

  cancelByType(type: Op['type']): number {
    const before = this.queue.length
    this.queue = this.queue.filter(cmd => cmd.submission.op.type !== type)
    const removed = before - this.queue.length
    if (removed > 0) this.notifyChange()
    return removed
  }

  size(): number { return this.queue.length }
  isEmpty(): boolean { return this.queue.length === 0 }

  // Svelte store integration: subscribe() returns unsubscribe
  subscribe(listener: () => void): Unsubscribe {
    return this.queueChanged.subscribe(listener)
  }

  getSnapshot(): readonly QueuedCommand[] {
    return this.snapshot
  }

  private notifyChange(): void {
    this.snapshot = Object.freeze([...this.queue])
    this.queueChanged.emit()
  }

  private autoPriority(op: Op): CommandPriority {
    switch (op.type) {
      case 'Interrupt':
      case 'Shutdown':
        return 'interrupt'
      case 'ExecApproval':
      case 'PatchApproval':
        return 'immediate'
      case 'UserTurn':
      case 'UserInput':
      case 'OverrideTurnContext':
        return 'normal'
      case 'ServiceRequest':
      case 'Compact':
      case 'ManualCompact':
      case 'AddToHistory':
      case 'GetHistoryEntryRequest':
      case 'GetPath':
      case 'ListMcpTools':
      case 'ListCustomPrompts':
      case 'Review':
      default:
        return 'deferred'
    }
  }
}
```

**Auto-priority mapping** (based on actual BrowserX Op types from `src/core/protocol/types.ts`):

| Op Type | Priority | Rationale |
|---------|----------|-----------|
| `Interrupt`, `Shutdown` | `interrupt` | Must preempt everything, clears queue |
| `ExecApproval`, `PatchApproval` | `immediate` | Unblocks waiting tool execution (ApprovalManager Promise) |
| `UserTurn`, `UserInput`, `OverrideTurnContext` | `normal` | Standard user interaction |
| `ServiceRequest`, `Compact`, `ManualCompact`, `AddToHistory`, `GetHistoryEntryRequest`, `GetPath`, `ListMcpTools`, `ListCustomPrompts`, `Review` | `deferred` | Can wait for current processing |

### CommandProcessor (Type-Aware Batching)

Replaces the sequential while-loop in `RepublicAgent.processSubmissionQueue()`:

```typescript
// src/core/messaging/CommandProcessor.ts

import type { CommandQueue, QueuedCommand } from './CommandQueue'
import type { Op } from '../protocol/types'

interface BatchStrategy {
  // Commands that must be processed individually (never batched)
  isolateTypes: Set<Op['type']>
  // Commands that can be batched together
  batchableTypes: Set<Op['type']>
  // Max batch size
  maxBatchSize: number
  // Max wait before flushing partial batch
  maxBatchWaitMs: number
}

const DEFAULT_STRATEGY: BatchStrategy = {
  isolateTypes: new Set([
    'Interrupt', 'Shutdown',            // Control flow
    'ExecApproval', 'PatchApproval',    // Must resolve individual promises
    'UserTurn',                          // Each turn is a separate agent invocation
    'OverrideTurnContext',               // Context changes apply individually
  ]),
  batchableTypes: new Set([
    'ServiceRequest',                    // Multiple service calls can batch
    'AddToHistory',                      // Multiple history entries
    'GetHistoryEntryRequest',            // Multiple lookups
  ]),
  maxBatchSize: 10,
  maxBatchWaitMs: 50,
}

type ProcessResult =
  | { type: 'single'; command: QueuedCommand }
  | { type: 'batch'; commands: QueuedCommand[] }
  | { type: 'empty' }

class CommandProcessor {
  private queue: CommandQueue
  private strategy: BatchStrategy
  private running = false

  constructor(queue: CommandQueue, strategy?: BatchStrategy) {
    this.queue = queue
    this.strategy = strategy ?? DEFAULT_STRATEGY
  }

  processNext(): ProcessResult {
    const next = this.queue.peek()
    if (!next) return { type: 'empty' }

    const opType = next.submission.op.type

    // Isolated types: dequeue and process individually
    if (this.strategy.isolateTypes.has(opType)) {
      const cmd = this.queue.dequeue()!
      return { type: 'single', command: cmd }
    }

    // Batchable types: drain all of same type
    if (this.strategy.batchableTypes.has(opType)) {
      const commands = this.queue.drain(
        cmd => cmd.submission.op.type === opType
      )
      if (commands.length === 0) return { type: 'empty' }
      return { type: 'batch', commands }
    }

    // Default: process individually
    const cmd = this.queue.dequeue()!
    return { type: 'single', command: cmd }
  }

  // Start event-driven processing (subscribes to queue changes)
  start(handler: (result: ProcessResult) => Promise<void>): void {
    if (this.running) return
    this.running = true

    const process = async () => {
      while (this.running) {
        const result = this.processNext()
        if (result.type === 'empty') break
        await handler(result)
      }
    }

    // Subscribe to queue changes to re-trigger processing
    this.queue.subscribe(() => {
      if (this.running) void process()
    })
  }

  stop(): void {
    this.running = false
  }

  setBatchStrategy(strategy: BatchStrategy): void {
    this.strategy = strategy
  }
}
```

**Integration with RepublicAgent** — Replace `processSubmissionQueue()`:

```typescript
// BEFORE (RepublicAgent.processSubmissionQueue):
private async processSubmissionQueue(): Promise<void> {
  this.isProcessing = true;
  while (this.submissionQueue.length > 0) {
    const submission = this.submissionQueue.shift()!;
    await this.handleSubmission(submission);
  }
  this.isProcessing = false;
}

// AFTER (with CommandProcessor):
private commandQueue = new CommandQueue()
private commandProcessor = new CommandProcessor(this.commandQueue)

async submitOperation(op: Op, context?: { tabId?: number }): Promise<string> {
  const id = `sub_${this.nextId++}`;
  const submission: Submission = { id, op, context };
  this.commandQueue.enqueue(submission);  // Auto-priority based on op.type
  this.processNext();
  return id;
}

private async processNext(): Promise<void> {
  if (this.isProcessing) return;
  this.isProcessing = true;

  while (!this.commandQueue.isEmpty()) {
    const result = this.commandProcessor.processNext();
    if (result.type === 'empty') break;

    if (result.type === 'single') {
      await this.handleSubmission(result.command.submission);
    } else {
      // Batch: process all commands of same type together
      for (const cmd of result.commands) {
        await this.handleSubmission(cmd.submission);
      }
    }
  }

  this.isProcessing = false;
}
```

### EventLog (Bounded Replay)

```typescript
// src/core/messaging/EventLog.ts

interface EventLogEntry {
  topic: string
  message: BusMessage
  insertedAt: number
}

class EventLog {
  private buffer: EventLogEntry[] = []
  private maxEntries: number
  private maxAgeMs: number

  constructor(maxEntries = 5000, maxAgeMs = 5 * 60 * 1000) {
    this.maxEntries = maxEntries
    this.maxAgeMs = maxAgeMs
  }

  append(topic: string, message: BusMessage): void {
    this.buffer.push({ topic, message, insertedAt: Date.now() })
    this.evict()
  }

  replay(topic: string, fromSequence: number): BusMessage[] {
    return this.buffer
      .filter(e => e.topic === topic && e.message.sequence > fromSequence)
      .map(e => e.message)
  }

  replayAll(fromSequence: number): EventLogEntry[] {
    return this.buffer.filter(e => e.message.sequence > fromSequence)
  }

  private evict(): void {
    const now = Date.now()
    // Evict by age
    while (this.buffer.length > 0 && now - this.buffer[0]!.insertedAt > this.maxAgeMs) {
      this.buffer.shift()
    }
    // Evict by size
    while (this.buffer.length > this.maxEntries) {
      this.buffer.shift()
    }
  }

  setMaxEntries(max: number): void { this.maxEntries = max }
  setMaxAgeMs(maxAge: number): void { this.maxAgeMs = maxAge }
  getOldestSequence(): number { return this.buffer[0]?.message.sequence ?? 0 }
  getNewestSequence(): number { return this.buffer[this.buffer.length - 1]?.message.sequence ?? 0 }
  getEntryCount(): number { return this.buffer.length }
}
```

## Integration with Existing Architecture

### What Changes

| Current Code | New Code | Migration Path |
|-------------|----------|----------------|
| `RepublicAgent.submissionQueue: Submission[]` | `CommandQueue` with semantic priorities | Replace plain array; `submitOperation()` calls `commandQueue.enqueue()` |
| `RepublicAgent.processSubmissionQueue()` (FIFO while loop) | `CommandProcessor.processNext()` with type-aware batching | Replace while-shift loop with processor dequeue |
| `RepublicAgent.emitEvent(msg)` → push to array + eventDispatcher callback | `messageBus.publish(topic, payload, 'agent')` | emitEvent() publishes to MessageBus; MessageBus notifies subscribers including ChannelManager |
| `RepublicAgent.eventDispatcher` callback | MessageBus subscription in ChannelManager | ChannelManager subscribes to `'**'` (all topics) and dispatches to channels |
| `ApprovalManager.pendingRequests` Map with Promise/resolver | `Mailbox<ApprovalResponse>` | Replace manual Promise management with `mailbox.receive()` / `mailbox.send()` |
| `AgentConfig.on('config-changed', cb)` EventEmitter | `configChanged = createSignal<[IConfigChangeEvent]>()` | Replace EventEmitter pattern with Signal |
| `QueueProcessor` class (dead code) | Delete entirely | Remove unused class; CommandProcessor replaces its concept |
| `SubmissionQueue` class (dead code) | Delete entirely | Remove unused class; CommandQueue replaces its concept |
| `EventQueue` class (dead code) | Delete entirely | Remove unused class; MessageBus replaces its concept |

### What Stays the Same

- **ChannelAdapter interface** — channels still implement the same adapter contract
- **ServiceRegistry** — RPC routing stays as-is (request/response, not pub/sub)
- **EventMsg type** — the 50+ event union type remains the payload contract
- **Op type** — submission operations unchanged
- **UIChannelClient** — frontend client keeps its RPC pattern via ServiceRequest
- **RepublicAgent.handleSubmission()** — the switch statement and per-type handlers stay the same
- **Session, TurnContext, ToolRegistry** — agent internals unchanged

### Wiring Diagram

```
                    ┌─────────────────────────────────────────┐
                    │              MessageBus                  │
                    │                                         │
User Input ────►    │  CommandQueue ──► CommandProcessor       │
(via Channel)       │       │              │                   │
                    │       │         ┌────┴────┐             │
                    │       │         │ Batched │             │
                    │       ▼         │ vs Solo │             │
                    │  RepublicAgent  └────┬────┘             │
                    │  .handleSubmission() │                   │
                    │       │              │                   │
                    │       ▼              ▼                   │
                    │  emitEvent() ──► messageBus.publish()    │
                    │                      │                   │
                    │  ┌───────────┐  ┌────┴────┐            │
                    │  │ EventLog  │◄─┤ Logging │            │
                    │  └───────────┘  │ Middlwr │            │
                    │                  └────┬────┘            │
                    │                       │                  │
                    │  topic subscriptions  │                  │
                    │       │               │                  │
                    └───────┼───────────────┼──────────────────┘
                            │               │
                    ┌───────┴───────┐ ┌─────┴────────┐
                    │ ChannelManager│ │  Mailbox       │
                    │ (subscribes   │ │ (approval      │
                    │  to all topics│ │  handshakes)   │
                    │  for dispatch)│ └────────────────┘
                    └───────┬───────┘
                            │
               ┌────────────┼────────────┐
               │            │            │
          SidePanel     WebSocket     Tauri
          Channel       Channel      Channel
```

### Bootstrap Wiring

How components connect at startup (e.g., in `ServerAgentBootstrap` or extension service worker):

```typescript
// 1. Create singletons
const messageBus = getMessageBus()
const eventLog = new EventLog(5000, 5 * 60 * 1000)
messageBus.setEventLog(eventLog)
messageBus.use(loggingMiddleware)

// 2. Create agent with CommandQueue
const commandQueue = new CommandQueue()
const commandProcessor = new CommandProcessor(commandQueue)
const approvalMailbox = new Mailbox<ApprovalResponse>()
const agent = new RepublicAgent(config, commandQueue, commandProcessor, approvalMailbox)

// 3. Wire ChannelManager to subscribe to MessageBus (replaces eventDispatcher callback)
const channelManager = getChannelManager()
messageBus.subscribePattern('**', (topic, message) => {
  const event: ChannelEvent = {
    msg: message.payload as EventMsg,
    sessionId: message.metadata?.sessionId as string,
  }
  channelManager.broadcastEvent(event)
})

// 4. Agent publishes via MessageBus instead of eventDispatcher
agent.setEventPublisher((msg: EventMsg, metadata?: Record<string, unknown>) => {
  const topic = eventTypeToTopic(msg.type)
  messageBus.publish(topic, msg, 'agent', metadata)
})
```

### Dependency on Other Tracks

- **Track 01 (Hook & Event System)**: Hooks subscribe to MessageBus topics (`tool.execution.*`, `approval.*`) instead of ad-hoc event wiring
- **Track 04 (Typed Task Families)**: Task lifecycle events publish to `task.*` topics
- **Track 06 (Multi-Agent Coordination)**: Cross-agent messages flow through Mailbox pattern
- **Track 07 (Centralized State)**: State changes publish to `state.*` topics; AgentStateStore subscribes to MessageBus for automatic updates

## Risks

- **Migration complexity**: RepublicAgent uses plain arrays, not the QueueProcessor classes. The migration is simpler than originally thought since we're replacing simple code, not complex code. Risk is low.
- **Performance**: Adding a middleware pipeline to every event adds latency. Mitigate with fast-path for events with no middleware and lazy message serialization.
- **Over-engineering**: Not every notification needs the full MessageBus. Keep Signal for simple fire-and-forget cases. The rule: if it has subscribers across module boundaries, use MessageBus. If it's within a single module, use Signal.
- **Topic explosion**: 50+ EventMsg types mapped to topics is a lot. Use wildcard subscriptions (`tool.*`) to keep subscriber code manageable.
- **Approval flow change**: The Mailbox-based approval flow changes the control flow in ApprovalManager significantly. Must ensure timeout handling, cancellation, and the `resolved` guard all transfer correctly.

## Phase Plan

**Phase 1: Signal + Mailbox** (Week 1)
- Implement Signal primitive (port from Claudy — exact code provided above)
- Implement Mailbox with poll/receive/subscribe/timeout (enhanced version of claudy's)
- Replace 3-5 existing ad-hoc notification patterns with Signal (targets identified above)
- Wire Mailbox into ApprovalManager (replace Promise/resolver pattern — code transformation shown above)

**Phase 2: MessageBus Core** (Week 2)
- Implement MessageBus with topic-based pub/sub, middleware pipeline, glob subscriptions
- Implement EventLog with bounded circular buffer and TTL eviction
- Create `topicMap.ts` with EventMsg-to-topic mapping
- Add logging middleware
- Wire `RepublicAgent.emitEvent()` to publish through MessageBus (keep emitEvent as thin wrapper)

**Phase 3: CommandQueue + CommandProcessor** (Week 3)
- Implement CommandQueue with semantic priorities (replace `submissionQueue: Submission[]`)
- Implement CommandProcessor with type-aware batching (replace `processSubmissionQueue()` while loop)
- Update `RepublicAgent.submitOperation()` to use CommandQueue
- Wire ChannelManager to subscribe via MessageBus for event dispatch (replace eventDispatcher callback)

**Phase 4: Migration + Middleware** (Week 4)
- Add metrics middleware (queue depth, throughput, latency)
- Add filter middleware for per-channel event filtering
- Wire config-messages through MessageBus
- Add replay support for reconnecting channels (EventLog + sequence tracking)
- Delete dead code: `QueueProcessor`, `SubmissionQueue`, `EventQueue` classes from `QueueProcessor.ts`
- Update imports across codebase

## Comparison Summary

| Aspect | BrowserX (Current) | Claudy | BrowserX (Proposed) |
|--------|-------------------|--------|-------------------|
| Event routing | Plain array + eventDispatcher callback | Signal + messageQueueManager + sdkEventQueue (layered) | MessageBus (unified) with Signal for simple cases |
| Command priority | None (plain array FIFO) | Semantic ('now'/'next'/'later') with linear-scan dequeue | Semantic ('interrupt'/'immediate'/'normal'/'deferred') with linear-scan dequeue |
| Batching | None (sequential one-at-a-time) | Command-type-aware (slash/bash isolated, same-mode batched) | Op-type-aware (isolate/batchable strategy) |
| Cross-component handshakes | Manual Promise/resolver in ApprovalManager | Mailbox (poll/receive with direct handoff) | Mailbox (ported from Claudy with timeout support) |
| Simple notifications | EventEmitter on AgentConfig, ad-hoc callbacks | Signal primitive (15+ usage sites) | Signal primitive (ported) |
| Event replay | None | Partial (sdkEventQueue drain, hookEvents buffer) | Full (EventLog with bounded replay) |
| Observability | Scattered console.log | Structured logging | Middleware pipeline (logging, metrics, filtering) |
| Backpressure | None (unbounded array growth) | Bounded queue (1000) with drop-oldest | Configurable per-subscriber (drop-oldest/newest/block) |
| Queue processor classes | Defined in QueueProcessor.ts but **unused** | Tight integration (processQueueIfReady → dequeue → executeInput) | CommandProcessor tightly integrated with RepublicAgent |
| Mid-turn drain | Not supported | Yes (drain 'next' priority during query loop) | Future enhancement (after Phase 4) |

## Validation Notes (re-checked vs claudy 2026-05-11)

This design was re-validated against the claudy source on 2026-05-11. The following corrections were applied:

1. **Added "Claudy Foundation (Validated)" subsection** at the top of "What Claudy Does" — explicitly enumerates what claudy *has* (`messageQueueManager.ts`, `signal.ts`, `mailbox.ts`) and what it *does not have* (no unified event bus, no EventLog with replay, no middleware pipeline, no backpressure signaling). Prevents the design from implying claudy already provides these primitives.

2. **Sharpened the mid-turn drain description** — claudy injects queued prompts/task-notifications as **attachments between tool executions** in the query loop (`utils/query.ts`, ~line 1570), filtering by `agentId` and excluding slash commands. BrowserX can mirror this once `Session.spawnTask` becomes generator-based.

3. **Added "Patterns Worth Porting"** — module-level singleton command queue with `Object.freeze([...queue])` snapshot pattern; linear-scan priority dequeue with `PRIORITY_ORDER` map; mailbox direct-handoff for approval flows; bounded circular buffer with drop-oldest for sdk-style queues.

4. **Added "Patterns NOT Worth Porting"** — Ink TUI rendering (`src/ink/`); REPL XML printing of `<task-notification>` (BrowserX uses structured `ChannelEvent` / `EventMsg` envelopes); `SessionState` transition machine tied to REPL interaction; CCR remote-bridge transport; Growthbook feature-flag wiring.

5. **Added "Cross-Check With Already-Merged BrowserX Work"** — PRs #174, #181, #185, #187, #193 set up the **transport** layer (`ChannelManager` + `ServiceRegistry` + `sessionId` / `ChannelEvent` + scheduler dispatch + channel-thread routing). Track 08 closes the **semantic** layer gap: `submissionQueue: Submission[]` plain FIFO, `emitEvent` array-push + callback, `ApprovalManager` hand-rolled pending-Promise map.

6. **Clarified scope boundary** — MessageBus sits **between** `RepublicAgent` and `ChannelManager` (semantic layer), not as a replacement. `ServiceRegistry` stays request/response (RPC), not queue-based.

7. **Justified BrowserX-specific extensions** — added "Why BrowserX Extends Beyond Claudy" subsection. EventLog with replay, MessageBus topics, and middleware pipeline are deliberate extensions justified by BrowserX's multi-channel architecture (sidepanel, websocket, tauri, server) versus claudy's single REPL/SDK output.

### Files Cited

- `utils/messageQueueManager.ts` — semantic priority queue (`now` / `next` / `later`), 548 lines
- `utils/signal.ts` — 1:N fire-and-forget primitive, ~30 lines
- `utils/mailbox.ts` — async handshake with direct-handoff, 74 lines
- `utils/query.ts` — mid-turn drain at the inter-tool boundary (~line 1570)
- `utils/sdkEventQueue.ts` — bounded queue (1000 max, drop-oldest) for headless mode
- `utils/hooks/hookEvents.ts` — buffered events (100 pending) with flush-on-handler-register
