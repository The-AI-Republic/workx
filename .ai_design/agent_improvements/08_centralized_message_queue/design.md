# Track 08: Centralized Message Queue & Audit

> **Status (2026-05-14):** Implementation-ready, phased. Active PR: none.
>
> This track was originally split into 08a (Signal+Mailbox primitives), 08b
> (CommandQueue), 08c (EventLog), and 08d (MessageBus deferred). Following a
> deeper audit of both claudy and BrowserX (see [Research Synthesis](#research-synthesis)),
> the split rationale collapsed: 08a's primitives turned out to be either redundant
> with what BrowserX already has, or to solve no BrowserX problem at all. With 08a
> gone, the dependency chain that justified separate sub-tracks dissolves.
>
> What remains is the two genuinely missing capabilities — priority-ordered queue
> with sub-agent isolation, and a persistent audit log — packaged as two phases
> of a single track.
>
> **Dropped from the earlier 08a proposal** (rationale in [Dropped from Earlier Proposals](#dropped-from-earlier-proposals)):
> - **Signal** — HookRegistry + Svelte stores already cover every non-CLI use case in claudy.
> - **Mailbox** — `TurnState.pendingInput` + `Session.addPendingInput()` is BrowserX's in-process mailbox; claudy itself never calls `Mailbox.receive()` for ApprovalManager.
> - **ApprovalManager refactor** — BrowserX's `ApprovalManager` is more complete than claudy's (timeout, policy, ApprovalGate hooks, risk enhancers); the resolver pattern is ~30 lines and works fine.

---

## Problem

BrowserX has a working request/event/approval system, but three concrete gaps remain after the deep audit (2026-05-14):

### Gap 1 — `submissionQueue` is plain FIFO with no priorities, no filter, no batching

`RepublicAgentEngine.submissionQueue: Submission[]` (`src/core/engine/RepublicAgentEngine.ts:27`) is a plain array drained via `shift()`. Concretely this means:

- **No priority.** A user-typed `'now'` interrupt waits behind queued background-task results.
- **No `agentId` filter.** Sub-agents (PR #191 background-mode work) and the parent share queue infrastructure. PR #191 introduced `pendingNotifications: string[]` (`RepublicAgentEngine.ts:44`) as a parallel buffer because there's no good way to mark which agent a submission targets.
- **No batching.** Multiple consecutive user prompts each become a separate turn even when they should coalesce into one.
- **No structured observability of queue state.** No event for "submission queued", no way to subscribe to depth or backpressure signals.

Claudy solves all four with `messageQueueManager.ts` plus an `agentId`-aware `dequeue(filter)`. The shape ports cleanly.

### Gap 2 — No persistent audit trail

`RolloutRecorder` (`src/storage/rollout/`) persists conversation history. Everything else is ephemeral:

- Approvals live in `ApprovalManager.approvalHistory: Map<string, ApprovalResponse>` — memory only, cleared on reload.
- Hook firings emit observability events to live UI consumers only — not persisted.
- Queue operations (enqueue / dequeue / remove) are not logged anywhere.
- Tool start/end timing only appears in the conversation rollout indirectly via `tool_use`/`tool_result` items.

Concrete questions today require reading source code to answer:
- "Why was that command auto-approved?" → grep `ApprovalManager.evaluatePolicy`.
- "Did the `PreToolUse` hook fire for that DOM write?" → no way to tell after the session ends.
- "When did the user cancel that command?" → not logged.

### Gap 3 — Dead code

`src/core/QueueProcessor.ts` (343 LOC) defines `PriorityQueue<T>`, `SubmissionQueue extends PriorityQueue<Submission>`, `EventQueue extends PriorityQueue<Event>`, and a `QueueProcessor` orchestrator. **Confirmed never instantiated** in production code (2026-05-13 audit, re-verified 2026-05-14). Only its own test file references it.

Carrying both the dead `PriorityQueue<T>` and an upcoming `CommandQueue<T>` invites future drift. The `QueueProcessor.ts` priority constants overlap with what Phase 1 introduces, but with different semantics, which is exactly the kind of confusion a clean delete prevents.

---

## Research Synthesis

This scope is the result of two independent deep audits run 2026-05-14: one mapping claudy's full message/queue/event/approval/audit pipeline (`/home/rich/dev/study/claudy/src`), one mapping BrowserX's equivalent infrastructure. The matrix below is the gap analysis.

| Capability | Claudy has | BrowserX has | Real gap? |
|---|---|---|---|
| Input buffer while busy | `Mailbox` (1 use site: `useMailboxBridge`) | `TurnState.pendingInput` + `Session.addPendingInput()` | ✅ Already covered |
| Background sub-agent result injection | enqueue with `'later'` | `pendingNotifications` + `enqueueSyntheticUserTurn()` (unified path) | ✅ Already covered |
| Pub/sub primitive | `Signal` (mostly React adapters for `useSyncExternalStore`) | HookRegistry + Svelte stores | ✅ Already covered (different runtime; Svelte makes Signal redundant) |
| Inter-process IPC (swarm) | `teammateMailbox` (disk JSON, file locks) | N/A — single process | ✅ Not applicable |
| Approval request/response with timeout | tool-result return + handler-specific logic | `ApprovalManager` (timeout, policy, ApprovalGate hooks, risk enhancers) | ✅ Already covered; BrowserX's is more complete than claudy's |
| Lifecycle hooks | hooks system | `HookRegistry`/`HookDispatcher` w/ 13 events (PR #198) | ✅ Already covered |
| Cross-platform message routing | n/a (CLI only) | `ChannelManager` + `ServiceRegistry` (PR #174) | ✅ BrowserX-specific, complete |
| **Priority-ordered queue** (`'now'/'next'/'later'`) | `messageQueueManager` | `submissionQueue: Submission[]` plain FIFO | ❌ **Real gap → Phase 1** |
| **`agentId` filter on queue** for sub-agent isolation | yes, every `dequeue()` | none; PR #191 uses parallel `pendingNotifications` array as a workaround | ❌ **Real gap → Phase 1** |
| **Consecutive-prompt batching** | yes — same `workload` coalesces | no — each prompt = a separate turn | ❌ **Real gap → Phase 1** (optional) |
| **Persistent audit/event log** | `recordQueueOperation` → JSONL (anemic, only queue ops) | console only; rollout = conversation, not audit | ❌ **Real gap → Phase 2** (we get to build what claudy *should* have) |
| **Dead `QueueProcessor.ts`** | n/a | 343 LOC, never instantiated | 🗑️ Cleanup → Phase 1 |

### What the audit reframed

Three findings flipped earlier assumptions:

1. **`Mailbox.receive()` is never called in claudy.** The class implements the await-for-message pattern, but the only consumer is `useMailboxBridge` which calls `poll()`. The "direct handoff" pattern that 08a's design doc treated as load-bearing is dead-on-arrival in claudy itself. Mapping it onto BrowserX's `ApprovalManager` would have been the first real use.

2. **BrowserX's `ApprovalManager` is more complete than claudy's approval flow.** Claudy's interactive approvals route through the tool-result return path; only swarm-worker handlers use a Mailbox-shaped wait. BrowserX has: timeout (600s default), policy evaluation, `ApprovalGate` hook integration (PR #198), risk enhancers, and an `approvalHistory` map. The 547-line file is mostly policy/risk/events — the resolver pattern itself is ~30 lines and uncomplicated.

3. **`Signal` in claudy is mostly a `useSyncExternalStore` adapter.** Of the 20 `createSignal()` instances, 9 are CLI-specific (chokidar file watchers, tmux session switches, Slack cache, etc. — none apply to BrowserX). The remaining ~10 are bridge state into React. Svelte's `writable()` covers both the state and the subscribe surface natively; the adapter is unnecessary.

The unified, priority-ordered command queue is the load-bearing claudy pattern. Everything else 08a proposed was either already present in BrowserX in another form or a CLI/React-shaped concern that doesn't transfer.

---

## Phase 1: CommandQueue

### Goal

Replace `RepublicAgentEngine.submissionQueue: Submission[]` (and the parallel `pendingNotifications: string[]`) with a single `CommandQueue<Submission>` that is priority-ordered, filterable, and observable.

### Design

#### Envelope

```typescript
// src/core/queue/types.ts
export type QueuePriority = 'now' | 'next' | 'later';

export interface QueuedCommand<T> {
  readonly uuid: string;
  readonly payload: T;
  readonly priority: QueuePriority;
  readonly engineId?: string;   // undefined = main agent / unfiltered
  readonly workload?: string;   // for batching consecutive prompts in same workload
  readonly enqueuedAt: number;
}

export interface EnqueueOptions {
  priority?: QueuePriority;
  engineId?: string;
  workload?: string;
}

export interface DequeueFilter<T> {
  (cmd: QueuedCommand<T>): boolean;
}
```

#### API

```typescript
// src/core/queue/CommandQueue.ts
export class CommandQueue<T> {
  enqueue(payload: T, opts?: EnqueueOptions): string;          // returns uuid
  dequeue(filter?: DequeueFilter<T>): QueuedCommand<T> | undefined;
  dequeueBatch(filter: DequeueFilter<T>, maxBatch?: number): QueuedCommand<T>[];
  peek(filter?: DequeueFilter<T>): QueuedCommand<T> | undefined;
  remove(uuid: string): boolean;
  popAll(filter?: DequeueFilter<T>): QueuedCommand<T>[];
  clear(): void;
  get length(): number;
  /** Subscribe to queue mutations; returns unsubscribe. */
  subscribe(listener: (snapshot: ReadonlyArray<QueuedCommand<T>>) => void): () => void;
}
```

No new pub/sub primitive needed. `subscribe` is a plain `Set<Listener>` internally (~10 LOC), not an exported abstraction. Subscribers receive a frozen snapshot per emit.

#### Priority semantics (matches claudy's `messageQueueManager.ts:151-155`)

- **`'now'`** — pulled before everything else. **Not preemptive**: does not abort an in-flight turn. The drain loop picks it on the next iteration. (BrowserX's parallel background sub-agents make preemption messy; we adopt claudy's "urgent but cooperative" semantic.)
- **`'next'`** — drained mid-turn before the next API round-trip. Default for user input.
- **`'later'`** — lowest. Drained as a new turn after the current one ends. Default for sub-agent notifications and scheduler ticks.

#### Default priorities by submission source

| Source (current code location) | Priority |
|---|---|
| User text submission (`RepublicAgent.submitOperation` → `UserInput` op) | `'next'` |
| `Interrupt`, `Shutdown` ops | `'now'` |
| `ExecApproval` op | `'now'` |
| Sub-agent background result (`enqueueSyntheticUserTurn` → enqueue here) | `'later'` |
| Scheduler tick (`src/core/scheduler/`) | `'later'` |
| `ServiceRequest` ops | `'next'` |

#### Sub-agent isolation

Each `RepublicAgentEngine` has an `engineId` (`RepublicAgentEngine.ts:19`). Sub-agent engines inherit `parentEngineId` (`RepublicAgentEngine.ts:357`). When a sub-agent's `processSubmissionQueue` drains, it filters:

```typescript
dequeue((cmd) => cmd.engineId === this.engineId);
```

The main agent's drain uses:

```typescript
dequeue((cmd) => cmd.engineId === undefined || cmd.engineId === this.engineId);
```

This replaces `pendingNotifications`. When `enqueueSyntheticUserTurn(text)` fires from a background sub-agent, it now enqueues into the **parent's** `CommandQueue` with `engineId: parentEngineId` and `priority: 'later'`. The parent's drain loop picks it up naturally on the next idle pass. `drainPendingNotificationsInto(input)` (`RepublicAgentEngine.ts:318-325`) and the `pendingNotifications: string[]` field are deleted.

#### Batching (optional, can defer to follow-up)

Consecutive `'prompt'`-mode commands from the same `workload` should coalesce into a single turn:

```typescript
const batch = queue.dequeueBatch(
  (cmd) => cmd.workload === workload && isPromptMode(cmd.payload),
  10,
);
const mergedText = batch.map(c => extractText(c.payload)).join('\n\n');
```

For v1, batching can be deferred until a real consumer demands it; the API supports it, but the drain loop in `processSubmissionQueue` can ignore `dequeueBatch` initially.

### Migration plan

1. Add `src/core/queue/types.ts` and `src/core/queue/CommandQueue.ts`.
2. Modify `RepublicAgentEngine`:
   - Replace `submissionQueue: Submission[]` with `submissionQueue: CommandQueue<Submission>`.
   - Update `submitOperation` (`RepublicAgentEngine.ts:116-126`) to call `enqueue()` with appropriate priority based on op type.
   - Update `processSubmissionQueue` (`RepublicAgentEngine.ts:378-403`) to call `dequeue(filter)`.
   - Delete `pendingNotifications: string[]` and `drainPendingNotificationsInto`.
   - Modify `enqueueSyntheticUserTurn` (`RepublicAgentEngine.ts:299-312`) to enqueue into the parent's `CommandQueue` rather than push to a string array.
3. Delete `src/core/QueueProcessor.ts` and `src/core/__tests__/QueueProcessor.test.ts`.
4. Tests in `src/core/queue/__tests__/`:
   - Priority ordering (now > next > later, FIFO within tier).
   - `engineId` filter behavior (sub-agent vs main).
   - `remove(uuid)` and `popAll(filter)`.
   - `subscribe` notify on every mutation.
   - `dequeueBatch` returns up to N matching items.

### Naming collision audit (verify before merge)

Run 2026-05-14 audit:

```bash
grep -rn "CommandQueue\b" src/ --include="*.ts" --include="*.svelte"
```

Verify no class/type named `CommandQueue` exists in `src/`. If a collision exists, fall back to `MessageQueue<T>` or `SubmissionQueueV2`.

### Estimated size

- **New:** ~300 LOC (CommandQueue + types + tests + engine wiring).
- **Deleted:** ~350 LOC (`QueueProcessor.ts` + `pendingNotifications` plumbing).
- **Net:** roughly LOC-neutral, plus first-class priority/filter capability.

---

## Phase 2: EventLog

### Goal

Persistent, bounded, queryable audit log of system events — separate from conversation history (`RolloutRecorder`).

This is the only phase that adds new storage. Conversation rollout stays unchanged.

### What gets logged

```typescript
// src/storage/eventLog/types.ts
export type EventKind =
  | 'queue.enqueue' | 'queue.dequeue' | 'queue.remove'
  | 'hook.fired' | 'hook.blocked'
  | 'approval.requested' | 'approval.granted' | 'approval.denied' | 'approval.auto-approved'
  | 'tool.started' | 'tool.completed' | 'tool.failed'
  | 'turn.started' | 'turn.completed'
  | 'subagent.spawned' | 'subagent.completed' | 'subagent.failed';

export interface EventLogEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly engineId?: string;
  readonly timestamp: number;
  readonly kind: EventKind;
  readonly data: Record<string, unknown>;   // kind-specific payload, JSON-serializable
}

export interface EventFilter {
  sessionId?: string;
  engineId?: string;
  kinds?: EventKind[];
  since?: number;       // ms epoch
  until?: number;
  limit?: number;       // default 1000, max 10000
}
```

`data` is intentionally `Record<string, unknown>` rather than a discriminated union — per-kind shapes are documented but not enforced at the type level, so adding a new kind doesn't require touching the storage schema.

### Public API

```typescript
// src/storage/eventLog/EventLog.ts
export class EventLog {
  append(entry: Omit<EventLogEntry, 'id' | 'timestamp'>): Promise<void>;
  getEvents(filter: EventFilter): Promise<EventLogEntry[]>;
  streamEvents(filter: EventFilter): AsyncIterableIterator<EventLogEntry>;
  clearForSession(sessionId: string): Promise<void>;
  /** Get rough byte count / entry count for diagnostics. */
  stats(sessionId: string): Promise<{ entries: number; oldestTs?: number; newestTs?: number }>;
}
```

### Storage

New `event_log` store/table in each platform adapter. Three adapters mirror the existing rollout storage:

**Extension (IndexedDB)** — bump version to v5, add object store:

```typescript
// src/storage/IndexedDBAdapter.ts (extend existing upgrade path)
db.createObjectStore('event_log', { keyPath: 'id' });
store.createIndex('by_session_kind_ts', ['sessionId', 'kind', 'timestamp']);
store.createIndex('by_session_ts', ['sessionId', 'timestamp']);
```

**Desktop / Tauri (SQLite)** — new table + Rust migration:

```sql
CREATE TABLE event_log (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  engine_id   TEXT,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  data        TEXT NOT NULL   -- JSON
);
CREATE INDEX idx_event_log_session_kind_ts ON event_log(session_id, kind, ts DESC);
CREATE INDEX idx_event_log_session_ts ON event_log(session_id, ts DESC);
```

**Node (server)** — same schema as Tauri via better-sqlite3.

### Eviction policy

Bounded ring buffer per session, capped at the minimum of:

- **5,000 entries**, or
- **30 days** old entries

Eviction runs lazily:
- On `append()` with a 10% sample rate (don't tax every write).
- On `getEvents()` if the session's count exceeds the budget by > 10%.
- On `clearForSession()` (explicit).

Configuration exposed via `AgentConfig` (defaults baked, override-able):

```typescript
{
  eventLog: {
    maxEntriesPerSession: 5000,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    enabled: true,
  }
}
```

### Subscribers — where `append` is called

| Source | Hook point | Kinds emitted |
|---|---|---|
| `CommandQueue` (Phase 1) | `subscribe()` listener wired in `RepublicAgentEngine.initialize()` | `queue.enqueue`, `queue.dequeue`, `queue.remove` |
| `HookDispatcher` (Track 01) | `emitObservability` choke point (`src/core/hooks/HookDispatcher.ts`) | `hook.fired`, `hook.blocked` |
| `ApprovalManager` | extend existing event emits (Requested / Granted / Denied / AutoApproved) | `approval.*` |
| `TurnManager` | add log calls at turn start/end and tool start/end | `turn.*`, `tool.*` |
| `SubAgentRunner` | log spawn (`run()` line 165-171), completion (`enqueueSyntheticUserTurn` site), failure | `subagent.*` |

The wiring uses a single `EventLogRecorder` class (`src/storage/eventLog/EventLogRecorder.ts`) that owns the subscriptions. It's separate from `RolloutRecorder` because the semantics differ: rollout is mutable conversation history (can be edited / compacted); event log is immutable append-only audit.

### Read API usage examples

```typescript
// "Why was that command auto-approved?"
const events = await eventLog.getEvents({
  sessionId, kinds: ['approval.auto-approved'], since: turnStart,
});

// "Did the PreToolUse hook fire?"
const fired = await eventLog.getEvents({
  sessionId, kinds: ['hook.fired'], limit: 50,
});

// Live stream for a debugging UI
for await (const entry of eventLog.streamEvents({ sessionId })) {
  renderToDevPanel(entry);
}
```

A small DevTools panel (separate follow-up) can consume `streamEvents` to render a live event timeline; not required for v1.

### Estimated size

~600 LOC, distributed:

- `EventLog.ts` façade + types: ~80 LOC
- IndexedDB adapter: ~120 LOC + IDB migration
- SQLite adapter (Tauri/Node shared): ~150 LOC + Rust migration
- `EventLogRecorder.ts` wiring: ~150 LOC
- Tests: ~100 LOC

---

## Deferred: MessageBus

Originally scoped as 08d for generic topic-based pub/sub. The deferred status is unchanged after the 2026-05-14 audit. Same reasoning:

1. **`ChannelManager`** (`src/core/channels/ChannelManager.ts`, PR #174) already routes submissions between UI channels and the agent and dispatches events back.
2. **`HookDispatcher`** (PR #198) already covers lifecycle observability with structured event kinds.
3. **`ServiceRegistry`** (`src/core/channels/ServiceRegistry.ts`) already handles request/response RPC.
4. **`CommandQueue.subscribe`** (this track, Phase 1) handles queue-state observation.
5. **`EventLog.streamEvents`** (this track, Phase 2) handles audit-event observation.

Adding a generic `MessageBus` on top would create a fourth routing layer with overlapping responsibilities. Reassess only if a concrete consumer emerges that none of the above can serve.

---

## Dropped from Earlier Proposals

The previous split (08a/b/c/d) carried three proposals that the deep audit eliminated. Each is recorded here so future contributors don't re-propose them without context.

### Signal (`createSignal<T>()`)

**Proposed in 08a:** port claudy's `Signal<T>` as a 25-line pub/sub primitive with per-listener try/catch.

**Why dropped:**
- Of 20 `Signal` instances in claudy (audit 2026-05-14), 9 are CLI-specific (chokidar file watchers, tmux session switches, Slack channel cache, GrowthBook feature flags, file index builds) — none apply to a browser extension.
- The remaining ~10 are React-adapter shapes for `useSyncExternalStore`. Svelte's `writable()` covers both the state and the subscribe surface natively; the adapter is unnecessary in this codebase.
- The one consumer that *would* exist in BrowserX (`CommandQueue.subscribe`, `EventLog` subscribers) is a 10-line internal `Set<Listener>` inside each consumer class. No exported primitive needed.
- `HookRegistry` (Track 01, PR #198) already covers lifecycle events with stronger guarantees (matchers, aggregation, observability).

### Mailbox (`new Mailbox<T>()`)

**Proposed in 08a:** port claudy's `Mailbox<T>` class with `send` / `receive(predicate, {timeoutMs, signal})` for request/response handshakes, and use it to refactor `ApprovalManager`.

**Why dropped:**
- Claudy uses `Mailbox` in exactly one place (`useMailboxBridge` via `context/mailbox.tsx`) and only calls `poll()`, never `receive()`. The await-for-message pattern that 08a treated as load-bearing is dead-on-arrival in claudy itself.
- The one BrowserX use case `Mailbox` would solve (buffering user input while the agent is busy) is **already solved** by `TurnState.pendingInput` + `Session.addPendingInput()` / `Session.getPendingInput()` (`src/core/session/state/TurnState.ts:16-76`, `src/core/Session.ts:489-504`). Same FIFO drain on idle, but scoped per-turn rather than per-app.
- The other proposed use case (refactoring `ApprovalManager`) was dropped — see below.
- The separate disk-based `teammateMailbox.ts` in claudy is for inter-process IPC between separate agent processes in the swarm feature; BrowserX is single-process, so this concept does not transfer.

### ApprovalManager refactor

**Proposed in 08a:** rewrite `ApprovalManager.requestApproval` to use a `Mailbox`, replacing the `Map<id, PendingApproval>` resolver pattern.

**Why dropped:**
- The deep audit revealed `ApprovalManager`'s 547 lines are mostly **policy evaluation**, **risk assessment**, **event emissions**, and **history tracking** — not the resolver dance. The resolver pattern itself is ~30 lines (`src/core/ApprovalManager.ts:101-185`) and works correctly.
- BrowserX's `ApprovalManager` is **more complete than claudy's approval flow**: claudy returns interactive approvals via tool-result return paths and only uses Mailbox for swarm-worker scenarios. BrowserX has timeout (600s default), policy evaluation, `ApprovalGate` hook integration (PR #198), risk enhancers (DOM, semantic, domain sensitivity), and persistent approval history map.
- A rewrite would touch a load-bearing 547-line file for stylistic gain only, with non-trivial regression risk around the auto-approve-on-timeout semantics and four event emission sites.
- If a future need emerges (e.g., cancel-on-session-end via `AbortController`), it can be added in-place without a primitive.

---

## Dependencies

```
01_hook_event_system_DONE ──> 08 Phase 2 EventLog (subscribes to HookDispatcher.emitObservability)
                              08 Phase 2 EventLog (logs PermissionRequest/Denied from ApprovalGate)

03_command_skill_system_DONE ──> 08 Phase 2 EventLog (commands may emit log entries on execution; optional)

04_typed_task_families ──> 08 Phase 2 EventLog (Task lifecycle events; tracks well together but not blocking)

PR #191 (background sub-agents) ──> 08 Phase 1 CommandQueue
                                    (replaces pendingNotifications workaround)

08 Phase 1 CommandQueue ──> 08 Phase 2 EventLog (queue.* event kinds)
                            ──> Deferred 08d MessageBus reassessment
```

Phase 1 and Phase 2 are independent and can ship in either order; Phase 2 emits richer events if Phase 1 has landed.

---

## Risks

### Phase 1

- **`enqueueSyntheticUserTurn` semantic change.** Today's `pendingNotifications` always appends as **text items to the next turn's input**. After Phase 1, sub-agent notifications enqueue into the parent's `CommandQueue` with `priority: 'later'`. The drain ordering changes from "always prepended" to "later than any pending user input". This is the correct behavior (user input goes first), but it's a behavior shift. **Mitigation:** integration test that drives a foreground prompt + background sub-agent completion concurrently and asserts the foreground prompt is processed first.
- **Sub-agent filter correctness.** A bug in the `engineId` filter could cross-talk commands between agents. **Mitigation:** test matrix covering main agent, sub-agent, and grandchild-agent dequeue patterns; assert no command meant for one engine surfaces in another's drain.
- **`'now'` priority is non-preemptive.** A user pressing an interrupt button while a 30s tool call runs will not abort that tool — it will queue and execute when the tool returns. This is consistent with claudy and avoids adding tool-cancellation plumbing to this track. **Mitigation:** document the semantic clearly in the queue type. Actual preemption is out of scope; if needed, it's a future track.

### Phase 2

- **IndexedDB version bump.** The extension's IDB is currently v4; this track bumps it to v5. A failed migration on a populated DB would surface as session-load failure. **Mitigation:** migration logic adds the `event_log` store only (no existing-store changes); test migration from each prior version (v1 → v5 chain).
- **Storage growth.** 5000 entries × ~300 bytes per entry ≈ 1.5 MB per active session. Over a long-running session with chatty hook firings, this could grow. **Mitigation:** lazy eviction + per-session bound. Add a `stats(sessionId)` API and surface in the rollout UI for visibility.
- **PII / secrets in `data` payloads.** Tool parameters and approval contexts may include user-typed secrets. **Mitigation:** define a redaction pass for tool parameters before logging; mirror the existing redaction in `RolloutRecorder`.
- **Tauri migration ordering.** The Rust SQLite migration needs to run on first launch of a build that includes this track. Migration framework is already in place for rollout; reuse the same versioning scheme.

---

## Validation Notes (2026-05-14)

Two parallel deep-audit probes informed this scope. Key concrete findings:

### Claudy mapping

- **`messageQueueManager.ts`** (`/home/rich/dev/study/claudy/src/utils/messageQueueManager.ts:53-193`): module-level `commandQueue: QueuedCommand[]` array. Priorities at line 151-155. `dequeue(filter)` at 167-193. `agentId` filter at line 1924 of `print.ts` (the main drain loop). `recordQueueOperation()` audit calls at lines 131, 191, 290, 472.
- **`QueuedCommand` schema** (`/home/rich/dev/study/claudy/src/types/textInputTypes.ts:299-358`): fields include `priority`, `agentId`, `workload`, `uuid`, `mode`, `isMeta`, `origin`.
- **Mailbox** (`utils/mailbox.ts`): 75 lines, used in 1 React Context, only via `poll()`. `receive()` has 0 callers.
- **TeammateMailbox** (`utils/teammateMailbox.ts`): ~1100 lines, disk-based IPC, completely separate from in-memory Mailbox. Single-process BrowserX does not need this.
- **Signal** (`utils/signal.ts`): 43 lines, 20 instantiations, 9 CLI-specific, ~10 React-adapter.
- **Audit log**: `recordQueueOperation` writes to the same per-session JSONL as conversation history — mixed types in one file. No separate audit store. BrowserX's Phase 2 is cleaner.

### BrowserX mapping

- **`RepublicAgentEngine.submissionQueue: Submission[]`** at `src/core/engine/RepublicAgentEngine.ts:27`. `processSubmissionQueue()` at line 378-403 (synchronous drain via `shift()`).
- **`pendingNotifications: string[]`** at line 44, drained by `drainPendingNotificationsInto(input)` at line 318-325. Wired into `enqueueSyntheticUserTurn` at line 299-312.
- **`TurnState.pendingInput: InputItem[]`** at `src/core/session/state/TurnState.ts:16`. Producer/consumer: `Session.addPendingInput` (line 504), `Session.getPendingInput` (line 489). Drained at turn boundaries by `TaskRunner.buildNormalTurnInput`.
- **`ApprovalManager`** at `src/core/ApprovalManager.ts` (547 lines). Resolver Map at line 80, `requestApproval` at line 101, `handleDecision` at 190, `cancelRequest` at 277. Default timeout 600_000 at line 110.
- **`ApprovalGate`** at `src/core/approval/ApprovalGate.ts:215, 379` fires `PermissionRequest` / `PermissionDenied` hooks (Track 01, PR #198).
- **`HookDispatcher`** at `src/core/hooks/HookDispatcher.ts:76-154`. 13 hook events defined. `emitObservability` is the single observability choke point — ideal subscriber site for Phase 2.
- **`QueueProcessor.ts`** at `src/core/QueueProcessor.ts` (343 lines): dead. Re-verified 2026-05-14 — only references are its own colocated tests and a single grep-only mention in another file's comment.
- **`AgentRegistry`** at `src/core/registry/AgentRegistry.ts:46-82` — session isolation already in place; each `RepublicAgent` instance has its own engine and queue. Sub-agent engineId filtering is the missing piece, not session-level isolation.
- **`ChannelManager`** + **`ServiceRegistry`** (PR #174) — cross-platform routing complete. No gap there.

### Decisions resolved

1. **Drop Signal entirely.** Svelte stores + HookRegistry + `Set<Listener>`-inside-class cover every use case BrowserX would actually have.
2. **Drop Mailbox entirely.** `TurnState.pendingInput` is the existing equivalent; claudy doesn't use `Mailbox.receive()` either.
3. **Drop ApprovalManager refactor.** Current implementation is correct and more complete than claudy's; the resolver pattern is small and works.
4. **Keep CommandQueue.** Real gap. Replaces `submissionQueue` + `pendingNotifications`.
5. **Keep EventLog.** Real gap. No existing queryable audit trail.
6. **Keep QueueProcessor.ts deletion.** Cleanup ride-along for Phase 1.
7. **MessageBus stays deferred.** No new consumer pressure surfaced.

### Sources

- Claudy: `utils/messageQueueManager.ts` (480 LOC), `utils/mailbox.ts` (75 LOC), `utils/teammateMailbox.ts` (~1100 LOC), `utils/signal.ts` (43 LOC), `types/textInputTypes.ts:299-358`, `cli/print.ts:1920-2100`, `utils/QueryGuard.ts:29-122`.
- BrowserX: `src/core/engine/RepublicAgentEngine.ts:27, 44, 116, 299, 318, 378`, `src/core/session/state/TurnState.ts:16-76`, `src/core/Session.ts:489-504`, `src/core/ApprovalManager.ts:80-321`, `src/core/approval/ApprovalGate.ts:215, 379`, `src/core/hooks/HookDispatcher.ts:76-154`, `src/core/QueueProcessor.ts` (343 LOC dead), `src/core/registry/AgentRegistry.ts:46-82`, `src/core/channels/ChannelManager.ts:59-67`.
