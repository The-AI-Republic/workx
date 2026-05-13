# Track 08: Centralized Message Queue — Implementation Tasks

## Phase 1: Signal + Mailbox (Week 1)

### 1.1 Implement Signal Primitive
- [ ] Create `src/core/messaging/Signal.ts`
- [ ] Port Claudy's `createSignal<Args>()` pattern (exact implementation in design.md)
- [ ] Export `Signal<Args>` type and `createSignal()` factory
- [ ] Signal's `subscribe()` must return an unsubscribe function (matches Svelte store contract)
- [ ] Add `signalStore()` adapter for Svelte readable store integration
- [ ] Unit tests: subscribe/emit/unsubscribe, multiple listeners, clear, emit with no listeners

### 1.2 Implement Mailbox
- [ ] Create `src/core/messaging/Mailbox.ts`
- [ ] Import and use `createSignal` from Signal.ts for internal change notifications
- [ ] Implement `send(msg)` with direct handoff optimization (if a waiter matches, resolve immediately without queuing)
- [ ] Implement `poll(predicate?)` — non-blocking check, returns undefined if no match
- [ ] Implement `receive(predicate?, timeoutMs?)` — Promise-based blocking with optional timeout (reject on timeout)
- [ ] Implement `subscribe` via `changed.subscribe` (delegates to internal Signal)
- [ ] Add `revision` counter (monotonic increment on every `send()`) for dirty checks
- [ ] Add `length` getter for queue inspection
- [ ] Unit tests: send/poll, send/receive, direct handoff (receive before send), timeout rejection, revision counter, predicate filtering

### 1.3 Replace Ad-Hoc Notification Patterns with Signal
- [ ] Replace `AgentConfig.on('config-changed', ...)` EventEmitter pattern → `configChanged = createSignal<[IConfigChangeEvent]>()`
  - File: `src/config/AgentConfig.ts`
  - Subscribers: `RepublicAgent.setupConfigSubscriptions()` in `src/core/RepublicAgent.ts`
- [ ] Replace ChannelAdapter connection state callbacks → `connectionStateChanged = createSignal<[ConnectionState]>()`
  - Files: `src/core/channels/ChannelAdapter.ts`, implementations in sidepanel/server channels
- [ ] Replace EffectQueue event triggers → `effectTriggered = createSignal()`
  - File: `src/extension/content/ui_effect/stores.ts`
- [ ] Replace tab manager state change notifications → `tabStateChanged = createSignal<[number]>()`
  - File: `src/core/TabManager.ts`
- [ ] Replace session lifecycle notifications → `sessionChanged = createSignal()`
  - File: `src/core/Session.ts`
- [ ] Verify no behavior change after each replacement (run existing tests)

### 1.4 Wire Mailbox into ApprovalManager
- [ ] Create shared `approvalMailbox = new Mailbox<ApprovalResponse>()` accessible to ApprovalManager
- [ ] In `ApprovalManager.requestApproval()`:
  - Replace manual `new Promise((resolve) => { pendingApproval.resolver = resolve })` with `approvalMailbox.receive(msg => msg.id === request.id, timeout)`
  - Remove `pendingApproval.resolver` storage pattern
  - Remove manual timeout setTimeout/clearTimeout — use Mailbox's built-in timeout
  - Remove `resolved` guard flag — Mailbox handles this atomically
- [ ] In `ApprovalManager.handleDecision()`:
  - Replace `pending.resolver(response)` with `approvalMailbox.send(response)`
  - Remove `pendingRequests.delete()` — Mailbox handles message consumption
- [ ] Keep `approvalHistory` Map for historical lookups (Mailbox is for live handshakes, not history)
- [ ] Keep policy evaluation (auto-approve/reject) — Mailbox only replaces the user-decision waiting path
- [ ] Integration test: approval grant/deny via Mailbox, timeout auto-approve, cancel request

## Phase 2: MessageBus Core (Week 2)

