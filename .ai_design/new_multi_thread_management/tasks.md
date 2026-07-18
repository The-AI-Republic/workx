# Multi-Thread Session Management — Implementation Plan

Companion to [design.md](./design.md) v5 and
[implementation-spec.md](./implementation-spec.md). Phases are ordered integration gates;
checkbox groups within a phase were proposed reviewable slices. At the implementation
owner's direction, the completed slices ship together on one branch and in one PR.
Lifecycle/UI work is client-only; Phase 2 and centralized Phase 3b config propagation cover
all platform managers, including scheduled/api/internal sessions.

Phase 4 is gated on Phase 2 + 3a + 3b + 3c. Every phase has explicit tests below and the
cross-phase definition of done in spec §18.

The coordinated Phase 4/5 cutover is complete: client lifecycle/browser paths are now the
only extension and desktop implementation, the temporary `MULTI_THREAD_LIFECYCLE` flag and
eager client branch are removed, and headless server mode remains eager. Phase 3b config
propagation is active on every manager, including headless.

Implementation completed on 2026-07-17 on
`agent/multi-thread-session-management`. External `session.create`/`session.resume` aliases
remain intentionally available for the documented two-release compatibility window. The
`AgentRegistry` compatibility export is likewise retained while production code uses the
public `SessionManager` name.

## Phase 0 — Prerequisites (complete)

- [x] PR #298 left-panel history merged to main (2026-07-16)
- [x] PR #326 closed; design absorbs its findings
- [x] Unified session/event routing landed on main (`f0eb7ba9`, `0788ad93`): one sessionId,
      `ChannelEvent{msg,sessionId}`, thread routing
- [x] Merge current main (`a05b1f13`) into this design branch for code review

## Phase 1 — Independent correctness patches

### 1.1 Remove redundant initialization (#326 regression)

- [x] In `createSessionServices`, remove `session.create`'s post-create
      `refreshModelClient`; creation already initialized the agent
- [x] Port the regression test: one create performs one prompt composition, model build, and
      memory initialization

### 1.2 Background-work-safe rebuild

- [x] Add explicit `runningTaskIds` across foreground/background/child paths; terminal
      `activeTasks` panel-retention entries do not count as live work
- [x] Add complete `Session.hasLiveBackgroundWork()`: active-turn tasks ∪ runningTaskIds ∪
      ShadowAgentScheduler.hasPending ∪ lifecycle-work leases
- [x] Add ShadowAgentScheduler zero↔nonzero subscription and bind/unbind it to Session's
      liveness-edge notifier
- [x] Add synchronous lifecycle-work leases for title, prompt suggestion, SessionSummary's
      detached extraction, and queued/running Compact/ManualCompact (D22/D26)
- [x] Add RepublicAgentEngine tracked-submission settlement so compact leases close on every
      completion/failure/queue-clear path; thread compact cancellation through pre-commit guard
- [x] Make SessionSummaryHook.detach async/await its extraction before file purge; await
      bounded task hooks before clearing a running ID
- [x] Replace refresh/hot-swap implementations with
      `RepublicAgent.rebuildExecutionContext`; aliases delegate during migration
- [x] Mutate existing TurnContext; preserve approval/sandbox overrides
- [x] Union pending rebuild reasons and flush once at the turn boundary; mode remains separate
- [x] Move per-agent config subscription to successful initialization and unsubscribe during
      dispose (Phase 3b later centralizes it)
- [x] Tests: each background owner and the task→queued-compact handoff defers rebuild, token
      settlement has no false-idle gap, reason union is lossless, policy survives, disposed
      listener is silent, rebuild failure leaves old usable context; delete cannot race a
      summary/compaction writer after abort

## Phase 2 — Construction unification (extension + desktop/server, coordinated cutover)

### 2.1 Auth and identity inputs

