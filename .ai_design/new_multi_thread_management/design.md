# Multi-Thread Session Management Redesign

Status: **DRAFT v5 — implementation-ready design (after deep code review, 2026-07-16)**
Documents:
- This file — architecture & behavior
- [implementation-spec.md](./implementation-spec.md) — code-level contracts, type definitions,
  state mappings, call-site inventories (Round-2 addition; implementers start here after
  reading this doc)
- [tasks.md](./tasks.md) — phased task breakdown
- [review-log.md](./review-log.md) — all review rounds, findings → resolutions

Related:
- PR #298 (left-panel chat history) — **merged into main 2026-07-16**
- PR #326 (thread-creation latency) — closed, superseded; absorption map in §9
- `.ai_design/simplify_session/design.md` (unified sessionId) — **hard prerequisite**
  (ThreadIndex keys, runtime-state events, background indicators) — **landed on main**
  (`f0eb7ba9`, `0788ad93`); Phase 0 is satisfied.

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
Concurrently live **managed interactive client** graphs are bounded by `hardMax` (default
10). Scheduled/API/internal and headless-server agents remain eager and are outside this pool.
New Chat itself is only an index write and never hits this bound. Its first send, like a send to any suspended
session, can wait in the bounded capacity queue. If that queue is full the send is rejected
as retryable and the draft is preserved. The design does not claim unbounded execution.

**Platform scope** (review C3 decision, corrected in round 1):
- **Phase 2 (construction unification: `AgentAssembler` + `AuthContext`) applies to all
  platforms** — the server's init-then-refresh double-work (D1) is fixed there too.
- **Phase 3a/3c/4 (lifecycle, ThreadIndex, tabs, left panel) is CLIENT-ONLY** (extension +
  desktop). Server mode (`src/server/`) is today a **single-tenant headless agent** — one
  user per dedicated instance (the `userId` in `src/server/connection/auth.ts` authenticates
  that one user; it does not multiplex tenants). The lifecycle layer is excluded there
  because (a) there is no thread-list UI — sessions are channel-driven (Slack/Telegram) —
  and (b) client-scoping the first delivery shrinks blast radius. The server can adopt it
  later. **Phase 3b config propagation is shared by all AgentRegistry instances** because
  RepublicAgent's self-subscription is shared code and must be removed consistently; the
  headless registry stays eager but owns its centralized sweep. Caveat: if multi-tenancy ever
  lands, config sweeps and any future LRU/ThreadIndex must be tenant-scoped.

Decisions taken with the team:

| Decision | Choice |
|---|---|
| Capacity model | Transparent LRU suspend/hydrate; sessions unlimited; managed interactive client agents bounded by `hardMax`; first sends use bounded backpressure |
| PR #298 | Merged; this design replaces its split history/thread projections with one ThreadIndex projection |
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
| **D17** | **(new, round 3)** Per-session agent mode is runtime-only in `threadStore` and is neither in `ThreadIndex` nor injected during hydration. Transparent suspension would reset a session's mode. | `threadStore.ts`, `RepublicAgent.handleModeChange` |
| **D18** | **(new, round 3)** Two-stage open reserves `sessionId` before construction, but today's `InitialHistory` carries an ID only for resumed sessions; new/forked construction can silently mint a different ID. | `session/state/types.ts`, `AgentRegistry.createSession` |
| **D19** | **(new, round 3)** Extension events have two outbound paths: the dispatcher installed by `AgentRegistry` and `setupPeriodicTasks()` polling `getNextEvent()` every 100 ms. A replay ring would double-deliver without one chokepoint. | `AgentRegistry.ts`, `service-worker.ts` `setupPeriodicTasks` |
| **D20** | **(new, round 3)** `RepublicAgent.cleanup()` always emits `SessionEnd(reason=shutdown)` and calls `Session.dispose(Shutdown)`. Suspension needs a distinct runtime-graph reason or every eviction becomes a false shutdown/close. | `RepublicAgent.cleanupOnce`, `AgentSession.terminate` |
| **D21** | **(new, round 3)** Desktop browser bridge collapses every agent into `BRIDGE_SESSION_ID='bridge:desktop'` and one `currentTabId`; per-session proxy registration drops the sessionId before `NodeBridge.invoke`. Parallel desktop sessions would share tab selection and leases. | `BrowserBridgeToolManager`, `BridgeExecutor` |
| **D22** | **(new, round 3)** Prompt suggestion generation is another detached post-turn model call; `suggestionInFlight` is set only after awaiting the client, so lifecycle sees neither the pending call nor its early race window. | `TaskRunner.emitTaskComplete`, `Session.maybeGenerateSuggestion` |
| **D23** | **(new, round 3)** `activeTasks` now retains terminal tasks for UI eviction grace, so `activeTasks.size` is no longer a busy predicate; TaskCreated/TaskCompleted hooks are also detached. Using the v3 formula would hold sessions RUNNING after work ended yet still miss hook work. | `Session.onTaskFinished`, task eviction, hook calls |
| **D24** | **(new, round 4)** `session.reset` changes the inner `Session.sessionId` to a new UUID while its `AgentSession` wrapper and registry map remain keyed by the old ID. Main uses this path for New Chat. It violates the durable thread-ID invariant and leaves a split identity graph. | `Session.reset`, `AgentSession.reset`, `session-services.ts`, `Main.svelte.startNewConversation` |
| **D25** | **(new, round 4)** Skill availability is process-global mutable state: one `SkillDomainFilter` follows the browser's globally active tab and the global prompt extension reads it for every agent. Concurrent agents can therefore receive a skills prompt selected by another session's tab. | `service-worker.initializeSkills`, `SkillDomainFilter`, `SkillRegistry.buildSkillsSystemPrompt` |
| **D26** | **(new, round 4)** Awaiting the post-turn hook wrapper does not await all hook-owned work: SessionSummary deliberately launches `void runExtraction()`, and AutoCompact returns after enqueueing a Compact engine op. Neither the pre-scheduler summary gap nor queued/running compaction is a task or current shadow job, so rebuild/suspension can race them. | `SessionSummaryHook.handlePostTurn`, `AutoCompactHook.handlePostTurn`, `RepublicAgentEngine.submissionQueue` |
| **D27** | **(new, round 4)** Submit dedupe was memory-only while the UI was told to retry an orphan with the same client ID after worker death. Without a durable client-ID↔turn marker, a lost ACK followed by retry can create a duplicate turn, and the UI cannot reconcile an accepted orphan from rollout. | `UIChannelClient.serviceRequest`, proposed submit ACK/retry path, current rollout task markers |

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
`VALID_STATE_TRANSITIONS` does today — the legacy↔new state mapping for existing callers is
in implementation-spec §17):

