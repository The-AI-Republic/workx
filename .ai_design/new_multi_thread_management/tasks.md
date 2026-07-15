# Multi-Thread Session Management — Task Breakdown

Companion to [design.md](./design.md). Each phase lands green independently.

## Phase 0 — Unblock

- [ ] Merge PR #298 (left-panel chat history) to main
- [ ] Close PR #326 with a comment linking this design (absorption map in design.md §8)

## Phase 1 — Correctness patches (small, independently shippable PRs)

- [ ] **D4** Move `config-changed` subscription from `RepublicAgent` constructor to end of
      `initialize()`; unsubscribe in `cleanupOnce()`
      (`src/core/RepublicAgent.ts:316`, `:1411-1443`)
- [ ] **D5** Add running-task deferral (reuse `pendingModelKey` pattern) to
      `refreshModelClient()` and `hotSwapModelClient()`
- [ ] **D2 (step 1)** Introduce `rebuildExecutionContext(reason)` that mutates the existing
      `TurnContext`; re-implement `refreshModelClient`/`hotSwapModelClient` as thin aliases
- [ ] Regression tests: no listener retained after cleanup; no mid-turn client swap;
      TurnContext policy fields survive rebuild

## Phase 2 — Construction unification

- [ ] **`AuthContext`**: wraps current `IAuthManager` + change events; owned by platform
      bootstrap (`service-worker.ts`, `ServerAgentBootstrap.ts`)
- [ ] **`AgentAssembler` contract** in core; server's `agentFactory` closure becomes its first
      implementation; extension gets an `ExtensionAgentAssembler` extracted from
      `AgentRegistry.ts:172-259`
- [ ] `RepublicAgent.initialize()` accepts `AuthContext`; model client built once, correctly
      (**D1**); delete server init-then-refresh (`ServerAgentBootstrap.ts:348-351`)
- [ ] Single `SessionManager.applyAuth()` sweep; delete the 4 hand-rolled loops (**D10**)
      (`service-worker.ts:536-545, 800-846`, `agent-services.ts:181-191`, `auth-services.ts:127`)
- [ ] Single credential-store read per rebuild (**D11**); reason-scoped rebuild (auth change
      does not rebuild memory service)
- [ ] Thread `SessionServices` (shared `SessionCacheManager` etc.) through the assembler
- [ ] **Test (absorbs PR #326)**: assemble() composes prompt / initializes memory exactly once,
      both platforms; perf assertion on real path

## Phase 3 — SessionManager (lifecycle + capacity)

- [ ] Runtime state machine: `suspended | hydrating | idle | running | suspending`
- [ ] `ThreadIndex` persisted store (sessionId, title, lastActiveAt, pinned, createdAt)
- [ ] `open(sessionId?)` create-or-continue; `suspend()` with LRU eviction of idle sessions;
      `hardMax` overshoot for running sessions; typed `busy` result (**D13**)
- [ ] Central config propagation: SessionManager subscribes to `config-changed`, sweeps live
      sessions in parallel with deferral; remove per-agent self-subscription (**D3**)
- [ ] Delete `AgentRegistry.resumeSession()`; extension startup loads `ThreadIndex` only (**D7**)
- [ ] Tab decoupling: `TabLeaseStore` sole tabId owner; remove `AgentSession._metadata.tabId`
      and `Session.setTabId`; lazy lease acquisition; tab closure releases lease without
      killing session (**D9**)
- [ ] Sessions with live sub-agent/shadow-agent children count as RUNNING (suspension safety)
- [ ] Hydration-latency budget test (history < 150 ms optimistic, sendable < 1 s)

## Phase 4 — UI (on top of PR #298)

- [ ] `session.open` / `session.list` (with runtime state) / `session.pin` / `session.unpin` /
      `session.delete` RPCs; `session.create`/`resume` kept as compat shims
- [ ] Left panel: promote `ChatHistorySection` to the thread list — pinned-first sort, running
      indicator via SessionManager events, click-to-open with optimistic history render
- [ ] Remove the in-chat thread tab strip; `threadStore` keyed by `sessionId`, fed from
      `ThreadIndex` + runtime events
- [ ] Message queueing during HYDRATING
- [ ] Drop UI `session.getActiveCount` calls (**D14**); counts come from `open`/`list`
- [ ] Narrow-mode popup gains running indicators
- [ ] Delete flow with confirmation

## Phase 5 — Convergence & cleanup

- [ ] Unify `agent.configUpdate`: extension uses the same in-place sweep as server; delete the
      destroy-all override (`service-worker.ts:782-822`) (**D8**)
- [ ] Per-agent prompt static context; remove first-agent-wins composer guard
      (`PromptLoader.ts:36-85`) (**D6**)
- [ ] Delete `refreshModelClient` / `hotSwapModelClient` aliases once callers migrate
- [ ] Docs: update `.ai_design/architecture.md` session section to point here

## Explicit non-goals (tracked separately)

- `Session.ts` god-object decomposition (**D12**) — follow-up series; guardrail: new features
  go into injected collaborators
- Engine/turn loop, tool orchestration, approval system changes
- Sub-agent / shadow-agent creation changes