### 2.1 Implement MessageBus
- [ ] Create `src/core/messaging/MessageBus.ts`
- [ ] Create `src/core/messaging/types.ts` with `BusMessage`, `SubscribeOptions`, `BusMiddleware`, `MessageHandler` types
- [ ] Implement `publish(topic, payload, source, metadata?)`:
  - Maintain per-topic monotonic sequence counter (`Map<string, number>`)
  - Build `BusMessage` with id, timestamp, sequence, source, payload, metadata
  - Run middleware chain (array of `BusMiddleware`, each calls `next()`)
  - After middleware, call `deliver()` to notify subscribers
- [ ] Implement `subscribe(topic, handler, options?)`:
  - Store in `Map<string, Set<{ handler, options }>>` by topic
  - Support `SubscribeOptions.mode`: 'sync' (direct call), 'async' (queueMicrotask), 'batched' (collect on interval)
  - Support `SubscribeOptions.filter` for per-subscriber message filtering
  - Return unsubscribe function
- [ ] Implement `subscribePattern(pattern, handler)`:
  - Convert glob pattern to RegExp: `'tool.*'` → `/^tool\.[^.]+$/`, `'tool.**'` → `/^tool\..+$/`
  - Store in separate pattern subscriptions array
  - Return unsubscribe function
- [ ] Implement `use(middleware)` for middleware pipeline
- [ ] Implement `setEventLog(log)` to wire EventLog for automatic persistence
- [ ] Implement `replay(topic, fromSequence, handler)` to replay from EventLog
- [ ] Implement `getStats()` and `getTopicStats(topic)` for diagnostics
- [ ] Create module-level singleton: `getMessageBus(): MessageBus`
- [ ] Unit tests: publish/subscribe, pattern matching, middleware chain, async delivery, filtering

### 2.2 Create EventMsg-to-Topic Mapping
- [ ] Create `src/core/messaging/topicMap.ts`
- [ ] Map all 50+ `EventMsg` types to topic hierarchy (see design.md topic table)
- [ ] Export `eventTypeToTopic(eventType: string): string` function
- [ ] Fallback: unmapped types → `unknown.{eventType}`
- [ ] Unit tests: all known EventMsg types map to expected topics

### 2.3 Implement EventLog
- [ ] Create `src/core/messaging/EventLog.ts`
- [ ] Array-based buffer with `EventLogEntry` records (topic, message, insertedAt timestamp)
- [ ] `append(topic, message)` — push to buffer, run eviction
- [ ] Eviction: TTL-based (remove entries older than `maxAgeMs`, default 5 minutes) + size-based (remove oldest beyond `maxEntries`, default 5000)
- [ ] `replay(topic, fromSequence)` — filter buffer by topic and sequence > fromSequence
- [ ] `replayAll(fromSequence)` — return all entries with sequence > fromSequence
- [ ] Getters: `getOldestSequence()`, `getNewestSequence()`, `getEntryCount()`
- [ ] Setters: `setMaxEntries()`, `setMaxAgeMs()`
- [ ] Unit tests: append/replay, TTL eviction, size eviction, topic filtering

### 2.4 Add Logging Middleware
- [ ] Create `src/core/messaging/middleware/LoggingMiddleware.ts`
- [ ] Log topic, source, sequence, and timestamp for each message
- [ ] Configurable log level per topic pattern (e.g., 'agent.message.delta' → debug only)
- [ ] Configurable verbosity: summary (topic + source) vs full (include payload)
- [ ] Export as `BusMiddleware` function
- [ ] Unit tests

### 2.5 Wire RepublicAgent.emitEvent() to MessageBus
- [ ] Modify `RepublicAgent.emitEvent(msg: EventMsg)` to also publish to MessageBus:
  ```
  emitEvent(msg) {
    const event = { id: `evt_${this.nextId++}`, msg }
    this.eventQueue.push(event)  // Keep for backward compat initially
    const topic = eventTypeToTopic(msg.type)
    getMessageBus().publish(topic, msg, 'agent', { sessionId: this.session.getId() })
  }
  ```
- [ ] Keep existing `eventDispatcher` callback working (will be replaced in Phase 3)
- [ ] Verify all existing event consumers still receive events
- [ ] Integration tests: events flow through both old and new paths

## Phase 3: CommandQueue + CommandProcessor (Week 3)

