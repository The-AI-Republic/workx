# Multi-Thread Session Management — Task Breakdown

Companion to [design.md](./design.md) (v2). Each phase lands green independently.
Lifecycle phases (3a/3b/3c/4) are **client-only** (extension + desktop); Phase 2 covers all
platforms including server — see design.md §1 scope.

## Phase 0 — Unblock (prerequisites)

- [ ] Merge PR #298 (left-panel chat history)
- [x] Close PR #326 with a comment linking this design (done 2026-07-14)
- [ ] Land `simplify_session` prerequisites this design consumes: unified `sessionId`
      end-to-end + `ChannelEvent{msg, sessionId}` envelope with per-session UI routing
      (**gates Phase 3a and Phase 4**; Phases 1–2 are NOT blocked)

## Phase 1 — Correctness patches (small, independently shippable PRs)

- [ ] **D4** Move `config-changed` subscription from `RepublicAgent` constructor to end of
      `initialize()`; unsubscribe in `cleanupOnce()`
      (`src/core/RepublicAgent.ts:316`, `:1411-1443`)
- [ ] **D5** Running-work deferral in `refreshModelClient()`/`hotSwapModelClient()` — using
      the **corrected** busy signal: `activeTurn` tasks ∪ `Session.activeTasks` (the current
      `getRunningTasks()` misses background/sub-agent tasks; design §3.5)
- [ ] **D2 (step 1)** Introduce `rebuildExecutionContext(reasons: Set<RebuildReason>)` that
      mutates the existing `TurnContext`; deferral stores a pending-reason **set** (union
      applied at turn boundary — a queued prompt-recompose must survive a later model change);
      `refreshModelClient`/`hotSwapModelClient` become thin aliases
- [ ] Regression tests: no listener after cleanup; no mid-turn swap (incl. background-task-only
      case); TurnContext policy fields survive rebuild; reason-union applied

## Phase 2 — Construction unification (ALL platforms; one coordinated cutover PR)

> Note: this phase changes `RepublicAgent.initialize()`'s signature and both construction
> call sites together — it is a single coordinated cutover, not per-platform incremental.

- [ ] **`AuthContext`** (design §4.2): `current()` / `generation()` / `subscribe()`; owned by
      platform bootstrap (`service-worker.ts`, `ServerAgentBootstrap.ts`)
- [ ] **`AgentAssembler`** contract (§4.3) with phased internals construct → initialize →
      wire (§4.4); `ServerAgentAssembler` from the `agentFactory` closure;
      `ExtensionAgentAssembler` extracted from `AgentRegistry.ts:172-259` **absorbing the
      `onAgentCreated` consumers** (`service-worker.ts:351-378`); delete `onAgentCreated`;
      both platforms return a real `subAgentRunner`; telemetry wrapping stays in the registry
- [ ] `RepublicAgent.initialize(auth)` — model client built once, correctly (**D1**); delete
      server init-then-refresh (`ServerAgentBootstrap.ts:348-351`) AND `session.create`'s
      post-create refresh (`session-services.ts:307`) — same request/response shape (shim
      schedule §7.4)
- [ ] `AssembledAgent.dispose()` as the single public teardown; `AgentSession.terminate()`
      delegates; direct `agent.cleanup()` made non-public (**§4.2**)
- [ ] Single `applyAuth()` sweep; delete the 4 hand-rolled loops (**D10**)
- [ ] Single credential-store read per build; reason-scoped rebuild work (**D11**)
- [ ] `SessionServices` threading for construction-graph `SessionCacheManager` sites
      (`AgentRegistry.ts:183`, `service-worker.ts:388`) — StorageTool sites are out of scope
