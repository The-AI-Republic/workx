# Multi-Thread Session Management Redesign

Status: **DRAFT v2 — revised after adversarial design review (2026-07-14)**
Related:
- PR #298 (left-panel chat history) — **prerequisite**, merge first
- PR #326 (thread-creation latency) — closed, superseded; absorption map in §9
- `.ai_design/simplify_session/design.md` (unified sessionId) — **hard prerequisite**, not
  optional companion: ThreadIndex keys, the runtime-state events, and background running
  indicators all require the unified `sessionId` and the `ChannelEvent{msg, sessionId}`
  envelope it defines (§7 there). Gated in Phase 0.
- Review log: [review-log.md](./review-log.md)

## 1. Goals & scope

1. **Parallel multi-session** — multiple independent agent sessions run in parallel; sessions
   never interfere with each other.
2. **Well-managed instances** — clear ownership, state in exactly one place, efficient
   initialization (no duplicated work).
3. **Codex/Claude-style thread model** — no "close thread" concept, no "create a thread tab"
   ceremony. The left panel lists recent chat sessions (on PR #298); the user pins and clicks;
   live parallelism is an implementation detail.
4. **Systematically absorb PR #326** — the latency fix is resolved at the root cause.

Honest bound on goal 3: "no user-visible limit" applies to *sessions* (unlimited, durable).
Concurrently **running** agents are bounded by `hardMax` (default 10); at that bound `open`
returns a typed `busy` result and auto-retries when capacity frees (§4.6). This is the same
ceiling that exists today — it just stops applying to idle/suspended sessions.

**Platform scope** (review C3 decision):
- **Phase 2 (construction unification: `AgentAssembler` + `AuthContext`) applies to all
  platforms** — the server's init-then-refresh double-work (D1) is fixed there too; auth is
  already per-connection on the server and maps cleanly to a construction input.
- **Phase 3+ (lifecycle: state machine, ThreadIndex, LRU, left panel) is CLIENT-ONLY**
  (extension + desktop). Server mode (`src/server/`) is today a **single-tenant headless
  agent** — one user runs a dedicated instance (the `userId` in
  `src/server/connection/auth.ts` authenticates that one user, it does not multiplex
  tenants). So nothing in the lifecycle layer would be *incorrect* on the server; it is
  excluded because (a) there is no thread-list UI to drive it — sessions are driven by
  channel connectors (Slack/Telegram), a different interaction model, and (b) keeping the
  first delivery client-scoped shrinks the blast radius. The server can adopt the lifecycle
  layer later as a follow-up. **Caveat for that follow-up**: the server-mode design doc
  positions the same architecture for future enterprise/multi-user deployments — if
  multi-tenancy ever lands, the LRU pool, config sweep, and ThreadIndex must be
  tenant-scoped at that point.

Decisions taken with the team:

| Decision | Choice |
|---|---|
| Capacity model | Transparent LRU suspend/hydrate; sessions unlimited, running agents bounded by `hardMax` |
| PR #298 | Merge first; this design builds on top |
| PR #326 | Closed unmerged; findings absorbed here (§9) |
| Tabs vs threads | Decoupled — browser tabs are a leased session *resource*, not the session's identity |
| Server mode | Single-tenant headless today. Phase 2 yes; Phase 3+ lifecycle out of scope for the first delivery (no thread-list UI; channel-driven sessions), adoptable later |

## 2. Current Architecture (as-is)

```
AgentRegistry  (Map<sessionId, AgentSession>, hard cap 5, throws at limit)
   └── AgentSession        1:1  lifecycle state machine + tab binding
         └── RepublicAgent 1:1  init/refresh orchestration, own ModelClientFactory
               └── Session 1:1  conversation, rollout, memory, tasks (3,231 lines)
```

- Every session builds a full fresh object graph (platform adapter, tool registry, approval
  gate, policy engine, x402, sub-agent runner) inline in `AgentRegistry.createSession()`
  (`src/core/registry/AgentRegistry.ts:130-357`).
- **Two independently maintained construction paths**: the extension inlines everything in
  `AgentRegistry.ts:172-259`; the server injects an `agentFactory` closure
  (`src/server/agent/ServerAgentBootstrap.ts:339-490`).
- Sub-agents / shadow agents share the parent's `ModelClientFactory` **by reference** via
  `createChildEngine()` (`src/core/engine/RepublicAgentEngine.ts:414-433`) — the one place
  auth inheritance works by construction rather than by compensation.
- The UI (`src/webfront/pages/chat/Main.svelte`) models threads as explicit tabs the user
  creates and closes; chat history is a separate resume flow.

### 2.1 Defect inventory

Mapped in a full code exploration (2026-07-14); citations re-verified by an independent
fact-check pass (see review-log.md).

| # | Defect | Evidence |
|---|--------|----------|
| D1 | Auth is a bolt-on: `ModelClientFactory.authManager` defaults `null` (`ModelClientFactory.ts:70`); `initialize()` builds the first model client (`RepublicAgent.ts:208`) before auth can be wired. Three distinct compensation patterns exist: (a) server re-inits **twice per session** (`ServerAgentBootstrap.ts:348-351`); (b) the generic `session.create` RPC handler does the same init-then-refresh double work (`session-services.ts:307`, the PR #326 target — back on main since #326 closed); (c) extension boot sets the auth manager without refreshing (`service-worker.ts:536-545`), and a session created via `session.create` after boot gets auth only when a later sweep happens to run. | entry-points exploration |
| D2 | Three near-duplicate "rebuild" paths: `initialize()` tail, `refreshModelClient()` (`RepublicAgent.ts:590-628`), `hotSwapModelClient()` (`RepublicAgent.ts:635-669`). Each redoes prompt composition + user instructions + full memory-service teardown/rebuild. `refreshModelClient()` also constructs a fresh `TurnContext`, dropping approval/sandbox overrides. | lifecycle exploration |
| D3 | Model-client/prompt state is mutated by **uncoordinated mechanisms**: (a) per-agent self-subscription to `config-changed`, acting on `model`/`tools`/`provider` sections (`RepublicAgent.ts:316-329`); (b) direct sweeps that bypass config events entirely — `auth-services.ts:120-129`, `agent-services.ts:172-190` (`setAuthManager` + `refreshModelClient`), and the server's sequential `hotSwapModelClient` sweep on file-watch/policy change (`ServerAgentBootstrap.ts:745-757`; note `AgentConfig.reload()` emits only `policy`-section events, which (a) ignores — so on that path only the sweep fires). When a direct config write emits `model`/`provider` sections while a sweep also runs, both mutate the same `TurnContext` unawaited relative to each other. | lifecycle exploration, corrected per fact-check |
| D4 | Listener leak: `config-changed` subscription registered in the constructor, never removed in `cleanupOnce()` (`RepublicAgent.ts:1411-1443`). Disposed agents stay subscribed to the singleton `AgentConfig` and can act on torn-down sessions. | lifecycle exploration §5.2 |
| D5 | `hotSwapModelClient`/`refreshModelClient` don't check running tasks — config file-watch can swap the model client **mid-turn**. The `pendingModelKey` deferral exists only on the self-subscription path (`RepublicAgent.ts:359-371`). **Additionally**, the deferral primitive itself undercounts: `getRunningTasks()` reads only `activeTurn` tasks (`Session.ts:3130-3136`), not the disjoint `Session.activeTasks` background/sub-agent map (`Session.ts:143`; `abortAllTasks` at `Session.ts:2091-2114` must union both — proof they're disjoint). A rebuild can swap the client under a live background sub-agent even where deferral exists. | lifecycle exploration + fact-check #1 |
| D6 | First-agent-wins global prompt state: `configurePromptComposer()` is a set-once module singleton (`PromptLoader.ts:36-85`). The first agent's persona/browser-connection context becomes process-global; later sessions' configuration is a silent no-op. | lifecycle exploration §5.8 |
| D7 | Two "resume" implementations: `AgentRegistry.resumeSession()` (`AgentRegistry.ts:600-643`) creates a **new empty conversation** despite its docblock; the real resume is the `session.resume` RPC (`session-services.ts:147`). **And the real one is single-primary**: it terminates the currently-live primary session before creating the resumed one (`session-services.ts:151-155`); `session.rewind` does the same (`session-services.ts:252`). | registry exploration + fact-check #2 |
| D8 | `agent.configUpdate` semantics diverge by platform: extension destroys **all** sessions and recreates one (`service-worker.ts:782-822`); server hot-swaps in place preserving history. | entry-points exploration |
| D9 | `tabId` is triplicated: `AgentSession._metadata.tabId`, `Session` state (`Session.ts:1074-1088`), and `TabLeaseStore` — kept in sync only by caller discipline. | registry exploration |
| D10 | Four hand-rolled "loop sessions + setAuthManager (+ refresh)" sweeps with different completeness (`service-worker.ts:536-545, 800-846`, `agent-services.ts:181-191`, `auth-services.ts:127`). | entry-points exploration |
| D11 | Redundant IO on the create path: 2 credential-store reads for the same key per init (`RepublicAgent.ts:172` + `ModelClientFactory.ts:583`); memory service torn down/rebuilt on every refresh. | lifecycle exploration §1 |
| D12 | `Session.ts` is a god object (3,231 lines: tasks, memory, compaction, titles, suggestions, hooks, rollout, tool results). | registry exploration |
| D13 | Hard cap: `createSession` **throws** at the concurrency limit (`AgentRegistry.ts:133-136`); the user must manually close threads. | registry exploration |
| D14 | UI round-trip waste: serial `session.create` → `session.getActiveCount`; on cold start `syncThreadsWithSessions` triggers `updateSessionLimits` twice (`Main.svelte:1237` and, via nested `createNewThread()`, `Main.svelte:1299`). | entry-points exploration, citation corrected per fact-check |

## 3. Target Architecture — lifecycle

### 3.1 Conceptual model: a thread IS a session, and it never closes

One user-facing concept: **a chat session** (identified by the unified `sessionId`, per
`simplify_session`). It is durable — it exists from creation until the user deletes it.
What varies is its **runtime state**:

```
 persisted only                          in memory
┌─────────────┐  open()   ┌───────────┐  ok   ┌────────┐ work ┌─────────┐
│  SUSPENDED  │ ────────► │ HYDRATING │ ────► │  IDLE  │ ───► │ RUNNING │
│             │ ◄──────── │           │       │        │ ◄─── │         │
└─────┬───────┘  failure  └─────┬─────┘       └───┬────┘ done └────┬────┘
      │                         │ tombstoned      │ evict/shutdown │
      │ delete()                ▼                 ▼                │
      └────────────────► ┌──────────┐      ┌────────────┐         │
                         │ DELETING │ ◄─── │ SUSPENDING │         │
                         └──────────┘      └─────┬──────┘   never suspended;
                          (terminal)             │          delete = abort
                                                 ▼          tasks first
                                             SUSPENDED
```

**Transition table** (the only legal transitions; anything else throws, as
`VALID_STATE_TRANSITIONS` does today in `registry/types.ts:195`):

| From | To | Trigger | Notes |
|---|---|---|---|
| SUSPENDED | HYDRATING | `open(sessionId)` | single-flight (§3.2) |
| HYDRATING | IDLE | assemble + history replay succeed | re-check config/auth generation (§3.4) |
| HYDRATING | SUSPENDED | hydration failure | error surfaced to UI, retryable; in-flight promise cleared — **never** stuck in HYDRATING |
| HYDRATING | DELETING | `delete()` tombstone observed at completion | just-assembled agent disposed, no `set()` into live map |
| IDLE | RUNNING | submit accepted OR background work begins (§3.5) | |
| RUNNING | IDLE | last foreground task AND last background work item completes | emits `background-idle` |
| IDLE | SUSPENDING | LRU eviction / app shutdown | entry re-checks: no in-flight submit, no background work, not viewed (§4.6) |
| SUSPENDING | SUSPENDED | teardown complete | |
| SUSPENDED / IDLE | DELETING | `delete()` | RUNNING requires abort-tasks confirm first |
| DELETING | — | rollout + index tombstoned | terminal (soft delete, §5.3) |

- **SUSPENDED**: no `RepublicAgent` in memory; a `ThreadIndex` entry + rollout history. Zero runtime cost.
- **IDLE**: full live agent graph, no work. LRU-evictable unless currently viewed (§4.6).
- **RUNNING**: foreground task OR live background work (§3.5). Never evicted.
- No TERMINATED user state. "Close" disappears; `delete` is soft (§5.3).

This resolves D13: opening a session never throws at a limit; limits govern *live agents*.

### 3.2 Concurrency discipline (single-flight per session)

`open` / `suspend` / `delete` are multi-`await` operations; without coordination they race
(double-hydrate on double-click, two `open()`s evicting the same LRU victim, delete
resurrection). Rules:

1. **Per-session operation queue.** SessionManager holds `Map<sessionId, Promise<unknown>>`;
   every lifecycle op on a sessionId chains onto the tail of that session's promise **before
   its first `await`**. Concurrent `open()` for a HYDRATING session returns the in-flight
   promise (promise-coalescing) — it never restarts hydration.
2. **Capacity critical section.** "count live → pick LRU victim → reserve slot → suspend
   victim → assemble" runs under a single SessionManager-level async mutex, so two `open()`
   calls cannot pick the same victim or overshoot `maxLive` unobserved. `suspend()` is
   idempotent (re-entrant call returns the in-flight promise).
3. **Delete tombstones.** `delete()` sets a tombstone synchronously. Hydration completion
   checks the tombstone before inserting into the live map; if set, the just-assembled agent
   is disposed and the op resolves as deleted.
4. **SUSPENDING is non-dispatchable.** Message routing treats SUSPENDING like SUSPENDED: a
   submit arriving mid-suspend is queued (§4.5) and triggers re-hydration after the suspend
   completes. It is never delivered to the dying agent. `suspend()` re-checks "no in-flight
   submit AND no background work" atomically at entry (extends today's `_submitting` guard,
   `AgentSession.ts:261-266`, to span the whole suspend).