| From | To | Trigger | Notes |
|---|---|---|---|
| SUSPENDED | HYDRATING | `open(sessionId)` with intent to run, or first submit to a two-stage-opened chat (§3.6) | single-flight (§3.2) |
| HYDRATING | IDLE | assemble + history replay succeed | re-check config/auth generations (§3.4) |
| HYDRATING | SUSPENDED | hydration failure | error surfaced, retryable; never stuck |
| HYDRATING | DELETING | delete tombstone observed at completion | just-assembled agent disposed |
| IDLE | RUNNING | submit accepted OR background work begins (§3.5) | |
| RUNNING | IDLE | rechecked `hasLiveBackgroundWork()` false | internal empty-edge callback; emits runtime state |
| IDLE | SUSPENDING | LRU eviction / shutdown | entry re-checks: no in-flight submit, no background work, not viewed (§4.6) |
| SUSPENDING | SUSPENDED | teardown complete | |
| SUSPENDING | IDLE | pre-teardown durable flush failed | graph is still intact; cancel victim replacement and surface warning |
| SUSPENDING | DELETING | confirmed delete tombstone wins | finish teardown as delete; cancel replacement |
| SUSPENDED / IDLE | DELETING | `delete()` | RUNNING requires abort confirm first |
| DELETING | SUSPENDED | `undelete()` before purge | same sessionId/history; no eager hydration |
| DELETING | — | hard purge (§5.3) | terminal only after ThreadIndex row is removed |

**`awaiting-input` is an attribute of RUNNING, not a distinct state** (round 2, D15): when a
thread-scoped approval request is outstanding, the session is RUNNING with
`awaitingInput: true`, carried on `SessionRuntimeEvent` (§7.1) and badged distinctly in the
UI (§7.2). It counts as RUNNING for eviction (never evicted) but the UI must make it
impossible to miss — a silently stalled session is a goal-1 failure.

### 3.2 Concurrency discipline (single-flight per session)

1. **Per-session operation queue** — every state mutation chains onto that session's promise
   tail before its first `await`. `openFlights: Map<sessionId, Promise<OpenResult>>` coalesces
   callers onto the exact hydration promise. Generalize the existing `LeaseLifecycleQueue`
   into `PerKeyOperationQueue`; do not add a second queue primitive (spec §10).
2. **Capacity scheduler, not a long-held mutex** — only count/pick/reserve/release is in the
   manager critical section. Storage, suspension teardown, and assembly run outside it.
   A reservation counts as live before the lock is released, so parallel hydrations cannot
   cross `hardMax` (spec §11).
3. **Lock ordering** — public session operations enqueue locally, release the per-session
   queue, then request capacity. No code waits for capacity while holding a session queue.
   The scheduler claims an eligible victim synchronously, then its session queue re-checks
   and transitions to SUSPENDING outside the scheduler. The scheduler never awaits or enters
   a session queue; this removes the capacity↔victim deadlock.
4. **Delete tombstones** — set synchronously before awaits. Assembly completion checks the
   tombstone plus captured config/auth generations before publishing the live handle.
5. **SUSPENDING is non-dispatchable** — a submit arriving mid-suspend joins the pending-submit
   queue and schedules re-hydration after teardown. Production `UserInput` is routed through
   the correlated `session.submit` service RPC; control ops have the state-specific routing
   table in implementation-spec §3. The send-only generic agent handler is not an ACK path.

### 3.3 Hydration is new work (corrected in round 1)

What hydration reuses is the **history reconstruction** inside `createSession({resume})`
(`AgentRegistry.ts:336-338` → rollout replay) — proven code. The orchestration
(open-without-killing-anything, single-flight, capacity) is new Phase-3a work. Today's
`session.resume`/`rewind` kill the live primary first (D7) and become shims over `open()`.

### 3.4 Config/auth changes racing hydration