- [x] Implement `MutableAuthContext` exactly as spec §4.1; bootstrap owns it
- [x] Make `ModelClientFactory` hold AuthContext; token closures read `current()` at call time
- [x] Delete `setAuthManager` and all snapshot-push auth sweeps
- [x] Registry owns one AuthContext subscription/allSettled identity-rebuild sweep on every
      platform and unsubscribes on shutdown
- [x] Extend all `InitialHistory` variants with authoritative sessionId; add new/resume/fork
      ID-invariant assertions (spec §5.1)

### 2.2 Assembler and prompt isolation

- [x] Add `AgentAssembler`, `AssembleInput`, and `AssembledAgent` contracts (spec §5)
- [x] Extract `ExtensionAgentAssembler` from `AgentRegistry.createSession`, including the
      full dependency inventory and lazy-getter provider bag
- [x] Extract `ServerAgentAssembler` from `ServerAgentBootstrap`'s factory closure
- [x] Replace `onAgentCreated`; both assemblers own sub-agent/plugin wiring and cleanup
- [x] Make `RepublicAgent.initialize(auth)` required and remove server init-then-refresh
- [x] Replace global set-once PromptLoader use with per-agent `AgentPromptLoader`; inject it
      into RepublicAgent, TurnManager, memory, and SessionSummaryHook
- [x] Migrate skills and plan-review dynamic context off global prompt registrations; retain
      only a temporary test compatibility wrapper (D6 moves here from old Phase 5)
- [x] Factory owns the single credential read and preserves missing-key warning callback

### 2.3 Reason-aware teardown

- [x] Implement idempotent `AssembledAgent.dispose(reason)` cleanup stack
- [x] Split suspend/delete/shutdown/assembly-failed semantics per spec §5.3
- [x] Make `AgentSession.terminate` delegate once; make direct RepublicAgent cleanup internal
- [x] Ensure plugin binder/resolvers and platform adapter are released on every path
- [x] Extend SessionServices with optional generated-title commit callback (no-op until index)

### Phase-2 verification

- [x] Extension and server real-path tests: one initialize/prompt/memory build
- [x] Auth token/refresh closure observes login→logout/routing updates mid-lifetime
- [x] New/resume/fork retain reserved sessionId
- [x] Suspension emits balanced SessionEnd(reason=suspend), never shutdown/close/abort, and
      preserves rollout/tool results; rehydrate emits SessionStart(reason=hydrate)
- [x] Assembly failure cleans reverse-order exactly once
- [x] Two simultaneous agents receive independent prompt static contexts/modes
- [x] Prompt extension/dynamic-context isolation: memory/summary registration and disposal on
      A cannot alter B; async extension failure omits only that extension

## Phase 3a-1 — Durable index and index-only open

### 3a-1.1 Storage and migration

- [x] Generalize `LeaseLifecycleQueue` to `PerKeyOperationQueue`; retain TabLeaseStore tests
- [x] Add `ThreadIndexStore` and full schema including `agentMode`/purge fields (spec §7)
- [x] IndexedDB DB_VERSION 5→6 + `STORE_KEY_PATHS`/`STORE_NAMES` registration
- [x] Add `thread_index` to NodeSQLite/desktop adapter allowlists
- [x] Implement deterministic idempotent rollout+SessionStorage backfill and marker
- [x] Add lazy-index safety net to `session.list`
- [x] Add derived normalized searchTitle and deterministic bounded list/search pagination;
      validate opaque cursor/request coupling and lazy-repair imported rows
- [x] Implement per-session write serialization and awaited flush on suspend/shutdown seams

### 3a-1.2 Session-list services

- [x] Add backward-compatible ServiceResponse errorCode/retryable fields,
      SessionServiceError, and UI ServiceRequestError; never parse messages for codes
- [x] Add index-only `session.open({})`: reserve ID, write entry, return SUSPENDED, no agent
- [x] Add bounded index-only `session.get` for restored selection/unknown runtime-event rows
- [x] Add `loadRolloutSnapshot`/`session.getRollout`; new empty index returns revision 0
- [x] Add `session.list`, pin/unpin, rename, delete/undelete
- [x] Add title provenance/ordering: manual rename wins, generated commit is serialized,
      list/startup reconciliation repairs split-store writes
