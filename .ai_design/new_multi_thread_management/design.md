# Multi-Thread Session Management Redesign

Status: **DRAFT v3 — implementation-ready candidate (after review rounds 1 & 2, 2026-07-14)**
Documents:
- This file — architecture & behavior
- [implementation-spec.md](./implementation-spec.md) — code-level contracts, type definitions,
  state mappings, call-site inventories (Round-2 addition; implementers start here after
  reading this doc)
- [tasks.md](./tasks.md) — phased task breakdown
- [review-log.md](./review-log.md) — both review rounds, findings → resolutions

Related:
- PR #298 (left-panel chat history) — **prerequisite**, merge first
- PR #326 (thread-creation latency) — closed, superseded; absorption map in §9
- `.ai_design/simplify_session/design.md` (unified sessionId) — **hard prerequisite**
  (ThreadIndex keys, runtime-state events, background indicators). Gated in Phase 0.

## 1. Goals & scope

1. **Parallel multi-session** — multiple independent agent sessions run in parallel; sessions
   never interfere with each other.
2. **Well-managed instances** — clear ownership, state in exactly one place, efficient
   initialization (no duplicated work).
3. **Codex/ChatGPT-work-style thread model** — no "close thread" concept, no thread-tab
   ceremony. The left panel lists recent chat sessions (on PR #298); the user pins, renames,
   searches, and clicks; live parallelism is an implementation detail.
4. **Systematically absorb PR #326** — the latency fix is resolved at the root cause.

Honest bound on goal 3: "no user-visible limit" applies to *sessions* (unlimited, durable).
Concurrently **running** agents are bounded by `hardMax` (default 10). Because new chats are
created **without** a live agent (two-stage open, §3.6), starting a new chat never hits this
bound; only *continuing* a session when ≥ hardMax agents are RUNNING returns a typed `busy`
that auto-retries when capacity frees (§4.6).

**Platform scope** (review C3 decision, corrected in round 1):
- **Phase 2 (construction unification: `AgentAssembler` + `AuthContext`) applies to all
  platforms** — the server's init-then-refresh double-work (D1) is fixed there too.
- **Phase 3+ (lifecycle, ThreadIndex, LRU, left panel) is CLIENT-ONLY** (extension +
  desktop). Server mode (`src/server/`) is today a **single-tenant headless agent** — one
  user per dedicated instance (the `userId` in `src/server/connection/auth.ts` authenticates
  that one user; it does not multiplex tenants). The lifecycle layer is excluded there
  because (a) there is no thread-list UI — sessions are channel-driven (Slack/Telegram) —
  and (b) client-scoping the first delivery shrinks blast radius. The server can adopt it
  later. Caveat: if multi-tenancy ever lands, LRU/config-sweep/ThreadIndex must be
  tenant-scoped at that point.

Decisions taken with the team:

| Decision | Choice |
|---|---|
| Capacity model | Transparent LRU suspend/hydrate; sessions unlimited; running agents bounded by `hardMax`; new chats never blocked (two-stage open) |
| PR #298 | Merge first; this design builds on top |
| PR #326 | Closed unmerged; findings absorbed (§9); an expedited create-path patch closes the interim regression window (§9 note) |
| Tabs vs threads | Decoupled — browser tabs are a leased session *resource* |
| Server mode | Single-tenant headless today; Phase 2 yes; Phase 3+ lifecycle out of scope for first delivery |

## 2. Current Architecture (as-is)

```
AgentRegistry  (Map<sessionId, AgentSession>, hard cap 5, throws at limit)
   └── AgentSession        1:1  lifecycle state machine + tab binding
         └── RepublicAgent 1:1  init/refresh orchestration, own ModelClientFactory
               └── Session 1:1  conversation, rollout, memory, tasks (3,231 lines)
```

- Every session builds a full fresh object graph inline in `AgentRegistry.createSession()`
  (`src/core/registry/AgentRegistry.ts:130-357`).
- **Two independently maintained construction paths**: extension inline
  (`AgentRegistry.ts:172-259`); server `agentFactory` closure
  (`ServerAgentBootstrap.ts:339-490`).
- Sub-agents / shadow agents share the parent's `ModelClientFactory` **by reference** via
  `createChildEngine()` (`RepublicAgentEngine.ts:414-433`) — the one place auth inheritance
  works by construction.
- The UI (`Main.svelte`) models threads as explicit tabs; chat history is a separate resume
  flow. **The live chat send path bypasses `AgentSession.submit()` entirely** — it goes
  `client.submitOp` → `ChannelManager` → `service-worker.ts:665-679` →
  `agent.submitOperation()` directly (see implementation-spec §3; this matters for every
  guard this design adds).

### 2.1 Defect inventory

| # | Defect | Evidence |
|---|--------|----------|
| D1 | Auth is a bolt-on: `ModelClientFactory.authManager` defaults `null` (`ModelClientFactory.ts:70`); `initialize()` builds the first model client (`RepublicAgent.ts:208`) before auth can be wired. Three compensation patterns: (a) server re-inits **twice per session** (`ServerAgentBootstrap.ts:348-351`); (b) generic `session.create` does the same double work (`session-services.ts:307`); (c) extension boot sets auth without refreshing (`service-worker.ts:536-545`) — post-boot `session.create` sessions get auth only when a later sweep runs. | entry-points exploration |
| D2 | Three near-duplicate "rebuild" paths: `initialize()` tail, `refreshModelClient()` (`RepublicAgent.ts:590-628`), `hotSwapModelClient()` (`:635-669`). **Round-2 correction**: both refresh paths DO rebuild the memory service (`:611`, `:653`); the real divergence is that `refreshModelClient` builds a **new** `TurnContext` (dropping approval/sandbox policy to defaults, `TurnContext.ts:93-94`) while `hotSwap` mutates in place. | lifecycle exploration, corrected round 2 |
| D3 | Model-client/prompt state is mutated by **uncoordinated mechanisms**: (a) per-agent self-subscription acting on `model`/`tools`/`provider` sections (`RepublicAgent.ts:316-329`); (b) direct sweeps bypassing config events — `auth-services.ts:120-129`, `agent-services.ts:172-190`, and the server's sequential `hotSwapModelClient` sweep (`ServerAgentBootstrap.ts:745-757`; `AgentConfig.reload()` emits only `policy` events, which (a) ignores). Overlap: direct config writes emitting `model`/`provider` while a sweep runs. | corrected round 1 |
| D4 | Listener leak: `config-changed` subscribed in constructor, never removed in `cleanupOnce()` (`RepublicAgent.ts:1411-1443`). | verified both rounds |
| D5 | Rebuild paths don't defer on running work, and the deferral primitive undercounts: `getRunningTasks()` reads only `activeTurn` tasks (`Session.ts:3130-3136`), not the disjoint `Session.activeTasks` background map (`Session.ts:143`; union proof at `:2091-2114`). | verified both rounds |
| D6 | First-agent-wins global prompt state: `configurePromptComposer()` set-once module singleton (`PromptLoader.ts:36-85`). | lifecycle exploration |
| D7 | Two "resume" implementations; the real one (`session.resume` RPC) is **single-primary** — it terminates the live primary before resuming (`session-services.ts:151-155`); `session.rewind` same (`:252`). `AgentRegistry.resumeSession()` (`AgentRegistry.ts:600-643`) doesn't restore conversation at all. | + fact-check round 1 |
| D8 | `agent.configUpdate`: extension destroys **all** sessions, recreates one (`service-worker.ts:782-822`); server hot-swaps in place. | entry-points exploration |
| D9 | `tabId` triplicated: `AgentSession._metadata`, `Session` state (`Session.ts:1074-1088`), `TabLeaseStore`. | registry exploration |
| D10 | Four hand-rolled auth sweeps with different completeness (`service-worker.ts:536-545, 800-846`, `agent-services.ts:181-191`, `auth-services.ts:127`). | entry-points exploration |
| D11 | Redundant IO per init: 2 credential reads (`RepublicAgent.ts:172` + `ModelClientFactory.ts:583`); memory service rebuilt on every refresh. | lifecycle exploration |
| D12 | `Session.ts` god object (3,231 lines). | registry exploration |
| D13 | Hard cap: `createSession` **throws** at the limit (`AgentRegistry.ts:133-136`). | registry exploration |
| D14 | UI round-trip waste: serial `session.create` → `session.getActiveCount`; double `updateSessionLimits` on cold start (`Main.svelte:1237`, `:1299`). Also: `restoreAllThreadHistories` (`Main.svelte:1248-1260`) requires every session live to fetch history via `session.getState` — the anti-pattern this design replaces. | + round 2 |
| **D15** | **(new, round 2)** Approval requests from a non-viewed session are invisible: approval events are thread-scoped (`event-scope.ts:51-56`) and buffer into the background thread's off-screen state (`Main.svelte:1477-1509`) with no user-facing signal — the session silently stalls awaiting input, holds a live slot indefinitely. | goals re-evaluation |
| **D16** | **(new, round 2)** The single-"primary" concept (`_primarySessionId`, `AgentRegistry.ts:54`) still underpins `session.turns`/`session.rewind` (`session-services.ts:190-198, 215-219`) — meaningless once N sessions run in parallel. | goals re-evaluation |

## 3. Target Architecture — lifecycle

### 3.1 Conceptual model: a thread IS a session, and it never closes

One user-facing concept: **a chat session** (unified `sessionId`). Durable from creation
until user deletion. What varies is **runtime state**:

```
 persisted only                          in memory
┌─────────────┐  open()   ┌───────────┐  ok   ┌────────┐ work ┌─────────┐
│  SUSPENDED  │ ────────► │ HYDRATING │ ────► │  IDLE  │ ───► │ RUNNING │──┐
│ (ThreadIndex│ ◄──────── │           │       │        │ ◄─── │(+await- │  │
│  + rollout) │  failure  └─────┬─────┘       └───┬────┘ done │  input) │  │
└─────┬───────┘                 │ tombstoned      │ evict     └─────────┘  │
      │ delete()                ▼                 ▼                        │
      └────────────────► ┌──────────┐      ┌────────────┐    delete =     │
                         │ DELETING │ ◄─── │ SUSPENDING │    abort first ◄┘
                         └──────────┘      └─────┬──────┘
                          (terminal, soft)       ▼
                                             SUSPENDED
```

**Transition table** (only legal transitions; anything else throws, as
`VALID_STATE_TRANSITIONS` does today — the legacy↔new state mapping for the 17 existing
call sites on the old enum is in implementation-spec §2):

| From | To | Trigger | Notes |
|---|---|---|---|
| SUSPENDED | HYDRATING | `open(sessionId)` with intent to run, or first submit to a two-stage-opened chat (§3.6) | single-flight (§3.2) |
| HYDRATING | IDLE | assemble + history replay succeed | re-check config/auth generations (§3.4) |
| HYDRATING | SUSPENDED | hydration failure | error surfaced, retryable; never stuck |
| HYDRATING | DELETING | delete tombstone observed at completion | just-assembled agent disposed |
| IDLE | RUNNING | submit accepted OR background work begins (§3.5) | |
| RUNNING | IDLE | `hasLiveBackgroundWork()` false | emits `background-idle` |
| IDLE | SUSPENDING | LRU eviction / shutdown | entry re-checks: no in-flight submit, no background work, not viewed (§4.6) |
| SUSPENDING | SUSPENDED | teardown complete | |
| SUSPENDED / IDLE | DELETING | `delete()` | RUNNING requires abort confirm first |
| DELETING | — | soft-deleted (§5.3) | terminal |

**`awaiting-input` is an attribute of RUNNING, not a distinct state** (round 2, D15): when a
thread-scoped approval request is outstanding, the session is RUNNING with
`awaitingInput: true`, carried on `SessionRuntimeEvent` (§7.1) and badged distinctly in the
UI (§7.2). It counts as RUNNING for eviction (never evicted) but the UI must make it
impossible to miss — a silently stalled session is a goal-1 failure.

### 3.2 Concurrency discipline (single-flight per session)

1. **Per-session operation queue** — every lifecycle op chains onto that session's promise
   tail before its first `await`; concurrent `open()` on a HYDRATING session returns the
   in-flight promise. *Implementation note: generalize the existing `LeaseLifecycleQueue`
   (`TabLeaseStore.ts:140-157`) into a shared `PerKeyOperationQueue` — this exact pattern
   already exists in-repo; do not write a new primitive* (implementation-spec §7).
2. **Capacity critical section** — "count live → pick LRU victim → reserve → suspend →
   assemble" runs under one manager-level mutex (same queue class, fixed key).
3. **Delete tombstones** — set synchronously; hydration completion checks before inserting
   into the live map.
4. **SUSPENDING is non-dispatchable** — a submit arriving mid-suspend is queued (§4.5) and
   triggers re-hydration after the suspend completes. **Important (round 2, D14/spec §3):
   today's real send path bypasses `AgentSession.submit()` — the guard must be installed in
   the `ChannelManager` agent-handler routing, not only on `AgentSession`** (the three
   direct-call sites are inventoried in implementation-spec §3).

### 3.3 Hydration is new work (corrected in round 1)

What hydration reuses is the **history reconstruction** inside `createSession({resume})`
(`AgentRegistry.ts:336-338` → rollout replay) — proven code. The orchestration
(open-without-killing-anything, single-flight, capacity) is new Phase-3a work. Today's
`session.resume`/`rewind` kill the live primary first (D7) and become shims over `open()`.

### 3.4 Config/auth changes racing hydration

`AgentConfig` and `AuthContext` each carry a monotonic **generation counter** (new — neither
exists today; the counter is bumped centrally in `AgentConfig.emitChangeEvent()`, spec §8).
`open()` records both at hydration start; after assemble + registration it re-compares and
runs `rebuildExecutionContext(union of reasons)` before HYDRATING → IDLE if either advanced.

### 3.5 Background work is first-class (suspension safety) — corrected in round 2

RUNNING must reflect all live work. Round-2 code tracing sharpened the picture:

- `Session.activeTasks` (sub-agents) — disjoint from `activeTurn` tasks; **must** be added
  to the busy signal (D5).
- `ShadowAgentScheduler` — inspectable today via `diagnostics()` (`ShadowAgentScheduler.ts:69-78`);
  a trivial `hasPending()` wrapper suffices. Note `Session.dispose()` **aborts** active shadow
  jobs (`Session.ts:1717-1724`) — gating eviction *before* dispose is what prevents loss.
- Post-turn hooks (`AutoCompactHook`, `SessionSummaryHook`) are **already awaited** inside
  turn finalization (`Session.firePostTurnHooks` awaited by `TaskRunner.ts:904-919`) — they
  are covered by existing task tracking and need **no** new machinery (v2 wrongly called
  them fire-and-forget).
- **Title generation is the one genuinely untracked continuation**
  (`Session.ts:2740-2757`, detached `.catch()`) — it needs new in-flight tracking (migrate
  onto the post-turn-hook pipeline or an explicit pending set), with the 30 s grace timeout.

```ts
// Session — composition detail in implementation-spec §9
hasLiveBackgroundWork(): boolean
// = activeTurn tasks ∪ activeTasks ∪ shadowScheduler.hasPending() ∪ title-gen in flight
```

Used by BOTH the LRU victim filter and rebuild deferral. Phase 1 introduces this method with
the first two terms (reusable), Phase 3a extends it — one method, not two implementations.

### 3.6 Two-stage open: new chats never build an agent eagerly (round 2)

`open()` with no `sessionId` **does not assemble an agent**. It: creates the ThreadIndex
entry, reserves the unified `sessionId`, returns immediately with `state: 'suspended'`. The
UI enables input at once. The **first submit** triggers hydration (empty-history assemble)
through the §4.5 pending queue, exactly like any suspended session.

Consequences:
- New chat → input ready is one index write — the < 300 ms budget (§10) is trivially met.
- An empty new chat consumes **no live slot** — New Chat can never return `busy` (§1).
- PR #326's "lazy agent init on first message" follow-up is **fully adopted**, not partial
  (§9) — and it needs no special-case machinery, because a new chat is just a suspended
  session with an empty rollout.

## 4. Target Architecture — components & contracts

### 4.1 Component ownership map

| Component | Owns (single source of truth) | Explicitly does NOT own |
|---|---|---|
| `ThreadIndex` (new, persisted; §5) | Session list: sessionId, title, timestamps, pinned, deletedAt | conversation content, runtime state |
| `SessionManager` (evolves `AgentRegistry` in place; renamed Phase 5) | Live-session map, runtime state machine, single-flight queues, LRU, hydrate/suspend, config/auth propagation, **viewed-session set (per connected UI surface)** (round 2, D16), **per-RUNNING-session event replay ring** (§7.5), post-assembly telemetry wrapping | agent construction, UI state |
| `AgentAssembler` (new) | Building one fully-wired agent graph | lifecycle, storage, telemetry |
| `AuthContext` (new) | Current `IAuthManager` + change notification + generation | per-session rebuilds |
| `RepublicAgent` | One `Session`, tools/engine/hooks, `rebuildExecutionContext()` | config subscription (removed), auth acquisition |
| `Session` | Conversation, rollout, tasks, `hasLiveBackgroundWork()` | tabId (D9), model-client lifecycle |
| `TabGroupRegistry` (new, over `TabLeaseStore`; §6) | Tab & tab-group ↔ session ownership, letters | session lifecycle |
| `threadStore` (webfront; exists today, keyed by sessionId) | UI projection of ThreadIndex + runtime events + per-session conversation buffers | its own ids |

The single-`_primarySessionId` concept is **deleted** (D16): `session.turns` and
`session.rewind` take an explicit `sessionId`; "the session an action targets" is always the
requesting surface's viewed session, reported via `session.setViewed` (§7.4).

### 4.2 Contracts

Full code-level definitions live in implementation-spec §1; summary:

```ts
interface SessionHandle {
  readonly sessionId: string;
  getState(): SessionRuntimeState;   // 'suspended'|'hydrating'|'idle'|'running'|'suspending'|'deleting'
  submit(op: SubmitInput): Promise<SubmitAck>;   // ACK, not turn result (see below)
  events: SessionEventSource;        // per-session filtered ChannelEvent view — NOT a new transport
}
```

- **`SubmitAck`, not `SubmitResult`** (round 2): the real submit chain is fire-and-forget —
  `AgentSession.submit` returns a bare submission-id; turn outcomes arrive later as
  `ChannelEvent`s. `submit()` resolves `{accepted, submissionId} | {queued, position} |
  {rejected: 'queue-full' | 'deleted' | 'busy'}`. Turn results are delivered **exclusively**
  via `events`.
- **`SubmitInput`** is the existing `Op` union narrowed to its `UserInput` variant — there is
  no standalone `UserInput` type today (spec §1).
- **`SessionEventSource`** is a per-sessionId filtered view over the existing
  `UIChannelClient.onEvent` + `ThreadEventRouter` machinery — no new transport.
- **`AuthContext`**: `current()` / `generation()` / `subscribe()`. Round-2 clarification of
  the "must not cache" rule: it applies to *decision logic* (SessionManager, hydration
  checks). `ModelClientFactory` **holds the `AuthContext` object itself** and reads
  `current()` inside its `tokenProvider`/`refreshAuthorizationToken` closures at call time —
  this is the chosen refactor (spec §5); it makes mid-stream token refresh follow auth
  changes without re-pushing managers into factories, and removes the `setAuthManager`
  sweep-push pattern entirely.
- **Single teardown owner**: `AssembledAgent.dispose()` is the only public teardown;
  `AgentSession.terminate()` delegates to it; direct `agent.cleanup()` becomes non-public.

### 4.3 Unified construction: `AgentAssembler` (fixes D1, D10)

```ts
interface AgentAssembler {
  assemble(input: {
    config: AgentConfig;
    initialHistory: InitialHistory;   // exists today (session/state/types.ts:177)
    auth: AuthContext;
    services: SessionServices;        // exists today (session/state/SessionServices.ts) — extended, not invented
  }): Promise<AssembledAgent>;
}
```

`RepublicAgent.initialize(auth)` — the parameter is **required**, not optional (an optional
auth would silently reintroduce D1). This changes a zero-arg signature
(`RepublicAgent.ts:151`) and its test constructions; the migration inventory is in spec §4.

The extension assembler's full dependency list (approval gate, policy engine, enhancers,
x402, sub-agent tool, TaskOutputStore, skill registry, plugin binder — several of which are
late-bound module state in `service-worker.ts` today) is inventoried in spec §4 with the
late-binding strategy. `_setupTabClosureHandling` stays in the registry until Phase 3c.

