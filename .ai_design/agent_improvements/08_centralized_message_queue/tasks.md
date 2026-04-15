# Track 08: Centralized Message Queue — Implementation Tasks

## Phase 1: Signal + Mailbox (Week 1)

### 1.1 Implement Signal Primitive
- [ ] Create `src/core/messaging/Signal.ts`
- [ ] Port Claudy's `createSignal<Args>()` pattern
- [ ] Add `subscribe()`, `emit()`, `clear()` methods
- [ ] Add `once()` convenience (auto-unsubscribe after first call)
- [ ] Unit tests for Signal

### 1.2 Implement Mailbox
- [ ] Create `src/core/messaging/Mailbox.ts`
- [ ] Implement `send(msg)` — queue or satisfy waiting promise
- [ ] Implement `poll(predicate)` — non-blocking check
- [ ] Implement `receive(predicate)` — async await with optional timeout
- [ ] Implement `subscribe(listener)` — enqueue/dequeue notifications
- [ ] Add revision counter for dirty checks
- [ ] Unit tests for Mailbox

### 1.3 Replace Ad-Hoc Notification Patterns
- [ ] Identify 3-5 existing ad-hoc callback patterns to replace with Signal
- [ ] Candidates: config change callbacks, connection state listeners, UI effect triggers
- [ ] Replace each with Signal, verify no behavior change
- [ ] Integration tests

### 1.4 Mailbox Proof of Concept
- [ ] Wire Mailbox into ApprovalManager for approval flow
- [ ] Tool execution `await mailbox.receive(isApprovalDecision)` instead of callback
- [ ] Verify approval flow works through Mailbox
- [ ] Integration test: approval grant/deny via Mailbox

## Phase 2: MessageBus Core (Week 2)

### 2.1 Implement MessageBus
- [ ] Create `src/core/messaging/MessageBus.ts`
- [ ] Create `src/core/messaging/types.ts` with BusMessage, SubscribeOptions, BusMiddleware
- [ ] Implement `publish(topic, message)` with monotonic sequence numbering
- [ ] Implement `subscribe(topic, handler, options?)` with sync/async/batched modes
- [ ] Implement `subscribePattern(pattern, handler)` with glob matching (e.g., `tool.*`)
- [ ] Implement `use(middleware)` pipeline
- [ ] Implement `getStats()` and `getTopicStats(topic)`
- [ ] Unit tests for MessageBus

### 2.2 Implement EventLog
- [ ] Create `src/core/messaging/EventLog.ts`
- [ ] Circular buffer implementation with configurable maxEntries (default: 5000)
- [ ] TTL-based eviction with configurable maxAgeMs (default: 5 minutes)
- [ ] Implement `replay(topic, fromSequence)` for topic-specific replay
- [ ] Implement `replayAll(fromSequence)` for full replay
- [ ] Unit tests for EventLog

### 2.3 Add Logging Middleware
- [ ] Create `src/core/messaging/middleware/LoggingMiddleware.ts`
- [ ] Log topic, source, sequence, and timestamp for each message
- [ ] Configurable log level per topic pattern
- [ ] Configurable verbosity (summary vs full payload)
- [ ] Unit tests

### 2.4 Wire EventQueue as MessageBus Wrapper
- [ ] Modify `EventQueue.emit()` to also publish to MessageBus
- [ ] Keep existing `EventQueue.on()` working (backward compatibility)
- [ ] Map EventMsg types to topic hierarchy (see design.md topic table)
- [ ] Verify all existing EventQueue subscribers still work
- [ ] Integration tests: events flow through both paths

## Phase 3: CommandQueue + CommandProcessor (Week 3)

### 3.1 Implement CommandQueue
- [ ] Create `src/core/messaging/CommandQueue.ts`
- [ ] Semantic priority type: `'interrupt' | 'immediate' | 'normal' | 'deferred'`
- [ ] Auto-priority mapping from Op type (see design.md table)
- [ ] Implement `enqueue()`, `dequeue()`, `peek()`, `drain()`, `cancelByType()`
- [ ] Implement `subscribe()` + `getSnapshot()` for Svelte store compatibility
- [ ] Unit tests for CommandQueue