- [x] Implement tombstone-first soft delete and `SessionDeletionCoordinator` with row-last,
      retryable purge; add missing token/task/tool-result deletion APIs
- [x] Retarget extension cleanup alarm; add desktop startup + two-hour purge scheduler
- [x] Add durable `session.setMode` behavior for non-live sessions (spec §12)

### 3a-1.3 Targeting, surfaces, and state compatibility

- [x] Delete `_primarySessionId`/`getPrimarySession`; require sessionId for turns/rewind
- [x] Rewind reserves a new ID and fork history; source is never terminated
- [x] Add agent-free RolloutForkWriter + durable origin; attach works before hydration and
      later fork hydration does not duplicate prefix records
- [x] Add surface leases (`surfaceId`, 20 s heartbeat, 60 s TTL, release) with injected clock
- [x] Add config generation and AuthContext hydration-generation capture API
- [x] Add runtime/submission thread events + channel-scoped index mutation event/mappings
- [x] Add new state enum/transition assertion and temporary `legacyState` projection

### Phase-3a-1 verification

- [x] IndexedDB upgrade preserves existing stores; SQLite generic CRUD accepts thread_index
- [x] Backfill merge rules, interrupted scan, marker, lazy repair, imported rollout
- [x] New Chat has zero assembler calls and returns within 300 ms budget harness
- [x] Empty snapshot, rename/pin ordering, mode survive process restart
- [x] 10,000-row list/search fixture returns ≤100 deterministic rows within history budget;
      page traversal has no duplicates in a stable dataset
- [x] Typed service-error propagation preserves legacy message and exposes code/retryable
- [x] Fork is visible before hydrate, survives worker death, preserves reserved ID/source,
      and has exactly one copy of each prefix record
- [x] Delete during no-live state, undo, partial purge failure/retry, row deleted last
- [x] Delete during SUSPENDING cancels replacement; undelete returns same ID/history to
      SUSPENDED without constructing an agent
- [x] Two surfaces viewing same session; atomic switch; TTL expiration; stale release isolation

## Phase 3a-2 — Lifecycle, capacity, submission, attach/replay

### 3a-2.1 State and capacity scheduler

- [x] Implement manager maps/queues/reservations from spec §10
- [x] Add explicit manager `lifecycleMode`: extension+desktop client; headless server eager
- [x] Add the compile-time lifecycle flag/default-off client branch for staged development;
      remove both after the coordinated Phase-4/5 cutover
- [x] Client bootstrap loads/backfills index and creates at most an index-only initial chat;
      skip extension/desktop eager primary-agent construction
- [x] Single-flight `openFlights`; exact same promise for concurrent opens
- [x] Implement short capacity scheduler and lock ordering from spec §11
- [x] Implement deterministic LRU eligibility/tie-break and paired victim/request reservation
- [x] Implement idempotent suspend; flush index+rollout before removing live handle
- [x] Implement flush-failure SUSPENDING→IDLE rollback and allSettled cleanup report semantics
- [x] Classify capacity before construction: client primary/non-internal is managed;
      scheduled/api/internal and every headless session are eager
- [x] Keep one registry live map but independent client counters: managed uses maxLive/hardMax;
      eager non-internal preserves RegistryConfig.maxConcurrent; internal keeps its bypass
- [x] Capture config/auth generations and reconcile before live publish

### 3a-2.2 Production submit/control path

- [x] Register correlated `session.submit` on client and direct-accept server passthrough
- [x] Route generic UserInput only through instrumented legacySubmit→manager shim; no direct
      agent call. Phase 5 changes it to a hard rejection after UI migration