**Credential-read consolidation (D11) preserves the missing-key warning**: the factory
becomes the single reader and surfaces `missing-key` through an assembler-provided callback
that emits today's `BackgroundEvent` warning (spec §6) — the second read at
`RepublicAgent.ts:172` is deleted without losing the UX.

### 4.4 One rebuild path (fixes D2, D5, D11)

```ts
async rebuildExecutionContext(reasons: ReadonlySet<RebuildReason>): Promise<void>
```

- `RebuildReason` enum and the reason→work matrix (which steps run per reason: client build,
  prompt recompose, memory refresh, credential read) are **defined in spec §2** — v2 named
  the concept but never enumerated it.
- Mutates the existing `TurnContext` (the `hotSwap` behavior). **This is an intentional
  behavior change** for `refreshModelClient`'s 7 call sites (inventoried in spec §2) — they
  currently get a fresh `TurnContext` with policy overrides silently reset; after this they
  keep overrides. That reset is a bug, not a contract.
- Defers on `hasLiveBackgroundWork()` (not just active-turn tasks); deferral stores a
  **pending-reason set** unioned across queued changes, applied at the existing turn-boundary
  flush point (`RepublicAgent.ts:967-978`). `pendingModeSwitch` (session-mode switching)
  remains a separate mechanism — it is a conversation-semantics change, not an execution
  context rebuild (spec §2).

