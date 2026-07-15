# Multi-Thread Session Management — Task Breakdown

Companion to [design.md](./design.md) (v3) and [implementation-spec.md](./implementation-spec.md)
(spec § references below). Lifecycle phases (3a/3b/3c/4) are **client-only**; Phase 2 covers
all platforms. **Gating: Phase 4 requires 3a + 3b + 3c** (design §13.7 — shipping the
many-sessions UI while config-update still destroys sessions (D8) or tab closure kills them
(D9) amplifies the exact bugs this design fixes).

## Phase 0 — Unblock (prerequisites)

- [ ] Merge PR #298 (left-panel chat history)
- [x] Close PR #326 with a comment linking this design (done 2026-07-14)
- [ ] Land `simplify_session` prerequisites: unified `sessionId` end-to-end +
      `ChannelEvent{msg, sessionId}` envelope with per-session UI routing
      (**gates 3a and 4**; Phases 1–2 NOT blocked)

## Phase 1 — Correctness patches (small, independently shippable PRs)

- [ ] **Expedited #326 patch** (spec §16): delete the post-create `refreshModelClient()` in
      `session.create` (`session-services.ts:307`) + port the no-double-compose regression
      test — closes the user-facing latency regression opened by closing #326
- [ ] **D4** Subscribe `config-changed` at end of `initialize()`; unsubscribe in
      `cleanupOnce()` (`RepublicAgent.ts:316`, `:1411-1443`)
- [ ] **D5** `Session.hasLiveBackgroundWork()` v1 — `activeTurn` tasks ∪ `activeTasks`
      (spec §9); used by all rebuild deferral
- [ ] **D2** `rebuildExecutionContext(reasons: Set<RebuildReason>)` per spec §2:
      reason→work matrix, mutate-in-place TurnContext (intentional behavior change — verify
      the 7 call sites), pending-reason set unioned at the flush point
      (`RepublicAgent.ts:967-978`); `refreshModelClient`/`hotSwapModelClient` become aliases;
      `pendingModeSwitch` stays separate
- [ ] Regression tests: no listener after cleanup; no mid-turn swap (incl.
      background-task-only case); TurnContext policy fields survive rebuild; reason-union

## Phase 2 — Construction unification (ALL platforms; one coordinated cutover PR)

> Coordinated cutover: `initialize(auth)` changes a zero-arg signature and both construction
> call sites together; test migration via `TestAuthContext.none()` (spec §4.2).

- [ ] **`AuthContext`** (design §4.2, spec §5): `current()`/`generation()`/`subscribe()`;
      owned by platform bootstrap
- [ ] **`ModelClientFactory` holds `AuthContext`** (spec §5): token closures read
      `current()` at call time; DELETE `setAuthManager` and all four sweep-push sites (**D10**)
- [ ] **`AgentAssembler`** (spec §4): `ServerAgentAssembler` from the closure;
      `ExtensionAgentAssembler` absorbing the 10-item dependency inventory with lazy-getter
      provider bag for late-bound service-worker state; delete `onAgentCreated`
      (extension-only); both platforms return real `subAgentRunner`; telemetry wrapping
      stays in the registry; `_setupTabClosureHandling` stays until 3c
- [ ] `RepublicAgent.initialize(auth)` **required** param (**D1**); delete server
      init-then-refresh (`ServerAgentBootstrap.ts:348-351`)
- [ ] `AssembledAgent.dispose()` single teardown; `terminate()` delegates; `cleanup()`
      non-public
- [ ] Credential single-read + `onMissingKey` warning callback (**D11**, spec §6)
- [ ] `SessionServices` extension for construction-graph cache sites (StorageTool out of scope)
- [ ] **Tests**: assemble() composes prompt / inits memory exactly once, both platforms;
      real-path perf assertion; token closure follows AuthContext change mid-lifetime

## Phase 3a-1 — ThreadIndex + two-stage open (visible Goal-3 skeleton, low concurrency risk)

- [ ] `PerKeyOperationQueue` generalized from `LeaseLifecycleQueue` (spec §7)
- [ ] `thread_index` store: IndexedDB `DB_VERSION` 5→6 + SQLite table (spec §11); schema §5.1
- [ ] One-time backfill + lazy-index safety net (design §5.2)
- [ ] **Two-stage `open()`** (design §3.6): no-sessionId → index entry only, no agent;
      first submit hydrates. New chat never consumes a live slot
- [ ] `session.getRollout` RPC (spec §12) + extract the shared raw-rollout→renderable
      transform; replace `restoreAllThreadHistories`' live-agent pattern (**D14**)
- [ ] `session.pin`/`unpin`/`rename`/`delete`/`undelete`; soft delete + retarget the
      existing `session-cleanup` alarm (`service-worker.ts:1793,1824`) to retention (§5.3)
- [ ] `session.setViewed` + per-surface viewed set with disconnect expiry (spec §10)
- [ ] `session.turns`/`session.rewind` take explicit `sessionId`; delete
      `_primarySessionId`/`getPrimarySession()` (**D16**)
