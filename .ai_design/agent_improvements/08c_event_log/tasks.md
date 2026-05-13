# Track 08c: EventLog — Tasks

> v1 scope only. ~600 LOC across types, recorder, 3 storage adapters, 4 subscribers, tests.
> Single PR. Soft prerequisites: 08a (Signal), 08b (CommandQueue) — can land before 08b
> if needed; the hook subscriber alone justifies the schema.

## Step 1 — Type definitions

- [ ] Create `src/core/eventLog/types.ts` (~80 LOC)
  - `EventLogKind` union of all event names (session, command, tool, approval, hook, subagent, compact, permission, error)
  - `EventLogEntry` interface: `id, sessionId, parentSessionId?, parentEventId?, timestamp, kind, payload, meta?`
  - `EventPayload` per-kind payload type registry: `EventPayload['command:enqueued']`, etc.
  - `EventLogStorage` interface: `append, query, evict, count`
- [ ] Verify `ulid` (or equivalent sortable-id) dependency available
  - `npm ls ulid 2>/dev/null` — if missing, install minimal one (~6 KB) or write a 20-line generator
  - Either way, document the choice in a code comment

## Step 2 — `EventLogRecorder` class

- [ ] Create `src/core/eventLog/EventLogRecorder.ts` (~100 LOC)
  - Constructor takes `EventLogStorage` + optional `{ maxEntriesPerSession, maxAgeMs }`
  - Default `maxEntriesPerSession = 5000`, `maxAgeMs = 30 * 24 * 60 * 60 * 1000`
  - `append<K>({ sessionId, kind, payload, parentSessionId?, parentEventId?, meta? })` — never throws; returns the appended entry
  - Generates ULID id, stamps timestamp = `Date.now()`
  - Emits `changed: Signal<[EventLogEntry]>` after successful append
  - `query` and `count` delegate to storage
  - `subscribe(sessionId, listener)` filters by sessionId AND parentSessionId
  - Private `maybeEvict(sessionId)` — runs at 1% sampling per append
- [ ] Create `src/core/eventLog/index.ts` re-export

## Step 3 — IndexedDB storage

- [ ] Add `event_log: 'id'` to `STORE_KEY_PATHS` (`src/storage/StorageAdapter.ts`)
- [ ] Bump `DB_VERSION` from 4 to 5 (`src/storage/IndexedDBAdapter.ts`)
- [ ] Add v5 `onupgradeneeded` block creating `event_log` object store with indexes:
  - `by_session` (sessionId, non-unique)
  - `by_session_timestamp` ([sessionId, timestamp], non-unique)
  - `by_kind` (kind, non-unique)
  - `by_parent_event` (parentEventId, non-unique)
- [ ] Create `src/storage/IndexedDBEventLogStorage.ts` (~120 LOC) implementing `EventLogStorage`
  - `append` — adapter.put('event_log', entry)
  - `query` — cursor on `by_session_timestamp`, in-memory filter on kind/range, limit
  - `evict({ sessionId, olderThan })` — cursor on `by_session`, delete matching by timestamp
  - `evict({ sessionId, keepLast })` — count then delete oldest excess
  - `count(sessionId)` — IDBKeyRange.only(sessionId) on `by_session` index

## Step 4 — NodeSQLite storage

- [ ] Add EventLog DDL to `src/server/storage/NodeSQLiteAdapter.ts` init
  - `CREATE TABLE IF NOT EXISTS event_log (...)`
  - Indexes: `idx_eventlog_session`, `idx_eventlog_session_ts`, `idx_eventlog_kind`, `idx_eventlog_parent_event`
- [ ] Create `src/server/storage/NodeSQLiteEventLogStorage.ts` (~100 LOC) implementing `EventLogStorage`
  - Use prepared statements via `better-sqlite3`
  - Serialize `payload` and `meta` as JSON strings on write
  - Deserialize on read
  - Denormalize `meta.durationMs` into a column for fast queries

## Step 5 — Tauri storage

- [ ] Create `src-tauri/src/migrations/0005_event_log.sql` — same DDL as NodeSQLite
- [ ] Wire migration into Tauri SQLite init (existing migration pattern)
- [ ] Create `src/desktop/storage/TauriEventLogStorage.ts` (~80 LOC)
  - Implements `EventLogStorage`
  - Routes through existing Tauri SQLite invoke pattern
  - Same JSON serialization as NodeSQLite

## Step 6 — Subscribers (4 small files)

