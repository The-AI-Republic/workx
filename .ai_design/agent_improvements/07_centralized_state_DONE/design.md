# Track 07: Centralized State

> **Status (2026-05-13):** Implementation-ready for a small v1 slice. Active PR: none.
> Independent track — does **not** require Track 05/05b's `main → agent-improvements`
> merge. Follow-on slices (07b, 07c, …) will land as separate tracks, mirroring the
> 03 → 03b and 05 → 05b pattern.
>
> Key decisions resolved (see [Validation Notes 2026-05-13](#validation-notes-2026-05-13)):
> - **Shape:** flat, not nested-by-domain (matches claudy; avoids domain-boundary
>   bikeshedding; React/Svelte selectors don't care).
> - **Naming:** type is `AgentState`; instance is `agentStateStore` (the literal
>   name `agentStore` is taken by `src/webfront/stores/agentStore.ts`).
> - **v1 scope:** 7 fields, 3 effect branches, no migration of existing service
>   ownership. Read-through facade only.
> - **Persistence:** zero persisted fields in v1. Multi-platform storage adapter
>   makes persisted fields expensive (IndexedDB schema bump + SQLite CREATE TABLE
>   + Rust migration per field) — defer until 07b.

## Problem

BrowserX distributes state across multiple singletons and service instances: `SessionState`, `AgentConfig`, `RepublicAgent`, `TaskRunner`, `ApprovalManager`, `ToolRegistry`, and 10+ Svelte stores in webfront. This makes it hard to:

- Observe state changes across the system
- Compute derived state (e.g., "is any task running on this domain?")
- Debug state inconsistencies
- Add new state consumers without wiring
- Prevent state drift between services

Claudy uses a centralized `AppState` (~160 top-level fields, flat — not namespaced — wrapped in `DeepImmutable`; see `getDefaultAppState()` in `state/AppStateStore.ts:89–452`) with a tiny homegrown store, a single global change handler, and only a couple of selectors, keeping all runtime state in one observable place. Of those ~160 fields, roughly **75% are terminal/REPL-only** and not portable — see [Not Portable to BrowserX](#not-portable-to-browserx).

## What Claudy Does

### Centralized AppState

```typescript
type State = {
  // Identity
  sessionId: SessionId
  parentSessionId?: SessionId
  projectRoot: string
  cwd: string
  originalCwd: string

  // Cost tracking
  totalCostUSD: number
  totalAPIDuration: number
  totalToolDuration: number
  modelUsage: { [model: string]: ModelUsage }

  // Agent styling
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number

  // Session runtime
  sessionCronTasks: SessionCronTask[]
  sessionCreatedTeams: Set<string>
  sessionTrustAccepted: boolean

  // Skills & planning
  invokedSkills: Map<string, SkillInvocation>
  planSlugCache: Map<string, string>

  // Cache headers (latched for prompt cache stability)
  afkModeHeaderLatched: boolean | null
  fastModeHeaderLatched: boolean | null
  promptCache1hEligible: boolean | null

  // API tracking
  lastAPIRequest: BetaMessageStreamParams
  lastApiCompletionTimestamp: number | null
}
```

### Store Mechanics

Claudy uses a **homegrown** `createStore<T>` (~35 lines, `state/store.ts`):

- A singleton closure variable holds the current state.
- Pub/sub list of subscribers; `setState(updater)` runs the updater, then notifies.
- `Object.is(next, prev)` short-circuits when the reference is unchanged — no notify.
- **No immer, no Zustand, no React Context-based store.**
- React integration is a single `useSyncExternalStore` call in `state/AppState.tsx`.

```typescript
// Generic setter with change tracking — no per-field setters, no atomic multi-field API
setAppState((prev) => ({ ...prev, sessionId, projectDir, cwd }))
```

### Side-Effect Handler (Single Global Diff)

Claudy does **not** register per-field effects. Instead, a single global function `onChangeAppState({ newState, oldState })` (`state/onChangeAppState.ts:43–171`) runs after every commit and does manual `if (newState.x !== oldState.x)` diffing across the fields it cares about. No per-field registration, no ordering layer, no dependency tracking.

```typescript
// state/onChangeAppState.ts (claudy pattern, simplified)
export function onChangeAppState({ newState, oldState }: { newState: AppState; oldState: AppState }) {
  if (newState.cwd !== oldState.cwd) {
    // reload CLAUDE.md, re-evaluate skills, update terminal title
  }
  if (newState.selectedModel !== oldState.selectedModel) {
    // update token limits, adjust prompt cache strategy
  }
  // …more inline diffs
}
```

BrowserX should adopt this same diff-based pattern, not invent a per-field registry:

```typescript
export function onChangeAgentState({ newState, oldState }: { newState: AgentState; oldState: AgentState }) {
  if (newState.selectedModel !== oldState.selectedModel) {
    updateTokenLimits(newState.selectedModel)
  }
}
```

### Selectors

Claudy ships only **2 real selectors** today (`getViewedTeammateTask`, `getActiveAgentForInput` in `state/selectors.ts`). There is **no memoized `createSelector` factory**. Memoization is whatever React's `useSyncExternalStore` plus selector identity provides. BrowserX should not promise a memoized selector factory in Phase 1.

### Persistence

Claudy persistence is **selective**, not whole-state. Only settings, model, panel visibility, `expandedView`, and `verbose` persist (via `saveGlobalConfig` / `updateSettingsForSource`). `tasks`, `mcp.clients`, `plugins`, etc. do NOT persist. AppState starts fresh each session via `getDefaultAppState()`. There is no snapshot/replay, no devtools, and no schema migrations.

### What Claudy Does NOT Do

- No per-field effect registration (uses a single diff handler instead)
- No memoized selector factory
- No persistent state snapshots (selective persistence only)
- No time-travel devtools
- No state versioning / migrations

## BrowserX Mapping

### Current State Distribution

```
RepublicAgent         → agentId, config, session, isRunning
Session/SessionState  → history, approvedCommands, tokenInfo, tabId, compactionCount
TurnManager           → activeTurn, turnContext
TaskRunner            → taskState, submissionId, status
ApprovalManager       → pendingRequests, history, policy
ToolRegistry          → tools, riskAssessors
AgentConfig           → model, provider, apiKeys, toolsConfig, approvalPolicy

// Svelte stores (webfront):
agentStore, threadStore, platformStore, schedulerStore,
layoutStore, themeStore, tokenUsageStore, usageStore,
userStore, vaultStore
```

### Problems with Distributed State

1. **Cross-cutting queries**: "What's the total token usage across all sessions?" requires reading multiple stores
2. **State synchronization**: Config changes in AgentConfig must propagate to Session, TurnManager, ApprovalManager
3. **Debugging**: No single place to inspect full agent state
4. **New consumers**: Adding a feature that needs state from 3 different services requires complex wiring

### Proposed Architecture

```
src/core/state/
├── AgentState.ts           # Centralized state type + getDefaultAgentState()
├── store.ts                # Tiny createStore<T> (pub/sub, Object.is short-circuit)
├── AgentStateStore.ts      # Singleton wiring + getAgentState/setAgentState
├── selectors.ts            # Plain selector functions (no memoized factory in Phase 1)
└── onChangeAgentState.ts   # Single global diff handler (no per-field registry)
```

(No `migrations.ts` — claudy has no state versioning, and BrowserX is not committing to one in Phase 1.)

### AgentState Type — v1 (this PR)

v1 includes **only the 7 fields read by 5+ files today** (verified by codebase audit
2026-05-13). Each one already exists somewhere; we are not inventing state, we are
giving it a single observable home.

```typescript
interface AgentState {
  // Routing identity — currently Session.sessionId (1477 refs)
  sessionId: string | null

  // Model selection — currently AgentConfig.currentConfig.selectedModelKey (29 files)
  selectedModelKey: string | null

  // Approval policy mode — currently ApprovalManager.policy (15+ files)
  approvalMode: ApprovalMode

  // Task registry — currently Session.activeTasks + TaskRunner.state, scattered (PR #191)
  runningTasks: Record<string, TaskSummary>

  // Foreground task — currently Session.foregroundTaskId (from PR #191)
  foregroundTaskId: string | null

  // Pending approvals — currently ApprovalManager.pendingRequests (Map)
  pendingApprovals: Record<string, PendingApprovalSummary>

  // Theme — currently webfront/stores/themeStore.ts (UI store, mirrored on read)
  theme: 'light' | 'dark' | 'system'
}

type TaskSummary = {
  id: string
  type: 'background_agent'        // expanded by Track 04
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  startedAt: number
}

type PendingApprovalSummary = {
  executionId: string
  toolName: string
  requestedAt: number
}
```

That's the entire v1 surface. No tabId, no domain, no token counters, no MCP, no
memory, no coordinator. Those land in 07b+.

### AgentState Type — Roadmap (07b, 07c, …)

Fields earmarked for follow-on slices, each its own PR. Order is suggestive, not binding:

- **07b — usage & cost:** `totalTokensUsed`, `totalCostUSD`, `modelUsage` (read-through
  facade over `TokenUsageStore`).
- **07c — browsing context:** `activeTabId`, `activeDomain`, `approvedDomains` (binds
  to extension/desktop tab APIs; platform-specific).
- **07d — tool surface:** `enabledTools`, `disabledTools`, `mcpServersConnected`
  (read-through over `ToolRegistry`).
- **07e — memory mirror** (depends on `main → agent-improvements` merge — Track 05/05b
  prerequisite): `sessionMemoryInitialized`, `lastMemoryExtractionAt`.
- **07f — coordinator/multi-agent** (depends on Track 06): `isCoordinatorMode`,
  `activeWorkerCount`, `workerSummary`.
- **07g — webfront consolidation:** absorb `agentStore`, `threadStore`, `usageStore`,
  `userStore` (the four that mirror server state today). `layoutStore`, `themeStore`,
  `platformStore` stay as Svelte stores — they're UI-local and never round-trip.

### Not Portable to BrowserX

Roughly 15–20 of claudy's 87 fields are terminal-only and should NOT be ported into `AgentState`:

- `replContext` — Node REPL VM context
- `sessionHooks` — post-sampling hooks, REPL-specific
- `tungstenActiveSession`, `tungstenPanelVisible`, `tungstenPanelAutoHidden` — tmux integration
- `expandedView` — TUI layout flag (replace with web-appropriate panel state)
- Other terminal/Ink-specific UI flags

Audit the full `getDefaultAppState()` list and drop anything with no web/extension equivalent.

### Resolved: Flat shape

We pick **flat** (matches claudy). Rationale:
- v1 has 7 fields — nesting buys nothing at this size.
- Selectors handle all derived/grouped views; the storage layout doesn't need to mirror domains.
- Spread updates stay shallow, which keeps the free-for-all `setState` pattern (claudy's lesson) survivable: `setAgentState(s => ({ ...s, foregroundTaskId: id }))` can't accidentally clobber an unrelated nested object.
- Nested shapes invite domain bikeshedding (does `runningTasks` go under `session.*` or `tasks.*`?). Flat sidesteps that entirely.

When 07b/07c land and the field count climbs past ~25, revisit. Until then, flat.

### Naming & Collisions

Audited against the codebase 2026-05-13:

| Name | Status | Verdict |
|------|--------|---------|
| `AgentState` (type) | Not used anywhere | **Use** as the type name |
| `agentStateStore` (instance) | Not used | **Use** as the singleton instance |
| `agentStore` | **Taken** — `src/webfront/stores/agentStore.ts` | Avoid |
| `appStore` / `AppState` | Not used, but `AgentConfig`/`AgentRegistry` follow `Agent*` convention | Pass — staying with `AgentState` keeps the prefix consistent |
| `SessionState` | Taken — `src/core/session/state/SessionState.ts` (per-session data container) | Don't rename; it's a different scope (per-session, not app-wide). Coexists fine. |
| `TurnState`, `TaskState`, `ExecutionState` | All taken, all narrow scopes | Coexist fine — `*State` suffix is house style |
| `src/core/state/` (new directory) | Sibling of existing `src/core/session/state/` | OK — different concern, parallel naming |

### Selectors (Derived State)

```typescript
// Plain functions over state. Phase 1 does NOT introduce a memoized selector factory;
// rely on selector identity + useSyncExternalStore (or Svelte derived stores).
const isAnyTaskRunning = (state: AgentState) =>
  state.activeTaskCount > 0 || state.backgroundTaskCount > 0

const currentDomainTrusted = (state: AgentState) =>
  state.activeDomain != null && state.approvedDomains.has(state.activeDomain)

const totalToolsAvailable = (state: AgentState) =>
  state.enabledTools.size + state.mcpServersConnected.length

const sessionDuration = (state: AgentState) =>
  Date.now() - state.sessionStartTime

const isApprovalBacklogged = (state: AgentState) =>
  state.pendingApprovals > 3
```

### Effects (Single Diff Handler) — v1

Match claudy's pattern: one global `onChangeAgentState({ newState, oldState })` that
runs after every commit and inline-diffs the fields it cares about. **Do not build a
per-field `registerEffect` registry.**

v1 ships with exactly **3 effect branches**:

```typescript
// src/core/state/onChangeAgentState.ts
import { saveConfig } from '../../config/storage'
import { emitEvent } from '../events/EventBus'  // assumes Track 01 hook bus is in
import { modelClientFactory } from '../../model/ModelClientFactory'

export function onChangeAgentState({
  newState,
  oldState,
}: {
  newState: AgentState
  oldState: AgentState
}) {
  // 1. Model swap — keep the model client in sync without RepublicAgent.setupConfigSubscriptions()
  if (newState.selectedModelKey !== oldState.selectedModelKey && newState.selectedModelKey) {
    modelClientFactory.swapModel(newState.selectedModelKey).catch((err) =>
      console.error('[agentState] model swap failed', err),
    )
  }

  // 2. Theme persistence — only persisted field in v1; Svelte themeStore reads from here downstream
  if (newState.theme !== oldState.theme) {
    saveConfig({ theme: newState.theme }).catch((err) =>
      console.error('[agentState] theme save failed', err),
    )
  }

  // 3. Approval-mode broadcast — fixes the same class of bug claudy's onChangeAppState fixed
  //    (mode change in one place not reaching the UI / event log)
  if (newState.approvalMode !== oldState.approvalMode) {
    emitEvent('approval:mode-changed', {
      from: oldState.approvalMode,
      to: newState.approvalMode,
      at: Date.now(),
    })
  }
}
```

That's it for v1. Each later track adds its own `if` block — no registry, no
ordering layer, no dependency tracking. When this file passes ~15 branches, revisit.

### Migration from Current Architecture

This is NOT a rewrite. The approach is:

1. **Create AgentStateStore as a thin facade** over existing services
2. **Existing services continue to own their state** (SessionState, AgentConfig, etc.)
3. **AgentStateStore reads from services** via defined adapter interfaces (see below)
4. **Selectors compute derived state** without duplicating storage
5. **Effects replace ad-hoc state propagation** (currently in config subscriptions)

Over time, state ownership can migrate from individual services to AgentStateStore as the codebase evolves.

### Adapter Interfaces

Each existing service must expose a state surface for the central store to read from. These adapters define what state is available and how it's accessed (pull vs. push):

```typescript
// Adapter for SessionState (src/core/session/state/SessionState.ts)
// Method: Pull — SessionState is a pure data container with getters
interface SessionStateAdapter {
  getHistory(): ResponseItem[]
  getApprovedCommands(): Set<string>
  getTokenInfo(): TokenUsageInfo | undefined
  getTabId(): number
  getCompactionCount(): number
  getLastCompactionTime(): number | undefined
}

// Adapter for ApprovalManager / ApprovalGate (src/core/approval/)
// Method: Pull + Event — read current state, subscribe to approval events
interface ApprovalStateAdapter {
  getPendingApprovals(): number
  getApprovalMode(): ApprovalMode
  getApprovedDomains(): Set<string>
  onApprovalDecision(handler: (event: ApprovalEvent) => void): void
}

// Adapter for ToolRegistry (src/tools/ToolRegistry.ts)
// Method: Pull — registry is relatively static after initialization
interface ToolRegistryAdapter {
  getRegisteredTools(): Set<string>
  getEnabledTools(): Set<string>
  getDisabledTools(): Set<string>
  getMcpServers(): string[]
}

// Adapter for TaskRunner (src/core/TaskRunner.ts)
// Method: Pull + Event — read current task state, subscribe to task lifecycle events
interface TaskRunnerAdapter {
  getActiveTaskCount(): number
  getBackgroundTaskCount(): number
  getTaskSummary(): Record<string, TaskStatus>
  onTaskStateChange(handler: (event: TaskLifecycleEvent) => void): void
}

// Adapter for AgentConfig (src/config/AgentConfig.ts)
// Method: Event — already has config-changed event via RepublicAgent.setupConfigSubscriptions()
interface AgentConfigAdapter {
  getSelectedModel(): string
  getSelectedProvider(): string
  onConfigChange(handler: (event: IConfigChangeEvent) => void): void
}
```

**Pull vs. Event strategy:**
- **Pull** (getter calls): For state that changes infrequently or where the central store can afford to read on demand. SessionState, ToolRegistry.
- **Event** (subscription): For state that changes frequently or must trigger side effects. AgentConfig already has `config-changed` events via `RepublicAgent.setupConfigSubscriptions()` (line 186). TaskRunner should emit lifecycle events.
- **Pull + Event** (hybrid): Initial read via getter, then subscribe for updates. ApprovalManager, TaskRunner.

The central store updates its internal snapshot when:
1. An event fires from a subscribed adapter
2. A selector is accessed and the underlying adapter state has changed (lazy pull)

### v1 Plan (this PR — ~600–800 LOC, single PR)

Goal: prove the pattern, ship the smallest possible thing, leave existing services
untouched.

**Step 1 — Store primitive** (`src/core/state/store.ts`, ~35 lines)
- Port claudy's `createStore<T>(initial, onChange?)` verbatim. Set-based listeners,
  `Object.is(next, prev)` dedup, `subscribe()` returns unsub, `setState(updater)`.
- Generic and reusable — not just for `AgentState`.

**Step 2 — AgentState type** (`src/core/state/AgentState.ts`)
- Define the 7-field interface (above).
- Export `getDefaultAgentState()` returning the initial snapshot.
- No `DeepImmutable` wrapper in v1 — TypeScript `readonly` is enough; revisit if mutation bugs surface.

**Step 3 — Singleton wiring** (`src/core/state/AgentStateStore.ts`)
- Instantiate `createStore<AgentState>(getDefaultAgentState(), onChangeAgentState)`.
- Export `getAgentState()`, `setAgentState(updater)`, `subscribeAgentState(listener)`.
- Single module-level instance. No factory, no DI in v1.

**Step 4 — Diff handler** (`src/core/state/onChangeAgentState.ts`)
- Three branches as shown above: `selectedModelKey`, `theme`, `approvalMode`.
- No registry, no per-field effects.

**Step 5 — Read-through facade adapters** (in the existing service files, not new ones)
- `AgentConfig` — on `selectedModelKey` change in its existing `eventHandlers`,
  call `setAgentState(s => ({ ...s, selectedModelKey: newKey }))`. ~5 lines.
- `ApprovalManager` — on policy mutation, mirror into `setAgentState`. On pending
  request enqueue/resolve, mirror `pendingApprovals` summary. ~15 lines.
- `Session.spawnTask` / `SubAgentRunner` (PR #191 surfaces) — on task lifecycle,
  mirror `runningTasks` and `foregroundTaskId` summaries. ~20 lines.
- Existing services keep being the source of truth. AgentState is a **read-only
  observable mirror** in v1.

**Step 6 — Webfront bridge** (`src/webfront/stores/agentStateBridge.ts`, ~40 lines)
- One Svelte `readable` per consumed field, backed by `subscribeAgentState`.
- Migrate `themeStore` to read from this bridge (smallest, lowest-risk consumer).
- Leave `agentStore`, `threadStore`, etc. unchanged — they migrate in 07g.

**Step 7 — Debug snapshot**
- Add `dumpAgentState(): string` returning pretty-printed JSON.
- Wire into existing error reporting context (one-line addition in error handler).

**Step 8 — Tests** (`tests/core/state/`)
- Unit: `createStore` (subscribe/unsubscribe, Object.is dedup, onChange firing).
- Unit: `onChangeAgentState` (each of the 3 branches fires on change, skipped on no-change).
- Integration: `AgentConfig` model swap → `getAgentState().selectedModelKey` updated.
- Integration: `ApprovalManager.requestApproval` → `pendingApprovals` populated.
- Aim 80%+ coverage on new files; do not chase coverage on existing services.

### Follow-on Tracks (NOT in this PR)

Each is a separate design + PR, mirroring the 03/03b and 05/05b pattern:

| Track | Scope | Depends on |
|-------|-------|------------|
| **07b** | Usage + cost mirror (`totalTokensUsed`, `totalCostUSD`, `modelUsage`) | TokenUsageStore exists today |
| **07c** | Browsing context (`activeTabId`, `activeDomain`, `approvedDomains`) | Per-platform tab APIs |
| **07d** | Tool surface (`enabledTools`, `disabledTools`, `mcpServersConnected`) | Tool registry stable |
| **07e** | Memory mirror (`sessionMemoryInitialized`, `lastMemoryExtractionAt`) | Track 05 + `main → agent-improvements` merge |
| **07f** | Coordinator/multi-agent (`isCoordinatorMode`, `activeWorkerCount`, `workerSummary`) | Track 06 |
| **07g** | Webfront consolidation — replace `agentStore`, `threadStore`, `usageStore`, `userStore` with bridge | 07b for usage |
| **07h** | Diagnostics — `/state` slash command, diff tracking, health checks, periodic audits | All above |

Each follow-on adds: 3–8 fields + ≤3 effect branches + 1–2 adapter wires. Stays under the ~15-branch ceiling per `onChangeAgentState`.

## Risks

- **Dual source of truth (v1, by design):** services keep ownership; AgentState is a
  read-only mirror. The risk is mirror drift — adapter forgets to call `setAgentState`
  on some mutation path. Mitigations:
  - Adapter code lives in the same file as the mutation (e.g., the `setAgentState`
    call sits next to the `this.policy = …` line in `ApprovalManager`), making drift
    visible at code-review time.
  - Tests assert that AgentState matches the underlying service after representative
    mutations.
  - v1 keeps the mirrored field set tiny (7), so the audit surface is small.
- **Free-for-all writes:** any module can call `setAgentState`. Claudy lives with
  this. Mitigations: spread-operator discipline, code review, no concurrent setState
  in a tick. Revisit if v1 surfaces real bugs.
- **Multi-platform persistence is expensive:** every persisted field requires
  `STORE_KEY_PATHS` entry + IndexedDB schema bump + SQLite CREATE TABLE + Rust
  migration. v1 dodges this by persisting **only `theme`** (which already has a
  config storage path). Future persisted fields are explicit per-track decisions.
- **Naming overlap with `SessionState`:** different scope (per-session container vs
  app-wide observable). Audited 2026-05-13; no API collision. Documented in
  [Naming & Collisions](#naming--collisions).
- **Bootstrap-state-style split (claudy lesson):** if circular deps force any field
  out of AgentState, document why in a comment header, and treat splits as a code
  smell to revisit.

## Validation Notes (re-checked vs claudy 2026-05-11)

Re-validated this design against the current claudy source. Corrections applied:

- **AppState size & shape**: pinned to ~87 top-level fields, flat (not namespaced), wrapped in `DeepImmutable` per `getDefaultAppState()` in `state/AppStateStore.ts:456–569`.
- **Store mechanics**: replaced "typed getters / atomic multi-field setters" framing with claudy's actual ~35-line homegrown `createStore<T>` in `state/store.ts` (pub/sub + `Object.is` short-circuit). React integration is `useSyncExternalStore` in `state/AppState.tsx`. No immer / Zustand / Context store.
- **Side-effects**: removed the per-field `registerEffect('cwd', handler)` API. Claudy uses a single global `onChangeAppState({ newState, oldState })` (`state/onChangeAppState.ts:43–171`) that inline-diffs fields. BrowserX adopts the same pattern.
- **Selectors**: clarified that claudy ships only 2 real selectors (`getViewedTeammateTask`, `getActiveAgentForInput` in `state/selectors.ts`) and has no memoized `createSelector` factory. Phase 2 no longer promises memoization.
- **Persistence**: clarified that claudy persistence is selective (settings, model, panel visibility, `expandedView`, `verbose` via `saveGlobalConfig` / `updateSettingsForSource`); `tasks`, `mcp.clients`, `plugins` do not persist. AppState resets per session. No snapshot/replay/devtools/migrations — `migrations.ts` removed from the file layout.
- **Terminal-only fields**: added a "Not Portable to BrowserX" subsection (`replContext`, `sessionHooks`, `tungsten*`, `expandedView`, etc. — ~15–20 of 87 fields).
- **Open decision**: flagged flat vs nested-by-domain `AgentState` as a Phase 0 decision for BrowserX.
- **What claudy does NOT do**: added an explicit list (no per-field effect registry, no memoized selector factory, no persistent snapshots, no time-travel devtools, no state versioning).

Sources: `state/store.ts`, `state/AppState.tsx`, `state/AppStateStore.ts`, `state/onChangeAppState.ts`, `state/selectors.ts`.

## Validation Notes (2026-05-13)

Re-validated against the current claudy source AND audited the browserx side
(branch `agent-improvements`) to make this design implementation-ready. Two parallel
research probes ran 2026-05-13.

### Claudy findings (correcting earlier estimates)

- **AppState is ~160 fields, not ~87.** `state/AppStateStore.ts:89–452`. Earlier
  estimate was off by ~2x. **~75% are terminal/REPL-only** (`replContext`,
  `sessionHooks`, `tungsten*`, `bagel*`, `computerUseMcpState`, `replBridge*`
  (~13 fields), `ultraplan*` (~5 fields), `teamContext`, footer/expand UI state).
  Portable subset is **~40 fields**, of which only ~7 are read frequently enough to
  justify v1 inclusion.
- **`createStore` is 34 lines exactly.** Quoted verbatim in the
  [Store Mechanics](#store-mechanics) section above. Worth porting 1:1 — it's smaller
  than any wrapper around Zustand we could write.
- **`onChangeAppState` is the choke-point** (`state/onChangeAppState.ts:43–172`). A
  multi-paragraph comment block (lines 52–64) explicitly documents the bug that
  killed the earlier per-callsite pattern: permission mode mutated by 8+ paths,
  only 2 told the SDK, web UI drifted. **This is the single biggest lesson we are
  importing** — applied here to `approvalMode` and `selectedModelKey`.
- **Claudy `tasks` is a mutable dict, not immutable.** A few `delete tasks[id]` sites
  exist. We mirror task summaries into `runningTasks: Record<string, TaskSummary>`
  but treat it as immutable on the browserx side (the source of truth — `Session.activeTasks`,
  `SubAgentRunner` — owns mutability).
- **Persistence is selective**, only ~4 fields trigger disk writes via the diff
  handler. Sessions/transcripts persist separately. **No automatic AppState snapshot.**
  We follow this — only `theme` persists in v1.
- **Bootstrap state is split off** (`bootstrap/state.ts:31` has
  `// DO NOT ADD MORE STATE HERE` warning) to avoid circular deps. Flagged as a
  risk in [Risks](#risks).

### BrowserX-side audit findings (correcting design assumptions)

Existing design referenced fields that don't exist or aren't in scope yet. Audit
2026-05-13 against branch `agent-improvements`:

- **No `src/core/state/` directory exists.** Only `src/core/session/state/` (turn-state
  scaffolding from PR #191 — `SessionState.ts`, `TurnState.ts`, `ActiveTurn.ts`). Track 07
  creates a NEW sibling directory; no naming collision.
- **No `AppState`, `AgentState`, or `appStore` files anywhere in `src/`.** Greenfield.
- **`AgentConfig` already has `eventHandlers: Map`** (`src/config/AgentConfig.ts:36`).
  It is essentially a proto-store. v1 adapter wires into this existing surface — no
  new event plumbing needed for `selectedModelKey`.
- **9 Svelte stores** in `src/webfront/stores/`: `agentStore`, `threadStore`,
  `usageStore`, `tokenUsageStore`, `layoutStore`, `themeStore`, `userStore`,
  `vaultStore`, `platformStore`, `schedulerStore`. Four of them mirror server state
  (`agentStore`, `threadStore`, `usageStore`, `userStore`) — Track 07g consolidates
  those. The other five are UI-local and stay.
- **`agentStore` name is taken** in webfront. The store singleton in v1 is named
  `agentStateStore` to avoid collision.
- **Memory system is NOT on this branch.** `src/core/memory/` exists on `main` only
  (PR #167 merged 2026-05-12, commit `37a092dd`). Branch is 45 commits behind. **Track 07 v1
  is independent — does not require the main merge.** Only 07e (memory mirror) does.
- **Storage adapter cost is real.** `STORE_KEY_PATHS` in `src/storage/StorageAdapter.ts:17–28`
  currently lists 10 stores. Adding a persisted field requires edits to: that path,
  `IndexedDBAdapter` (schema bump), `NodeSQLiteAdapter` (CREATE TABLE), `TauriSQLiteAdapter`
  (Rust migration). v1 reuses the existing `config` store for `theme`; no new stores added.
- **Open PRs (2026-05-13):** #198 (hook/event system), #197 (tool metadata), #194
  (plugin design), #190 (web UI), #189 (smoke test), #166 (release). None conflict
  with v1; we depend on #198 only for `EventBus` (the `approval:mode-changed` effect).

### v1 cross-cutting fields (verified read counts)

The 7 fields chosen for v1 are not aspirational — they were selected by counting
references in the codebase. Audit numbers:

| Field | Current owner | Reference count |
|-------|---------------|-----------------|
| `sessionId` | `Session.sessionId` | 1477 refs across src/ |
| `selectedModelKey` | `AgentConfig.currentConfig.selectedModelKey` | 29 files |
| `approvalMode` | `ApprovalManager.policy` | 15+ files |
| `runningTasks` | `Session.activeTasks` + `TaskRunner.state` | 6+ files (post PR #191) |
| `foregroundTaskId` | `Session.foregroundTaskId` | 5+ files (post PR #191) |
| `pendingApprovals` | `ApprovalManager.pendingRequests` (Map) | 8+ files |
| `theme` | `webfront/stores/themeStore.ts` | UI consumers only, but cross-platform |

### Decisions resolved in this revision

1. **Shape:** flat (not nested-by-domain). Documented in
   [Resolved: Flat shape](#resolved-flat-shape).
2. **Naming:** `AgentState` type, `agentStateStore` instance, `src/core/state/`
   directory. Documented in [Naming & Collisions](#naming--collisions).
3. **v1 surface:** 7 fields, 3 effect branches, no service migration, only `theme`
   persisted. Documented in [v1 Plan](#v1-plan-this-pr--600800-loc-single-pr).
4. **Independence from Track 05:** v1 does not require `main → agent-improvements`
   merge. Only 07e does.
5. **Roadmap:** explicit 07b–07h follow-on tracks listed, each in scope of a single
   future PR.

### Open items deliberately deferred to follow-on tracks

- Memoized selector factory (defer to 07h diagnostics if profiling demands it)
- `/state` slash command + diff tracking (07h)
- Periodic health checks (07h)
- Persistence of more than `theme` (each persisted field is its own decision)
- Webfront consolidation (07g)
- `DeepImmutable` wrapper (not in v1; revisit if mutation bugs surface)

Sources for this revision:
- Claudy: `state/store.ts`, `state/AppStateStore.ts:89–452`, `state/onChangeAppState.ts:43–172`,
  `state/selectors.ts`, `bootstrap/state.ts:31`.
- BrowserX: `src/core/Session.ts:49`, `src/core/RepublicAgent.ts:32`,
  `src/core/session/state/SessionState.ts:28`, `src/config/AgentConfig.ts:36`,
  `src/core/registry/AgentRegistry.ts:46`, `src/storage/StorageAdapter.ts:17–28`,
  `src/webfront/stores/*.ts`.