### 3.3 Hydration is new work (correcting a v1 claim)

v1 claimed hydration "reuses exactly the `session.resume` path." **False** (fact-check #2):
today's `session.resume` handler *terminates the live primary session first*
(`session-services.ts:151-155`) — a single-primary pattern fundamentally incompatible with
"open B while A keeps running." What hydration genuinely reuses is the **history
reconstruction inside `createSession({resume})`** (`AgentRegistry.ts:336-338` →
`Session.initialize()` replaying rollout items) — that part is proven. The *orchestration*
(open-without-killing-anything, single-flight, capacity) is new Phase-3a work and must be
treated as such in risk planning. `session.resume`/`session.rewind` RPCs become shims over
`open()` and lose their remove-the-primary behavior.

### 3.4 Config/auth changes racing hydration

A session being hydrated is not yet in the live map, so a config or auth change during
assembly would miss it (lost update; worst case: hydrate with just-logged-out credentials).
Rule: `AgentConfig` and `AuthContext` each carry a monotonically increasing **generation
counter**. `open()` records both generations when hydration starts; after assemble resolves
and the session is registered, it compares — if either advanced, it immediately runs
`rebuildExecutionContext(union of reasons)` before transitioning HYDRATING → IDLE.

### 3.5 Background work is first-class (suspension safety)

RUNNING must reflect **all** live work, not just the active turn. Today it doesn't:
`getRunningTasks()` reads only `activeTurn` tasks, while sub-agent/background tasks live in
the disjoint `Session.activeTasks` map, shadow-agent work in `ShadowAgentScheduler`, and
post-turn continuations (title generation, memory extraction, session-summary hook —
`Session.ts:1688-1696`) are fire-and-forget. Suspending on the current signal would abort
sub-agents mid-flight and corrupt exactly what the left panel shows (titles).

New signal, used by BOTH the LRU victim filter and rebuild deferral (fixing D5's blind spot):

```ts
// Session
hasLiveBackgroundWork(): boolean
// = activeTurn tasks ∪ activeTasks (sub-agents) ∪ shadowScheduler pending
//   ∪ registered post-turn continuations (title gen, memory extraction, summary hook)
```

- Post-turn continuations **register** as tracked work (bounded grace: if a continuation
  exceeds e.g. 30 s, it is logged and no longer blocks suspension).
- RUNNING → IDLE fires only when this returns false; Session emits `background-idle`.

## 4. Target Architecture — components & contracts

### 4.1 Component ownership map

| Component | Owns (single source of truth) | Explicitly does NOT own |
|---|---|---|
| `ThreadIndex` (new, persisted; §5) | The list of sessions: sessionId, title, timestamps, pinned, deletedAt | conversation content, runtime state |
| `SessionManager` (evolves `AgentRegistry` in place; renamed only in Phase 5) | Live-session map, runtime state machine, single-flight queues, LRU, hydrate/suspend, config/auth propagation to live agents, post-assembly telemetry wrapping | agent construction (→ `AgentAssembler`), UI state |
| `AgentAssembler` (new) | Building one fully-wired `RepublicAgent` graph | lifecycle, storage, telemetry wrapping |
| `AuthContext` (new) | Current `IAuthManager` + change notification + generation counter | per-session rebuilds (SessionManager sweeps) |
| `RepublicAgent` | One `Session`, tools/engine/hooks, `rebuildExecutionContext()` | config subscription (removed), auth acquisition |
| `Session` | Conversation state, rollout, tasks, `hasLiveBackgroundWork()` | tabId (D9), model-client lifecycle |
| `TabGroupRegistry` (new, over `TabLeaseStore`; §6) | All tab & tab-group ↔ session ownership, letter naming | session lifecycle |
| `threadStore` (webfront) | UI projection of `ThreadIndex` + runtime-state events | its own ids (keyed by `sessionId`) |

### 4.2 Contracts (review found these undefined in v1)

```ts
/** Returned by SessionManager.open(). The UI/services layer's ONLY grip on a session. */
interface SessionHandle {
  readonly sessionId: string;
  getState(): SessionRuntimeState;   // 'suspended'|'hydrating'|'idle'|'running'|'suspending'|'deleting'
  submit(input: UserInput): Promise<SubmitResult>;  // routes via pending queue when HYDRATING/SUSPENDING
  events: SessionEventSource;        // per-session runtime + turn events
  // NO direct agent access. Anything needing the agent goes through SessionManager internals.
}

/** Injected into assembly; the only auth source agents ever see. */
interface AuthContext {
  current(): IAuthManager | null;    // live read — consumers must not cache
  generation(): number;              // monotonic, bumped on every change (§3.4)
  subscribe(cb: () => void): () => void;
}

/** Produced by AgentAssembler.assemble(). */
interface AssembledAgent {
  agent: RepublicAgent;
  subAgentRunner: SubAgentRunner;    // BOTH platforms return a real one (see §4.4)
  dispose(): Promise<void>;          // THE ONLY public teardown (see below)
}
```

**Single teardown owner.** v1's `dispose` risked becoming a third cleanup path beside
`RepublicAgent.cleanup()` and `AgentSession.terminate()` — the same anti-pattern as D2.
Rule: `AssembledAgent.dispose()` is the **only** public teardown. It internally sequences
`session.dispose()` → `agent.cleanup()` → assembler-owned resources (adapter, gate
subscriptions). `AgentSession.terminate()` delegates to it; direct `agent.cleanup()` calls
outside `dispose()` are forbidden (enforced by making `cleanup()` package-private/renamed).

### 4.3 Unified construction: `AgentAssembler` (fixes D1, D10; PR #326 root cause)

Both platforms provide an `AgentAssembler`; `AgentRegistry.createSession()`'s inlined
extension branch is deleted (the injection point already exists as `agentFactory`).

```ts
interface AgentAssembler {
  assemble(input: {
    config: AgentConfig;
    initialHistory: InitialHistory;
    auth: AuthContext;               // auth is a construction input
    services: SessionServices;       // shared per-process services (see note)
  }): Promise<AssembledAgent>;
}
```

Key rule: **`RepublicAgent.initialize()` receives the `AuthContext` before it builds the
first model client** — correct on first build. The three D1 compensation patterns die:
server init-then-refresh (`ServerAgentBootstrap.ts:348-351`) deleted; `session.create`'s
post-create refresh (`session-services.ts:307`) deleted; extension's auth gap impossible.
The 4 hand-rolled sweeps (D10) become one `SessionManager.applyAuth()`.

Scope-corrected note on `SessionServices`: it deduplicates the **construction-graph**
`SessionCacheManager` instantiations (`AgentRegistry.ts:183`, `service-worker.ts:388`). The
two `StorageTool.ts` instantiations are tool-owned, outside the construction graph, and are
NOT addressed by this design (follow-up).

### 4.4 Assembly ordering & post-assembly wiring (entanglements v1 glossed over)

`assemble()` is internally phased — the flat signature hides a strict ordering the extension
branch and server closure both implement today:

1. **construct** — platform adapter, `new RepublicAgent(...)`
2. **initialize** — `await agent.initialize(auth)` (model client, prompt, memory, engine)
3. **wire** — steps that REQUIRE a completed initialize: approval gate + policy engine
   (needs `getApprovalManager()`/`getToolRegistry()`), x402 capability, sub-agent tool
   registration (needs `getEngine()` non-null), plugin session binder

Contract points settled here (review fact-check #4):
- **`subAgentRunner` is real on both platforms.** Today the server invokes `onAgentCreated`
  with `subAgentRunner: null` "for contract symmetry" (`AgentRegistry.ts:161-171`) and does
  its own plugin binding internally (`ServerAgentBootstrap.ts:394-416`). Both platforms'
  assemblers now perform wiring in phase 3 and return the real runner; the `onAgentCreated`
  callback is **deleted** — its consumers (TaskOutputStore, skills, plugin binder wiring in
  `service-worker.ts:351-378`) move into the `ExtensionAgentAssembler`.
- **Telemetry/eventDispatcher wrapping stays OUTSIDE the assembler**, owned by
  SessionManager post-assembly (as `AgentRegistry.ts:290-305` does today) — assemblers build
  agents; SessionManager instruments them.

### 4.5 Pending-submit queue (HYDRATING / SUSPENDING)

Owned by **SessionManager** (not the UI — a UI-held queue dies with the view and can't
survive routing). Semantics:
- Bounded FIFO per session (depth 8; overflow → immediate typed `queue-full` error to UI).
- Flushed in order on transition to IDLE, before any newly arriving submit.
- On hydration failure: every queued message is returned to the UI as `not-sent (retryable)`
  attached to the failure surface (§7.2) — never silently dropped.
- Durability: in-memory only; MV3 worker death loses it (documented; the UI shows queued
  messages as "sending…" until acked, so loss is visible, not silent).

### 4.6 Capacity, LRU, and the rules that keep it invisible

- `maxLive` (default 5) live agents; eviction picks the least-recently-used **IDLE** session
  that is **not currently viewed** — every connected UI surface reports its viewed
  sessionId(s); viewed sessions are LRU-ineligible (a session must never dehydrate under the
  user's cursor).
- All live RUNNING → overshoot allowed up to `hardMax` (10, today's `MAX_CONCURRENT_LIMIT`).
- At `hardMax` running: `open` resolves `{ type: 'busy', runningCount }` (typed result, not a
  throw). SessionManager keeps a bounded pending-open queue and emits `capacity-freed` on any
  RUNNING → IDLE; the UI auto-retries the pending open and shows "waiting for a free agent
  (N running)". New-chat is subject to the same bound — see §1's honest-bound statement.
- `internal: true` sessions (server bootstrap) keep bypassing counts, as today.

## 5. Persistence & migration (new section — review C4)

### 5.1 ThreadIndex schema

```ts
interface ThreadIndexEntry {
  sessionId: string;        // unified id (simplify_session)
  title: string;            // '' until first title generation (§7.3)
  createdAt: number;
  lastActiveAt: number;     // updated on open/submit/turn-complete
  pinned: boolean;
  deletedAt: number | null; // soft delete (§5.3)
  schemaVersion: 1;
}
```

Storage: extension & desktop → IndexedDB, as an evolution of the existing
`registry/SessionStorage.ts` store (same adapter stack). Writes are fire-and-forget on state
change (the `_autoPersist` pattern, `AgentSession.ts:576-581`) plus awaited at suspend step 2.

### 5.2 Upgrade backfill

The new UI *replaces* the tab strip and the separate history list — without backfill,
pre-upgrade conversations vanish. Two layers:
1. **One-time migration** on first run post-upgrade: scan existing rollout store +
   `SessionStorage` metadata; create a ThreadIndexEntry per known conversation
   (title from existing stored titles/summaries where present, else '').
2. **Lazy-index safety net**: `session.list` treats a rollout with no index entry as
   indexable-on-sight (covers migration crashes / partial states).

### 5.3 Soft delete

`delete` sets `deletedAt` (entry leaves all lists; rollout retained), with a UI undo window;
hard-wipe of rollout + entry runs after a retention period (default 30 days) via the existing
cleanup job slot (`cleanupOrphanedSessions` gains this duty and a confirmed periodic caller —
today it has none). Rationale: v1 replaced a non-destructive "close" with an irreversible
rollout wipe behind one confirm dialog — a data-loss regression.

### 5.4 Multi-client consistency

Invariant: **all UI surfaces of a given install talk to exactly one SessionManager process**
(extension: side panel(s) → one service worker; desktop: windows → one runtime process), and
ThreadIndex is written only by that process. UI clients are event-subscribers (§7.1), so
cross-window consistency is by construction. Extension and desktop are separate installs with
separate storage — sessions do not cross. Same-account-two-machines sync is explicitly out of
scope.

## 6. Tabs decoupled from sessions (fixes D9) — honest scope

v1 understated this. `TabLeaseStore` today is a per-tab, tool-execution-time claim store
(`claim`/`release`/`getOwner`, 157 lines) — it has **no tab-group concept, no letter naming**.
Those live in `AgentSession` (`bindTab`/`unbindTab`, `_metadata.tabGroupId/Name`,
`chrome.tabs.group()` calls, `AgentSession.ts:310-444`) and `AgentRegistry`
(`SESSION_LETTERS`, `_allocateLetterIndex`). The design therefore introduces
**`TabGroupRegistry`** layered on `TabLeaseStore`:

- Owns tab-group lifecycle + letter allocation (moved from AgentSession/AgentRegistry).
- `AgentSession._metadata.tabId/tabGroupId` and `Session.setTabId()` are removed; readers go
  through the registry (SessionHandle exposes a read-through view).
- A session acquires tabs/groups **lazily** (first browser-tool use) and releases on suspend.
- Tab closure releases leases and surfaces as a tool-level error on next browser action —
  it **never** terminates the session (today it does: `AgentRegistry.ts:544-559`).

This is its own sub-phase (3c) — it changes user-visible browser behavior and is orthogonal
to the lifecycle state machine.

## 7. UI design (on top of PR #298)

### 7.1 Runtime-state event contract (was undefined in v1)

New event, carried over the existing `BackgroundEvent`/`session_event` channel (and the
`ChannelEvent{msg, sessionId}` envelope from simplify_session §7):

```ts
interface SessionRuntimeEvent {
  type: 'session_runtime_state';
  sessionId: string;
  state: SessionRuntimeState;
  prevState: SessionRuntimeState;
  ts: number;
  reason?: 'opened'|'evicted'|'hydration-failed'|'shutdown'|'deleted';
}
```

The legacy `SessionStateChangedEvent` (`initializing|active|idle|terminated`) keeps firing
during migration; the UI switches sources in Phase 4.

### 7.2 Left panel

```
┌ Chat ──────────────────────┐
│  + New chat                │   ← replaces "new thread tab"
│  📌 Fix payment flow    ●  │   ← pinned first; ● = RUNNING
│  📌 Q3 report draft        │
│  ──────────────────────    │
│  Refactor session mgmt  ●  │
│  Browser automation ...    │   ← idle/suspended: visually identical
│  Yesterday's debugging     │
│  more…                     │   ← ChatHistoryModal (paginated)
└────────────────────────────┘
```

- **Pin/unpin** persists on ThreadIndex; pinned first, then `lastActiveAt` desc.
- **Click** → `session.open` + optimistic render. The optimistic snapshot and hydration
  replay MUST be the same immutable rollout snapshot (single read, shared), so
  reconciliation is a no-op by construction — no flicker/divergence.
- **Send is gated on IDLE**; a send during HYDRATING goes to the pending queue (§4.5) and
  renders as "sending…".
- **Failure surfaces**: hydration failure → history stays visible, input disabled, inline
  "couldn't resume — Retry" banner (+ queued messages marked not-sent, retryable);
  `busy` → "waiting for a free agent (N running)" with auto-retry (§4.6); delete failure →
  toast + entry restored.
- **Delete** = soft delete with undo (§5.3). The tab strip disappears; `threadStore` is keyed
  by `sessionId`, fed from ThreadIndex + `SessionRuntimeEvent`.
- Narrow mode keeps `ChatHistoryPopup` (PR #298 decision) + same indicators.

### 7.3 Title lifecycle (was unspecified)

- `open()` (new) → entry created with `title: ''`; UI renders "New chat".
- Existing title generation (currently inside `Session`) publishes through a
  `SessionManager.updateTitle(sessionId, title)` hook after the first assistant turn →
  ThreadIndex write + event. Title generation registers as post-turn background work (§3.5),
  so suspension cannot orphan it. (Full title-gen extraction from Session stays in D12
  follow-up scope.)

### 7.4 RPC surface

| RPC | Change |
|---|---|
| `session.open` (new) | Create-or-continue (§3.1). Response: `{ sessionId, state, liveCount, maxLive, title }` or `{ type:'busy', runningCount }`. Idempotent per §3.2 single-flight. |
| `session.list` | ThreadIndex entries (excl. soft-deleted) + runtime state — powers the panel in one call. |
| `session.pin`/`unpin`, `session.delete`, `session.undelete` (new) | Index mutations; delete is soft (§5.3). |
| `session.getActiveCount` | Deprecated for UI (counts ride on `open`/`list`) — D14. |
| `session.create`, `session.resume` | Compat shims (see below). In-repo, only `Main.svelte` consumes them; external server WebSocket clients are unverified, so verbs are kept one release and marked deprecated rather than removed. |
| `session.rewind` | Same semantics, re-implemented as fork → `open` (loses its kill-the-source behavior, §3.3). |

**Shim schedule** (review found v1's "kept for compatibility" underspecified and mis-phased):
- Phase 2: `session.create` handler body rewritten — drop the post-create
  `refreshModelClient()` (auth is now a construction input). Same request/response shape.
- Phase 3a: `session.create` → `open()`; `session.resume` → `open(sessionId)` (drops
  remove-the-primary); `session.rewind` → fork + `open`.
- Phase 5: verbs removed if telemetry shows no external callers.

## 8. Session independence guarantees (goal 1)

| Channel | Today | Target |
|---|---|---|
| Agent object graph | Fully per-session — good, kept | Same, via one `AgentAssembler` |
| Model client / auth | Per-session factory; auth swept inconsistently (D1/D10) | `AuthContext` injected at build; one sweep; generation-checked on hydration (§3.4) |
| Config events | Every agent (incl. disposed) self-subscribes (D3/D4) | Only SessionManager subscribes (client platforms); per-session deferral incl. background work (§3.5) |
| Prompt static context | Process-global, first-agent-wins (D6) | Per-agent |
| Tabs | Session-owned groups; closure kills session (D9) | Leased via `TabGroupRegistry`; closure never kills a session |
| Submission concurrency | `_submitting` per session | Kept; extended to span SUSPENDING (§3.2) |

## 9. PR #326 absorption map (goal 4)

| PR #326 item | Resolution here |
|---|---|
| Removed redundant `refreshModelClient()` from `session.create` | Structural: auth is a construction input (§4.3); the redundant call is deleted in Phase 2 (shim schedule §7.4). Server's same bug (`ServerAgentBootstrap.ts:348-351`) fixed by the same change. |
| `Promise.all` for post-create round trips | Superseded: `open` response carries counts (§7.4); tab binding leaves the create path (§6). |
| Regression test: no double-compose on create | Re-implemented against `AgentAssembler` (Phase 2), asserted on both platforms. |
| Follow-up: optimistic thread render | §7.2, with single-snapshot no-divergence rule. |
| Follow-up: lazy agent init on first message | Partially: hydration is background with send gated on IDLE + queueing (§4.5); full lazy-init remains a fallback if §10 budgets aren't met. |
| Follow-up: `activeCount` in create response | `session.open` response (§7.4). |
| Follow-up: perf test drives the real path | Phase 2 asserts real `assemble()` cost; Phase 3a adds hydration-budget test; §10 adds field metrics. |

## 10. Latency budgets & observability

| Interaction | Budget | How |
|---|---|---|
| Click suspended session → history visible | < 150 ms | Optimistic render from the shared rollout snapshot |
| Click suspended session → send enabled | < 1 s | Single-init hydration, auth pre-wired |
| New chat → input ready | < 300 ms | One round trip (`open`) |

Field metrics emitted by SessionManager through the existing diagnostics channel
(`src/core/diagnostics/DiagnosticRegistry.ts`): `hydration_duration_ms`,
`suspend_duration_ms`, `live_agents` (gauge), `evictions_total`, `busy_total`,
`hydrate_failures_total`, `pending_queue_depth`. Budgets are CI-tested once and
field-monitored forever.

## 11. MV3 service-worker death: recovery matrix (was an overclaim in v1)

| State at death | On wake |
|---|---|
| SUSPENDED | Nothing needed — durable by design. |
| IDLE | Live map is memory-only → session simply appears SUSPENDED. No loss (rollout was flushed at last turn boundary). |
| HYDRATING | In-flight promise gone; hydration reads are read-only → no partial writes; session appears SUSPENDED; UI retry path (§7.2) applies. Pending queue is lost but visibly (§4.5). |
| RUNNING | **In-flight turn is lost — no blanket robustness claim.** Rollout gains a turn-started marker; on wake, a marker without a turn-committed record marks the turn `interrupted`, surfaced in the conversation ("this response was interrupted"). Incremental turn checkpointing is a possible future hardening, out of scope. |

## 12. Alternatives considered (new section)

1. **Evolve `AgentRegistry` in place vs. new `SessionManager` class** — CHOSEN: evolve in
   place (all phases modify `AgentRegistry`; the rename to `SessionManager` is a mechanical
   final step in Phase 5). Avoids a big-bang parallel implementation and keeps every phase
   shippable.
2. **Process/worker-per-session** for isolation — REJECTED: impossible under MV3 (one service
   worker), heavy on desktop, and per-session isolation is already strong at the object-graph
   level (§8).
3. **Memory-pressure-driven suspension** instead of count-driven `maxLive` — DEFERRED:
   count-based is predictable and testable; §13.4 keeps `maxLive` a tuning knob and a
   pressure signal can later *feed* it. Pure pressure-driven eviction is nondeterministic to
   test and MV3 exposes no reliable memory signal.

## 13. Risks & open questions

1. **Suspension safety** — mitigated by design now: `hasLiveBackgroundWork()` gates eviction
   AND rebuild deferral (§3.5); post-turn continuations register as work.
2. **Hydration correctness** — history replay is proven code; orchestration is NEW (§3.3) and
   carries the single-flight/tombstone test burden (Phase 3a test matrix).
3. **MV3 lifetime** — per-state recovery matrix (§11); RUNNING-turn loss is accepted and
   surfaced, not silent.
4. **`maxLive` default 5 / `hardMax` 10** — tuning knobs; revisit with §10 field metrics.
5. **External RPC consumers** — `session.create`/`resume` external usage is unverified;
   deprecation telemetry in Phase 3a decides Phase 5 removal.
6. **simplify_session sequencing** — if unified sessionId slips, Phase 3a/4 are blocked
   (ThreadIndex keying + event envelope); Phase 1–2 are NOT blocked and should proceed.