- [ ] `src/core/eventLog/subscribers/hookSubscriber.ts` (~30 LOC)
  - `wireHookSubscriber({ eventLog, hookDispatcher })` wraps `hookDispatcher.eventEmitter`
  - On `HookFired` events, append `{ kind: 'hook:fired', payload: msg.data }`
  - Pass-through to existing UI emitter (don't replace, augment)
- [ ] `src/core/eventLog/subscribers/commandQueueSubscriber.ts` (~30 LOC)
  - Subscribe to `commandQueue.changed` — but careful, the snapshot doesn't tell us *what* changed
  - Better: instrument enqueue/dequeue at the queue level via a small `onMutate` hook OR subscribe to specific signals (`urgentEnqueued` is one; consider adding `enqueued`/`dequeued` signals to CommandQueue for this purpose — coordinate with 08b PR)
  - **Decision in this PR:** if 08b is already merged with only `changed`, fall back to subscriber-side diff (compare snapshots); document the trade-off
- [ ] `src/core/eventLog/subscribers/approvalSubscriber.ts` (~30 LOC)
  - Wrap `ApprovalManager.eventEmitter` (or whatever post-08a path is)
  - Translate `ApprovalRequested/Granted/Denied/AutoApproved` to `approval:*` log entries
- [ ] `src/core/eventLog/subscribers/subagentSubscriber.ts` (~30 LOC)
  - Subscribe to `SubAgentRunner` lifecycle (existing PR #191 hooks)
  - Translate to `subagent:spawned/completed/failed/killed` entries

## Step 7 — Bootstrap wiring

- [ ] In `RepublicAgent.initialize` (or earliest possible bootstrap):
  - Construct `EventLogRecorder` with platform-appropriate `EventLogStorage`
  - Call all four `wire*Subscriber()` functions
- [ ] Pass `eventLogRecorder` reference to `Session` (constructor param) for direct `append` use cases that don't fit a subscriber (rare; document each one)
- [ ] Verify the recorder is shared across the entire agent lifecycle (one per session, lives for the session's duration)

## Step 8 — Tests

- [ ] `tests/core/eventLog/EventLogRecorder.test.ts` (~100 LOC)
  - `append` writes via storage and emits `changed` with the entry
  - `append` swallows storage errors (mock storage that rejects; verify no throw, console.error logged)
  - `subscribe(sessionId, listener)` filters by sessionId only
  - `subscribe(sessionId, listener)` ALSO matches entries with `parentSessionId === sessionId`
  - `query` filter combinations: kind, after, before, limit
  - `evict({ olderThan })` removes entries below cutoff, leaves newer
  - `evict({ keepLast: N })` trims to N most-recent
  - `count(sessionId)` returns correct count
  - `maybeEvict` triggers at 1% sampling (mock Math.random)
- [ ] `tests/storage/IndexedDBEventLogStorage.test.ts` (~80 LOC)
  - Use `fake-indexeddb` for in-memory tests
  - v4 → v5 upgrade preserves existing data, adds event_log store
  - `append` + `query` round-trip
  - `query` uses index correctly (no full scan for sessionId queries)
  - `evict` deletes correct rows
- [ ] `tests/server/storage/NodeSQLiteEventLogStorage.test.ts` (~60 LOC)
  - Use `:memory:` SQLite db
  - Migration is idempotent (run twice, no error)
  - JSON round-trip for payload + meta
- [ ] `tests/core/eventLog/subscribers/*.test.ts` (~80 LOC total)
  - Hook fires → entry with `kind: 'hook:fired'`
  - Command enqueued → entry with `kind: 'command:enqueued'`
  - ApprovalManager grants → entry with `kind: 'approval:granted'`
  - SubAgent spawned → entry with `kind: 'subagent:spawned'`
- [ ] `tests/core/eventLog/integration.test.ts` (~60 LOC)
  - End-to-end: user sends message → expect chain of `command:enqueued → command:dequeued → tool:start → approval:requested → ... → tool:end`
  - Verify `parentEventId` chain wires correctly across subscribers (or document explicit gaps)

## Step 9 — Performance & coverage

- [ ] Benchmark: append latency under 5 ms p99 with 5000-entry IndexedDB log
  - If not, profile and adjust eviction cadence
- [ ] Verify 80%+ coverage on `src/core/eventLog/**` and `src/storage/IndexedDBEventLogStorage.ts`
- [ ] Verify build green on extension/desktop/server platforms
- [ ] Verify lint passes
- [ ] Add short README at `src/core/eventLog/README.md` linking to design doc

## Out of scope (08c) — picked up by follow-ons

- `/log` slash command for inline querying (08c-followup)
- Live tail debug overlay in webfront (08c-followup)
- JSONL export for offline analysis (08c-followup)
- Cross-session aggregation queries (08c-followup)
- Compaction reading from EventLog instead of transcript (05b)
- Tool-execution payload subscribers for Phase 2 hooks (`PreToolUse/PostToolUse/...` once Track 01 Phase 2 fires them)
- Schema versioning beyond v5 — punt to follow-on if event shape changes
- Persisted causality-chain validator (some chains will inevitably be broken; document, don't enforce in v1)
