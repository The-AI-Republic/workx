# Track 07: Centralized State

## Problem

BrowserX distributes state across multiple singletons and service instances: `SessionState`, `AgentConfig`, `RepublicAgent`, `TaskRunner`, `ApprovalManager`, `ToolRegistry`, and 10+ Svelte stores in webfront. This makes it hard to:

- Observe state changes across the system
- Compute derived state (e.g., "is any task running on this domain?")
- Debug state inconsistencies
- Add new state consumers without wiring
- Prevent state drift between services

Claudy uses a centralized `AppState` (~80+ fields) with typed getters, atomic multi-field setters, and side-effect handlers, keeping all runtime state in one observable place.

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

### Getters & Setters

```typescript
// Immutable getters
function getSessionId(): SessionId
function getProjectRoot(): string
function getTotalCostUSD(): number

// Atomic multi-field setters (prevent intermediate invalid states)
function switchSession(sessionId: SessionId, projectDir: string): void
// Updates sessionId, projectDir, cwd atomically

// Generic setter with change tracking
function setAppState(updates: Partial<State>): void
```

### Side-Effect Handlers

```typescript
// Claudy uses onChange handlers for derived effects:
onChangeAppState('cwd', (newCwd, oldCwd) => {
  // Reload CLAUDE.md, re-evaluate skills, update terminal title
})

onChangeAppState('selectedModel', (newModel) => {
  // Update token limits, adjust prompt cache strategy
})
```

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
├── AgentState.ts           # Centralized state type definition
├── AgentStateStore.ts      # Store implementation with getters/setters
├── selectors.ts            # Derived state computations
├── effects.ts              # Side-effect handlers for state changes
└── migrations.ts           # State schema versioning
```

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

### Selectors (Derived State)

```typescript
// Computed from base state, memoized:
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

### Effects (Side-Effect Handlers)

```typescript
// When tab changes, update domain and re-evaluate skills:
registerEffect('activeTabId', (newTabId, oldTabId, state) => {
  state.activeDomain = getTabDomain(newTabId)
  reEvaluateSkillVisibility(state.activeDomain)
})

// When model changes, update token limits:
registerEffect('selectedModel', (newModel) => {
  updateTokenLimits(newModel)
  invalidatePromptCache()
})

// When coordinator mode changes, adjust tool set:
registerEffect('isCoordinatorMode', (isCoordinator) => {
  if (isCoordinator) registerCoordinatorTools()
  else unregisterCoordinatorTools()
})
```

### Migration from Current Architecture

This is NOT a rewrite. The approach is:

1. **Create AgentStateStore as a thin facade** over existing services
2. **Existing services continue to own their state** (SessionState, AgentConfig, etc.)
3. **AgentStateStore reads from services** and provides a unified view
4. **Selectors compute derived state** without duplicating storage
5. **Effects replace ad-hoc state propagation** (currently in config subscriptions)

Over time, state ownership can migrate from individual services to AgentStateStore as the codebase evolves.

### Phase Plan

**Phase 1: State Type & Store** (Week 1)
- Define `AgentState` interface
- Implement `AgentStateStore` with getters and setters
- Wire store to read from existing services (facade pattern)
- Add state snapshot for debugging (`getFullState()`)

**Phase 2: Selectors** (Week 2)
- Implement memoized selectors for common derived state
- Add selector subscription (notify on change)
- Replace ad-hoc derived state computation across codebase
- Wire selectors into UI stores (Svelte store compatibility)

**Phase 3: Effects** (Week 3)
- Implement `registerEffect(field, handler)` mechanism
- Migrate config subscription handlers from RepublicAgent to effects
- Migrate approval mode propagation to effects
- Add effect ordering and dependency tracking

**Phase 4: State Diagnostics** (Week 4)
- Add `/state` command: dump current AgentState as JSON
- Add state diff tracking (what changed between turns)
- Add state health checks (detect inconsistencies)
- Wire into error reporting (include state snapshot in error context)

## Risks

- **Dual source of truth**: During migration, state exists in both AgentStateStore and original services. Mitigate by making AgentStateStore a read-through facade initially.
- **Performance**: Selector re-computation on every state change. Mitigate with memoization and granular subscriptions.
- **Breaking existing code**: Existing code reads from SessionState, AgentConfig directly. Don't break these paths; add AgentStateStore alongside.