- [x] Implement deterministic explicit target resolution for surface-less quick actions
- [x] Implement per-session FIFO (8), global capacity FIFO (32), dedupe, ACK/event semantics
- [x] Implement exhaustive live-control disposition table (spec §3.2)
- [x] Implement full durable mode behavior across all states, including deferred RUNNING apply
- [x] Route compat create/resume through open without terminating another session
- [x] Client-mode `session.close` compat force-suspends but retains index/rollout; use the
      compat-close abort/no-marker reason

### 3a-2.3 Work tracking and recovery

- [x] Connect Phase-1 liveness false↔true edges to manager onBackgroundWorkChanged with an
      under-queue recheck; add IDLE↔RUNNING transition and queued-head dispatch tests
- [x] Wire title success to manager ThreadIndex update/event
- [x] Track approval/foreground awaiting-input tokens; publish count + kinds
- [x] Add TaskRunner `turn_start`/terminal markers and idempotent worker-restart abort recovery
- [x] Fail queued messages on hydration failure/delete/shutdown; persist client ID/input
      digest in turn_start and atomically maintain metadata open-turn/recent-ACK index
- [x] Recover from metadata only (never scan every rollout); lazy-load recent ACKs per session;
      expose terminal-marker durability degradation without replacing the task result

### 3a-2.4 Event chokepoint and attach

- [x] Make SessionManager the sole outbound event path; remove service-worker 100 ms event poll
- [x] Narrow production EventDispatcher to synchronous enqueue; sequence/catch async ring +
      broadcast work inside a per-session promise chain that survives rejection
- [x] Disable RepublicAgent legacy eventQueue in production assemblers so removing the poll
      cannot create an undrained memory leak; retain explicit test mode until Phase 5
- [x] Add per-hydration epoch/sequence and 512-event/1-MiB replay ring
- [x] Inject switchable event gate before agent initialize; activate/drain after publish,
      discard on failure, serialize outbound sends (initialization events are not lost)
- [x] Implement shared single-flight immutable snapshot cache for hydration + attach
- [x] Implement `session.attach` boundary/cursor/truncation contract (spec §9)
- [x] Flush + refresh snapshot before terminal IDLE, then clear finished ring
- [x] Add privacy-safe telemetry events and lifecycle doctor check (spec §16)

### Phase-3a-2 verification

- [x] Double-open, delete-while-hydrating, hydrate-failure retry, config/auth race
- [x] Terminal retained task does not block IDLE/LRU; detached task hook cannot outlive graph
- [x] Parallel managed-interactive hydrate never exceeds hardMax; reservation released on
      every thrown step
- [x] Saturate managed and eager pools independently: neither pool blocks, counts, evicts, or
      queues the other; internal still bypasses eager capacity; headless cap behavior is unchanged
- [x] Suspend flush failure keeps graph usable/dispatches queued head; post-flush cleanup
      failures still release the slot and remain rehydratable
- [x] Capacity/victim/submit interleavings prove no lock cycle using controlled promises
- [x] FIFO order, duplicate clientMessageId, both queue bounds, suspension-submit race
- [x] Lost-ACK restart rebuilds accepted ACK/digest conflict from rollout; unmatched intent is
      never auto-replayed and no accepted turn duplicates
- [x] Control ops never hydrate/queue and stale approval is rejected
- [x] Compat-close during RUNNING aborts/awaits then suspends without close marker or deletion;
      an arriving submit queues and flush failure restores the intact graph
- [x] Sole-path event delivery (no duplicates); attach before/during/after event; epoch change;
      truncation; committed-IDLE snapshot ordering
- [x] Deferred/rejecting broadcaster proves synchronous capture order, no unhandled rejection,
      and later-event delivery after a send failure
- [x] SessionStart/init warning emitted during assemble is ordered/replayed after publish;
      failed assembly leaks no partial init events; pre-publish overflow preserves truncation
- [x] Worker restart closes unmatched turn once; matched/previously recovered turns unchanged
- [x] IndexedDB/SQLite transaction-boundary tests keep marker+recovery metadata atomic; startup
      reads metadata only and terminal-write failure leaves a conservative open turn
