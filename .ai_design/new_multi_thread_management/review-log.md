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
| No legacy↔new state mapping; 17 production call sites read the old 4-state enum | current spec §17: mapping + `legacyState()` compat getter; legacy event derived until Phase 5 |
| The real send path bypasses `AgentSession.submit()` (ChannelManager → `agent.submitOperation` direct at `service-worker.ts:665-679`, `:1558`, `:1675`) — the guard v2 claimed to extend never runs for real messages | spec §3: submit-path rewiring is now an explicit 3a-2 task; guards installed at ChannelManager routing |
| Optimistic render had no RPC: `session.getState` throws for suspended sessions; no rollout-read endpoint existed | current spec §7.3/§9: agent-free snapshot loader + attach and shared projection |

### Contract conflicts (v3 resolutions)

| Finding | Resolution |
|---|---|
| `UserInput`/`SubmitResult` don't exist; submit chain is fire-and-forget id-only | spec §1: `SubmitInput = Extract<Op,{type:'UserInput'}>`; `SubmitAck` (ack, never turn result); outcomes via events only |
| "AuthContext consumers must not cache" conflicted with `ModelClientFactory`'s structural need for a persistent auth handle (token closures invoked mid-stream) | current spec §4.1: factory holds the AuthContext OBJECT, closures read `current()` at call time; `setAuthManager` + sweep-push sites deleted |
| `RebuildReason` named but never enumerated; no reason→work mapping; `refreshModelClient` aliasing is a behavior change (drops fresh-TurnContext policy reset) for 7 call sites | current spec §4.3: enum/work matrix/intentional change; `pendingModeSwitch` stays separate |
| v2 called all post-turn continuations fire-and-forget; only title generation is (hooks are awaited by TaskRunner; summary extraction registers a shadow job) | design §3.5 narrowed; current spec §6 tracks title generation only |
| `SessionRuntimeEvent` would default to 'channel' scope and never reach thread-keyed UI | current spec §1: `EVENT_SCOPE_MAP` entries required; transports additive |
| "ThreadIndex evolves SessionStorage" ambiguous; desktop is SQLite, not IndexedDB; `cleanupOrphanedSessions` HAS periodic callers (chrome.alarms + setInterval) | design §5.1/5.3; current spec §7: new store, DB_VERSION 5→6, SQLite allowlist |
| §3.2's op queue presented as new work | current spec §10: generalize existing `LeaseLifecycleQueue` |
| D2 evidence: BOTH refresh paths rebuild memory today; real divergence is replace-vs-mutate TurnContext | D2 corrected in design §2.1 |

### Goals-driven design additions (v3)

| Finding | Resolution |
|---|---|
| Background approval requests invisible — session silently stalls holding a live slot (new **D15**) | `awaitingInput` attribute of RUNNING + distinct badge + "N sessions need your input" aggregate + deep-link (design §3.1, §7.1, §7.2) |
| Background streaming buffering unspecified; Phase 4 as written would regress A↔B switching; second window empty mid-turn | design §7.5: SessionManager replay ring + threadStore keeps conversation buffers |
| Tab/focus contention between concurrent RUNNING sessions undefined | design §6.1: lease isolation + no focus stealing; foreground-needing automation raises awaitingInput |
| "Primary session" survives in `session.turns`/`rewind` (new **D16**) | explicit `sessionId` params; `_primarySessionId` deleted; viewed-session set owned by SessionManager |
| Viewed set had no owner/RPC | current spec §8: explicit webfront surface leases |
| New chat eagerly assembles; busy possible on bare New Chat | Two-stage open (design §3.6) — index entry only; first submit hydrates; New Chat never busy; #326 lazy-init FULLY adopted |
| Narrow mode degraded/under-specified | explicit parity list (design §7.2) |
| Missing search/rename/selection highlight/New-Chat semantics/"more…" runtime-awareness | all added (design §7.2, §7.4) |
| Phase 4 could ship before 3b/3c, amplifying D8/D9 under the new UX | Phase 4 gated on 3a+3b+3c (design §13.7, tasks.md header) |
| Lean "Goal-3-first" alternative unexplored | design §12.4: rejected as end state (re-surfaces the cap) but Phase 3a milestone-sliced into 3a-1 (visible skeleton) / 3a-2 (heavy machinery) |
| #326 absorption self-asserted; closing #326 reopened the latency regression until Phase 2 | PR body quoted below; tasks Phase 1.1 deletes the redundant refresh + ports the test |
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

