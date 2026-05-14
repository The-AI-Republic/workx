# Track 08 Tasks

> **Status (2026-05-14):** Two phases, both implementation-ready. Phase 1 and Phase 2
> are independent and can ship in either order. Recommended order: Phase 1 first, since
> Phase 2's EventLog gets richer `queue.*` events once CommandQueue lands.

See [`design.md`](./design.md) for the architectural rationale and gap analysis.

---

## Phase 1: CommandQueue (replaces `submissionQueue` + `pendingNotifications`)

**Goal:** Priority-ordered, filterable, observable queue in place of the plain array.
**Estimated size:** ~300 LOC new, ~350 LOC deleted (net roughly LOC-neutral, plus new capability).
**Single PR.**

### 1.1 Pre-flight audits

- [ ] **Naming collision audit.** Run `grep -rn "class CommandQueue\|interface CommandQueue\|type CommandQueue" src/` — verify no existing symbol named `CommandQueue` in `src/`. If a collision exists, fall back to `MessageQueue<T>` or `SubmissionQueueV2`.
- [ ] **Dead-code re-verification.** Re-run `grep -rn "QueueProcessor\|SubmissionQueue\|EventQueue" src/ --include="*.ts" | grep -v __tests__` to confirm `QueueProcessor.ts` exports remain uninstantiated in production code as of branch-creation date. False positives expected on `RepublicAgent.eventQueue` (different name, same word).

### 1.2 New primitive

- [ ] Create `src/core/queue/types.ts` with `QueuePriority`, `QueuedCommand<T>`, `EnqueueOptions`, `DequeueFilter<T>`. ~30 LOC.
- [ ] Create `src/core/queue/CommandQueue.ts`:
  - [ ] `enqueue(payload, opts)` returns `uuid`. Default priority `'next'` if not specified.
  - [ ] `dequeue(filter?)` finds highest-priority match (linear scan, FIFO within tier). Removes and returns.
  - [ ] `dequeueBatch(filter, maxBatch=10)` returns up to N matching items in priority + FIFO order.
  - [ ] `peek(filter?)` non-destructive variant of `dequeue`.
  - [ ] `remove(uuid)` returns boolean.
  - [ ] `popAll(filter?)` drains all matching.
  - [ ] `clear()` empties queue.
  - [ ] `length` getter.
  - [ ] `subscribe(listener)` — internal `Set<Listener>`, fires on every mutation with frozen snapshot. Returns unsubscribe.
- [ ] Tests in `src/core/queue/__tests__/CommandQueue.test.ts`:
  - [ ] Priority ordering: `now` before `next` before `later`.
  - [ ] FIFO within same priority tier.
  - [ ] `engineId` filter excludes mismatched commands.
  - [ ] `remove(uuid)` and return value.
  - [ ] `popAll(filter)` drains correctly.
  - [ ] `subscribe` fires on enqueue, dequeue, remove, popAll, clear. Returns unsubscribe.
  - [ ] `dequeueBatch` respects maxBatch and filter.
  - [ ] `dequeueBatch` skips non-matching items (does not stop on first non-match if subsequent match exists — claudy semantic).

### 1.3 RepublicAgentEngine wiring

- [ ] In `src/core/engine/RepublicAgentEngine.ts`:
  - [ ] Replace `private submissionQueue: Submission[] = []` (line 27) with `private submissionQueue = new CommandQueue<Submission>()`.
  - [ ] Update `submitOperation(op)` (line 116-126) to call `submissionQueue.enqueue(submission, { priority, engineId })`. Priority derived from op type via a small helper `priorityForOp(op): QueuePriority` (`Interrupt`/`Shutdown`/`ExecApproval` → `'now'`; `UserInput`/`UserTurn`/`ServiceRequest` → `'next'`; default → `'later'`).
  - [ ] Update `processSubmissionQueue()` (line 378-403): loop calls `submissionQueue.dequeue(this.queueFilter())` until empty. `queueFilter()` returns the appropriate filter for main agent vs sub-agent.
  - [ ] Delete `pendingNotifications: string[]` field (line 44).
  - [ ] Delete `drainPendingNotificationsInto(input)` method (line 318-325) and all callers (`run`, `sendFollowUp`).
  - [ ] Modify `enqueueSyntheticUserTurn(text)` (line 299-312):
    - If `parentEngine` is set, call `parentEngine.submissionQueue.enqueue({ type: 'UserInput', items: [{type:'text', text}] }, { priority: 'later', engineId: this.engineId })`.
    - Else (root agent), enqueue into own `submissionQueue` with `priority: 'later'`.
  - [ ] Update `eventWaiters` resolution to NOT depend on the queue type (already independent — verify).

### 1.4 Delete dead code