### 3.1 Implement CommandQueue
- [ ] Create `src/core/messaging/CommandQueue.ts`
- [ ] Semantic priority type: `'interrupt' | 'immediate' | 'normal' | 'deferred'`
- [ ] `PRIORITY_ORDER` map: interrupt=0, immediate=1, normal=2, deferred=3
- [ ] Auto-priority mapping from all BrowserX Op types (see design.md table):
  - Interrupt/Shutdown → interrupt
  - ExecApproval/PatchApproval → immediate
  - UserTurn/UserInput/OverrideTurnContext → normal
  - ServiceRequest/Compact/ManualCompact/AddToHistory/GetHistoryEntryRequest/GetPath/ListMcpTools/ListCustomPrompts/Review → deferred
- [ ] `enqueue(submission, priority?)` — auto-priority if not specified, append to queue
- [ ] `dequeue(filter?)` — linear scan finding first item with lowest priority (FIFO within same priority)
- [ ] `peek(filter?)` — like dequeue but don't remove
- [ ] `drain(predicate)` — remove all matching items, return them
- [ ] `cancelByType(type)` — remove all items of specific Op type
- [ ] `subscribe(listener)` + `getSnapshot()` for Svelte store integration
  - `snapshot = Object.freeze([...queue])` — new reference on mutation only
  - `subscribe` delegates to internal `createSignal()`
- [ ] Unit tests: priority ordering, dequeue with filter, drain, cancel, snapshot immutability

### 3.2 Implement CommandProcessor
- [ ] Create `src/core/messaging/CommandProcessor.ts`
- [ ] `BatchStrategy` type with `isolateTypes`, `batchableTypes`, `maxBatchSize`, `maxBatchWaitMs`
- [ ] Default strategy:
  - isolate: Interrupt, Shutdown, ExecApproval, PatchApproval, UserTurn, OverrideTurnContext
  - batchable: ServiceRequest, AddToHistory, GetHistoryEntryRequest
  - maxBatchSize: 10, maxBatchWaitMs: 50
- [ ] `processNext()` → returns `{ type: 'single', command }` | `{ type: 'batch', commands }` | `{ type: 'empty' }`
  - Peek at next → check if isolate → dequeue single
  - Check if batchable → drain all of same type
  - Default → dequeue single
- [ ] `start(handler)` / `stop()` lifecycle with queue subscription
- [ ] `setBatchStrategy(strategy)` for runtime reconfiguration
- [ ] Unit tests: isolated processing, batch draining, strategy changes

### 3.3 Replace RepublicAgent Queue Infrastructure
- [ ] Replace `private submissionQueue: Submission[] = []` with `private commandQueue: CommandQueue`
- [ ] Replace `submitOperation()`:
  - Change from `this.submissionQueue.push(submission)` to `this.commandQueue.enqueue(submission)`
  - CommandQueue auto-assigns priority based on Op type
- [ ] Replace `processSubmissionQueue()` with CommandProcessor-driven loop:
  - Use `commandProcessor.processNext()` instead of `this.submissionQueue.shift()`
  - Handle both `single` and `batch` results
  - Keep `isProcessing` guard for re-entrancy protection
- [ ] Update `handleInterrupt()`:
  - Change from `this.submissionQueue = []` to `this.commandQueue.cancelByType(...)` or drain all
- [ ] Keep `handleSubmission()` switch statement unchanged (individual handlers stay the same)
- [ ] Verify all Op types route correctly with new priority mapping
- [ ] Integration tests: UserTurn, ExecApproval, Interrupt, Shutdown flows

### 3.4 Wire ChannelManager to MessageBus
- [ ] In bootstrap code (ServerAgentBootstrap, extension service worker):
  - Subscribe ChannelManager to MessageBus with `subscribePattern('**', handler)`
  - Handler converts BusMessage back to ChannelEvent and calls `broadcastEvent()`
- [ ] Remove `eventDispatcher` callback from RepublicAgent (no longer needed)
- [ ] Remove `setEventDispatcher()` method from RepublicAgent
- [ ] ChannelManager now receives events via MessageBus subscription instead of direct callback
- [ ] Per-channel topic filtering: channels can subscribe to specific topic patterns based on capabilities
- [ ] Verify all channel types receive correct events
- [ ] Integration tests: sidepanel, websocket, tauri channels