## Review round 3 — 2026-07-16 (against DRAFT v3; every-phase coding readiness)

Deep review against main after PR #298 and unified session/event routing merged. Scope:
production submission transport, lifecycle lock ordering, construction/teardown, storage
adapters and deletion stores, config event union, extension/desktop surface identity,
event delivery, rollout durability, browser focus, and current webfront projections.

Verdict on v3: direction remained sound, but it was **not ready to implement beyond Phase
1**. The following blockers are resolved in v4 and its rewritten implementation spec.

### Critical contract fixes

| Finding | Resolution in v4 |
|---|---|
| `SubmitAck` had no transport path: `UIChannelClient.submitOp`/transport return void and SidePanelChannel discards the agent-handler value | `session.submit` is a correlated ServiceRequest/ServiceResponse for UserInput; queued completion/failure gets a new thread-scoped event; server registers a direct-accept passthrough (spec §3) |
| `SessionHandle.submit` was typed UserInput but the proposed rewiring sent every `Op` through it | Exhaustive Op disposition table: UserInput queues; mode/interrupt use services; approvals and other controls are live-only and never hydrate/queue (spec §3.2) |
| Capacity section held count→suspend→assemble under one manager mutex and could deadlock with per-session operations | Short scheduler only count/pick/reserve/release; paired reservations; slow teardown/assembly outside; public session queue released before capacity request; exact pseudocode (spec §10–11) |
| Replay ring had no attach cursor, ordering boundary, dedupe, truncation, or snapshot consistency contract | Epoch+sequence envelope, bounded ring, `session.attach`, one captured throughSeq, same immutable snapshot for attach/hydration, UI buffer/merge algorithm (spec §9) |
| Extension viewed-surface identity assumed a connected channel/disconnect event that does not exist (`onMessage` is one-shot) | Webfront UUID surface lease, 20 s heartbeat/60 s TTL, atomic replacement, explicit release, fake-clock tests (spec §8) |
| Suspension reused terminal `cleanup()`, which always fires SessionEnd(shutdown) | Defined one reason-aware teardown owner; suspend emits a balanced runtime hook reason but no shutdown/abort/close (spec §5.3; D20) |

### Persistence and recovery fixes

| Finding | Resolution in v4 |
|---|---|
| Design contradicted spec by saying new IndexedDB store needed no DB version bump | Explicit DB_VERSION 5→6 plus STORE_NAMES/key paths and SQLite allowlists (design §5.1, spec §7.1) |
| Per-session mode was runtime-only; suspension/hydration reset it | Durable ThreadIndex `agentMode`, state-specific `session.setMode`, assembler preference input (D17, spec §12) |
| Index-only open reserved an ID but new/forked InitialHistory could mint another | All InitialHistory variants carry reserved ID; assembler asserts equality (D18, spec §5.1) |
| Backfill said “scan and create” without deterministic merge/crash behavior | Exact per-field merge, missing-only upsert, completion marker, lazy repair (spec §7.2) |
| Soft delete did not enumerate hard-purge data or retry behavior | Row-last idempotent coordinator covers rollout/cache/session/token/task/output/tool results; failed row retained; desktop scheduler added (spec §7.4) |
| MV3 recovery relied on a turn-start marker that current rollout explicitly does not persist; existing turn_completion is not wired | Add TaskRunner-wired `turn_start` + terminal markers and idempotent worker_restart abort recovery (spec §14) |
| Two-stage rewind had no durable history until live Session construction, so attach-before-hydrate would be empty and worker death would lose the fork | Agent-free fork writer + durable provenance + no-double-persist hydration contract (spec §7.5) |

### Independence/UI fixes

