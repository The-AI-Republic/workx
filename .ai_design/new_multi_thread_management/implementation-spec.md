# Implementation Spec — Multi-Thread Session Management

Code-level contracts for [design.md](./design.md) (v3). Every section here answers a
"where exactly / what exactly" question an implementer would otherwise have to guess
(round-2 review findings). File:line references verified 2026-07-14 on this branch.

## 1. Type definitions

```ts
// src/core/registry/types.ts
export type SessionRuntimeState =
  | 'suspended' | 'hydrating' | 'idle' | 'running' | 'suspending' | 'deleting';

// SubmitInput: the existing Op union narrowed to its UserInput variant.
// There is NO standalone UserInput type today — 'UserInput' is a discriminant tag
// (src/core/protocol/types.ts:43). Do not invent a new message shape.
export type SubmitInput = Extract<Op, { type: 'UserInput' }>;

// SubmitAck — an ACK, never a turn result. The submit chain is fire-and-forget:
// AgentSession.submit returns a bare submission-id string (AgentSession.ts:256-286);
// turn outcomes arrive later as ChannelEvents. Callers get results via events only.
export type SubmitAck =
  | { status: 'accepted'; submissionId: string }
  | { status: 'queued'; position: number }              // HYDRATING/SUSPENDING queue (§4.5)
  | { status: 'rejected'; reason: 'queue-full' | 'deleted' | 'busy' };

// SessionEventSource — NOT a new transport. A per-sessionId filtered view over the
// existing plumbing: UIChannelClient.onEvent (UIChannelClient.ts:136-150) routed by
// ThreadEventRouter (src/webfront/routing/ThreadEventRouter.ts) using getEventScope().
export interface SessionEventSource {
  on(handler: (e: ChannelEvent) => void): () => void;   // events already carry sessionId
}
```

## 2. `rebuildExecutionContext` — semantics, reasons, call sites

```ts
// src/core/RepublicAgent.ts
export type RebuildReason = 'auth' | 'model' | 'provider' | 'tools' | 'prompt';

async rebuildExecutionContext(reasons: ReadonlySet<RebuildReason>): Promise<void>
```

**Reason → work matrix** (v2 named the concept but never enumerated it):

| Work step | auth | model | provider | tools | prompt |
|---|---|---|---|---|---|
| Rebuild model client (factory) | ✓ | ✓ | ✓ | — | — |
| Credential-store read | via factory (§6) | ✓ | ✓ | — | — |
| Recompose base instructions / prompt | — | ✓ | — | ✓ | ✓ |
| Reload user instructions | — | — | — | — | ✓ |
| Refresh memory service | — | — | ✓ | — | ✓ |
| Re-sync memory tools / summary hook | — | — | — | ✓ | ✓ |