`AgentConfig` and `AuthContext` each carry a monotonic **generation counter** (new — neither
exists today; the counter is bumped centrally in `AgentConfig.emitChangeEvent()` (spec §4).
`open()` records both at hydration start. After assembly, but before the live handle is
published or HYDRATING → IDLE is emitted, it re-compares and runs
`rebuildExecutionContext(union of reasons)`. A tombstone wins over reconciliation.

### 3.5 Background work is first-class (suspension safety) — corrected in round 2

RUNNING must reflect all live work. Round-2 code tracing sharpened the picture:

- `Session.activeTasks` is no longer a valid busy signal: it retains terminal UI records.
  Add explicit `runningTaskIds`, maintained by every foreground/background/child task path
  from start through `finally`; activeTurn remains a cross-check (D5/D23).
- `ShadowAgentScheduler` — inspectable today via `diagnostics()` (`ShadowAgentScheduler.ts:69-78`);
  a trivial `hasPending()` wrapper suffices. Note `Session.dispose()` **aborts** active shadow
  jobs (`Session.ts:1717-1724`) — gating eviction *before* dispose is what prevents loss.
- Post-turn hook callbacks are awaited, but two callbacks only *launch* work (D26).
  `SessionSummaryHook` reserves a lifecycle-work token synchronously before its detached
  extraction and releases it in the extraction `finally`. Compact/ManualCompact reserve a
  token before engine enqueue and release it from a tracked-submission settlement promise,
  covering the queue gap and all success/failure/cancel paths.
- Task lifecycle `TaskCreated`/`TaskCompleted` hooks are detached today; await them within the
  running-task lifecycle (with existing hook timeouts) before removing `runningTaskIds`.
- **Title generation and the newer prompt-suggestion generation are untracked detached model
  calls**. Both synchronously reserve abortable lifecycle-work tokens with a 30 s grace
  timeout. Suggestion's current flag is set after an await and is not a lifecycle guard
  (D22).

```ts
// Session — composition detail in implementation-spec §6
hasLiveBackgroundWork(): boolean
// = activeTurn tasks ∪ runningTaskIds ∪ shadowScheduler.hasPending() ∪ lifecycleWorkTokens
```

Used by BOTH the LRU victim filter and rebuild deferral. Phase 1 introduces this method with
the first two terms (reusable), Phase 3a extends it — one method, not two implementations.

### 3.6 Two-stage open: new chats never build an agent eagerly (round 2)

`open()` with no `sessionId` **does not assemble an agent**. It creates the ThreadIndex
entry, reserves the unified `sessionId`, returns immediately with `state: 'suspended'`, and
the UI enables input at once. That reserved ID is passed explicitly into `AgentAssembler`;
new, resumed, and forked construction may never mint a replacement ID (D18).

The **first submit** enters the same pending-submit/capacity path as any suspended session.
The submit may be queued when `hardMax` is occupied; queue overflow is a typed retryable
rejection and never drops the user's draft.

`session.reset` is not a lifecycle operation. In lifecycle mode it is rejected; New Chat
uses `session.open({})` and selects the returned ID. The eager compatibility branch keeps
today's reset behavior only while the rollout flag is off, so no split-identity graph can
enter the new manager (D24; spec §17).

Consequences:
- New chat → input ready is one index write — the < 300 ms budget (§10) is trivially met.
- An empty new chat consumes **no live slot** — New Chat itself cannot return `busy`; its
  first send is subject to the bounded execution queue (§1, §4.6).
- PR #326's "lazy agent init on first message" follow-up is **fully adopted**, not partial
  (§9) — and it needs no special-case machinery, because a new chat is just a suspended
  session with an empty rollout.

## 4. Target Architecture — components & contracts

### 4.1 Component ownership map

| Component | Owns (single source of truth) | Explicitly does NOT own |
|---|---|---|
| `ThreadIndex` (new, persisted; §5) | Session list: sessionId, title, timestamps, pinned, deletedAt, durable `agentMode` | conversation content, runtime state |
| `SessionManager` (evolves `AgentRegistry` in place; renamed Phase 5) | Live-session map, runtime state machine, submit/capacity queues, reservations, LRU, hydrate/suspend, config/auth propagation, surface leases, per-live-epoch replay rings, awaiting-input tokens, post-assembly telemetry wrapping | agent construction, UI state |
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
  submit(op: SubmitInput, clientMessageId: string): Promise<SubmitAck>; // ACK, not turn result
  dispatchControl(op: Exclude<Op, SubmitInput>): Promise<void>;
  events: SessionEventSource;        // per-session filtered ChannelEvent view — NOT a new transport
}
```

- **`SubmitAck`, not `SubmitResult`**: turn outcomes arrive later as `ChannelEvent`s.
  `session.submit` is a correlated `ServiceRequest`/`ServiceResponse`, reusing the existing
  `UIChannelClient.serviceRequest` mechanism. It carries a UI-generated `clientMessageId`.
  An immediate queued ACK is followed by a thread-scoped `session_submission_state` event
  when the message is accepted or fails; this is how "sending…" resolves without holding a
  service request open through capacity/hydration (spec §3).
- **`SubmitInput`** is the existing `Op` union narrowed to its `UserInput` variant — there is
  no standalone `UserInput` type today (spec §1).
- **Control ops never enter the hydration queue.** Interrupt and mode use service RPCs;
  approval/compact/history controls target a live handle and reject if stale or suspended.
  The exhaustive disposition table is in spec §3.
- **`SessionEventSource`** is a per-sessionId filtered view over the existing
  `UIChannelClient.onEvent` + `ThreadEventRouter` machinery — no new transport.
- **`AuthContext`**: `current()` / `generation()` / `subscribe()`. Round-2 clarification of
  the "must not cache" rule: it applies to *decision logic* (SessionManager, hydration
  checks). `ModelClientFactory` **holds the `AuthContext` object itself** and reads
  `current()` inside its `tokenProvider`/`refreshAuthorizationToken` closures at call time —
  this is the chosen refactor (spec §4.1); it makes mid-stream token refresh follow auth
  changes without re-pushing managers into factories, and removes the `setAuthManager`
  sweep-push pattern entirely.
- **Single teardown owner**: `AssembledAgent.dispose(reason)` is the only public teardown.
  `reason='suspend'` flushes and releases runtime resources, emits SessionEnd with the
  distinct runtime reason `suspend`, and records no close/abort; delete/shutdown are terminal.
  Hydration emits the matching SessionStart with `start_reason:'hydrate'`. Hook lifecycle
  describes an in-memory graph, not deletion of the durable chat. `AgentSession.terminate()` delegates;
  direct `agent.cleanup()` becomes non-public (D20, spec §5).

### 4.3 Unified construction: `AgentAssembler` (fixes D1, D10)

```ts
interface AgentAssembler {
  assemble(input: {
    sessionId: string;               // reserved before construction; always authoritative
    kind: 'new' | 'resume' | 'fork';
    history: RolloutSnapshot;        // immutable; empty snapshot for new
    sourceSessionId?: string;         // required only for fork
    config: AgentConfig;
    auth: AuthContext;
    services: SessionServices;        // extended with onTitleChanged callback
    preferences: { agentMode: AgentMode };
  }): Promise<AssembledAgent>;
}
```

`RepublicAgent.initialize(auth)` — the parameter is **required**, not optional (an optional
auth would silently reintroduce D1). This changes a zero-arg signature
(`RepublicAgent.ts:151`) and its test constructions; the migration contract is in spec §5.

The extension assembler's full dependency list (approval gate, policy engine, enhancers,
x402, sub-agent tool, TaskOutputStore, skill registry, plugin binder — several of which are
late-bound module state in `service-worker.ts` today) is inventoried in spec §5.2 with the
late-binding strategy. `_setupTabClosureHandling` stays in the registry until Phase 3c.

The assembler translates this input into today's `InitialHistory`; all three variants are
extended to carry the reserved `sessionId`. It owns an idempotent reverse-order cleanup
stack, including plugin binders that currently have no teardown path. `AssembledAgent` is a
defined output type, not an informal tuple (spec §5).

**Credential-read consolidation (D11) preserves the missing-key warning**: the factory
becomes the single reader and surfaces `missing-key` through an assembler-provided callback
that emits today's `BackgroundEvent` warning (spec §5.2) — the second read at
`RepublicAgent.ts:172` is deleted without losing the UX.

### 4.4 One rebuild path (fixes D2, D5, D11)

```ts
async rebuildExecutionContext(reasons: ReadonlySet<RebuildReason>): Promise<void>
```

- `RebuildReason` enum and the reason→work matrix (which steps run per reason: client build,
  prompt recompose, memory refresh, credential read) are **defined in spec §4.3** — v2 named
  the concept but never enumerated it.
- Mutates the existing `TurnContext` (the `hotSwap` behavior). **This is an intentional
  behavior change** for `refreshModelClient` callers (spec §4.3) — they
  currently get a fresh `TurnContext` with policy overrides silently reset; after this they
  keep overrides. That reset is a bug, not a contract.
- Defers on `hasLiveBackgroundWork()` (not just active-turn tasks); deferral stores a
  **pending-reason set** unioned across queued changes, applied at the existing turn-boundary
  flush point (`RepublicAgent.ts:967-978`). `pendingModeSwitch` (session-mode switching)
  remains a separate mechanism — it is a conversation-semantics change, not an execution
  context rebuild (spec §4.3).

### 4.5 Pending-submit queue (HYDRATING / SUSPENDING)

Owned by SessionManager. Bounded FIFO per session (depth 8) plus a bounded global set of
sessions waiting for capacity (32). Every item is `{clientMessageId, input, enqueuedAt}`.
Duplicate `clientMessageId` in the same worker lifetime returns the original ACK and is not
submitted twice. Overflow returns `queue-full`; delete returns `deleted`.

Messages flush FIFO only after IDLE. A queued ACK does not become an accepted ACK later;
instead `session_submission_state` emits `{state:'accepted', submissionId}` or
`{state:'failed', reason}` for that `clientMessageId`. Hydration failure, deletion, and
shutdown fail every affected item visibly/retryably. Accepted turns persist clientMessageId +
input digest in their `turn_start` marker, so attach and startup rebuild the recent ACK cache.
On worker death, a local send with a matching marker becomes accepted; one with no durable
marker becomes `delivery-unknown`, never an automatic retry. An explicit Resend creates a new
clientMessageId and warns that pre-turn side effects cannot be proven absent (D27; spec §14).

### 4.6 Capacity, LRU, and the rules that keep it invisible

- Defaults: `maxLive=5`, `hardMax=10`, `maxPendingHydrations=32`; all are validated
  (`1 <= maxLive <= hardMax`, pending bound > 0).
- Counted: HYDRATING reservations, IDLE, RUNNING, and SUSPENDING managed interactive
  sessions. `type:'scheduled'`, `type:'api'`, and `internal:true` stay on the eager ephemeral
  path and are excluded from this first client lifecycle delivery; config/auth sweeps still
  reach them.
- Classification is total before construction: in client mode only non-internal `primary`
  sessions are managed; every other combination is eager. The eager/non-internal path keeps
  today's independent `AgentRegistry.maxConcurrent` budget (default 5), while `internal:true`
  keeps its bypass. Managed handles do not contribute to that count, and eager handles never
  consume/reserve/evict a managed slot. Headless stays wholly eager with today's registry
  limit semantics. Both classes may share the registry's live map; their counters may not.
- Admission is serialized: if below `maxLive`, reserve; otherwise pick an eligible LRU
  victim; otherwise overshoot below `hardMax`; otherwise place the session in the global
  FIFO. State remains SUSPENDED until a capacity reservation exists; only then HYDRATING.
- Victim eligibility is exact: IDLE, no `hasLiveBackgroundWork()`, no pending submissions,
  no awaiting-input tokens, no unexpired viewed-surface lease, managed interactive. Sort by
  `lastActiveAt`, then `sessionId` for deterministic ties. Re-check before SUSPENDING.
- A victim and requester reservation are paired under the scheduler. Requester assembly
  waits until victim teardown completes; teardown/assembly run outside the scheduler, so
  managed interactive graphs never cross `hardMax`. Completion/failure releases or re-admits and drains
  the FIFO. A submit never waits for this while holding its per-session operation queue.
- Suspend flushes rollout + ThreadIndex before destructive cleanup. Flush failure rolls the
  intact victim back SUSPENDING → IDLE and cancels/re-admits the replacement. Cleanup after a
  successful flush is best-effort and always releases the slot; errors are diagnostic.
- `session.open` used only for view/prewarm may return `{status:'queued'|'busy'}` while
  `session.attach` still returns history. A first send joins the same capacity FIFO. If the
  global queue is full, the submit gets `queue-full` and the UI preserves the draft.

## 5. Persistence & migration

### 5.1 ThreadIndex schema & storage

```ts
interface ThreadIndexEntry {
  sessionId: string;
  title: string;            // '' until first title generation (§7.3)
  searchTitle: string;      // derived NFKC+lowercase title for deterministic search
  titleSource: 'generated' | 'user' | null;
  titleUpdatedAt: number;
  createdAt: number;
  lastActiveAt: number;
  pinned: boolean;
  deletedAt: number | null; // soft delete
  purgeAfter: number | null;
  purgeState?: 'pending' | 'failed';
  agentMode: AgentMode;     // durable; seeds hydration (D17)
  origin: { kind: 'new' } | { kind: 'fork'; sourceSessionId: string };
  schemaVersion: 1;
}
```

**A new object store / table named `thread_index`** — NOT extra fields piggybacked on the
existing `agent_sessions` store (`PersistedSession` shares almost no fields; mixing them
invites shoehorning — round 2, spec §7). Storage engines (round-2 factual correction):
extension → IndexedDB (`IndexedDBAdapter`); **desktop → SQLite**
(`DesktopRuntimeSQLiteAdapter`), which shares the `StorageAdapter` *interface*, not the
engine. No secondary indexes initially — store-side `getAll()` + sort/filter is acceptable
for v1, but the service response is always cursor-paged and benchmarked with 10,000 entries;
unlimited threads must not create an unlimited startup payload (spec §7.2).
**Adding an object store does require IndexedDB `DB_VERSION` 5 → 6**; add `thread_index` to
`STORE_KEY_PATHS`, `STORE_NAMES`, and the Node/desktop SQLite adapter store allowlist.
Writes are serialized per session; routine writes may be scheduled, but suspend and shutdown
await `flush(sessionId)`.

### 5.2 Upgrade backfill

1. One-time, idempotent migration on first post-upgrade run: union rollout metadata and
   `SessionStorage` session IDs. Title prefers rollout metadata; `createdAt` is the minimum
   valid source timestamp; `lastActiveAt` is the maximum; pinned/deleted default false/null;
   `agentMode` is the configured default. Existing non-empty titles migrate as `user`
   (preservation-first). Record a v1 backfill marker only after the scan.
2. Lazy-index safety net: `session.list` indexes any rollout missing an entry even when the
   marker exists (covers a crash or data imported after migration).
3. A newly opened session has a valid empty snapshot `{revision:0, items:[]}` before rollout
   metadata exists; history reads never throw for it.
4. Rewind/fork writes the sliced rollout under its reserved new ID **without an agent** before
   creating an index entry. The entry stores fork provenance; hydration reconstructs the
   already-persisted prefix without writing it twice (spec §7.5).

### 5.3 Soft delete

RUNNING deletion first returns `requires-confirmation` without mutation. The confirmed call
(or any IDLE/SUSPENDED delete) sets the tombstone synchronously, persists `deletedAt` and
`purgeAfter=deletedAt+30 days`, then fails queues/cancels capacity and tears down a live agent
with terminal reason `delete`. Persist-first prevents a crash from resurrecting the row.
Undo before purge clears these fields.

Hard purge is coordinated and retryable: rollout items+metadata, session cache,
`agent_sessions`, token usage (add `TokenUsageStore.deleteSession`), task state and known
task-output chunks, persistent tool results, then the ThreadIndex row **last**. Failure keeps
the soft-deleted row with `purgeState:'failed'` so the next run retries; partial success is
therefore idempotent. Extension retargets the existing `session-cleanup` alarm. Desktop runs
the same coordinator once on startup and from a two-hour unref'd runtime timer; there is no
Chrome alarm in the desktop sidecar.

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
`TabGroupRegistry` exposes `claimExisting`, `createForSession`, `release`, `releaseAll`,
`handleTabClosed`, `groupFor`, and `isOwned`. It serializes mutations globally because
`TabLeaseStore` persists one shared lease blob. Group records live in `chrome.storage.session`.
On suspend, leases/groups are released and tabs are left open and ungrouped; lifecycle must
not destructively close a user's page.

Desktop browser tools execute inside the paired Chrome extension. Phase 3c therefore extends
the bridge envelope with the originating `sessionId` and a focus grant, replaces
`BRIDGE_SESSION_ID`/single `currentTabId` with per-session bridge state, and adds an internal
release-session control used by suspension. The extension-hosted TabGroupRegistry remains
the physical owner; the desktop SessionManager remains the authority for viewed/attention
state (D21, spec §15).

Skill definitions remain a shared catalog, but domain-conditioned availability is not shared
mutable state. Phase 3c replaces the one globally active `SkillDomainFilter` with a pure
per-session view fed by that session's leased/bridge browser context. The instance prompt
loader awaits this view, so a background thread never receives another thread's domain-
conditioned skills (D25; spec §15.2).

### 6.1 Browser resource contention between concurrent sessions (round 2)

Two RUNNING sessions share one physical browser. Rules:
- Per-session tab groups are isolated — a session's tools operate only on tabs it holds
  leases for; cross-session lease theft is not permitted (contended `claim` waits or fails
  tool-level, never silently reassigns).
- **No focus stealing from background sessions**: tab creation is forced to `active:false`;
  cosmetic activation is downgraded. Browser tools receive a session-scoped platform
  adapter, so the policy is enforced below individual tools; the production Chrome API
  inventory to migrate is in spec §15.
- A genuinely foreground-required operation calls
  `requestForeground({sessionId, tabId, reason})`, which creates an awaiting-input token and
  returns a one-shot grant. UI deep-link + `session.resolveAttention({requestId})` verifies
  the surface now views that session and resolves the grant. The platform adapter then
  resumes from a pre-side-effect focus preflight; desktop sends the grant across the bridge.
  Delete/abort rejects it; it is never silently retried after partial side effects.

## 7. UI design (on top of PR #298)

### 7.1 Runtime-state event contract

`SessionRuntimeEvent` is a **new `EventMsg` union member** (not folded into
`BackgroundEvent`'s payload), and — critical, round 2 — it MUST get an
`'session_runtime_state': 'thread'` entry in `EVENT_SCOPE_MAP`
(`src/core/protocol/event-scope.ts`), because unknown types default to `'channel'` scope and
would never reach thread-keyed UI state via `ThreadEventRouter`. Transports are additive on
both the Tauri bridge and server WS wire (verified round 2 — no protocol changes).

Index mutations use a separate channel-scoped `session_index_changed` event so every open
surface updates its left list even when it is viewing another session. Runtime/submission
events remain thread-scoped.

```ts
interface SessionRuntimeEventData {
  sessionId: string;
  state: SessionRuntimeState;
  prevState: SessionRuntimeState;
  awaitingInputCount: number;
  awaitingInputKinds: Array<'approval' | 'foreground'>;
  durability: 'ok' | 'degraded';
  durabilityReason?: 'terminal-marker-write';
  ts: number;
  reason?: 'opened'|'evicted'|'hydration-failed'|'shutdown'|'deleted';
}

