# Design Review Log — Multi-Thread Session Management

## Review round 1 — 2026-07-14 (against DRAFT v1)

Three independent adversarial reviewers: a code-grounded fact-checker, a concurrency/lifecycle
reviewer, and a senior-architect reviewer. Combined verdict: **NEEDS-REVISION** (direction
approved; specification gaps). All findings below are resolved in DRAFT v2 unless marked.

### Critical

| Finding | Resolution in v2 |
|---|---|
| Hydration premise false: `session.resume` today terminates the live primary session (`session-services.ts:151-155`) — "reuses exactly that path" could not support parallel sessions | §3.3 rewritten: history replay is reused; orchestration is declared NEW work; D7 evidence extended |
| State machine unsound: no transition table, no single-flight, undefined failure states (double-hydrate, delete-resurrection, stuck-HYDRATING soft-lock, LRU victim races, dispatchable SUSPENDING) | §3.1 full transition table incl. DELETING + failure transitions; §3.2 concurrency discipline (per-session op queue, capacity mutex, tombstones, non-dispatchable SUSPENDING) |
| Server "multi-tenancy": reviewer flagged global config sweep / shared LRU / user-less ThreadIndex as wrong for a shared server process. **Team correction (2026-07-14): server mode is single-tenant today** — one user per dedicated headless instance; the reviewer over-read the enterprise aspirations in server_mode_design.md and the `userId` auth field. | §1 scope decision (revised rationale): Phase 2 applies to all platforms; Phase 3+ lifecycle is client-only for the first delivery because the server has no thread-list UI and is channel-driven — not because of tenancy. Tenant-scoping noted as a caveat only if multi-tenancy ever lands. |
| ThreadIndex had no schema, storage target, or migration — pre-upgrade conversations would vanish from the new single-list UI | §5: schema, IndexedDB target, one-time backfill + lazy-index safety net |

### High

| Finding | Resolution |
|---|---|
| Background work invisible to lifecycle: `getRunningTasks()` excludes the disjoint `Session.activeTasks`; post-turn continuations (title gen, memory extraction, summary hook) gate nothing → suspension data loss; rebuild deferral shares the blind spot | §3.5 `hasLiveBackgroundWork()` used by LRU filter AND deferral; continuations register as tracked work; D5 evidence extended |
| `SessionHandle`, `AuthContext` undefined; `AssembledAgent.dispose` risked a third cleanup path | §4.2 contracts defined; dispose declared the single public teardown, `terminate()` delegates, direct `cleanup()` forbidden |
| simplify_session treated as "companion" but is a hard prerequisite (ThreadIndex keys, ChannelEvent envelope) | Promoted to gated Phase 0 prerequisite; risk §13.6 |
| TabLeaseStore cannot be "sole owner" — no group/letter semantics (they live in AgentSession/AgentRegistry) | §6 introduces `TabGroupRegistry` over TabLeaseStore; scoped as own sub-phase 3c |
| MV3 "more robust than today" overclaim — RUNNING sessions lose in-flight turns with no recovery story | §11 per-state recovery matrix; interrupted-turn marker; claim narrowed |
| Message queue during HYDRATING: owner/failure/ordering/durability undefined | §4.5: SessionManager-owned bounded FIFO, ordered flush, retryable returns on failure, visible-loss durability stance |
| Runtime-state event contract to UI undefined | §7.1 `SessionRuntimeEvent` |
| Multi-window consistency undefined | §5.4 single-SessionManager-process invariant |
| Phase 3 overloaded (5 risky changes) | Split into 3a (lifecycle+index), 3b (config propagation), 3c (tabs) |
| LRU can evict the session the user is viewing | §4.6 viewed-session ineligibility |
| At hardMax running, user can't open a new chat — contradicts "no limit" promise | §1 honest-bound statement; §4.6 pending-open queue + capacity-freed auto-retry |
| Auth/config change during hydration is a lost update | §3.4 generation counters + post-assemble reconciliation |

### Medium / accuracy

