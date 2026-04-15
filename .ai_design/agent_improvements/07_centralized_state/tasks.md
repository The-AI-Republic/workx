# Track 07: Centralized State - Tasks

## Phase 1: State Type & Store

- [ ] Define `AgentState` interface in `src/core/state/AgentState.ts`
  - Identity fields: agentId, sessionId, platform
  - Session fields: activeTabId, activeDomain, sessionStartTime, isRunning
  - Usage fields: totalTokensUsed, totalCostUSD, modelUsage
  - Approval fields: approvalMode, approvedDomains, approvedCommands, pendingApprovals
  - Task fields: activeTaskCount, backgroundTaskCount, taskSummary
  - Tool fields: enabledTools, disabledTools, mcpServersConnected
  - Config fields: selectedModel, selectedProvider
- [ ] Implement `AgentStateStore` class in `src/core/state/AgentStateStore.ts`:
  - getState(): AgentState (immutable snapshot)
  - setState(updates: Partial<AgentState>): void
  - subscribe(listener: (state) => void): unsubscribe function
  - getFullState(): AgentState (for debugging, includes all fields)
- [ ] Wire store to read from existing services (facade pattern):
  - Read from SessionState for session-related fields
  - Read from AgentConfig for config fields
  - Read from ApprovalManager for approval fields
  - Read from TaskRunner for task fields
  - Read from ToolRegistry for tool fields
- [ ] Add state snapshot method for debugging: `dumpState(): string`
- [ ] Add state serialization for error reporting context
- [ ] Write tests for store creation, getState/setState, subscription

## Phase 2: Selectors

- [ ] Define selector type: `(state: AgentState) => T`
- [ ] Implement memoized selector factory in `src/core/state/selectors.ts`:
  - createSelector(inputSelectors, combiner): MemoizedSelector
  - Re-computes only when input values change
- [ ] Implement core selectors:
  - isAnyTaskRunning: boolean
  - currentDomainTrusted: boolean
  - totalToolsAvailable: number
  - sessionDuration: number
  - isApprovalBacklogged: boolean
  - activeWorkerSummary: WorkerStatus[] (for Track 06)
- [ ] Add selector subscription: subscribe to specific selector, notified only when value changes
- [ ] Create Svelte store adapter: wrap AgentStateStore selector as Svelte readable store
- [ ] Identify and replace ad-hoc derived state computations in existing code
- [ ] Write tests for selector memoization and change detection

## Phase 3: Effects

- [ ] Define `StateEffect` type: (newValue, oldValue, state) => void
- [ ] Implement `registerEffect(field, handler)` in `src/core/state/effects.ts`
- [ ] Implement effect execution on setState: run registered effects for changed fields
- [ ] Add effect ordering: effects run in registration order (deterministic)
- [ ] Migrate existing config subscription handlers from RepublicAgent.initialize():
  - selectedModelKey change → update model client
  - toolsConfig change → update ToolRegistry
  - providerApiKeys change → recreate model client
  - approvalPolicy change → update ApprovalManager
- [ ] Migrate approval mode propagation to effects
- [ ] Add effect dependency tracking: effect A depends on effect B (run B first)
- [ ] Add effect error isolation: failed effect logs error, doesn't block other effects
- [ ] Write tests for effect execution order and error isolation

## Phase 4: State Diagnostics

- [ ] Add `/state` command to CommandRegistry:
  - Dumps current AgentState as formatted JSON
  - Highlights non-default values
  - Shows active effects and selectors
- [ ] Implement state diff tracking:
  - Store previous state on each setState
  - computeDiff(prev, current): StateChange[]
  - Log diffs for debugging (configurable verbosity)
- [ ] Implement state health checks in `src/core/state/healthChecks.ts`:
  - Verify session exists in AgentRegistry
  - Verify active tab is still open
  - Verify approved domains haven't been revoked
  - Verify tool registry matches enabled/disabled state
- [ ] Wire state snapshot into error reporting:
  - Include AgentState summary in error context
  - Redact sensitive fields (API keys, form data)
- [ ] Add periodic health check (configurable interval, default: every 30 turns)
- [ ] Write tests for health checks and state diff computation