### 4.5 Pending-submit queue (HYDRATING / SUSPENDING)

Owned by SessionManager. Bounded FIFO per session (depth 8; overflow → `{rejected:
'queue-full'}` ack). Flushed in order on IDLE. On hydration failure every queued message
returns to the UI as not-sent/retryable. In-memory only; loss on worker death is visible
("sending…" never acks), not silent.

### 4.6 Capacity, LRU, and the rules that keep it invisible

- `maxLive` (default 5); eviction picks the LRU **IDLE** session that is **not viewed by any
  connected surface** (viewed set reported via `session.setViewed`, expiring on surface
  disconnect — spec §10).
- All live RUNNING → overshoot to `hardMax` (10).
- At `hardMax` running, `open(sessionId)` (continue) resolves `busy`; SessionManager keeps a
  bounded pending-open queue drained on `capacity-freed`; the UI auto-retries. New chats are
  exempt (§3.6).
- `internal: true` sessions keep bypassing counts.

## 5. Persistence & migration

### 5.1 ThreadIndex schema & storage

```ts
interface ThreadIndexEntry {
  sessionId: string;
  title: string;            // '' until first title generation (§7.3)
  createdAt: number;
  lastActiveAt: number;
  pinned: boolean;
  deletedAt: number | null; // soft delete
  schemaVersion: 1;
}
```