| Finding | Resolution |
|---|---|
| D3 evidence imprecise: cited server path emits only `policy` events, ignored by self-subscription; real overlap is with the auth-services/agent-services direct sweeps; server sweep is sequential, not parallel | D3 rewritten with corrected mechanism |
| "Kills the 4x SessionCacheManager" overstated (2 of 4 sites are tool-owned, outside the construction graph) | §4.3 scope-corrected note |
| D14 citation wrong (`Main.svelte:1301` is `bindToActiveTab`; the second call is `:1299`) | Corrected |
| `session.create`'s own `refreshModelClient()` (`session-services.ts:307`) is a third D1 compensation instance, back on main since #326 closed | Added to D1 |
| "Kept for server API consumers" unsubstantiated — only `Main.svelte` consumes these verbs in-repo | §7.4 softened + deprecation telemetry; risk §13.5 |
| AgentAssembler glossed over: telemetry wrapping lives outside agentFactory; `onAgentCreated` subAgentRunner asymmetry (server passes null); wiring steps have strict post-initialize ordering | §4.4 assembly phases; onAgentCreated deleted; both platforms return real subAgentRunner; telemetry stays with SessionManager |
| Deferred rebuilds collapse multiple reasons into one boolean — a queued prompt-recompose can be dropped by a later model change | §3.4/§3.5: pending-reason set, union applied at turn boundary (folded into rebuildExecutionContext spec) |
| Title generation for the list unspecified | §7.3 title lifecycle |
| No observability plan for latency budgets | §10 field metrics |
| UI error surfaces beyond `busy` missing | §7.2 failure surfaces |
| Compat shims mis-phased (session.create's body must change in Phase 2, not 4) | §7.4 shim schedule |
| Phase 2 is a coordinated two-platform cutover, not independently shippable per platform | tasks.md Phase 2 note |
| No alternatives-considered section | §12 (evolve-in-place chosen; process-per-session rejected; memory-pressure eviction deferred) |
| `delete` = irreversible rollout wipe behind one confirm — data-loss regression vs non-destructive close | §5.3 soft delete + undo + retention |
| `hardMax` busy result had no drain/back-pressure | §4.6 pending-open queue + capacity-freed event |

### Not adopted (with rationale)

- **Always permit a new chat regardless of RUNNING count** — would break the hardMax
  invariant that bounds total live agent graphs; instead the bound is stated honestly (§1)
  and softened by auto-retry UX (§4.6).
- **Durable (worker-death-surviving) pending-submit queue** — complexity not justified;
  loss is made visible instead of silent (§4.5).

## Review round 2 — 2026-07-14 (against DRAFT v2; focus: implementation-readiness + goals satisfaction)

Three reviewers: implementation-readiness (phase-by-phase walk vs code, 21 findings),
goals re-evaluation (journey tracing, 14 findings), type/interface feasibility (8 contract
checks). Round-1 verdict on v2's direction upheld; v2 was NOT implementation-ready.
All findings below resolved in DRAFT v3 + the new implementation-spec.md.

### Goal-by-goal verdict on v2 (drove the v3 changes)

| Goal | v2 verdict | Chief gaps |
|---|---|---|
| 1 Parallel multi-session | PARTIAL | invisible background approvals; unspecified background streaming; tab focus contention |
| 2 Well-managed instances | PARTIAL | "primary session" survived; viewed-set unowned; eager new-chat assemble |
| 3 Thread model | PARTIAL | narrow-mode degraded; no search/rename/selection-highlight/New-Chat semantics |
| 4 Absorb #326 | PARTIAL | self-asserted map; lazy-init punted; regression window from closing #326 |

### Implementation blockers (v3 resolutions)

| Finding | Resolution |
|---|---|
| No legacy↔new state mapping; 17 production call sites read the old 4-state enum | spec §15: mapping table + `legacyState()` compat getter; legacy event derived until Phase 5 |
| The real send path bypasses `AgentSession.submit()` (ChannelManager → `agent.submitOperation` direct at `service-worker.ts:665-679`, `:1558`, `:1675`) — the guard v2 claimed to extend never runs for real messages | spec §3: submit-path rewiring is now an explicit 3a-2 task; guards installed at ChannelManager routing |
| Optimistic render had no RPC: `session.getState` throws for suspended sessions; no rollout-read endpoint existed | spec §12: new `session.getRollout` wrapping the existing `loadRolloutHistory` hook + shared renderable transform |

### Contract conflicts (v3 resolutions)

| Finding | Resolution |
|---|---|
| `UserInput`/`SubmitResult` don't exist; submit chain is fire-and-forget id-only | spec §1: `SubmitInput = Extract<Op,{type:'UserInput'}>`; `SubmitAck` (ack, never turn result); outcomes via events only |
| "AuthContext consumers must not cache" conflicted with `ModelClientFactory`'s structural need for a persistent auth handle (token closures invoked mid-stream) | spec §5: factory holds the AuthContext OBJECT, closures read `current()` at call time; `setAuthManager` + all 4 sweep-push sites deleted; "no cache" rule scoped to decision logic |
| `RebuildReason` named but never enumerated; no reason→work mapping; `refreshModelClient` aliasing is a behavior change (drops fresh-TurnContext policy reset) for 7 call sites | spec §2: enum + work matrix + call-site inventory + intentional-change note; `pendingModeSwitch` stays separate |
| v2 called all post-turn continuations fire-and-forget; only title generation is (hooks are awaited by TaskRunner; summary extraction registers a shadow job) | design §3.5 narrowed; spec §9: new tracking for title-gen ONLY |
| `SessionRuntimeEvent` would default to 'channel' scope and never reach thread-keyed UI | spec §13: `EVENT_SCOPE_MAP` entry required; transports verified additive (no protocol changes) |
| "ThreadIndex evolves SessionStorage" ambiguous; desktop is SQLite, not IndexedDB; `cleanupOrphanedSessions` HAS periodic callers (chrome.alarms + setInterval) | design §5.1/5.3 corrected; spec §11: new `thread_index` store, DB_VERSION 5→6, no secondary indexes |
| §3.2's op queue presented as new work | spec §7: generalize existing `LeaseLifecycleQueue` (`TabLeaseStore.ts:140-157`) |
| D2 evidence: BOTH refresh paths rebuild memory today; real divergence is replace-vs-mutate TurnContext | D2 corrected in design §2.1 |

### Goals-driven design additions (v3)

| Finding | Resolution |
|---|---|
| Background approval requests invisible — session silently stalls holding a live slot (new **D15**) | `awaitingInput` attribute of RUNNING + distinct badge + "N sessions need your input" aggregate + deep-link (design §3.1, §7.1, §7.2) |
| Background streaming buffering unspecified; Phase 4 as written would regress A↔B switching; second window empty mid-turn | design §7.5: SessionManager replay ring + threadStore keeps conversation buffers |
| Tab/focus contention between concurrent RUNNING sessions undefined | design §6.1: lease isolation + no focus stealing; foreground-needing automation raises awaitingInput |
| "Primary session" survives in `session.turns`/`rewind` (new **D16**) | explicit `sessionId` params; `_primarySessionId` deleted; viewed-session set owned by SessionManager |
| Viewed set had no owner/RPC | `session.setViewed` + ownership entry + disconnect expiry (spec §10) |
| New chat eagerly assembles; busy possible on bare New Chat | Two-stage open (design §3.6) — index entry only; first submit hydrates; New Chat never busy; #326 lazy-init FULLY adopted |
| Narrow mode degraded/under-specified | explicit parity list (design §7.2) |
| Missing search/rename/selection highlight/New-Chat semantics/"more…" runtime-awareness | all added (design §7.2, §7.4) |
| Phase 4 could ship before 3b/3c, amplifying D8/D9 under the new UX | Phase 4 gated on 3a+3b+3c (design §13.7, tasks.md header) |
| Lean "Goal-3-first" alternative unexplored | design §12.4: rejected as end state (re-surfaces the cap) but Phase 3a milestone-sliced into 3a-1 (visible skeleton) / 3a-2 (heavy machinery) |
| #326 absorption self-asserted; closing #326 reopened the latency regression until Phase 2 | PR body quoted below; expedited Phase-1 patch (spec §16) deletes the redundant refresh + ports the test now |
| Bulk actions silence read as oversight | explicit non-goal |

### PR #326 claim list (quoted for §9 verifiability)

> **Changes**: (1) remove redundant `refreshModelClient()` from `session.create`
> (`src/core/services/session-services.ts`) — `registry.createSession()` already runs
> `agent.initialize()`; the refresh re-composed the prompt, reloaded instructions, and
> refreshed memory a second time on the critical path; (2) `Main.svelte` — run
> `updateSessionLimits()` + `bindToActiveTab()` concurrently via `Promise.all`;
> (3) regression test asserting `session.create` no longer double-composes.
> **Follow-ups (not in the PR)**: optimistic thread render; lazy agent init on first
> message; return `activeCount`/`canCreateSession` in the `session.create` response;
> make `session-overhead.perf.test.ts` drive the real path instead of mocking `initialize()`.

### De-risks confirmed by round 2 (no action needed)

- `SessionServices` and `InitialHistory` exist and are already threaded through both
  construction paths — Phase 2 extends, not invents.
- `threadStore` already exists keyed by `sessionId`.
- Server never registered `onAgentCreated` — deleting it is extension-only.
- `session.open` response shape unconstrained by the RPC envelope (ChannelManager wraps).
- Tauri + WS transports pass new event types through — no protocol work.
- D4 patch is mechanically straightforward as specified.
