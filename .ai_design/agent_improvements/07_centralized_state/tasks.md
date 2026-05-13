# Track 07: Centralized State — Tasks

> v1 scope only. Each follow-on (07b–07h) gets its own tasks.md when picked up.
> Target: single PR, ~600–800 LOC, no migration of existing service ownership.

## Step 1 — Store primitive

- [ ] Create `src/core/state/store.ts` (~35 lines)
  - Port claudy's `createStore<T>(initial, onChange?)` verbatim
  - `Set<Listener>` for subscribers
  - `Object.is(next, prev)` short-circuit before notify
  - `subscribe()` returns unsubscribe function
- [ ] Unit tests in `tests/core/state/store.test.ts`
  - Subscribe / unsubscribe lifecycle
  - `Object.is` dedup (no notify on identical state)
  - `onChange` receives `{ newState, oldState }`
  - Listeners fire in insertion order

## Step 2 — AgentState type

- [ ] Create `src/core/state/AgentState.ts`
  - Define `AgentState` interface (7 fields, see design.md)
  - Define `TaskSummary` and `PendingApprovalSummary` helper types
  - Export `getDefaultAgentState(): AgentState`
- [ ] No `DeepImmutable` wrapper in v1; use `readonly` modifiers on the interface

## Step 3 — Singleton store wiring

- [ ] Create `src/core/state/AgentStateStore.ts`
  - Instantiate `createStore<AgentState>(getDefaultAgentState(), onChangeAgentState)`
  - Export `getAgentState()`, `setAgentState(updater)`, `subscribeAgentState(listener)`
  - Single module-level instance — no factory, no DI in v1
- [ ] Export a `dumpAgentState(): string` helper for debug snapshots

## Step 4 — Diff handler

- [ ] Create `src/core/state/onChangeAgentState.ts`
  - Branch 1: `selectedModelKey` change → `modelClientFactory.swapModel(newKey)`
  - Branch 2: `theme` change → `saveConfig({ theme })` via existing config storage
  - Branch 3: `approvalMode` change → emit `approval:mode-changed` event
- [ ] Unit tests in `tests/core/state/onChangeAgentState.test.ts`
  - Each branch fires when its field changes
  - No branch fires when its field doesn't change (Object.is path)
  - Error in one branch doesn't block others (try/catch per branch)

## Step 5 — Read-through facade adapters

- [ ] `AgentConfig`: in the existing `eventHandlers` plumbing
      (`src/config/AgentConfig.ts:36`), on `selectedModelKey` change, call
      `setAgentState(s => ({ ...s, selectedModelKey: newKey }))`. ~5 lines.
- [ ] `ApprovalManager`:
  - On policy mode change → mirror to `approvalMode`
  - On `pendingRequests` enqueue/resolve → mirror summary to `pendingApprovals`
  - ~15 lines total
- [ ] `Session` / `SubAgentRunner` (PR #191 surfaces):
  - On task spawn → add to `runningTasks`
  - On task status transition → update entry
  - On task complete/fail/kill → remove from `runningTasks`
  - On foreground swap → update `foregroundTaskId`
  - ~20 lines total
- [ ] Integration tests in `tests/core/state/integration.test.ts`
  - `AgentConfig` model swap → `getAgentState().selectedModelKey` matches
  - `ApprovalManager.requestApproval` → `pendingApprovals` populated; resolve clears it
  - `Session.spawnTask` → `runningTasks` includes the new task; completion removes it

## Step 6 — Webfront bridge

- [ ] Create `src/webfront/stores/agentStateBridge.ts` (~40 lines)
  - One Svelte `readable` per consumed AgentState field
  - Each backed by `subscribeAgentState` + a field selector
- [ ] Migrate `themeStore.ts` to read from `agentStateBridge`
  - Smallest-blast-radius consumer — proves the bridge pattern
  - Other Svelte stores (`agentStore`, `threadStore`, `usageStore`, `userStore`)
    stay unchanged — migrate in 07g

## Step 7 — Debug + error reporting

- [ ] Wire `dumpAgentState()` into the existing error reporting context
  - One line in the error handler; pretty-printed JSON in the error payload
- [ ] Redact pending approval payloads beyond `{ executionId, toolName, requestedAt }`
      to avoid leaking arguments

## Step 8 — Coverage & docs

- [ ] Verify 80%+ coverage on `src/core/state/**` new files
  - Do NOT chase coverage on the modified existing services
- [ ] Update `CLAUDE.md` if relevant patterns shift (optional)
- [ ] Add a short README at `src/core/state/README.md` documenting:
  - v1 surface
  - How to read / how to write
  - Pointer to follow-on tracks

## Out of scope (v1) — picked up by 07b–07h

- Usage + cost tracking (07b)
- Browsing context fields (07c)
- Tool surface mirror (07d)
- Memory mirror (07e) — also requires `main → agent-improvements` merge
- Coordinator / multi-agent fields (07f) — requires Track 06
- Webfront consolidation beyond `themeStore` (07g)
- `/state` slash command, diff tracking, health checks (07h)
- Memoized selector factory (defer until profiling demands it)
- `DeepImmutable` wrapper (revisit if mutation bugs surface)
- Additional persisted fields beyond `theme`