- [x] Fake assembler latency budget: history <150 ms, hydration/send-enabled <1 s

## Phase 3b — Central config propagation (all platform registries)

- [x] Add compile-time exhaustive CONFIG_IMPACT map for every current config section (spec §4.2)
- [x] Each AgentRegistry/SessionManager becomes its platform's sole config subscriber; remove
      RepublicAgent self-subscription and direct bootstrap sweeps
- [x] Snapshot live agents and sweep with `Promise.allSettled`; one failure cannot stop others
- [x] `policy`/reload conservatively performs full rebuild; hook/approval/plugin actions are
      manager-owned and idempotent
- [x] Replace extension `agent.configUpdate` destroy-all behavior with reload + manager sweep
- [x] Include scheduled/api/internal and headless live agents; client HYDRATING uses
      generation reconciliation
- [x] Tests: every section mapped, policy full impact, running deferral, allSettled isolation,
      no disposed listener, hydration changed-generation case

## Phase 3c — Browser-resource isolation

- [x] Implement `TabGroupRegistry` API/serialization/storage from spec §15
- [x] Make ExtensionPlatformAdapter session-scoped and assembler-created with reserved ID
- [x] Add SessionBrowserResources/BrowserTabDescriptor capability; remove Chrome types and raw
      active/claim/release fallbacks from core agent execution
- [x] Migrate the direct Chrome API inventory named in spec §15
- [x] Extend desktop node-invoke bridge with sessionId/focus grant/release-session control;
      replace `BRIDGE_SESSION_ID` and one `currentTabId` with per-session executor state (D21)
- [x] Extend TabGroupRegistry/desktop bridge with per-session browser-context lookup; replace
      global mutable SkillDomainFilter/ChromeActiveTabAdapter with pure SessionSkillView
- [x] Register each SessionSkillView only on its agent's prompt loader; keep catalog CRUD and
      explicit user invocation shared (D25)
- [x] Remove AgentSession/Session tab ownership fields and tab-close termination
- [x] Lazy group/letter allocation; release+ungroup on suspend, leave tabs open
- [x] Forbid cross-session lease theft; tab close removes only lease/membership
- [x] Enforce background `active:false`; implement foreground attention promise +
      `session.resolveAttention` surface/ownership validation
- [x] Add thread-scoped browser_attention_required event and exact resolve result/grant expiry
- [x] Tests: two-session isolation, concurrent lease mutations, close behavior, suspend leaves
      pages open, two desktop bridge sessions select different tabs, per-session bridge
      release, background focus denied, grant/session mismatch, resolve/abort/delete paths
- [x] Quick action on an already leased tab targets its owner; unowned tab is claimed for the
      resolved session; contention never steals
- [x] Skills tests: A on gmail and B on github receive different conditional prompts; a
      suspended/no-tab session gets unconditional skills only; desktop lookup is ID-scoped
- [x] Repository guard permits chrome.tabs/tabGroups only in the enumerated global/bootstrap,
      transport, TabGroupRegistry, and platform-adapter/bridge boundaries

## Phase 4 — One-list webfront

### 4.1 Store convergence and bootstrap

- [x] Expand threadStore to the single projection defined in spec §13
- [x] Bootstrap from first `session.list` page and incrementally load more; persist only local
      active selection, not duplicate list data
- [x] Use global `agent.getAccessState` on both clients; make backend access state derive from
      bootstrap AuthContext/config, not a live/primary session; input remains enabled suspended
- [x] Replace direct history list/resume bridge and Main's separate thread/event maps
- [x] Remove ThreadBar/ThreadTab and all primary history dependence on a live agent

### 4.2 Navigation, attach, and send

- [x] Generate one surfaceId per document; heartbeat/release based on visibility
- [x] Implement list→setViewed→attach and optional prewarm flow
- [x] Implement attach buffer/snapshot/replay/dedupe/truncation algorithm exactly as spec §9.2
- [x] New Chat is index-only/instant; first send uses clientMessageId ACK lifecycle
- [x] Replace Main.startNewConversation/session.reset with open→select returned ID; previous
      thread and its buffers remain unchanged