**A new object store / table named `thread_index`** — NOT extra fields piggybacked on the
existing `agent_sessions` store (`PersistedSession` shares almost no fields; mixing them
invites shoehorning — round 2, spec §11). Storage engines (round-2 factual correction):
extension → IndexedDB (`IndexedDBAdapter`); **desktop → SQLite**
(`DesktopRuntimeSQLiteAdapter`), which shares the `StorageAdapter` *interface*, not the
engine. No new indexes initially — `getAll()` + in-memory sort suffices at chat scale, so no
IndexedDB `DB_VERSION` bump is required (SQLite side is idempotent `CREATE TABLE IF NOT
EXISTS`). Writes: fire-and-forget on state change (the `_autoPersist` pattern) + awaited at
suspend.

### 5.2 Upgrade backfill

1. One-time migration on first post-upgrade run: scan rollout store + `SessionStorage`
   metadata → create entries (existing titles where present, else '').
2. Lazy-index safety net: `session.list` indexes any rollout with no entry on sight.

### 5.3 Soft delete

`delete` sets `deletedAt` (leaves all lists; rollout retained), UI undo window; hard-wipe
after retention (default 30 days). Round-2 correction: `cleanupOrphanedSessions` **already
has periodic callers** (`chrome.alarms 'session-cleanup'` at `service-worker.ts:1793` +
2-hour `setInterval` fallbacks at `:1824`) — the work is *retargeting* that existing job to
retention semantics, not adding a scheduler.