### 3.2 Implement CommandProcessor
- [ ] Create `src/core/messaging/CommandProcessor.ts`
- [ ] BatchStrategy configuration (isolateTypes, batchableTypes, maxBatchSize, maxBatchWaitMs)
- [ ] Default strategy: isolate Interrupt/Shutdown/Approvals, batch ServiceRequests
- [ ] Implement `processNext()` — returns single or batched commands
- [ ] Implement `start()` / `stop()` lifecycle
- [ ] Unit tests for CommandProcessor

### 3.3 Replace SubmissionQueue and QueueProcessor
- [ ] Wire CommandQueue into RepublicAgent (replaces SubmissionQueue)
- [ ] Wire CommandProcessor (replaces QueueProcessor)
- [ ] Update ChannelManager submission routing to use CommandQueue
- [ ] Verify all Op types route correctly with new priority mapping
- [ ] Integration tests: user turn, approval, interrupt, shutdown flows

### 3.4 Wire ChannelManager to MessageBus
- [ ] ChannelManager subscribes to MessageBus for event dispatch (replaces direct dispatchEvent calls)
- [ ] Per-channel topic filtering based on channel capabilities
- [ ] Verify all channel types receive correct events
- [ ] Integration tests: sidepanel, websocket, tauri channels

## Phase 4: Migration + Middleware (Week 4)

### 4.1 Migrate Direct EventQueue Subscribers
- [ ] Audit all `eventQueue.on()` call sites
- [ ] Replace each with `messageBus.subscribe('topic', handler)`
- [ ] Remove direct EventQueue references where possible
- [ ] Keep EventQueue as thin wrapper for backward compatibility if needed

### 4.2 Add Metrics Middleware
- [ ] Create `src/core/messaging/middleware/MetricsMiddleware.ts`
- [ ] Track per-topic: publish count, subscribe count, processing latency
- [ ] Track queue depth over time (CommandQueue, EventLog)
- [ ] Expose via `messageBus.getStats()`

### 4.3 Add Filter Middleware
- [ ] Create `src/core/messaging/middleware/FilterMiddleware.ts`
- [ ] Per-subscriber event filtering (e.g., channel only receives events for its session)
- [ ] Topic-level rate limiting (e.g., max 100 delta events/second to slow channels)

### 4.4 Wire Config Messages Through MessageBus
- [ ] Map CONFIG_REQUEST/RESPONSE/UPDATE/CHANGE to `config.*` topics
- [ ] Replace direct config message passing with MessageBus publish/subscribe
- [ ] Keep existing config message types as payload (no type change)
- [ ] Integration tests: config sync across channels

### 4.5 Add Replay for Reconnecting Channels
- [ ] On channel reconnection, replay missed events from EventLog
- [ ] Channel tracks last-seen sequence number
- [ ] ChannelManager calls `eventLog.replay(topic, lastSequence)` on reconnect
- [ ] Integration test: WebSocket reconnection replays missed events

### 4.6 Cleanup
- [ ] Remove unused QueueProcessor class (replaced by CommandProcessor)
- [ ] Remove unused SubmissionQueue class (replaced by CommandQueue)
- [ ] Update imports across codebase
- [ ] Update ARCHITECTURE.md with new messaging architecture
- [ ] Final integration test suite

## Dependencies

- **No blockers**: This track can proceed independently
- **Enhances Track 01**: Hook system can subscribe to MessageBus topics
- **Enhances Track 04**: Task lifecycle events publish through MessageBus
- **Enhances Track 06**: Cross-agent messaging uses Mailbox
- **Enhances Track 07**: State changes flow through MessageBus

## Success Criteria

- [ ] All events flow through MessageBus (no direct EventQueue usage except wrapper)
- [ ] Commands use semantic priority ('interrupt' > 'immediate' > 'normal' > 'deferred')
- [ ] Type-aware batching: approvals isolated, service requests batchable
- [ ] EventLog enables replay for reconnecting channels
- [ ] Middleware pipeline provides cross-cutting logging and metrics
- [ ] Existing tests pass unchanged (backward-compatible migration)
- [ ] Signal replaces at least 3 ad-hoc notification patterns
- [ ] Mailbox used for at least 1 cross-component handshake (approval flow)