- [x] Preserve per-session conversation buffers/cursors across A↔B switching
- [x] Reconnect reconciles orphaned sends from durable client-ID markers; unmatched epoch-
      changed sends become delivery-unknown and explicit Resend uses a new clientMessageId

### 4.3 Product behavior

- [x] Pinned-first 10-row paged recent list with inline More loading in a fixed-height scroll
      container, debounced backend search across unloaded rows, selection,
      rename, soft-delete undo
- [x] Distinct RUNNING and awaiting-input badges; aggregate attention deep-links
- [x] Coalesced session.get fills an unloaded row on runtime/attention events; purged stubs drop
- [x] Runtime-aware inline More pagination; New Chat demotes current session without stopping it
- [x] Failure UI: hydration retry banner, capacity wait/queue-full retry, partial replay warning
- [x] Delivery-unknown UI explains uncertainty; Resend is explicit, warns, and uses a new ID
- [x] Durability-degraded runtime banner remains distinct from hydration/replay failures
- [x] Narrow parity: pin, delete/undo, badges/attention, open/failure, sending/retry, search;
      rename remains wide-only; bulk actions remain out of scope

### Phase-4 verification

- [x] Two surfaces attach mid-turn with no missing/duplicate tokens
- [x] Switch A→B→A while both stream; each buffer/state/mode remains independent
- [x] Surface hide/TTL protects then releases LRU eligibility
- [x] Worker restart, orphan submit, hydration failure, queue full, delete undo journeys
- [x] Accessibility/keyboard navigation and narrow/wide component tests
- [x] Repository search proves no primary UI use of `restoreAllThreadHistories`, live
      `session.getState` for history, direct RolloutRecorder list, session.getActiveCount, or
      session-bound agent.healthCheck for global readiness, and no webfront `session.reset`
- [x] Cut extension+desktop over only after the migration tests pass, then remove the
      temporary lifecycle flag and eager client branch

## Phase 5 — Compatibility convergence and cleanup

- [x] Migrate all in-repo `session.create`/`resume` callers; keep external aliases for at
      least two stable releases
- [x] Delete refresh/hot-swap aliases and global PromptLoader compatibility wrapper
- [x] Delete legacy RepublicAgent event queue/getNextEvent after tests migrate
- [x] Delete the in-repo session.reset service/client compatibility branch after the Phase-4
      New Chat migration; durable sessions never mutate identity
- [x] Remove legacy SessionState event/getter after repository consumers are migrated
- [x] Mechanically rename `AgentRegistry` → `SessionManager`, retaining a compatibility
      export; included in this single PR at the implementation owner's direction
- [x] Complete the coordinated lifecycle cutover requested by the implementation owner:
      delete the rollout flag/eager client branch, make generic client UserInput reject,
      delete legacy global tab/skill-filter paths, and keep headless-server eager mode
- [x] Update `.ai_design/architecture.md`, RPC docs, and support/doctor documentation
- [x] Full typecheck, lint, unit/integration suites; diff review confirms no behavior change

## Explicit non-goals

- Session god-object decomposition beyond injected collaborators
- StorageTool-owned cache duplication outside the construction graph
- Bulk/multi-select UI actions
- Server-mode durable thread lifecycle/list UI
- Cross-machine sync or durable in-flight submit queues
- Incremental token-level checkpointing of a running turn

## Final verification (2026-07-17)

- `npx vitest run --silent=true --reporter=basic`: 490 files and 9,517 tests passed;
  one pre-existing integration file/8 tests remained explicitly skipped
- `npm run test:rust`: 33 tests passed
- `npm run type-check -- --pretty false`: passed
- `npx eslint src --quiet`: passed with no errors
- Extension, desktop, desktop-runtime, server SSR, and web production builds: passed
- `git diff --check`: passed
