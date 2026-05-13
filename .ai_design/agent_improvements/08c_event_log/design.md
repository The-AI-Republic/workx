# Track 08c: EventLog (Bounded Audit / Replay Journal)

> **Status (2026-05-13):** Design ready. Active PR: none.
> Soft prerequisites: 08a (uses `Signal<T>`), 08b (subscribes to `commandQueue.changed`).
> Can land before 08b if needed; the Track 01 hook subscriber alone justifies the schema.
>
> Key decisions resolved (see [Validation Notes 2026-05-13](#validation-notes-2026-05-13)):
> - **Source pattern:** *not* a port — claudy's logging is anemic by their own admission. We design what claudy *should* have.
> - **Subscribers:** Track 01 `HookDispatcher.emitObservability` (single choke point, identified in audit), 08b `commandQueue.changed`, 08a `Mailbox` send (via Signal). Approval decisions ride through the hook events.
> - **Storage:** new `event_log` store in `STORE_KEY_PATHS`. Bumps IndexedDB to v5; adds SQLite table to Node + Tauri adapters; adds Rust migration for Tauri.
> - **Recorder:** **separate `EventLogRecorder` class**, not bolted onto `RolloutRecorder`. Different semantics (immutable append-only vs mutable conversation history).
> - **Eviction:** ring-buffer per session, capped at **5,000 entries or 30 days**, whichever hits first. Configurable.
> - **Replay:** read API only (`getEvents`, `streamEvents`). Replay is for debugging + offline analysis, not state-machine restoration.
> - **v1 size:** ~600 LOC (storage migration is the bulk).

## Problem

We have **no unified, queryable audit trail** of what the agent has done. Concretely:

- **What happened in this session?** Today, you stitch together: the conversation `.jsonl`, scattered `console.log` lines, the `execution_records` SQL table (only for scheduled jobs), and platform-specific dev-tools logs. There is no single answer.
- **Why did this approval get auto-approved?** Today: read `ApprovalManager` source, infer from policy + timeout config. Should be: query the log for the approval event with its decision context.
- **When did the user cancel that command?** Today: nothing logs cancel events. Should be: `eventLog.getEvents({ kind: 'command-cancelled', sessionId })`.
- **Did the PreToolUse hook fire for that tool call?** Today: hook firings are emitted as observability events (Track 01 PR #198) but only for live UI consumers — not persisted. Should be: persisted with timing data.

Claudy's audit trail is admittedly thin. The 08c research probe found **10 concrete gaps** in claudy's logging:
1. Tool execution start/end (only approval decisions land in analytics)
2. Permission prompt timing (display duration, timeout reason)
3. Model response metadata (tokens, cost, cache hit/miss only in analytics, not in `.jsonl`)
4. User edits / cancellations (queue ops logged but reason lost)
5. Hook execution trace (which hooks fired, in what order, return values)
6. Approval source ambiguity (classifier vs hook vs user — only in analytics metadata)
7. **Unified audit trail** — no single chain of: input → queue op → tool start → approval → result
8. Sub-agent causality (parent message id linkage missing)
9. Compaction opacity (no log of what was archived)
10. Permission mode transitions (logged as `mode` entry but not linked to triggering action)

PR #167 (session memory extraction) had to invent a `marble-origami-commit` boundary type because the audit chain didn't exist. We get to build it from the start.

## What Claudy Does (the gap, not the model)

Claudy logs queue operations to `~/.claude/projects/{project}/{sessionId}.jsonl` via `recordQueueOperation`:

```typescript
// claudy/utils/messageQueueManager.ts:28-38
function logOperation(operation: QueueOperation, content?: string): void {
  const sessionId = getSessionId()
  const queueOp: QueueOperationMessage = {
    type: 'queue-operation',
    operation,                        // 'enqueue' | 'dequeue' | 'remove' | 'popAll'
    timestamp: new Date().toISOString(),
    sessionId,
    ...(content !== undefined && { content }),
  }
  void recordQueueOperation(queueOp)
}
```

That's the entire claudy event-log surface. Other things that *should* be persisted go to:
- **Analytics backends** (Statsig/Datadog/OTel) — `tengu_tool_use_*`, `tengu_api_*`, `tengu_tool_result_persisted` — not queryable per-session locally.
- **Per-session `.jsonl`** — message history, queue ops, attribution snapshots, file-history snapshots, mode changes, task summaries.
- **Sidechain `.jsonl`** — sub-agent transcripts in separate files, not cross-linked structurally.

`--replay-user-messages` is **not** replay — it's stdin-echo over stream-json mode, used by the Anthropic CCR bridge for acknowledgment. Compaction reads transcript messages, not the queue-op log.

So claudy's "EventLog" is a write-only debugging line, not an audit chain. Browserx fills the gap.

## BrowserX Design

### Event envelope

```typescript
// src/core/eventLog/types.ts
export type EventLogKind =
  // Session / agent lifecycle
  | 'session:start' | 'session:end' | 'session:resume'

  // Command queue (08b)
  | 'command:enqueued' | 'command:dequeued' | 'command:removed' | 'command:cancelled' | 'command:urgent'

  // Tool execution (Track 02)
  | 'tool:start' | 'tool:end' | 'tool:error'

  // Approvals (08a-refactored ApprovalManager)
  | 'approval:requested' | 'approval:granted' | 'approval:denied' | 'approval:auto-approved' | 'approval:timeout'

  // Hooks (Track 01)
  | 'hook:fired' | 'hook:result'

  // Sub-agents (PR #191)
  | 'subagent:spawned' | 'subagent:completed' | 'subagent:failed' | 'subagent:killed'

  // Compaction (Track 05/05b)
  | 'compact:started' | 'compact:completed' | 'compact:summary-extracted'

  // Permission mode changes
  | 'permission:mode-changed'

  // Errors
  | 'error:unhandled' | 'error:listener-threw'

export interface EventLogEntry {
  id: string                     // ULID — sortable by time
  sessionId: string
  parentSessionId?: string       // sub-agent → parent linkage (closes claudy gap #8)
  parentEventId?: string         // event causality chain (closes claudy gap #7)
  timestamp: number              // ms epoch
  kind: EventLogKind
  payload: unknown               // shape determined by kind, see EventPayload<K>
  meta?: {
    durationMs?: number          // for events with implicit duration (tool:end, hook:result)
    error?: { name: string; message: string; stack?: string }
    workload?: string            // billing tag from Command (08b)
    origin?: 'user' | 'system' | 'subagent' | 'hook' | 'scheduler'
  }
}

// Per-kind payload typing (a registry, not a single union — keeps payloads cohesive)
export interface EventPayload {
  'command:enqueued': { commandId: string; mode: CommandMode; priority: CommandPriority }
  'command:dequeued': { commandId: string; mode: CommandMode }
  // ...
}
```

What the schema is doing:
- **`parentEventId`** — every event optionally points at the event that caused it. Tool:start cites the command:dequeued that triggered it. Approval:requested cites the tool:start. Hook:fired cites the approval:requested. **This is the chain claudy doesn't have.**
- **`parentSessionId`** — sub-agent events carry the parent's session id, not just their own. Cross-session queries become trivial.
- **`meta.durationMs`** — events that have an "end" pair (tool:end, hook:result) include duration; eliminates a join in queries.
- **`workload`** — billing parity with claudy.

### `EventLogRecorder` class

```typescript
// src/core/eventLog/EventLogRecorder.ts
import { createSignal } from '../signals/signal'
import { ulid } from '../utils/ulid'  // or whatever id library is in use; see naming check

export interface EventLogStorage {
  append(entry: EventLogEntry): Promise<void>
  // Filtered read (newest-first by default)
  query(filter: {
    sessionId: string
    kind?: EventLogKind | EventLogKind[]
    after?: number       // timestamp
    before?: number
    limit?: number
  }): Promise<EventLogEntry[]>
  // Compaction / eviction
  evict(filter: { sessionId: string; olderThan?: number; keepLast?: number }): Promise<number>
  count(sessionId: string): Promise<number>
}

export class EventLogRecorder {
  private readonly maxEntriesPerSession: number
  private readonly maxAgeMs: number
  private readonly evictBatchSize = 100
  changed = createSignal<[EventLogEntry]>()  // for live consumers (UI tail, debug overlay)

  constructor(
    private readonly storage: EventLogStorage,
    opts: { maxEntriesPerSession?: number; maxAgeMs?: number } = {},
  ) {
    this.maxEntriesPerSession = opts.maxEntriesPerSession ?? 5_000
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000  // 30 days
  }

  async append<K extends EventLogKind>(args: {
    sessionId: string
    kind: K
    payload: EventPayload[K]
    parentSessionId?: string
    parentEventId?: string
    meta?: EventLogEntry['meta']
  }): Promise<EventLogEntry> {
    const entry: EventLogEntry = {
      id: ulid(),
      sessionId: args.sessionId,
      parentSessionId: args.parentSessionId,
      parentEventId: args.parentEventId,
      timestamp: Date.now(),
      kind: args.kind,
      payload: args.payload,
      meta: args.meta,
    }
    try {
      await this.storage.append(entry)
      this.changed.emit(entry)
    } catch (err) {
      // Logging-the-logger problem: print and swallow. Audit trail is
      // important but never important enough to crash the agent.
      console.error('[eventLog] append failed', err, entry)
    }
    // Best-effort opportunistic eviction; bounded.
    if (Math.random() < 0.01) void this.maybeEvict(args.sessionId)
    return entry
  }

  query = this.storage.query.bind(this.storage)
  count = this.storage.count.bind(this.storage)

  /** Subscribe to a live tail of events for a session (e.g., debug UI). */
  subscribe(sessionId: string, listener: (entry: EventLogEntry) => void): () => void {
    return this.changed.subscribe((entry) => {
      if (entry.sessionId === sessionId || entry.parentSessionId === sessionId) {
        listener(entry)
      }
    })
  }

  private async maybeEvict(sessionId: string): Promise<void> {
    const count = await this.storage.count(sessionId)
    const ageCutoff = Date.now() - this.maxAgeMs
    if (count > this.maxEntriesPerSession) {
      await this.storage.evict({ sessionId, keepLast: this.maxEntriesPerSession })
    }
    await this.storage.evict({ sessionId, olderThan: ageCutoff })
  }
}
```

Key design choices:
- **`append` never throws.** Audit-trail failures are logged but never propagate. The audit trail is best-effort by definition.
- **Opportunistic eviction.** 1% sampling on every append checks for over-cap. Cheap; no separate timer thread.
- **Per-kind type safety.** `EventPayload[K]` enforces the right shape per event kind at the call site.
- **Live tail via Signal.** UI consumers subscribe; debug overlays get free real-time updates.

### Storage: `event_log` store across all three adapters

#### `STORE_KEY_PATHS` addition (`src/storage/StorageAdapter.ts`)

```typescript
export const STORE_KEY_PATHS: Record<string, string> = {
  // ... existing entries ...
  event_log: 'id',  // ULID; indexed by [sessionId, timestamp]
}
```

#### IndexedDB schema (`src/storage/IndexedDBAdapter.ts`)

Bump `DB_VERSION` from 4 to 5. Add to `onupgradeneeded`:

```typescript
if (oldVersion < 5) {
  if (!db.objectStoreNames.contains('event_log')) {
    const store = db.createObjectStore('event_log', { keyPath: 'id' })
    store.createIndex('by_session', 'sessionId', { unique: false })
    store.createIndex('by_session_timestamp', ['sessionId', 'timestamp'], { unique: false })
    store.createIndex('by_kind', 'kind', { unique: false })
    store.createIndex('by_parent_event', 'parentEventId', { unique: false })
  }
}
```

#### NodeSQLite schema (`src/server/storage/NodeSQLiteAdapter.ts` or wherever the migration lives)

```sql
CREATE TABLE IF NOT EXISTS event_log (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  parentSessionId TEXT,
  parentEventId TEXT,
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,        -- JSON-encoded
  meta TEXT,                     -- JSON-encoded, optional
  durationMs INTEGER             -- denormalized from meta for fast queries
);
CREATE INDEX IF NOT EXISTS idx_eventlog_session ON event_log(sessionId);
CREATE INDEX IF NOT EXISTS idx_eventlog_session_ts ON event_log(sessionId, timestamp);
CREATE INDEX IF NOT EXISTS idx_eventlog_kind ON event_log(kind);
CREATE INDEX IF NOT EXISTS idx_eventlog_parent_event ON event_log(parentEventId);
```

#### Tauri (Rust migration)

`src-tauri/src/migrations/0005_event_log.sql` — same DDL as NodeSQLite.

#### Adapter implementation pattern

Each adapter implements `EventLogStorage`:

```typescript
class IndexedDBEventLogStorage implements EventLogStorage {
  async append(entry: EventLogEntry): Promise<void> {
    return this.adapter.put('event_log', entry)
  }
  async query(filter): Promise<EventLogEntry[]> {
    // Use cursor on by_session_timestamp index, apply kind/range filters in-memory
  }
  async evict(filter): Promise<number> {
    // Open cursor on by_session, delete matching, return count
  }
  async count(sessionId): Promise<number> {
    return this.adapter.count('event_log', IDBKeyRange.only(sessionId), 'by_session')
  }
}
```

### Subscriber wiring

The point of EventLog is to **subscribe to the existing observation choke points**, not to instrument every code site individually.

**Track 01 — `HookDispatcher.emitObservability`** (`src/core/hooks/HookDispatcher.ts:173-189`)
This is **the** single point where every hook firing converges (audit confirmed 2026-05-13). One subscriber catches every hook event:

```typescript
// src/core/eventLog/subscribers/hookSubscriber.ts
export function wireHookSubscriber(deps: { eventLog: EventLogRecorder; hookDispatcher: HookDispatcher }) {
  const prevEmitter = deps.hookDispatcher.eventEmitter
  deps.hookDispatcher.setEventEmitter((msg) => {
    // Pass-through to existing UI emitter
    prevEmitter?.(msg)
    // Plus: log
    if (msg.type === 'HookFired') {
      void deps.eventLog.append({
        sessionId: deps.hookDispatcher.currentSessionId,
        kind: 'hook:fired',
        payload: msg.data,
      })
    }
  })
}
```

**08b — `commandQueue.changed` + `urgentEnqueued`**
Subscribe to both signals; log enqueue/dequeue/urgent.

**08a — Mailbox sends from ApprovalManager**
ApprovalManager already emits `ApprovalRequested/Granted/Denied/AutoApproved` events. Wire a subscriber that translates those to `approval:*` log entries.

**Tool execution (Track 02)**
Track 02's PR #197 added `tool:start`/`tool:end`/`tool:error` event semantics in tool runtime metadata. Wire one subscriber that consumes those.

**Sub-agents (PR #191)**
`SubAgentRunner` lifecycle hooks already exist. Subscriber translates to `subagent:*` log entries.

### Debug API — `/log` slash command (out of scope for v1; lives in 08c-followup)

Future capability:
```
/log [--kind=tool:start] [--last=50] [--session=current|<id>]
```
Returns a tabular dump for debugging. Built on top of `EventLogRecorder.query`. Trivial once the storage exists.

### Dev overlay — live tail (also future)

Future capability: a Svelte panel in webfront that subscribes to `eventLogRecorder.subscribe(sessionId)` and renders entries as they happen. ~50 LOC; defer.

## Naming & Collisions

Audited 2026-05-13:

| Name | Status |
|------|--------|
| `EventLog` | Not used — **use** |
| `EventLogEntry`, `EventLogKind`, `EventLogStorage`, `EventLogRecorder` | Not used — **use** |
| `EventPayload` | Not used as a type — **use** |
| `event_log` (store key) | Not in `STORE_KEY_PATHS` — **use** |
| `src/core/eventLog/` directory | Doesn't exist — **create** |
| `ulid()` | Confirm dependency exists or add — see Step 1 |

## v1 Plan (this PR — ~600 LOC)

**Step 1 — Type definitions** (`src/core/eventLog/types.ts`, ~80 LOC)
- All `EventLogKind` values
- `EventLogEntry` interface
- `EventPayload<K>` per-kind payload registry
- `EventLogStorage` interface

**Step 2 — `EventLogRecorder`** (`src/core/eventLog/EventLogRecorder.ts`, ~100 LOC)
- `append`, `query`, `count`, `subscribe`, `maybeEvict`
- Never-throw `append`; opportunistic eviction at 1% sampling
- Configurable `maxEntriesPerSession` (default 5000), `maxAgeMs` (default 30 days)
- Verify `ulid` (or another sortable ID generator) is available; if not, install it (~6 KB)

**Step 3 — IndexedDB storage** (`src/storage/IndexedDBEventLogStorage.ts`, ~120 LOC)
- Implement `EventLogStorage` over the v5 `event_log` store
- Bump `DB_VERSION` from 4 to 5; add `onupgradeneeded` block
- Cursor-based query with index `by_session_timestamp`
- Cursor-based evict with delete-during-iteration

**Step 4 — NodeSQLite storage** (`src/server/storage/NodeSQLiteEventLogStorage.ts`, ~100 LOC)
- Same `EventLogStorage` interface, backed by `better-sqlite3` prepared statements
- DDL in adapter init; idempotent `CREATE IF NOT EXISTS`

**Step 5 — Tauri storage**
- Add Rust migration `src-tauri/src/migrations/0005_event_log.sql`
- `TauriEventLogStorage.ts` calls into the existing Tauri SQLite invoke pattern

**Step 6 — Subscriber wires** (~150 LOC across 4 files)
- `subscribers/hookSubscriber.ts` — wraps `HookDispatcher.eventEmitter`
- `subscribers/commandQueueSubscriber.ts` — `commandQueue.changed` (08b) + `urgentEnqueued`
- `subscribers/approvalSubscriber.ts` — `ApprovalManager` event emitter
- `subscribers/subagentSubscriber.ts` — `SubAgentRunner` lifecycle

**Step 7 — Bootstrap wiring**
- In `RepublicAgent.initialize`, instantiate `EventLogRecorder` with the platform-appropriate storage
- Wire all subscribers
- Pass recorder reference to `Session` for direct logging where useful (rare; subscribers cover most cases)

**Step 8 — Tests** (`tests/core/eventLog/`, ~200 LOC)
- `EventLogRecorder.append` writes via storage and emits `changed`
- `append` swallows storage errors (mock storage that throws; verify no propagation)
- `subscribe(sessionId, listener)` filters by sessionId AND parentSessionId
- `query` returns matching entries with all filter combinations
- `evict` removes entries by `olderThan` and `keepLast`
- IndexedDB v4 → v5 upgrade test (use fake-indexeddb)
- NodeSQLite migration test (in-memory SQLite)
- Subscriber tests: hook fires → entry appended; command enqueued → entry; etc.
- Integration: end-to-end "user sends message" produces expected event chain

**Step 9 — Performance & coverage**
- Append latency under 5ms p99 with 5000-entry log on IndexedDB
- 80%+ coverage on `src/core/eventLog/**`
- Verify build green for all platforms

## Follow-on (NOT in this PR)

| Track | Scope |
|-------|-------|
| **08c-followup** | `/log` slash command for inline querying |
| **08c-followup** | Live tail debug overlay in webfront |
| **08c-followup** | Export to JSONL for offline analysis (`eventLogRecorder.exportSession(id, stream)`) |
| **08c-followup** | Tool-execution payload subscribers when Track 02 lands more lifecycle hooks |
| **05b** | Compaction reads from EventLog for richer summaries (currently only reads transcript) |

## Risks

- **Logging-the-logger.** A failure in `EventLogRecorder.append` cannot crash the agent. Hard rule. Mitigation: try/catch in `append`; tests assert no propagation.
- **Storage cost.** 5000 entries/session at ~500 bytes each = ~2.5 MB/session worst case. With 30-day eviction and typical browser sessions, p95 likely under 500 KB. Acceptable for IndexedDB; for SQLite it's a rounding error.
- **Schema migration risk.** IndexedDB v4 → v5 must be tested with real fake-indexeddb against existing v4 data. NodeSQLite uses idempotent DDL so it's safe. Tauri Rust migration must be tested on a populated DB.
- **Subscriber drift.** New event kinds added later require adding to `EventLogKind` and `EventPayload`. Mitigation: TypeScript catches mismatches at compile time. PR review checks include "if you added a new event surface, did you wire a subscriber?"
- **Performance: opportunistic eviction.** 1% sampling on every append is cheap but bursty. Mitigation: profile; if p99 latency spikes during eviction, move eviction to a setTimeout(0) or background tick.
- **Causality chain integrity.** `parentEventId` only works if every subscriber threads the parent ID through correctly. Mitigation: helper function `appendCaused(by: EventLogEntry, ...)` that auto-fills `parentEventId` and `parentSessionId`.

## Validation Notes (2026-05-13)

Re-validated against claudy + browserx via parallel research probes 2026-05-13.

### Claudy findings

- Claudy's "EventLog" is `recordQueueOperation`, which logs only `enqueue/dequeue/remove/popAll` to per-session `.jsonl`. **Nothing else flows through it.**
- Tool calls and approval decisions go to **analytics backends** (Statsig/Datadog/OTel) — not queryable per-session locally.
- `--replay-user-messages` is **not** replay; it's a stdin-echo feature for the CCR bridge.
- Compaction reads transcript messages, **not** the queue-op log.
- The 10-gap list (see Problem section) is the explicit motivation for browserx doing better.
- PR #167 (session memory extraction) had to invent `marble-origami-commit` because no audit chain existed. We avoid that pattern.

### BrowserX-side findings

- `STORE_KEY_PATHS` (`src/storage/StorageAdapter.ts:17-28`) currently lists 10 stores. Adding `event_log` is straightforward.
- IndexedDB `DB_VERSION = 4` (`src/storage/IndexedDBAdapter.ts:24`). v4→v5 follows the existing pattern in v4's migration block.
- `RolloutRecorder` is **too coupled** to `RolloutItem` (conversation history) to host EventLog rows. Decision: separate `EventLogRecorder` class, separate store. Confirmed by audit.
- `execution_records` table (`src/server/scheduler/ServerExecutionStorage.ts`) is for scheduled job runs, tightly typed; not reusable.
- `HookDispatcher.emitObservability` (`src/core/hooks/HookDispatcher.ts:173-189`) **is** the single observation point for all hook firings. Subscribing once captures every hook event. Confirmed.
- Track 01 PR #198 fired hooks at: `SessionStart` (RepublicAgent:179), `SessionEnd` (RepublicAgent:901), `UserPromptSubmit` (RepublicAgent:484), `PermissionRequest` (ApprovalGate:215), `PermissionDenied` (ApprovalGate:379). Phase 2 will add `PreToolUse/PostToolUse/PostToolUseFailure/TaskCreated/TaskCompleted/Stop`.
- All naming clear (`EventLog`, `EventLogEntry`, `EventLogKind`, `EventLogRecorder`, `event_log`, `src/core/eventLog/`).
- No conflicting open PRs touching storage adapters or hooks.

### Decisions resolved

1. **Separate `EventLogRecorder` class**, separate `event_log` store. Don't shoehorn into `RolloutRecorder`.
2. **Subscribe to existing observation points** (HookDispatcher, CommandQueue, ApprovalManager events). Don't instrument every site individually — that's the maintenance trap claudy fell into with scattered analytics calls.
3. **Causality chain** via `parentEventId` + `parentSessionId`. Closes the biggest claudy gap (#7).
4. **Append-never-throws.** Audit trail is best-effort by definition; never crash the agent because logging failed.
5. **Ring-buffer eviction**: 5000 entries OR 30 days per session, whichever comes first. Configurable.
6. **Replay = read API only** for v1. State-machine restoration is a different track entirely.
7. **Three storage backends** match the existing adapter pattern. No new storage abstraction.
8. **ULID for entry IDs** because it's sortable by time (good for indexed range queries) and unique (no coordination needed).

### Open items deliberately deferred

- `/log` slash command (08c-followup)
- Live tail debug overlay (08c-followup)
- JSONL export for offline analysis (08c-followup)
- Compaction reading from EventLog instead of transcript (05b)
- Tool-execution payload subscribers when Track 02 lands more granular hooks (Phase 2)
- Cross-session aggregation queries (08c-followup)

Sources:
- Claudy: `utils/messageQueueManager.ts:28-38` (recordQueueOperation), `utils/sessionStorage.ts` (appendEntry), `cli/main.tsx:988, 1839, 2849; cli/print.ts:4030-4078` (--replay-user-messages), `services/compact/microCompact.ts` (compaction transcript-only).
- BrowserX: `src/storage/StorageAdapter.ts:17-28` (STORE_KEY_PATHS), `src/storage/IndexedDBAdapter.ts:24, 280-314` (DB_VERSION + v4 migration pattern), `src/server/scheduler/ServerExecutionStorage.ts` (SQLite migration pattern), `src/core/hooks/HookDispatcher.ts:173-189` (emitObservability choke point), `src/core/RepublicAgent.ts:179, 484, 901` (hook fire sites), `src/core/approval/ApprovalGate.ts:215, 379` (PermissionRequest/Denied fire sites).