- [ ] Delete `src/core/QueueProcessor.ts` (343 LOC).
- [ ] Delete `src/core/__tests__/QueueProcessor.test.ts`.
- [ ] Re-run `npm run lint && npm run type-check` and `npm test` — all green.

### 1.5 Behavior tests

- [ ] Integration test in `src/core/engine/__tests__/RepublicAgentEngine.queue.test.ts`:
  - [ ] User submits a prompt while a background sub-agent is mid-execution. Sub-agent's `enqueueSyntheticUserTurn` enqueues with `priority: 'later'`. User prompt enqueues with `priority: 'next'`. Drain order: user prompt first, sub-agent notification second.
  - [ ] Sub-agent's `processSubmissionQueue` does not pick up commands meant for main agent (engineId mismatch).
  - [ ] `Interrupt` op enqueued during in-flight tool: queued at `'now'`, picked next iteration, **does not abort the in-flight tool** (consistent with claudy and design intent).
- [ ] Update existing `RepublicAgent.test.ts` and `RepublicAgentEngine.test.ts` for any assertions about `submissionQueue.length` or `pendingNotifications`.

### 1.6 Documentation

- [ ] Brief README at `src/core/queue/README.md` pointing at design doc.
- [ ] Update `src/core/engine/README.md` (if present) to note priority semantics and sub-agent filter.

---

## Phase 2: EventLog (persistent audit trail)

**Goal:** Bounded, queryable, append-only audit store for system events. Separate from conversation rollout.
**Estimated size:** ~600 LOC (storage migration is the bulk).
**Can be split into two PRs: storage adapters first (Phase 2a), recorder + wiring second (Phase 2b).**

### 2.1 Types and façade

- [ ] Create `src/storage/eventLog/types.ts` with `EventKind`, `EventLogEntry`, `EventFilter`. ~50 LOC.
- [ ] Create `src/storage/eventLog/EventLog.ts` façade class with:
  - [ ] `append(entry)` — generates id (uuid) + timestamp, delegates to platform adapter.
  - [ ] `getEvents(filter)` — delegates to adapter, applies `limit` default 1000, max 10000.
  - [ ] `streamEvents(filter)` — async iterator over adapter cursor.
  - [ ] `clearForSession(sessionId)`.
  - [ ] `stats(sessionId)` — returns entry count + ts range.

### 2.2 IndexedDB adapter (extension)

- [ ] Update `src/storage/IndexedDBAdapter.ts` (or add `EventLogIDBAdapter.ts` alongside it):
  - [ ] Bump DB version from v4 to v5.
  - [ ] Add `event_log` object store, `keyPath: 'id'`.
  - [ ] Add indexes: `by_session_kind_ts: ['sessionId', 'kind', 'timestamp']`, `by_session_ts: ['sessionId', 'timestamp']`.
  - [ ] Implement `append`, `getEvents` (via index range query), `streamEvents` (cursor-based), `clearForSession` (index delete).
  - [ ] Test migration from v4 → v5 on populated DB.
- [ ] Migration tests in `src/storage/__tests__/IndexedDBAdapter.migration.test.ts`.

### 2.3 SQLite adapter (Tauri / Node)

- [ ] Add `src/storage/eventLog/adapters/SQLiteEventLogAdapter.ts`:
  - [ ] Use existing `better-sqlite3` connection (Node) or Tauri SQL plugin connection.
  - [ ] Prepared statements for `append`, `getEvents`, `streamEvents` (via `iterate()`), `clearForSession`, `stats`.
- [ ] Tauri Rust migration:
  - [ ] Add migration file in `src-tauri/migrations/` (next sequential number).
  - [ ] Migration creates `event_log` table + indexes (schema in design.md).
  - [ ] Register migration in Tauri SQL plugin setup.
- [ ] Tauri integration test verifying migration runs and the table is queryable from JS.

### 2.4 Adapter factory

- [ ] Update `src/storage/StorageAdapter.ts` (or equivalent provider) so `EventLog` resolves the correct adapter for the current platform (extension / desktop / server).
- [ ] Make adapter selection a one-line config; document in adapter README.

### 2.5 Eviction policy

- [ ] In `EventLog.append`, sample 10% of writes to trigger `maybeEvict(sessionId)`.
- [ ] `maybeEvict` checks `stats(sessionId)`; if `entries > maxEntries * 1.1` or `oldestTs < now - maxAgeMs`, delete the oldest entries down to budget.
- [ ] Make `maxEntries` (default 5000) and `maxAgeMs` (default 30 days) configurable via `AgentConfig.eventLog`.
- [ ] Tests: insert 6000 entries; assert stats reports ≤ 5500 after sample-triggered eviction; force a `getEvents` call and assert ≤ 5000 after lazy compaction.

