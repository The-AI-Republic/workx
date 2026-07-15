# Multi-Thread Session Management Redesign

Status: **DRAFT — for review**
Related: PR #298 (left-panel chat history, prerequisite), PR #326 (thread-creation latency, superseded by this design), `.ai_design/simplify_session/design.md` (unified sessionId, companion)

## 1. Goals

1. **Parallel multi-session** — the app supports multiple independent agent sessions running in parallel (like browser tabs); sessions never interfere with each other.
2. **Well-managed instances** — components are organized around clear ownership; state lives in exactly one place; initialization is efficient (no duplicated work).
3. **Codex/Claude-style thread model** — there is no "close thread" concept and no "create a thread tab" ceremony. The left panel lists recent chat sessions (built on PR #298); the user can pin sessions and click any one to continue it. Live parallelism is an implementation detail the user never manages.
4. **Systematically absorb PR #326** — the new-thread latency fix is resolved structurally (root cause), not tactically. PR #326 closes in favor of this design.
5. This document lives in `.ai_design/new_multi_thread_management/`.

Decisions taken with the team:

| Decision | Choice |
|---|---|
| Capacity model | Transparent LRU suspend/hydrate — no user-visible session limit |
| PR #298 | Merge first; this design builds on top |
| PR #326 | Close unmerged; findings absorbed here (§8) |
| Tabs vs threads | Decoupled — browser tabs are a leased session *resource*, not the session's identity |

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

These were mapped in a full code exploration (2026-07-14, branch `pi-dash/workxos-2`).

| # | Defect | Evidence |
|---|--------|----------|
| D1 | Auth is a bolt-on: `ModelClientFactory.authManager` defaults `null` (`ModelClientFactory.ts:70`); `initialize()` builds the first model client (`RepublicAgent.ts:208`) before auth can be wired. Every platform compensates differently — the server re-inits **twice per session** (`ServerAgentBootstrap.ts:348-351`); extension `session.create` never wires auth at all (gap). | exploration §2 (entry points) |
| D2 | Three near-duplicate "rebuild" paths: `initialize()` tail, `refreshModelClient()` (`RepublicAgent.ts:590-628`), `hotSwapModelClient()` (`RepublicAgent.ts:635-669`). Each redoes prompt composition + user instructions + full memory-service teardown/rebuild. `refreshModelClient()` also constructs a fresh `TurnContext`, dropping approval/sandbox overrides. | exploration §2 (lifecycle) |
| D3 | Config changes propagate through **two racing mechanisms**: per-agent self-subscription (`RepublicAgent.ts:316`) *and* caller-driven sweeps (`ServerAgentBootstrap.ts:745-757`). One update triggers both concurrently; last write wins on `TurnContext`. | exploration §5.3 |
| D4 | Listener leak: `config-changed` subscription registered in the constructor, never removed in `cleanupOnce()` (`RepublicAgent.ts:1411-1443`). Disposed agents stay subscribed to the singleton `AgentConfig` and can act on torn-down sessions. | exploration §5.2 |
| D5 | `hotSwapModelClient`/`refreshModelClient` don't check running tasks — config file-watch can swap the model client **mid-turn**. The `pendingModelKey` deferral exists only on the self-subscription path (`RepublicAgent.ts:359-371`). | exploration §5.4 |
| D6 | First-agent-wins global prompt state: `configurePromptComposer()` is a set-once module singleton (`PromptLoader.ts:36-85`). The first agent's persona/browser-connection context becomes process-global; later sessions' configuration is a silent no-op. | exploration §5.8 |
| D7 | Two "resume" implementations: `AgentRegistry.resumeSession()` (`AgentRegistry.ts:600-643`) creates a **new empty conversation** despite its docblock; the real resume is the `session.resume` RPC (`session-services.ts:147`). | exploration (registry) |
| D8 | `agent.configUpdate` semantics diverge by platform: extension destroys **all** sessions and recreates one (`service-worker.ts:782-822`); server hot-swaps in place preserving history. | exploration (entry points) |
| D9 | `tabId` is triplicated: `AgentSession._metadata.tabId`, `Session` state (`Session.ts:1074-1088`), and `TabLeaseStore` — kept in sync only by caller discipline. | exploration (registry) |
| D10 | Four hand-rolled "loop sessions + setAuthManager (+ refresh)" sweeps with different completeness (`service-worker.ts:536-545, 800-846`, `agent-services.ts:181-191`, `auth-services.ts:127`). | exploration §3 |
| D11 | Redundant IO on the create path: 2 credential-store reads for the same key per init (`RepublicAgent.ts:172` + `ModelClientFactory.ts:583`); memory service torn down/rebuilt on every refresh. | exploration §1 |
| D12 | `Session.ts` is a god object (3,231 lines: tasks, memory, compaction, titles, suggestions, hooks, rollout, tool results). | exploration (registry) |
| D13 | Hard cap: `createSession` **throws** at the concurrency limit (`AgentRegistry.ts:133-136`); the user must manually close threads. | exploration (registry) |
| D14 | UI round-trip waste: serial `session.create` → `session.getActiveCount`; `syncThreadsWithSessions` calls `getActiveCount` twice on cold start (`Main.svelte:1237, 1301`). | exploration §3, PR #326 |

## 3. Target Architecture

### 3.1 Conceptual model: a thread IS a session, and it never closes

One user-facing concept: **a chat session** (identified by `sessionId`, per
`simplify_session` design). It is durable — it exists from creation until the user deletes
it. What varies is its **runtime state**:

```
                      ┌────────────────────────────────────────────┐
                      │                 SessionManager             │
                      │  (evolves AgentRegistry; owns lifecycle)   │
                      └────────────────────────────────────────────┘
  persisted only                       in memory
 ┌─────────────┐   hydrate   ┌──────────────┐        ┌──────────────┐
 │  SUSPENDED  │ ──────────► │     IDLE     │ ─────► │   RUNNING    │
 │ (rollout +  │ ◄────────── │ (live agent, │ ◄───── │ (task in     │
 │  ThreadIndex│   suspend   │  no task)    │        │  flight)     │
 │  entry)     │             └──────────────┘        └──────────────┘
 └─────────────┘                LRU-evictable          never evicted
```

- **SUSPENDED**: no `RepublicAgent` in memory. The session exists as a `ThreadIndex` entry
  (title, recency, pinned, sessionId) plus its rollout history. Zero runtime cost.
- **IDLE**: full live agent graph, no running task. Eligible for LRU suspension.
- **RUNNING**: at least one task in flight. Never suspended.
- There is **no TERMINATED user state**. "Close" disappears from the UI; `delete` (explicit,
  destructive, removes rollout + index entry) replaces it.

This resolves D13: `createSession` never throws at a limit; the limit governs how many
*live agents* exist, not how many *sessions* the user may have.

### 3.2 Component ownership map

| Component | Owns (single source of truth) | Explicitly does NOT own |
|---|---|---|
| `ThreadIndex` (new, persisted) | The list of sessions: sessionId, title, lastActiveAt, pinned, createdAt | conversation content, runtime state |
| `SessionManager` (evolves `AgentRegistry`) | Map of **live** sessions, runtime state machine (suspended/hydrating/idle/running/suspending), LRU policy, hydrate/suspend orchestration, config/auth propagation to live agents | agent construction details (delegated to `AgentAssembler`), UI state |
| `AgentAssembler` (new; unifies the two construction paths) | Building one fully-wired `RepublicAgent` from `(config, initialHistory, AuthContext, platform hooks)` | lifecycle, storage |
| `AuthContext` (new) | The current `IAuthManager` + change notification | per-session client rebuilds (SessionManager sweeps) |
| `RepublicAgent` | One `Session`, its `ToolRegistry`/engine/hooks, `rebuildExecutionContext()` | config subscription (removed → SessionManager), auth acquisition |
| `Session` | Conversation state, rollout, tasks | tabId (moves out, D9), model-client lifecycle |
| `TabLeaseStore` | **All** tab ↔ session ownership (sole tabId authority) | session lifecycle (closing a tab never kills a session) |
| `threadStore` (webfront) | UI projection of `ThreadIndex` + runtime states pushed via events | its own thread ids (keyed by `sessionId`) |

### 3.3 Unified construction: `AgentAssembler` (fixes D1, D10, and PR #326's root cause)

`AgentRegistry.createSession()`'s inlined extension branch is deleted. Both platforms
provide an `AgentAssembler` (the injection point already exists as `agentFactory`; this
promotes it to the *only* path and gives it a real contract):

```ts
interface AgentAssembler {
  assemble(input: {
    config: AgentConfig;
    initialHistory: InitialHistory;
    auth: AuthContext;          // NEW: auth is a construction input
    services: SessionServices;  // shared cache manager, storage, etc. (kills the 4x SessionCacheManager news)
  }): Promise<AssembledAgent>;  // { agent, subAgentRunner, dispose }
}
```

Key rule: **`RepublicAgent.initialize()` receives the `AuthContext` before it builds the
first model client**, so the client is correct on first build. The compensation patterns die:

- server's init-then-refresh double work (`ServerAgentBootstrap.ts:348-351`) → deleted
- extension's missing auth on `session.create` → impossible by construction
- the 4 hand-rolled auth sweeps (D10) → replaced by one `SessionManager.applyAuth(authContext)`
  used by `agent.initAuth`, `auth.completeLogin`, `auth.logout`, OIDC exchange

This follows the proven sub-agent pattern (share the live object, don't re-derive state per
construction).

### 3.4 One rebuild path (fixes D2, D5, D11)

`refreshModelClient()` and `hotSwapModelClient()` are replaced by a single method:

```ts
// RepublicAgent
async rebuildExecutionContext(reason: 'auth-changed' | 'model-changed' | 'config-changed'): Promise<void>
```

Behavior:
- **Mutates** the existing `TurnContext` (the `hotSwap` approach) — approval/sandbox policy
  and tab overrides survive.
- **Defers when tasks are running** using the existing `pendingModelKey` pattern, applied at
  the next turn boundary — for *every* caller, not just self-subscription (D5).
- Rebuilds only what the `reason` requires: `auth-changed` rebuilds the model client but does
  **not** tear down the memory service or recompose prompts; `config-changed` recomposes
  prompts. (Today every path redoes everything — D11.)
- Credential store is read **once** per rebuild (factory read is authoritative; the missing-
  key warning consumes the same read).

### 3.5 One config propagation path (fixes D3, D4)

`RepublicAgent` no longer subscribes to `config-changed` (the constructor subscription at
`RepublicAgent.ts:316` is removed, which also removes the leak in D4 by construction).
`SessionManager` subscribes **once** and orchestrates:

```
AgentConfig 'config-changed'
   └─► SessionManager.onConfigChanged(diff)
          └─► for each LIVE session (parallel):
                 agent.rebuildExecutionContext(reasonFor(diff))   // defers if running
```

`agent.configUpdate` becomes the same sweep on both platforms — history is preserved
everywhere (D8; the extension's destroy-everything override is deleted).

### 3.6 Hydration & suspension (fixes D7, D13; absorbs PR #326 follow-ups)

`SessionManager` gains two verbs; the misleading `AgentRegistry.resumeSession()` is deleted
(D7 — its only caller, extension startup, moves to `ThreadIndex` loading which does not need
live agents at all):

```ts
class SessionManager {
  // create-or-continue; the ONLY way UI opens a session
  async open(sessionId?: string): Promise<SessionHandle>;
  // internal: LRU eviction + explicit app shutdown
  private async suspend(sessionId: string): Promise<void>;
}
```

**`open(sessionId?)`**
1. No `sessionId` → new session: append `ThreadIndex` entry, assemble agent (§3.3), state → IDLE.
2. `sessionId` live → return handle (pure map lookup, O(1)).
3. `sessionId` suspended → state → HYDRATING; load rollout; assemble agent with
   `initialHistory: { mode: 'resumed', ... }`; state → IDLE.
4. If live count = `maxLive` (default 5): suspend the LRU **idle** session first. If all live
   sessions are RUNNING, overshoot is permitted up to `hardMax` (default 10, reusing existing
   `MAX_CONCURRENT_LIMIT`); beyond that, `open` returns a typed `busy` result the UI surfaces
   ("N agents are running — wait or stop one"), it does not throw.

**`suspend(sessionId)`** (only IDLE sessions)
1. State → SUSPENDING.
2. Flush rollout; persist `ThreadIndex` entry (lastActiveAt).
3. Release tab leases (§3.7).
4. Dispose the agent graph — safe now because D4's leak is structurally gone.
5. Remove from live map. State → SUSPENDED.

**Latency budget** (this is where PR #326 is absorbed — see §8):

| Interaction | Budget | How |
|---|---|---|
| Click a suspended session → history visible | < 150 ms | Optimistic render: UI paints from rollout/cache immediately; hydration proceeds in background |
| Click a suspended session → can send message | < 1 s | Hydration is the *only* work (single init, auth pre-wired, no double-compose); input enabled on IDLE; a message typed during HYDRATING queues |
| New chat → input ready | < 300 ms | `open()` response carries `{ sessionId, state, liveCount, maxLive }` so the UI needs **one** round trip (kills `session.getActiveCount` follow-up, D14) |

### 3.7 Tabs decoupled from sessions (fixes D9)

- `TabLeaseStore` becomes the **only** owner of tab ↔ session mapping. `AgentSession._metadata.tabId`
  and `Session.setTabId()` are removed; readers query the lease store (or the handle caches a
  read-through view).
- A session acquires a tab/tab-group **lazily**, when a browser tool first needs one, and
  releases leases on suspend. The tab-group "letter" naming moves behind the lease store.
- Closing a browser tab releases the lease and notifies the agent (tool-level error on next
  browser action) — it **never** terminates the session (today: tab closure tears the session
  down, `AgentRegistry.ts:544-559`).

### 3.8 Per-agent prompt context (fixes D6)

`PromptLoader`'s module-level composer singleton keys its static context per agent (or the
composer becomes an instance owned by `AgentAssembler` and passed into `RepublicAgent`).
Session-scoped prompt extensions already work (`sessionPromptExtensions` map) — this change
makes persona/browser-connection context follow the same pattern instead of first-agent-wins.

## 4. UI Design (on top of PR #298)

PR #298 gives us `LeftPanelSection` + `ChatHistorySection` + `chatHistoryStore`. This design
promotes that history list into the **thread list** — one list, not "open tabs" + "history".

### 4.1 Left panel

```
┌ Chat ──────────────────────┐
│  + New chat                │   ← replaces "new thread tab"
│                            │
│  📌 Fix payment flow    ●  │   ← pinned first; ● = running indicator
│  📌 Q3 report draft        │
│  ──────────────────────    │
│  Refactor session mgmt  ●  │   ← recent, running
│  Browser automation ...    │   ← recent, idle/suspended (visually identical)
│  Yesterday's debugging     │
│  more…                     │   ← existing ChatHistoryModal (paginated)
└────────────────────────────┘
```

- **Pin/unpin**: context-menu or hover action; `pinned` persists on the `ThreadIndex` entry;
  pinned items sort first, then by `lastActiveAt`.
- **Running indicator**: driven by SessionManager state-change events pushed over the existing
  event channel; RUNNING shows an activity dot/spinner; IDLE and SUSPENDED are visually
  identical (the user should not perceive hydration state).
- **Click**: `session.open` + optimistic history render (§3.6). The active session highlights.
- **Delete** (context menu, confirm): the only destructive action; removes rollout + index entry.
- The in-chat thread **tab strip disappears**. `threadStore` remains as the UI projection but
  is keyed by `sessionId` and fed from `ThreadIndex` + runtime events (no more UI-generated
  thread ids — per `simplify_session`).
- Narrow mode (extension side panel): the existing `ChatHistoryPopup` stays (PR #298's
  decision), gaining the same running indicators.

### 4.2 RPC surface changes

| RPC | Change |
|---|---|
| `session.open` (new) | Create-or-continue (§3.6). Response: `{ sessionId, state, liveCount, maxLive, title }`. Replaces UI use of `session.create` + `session.resume`. |
| `session.list` | Returns `ThreadIndex` entries with runtime state (`suspended/idle/running`) — powers the left panel in one call. |
| `session.pin` / `session.unpin` (new) | Toggle `pinned` on the index entry. |
| `session.delete` (new) | Destructive delete (rollout + index). |
| `session.getActiveCount` | Deprecated for UI use (`open`/`list` responses carry counts) — D14. |
| `session.create`, `session.resume` | Kept for compatibility (server API consumers), implemented on `SessionManager.open`. |
| `session.rewind` | Unchanged semantics; implemented as fork → `open`. |

## 5. Session independence guarantees (goal 1)

Parallel sessions must not interfere. The redesign keeps the strong per-session isolation
that already exists, and closes the known cross-talk channels:

| Channel | Today | Target |
|---|---|---|
| Agent object graph | Fully per-session (adapter, tools, approval gate) — good, kept | Same, but assembled via one `AgentAssembler` |
| Model client / auth | Per-session factory; auth swept inconsistently (D1/D10) | Per-session factory; `AuthContext` injected at build; central sweep |
| Config events | Every agent (incl. disposed ones) self-subscribes (D3/D4) | Only SessionManager subscribes; live sessions swept with per-session deferral |
| Prompt static context | Process-global, first-agent-wins (D6) | Per-agent |
| Tabs | Session-owned tab groups; closure kills session (D9) | Leased resource; closure never kills a session |
| Submission concurrency | `AgentSession._submitting` per session — kept | Same |

## 6. What we deliberately do NOT change now

- `Session.ts` decomposition (D12): out of scope. Guardrail: new session-scoped features go
  into injected collaborators (`SessionServices`), never new fields on `Session`. Extraction
  (memory, title, suggestions) is a follow-up series.
- The engine/turn loop, tool orchestration, approval system: untouched.
- Sub-agent/shadow-agent creation: untouched (already the model we're moving toward).
- Server multi-tenant registry instancing: `SessionManager` keeps the same
  singleton-on-extension / instance-on-server split, now explicit in its constructor docs.

## 7. Implementation plan (phases → see tasks.md)

- **Phase 0 — unblock**: merge PR #298; close PR #326 pointing at this doc.
- **Phase 1 — correctness patches** (small PRs, immediately shippable): fix D4 (unsubscribe +
  subscribe-after-init), D5 (deferral in all rebuild paths), consolidate D2 into
  `rebuildExecutionContext`.
- **Phase 2 — construction unification**: `AuthContext`, `AgentAssembler`, delete the inlined
  extension branch and the server double-init, single auth sweep (D1, D10, D11).
- **Phase 3 — SessionManager**: states + `open`/`suspend`, LRU, `ThreadIndex`, central config
  propagation (D3, D7, D13), tab-lease decoupling (D9).
- **Phase 4 — UI**: left-panel thread list on PR #298 (pinning, indicators, optimistic open),
  remove tab strip, `session.open`/`list`/`pin`/`delete` RPCs (D14).
- **Phase 5 — convergence & cleanup**: unify `agent.configUpdate` (D8), per-agent prompt
  context (D6), delete dead paths (`resumeSession`, `refreshModelClient`, `hotSwapModelClient`).

Each phase lands green independently; Phases 1–2 carry regression tests that lock in the
PR #326 behavior (no double-compose on create) at the structural level.

## 8. PR #326 absorption map (goal 4)

| PR #326 item | How this design resolves it |
|---|---|
| Removed redundant `refreshModelClient()` from `session.create` | Made impossible structurally: auth is a construction input (§3.3), so there is no post-init refresh to forget or to double-run. The server path's identical bug (`ServerAgentBootstrap.ts:348-351`) — which #326 did not touch — is fixed by the same change. |
| `Promise.all` for `updateSessionLimits` + `bindToActiveTab` | Superseded: `open` response carries counts (one round trip, §4.2); tab binding leaves the create path entirely (§3.7). |
| Regression test: no double-compose on create | Re-implemented against `AgentAssembler` (Phase 2) — asserts prompt composition/memory-init runs exactly once per assemble, on both platform paths. |
| Follow-up: optimistic thread render | Adopted as the §3.6 latency budget (history visible < 150 ms). |
| Follow-up: lazy agent init on first message | Partially adopted: hydration is background work with input enabled on IDLE and message queueing during HYDRATING; full lazy-init remains a Phase 3 option if budgets aren't met. |
| Follow-up: return `activeCount` in create response | Adopted in `session.open` response (§4.2). |
| Follow-up: perf test drives the real path | Phase 2 test asserts real `assemble()` cost; add a hydration-latency budget test in Phase 3. |

## 9. Risks & open questions

1. **Suspension safety**: disposing an idle agent must not lose queued sub-agent/shadow-agent
   results. Mitigation: a session with live background children counts as RUNNING.
2. **Hydration correctness**: resume already reconstructs history from rollout
   (`session.resume` path) — hydration reuses exactly that path, so risk is concentrated in
   the (existing) rollout completeness, not new code.
3. **Extension MV3 service-worker lifetime**: the worker itself can be killed by the browser;
   SUSPENDED-by-default is *more* robust than today's always-live model, but `ThreadIndex`
   writes must be synchronous-ish (IndexedDB on every state change, as `_autoPersist` does today).
4. **`maxLive` default**: start at 5 (today's cap). Revisit with memory profiling once
   suspension exists; the number becomes a tuning knob rather than a UX wall.
5. **Naming**: `SessionManager` vs keeping `AgentRegistry` name with new semantics — decide at
   Phase 3 PR time; this doc uses `SessionManager` for clarity.
