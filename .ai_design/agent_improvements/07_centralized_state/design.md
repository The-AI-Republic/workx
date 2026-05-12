# Track 07: Centralized State

## Problem

BrowserX distributes state across multiple singletons and service instances: `SessionState`, `AgentConfig`, `RepublicAgent`, `TaskRunner`, `ApprovalManager`, `ToolRegistry`, and 10+ Svelte stores in webfront. This makes it hard to:

- Observe state changes across the system
- Compute derived state (e.g., "is any task running on this domain?")
- Debug state inconsistencies
- Add new state consumers without wiring
- Prevent state drift between services

Claudy uses a centralized `AppState` (~87 top-level fields, flat — not namespaced — wrapped in `DeepImmutable`; see `getDefaultAppState()` in `state/AppStateStore.ts:456–569`) with a tiny homegrown store, a single global change handler, and only a couple of selectors, keeping all runtime state in one observable place.

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

### AgentState Type

```typescript
interface AgentState {
  // Identity
  agentId: string
  sessionId: string
  platform: 'extension' | 'desktop' | 'server'

  // Session
  activeTabId: number | null
  activeDomain: string | null
  sessionStartTime: number
  isRunning: boolean

  // Cost & usage
  totalTokensUsed: number
  totalCostUSD: number
  modelUsage: Record<string, { input: number; output: number }>

  // Approval state
  approvalMode: ApprovalMode
  approvedDomains: Set<string>
  approvedCommands: Set<string>
  pendingApprovals: number

  // Task tracking
  activeTaskCount: number
  backgroundTaskCount: number
  taskSummary: Record<string, TaskStatus>

  // Tool state
  enabledTools: Set<string>
  disabledTools: Set<string>
  mcpServersConnected: string[]

  // Memory (from Track 05)
  sessionMemoryInitialized: boolean
  lastMemoryExtractionAt: number | null

  // Coordinator (from Track 06)
  isCoordinatorMode: boolean
  activeWorkerCount: number
  workerSummary: Record<string, WorkerStatus>

  // Config (read-only mirror)
  selectedModel: string
  selectedProvider: string
}
```

### Not Portable to BrowserX

Roughly 15–20 of claudy's 87 fields are terminal-only and should NOT be ported into `AgentState`:

- `replContext` — Node REPL VM context
- `sessionHooks` — post-sampling hooks, REPL-specific
- `tungstenActiveSession`, `tungstenPanelVisible`, `tungstenPanelAutoHidden` — tmux integration
- `expandedView` — TUI layout flag (replace with web-appropriate panel state)
- Other terminal/Ink-specific UI flags

Audit the full `getDefaultAppState()` list and drop anything with no web/extension equivalent.

### Open Decision: Flat vs Nested-by-Domain

BrowserX must decide whether `AgentState` is **flat** (claudy's choice, optimized for React + `useSyncExternalStore`) or **nested by domain** (`session.*`, `approval.*`, `tools.*`, `tasks.*`). Claudy chose flat for React simplicity, but BrowserX has many singleton services to fold in, and a nested layout may better mirror the existing service boundaries (and make adapter wiring more obvious). Pick before Phase 1.

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

### Effects (Single Diff Handler)

Match claudy's pattern: one global `onChangeAgentState({ newState, oldState })` that runs after every commit and inline-diffs the fields it cares about. **Do not build a per-field `registerEffect` registry.**

```typescript
// src/core/state/onChangeAgentState.ts
export function onChangeAgentState({ newState, oldState }: { newState: AgentState; oldState: AgentState }) {
  if (newState.activeTabId !== oldState.activeTabId) {
    const domain = newState.activeTabId != null ? getTabDomain(newState.activeTabId) : null
    if (domain !== newState.activeDomain) {
      // commit follow-up via setAgentState; reEvaluateSkillVisibility handles the rest
    }
    reEvaluateSkillVisibility(newState.activeDomain)
  }

  if (newState.selectedModel !== oldState.selectedModel) {
    updateTokenLimits(newState.selectedModel)
    invalidatePromptCache()
  }

  if (newState.isCoordinatorMode !== oldState.isCoordinatorMode) {
    if (newState.isCoordinatorMode) registerCoordinatorTools()
    else unregisterCoordinatorTools()
  }
}
```

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

### Phase Plan

**Phase 1: State Type, Store & Adapters** (Week 1)
- Decide flat vs nested-by-domain `AgentState` shape (see open decision above)
- Define `AgentState` interface and `getDefaultAgentState()`
- Implement homegrown `createStore<T>` (~35 lines, pub/sub + `Object.is` short-circuit) — no immer, no Zustand
- Implement adapter interfaces for each existing service (SessionState, ApprovalManager, ToolRegistry, TaskRunner, AgentConfig)
- Wire store to read from existing services via adapters (pull for static state, event subscription for dynamic state)
- Add state snapshot for debugging (`getFullState()`)
- **No memoized selector factory in this phase** — plain selector functions only

**Phase 2: Selectors** (Week 2)
- Add plain selector functions for the most common derived state
- Wire selectors into UI stores (Svelte derived store compatibility)
- Replace ad-hoc derived state computation across the codebase
- Defer any memoized `createSelector` factory until profiling proves it's needed

**Phase 3: Single Diff Handler** (Week 3)
- Implement `onChangeAgentState({ newState, oldState })` and call it from `setAgentState`
- Migrate config subscription handlers from RepublicAgent into the diff handler
- Migrate approval mode propagation into the diff handler
- **No per-field `registerEffect` registry, no effect ordering layer, no dependency tracking** — keep it boring

**Phase 4: State Diagnostics** (Week 4)
- Add `/state` command: dump current AgentState as JSON
- Add state diff tracking (what changed between turns)
- Add state health checks (detect inconsistencies)
- Wire into error reporting (include state snapshot in error context)

## Risks

- **Dual source of truth**: During migration, state exists in both AgentStateStore and original services. Mitigate by making AgentStateStore a read-through facade initially.
- **Performance**: Selector re-computation on every state change. Mitigate with memoization and granular subscriptions.
- **Breaking existing code**: Existing code reads from SessionState, AgentConfig directly. Don't break these paths; add AgentStateStore alongside.

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