| Finding | Resolution in v4 |
|---|---|
| Service worker has immediate agent dispatcher plus 100 ms `getNextEvent` broadcaster, so replay would double-deliver | Manager becomes sole outbound chokepoint and old poll is removed (D19, spec §9.1) |
| Phase 4 was gated before D6 per-agent prompt state, so “independent” sessions could share first-agent global context | D6 moved from Phase 5 into coordinated Phase 2; instance prompt loader contract defined (spec §5.4) |
| Title generation updates rollout only; ThreadIndex would stay stale, and later auto-title could overwrite rename | Title provenance + serialized `commitGeneratedTitle`; user rename wins and split-write reconciliation repairs crashes (spec §6–7) |
| Boolean awaitingInput could clear early with multiple approvals/foreground requests | Token set with count+kinds and exact add/remove seams (spec §6) |
| Focus rule said “defer/downgrade” but did not say how a foreground-required tool resumes | Awaitable BrowserAttentionRequest + surface/ownership-validated resolve RPC (spec §15) |
| PR #298 left two UI projections (history resume flow + threadStore/Main maps) with no convergence plan | Phase 4 makes threadStore the sole projection and supplies exact bootstrap/navigation/send flows (spec §13) |
| Desktop bridge used one stable lease owner/current tab for all agent sessions and dropped sessionId at the proxy callback | Bridge invoke carries sessionId/focus grant; executor state and release are per-session (D21, spec §15.1) |
| Main now has a second detached post-turn model call (`maybeGenerateSuggestion`), and its single-flight flag begins after an await | Title + suggestion share synchronous abortable continuation tracking before terminal event (D22, spec §6) |
| `activeTasks` now retains terminal task records for panel grace, invalidating v3's `activeTasks.size` busy test; task lifecycle hooks are detached | Explicit runningTaskIds start/finally set; terminal UI records excluded; lifecycle hooks awaited (D23, spec §6) |
| Agent initialize emits events before current registry installs its dispatcher; assembler would lose SessionStart/warnings and bypass replay ordering | Preinstalled switchable event gate buffers, then atomically activates through manager after publish (spec §5.2.1) |

### Accuracy corrections

- `IConfigChangeEvent.section` has no `instructions`; it includes 14 current sections.
  v4 uses a `satisfies Record<...>` exhaustive impact map and treats `policy` as full impact
  because `AgentConfig.reload()` currently replaces config but emits only `policy`.
- `DiagnosticRegistry` is a doctor-check registry, not a field metric sink. v4 uses the
  existing privacy-gated telemetry `logEvent` API and adds one local lifecycle doctor check.
- “New Chat never blocked” is now scoped correctly: index creation never blocks on capacity;
  first send uses bounded backpressure and can be retryably rejected only on queue overflow.
- Phase 0 prerequisites are complete on main; old line-number inventories were replaced with
  stable symbol/file integration points.

### Round-3 readiness verdict

All phases now have inputs/outputs, owner, concurrency and failure behavior, migration rules,
platform boundaries, concrete code integration points, and phase acceptance gates. Remaining
items are implementation risks to validate with the specified tests, not unresolved design
choices.

## Review round 4 — 2026-07-16 (against DRAFT v4; final cross-phase/code-owner audit)

Round 4 traced every remaining module-level mutable owner and every current webfront lifecycle
RPC, then checked awaited hooks through their internal work and the acceptance table against
the normative sections. It found four additional lifecycle/Goal-1/identity blockers and ten
specification defects. All are resolved in DRAFT v5.