### 2.6 Recorder + subscriber wiring

- [ ] Create `src/storage/eventLog/EventLogRecorder.ts`:
  - [ ] Owns subscriptions to all event sources.
  - [ ] Single `start(eventLog: EventLog)` method called from agent bootstrap.
  - [ ] Single `stop()` for clean teardown.
- [ ] Wire `CommandQueue.subscribe` (Phase 1):
  - [ ] On each mutation, diff prior vs current snapshot to derive `queue.enqueue` / `queue.dequeue` / `queue.remove` events.
  - [ ] Alternative (simpler): expose explicit `onEnqueue`, `onDequeue`, `onRemove` callbacks on CommandQueue and subscribe directly. Decide during implementation; prefer the explicit callbacks for clarity.
- [ ] Wire `HookDispatcher`:
  - [ ] Subscribe to existing `emitObservability` channel (`src/core/hooks/HookDispatcher.ts`).
  - [ ] Translate `HookFired` → `hook.fired`, `HookBlocked` → `hook.blocked`.
- [ ] Wire `ApprovalManager`:
  - [ ] In `requestApproval` / `handleDecision` / cancellation / timeout paths, call `eventLog.append({ kind: 'approval.*', data: redactedSummary })`.
  - [ ] Define redaction for tool parameters / sensitive context (mirror existing `RolloutRecorder` redaction).
- [ ] Wire `TurnManager`:
  - [ ] At turn start/end: `turn.started`, `turn.completed` with token usage if available.
  - [ ] At tool start/end: `tool.started`, `tool.completed`, `tool.failed`.
- [ ] Wire `SubAgentRunner` (`src/tools/AgentTool/SubAgentRunner.ts`):
  - [ ] On `run()` (line 121-163): `subagent.spawned`.
  - [ ] On completion / `enqueueSyntheticUserTurn` site (line 180): `subagent.completed`.
  - [ ] On error path: `subagent.failed`.
- [ ] Tests:
  - [ ] Driver test that exercises a full submit→approve→tool→complete flow and asserts the expected event sequence appears in EventLog.
  - [ ] Hook subscription test: register a hook, fire it, assert `hook.fired` entry.
  - [ ] Approval test: timeout path produces `approval.auto-approved` entry with reason.

### 2.7 Read-side surface

- [ ] Expose `EventLog` via `AgentRegistry` or a similar singleton so future debugging UI / DevTools panel can call `getEvents` / `streamEvents` without re-wiring storage.
- [ ] (Optional, follow-up) Small debug panel in sidepanel `/settings` or `/debug` route that renders the live event stream — not required for v1.

### 2.8 Configuration

- [ ] Add `AgentConfig.eventLog` config block:
  ```typescript
  eventLog: {
    enabled: boolean;             // default true
    maxEntriesPerSession: number; // default 5000
    maxAgeMs: number;             // default 30 * 24 * 60 * 60 * 1000
  }
  ```
- [ ] When `enabled === false`, all `append` calls become no-ops (cheap early return).
- [ ] Document in `src/config/README.md` (if present).

### 2.9 Documentation

- [ ] `src/storage/eventLog/README.md`: API overview, kinds, example queries, eviction policy.
- [ ] Update `CLAUDE.md` "Source Layout" table with the new `src/storage/eventLog/` entry.

---

## Cross-cutting tasks (both phases)

- [ ] Verify `__BUILD_MODE__` (`extension` / `desktop` / `server`) is respected — the adapter factory must select the right platform without bringing in node-only code in the extension bundle.
- [ ] Add type exports to `src/storage/index.ts` so consumers don't reach into subpaths.
- [ ] Update the dependency graph in `.ai_design/agent_improvements/README.md` to reflect that Track 08 is now a single track with two phases.

---

## Deferred work (NOT in this track)

| Item | Rationale |
|------|-----------|
| **MessageBus** (former 08d) | Stays deferred. Reassess only if a real consumer emerges that none of `ChannelManager`, `ServiceRegistry`, `HookDispatcher`, `CommandQueue.subscribe`, or `EventLog.streamEvents` can serve. |
| **Tool-call preemption on `'now'` priority** | Out of scope. `'now'` is urgent-but-cooperative (claudy semantic). Adding tool-cancellation plumbing is a separate concern. |
| **EventLog debug UI panel** | Optional follow-up after v1 ships. The `streamEvents` API supports it; the panel itself is UI work. |
| **RepublicAgentEngine.eventWaiters refactor** | The other "resolver Array" pattern in the engine. Not in scope; revisit if it grows. |
| **EventLog cross-session aggregation queries** | v1 is per-session. Cross-session debugging (e.g., "all auto-approves in the last week across all sessions") is a future need; the schema supports it via filter, but eviction and indexing are session-scoped today. |