### 5.4 Multi-client consistency

All UI surfaces of an install talk to exactly one SessionManager process; ThreadIndex is
written only by that process; UIs are event subscribers. Extension and desktop are separate
installs. Cross-machine sync out of scope.

## 6. Tabs decoupled from sessions (fixes D9)

`TabLeaseStore` today is a per-tab tool-execution claim store — no groups, no letters (those
live in `AgentSession`/`AgentRegistry`). New **`TabGroupRegistry`** layered on it owns group
lifecycle + letter allocation; `AgentSession._metadata.tabId/tabGroupId` and
`Session.setTabId()` are removed; acquisition is lazy (first browser-tool use); release on
suspend; tab closure never terminates a session (today it does, `AgentRegistry.ts:544-559`).

### 6.1 Browser resource contention between concurrent sessions (round 2)

Two RUNNING sessions share one physical browser. Rules:
- Per-session tab groups are isolated — a session's tools operate only on tabs it holds
  leases for; cross-session lease theft is not permitted (contended `claim` waits or fails
  tool-level, never silently reassigns).
- **No focus stealing from background sessions**: `chrome.tabs.update({active:true})` /
  window-focus calls from a session that is not the viewed session are deferred or downgraded
  to non-activating operations; a background session's automation must not yank the user out
  of the page they're interacting with. When a background session genuinely requires
  foreground interaction (e.g. a login page), it raises `awaitingInput` (§3.1) instead.