- [ ] Generation counters on `AgentConfig` (bump in `emitChangeEvent`) + `AuthContext` (spec §8)
- [ ] `SessionRuntimeEvent` + `EVENT_SCOPE_MAP['session_runtime_state']='thread'` (spec §13)
- [ ] Legacy↔new state mapping: `legacyState()` compat getter; new transition table replaces
      `VALID_STATE_TRANSITIONS` (spec §15); legacy event keeps firing

## Phase 3a-2 — Suspend/hydrate + capacity (the heavy machinery)

- [ ] Full runtime state machine per design §3.1 (illegal transitions throw)
- [ ] Single-flight open, capacity mutex, delete tombstones (design §3.2)
- [ ] **Submit-path rewiring** (spec §3): the three `service-worker.ts` direct
      `submitOperation` sites route through `SessionHandle.submit`; SUSPENDING/HYDRATING
      hit the pending queue; guard actually guards production sends
- [ ] Hydration (multi-session-safe, design §3.3): `open(sessionId)` without killing
      anything; `session.create`/`resume` shims route to `open()`; deprecation telemetry
- [ ] `suspend()` idempotent; LRU with viewed-session ineligibility; `busy` +
      pending-open queue + `capacity-freed` drain (design §4.6)
- [ ] Post-assemble generation re-check (design §3.4)
- [ ] `hasLiveBackgroundWork()` v2: + `shadowScheduler.hasPending()` + title-gen
      `_pendingContinuations` tracking with 30 s grace (spec §9); `background-idle` event
- [ ] Pending-submit queue (design §4.5): bounded, ordered flush, retryable returns
- [ ] `awaitingInput` attribute: approval-request/resolve wiring → runtime event (**D15**)
- [ ] Delete `AgentRegistry.resumeSession()` (**D7**); startup loads ThreadIndex only
- [ ] MV3: interrupted-turn marker on wake (design §11)
- [ ] **Test matrix**: double-open coalescing; delete-while-hydrating; hydration-failure →
      SUSPENDED retryable; concurrent-eviction victim reservation; suspend-vs-submit race;
      queued-messages-on-failure; generation-race reconciliation; hydration-latency budget
- [ ] Metrics (design §10) via DiagnosticRegistry

## Phase 3b — Central config propagation (client-only; may precede 3a)

- [ ] SessionManager subscribes once to `config-changed`; parallel sweep with per-session
      deferral (**D3**); remove per-agent self-subscription
- [ ] Extension `agent.configUpdate` = in-place sweep; delete destroy-all override
      (`service-worker.ts:782-822`) (**D8**)

## Phase 3c — Tab decoupling (client-only; REQUIRED before Phase 4)

- [ ] `TabGroupRegistry` over `TabLeaseStore` (design §6): groups + letters moved from
      `AgentSession`/`AgentRegistry`
- [ ] Remove `AgentSession` tab fields + `Session.setTabId` (**D9**); handle read-through
- [ ] Lazy acquisition; release on suspend; closure never terminates a session
- [ ] **Contention rules** (design §6.1): no cross-session lease theft; no focus stealing
      from non-viewed sessions — foreground-requiring automation raises `awaitingInput`

## Phase 4 — UI (gated on 3a + 3b + 3c + Phase-0 simplify_session)

- [ ] Left panel per design §7.2: pinned-first, selection highlight (one viewed per window),
      `●` RUNNING vs `⏳` awaitingInput badges, "N sessions need your input" aggregate with
      deep-link, search filter, rename, New-Chat demote semantics, runtime-aware "more…" modal
- [ ] Click-to-open: optimistic render from `session.getRollout` snapshot (same-snapshot
      rule); send gated on IDLE; "sending…" queue states; failure surfaces (retry banner,
      busy auto-retry, delete undo toast)
- [ ] **Background streaming** (design §7.5): SessionManager per-session replay ring;
      `threadStore` keeps per-session conversation buffers — do NOT reduce to
      index+state projection
- [ ] `SidePanelThread` shape extension; remove `ThreadBar`/`ThreadTab` (spec §14)
- [ ] Drop UI `session.getActiveCount` + `session.getState`-for-history (**D14**)
- [ ] Narrow-mode parity list (design §7.2): pin, delete/undelete+undo, all badges,
      open+failure banner, "sending…", search (rename/bulk = wide-only)

## Phase 5 — Convergence & cleanup

- [ ] Per-agent prompt static context; remove first-agent-wins guard
      (`PromptLoader.ts:36-85`) (**D6**)
- [ ] Delete `refreshModelClient`/`hotSwapModelClient` aliases; delete legacy
      `SessionStateChangedEvent` + `legacyState()` once consumers migrate
- [ ] Remove deprecated `session.create`/`resume` if telemetry silent
- [ ] Mechanical rename `AgentRegistry` → `SessionManager`
- [ ] Update `.ai_design/architecture.md` session section

## Explicit non-goals (tracked separately)

- `Session.ts` god-object decomposition (**D12**) — guardrail: new features via injected
  collaborators
- StorageTool-owned `SessionCacheManager` duplication (outside construction graph)
- Bulk/multi-select thread actions (design §7.2)
- Engine/turn loop, tool orchestration, approval-system changes
- Sub-agent/shadow-agent creation changes
- Server-mode lifecycle adoption (single-tenant headless today; design §1)
- Cross-machine session sync; incremental turn checkpointing for MV3 (design §11)