## Phase 4: Migration + Middleware (Week 4)

### 4.1 Add Metrics Middleware
- [ ] Create `src/core/messaging/middleware/MetricsMiddleware.ts`
- [ ] Track per-topic: publish count, subscriber count, processing latency (ms)
- [ ] Track queue depth over time (CommandQueue size, EventLog entry count)
- [ ] Expose via `messageBus.getStats()` and `messageBus.getTopicStats(topic)`

### 4.2 Add Filter Middleware
- [ ] Create `src/core/messaging/middleware/FilterMiddleware.ts`
- [ ] Per-subscriber event filtering (e.g., channel only receives events for its session via `metadata.sessionId`)
- [ ] Topic-level rate limiting (e.g., max 100 `agent.message.delta` events/second to slow channels)

### 4.3 Wire Config Messages Through MessageBus
- [ ] Map ConfigChangeNotification → `config.changed` topic
- [ ] Map ConfigSyncMessage → `config.sync` topic
- [ ] Replace direct config message passing with MessageBus publish/subscribe
- [ ] Keep existing `ConfigRequestMessage`/`ConfigResponseMessage` types as payload (no type changes)
- [ ] Integration tests: config sync across channels

### 4.4 Add Replay for Reconnecting Channels
- [ ] Channel tracks `lastSeenSequence` number
- [ ] On channel reconnection, replay missed events from EventLog:
  ```
  messageBus.replay('**', channel.lastSeenSequence, (topic, msg) => {
    channel.sendEvent({ msg: msg.payload as EventMsg })
  })
  ```
- [ ] Update `ChannelAdapter` interface with optional `lastSeenSequence` property
- [ ] Integration test: WebSocket reconnection replays missed events

### 4.5 Cleanup Dead Code
- [ ] Delete `PriorityQueue` class from `src/core/QueueProcessor.ts` (unused by RepublicAgent)
- [ ] Delete `SubmissionQueue` class from `src/core/QueueProcessor.ts` (replaced by CommandQueue)
- [ ] Delete `EventQueue` class from `src/core/QueueProcessor.ts` (replaced by MessageBus)
- [ ] Delete `QueueProcessor` class from `src/core/QueueProcessor.ts` (replaced by CommandProcessor)
- [ ] Delete the entire `src/core/QueueProcessor.ts` file if nothing else imports from it
- [ ] Remove `RepublicAgent.eventQueue: Event[]` plain array (events now flow through MessageBus)
- [ ] Remove `RepublicAgent.eventDispatcher` callback (replaced by MessageBus subscription)
- [ ] Update `src/core/__tests__/QueueProcessor.test.ts` — either delete or rewrite for new classes
- [ ] Update all imports across codebase that reference deleted classes
- [ ] Run full test suite, fix any breakage

## Dependencies

- **No blockers**: This track can proceed independently
- **Enhances Track 01**: Hook system can subscribe to MessageBus topics (`tool.execution.*`, `approval.*`)
- **Enhances Track 04**: Task lifecycle events publish through MessageBus (`task.*`)
- **Enhances Track 06**: Cross-agent messaging uses Mailbox
- **Enhances Track 07**: State changes flow through MessageBus (`state.*`)

## Success Criteria

- [ ] All events flow through MessageBus (RepublicAgent.emitEvent → messageBus.publish)
- [ ] Commands use semantic priority ('interrupt' > 'immediate' > 'normal' > 'deferred')
- [ ] Type-aware batching: approvals/interrupts isolated, service requests batchable
- [ ] EventLog enables replay for reconnecting channels
- [ ] Middleware pipeline provides cross-cutting logging and metrics
- [ ] Existing tests pass unchanged (backward-compatible migration)
- [ ] Signal replaces at least 3 ad-hoc notification patterns (AgentConfig, ChannelAdapter, EffectQueue)
- [ ] Mailbox replaces ApprovalManager Promise/resolver handshake
- [ ] Dead code deleted: QueueProcessor.ts classes removed entirely