// EventMsg member:
// { type: 'session_runtime_state'; data: SessionRuntimeEventData }
```

The manager tracks tokens (`approval:<requestId>`, `foreground:<requestId>`) rather than a
boolean so resolving one of several requests cannot incorrectly clear the badge. Approval
requested/granted/denied/auto-approved and foreground request/resolve are the add/remove
chokepoints; terminal turn events clear orphan tokens.

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

- **Selection highlight**: exactly one locally active session per surface (`▸`). Each web
  document generates an ephemeral `surfaceId` (`crypto.randomUUID()`). Because the extension
  channel uses one-shot `chrome.runtime.onMessage`, viewed protection is a lease rather than
  a disconnect callback: heartbeat every 20 s, TTL 60 s, best-effort release on hide/pagehide.
- **`awaitingInput` badge (`⏳`) is visually distinct from RUNNING (`●`)** and the window
  surfaces an aggregate "N sessions need your input" affordance that deep-links to the
  blocked session (D15). Approval prompts from non-viewed sessions raise this signal — they
  must never only append to an unseen transcript. If the row is outside loaded list pages,
  threadStore resolves it with bounded index-only `session.get` before showing the aggregate.
- **Search**: debounced paged `session.list({query})` over normalized ThreadIndex titles,
  feeding both the panel and the "more…" modal; it is not limited to rows already loaded.
- **Rename**: context-menu → `session.rename` (round 2).
- **New Chat semantics** (round 2): the current conversation demotes to a background item
  (keeps running, keeps its badges); if it is `awaitingInput`, the aggregate affordance keeps
  it reachable.
- **"more…" modal** is the same runtime-aware projection as the panel (badges, open-with-
  hydration, search) — not a static history list.
- **Click** → `session.setViewed` + `session.attach`; render the immutable rollout snapshot
  and replay in the attach response, then optionally call `session.open` to prewarm. Attach
  works while capacity is full because reading history does not construct an agent.
- **Input stays enabled for SUSPENDED/IDLE/HYDRATING/SUSPENDING threads** when global access
  is ready. SUSPENDED/IDLE sends begin admission; HYDRATING/SUSPENDING sends queue and render
  "sending…". RUNNING rejects `busy` and preserves the draft for explicit retry.
- **Failure surfaces**: hydration failure → history visible, "couldn't resume — Retry"
  banner, queued messages marked not-sent; `busy` → retry affordance; cross-epoch unknown
  delivery → explicit warned Resend; delete → undo toast.
- Narrow mode (extension side panel) — **explicit parity list** (round 2): pin/unpin,
  soft-delete/undelete with undo, all runtime badges incl. `awaitingInput`, click-to-open
  with hydration + failure banner, "sending…" queue states, search. Rename and bulk actions
  are wide-mode-only (popup ergonomics).
- Bulk actions (multi-select delete/archive): **explicit non-goal** for this design.

### 7.3 Title lifecycle

`open()` (new) → `''` → UI renders "New chat" → after first assistant turn, title generation
(now tracked background work, §3.5) invokes injected
`SessionServices.commitGeneratedTitle(sessionId,title)` → one serialized manager decision
over rollout metadata + ThreadIndex + thread event. A `titleSource:'user'` rename wins and
auto-generation becomes a no-op; reconciliation repairs a crash between the two writes.
Full title-gen extraction from `Session` stays in D12 follow-up scope.

### 7.4 RPC surface

| RPC | Change |
|---|---|
| `session.open` (new) | Create index-only or request hydration/prewarm. Returns `{sessionId,state,capacityStatus,liveCount,maxLive,title}`. Never required merely to view history. |
| `session.attach` (new) | `{surfaceId,sessionId,after?}` → ThreadIndex entry + immutable rollout snapshot + runtime state + replay cursor/ring (§7.5). Primary UI attach API. |
| `session.getRollout` (new) | Lower-level read-only `{sessionId}` → `{revision,items}` using the same manager snapshot loader as attach/hydration. Empty new chat returns revision 0. |
| `session.list` | ThreadIndex entries (excl. soft-deleted) + runtime state + `awaitingInput`. |
| `session.pin`/`unpin`, `session.rename` (new), `session.delete`/`undelete` (new) | Index mutations; delete soft. |
| `session.setViewed` / `session.releaseSurface` | Explicit `surfaceId`; atomic replace of that surface's viewed session; 60 s lease expiry. Feeds only LRU ineligibility—the visual highlight stays UI-local. |
| `session.submit` (new) | Correlated UserInput ACK path with `clientMessageId`; queued completion uses `session_submission_state`. Registered on clients and as direct-accept passthrough on headless server for API uniformity. |
| `session.setMode` / `agent.interrupt` | Durable mode mutation and existing interrupt service route; neither uses the generic UserInput queue. |
| `session.resolveAttention` (new) | Completes a foreground-awaiting token only after the calling surface views the session. |
| `session.turns`, `session.rewind` | Require explicit `sessionId` (D16); rewind = fork + open, never kills the source. |
| `session.getActiveCount` | Deprecated for UI (counts on `open`/`list`). |
| `session.getState` | Deprecated for history fetching (throws for suspended sessions — round 2); superseded by `session.getRollout` + live events. |
| `session.create`, `session.resume` | Compat shims. Phase 1 drops create's redundant refresh; Phase 3a routes both to `open()`. Phase 5 removes in-repo callers but keeps aliases for at least two stable releases. |

### 7.5 Background conversation streaming (round 2 — was unspecified and at risk)

Today, switching works only because `Main.svelte` incidentally retains per-session event
maps. The explicit contract is:

- SessionManager is the **sole outbound event chokepoint**. It removes the service worker's
  100 ms `getNextEvent()` broadcaster (D19), assigns `{runtimeEpoch,eventSeq}` to every live
  event, broadcasts it, and stores it in a ring capped at 512 events or 1 MiB.
- `runtimeEpoch` is a UUID per hydration attempt (safe across worker restarts); `eventSeq` starts at
  1. The epoch records its
  `baseRolloutRevision`. On committed IDLE, the manager refreshes the snapshot and clears the
  ring. A truncated ring is explicitly reported.
- `session.attach({after})` returns `{snapshot:{revision,items}, replay:{runtimeEpoch,
  firstSeq,throughSeq,truncated,events}}`. `loadSnapshot(sessionId)` is single-flight and is
  shared by attach and hydration so both consume the same immutable object/revision.
- While attach is in flight the UI buffers incoming target-session events. It applies the
  snapshot, then replay, drops buffered events `<= throughSeq` in that epoch, then applies
  the rest. Dedupe key is `(runtimeEpoch,eventSeq)`. If `truncated`, show a partial-output
  notice and refresh the committed rollout when the terminal event/IDLE arrives.
- `threadStore` owns per-session conversation buffers, attach cursors, runtime state, and
  pending submissions. ThreadIndex is its durable list projection; the old chat-history
  store/resume bridge and `Main.svelte`'s separate `threadStates` map cease being primary
  sources of truth.
- The ring and pending queue are in-memory. Worker death loses uncommitted partial output;
  committed turns and client IDs come from rollout. Attach reconciles matching sends and
  marks unproven sends delivery-unknown; it never retries automatically (D27).

## 8. Session independence guarantees (goal 1)

| Channel | Today | Target |
|---|---|---|
| Agent object graph | Fully per-session — kept | Same, via one `AgentAssembler` |
| Model client / auth | Per-session factory; sweep-pushed auth (D1/D10) | `AuthContext` held by factory, read at call time (§4.2); generation-checked hydration |
| Config events | Every agent (incl. disposed) self-subscribes (D3/D4) | Only SessionManager subscribes (client); deferral incl. background work |
| Prompt static context | Process-global first-agent-wins (D6) | Per-agent, moved into Phase 2 before multi-session UI |
| Domain-conditioned skills | One globally active-tab filter feeds every prompt (D25) | Shared immutable catalog + per-session browser-context view (§6.1) |
| Tabs | Session-owned groups; closure kills session (D9) | Leased via `TabGroupRegistry`; no focus stealing from background sessions (§6.1) |
| Approvals | Background approvals invisible (D15) | `awaitingInput` state + aggregate affordance (§3.1, §7.2) |
| Streaming | Incidental UI-map buffering + duplicate extension outbound path | One manager chokepoint, sequenced replay ring + threadStore buffers (§7.5) |
| Submission concurrency | `_submitting` per session, bypassed by real send path | Correlated `session.submit` service ACK + bounded manager queue (§3.2) |

## 9. PR #326 absorption map (goal 4)

Full PR #326 claim list is quoted in review-log.md round 2 for verifiability (round-2
finding: the map was self-asserted).

| PR #326 item | Resolution |
|---|---|
| Removed redundant `refreshModelClient()` from `session.create` | Structural (auth as construction input, §4.3). **Interim regression closed**: because #326 was closed unmerged, main currently carries the redundant call (`session-services.ts:307`); an **expedited Phase-1 patch** deletes it standalone (shape-compatible) so users aren't regressed until Phase 2 (round 2). |
| `Promise.all` post-create round trips | Superseded: counts on `open` response; tab binding leaves the create path. |
| Regression test: no double-compose | Re-implemented against `AgentAssembler` (Phase 2), both platforms. |
| Follow-up: optimistic render | §7.2 + `session.attach` + single-snapshot rule. |
| Follow-up: lazy agent init on first message | **Fully adopted** via two-stage open (§3.6) — no longer partial. |
| Follow-up: `activeCount` in create response | `session.open` response. |
| Follow-up: perf test on real path | Phase 2 real-`assemble()` assertion; Phase 3a hydration-budget test; §10 field metrics. |

## 10. Latency budgets & observability

| Interaction | Budget | How |
|---|---|---|
| Click suspended session → history visible | < 150 ms | `session.attach` snapshot render (no hydration) |
| Click suspended session → send enabled | < 1 s | Single-init hydration, auth pre-wired |
| New chat → input ready | < 300 ms | Two-stage open: index write only (§3.6) |

Field metrics use the existing privacy-gated `core/telemetry.logEvent` API (not
`DiagnosticRegistry`, which registers doctor checks): `session_hydrated`, `session_suspended`,
`session_evicted`, `session_capacity_queued`, `session_hydrate_failed`, and
`session_submission_queued`, with numeric duration/live/depth metadata only. A new lifecycle
doctor check reports current live/reservation/queue counts for local diagnostics. Tests
attach a memory telemetry sink and assert emission; production remains fail-closed when the
telemetry gate is off.

## 11. MV3 service-worker death: recovery matrix

| State at death | On wake |
|---|---|
| SUSPENDED | Durable by design. |
| IDLE | Appears SUSPENDED (live map is memory-only); rollout flushed at last turn boundary. |
| HYDRATING | Reads were read-only; appears SUSPENDED; UI retry path. Pending queue lost visibly. |
| RUNNING | In-flight turn lost. Phase 3 adds persisted `turn_start{submissionId,clientMessageId,inputDigest}` and terminal `turn_completion{submissionId,outcome}` markers at TaskRunner's lifecycle seams. On wake, an unmatched start is closed exactly once with persisted `TurnAborted(reason='worker_restart')` + terminal marker and surfaced on attach; the client ID also reconciles any orphaned UI send. Incremental checkpointing is out of scope. |

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
   so the UX contract is reviewable and validated earlier without changing the destination;
   the client rollout flag still keeps it disabled until the coordinated Phase-4 cutover.

## 13. Risks & validation targets

1. Suspension safety — `hasLiveBackgroundWork()` gates eviction AND deferral; every detached
   or internally queued owner in §3.5 must acquire a lifecycle-work token synchronously.
2. Hydration correctness — replay is proven; orchestration is new; single-flight/tombstone
   test matrix in Phase 3a.
3. MV3 — §11; RUNNING-turn loss accepted and surfaced.
4. `maxLive`/`hardMax` defaults are configuration knobs, but admission and queue behavior are
   fixed by §4.6 and spec §11; tuning cannot change correctness.
5. External RPC consumers of `session.create`/`resume` are unverified. Phase 5 removes
   in-repo uses but keeps external aliases for at least two stable releases; removal is a
   separate compatibility decision, never inferred from local telemetry silence. Lifecycle-
   mode `session.reset` deliberately rejects because its old ID-mutation semantics cannot be
   represented safely; the bundled UI is migrated before the flag flips.
6. simplify_session slippage blocks 3a/4 (not 1–2).
7. **Goal-1 gating**: the promise is only true after Phase 2's per-agent prompt context,
   3b's config sweep, and 3c's tab decoupling. Phase 4 is gated on all of them.
8. **Safe phased landing**: the client lifecycle/browser changes in 3a and 3c ship behind
   compile-time `MULTI_THREAD_LIFECYCLE=false` because today's UI still requires eager
   create/send/close/history. Phase 3b config centralization is active on every registry and
   is not flag-gated. Phase 4 migrates client paths and enables the flag atomically; Phase 5
   removes the client flag after one stable release.