`reasonFor(section)` derivation from `IConfigChangeEvent.section`
(`src/config/types.ts:718-724`): `'model'→model`, `'provider'→provider`, `'tools'→tools`,
`'preferences'/'instructions'→prompt`. `'policy'` does not trigger a rebuild (matches
today's self-subscription behavior, `RepublicAgent.ts:316-329`).

**Intentional behavior change**: today `refreshModelClient()` constructs a **new**
`TurnContext` (`RepublicAgent.ts:598`), silently resetting `approvalPolicy`/`sandboxPolicy`
to defaults (`TurnContext.ts:93-94`), while `hotSwapModelClient()` mutates in place
(`:640-644`). `rebuildExecutionContext` adopts mutate-in-place for everyone. The 7 call
sites that today receive a fresh TurnContext and will now keep overrides:
`ServerAgentBootstrap.ts:350`, `:1323`; `auth-services.ts:127`; `session-services.ts:307`;
`agent-services.ts:189`; `service-worker.ts:805`, `:843`. The policy reset is a bug, not a
contract — no caller may rely on it (verify in PR).

**Correction to v2**: BOTH old paths already rebuild the memory service
(`RepublicAgent.ts:611` and `:653`) — the matrix above is what makes memory refresh
reason-scoped for the first time.

**Deferral**: pending state becomes `pendingReasons: Set<RebuildReason>` +
`pendingModelKey` (per-field last-wins). Flush point: the existing turn-boundary checkpoint
at `RepublicAgent.ts:967-978` (where `pendingModelKey`/`pendingModelClientRefresh` are
applied today). The busy check uses `session.hasLiveBackgroundWork()` (§9), not
`getRunningTasks()`. **`pendingModeSwitch` (`RepublicAgent.ts:90`, applied `:980-992`)
stays a separate mechanism** — session-mode switching is a conversation-semantics change,
not an execution-context rebuild; folding it in would couple unrelated invariants.

## 3. Submit-path rewiring (the guard must move)

The live chat send path **bypasses `AgentSession.submit()`** — its `_submitting` guard and
`markActive()` never run for real messages:

```
Main.svelte:822-833  client.submitOp(op, {tabId, sessionId})
  → UIChannelClient.submitOp (UIChannelClient.ts:66-68)   // Promise<void>, send-only
  → ChannelManager AgentHandler (ChannelManager.ts:18,59-68)
  → service-worker.ts:665-679  targetSession.agent.submitOperation(op, ...)  // DIRECT
```

Direct-call sites to rewire (all three): `service-worker.ts:665-679` (main handler),
`service-worker.ts:1558`, `service-worker.ts:1675`. Phase 3a replaces these with
`sessionManager.getHandle(sessionId).submit(op)` so that:
- SUSPENDING/HYDRATING routing hits the pending queue (design §4.5),
- `markActive()`/RUNNING transitions fire for real sends,
- the `_submitting` guard actually guards the production path.

`ServiceRegistry` is NOT involved — submission stays on the ChannelManager path (there is
no `session.submit` RPC and this design does not add one).

## 4. `AgentAssembler` — extension dependency inventory & initialize(auth)

### 4.1 What `ExtensionAgentAssembler` must absorb

From the inline branch (`AgentRegistry.ts:172-259`) and `onAgentCreated` consumers
(`service-worker.ts:351-378`), in wiring order:

| # | Dependency | Today | Assembler strategy |
|---|---|---|---|
| 1 | `ExtensionPlatformAdapter` | constructed inline `:179` | construct in phase-construct |
| 2 | `SessionServices` + `SessionCacheManager` | `createSessionServices` `:182-185` | passed-in shared `services` (design §4.3) |
| 3 | `PolicyRulesEngine(getDefaultRules('extension'))` | `:188-196` | phase-wire |
| 4 | `ApprovalGate` + `DomainSensitivityEnhancer` + `SemanticElementEnhancer` | `:197-207` | phase-wire (needs `agent.getApprovalManager()` post-init) |
| 5 | `ApprovalConfigStorage(() => getConfigStorage()).loadConfig()` | `:208-215` | phase-wire |
| 6 | x402: `createPaymentCapability`/`NoopSigner`/`getX402Config`/`isX402Enabled` | `:239-249` | phase-wire |
| 7 | `registerSubAgentTool(engine)` → real `SubAgentRunner` | `:250-259` | phase-wire (needs `getEngine()` non-null) |
| 8 | `taskOutputStore.setTaskOutputStore` | `service-worker.ts:351-360` | **late-bound getter** (see below) |
| 9 | `skillRegistry.setValidationContextProvider` + `registerSkillsToolOnAgent` | `:361-370` | late-bound getter |
| 10 | `PluginSessionBinder` + `pluginFsResolvers` | `:371-378` | late-bound getter |

**Late-binding constraint**: items 8–10 are module-level state in `service-worker.ts`
initialized AFTER `registry.initialize()` (e.g. `taskOutputStore` constructed at
`service-worker.ts:389`, after registry init at `:380`) — today's closure tolerates that by
reading at call time. `ExtensionAgentAssembler` therefore takes a **provider bag of lazy
getters** (`() => TaskOutputStore` etc.), not resolved instances, preserving init-order
tolerance. Do NOT reorder service-worker bootstrap to avoid this — the getters are the
smaller change.

`_setupTabClosureHandling(session)` (`AgentRegistry.ts:321-328`) stays in the
registry (it is lifecycle, not construction) until Phase 3c removes it.

**Server side**: the `agentFactory` closure (`ServerAgentBootstrap.ts:339-490`) becomes
`ServerAgentAssembler` nearly 1:1. The server never registered `onAgentCreated` (verified) —
deleting that callback is extension-only work.

### 4.2 `initialize(auth)` signature change

`RepublicAgent.initialize()` is zero-arg today (`RepublicAgent.ts:151`). It becomes
`initialize(auth: AuthContext)` with the parameter **required** — optional would silently
reintroduce D1. Migration cost: the two production call sites (`AgentRegistry.ts:186`,
`ServerAgentBootstrap.ts:347`) plus every test constructing a `RepublicAgent` directly;
provide a `TestAuthContext.none()` helper (returns `current() → null`, `generation() → 0`)
so test migration is mechanical.

## 5. `AuthContext` in `ModelClientFactory` (the chosen refactor)

`ModelClientFactory` needs a **persistent** auth handle: its token closures are captured at
client construction and invoked much later (mid-stream refresh) —
`getAuthorizationToken: tokenProvider` (`ModelClientFactory.ts:366-367, 408-417`) and
`refreshAuthorizationToken: async () => this.authManager?.refreshAccessToken?.()` (`:418`).
A value read once at assemble time cannot follow auth changes.

**Decision (round 2, option 1)**: the factory holds the `AuthContext` **object** and its
closures read `auth.current()` at call time:

```ts
class ModelClientFactory {
  private auth: AuthContext;                    // replaces authManager field + setAuthManager
  // tokenProvider closure body: this.auth.current()?.getAccessToken?.() ...
  // refresh closure body:       this.auth.current()?.refreshAccessToken?.()
}
```

Consequences:
- `setAuthManager()` (`ModelClientFactory.ts:81-86`) is **deleted**, along with all four
  sweep-push call sites (D10) — an auth change is visible to every live client's next token
  fetch automatically.
- `SessionManager.applyAuth()` shrinks to: bump handled by `AuthContext` itself; sweep
  only calls `rebuildExecutionContext({'auth'})` where a client's *identity* must change
  (e.g. gateway↔direct routing flips), which the reason matrix scopes.
- In-flight requests started before a logout keep their captured token for that request —
  same as today; no new invariant.
- The "consumers must not cache" rule (design §4.2) formally applies to decision logic
  (SessionManager/hydration generation checks); the factory holding the *context object*
  is the compliant pattern, holding a *manager snapshot* is not.

## 6. Credential-read consolidation + missing-key warning (D11)

Delete the pre-read at `RepublicAgent.ts:172` (used only for the "No API key configured"
`BackgroundEvent`). The factory's `loadConfigForProvider` (`ModelClientFactory.ts:~583`)
becomes the single reader; `assemble()` passes an `onMissingKey(providerId)` callback that
emits the same `BackgroundEvent` — one read, warning preserved.

## 7. `PerKeyOperationQueue` (reuse, don't rewrite)

`LeaseLifecycleQueue` (`src/core/TabLeaseStore.ts:140-157`) already implements the exact
per-key promise-chain pattern design §3.2 requires. Move/generalize to
`src/core/utils/PerKeyOperationQueue.ts`; `TabLeaseStore` imports it. The capacity critical
section uses the same class with a fixed key (`run('__capacity__', fn)`). No new dependency
(repo has no async-mutex/p-queue — verified).

## 8. Generation counters

`AgentConfig` is NOT an EventEmitter — it is a hand-rolled pub/sub
(`eventHandlers` map + `on`/`off`/`emitChangeEvent`, `AgentConfig.ts:998-1025`). Add:

```ts
private _generation = 0;
generation(): number { return this._generation; }
// bump centrally, FIRST line of emitChangeEvent(section, ...) — the single choke point
```

`AuthContext.generation()` is analogous, bumped on every `AuthContext` change notification.
Hydration records both at start and re-checks post-assemble (design §3.4).

## 9. `hasLiveBackgroundWork()` composition

```ts
// Session.ts — same-class access to private fields is the point
hasLiveBackgroundWork(): boolean {
  return (this.activeTurn?.getTasks().length ?? 0) > 0     // today's getRunningTasks (Session.ts:3130-3136)
      || this.activeTasks.size > 0                          // disjoint background map (Session.ts:143)
      || this.shadowAgentScheduler?.hasPending() === true   // new ~5-line wrapper over diagnostics() (ShadowAgentScheduler.ts:69-78)
      || this._pendingContinuations.size > 0;               // NEW tracking — title generation only
}
```

Round-2 corrections that scope the work down:
- `AutoCompactHook`/`SessionSummaryHook` are **already awaited** inside turn finalization
  (`Session.firePostTurnHooks` `Session.ts:641-651`, awaited by `TaskRunner.ts:904-919`;
  the summary hook's extraction additionally registers a real shadow-scheduler job,
  `SessionSummaryHook.ts:280-283`) — build **no** new tracking for them.
- **Title generation is the only untracked continuation**
  (`this.generateAndUpdateTitle(...).catch(...)`, `Session.ts:2740-2757`): wrap it in a
  `_pendingContinuations` set entry with the 30 s grace timeout (after which it logs and
  stops blocking suspension).

Phase 1 lands the method with the first two terms (fixing D5's undercount for rebuild
deferral); Phase 3a adds the last two. One method, extended — not reimplemented.

## 10. Viewed-session reporting

`session.setViewed({ sessionId: string | null })` — called by each UI surface on selection
change. SessionManager keys the viewed set by connection/surface id (the ChannelManager
connection context) and drops entries on surface disconnect. Consumed by: LRU victim filter
(design §4.6), selection highlight (§7.2), and `session.turns`/`rewind` default targeting
if a caller omits `sessionId` during migration (D16).

## 11. ThreadIndex storage

- **New store, not extended records**: IndexedDB object store `thread_index`
  (`STORE_NAMES.THREAD_INDEX`, keyPath `sessionId`) on the extension; SQLite table
  `thread_index` via `DesktopRuntimeSQLiteAdapter` on desktop (idempotent
  `CREATE TABLE IF NOT EXISTS`, `NodeSQLiteAdapter.ts:66-100` pattern). Desktop is
  **SQLite**, not IndexedDB — they share `StorageAdapter`, not the engine.
- Adding the store requires an IndexedDB `DB_VERSION` bump (5 → 6,
  `IndexedDBAdapter.ts:24`) with a `createObjectStore` in `onupgradeneeded` — stores (unlike
  fields) do need the version dance. **No secondary indexes** initially: `session.list`
  uses `getAll()` + in-memory filter/sort (the `loadAllSessions` pattern,
  `SessionStorage.ts:66-76`), sufficient at chat scale.
- `PersistedSession`/`agent_sessions` (`SessionStorage.ts:15-27`) keeps serving live-session
  runtime metadata during migration; Phase 3c removes its tab fields; long-term the two
  stores coexist (index = durable list; agent_sessions = live-session scratch) — do NOT
  merge them.

## 12. `session.getRollout` RPC

```ts
// session-services.ts
'session.getRollout': async ({ sessionId }) => {
  const snapshot = await deps.loadRolloutHistory?.(sessionId);   // existing platform hook, SessionServiceDeps (session-services.ts:41)
  if (!snapshot) throw new Error(`No rollout for ${sessionId}`);
  return { sessionId, items: snapshot.rolloutItems };            // no agent construction, no side effects
}
```

- `loadRolloutHistory` already exists on both platforms (it feeds `session.resume` today,
  `session-services.ts:148,157`); this RPC exposes it read-only.
- `RolloutRecorder.getRolloutHistory()` (`RolloutRecorder.ts:397-416`) is agent-free and
  cheap — fits the < 150 ms budget.
- **Renderable-format note**: the UI's `parseHistoryItems` currently consumes
  live-`Session.getConversationHistory()` output (`Main.svelte:539-551`). The raw-rollout →
  renderable transform must be extracted into a shared pure function (webfront-side) used by
  BOTH the optimistic render and (unchanged) live-history paths, so the §7.2
  "same snapshot" rule holds. This replaces `restoreAllThreadHistories`'
  every-session-must-be-live startup pattern (`Main.svelte:1248-1260`).

## 13. `SessionRuntimeEvent` wiring checklist

1. Add `SessionRuntimeEvent` as a new `EventMsg` union member
   (`src/core/protocol/events.ts`) — do NOT overload `BackgroundEvent`.
2. Add `'session_runtime_state': 'thread'` to `EVENT_SCOPE_MAP`
   (`src/core/protocol/event-scope.ts`) — **unknown types default to `'channel'` scope**
   (`event-scope.ts:122`) and would never reach thread-keyed UI state.
3. Transports: none — Tauri bridge (`RuntimeRelayTauriTransport.ts:13-20`) and WS
   (`WebSocketTransport.ts:398-403`, server `eventWireName.ts:63-64`,
   `authorize.ts:82-87`) pass unknown event types through (verified round 2).
4. `packages/ws-server/src/methods.ts` has a **separate, unrelated** `EVENT_SCOPE_MAP`
   (wire-auth scoping) — defaults permissive; do not confuse the two.

## 14. UI store mapping (Phase 4)

`threadStore` (`src/webfront/stores/threadStore.ts`) already exists keyed by `sessionId`
(`SidePanelThread.sessionId`). Phase 4:
- Extend `SidePanelThread` with `pinned`, `deletedAt`, `runtimeState`, `awaitingInput`
  (from ThreadIndex + `SessionRuntimeEvent`).
- `mode`/`pendingMode` remain UI-only fields (no ThreadIndexEntry counterpart — they are
  view state, not durable session identity).
- Remove `ThreadBar.svelte`/`ThreadTab.svelte` (the tab strip).
- Keep per-session conversation buffers (design §7.5) — do NOT reduce the store to
  index+state projection.

## 15. Legacy ↔ new state mapping

17 production call sites read the legacy `SessionState`
(`'initializing'|'active'|'idle'|'terminated'`, `registry/types.ts:13`) — server sweeps,
registry loops. During migration (Phase 3a until Phase 5):

| Legacy read | New source of truth |
|---|---|
| `'initializing'` | `'hydrating'` |
| `'active'` | `'running'` |
| `'idle'` | `'idle'` |
| `'terminated'` | `'deleting'` (or absent from live map) |
| — (no legacy equivalent) | `'suspended'`, `'suspending'` — legacy readers only ever see LIVE sessions, so a compat getter `legacyState()` on AgentSession maps the new enum down; suspended sessions are simply not in the live map, which legacy loops already handle (they iterate the map) |

`AgentSession.setState` keeps throwing on illegal transitions; the new table (design §3.1)
replaces `VALID_STATE_TRANSITIONS` in the same location (`registry/types.ts:195-200`).
Legacy `SessionStateChangedEvent` keeps firing (derived via `legacyState()`) until Phase 5.

## 16. Expedited Phase-1 patch (PR #326 regression window)

Standalone, shape-compatible, ships with the Phase-1 correctness PRs:
- Delete the post-create `await agentSession.agent.refreshModelClient()` in
  `'session.create'` (`session-services.ts:303-314` — the comment block documenting why
  already exists from the #326 investigation).
- Port #326's regression test (create does not double-compose).
This closes the user-facing latency regression opened by closing #326, months before
Phase 2 lands.