| Finding | Resolution in v5 |
|---|---|
| Main's New Chat calls `session.reset`; `Session.reset()` mints a UUID inside Session while AgentSession/registry stay keyed by the old ID | D24 added. Lifecycle mode rejects reset without mutation; Phase 4 replaces Main's path with `session.open({})` and selects the returned immutable ID; Phase 5 deletes the compatibility branch (spec §13, §17) |
| Skills prompt filtering is one process-global mutable view of Chrome's active tab, so agent A can receive agent B's domain-conditioned skills | D25 added. Shared catalog remains, but Phase 3c adds pure per-session `SessionSkillView`, TabGroupRegistry/desktop context lookup, and agent-local async prompt registration (spec §15.2) |
| Awaited post-turn callbacks still detach SessionSummary extraction or merely enqueue AutoCompact; neither pre-scheduler summary work nor queued/running compact work was in the liveness predicate | D26 added. Phase 1 now supplies synchronous lifecycle-work leases plus tracked engine-submission settlement; all owners are included before rebuild/lifecycle work can observe idle (spec §6) |
| The submit cache was in-memory but reconnect told the UI to retry an orphan with the same ID; a lost ACK could duplicate an already-started turn | D27 added. Managed turn-start markers persist client ID + stable input digest, startup reconstructs recent accepted ACKs, attach reconciles matches, and unmatched epoch-changed sends become delivery-unknown with no automatic replay (spec §3, §14) |
| Per-agent PromptLoader contract did not enumerate the current owners, so implementers could leave global memory/summary/skills/plan-review paths behind | Spec §5.4 now names every owner/call site, async/error/disposal semantics, and the exact temporary test-only wrapper boundary |
| Phase-2 acceptance row said suspension emits no SessionEnd, contradicting the teardown matrix's balanced SessionEnd(reason=suspend) | Acceptance row corrected to require the balanced suspend hook while forbidding shutdown/abort/close semantics |
| Current EventDispatcher permits a Promise but most emission sites ignore it; an async manager dispatcher could reorder events or create unhandled rejections | Production dispatcher is now synchronous enqueue only; one per-session promise chain owns/catches ordered async storage+broadcast work, with rejection-recovery tests (spec §9.1) |
| Several sections promised typed service failures even though ServiceResponse transports only an error message | Added backward-compatible `errorCode`/`retryable`, SessionServiceError mapping, and UI ServiceRequestError; legacy handlers remain message-only and no client parses text (spec §1) |
| Lifecycle compatibility `session.close` was called a suspension while also aborting work, contradicting ordinary suspend teardown and leaving close-marker behavior undefined | Added distinct `compat-close`: force-suspend claim, abort/await, no close marker/deletion, flush rollback, and queued-submit behavior (spec §5.3, §17) |
| MV3 recovery said to scan every indexed rollout on every wake, an unbounded cost under an unlimited-thread design | Turn start/completion now atomically maintain bounded recovery data in existing rollout metadata JSON; startup reads only open-turn metadata and recent ACKs load lazily per session (spec §14) |
| `session.list` returned every ThreadIndex row and search filtered only the client-loaded set, contradicting unlimited threads and startup latency | Added normalized title field, deterministic opaque-cursor pages (50 default/100 max), backend search across all rows, lazy repair, and a 10,000-row latency fixture (spec §7.2, §13) |
| Rollout text said all of 3a–3c was behind a client flag, but Phase 3b must remove shared RepublicAgent listeners and own config propagation on headless too | Flag scope narrowed to client lifecycle/browser paths in 3a/3c; Phase 3b is active and ungated on every platform registry (spec §2, tasks preamble) |
| Phase 3c's Chrome migration list omitted TurnManager, BaseTool, hook context, duplicate tool trees, service-worker tab commands, and several tools, leaving active-tab cross-session fallbacks | Added SessionBrowserResources, the full production inventory/exclusions, explicit quick-action claim handoff, and a repository guard against sessionless Chrome calls (spec §15) |
| Excluding scheduled/API sessions from managed capacity left the existing shared AgentRegistry count ambiguous; managed primaries could still starve scheduled jobs or vice versa | Added total pre-construction capacity classification and independent client-mode counters: managed primary/non-internal uses maxLive/hardMax, eager non-internal preserves maxConcurrent, internal preserves its bypass, and headless behavior is unchanged (spec §2, §11) |

### Round-4 readiness verdict

DRAFT v5 is ready to code phase by phase. Every phase now has a bounded change inventory,
explicit compatibility state, named production owners, failure/concurrency semantics, and
acceptance evidence. No known architecture choice is deferred to an implementer; remaining
unknowns are testable implementation risks behind the documented rollout gate.