- [ ] **Tests (absorb PR #326)**: assemble() composes prompt / inits memory exactly once, both
      platforms; real-path perf assertion

## Phase 3a — Lifecycle state machine + ThreadIndex (client-only)

- [ ] Runtime states + **transition table** (§3.1) enforced like today's
      `VALID_STATE_TRANSITIONS`; illegal transitions throw
- [ ] **Concurrency discipline** (§3.2): per-session op queue (single-flight `open`),
      capacity mutex, delete tombstones, non-dispatchable SUSPENDING with submit-guard
- [ ] `ThreadIndex` store (schema §5.1) + one-time backfill + lazy-index safety net (§5.2)
- [ ] `open(sessionId?)` create-or-continue (multi-session-safe — replaces the
      kill-the-primary resume, §3.3); `suspend()` (idempotent); LRU with **viewed-session
      ineligibility** (§4.6); `busy` result + pending-open queue + `capacity-freed` drain
- [ ] Generation counters on `AgentConfig`/`AuthContext`; post-assemble reconciliation (§3.4)
- [ ] `Session.hasLiveBackgroundWork()` (§3.5); post-turn continuations register as tracked
      work with grace timeout; `background-idle` event; RUNNING derived from it
- [ ] Pending-submit queue in SessionManager (§4.5): bounded, ordered flush, retryable
      returns on hydration failure
- [ ] Soft delete + undelete + retention wipe; wire a periodic caller for the cleanup job (§5.3)
- [ ] `SessionRuntimeEvent` emission (§7.1); legacy state event kept during migration
- [ ] Delete `AgentRegistry.resumeSession()`; startup loads ThreadIndex only (**D7**)
- [ ] RPC shims: `session.create` → `open()`; `session.resume` → `open(sessionId)`;
      `session.rewind` → fork + `open`; deprecation telemetry on old verbs (§7.4)
- [ ] MV3 recovery (§11): interrupted-turn marker on wake for RUNNING-at-death
- [ ] Test matrix: double-open coalescing, delete-while-hydrating tombstone,
      hydration-failure → SUSPENDED (retryable, never stuck), concurrent-eviction victim
      reservation, suspend-vs-submit race, hydration-latency budget
- [ ] Metrics (§10) via DiagnosticRegistry

## Phase 3b — Central config propagation (client-only; can land before or after 3a)

- [ ] SessionManager subscribes once to `config-changed`; parallel sweep with per-session
      deferral (**D3**); remove per-agent self-subscription
- [ ] Extension `agent.configUpdate` becomes the same in-place sweep; delete the destroy-all
      override (`service-worker.ts:782-822`) (**D8**)

## Phase 3c — Tab decoupling (client-only; orthogonal, sequence last)

- [ ] `TabGroupRegistry` over `TabLeaseStore` (§6): group lifecycle + letter allocation moved
      from `AgentSession`/`AgentRegistry`
- [ ] Remove `AgentSession._metadata.tabId/tabGroupId` and `Session.setTabId` (**D9**);
      SessionHandle read-through view
- [ ] Lazy tab/group acquisition on first browser-tool use; release on suspend
- [ ] Tab closure releases lease + tool-level error; never terminates the session

## Phase 4 — UI (on top of PR #298; gated on Phase 0 simplify_session items)

- [ ] `session.open`/`list`/`pin`/`unpin`/`delete`/`undelete` wiring in `Main.svelte` +
      left panel; drop UI `session.getActiveCount` (**D14**)
- [ ] Thread list: pinned-first sort, RUNNING indicator from `SessionRuntimeEvent`,
      click-to-open with optimistic render from the **same** rollout snapshot hydration
      replays (§7.2 no-divergence rule)
- [ ] Send gated on IDLE; "sending…" for queued; failure surfaces: retry banner, busy
      auto-retry, delete undo toast (§7.2)
- [ ] Title lifecycle: "New chat" placeholder → `updateTitle` after first turn (§7.3)
- [ ] Remove the in-chat tab strip; `threadStore` keyed by `sessionId`
- [ ] Narrow-mode popup gains indicators

## Phase 5 — Convergence & cleanup

- [ ] Per-agent prompt static context; remove first-agent-wins composer guard
      (`PromptLoader.ts:36-85`) (**D6**)
- [ ] Delete `refreshModelClient`/`hotSwapModelClient` aliases
- [ ] Remove deprecated `session.create`/`resume` verbs if telemetry shows no external callers
- [ ] Mechanical rename `AgentRegistry` → `SessionManager` (§12.1)
- [ ] Update `.ai_design/architecture.md` session section to point here

## Explicit non-goals (tracked separately)

- `Session.ts` god-object decomposition (**D12**) — guardrail: new features go into injected
  collaborators
- StorageTool-owned `SessionCacheManager` duplication (outside construction graph)
- Engine/turn loop, tool orchestration, approval system changes
- Sub-agent/shadow-agent creation changes
- Server-mode lifecycle/tenant-scoping (design §1 scope decision)
- Cross-machine session sync (§5.4)
- Incremental turn checkpointing for MV3 RUNNING-death recovery (§11)
