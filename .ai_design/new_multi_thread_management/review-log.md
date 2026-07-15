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