## 7. UI design (on top of PR #298)

### 7.1 Runtime-state event contract

`SessionRuntimeEvent` is a **new `EventMsg` union member** (not folded into
`BackgroundEvent`'s payload), and — critical, round 2 — it MUST get an
`'session_runtime_state': 'thread'` entry in `EVENT_SCOPE_MAP`
(`src/core/protocol/event-scope.ts`), because unknown types default to `'channel'` scope and
would never reach thread-keyed UI state via `ThreadEventRouter`. Transports are additive on
both the Tauri bridge and server WS wire (verified round 2 — no protocol changes).

```ts
interface SessionRuntimeEvent {
  type: 'session_runtime_state';
  sessionId: string;
  state: SessionRuntimeState;
  prevState: SessionRuntimeState;
  awaitingInput: boolean;           // D15: RUNNING-with-pending-approval
  ts: number;
  reason?: 'opened'|'evicted'|'hydration-failed'|'shutdown'|'deleted';
}
```

### 7.2 Left panel

```
┌ Chat ────────────────────────┐
│  + New chat        [search]  │
│  📌 Fix payment flow      ●  │   ← pinned; ● RUNNING
│  📌 Q3 report draft          │
│  ─────────────────────────   │
│ ▸ Refactor session mgmt   ⏳ │   ← ▸ viewed/selected; ⏳ awaiting input
│  Browser automation ...   ●  │
│  Yesterday's debugging       │
│  more…                       │
└──────────────────────────────┘
```

- **Selection highlight**: exactly one viewed session per window (`▸`); the invariant is
  explicit and reported via `session.setViewed`.
- **`awaitingInput` badge (`⏳`) is visually distinct from RUNNING (`●`)** and the window
  surfaces an aggregate "N sessions need your input" affordance that deep-links to the
  blocked session (D15). Approval prompts from non-viewed sessions raise this signal — they
  must never only append to an unseen transcript.
- **Search**: client-side title filter over ThreadIndex, feeding both the panel and the
  "more…" modal (round 2).
- **Rename**: context-menu → `session.rename` (round 2).
- **New Chat semantics** (round 2): the current conversation demotes to a background item
  (keeps running, keeps its badges); if it is `awaitingInput`, the aggregate affordance keeps
  it reachable.
- **"more…" modal** is the same runtime-aware projection as the panel (badges, open-with-
  hydration, search) — not a static history list.
- **Click** → `session.open` + optimistic render. The optimistic snapshot and hydration
  replay are the **same immutable rollout snapshot**, fetched via the new `session.getRollout`
  RPC (§7.4 — round 2: no existing RPC can serve history for a suspended session;
  `session.getState` throws without a live agent).
- **Send** gated on IDLE; sends during HYDRATING queue and render "sending…".
- **Failure surfaces**: hydration failure → history visible, "couldn't resume — Retry"
  banner, queued messages marked not-sent; `busy` → auto-retry affordance; delete → undo
  toast.
- Narrow mode (extension side panel) — **explicit parity list** (round 2): pin/unpin,
  soft-delete/undelete with undo, all runtime badges incl. `awaitingInput`, click-to-open
  with hydration + failure banner, "sending…" queue states, search. Rename and bulk actions
  are wide-mode-only (popup ergonomics).
- Bulk actions (multi-select delete/archive): **explicit non-goal** for this design.

### 7.3 Title lifecycle

`open()` (new) → `''` → UI renders "New chat" → after first assistant turn, title generation
(now tracked background work, §3.5) publishes via `SessionManager.updateTitle` → ThreadIndex
write + event. Full title-gen extraction from `Session` stays in D12 follow-up scope.

### 7.4 RPC surface

| RPC | Change |
|---|---|
| `session.open` (new) | Create (two-stage, §3.6) or continue. Response: `{ sessionId, state, liveCount, maxLive, title }` or `{ type:'busy', runningCount }`. Idempotent per §3.2. |
| `session.getRollout` (new, round 2) | `{sessionId}` → `{items}` — read-only rollout snapshot for a suspended session, wrapping the existing `loadRolloutHistory` platform hook (`session-services.ts:41`), no agent side effects. Serves optimistic render AND replaces `restoreAllThreadHistories`' live-agent requirement (D14). |
| `session.list` | ThreadIndex entries (excl. soft-deleted) + runtime state + `awaitingInput`. |
| `session.pin`/`unpin`, `session.rename` (new), `session.delete`/`undelete` (new) | Index mutations; delete soft. |
| `session.setViewed` (new, round 2) | Surface reports its viewed sessionId (null = none); feeds LRU ineligibility + selection highlight; expires on surface disconnect. |
| `session.turns`, `session.rewind` | Take an explicit `sessionId` (D16 — no more `getPrimarySession()`); rewind = fork + `open`, no longer kills the source. |
| `session.getActiveCount` | Deprecated for UI (counts on `open`/`list`). |
| `session.getState` | Deprecated for history fetching (throws for suspended sessions — round 2); superseded by `session.getRollout` + live events. |
| `session.create`, `session.resume` | Compat shims. Phase 1 (expedited): create's handler drops the post-create `refreshModelClient()` (§9). Phase 3a: both route to `open()`. Removal in Phase 5 if deprecation telemetry is silent. |

### 7.5 Background conversation streaming (round 2 — was unspecified and at risk)

Today, switching between threads works only because `Main.svelte` accumulates per-session
`processedEvents` in an in-memory map. The redesign makes this a first-class, specified
mechanism instead of an incidental one:

- **SessionManager keeps a bounded in-memory event replay ring per non-suspended session**
  (current-turn events, cap ~512): any UI surface that attaches (window open, switch, side
  panel reopen) requests the ring to reconstruct in-flight output — fixing the
  "second window shows nothing mid-turn" hole.
- **`threadStore` retains per-session conversation buffers** as the UI projection, fed by
  live events + the replay ring on attach. Phase 4 must NOT reduce `threadStore` to
  index+runtime-state only — that would regress today's A↔B switching.
- Durability: ring is in-memory (worker death loses in-flight partials — consistent with
  §11's RUNNING recovery stance; committed turns come from rollout).

## 8. Session independence guarantees (goal 1)

| Channel | Today | Target |
|---|---|---|
| Agent object graph | Fully per-session — kept | Same, via one `AgentAssembler` |
| Model client / auth | Per-session factory; sweep-pushed auth (D1/D10) | `AuthContext` held by factory, read at call time (§4.2); generation-checked hydration |
| Config events | Every agent (incl. disposed) self-subscribes (D3/D4) | Only SessionManager subscribes (client); deferral incl. background work |
| Prompt static context | Process-global first-agent-wins (D6) | Per-agent |
| Tabs | Session-owned groups; closure kills session (D9) | Leased via `TabGroupRegistry`; no focus stealing from background sessions (§6.1) |
| Approvals | Background approvals invisible (D15) | `awaitingInput` state + aggregate affordance (§3.1, §7.2) |
| Streaming | Incidental UI-map buffering | Specified replay ring + threadStore buffers (§7.5) |
| Submission concurrency | `_submitting` per session, bypassed by real send path | Guard installed at ChannelManager routing (§3.2) |

## 9. PR #326 absorption map (goal 4)

Full PR #326 claim list is quoted in review-log.md round 2 for verifiability (round-2
finding: the map was self-asserted).

| PR #326 item | Resolution |
|---|---|
| Removed redundant `refreshModelClient()` from `session.create` | Structural (auth as construction input, §4.3). **Interim regression closed**: because #326 was closed unmerged, main currently carries the redundant call (`session-services.ts:307`); an **expedited Phase-1 patch** deletes it standalone (shape-compatible) so users aren't regressed until Phase 2 (round 2). |
| `Promise.all` post-create round trips | Superseded: counts on `open` response; tab binding leaves the create path. |
| Regression test: no double-compose | Re-implemented against `AgentAssembler` (Phase 2), both platforms. |
| Follow-up: optimistic render | §7.2 + `session.getRollout` + single-snapshot rule. |
| Follow-up: lazy agent init on first message | **Fully adopted** via two-stage open (§3.6) — no longer partial. |
| Follow-up: `activeCount` in create response | `session.open` response. |
| Follow-up: perf test on real path | Phase 2 real-`assemble()` assertion; Phase 3a hydration-budget test; §10 field metrics. |

## 10. Latency budgets & observability

| Interaction | Budget | How |
|---|---|---|
| Click suspended session → history visible | < 150 ms | `session.getRollout` snapshot render |
| Click suspended session → send enabled | < 1 s | Single-init hydration, auth pre-wired |
| New chat → input ready | < 300 ms | Two-stage open: index write only (§3.6) |

Field metrics via `DiagnosticRegistry`: `hydration_duration_ms`, `suspend_duration_ms`,
`live_agents`, `evictions_total`, `busy_total`, `hydrate_failures_total`,
`pending_queue_depth`, `awaiting_input_sessions`.

## 11. MV3 service-worker death: recovery matrix

| State at death | On wake |
|---|---|
| SUSPENDED | Durable by design. |
| IDLE | Appears SUSPENDED (live map is memory-only); rollout flushed at last turn boundary. |
| HYDRATING | Reads were read-only; appears SUSPENDED; UI retry path. Pending queue lost visibly. |
| RUNNING | In-flight turn lost. Rollout turn-started marker without turn-committed → marked `interrupted`, surfaced in conversation. Incremental checkpointing out of scope. |

## 12. Alternatives considered

1. **Evolve `AgentRegistry` in place vs new class** — CHOSEN: evolve; rename in Phase 5.
2. **Process/worker-per-session** — REJECTED: impossible under MV3; per-session isolation is
   already strong at the object-graph level.
3. **Memory-pressure-driven suspension** — DEFERRED: count-based is deterministic/testable;
   pressure can later feed `maxLive`.
4. **"Lifecycle-lite" Goal-3-first slice** (round 2): ship ThreadIndex + pin + soft-delete +
   click-to-open against today's capped live pool, deferring LRU/suspend/hydrate. PARTIALLY
   ADOPTED: rejected as an end state (it re-surfaces the session cap, contradicting the
   capacity decision), but Phase 3a is **milestone-sliced accordingly** — 3a-1 delivers
   ThreadIndex + two-stage open + pin/rename/soft-delete (the visible Goal-3 skeleton, low
   concurrency risk), 3a-2 delivers LRU suspend/hydrate + capacity (the heavy machinery) —
   so the UX ships and is validated earlier without changing the destination.

## 13. Risks & open questions

1. Suspension safety — `hasLiveBackgroundWork()` gates eviction AND deferral; title-gen is
   the one continuation needing new tracking (§3.5).
2. Hydration correctness — replay is proven; orchestration is new; single-flight/tombstone
   test matrix in Phase 3a.
3. MV3 — §11; RUNNING-turn loss accepted and surfaced.
4. `maxLive`/`hardMax` defaults — tuning knobs; revisit with §10 metrics.
5. External RPC consumers of `session.create`/`resume` unverified — deprecation telemetry
   decides Phase 5 removal.
6. simplify_session slippage blocks 3a/4 (not 1–2).
7. **Goal-1 gating** (round 2): the "no interference" promise is only true once 3b (config
   sweep, D8) and 3c (tab decoupling, D9) land — **Phase 4 is gated on 3b AND 3c**, because
   shipping the many-sessions UI while config-update still destroys sessions and tab-closure
   still kills them would amplify exactly the bugs this design exists to fix.
