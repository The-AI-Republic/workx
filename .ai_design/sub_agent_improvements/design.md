# Sub-Agent System Improvements

> **Doc status (2026-05-11):** Reflects implementation actually landed on the `design-sub-agent` branch. Phases 0, 1, 3 (queue half), and 4 are in code; phase 2's parameter surface is in code but the background **detachment path and notification injection are not wired**. See §1.5 for the precise per-item status and §1.6 for the ordered path to finish the claudy-style design.

## 1. Context

### 1.1 Current State (PR #191, `design-sub-agent` branch)

The sub-agent module has been moved to `src/tools/AgentTool/` and refactored into a `prepare()` / `execute()` / `cleanup()` pipeline. The structural design described in §2 is largely in code; functional gaps are summarized in §1.5.

| Component | File | Notes |
|-----------|------|-------|
| `SubAgentRunner` | `src/tools/AgentTool/SubAgentRunner.ts` | Implements `IAgentRunner` (prepare/execute/cleanup). `run()` always `await`s `execute()`; no background branch yet. |
| `SubAgentRegistry` | `src/tools/AgentTool/SubAgentRegistry.ts` | Concurrency cap (default 3), pending-message queue, retained run summaries, token-usage aggregation. |
| `SubAgentTool` | `src/tools/AgentTool/SubAgentTool.ts` | Builds the `sub_agent` tool definition; schema already includes `background?: boolean`. |
| Management tools | `src/tools/AgentTool/managementTools.ts` | `list_sub_agents`, `cancel_sub_agent`, `send_message` registered alongside `sub_agent`. |
| Built-in types | `src/tools/AgentTool/builtinTypes.ts` | `researcher` (read-only), `planner` (analysis), `worker` (full execution). |
| `IAgentRunner`/`AgentContext` | `src/tools/AgentTool/types.ts` | Pipeline interfaces; `AgentContext` carries `background` flag, abort controller, parent-engine reference, type config. |
| `SubAgentEventRouter` | `src/core/events/SubAgentEventRouter.ts` | Namespaces and filters sub-agent events. |
| `RepublicAgentEngine` | `src/core/engine/RepublicAgentEngine.ts` | `createChildEngine()` accepts `depth`, `maxDepth`, `drainPendingMessages`. `enqueueSyntheticUserTurn()` exists but is **never called from `SubAgentRunner`**. |
| `TaskRunner` drain hook | `src/core/tasks/RegularTask.ts` (loop) | Drains `drainPendingMessages` between turns and feeds messages into pending input. |

**Execution flow today (foreground only, regardless of `background` flag):**
```
LLM calls sub_agent(type, prompt, background?)
  -> SubAgentRunner.run()
       -> prepare()  [resolves type, builds restricted registry, links parent
                      abort + EngineDisposed listener for foreground,
                      creates child engine via parentEngine.createChildEngine(),
                      registers in SubAgentRegistry]
       -> execute()  [await engine.run(input, { signal, maxTurns })]
       -> cleanup()  [engine.dispose(); foreground: unregister; background: retain]
  -> return SubAgentResult to parent LLM
```

The sub-agent shares the main ReAct loop (`TaskRunner.runLoop()` → `TurnManager.runTurn()`), matches the reference architecture, and respects parent abort + parent-engine disposal for foreground runs. **What it does not yet do:** detach when `background: true`, inject a `<task-notification>` back into the parent's input on completion, or drive any of the message-queue plumbing that Phase 3 wired up.

### 1.2 Reference Architecture (Claudy)

Claudy has three distinct agent concepts built on a single shared ReAct loop (`query()` generator):

| Concept | Context | System Prompt | Tools | Async? | Cache Sharing |
|---------|---------|---------------|-------|--------|---------------|
| **Sub-agent** | Fresh (prompt only) | Agent's own | Filtered per type | Optional | No |
| **Forked agent** | Parent's full prefix (cache-shaped)* | Parent's rendered bytes | Parent's exact set | Always | Yes (all forks share prefix) |
| **Coordinator mode** | N/A (modifier) | N/A | N/A | Forces async | N/A |

*Forked agents don't just "inherit parent history" — they are **cache-shape engineered**. The parent's rendered system prompt bytes, exact tool array, thinking config, and synthetic placeholder tool results are all specifically shaped to produce byte-identical API request prefixes across all fork children, maximizing prompt cache hits. Context inheritance is a side effect of the cache engineering, not its purpose.

Key capabilities BrowserX lacks:
1. **Background/async execution** — parameter accepted, but `execute()` still `await`s
2. **Task notification pipeline** — `enqueueSyntheticUserTurn()` exists on the engine; nothing calls it
3. **Cross-agent messaging mid-flight delivery** — `send_message` tool + drain hook are wired, but blocked behind (1)
4. **Forked agent path** — no cache-optimized spawning with inherited context *(non-goal, see §3)*
5. **Agent resume** — sub-agents are ephemeral *(non-goal, see §3)*

(Items 6 from the original doc — "parent-lifecycle-linked cancellation" — has shipped on this branch.)

### 1.2.1 Claudy mechanics confirmed by deep dive (May 2026)

A second pass on `/home/irichard/dev/study/claudy/src` surfaced several details that inform what BrowserX still needs to build and what stays out of scope. The full reference lives in the audit notes; the items below are the ones that bear on this design.

**`runAgent()` is a long-lived async generator, not a function.** `src/tools/AgentTool/runAgent.ts` is ~975 lines and structures the agent lifecycle as `prepare (~400 lines) → query() loop → finally cleanup`. The generator yields messages as they arrive from `query()`, so the caller (the parent's ReAct loop) can stream sub-agent progress. BrowserX uses a callback-based `onProgress` instead (see §6.5) — this remains the right call.

**`createSubagentContext()` (`src/utils/forkedAgent.ts:345`) clones more state than BrowserX does today:**
- `readFileState` → `cloneFileStateCache()` (independent file-read cache)
- `abortController` → `createChildAbortController(parent)` (linked, parent abort cascades)
- `getAppState` → wrapped to set `shouldAvoidPermissionPrompts: true` unless interactive
- `setAppState` → no-op for async agents, shared for in-process teammates
- `toolDecisions`, `contentReplacementState` → cloned (for prompt-cache stability)
- `localDenialTracking` → fresh state per async agent (retry counter doesn't leak)
- `queryTracking` → `{ chainId, depth: parent.depth + 1 }`

BrowserX's `createChildEngine()` currently handles `depth`, `maxDepth`, abort linkage, and drain callbacks. Most of the rest is irrelevant (no UI app state, no prompt-cache stability concerns, no per-tool denial tracking). The one open question is whether sub-agents that read DOM/files need an independent read cache — punted until concrete contention shows up.

**`messageQueueManager` is a process-global priority queue, not a per-agent array.** Claudy has ~14 producers (user typing, Chrome extension, MCP servers, cron, bridge connections, task completions, SendMessage…) all enqueuing `QueuedCommand` objects with `priority: 'now' | 'next' | 'later'`. The `query()` loop drains them between turns, filtered by `agentId` so each agent only sees commands addressed to it. This is what makes background-completion notifications, cross-agent SendMessage, and external nudges all share one delivery path.

BrowserX deliberately does **not** adopt this model (single parent, max 3 sub-agents, no external producers). Notifications go through the parent session's pending-input path; SendMessage targets only running sub-agents through `SubAgentRegistry`. The fan-in model becomes worth revisiting if BrowserX ever gains independent input sources (extension popup, MCP, bridge, etc.).

**Mid-loop drain timing.** Claudy drains its queue *after each assistant message is yielded*, before the next tool round begins — not at task boundaries. For BrowserX, the equivalent is "after each turn completes, before the next turn starts." `TaskRunner.runLoop()` already has this drain hook in place; it just needs to actually call `parentEngine.enqueueSyntheticUserTurn()` from the background completion handler so the parent sees the notification at its next turn boundary.

**Cleanup is more extensive in claudy** (MCP server shutdown, frontmatter hook deregistration, prompt-cache break-detection tracking, file state cache clear, transcript subdir cleanup, todo purge, PPID=1 shell-task reaping, Perfetto trace deregister). For BrowserX, `engine.dispose()` covers the engine half; the items above don't apply because BrowserX doesn't have agent-scoped MCP servers, frontmatter hooks, transcripts, or backgrounded shell tasks. **Worth adding when corresponding features land** — they don't add value now.

**Agent identity is data-driven in claudy.** Built-in agents live in `src/tools/AgentTool/built-in/` (`generalPurposeAgent.ts`, `exploreAgent.ts`, `planAgent.ts`, etc.); user agents are discovered from `.claude/agents/` markdown frontmatter (`loadAgentsDir.ts`). Frontmatter encodes `tools`, `disallowedTools`, `permissionMode`, `mcpServers`, `hooks`, `memory`. BrowserX matches the basic shape (`SubAgentTypeConfig` + config-driven types via `subAgentTypes`); we have intentionally **not** built frontmatter-driven hooks, agent-scoped MCP servers, or agent memory because the features they coordinate with don't exist in BrowserX yet.

**SendMessage in claudy** (`src/tools/SendMessageTool/`) routes to teammates (file-based mailboxes, UDS peers, remote bridges), supports broadcast (`to: "*"`) and structured discriminated unions (shutdown negotiations, plan-approval responses). BrowserX's `send_message` targets running background sub-agents only, plain text — see §2.3. This stays narrower than claudy by design.

### 1.3 Architectural Gap: Preparation Layer (resolved)

The original design called for splitting `SubAgentRunner.run()` into `prepare/execute/cleanup` and adding a depth-aware `createChildEngine()` plus a `drainPendingMessages` hook in `TaskRunner.runLoop()`. **All of this has shipped on this branch.** The remaining gap is no longer structural — it's the unfinished detachment path in `execute()` and the missing call into `enqueueSyntheticUserTurn()` from the background completion handler.

For posterity (and for anyone porting the design to another codebase), the original mapping read:

| Claudy | BrowserX (before this branch) | Status now |
|--------|-------------------------------|------------|
| `runAgent()` prepare | `SubAgentRunner.run()` first ~100 lines | ✅ Split into `prepare()` |
| `createSubagentContext()` (~120 lines) | `createChildEngine()` (~25 lines) | ✅ Extended with depth/drain/abort linkage |
| `query()` as async generator | `engine.run()` returns Promise | ✅ `onProgress` callback added (§6.5 — generator deferred by design) |
| `query()` mid-loop drain | `TaskRunner.runLoop()` (no hook) | ✅ Drain hook in place |
| `runAgent()` finally | `engine.dispose()` | ✅ + retained run summaries in `SubAgentRegistry` |

### 1.4 Design Principles

1. **Same ReAct loop for all agents** — already achieved; do not create separate loops
2. **Sub-agent is not tab** — sub-agent is an LLM execution orchestration concern; tab is a browser tool context concern; keep them decoupled
3. **Incremental improvement** — each phase delivers standalone value
4. **No speculative abstractions** — only build what's needed now
5. **Interface decisions should be teammate-compatible** — don't build teammate infrastructure, but don't make choices that block it either

### 1.5 Implementation Status (per the `design-sub-agent` branch)

Legend: ✅ done · 🟡 partial · ❌ missing · ⛔ non-goal (see §3).

| Area | Status | Where it lives | What's missing |
|------|--------|----------------|----------------|
| Module relocation to `src/tools/AgentTool/` | ✅ | `src/tools/AgentTool/` | — |
| `IAgentRunner` + `AgentContext` + prepare/execute/cleanup split | ✅ | `SubAgentRunner.ts`, `types.ts` | — |
| `createChildEngine()` with depth/drain/parent linkage | ✅ | `RepublicAgentEngine.ts`, `RepublicAgentEngineConfig.ts` | — |
| `drainPendingMessages` hook between turns | ✅ | `RegularTask.ts` (task loop) | — |
| `onProgress` callback | ✅ | `RepublicAgentEngine.ts`, `TaskRunner` | — |
| Recursion depth enforcement (defense-in-depth) | ✅ | `SubAgentRunner.prepare()` lines ~118–121 | — |
| `sub_agent` excluded from child registries (denylist) | ✅ | `ToolRegistryCloner` | — |
| Foreground cancellation linked to parent abort | ✅ | `SubAgentRunner.prepare()` lines ~174–189 | — |
| Foreground cancellation linked to parent `EngineDisposed` | ✅ | `SubAgentRunner.prepare()` via `parentEngine.onEvent()` | — |
| Token-usage retention + `getUsageSummary()` | ✅ | `SubAgentRegistry.ts` | — |
| `background?: boolean` parameter & schema | ✅ | `types.ts`, `SubAgentTool.ts`, `register.ts` | — |
| **Detached background execution** | ❌ | `SubAgentRunner.execute()` always `await`s | Branch on `context.background`; fire-and-forget promise; return `BackgroundSubAgentResult` |
| Independent abort controller for background | ✅ | `SubAgentRunner.prepare()` | (already correct, but unused until detachment lands) |
| `approvalPolicy: 'never'` forced for background | 🟡 | `SubAgentRunner.prepare()` | Currently set; verify it can't be overridden by `'inherit'` from type config |
| Retained run summaries / tombstones for completed background runs | 🟡 | `SubAgentRegistry.ts` | Entries are retained; no TTL / lightweight tombstone shape — fine for now |
| `list_sub_agents`, `cancel_sub_agent`, `send_message` tools | ✅ | `managementTools.ts` | — |
| `enqueueSyntheticUserTurn()` on engine | ✅ | `RepublicAgentEngine.ts:291` | — |
| **`<task-notification>` formatter + completion → parent injection** | ❌ | nowhere yet | `.then(...).catch(...).finally(...)` on the detached promise; format XML; call `parentEngine.enqueueSyntheticUserTurn()` |
| `SubAgentRegistry.queueMessage()` / `drainMessages()` | ✅ | `SubAgentRegistry.ts` | — |
| `send_message` queues into registry | ✅ | `managementTools.ts` | — |
| **`drainPendingMessages` wired into child engine for `send_message`** | 🟡 | `SubAgentRunner.prepare()` passes drain callback; effective only once background detach exists | Validate end-to-end once §1.6 step 1 lands |
| Config-driven `subAgentTypes` (load + merge precedence) | ✅ | `register.ts`, validation helper | — |
| Phase 0 regression tests | 🟡 | `__tests__/SubAgentTool.test.ts`, `SubAgentRegistry.test.ts` | Add explicit drain-noop and onProgress-no-op tests |
| Phase 1 tests (depth, signal, usage) | 🟡 | scattered | Add the named tests from §4 Phase 1.4 |
| Phase 2 tests (background, notification, cancel) | ❌ | — | Land alongside §1.6 step 1 |
| Phase 3 tests (message drain cycle) | ❌ | — | Land alongside §1.6 step 1 (drain is only observable once background runs exist) |
| Phase 4 tests (config types, precedence) | 🟡 | — | Add overrides + invalid-entry warning tests |
| Forked agent path (cache-shape) | ⛔ | — | Non-goal (§3) |
| Agent resume from disk | ⛔ | — | Non-goal (§3) |
| In-process teammates | ⛔ | — | Non-goal (§3); interfaces stay teammate-compatible |
| Process-global message queue | ⛔ | — | Non-goal (§3); revisit if multiple input producers appear |
| Coordinator mode | ⛔ | — | Non-goal (§3); trivially expressible as `background: true` default |

### 1.6 Path to Move Progress

The branch sits one focused change away from being functionally claudy-aligned for sub-agents. Recommended order:

1. **Land Phase 2.2 + 2.4 together — background detachment and task-notification injection.** Until this lands, the `background` parameter, the management tools, the message queue, and the drain hook are all dead weight: foreground runs complete before any of them can observe state. See §2.1, §2.2, §6.7. Concretely:
   - In `SubAgentRunner.execute()` (or, cleaner, in `run()`): branch on `context.background`. For background, kick off `execute(context, params)` as a detached promise and immediately return a `BackgroundSubAgentResult` (`{ status: 'launched', runId }`). Do **not** await; do **not** run the existing `cleanup()` synchronously — attach `.then/.catch/.finally` to the detached promise.
   - In the `.then/.catch` handlers: format a `<task-notification>` (schema in §2.2) and call `context.parentEngine.enqueueSyntheticUserTurn(...)`. Always include `tokenUsage`, `turnCount`, `durationMs`, and `stopReason`.
   - In `.finally`: call `cleanup(context)`. Foreground keeps the synchronous `try/finally` it already has.
   - Add the `BackgroundSubAgentResult` discriminator to the `sub_agent` tool's return type so the parent LLM gets a clear `status: 'launched'` envelope rather than an opaque "result".
   - Tests: detached returns immediately; notification text reaches the parent's next turn (assert via pending-input drain, not history); failure path injects an error notification; `cancel_sub_agent` aborts the detached run and still injects a `cancelled` notification.

2. **Validate the cross-agent messaging cycle end-to-end** once step 1 lands. `send_message → SubAgentRegistry.queueMessage → drainPendingMessages → child pending input → next turn` is already wired but unobservable without a running background agent. Add one integration test that walks this path.

3. **Backfill the missing phase tests** (Phase 0.6, 1.4 explicit tests, Phase 4.4 overrides/invalid-entry). These are independent of step 1 and can land in parallel.

4. **Tighten `approvalPolicy` override for background runs.** The audit notes a 🟡 — confirm in code that a type with `approvalPolicy: 'inherit'` is forced to `'never'` when `background: true`, not silently inherited.

5. **Defer everything in §3 (non-goals).** Forked agents, agent resume, in-process teammates, the global message queue, and coordinator mode remain explicitly out of scope. Revisit only if BrowserX gains the prerequisite features (prompt cache, transcript persistence, multiple input producers, long-lived background workers).

Step 1 is the load-bearing change. Steps 2–4 are housekeeping.

---

## 2. Improvements

### 2.0 Move Sub-Agent Module to `src/tools/AgentTool/`

**Problem:** The sub-agent module lives in `src/core/subagent/` even though, from the main agent's perspective, `sub_agent` is a tool registered into `ToolRegistry` — the same as `browser_dom`, `exec_command`, etc. This creates a misleading organizational split: tools live in `src/tools/`, but the sub-agent (which is a tool) lives in `src/core/`.

Claudy places its equivalent squarely in `src/tools/AgentTool/`. This is the right pattern — the sub-agent *uses* core engine internals (`createChildEngine`), but so do other tools that reference engine types. The import direction (tool → core) is correct and doesn't justify placing the tool inside core.

**Proposed change:**

Move the entire `src/core/subagent/` directory to `src/tools/AgentTool/`:

```
src/core/subagent/                    →  src/tools/AgentTool/
├── types.ts                          →  ├── types.ts
├── builtinTypes.ts                   →  ├── builtinTypes.ts
├── SubAgentTool.ts                   →  ├── SubAgentTool.ts
├── SubAgentRegistry.ts               →  ├── SubAgentRegistry.ts
├── SubAgentRunner.ts                 →  ├── SubAgentRunner.ts
├── register.ts                       →  ├── register.ts
├── index.ts                          →  ├── index.ts
└── __tests__/                        →  └── __tests__/
    ├── SubAgentRegistry.test.ts      →      ├── SubAgentRegistry.test.ts
    └── SubAgentTool.test.ts          →      └── SubAgentTool.test.ts
```

**Import updates required (6 external files):**

| File | Old import | New import |
|------|-----------|------------|
| `src/tools/ToolRegistryCloner.ts` | `'../core/subagent/types'` | `'./AgentTool/types'` |
| `src/tools/__tests__/ToolRegistryCloner.test.ts` | `'@/core/subagent/types'` | `'@/tools/AgentTool/types'` |
| `src/core/engine/__tests__/RepublicAgentEngine.integration.test.ts` | `'../../subagent/SubAgentRunner'` etc. | `'@/tools/AgentTool/SubAgentRunner'` etc. |
| `src/server/agent/ServerAgentBootstrap.ts` | `'@/core/subagent/register'` | `'@/tools/AgentTool/register'` |
| `src/desktop/agent/DesktopAgentBootstrap.ts` | `'@/core/subagent/register'` | `'@/tools/AgentTool/register'` |
| `src/core/registry/AgentRegistry.ts` | `'../subagent/register'` | `'@/tools/AgentTool/register'` |

**Internal import updates (files within the moved module):**

| File | Old import | New import |
|------|-----------|------------|
| `SubAgentRunner.ts` | `'../engine/RepublicAgentEngine'` | `'@/core/engine/RepublicAgentEngine'` |
| `SubAgentRunner.ts` | `'../engine/RepublicAgentEngineConfig'` | `'@/core/engine/RepublicAgentEngineConfig'` |
| `SubAgentRunner.ts` | `'../events/SubAgentEventRouter'` | `'@/core/events/SubAgentEventRouter'` |
| `SubAgentRunner.ts` | `'../../tools/ToolRegistryCloner'` | `'../ToolRegistryCloner'` |
| `SubAgentRegistry.ts` | `'../engine/RepublicAgentEngine'` | `'@/core/engine/RepublicAgentEngine'` |
| `register.ts` | `'../engine/RepublicAgentEngine'` | `'@/core/engine/RepublicAgentEngine'` |
| `SubAgentTool.ts` | `'../../tools/BaseTool'` | `'../BaseTool'` |
| `__tests__/SubAgentRegistry.test.ts` | `'../../engine/RepublicAgentEngine'` | `'@/core/engine/RepublicAgentEngine'` |
| `__tests__/SubAgentTool.test.ts` | `'../../../tools/BaseTool'` | `'../../BaseTool'` |

**Why this comes first:** Every subsequent section references file paths. Moving the module first means all file references in Phase 0–4 point to the correct location. It also establishes the convention: sub-agent tools belong in `src/tools/`, alongside the other tools they sit next to in the LLM's tool list.

### 2.1 Background Execution (Async Sub-Agents)

**Problem:** Currently `SubAgentRunner.run()` is purely `await`-based. The parent agent blocks until the sub-agent completes. This prevents parallel worker patterns (e.g., research topic A while researching topic B).

**What Claudy does:** `run_in_background: true` parameter. Async agents get:
- Separate `AbortController` (unlinked from parent)
- `shouldAvoidPermissionPrompts: true` (can't show UI)
- Immediate return with `agentId` — parent continues working
- Task notification enqueued on completion

**Proposed design:**

Add a `background` flag to `SubAgentToolParams`:

```typescript
interface SubAgentToolParams {
  type: string;
  prompt: string;
  description?: string;
  background?: boolean;    // NEW: run in background
  signal?: AbortSignal;
}
```

When `background: true`:
1. `SubAgentRunner` starts the child engine but does **not** await `engine.run()`
2. Returns immediately with `{ status: 'launched', runId }` to the parent LLM
3. The child engine runs in a detached promise tracked by `SubAgentRegistry`
4. On completion, a **task notification** is injected into the parent's conversation (see 2.2)

When `background: false` (default, current behavior):
- No change. Parent awaits result synchronously.

**Approval policy for background agents (BrowserX design choice):**
- Background agents use `approvalPolicy: 'never'` — they cannot prompt for approval since the parent has moved on. If a type has `approvalPolicy: 'inherit'`, override to `'never'` when running in background and log a warning.
- Note: Claudy uses a finer-grained mechanism (`shouldAvoidPermissionPrompts: true`) that suppresses the interactive prompt dialog but still allows automated approval via permission hooks and classifiers. Async agents with `permissionMode: 'bubble'` can even surface prompts to the parent terminal. BrowserX simplifies to a hard `'never'` since we lack permission hooks and classifiers. If those are added later, revisit this to allow hook-based auto-approval for background agents.

**AbortController strategy:**
- Background agents get a **new, unlinked** `AbortController`. Parent aborting does not kill background children.
- Foreground agents (current behavior): child linked to parent's signal — parent abort cancels child.

**New tool for background management:**

```typescript
// list_sub_agents: shows running/completed background agents
// cancel_sub_agent: cancels a running background agent by runId
```

These are simple tools registered alongside `sub_agent`. They query/mutate `SubAgentRegistry`.

Completed background runs cannot be removed from `SubAgentRegistry` immediately. Management tools need a short-lived retained summary record, such as an in-memory tombstone with status, duration, token usage, and optional result preview. Foreground synchronous runs can continue using immediate cleanup because the parent already receives the direct tool result.

### 2.2 Task Notification Pipeline

**Problem:** When a background sub-agent completes, there is no mechanism to inform the parent LLM of the result. The parent would need to poll.

**What Claudy does:** Claudy uses a process-global command queue (`messageQueueManager.ts`). `enqueuePendingNotification()` enqueues notifications with `priority: 'later'` into a singleton queue. The `query()` loop drains this queue between turns, filtering by `agentId` so notifications reach only the intended parent. Notifications are converted to attachment blocks in the API request. This decouples the completing agent from needing a reference to the parent — it just enqueues to the global queue and the parent's loop picks it up.

**Proposed design (BrowserX simplification):**

BrowserX uses direct parent-engine injection rather than a global queue. This is simpler and sufficient for our scope (single parent, max 3 sub-agents, no multi-parent coordination). If BrowserX later needs notification routing across multiple independent parents, a queue-based model closer to Claudy's should be considered.

Add a notification delivery mechanism to `RepublicAgentEngine` that queues synthetic user input for the parent's next turn. Appending text via `AddToHistory` is not sufficient because it only mutates history; it does not cause the parent task loop to consume the notification.

```typescript
// In RepublicAgentEngine
enqueueSyntheticUserTurn(notificationText: string): void {
  // Queue a synthetic user message into the same pending-input path
  // consumed by TaskRunner at turn boundaries or on the next run.
  this.session?.addPendingInput([
    { type: 'text', text: notificationText }
  ]);

  // Emit a lightweight engine event so UI/consumers know a notification arrived.
  this.pushEvent({
    id: crypto.randomUUID(),
    msg: { type: 'SubAgentNotificationQueued' }
  });
}
```

```typescript
interface TaskNotification {
  runId: string;
  type: string;           // sub-agent type
  description: string;
  status: 'completed' | 'failed' | 'cancelled';
  result?: string;        // final response text
  tokenUsage?: { input: number; output: number; total: number };
  turnCount: number;
  durationMs: number;
  error?: string;
}
```

**Notification format** (injected as text into parent's conversation):

```xml
<task-notification>
  <run-id>abc-123</run-id>
  <type>researcher</type>
  <status>completed</status>
  <summary>Researcher "API endpoint analysis" completed</summary>
  <result>Found 3 REST endpoints in src/server/...</result>
  <usage>
    <total_tokens>8500</total_tokens>
    <turn_count>6</turn_count>
    <duration_ms>12000</duration_ms>
  </usage>
</task-notification>
```

**When notifications are delivered:**
- After a background sub-agent completes/fails/is cancelled
- `SubAgentRunner` holds a reference to the parent engine and calls `parentEngine.enqueueSyntheticUserTurn(...)`
- If the parent engine is currently in a turn, the notification sits in pending input and is consumed at the next drain point or next user-triggered turn
- If BrowserX later needs multi-parent or cross-process routing, replace this with a queue closer to Claudy's `messageQueueManager`

### 2.3 Cross-Agent Messaging

**Problem:** Once a sub-agent is spawned, there is no way to send follow-up instructions. The parent cannot steer a running background agent.

**What Claudy does:** Claudy has two separate messaging paths. Background local agents use a per-task `pendingMessages` array drained at tool-round boundaries via the attachment pipeline. In-process teammates use a separate `pendingUserMessages` queue drained by a 500ms polling idle loop in `inProcessRunner.ts`. BrowserX has no in-process teammates, so we adopt the local agent pattern (drain at tool-round boundaries).

**Proposed design:**

Add a `send_message` tool:

```typescript
interface SendMessageParams {
  to: string;         // runId of target sub-agent
  message: string;    // follow-up instruction
}
```

**Implementation:**
1. `SubAgentRegistry` gains a `pendingMessages: Map<string, string[]>` per running retained agent
2. `send_message` tool validates the agent exists and is running, then appends to its pending queue
3. The child engine's task loop checks for pending messages after each turn (between tool rounds)
4. Pending messages are queued into the child's pending-input path as synthetic user input before the next turn starts

This requires a hook point in `TaskRunner.runLoop()`:

```typescript
// In TaskRunner.runLoop(), after each turn:
const pendingMessages = this.getPendingMessages?.();
if (pendingMessages?.length) {
  session.addPendingInput([
    { type: 'text', text: pendingMessages.join('\n') }
  ]);
}
```

**Scope limitation:** No broadcast (`*`), no structured messages, no agent resume in this phase. Keep it simple: send a text message to a running background agent by ID.

### 2.4 Cancellation Chain & Parent-Lifecycle Propagation

**Problem:** `SubAgentToolParams` already passes `signal` through to `engine.run()`, and `TaskRunner` already honors `AbortSignal`. The missing piece is explicit lifecycle linkage: foreground children should stop when the parent engine/session is torn down, while background children should intentionally outlive the parent turn.

**Proposed design:**

Preserve the existing signal path and add parent-lifecycle linkage on top.

For **foreground** sub-agents: create a child `AbortController` linked to both the caller's `params.signal` and parent-engine disposal/interruption:

```typescript
const childController = new AbortController();

// Link to caller's signal
if (params.signal) {
  params.signal.addEventListener('abort', () => childController.abort(), { once: true });
}

// Link to parent engine disposal / shutdown via existing event listener
const unlinkParent = parentEngine.onEvent((event) => {
  if (event.msg.type === 'EngineDisposed') {
    childController.abort();
  }
});
```

For **background** sub-agents: create an independent `AbortController` (not linked to parent). Only cancelled explicitly via `cancel_sub_agent` tool.

### 2.5 Token Usage Aggregation

**Problem:** Per-run token usage is already aggregated by `TaskRunner` and returned by `engine.run()`, and `SubAgentRunner` already exposes that in `SubAgentResult`. What is missing is retained accounting across multiple sub-agent runs so the parent can inspect or report on aggregate sub-agent cost after the fact.

**Proposed design:**

Track aggregate usage in `SubAgentRegistry`:

```typescript
interface SubAgentUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  byAgent: Array<{
    runId: string;
    type: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

// In SubAgentRegistry
getUsageSummary(): SubAgentUsageSummary
```

`SubAgentRunner` updates the registry with token usage when each sub-agent completes. The parent engine or management tools can query aggregate usage for reporting.

Include sub-agent token usage in the task notification (2.2) so the parent LLM is aware of cost.

### 2.6 Structural Refactoring: Agent Execution Pipeline

**Problem:** `SubAgentRunner.run()` currently handles type resolution, registry management, engine creation, execution, event emission, result formatting, and cleanup in a single method. Every improvement in 2.1–2.7 adds more responsibility to this method. Without restructuring, it will grow into an unmaintainable monolith — and the same structure would need to be duplicated if teammates are added later.

**What Claudy does:** `runAgent()` is a dedicated async generator that handles all agent-specific preparation and cleanup, delegating execution to `query()`. This separation means `query()` stays generic (it doesn't know about agent types, transcripts, or permissions) while `runAgent()` handles all agent-specific orchestration.

**Proposed design:**

#### 2.6.1 `IAgentRunner` Interface

Define a common interface for agent execution strategies. Sub-agents implement it now; teammates could implement it later without changing the rest of the system.

```typescript
interface IAgentRunner {
  prepare(params: AgentRunParams): Promise<AgentContext>;
  execute(context: AgentContext): Promise<AgentRunResult>;
  cleanup(context: AgentContext): Promise<void>;
}

interface AgentContext {
  runId: string;
  engine: RepublicAgentEngine;
  abortController: AbortController;
  registry: SubAgentRegistry;
  typeConfig: SubAgentTypeConfig;
  parentEngine: RepublicAgentEngine;
  background: boolean;
  // Extensible: add transcript writer, MCP servers, etc. as needed
}

interface AgentRunResult {
  success: boolean;
  response: string;
  turnCount: number;
  tokenUsage?: { input: number; output: number; total: number };
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled' | 'interrupted';
  error?: string;
}
```

`SubAgentRunner` refactors from one `run()` method to three:

```typescript
class SubAgentRunner implements IAgentRunner {
  async prepare(params): Promise<AgentContext> {
    // 1. Resolve type config
    // 2. Create restricted tool registry
    // 3. Create event router
    // 4. Resolve approval policy + abort controller
    // 5. Create child engine
    // 6. Register with SubAgentRegistry
    // 7. Return AgentContext
  }

  async execute(context): Promise<AgentRunResult> {
    // 1. Initialize engine
    // 2. Run engine (await or detach based on context.background)
    // 3. Emit events
    // 4. Format result
  }

  async cleanup(context): Promise<void> {
    // 1. Dispose engine
    // 2. Unregister from registry
    // 3. Release resources
  }
}
```

The public entry point becomes:

```typescript
async run(params: SubAgentToolParams): Promise<SubAgentResult> {
  const context = await this.prepare(params);
  try {
    return await this.execute(context);
  } finally {
    await this.cleanup(context);
  }
}
```

This is a **refactor, not a rewrite** — the same logic, split into clear stages.

#### 2.6.2 Deeper Context Isolation in `createChildEngine()`

Current `createChildEngine()` (~25 lines) only creates a new engine with different config. It does not isolate mutable state. Extend it to handle:

```typescript
createChildEngine(config: ChildEngineConfig): RepublicAgentEngine {
  return new RepublicAgentEngine({
    ...config,
    // Existing
    parentEngineId: this.engineId,
    persistent: false,

    // NEW: abort strategy (2.4)
    // Caller decides: linked (foreground) or independent (background)
    abortController: config.abortController,

    // NEW: message drain callback (2.3)
    // Allows TaskRunner to check for pending messages between turns
    drainPendingMessages: config.drainPendingMessages,
  });
}
```

#### 2.6.3 Message Drain Hook in `TaskRunner.runLoop()`

Add a generic drain point between turns. This serves cross-agent messaging (2.3) now and would serve teammate message injection later, without TaskRunner knowing about either concept:

```typescript
// In TaskRunner.runLoop(), after each turn completes:
if (this.drainPendingMessages) {
  const pending = this.drainPendingMessages();
  if (pending?.length) {
    // Inject as synthetic user input via the pending-input path.
    // This is consumed by session.getPendingInput() at the top of the next
    // loop iteration, matching how the task loop already accepts new user text.
    // Using addToHistory() would be insufficient — it mutates history but does
    // not cause the task loop to consume the message (see rationale in 2.2).
    session.addPendingInput(
      pending.map(msg => ({ type: 'text' as const, text: msg }))
    );
  }
}
```

The `drainPendingMessages` callback is injected via engine config — TaskRunner doesn't import SubAgentRegistry or know where messages come from. This keeps the coupling one-directional.

#### 2.6.4 Progress Yielding (Future-Compatible)

Current `engine.run()` returns `Promise<EngineResult>` — the caller gets nothing until completion. This blocks progress tracking and transcript recording.

**Immediate change:** Add an `onProgress` callback to `RunOptions`:

```typescript
interface RunOptions {
  maxTurns?: number;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;  // NEW
}

type AgentProgressEvent =
  | { type: 'turn_complete'; turnNumber: number; tokenUsage: TokenUsage }
  | { type: 'tool_called'; toolName: string; turnNumber: number }
  | { type: 'message'; text: string };
```

This is less invasive than converting `engine.run()` to an async generator (which would change every caller), but provides the hook needed for:
- Sub-agent progress tracking in `SubAgentRegistry` (now)
- Transcript recording (now)
- Teammate message accumulation across turns (later, if needed)

**Why not an async generator now:** Converting `engine.run()` to yield messages would require changing `Session.spawnTask()`, `TaskRunner`, and every consumer of `engine.run()`. The callback approach is additive — existing callers don't change.

#### 2.6.5 Teammate Compatibility Notes

These refactoring choices are designed so that a hypothetical teammate implementation would:
- Implement `IAgentRunner` with an idle→work→idle loop in `execute()`
- Use the same `drainPendingMessages` hook for receiving messages
- Use the same `AgentContext` with additional fields (identity, team name)
- Use the same `SubAgentRegistry` (or a shared `AgentRegistry`) for tracking

None of this is built now. The point is that these interfaces don't need to change when teammates are added — only new implementations of existing interfaces.

### 2.7 Custom Agent Type Definitions from Config

**Problem:** Built-in types are hardcoded. Users can only extend via programmatic `customTypes` in `registerSubAgentTool()`.

**What Claudy does:** Loads custom agent YAML from user/project settings directories, validates with Zod schema.

**Proposed design:**

Add a `subAgentTypes` section to the agent config (loaded from `config.json`):

```json
{
  "subAgentTypes": [
    {
      "id": "data-analyst",
      "name": "Data Analyst",
      "description": "Analyzes structured data and generates insights",
      "systemPrompt": "You are a data analysis assistant...",
      "tools": { "allow": ["web_scraping_tool", "data_extraction_tool"] },
      "maxTurns": 20,
      "approvalPolicy": "never"
    }
  ]
}
```

`registerSubAgentTool()` merges:
1. Built-in types (researcher, planner, worker)
2. Config-defined types (from `config.json`)
3. Programmatic types (from `customTypes` parameter)

Config-defined types can override built-in types by matching `id`. Programmatic types override both.

---

## 3. Non-Goals

These are explicitly **out of scope** for this improvement phase:

| Non-Goal | Reason |
|----------|--------|
| Forked agent (cache-shape engineered spawning) | Claudy's fork path is cache-shape engineering: it threads the parent's rendered system prompt bytes, exact tool array, thinking config, and synthetic placeholder tool results to produce byte-identical API request prefixes across all fork children, maximizing prompt cache hits. This requires prompt cache infrastructure that doesn't exist in BrowserX. The optimization is less relevant for browser automation (shorter conversations, fewer parallel research tasks than CLI coding). Revisit when usage patterns justify it. |
| Tab-per-agent isolation | Tab management is a browser tool concern, not a sub-agent concern. A sub-agent may or may not use a browser tab depending on its tools. Don't couple these concepts. If a sub-agent needs a specific tab, it should use existing tab management tools. |
| Agent resume from disk | Claudy supports full agent lifecycle: eviction to disk, transcript sidechain persistence (`subagents/<agentId>.jsonl`), auto-resume from `SendMessage` (reconstructs replacement state, restores worktree metadata, continues in background), and re-warm of evicted agents. This requires transcript persistence, sidechain storage, and session reconstruction — significant infrastructure. BrowserX sub-agent tasks are typically short-lived browser automation steps where resume provides marginal value. Revisit if long-running background agents become a usage pattern. |
| Coordinator mode | A modifier that forces async on all spawns. Useful for CLI orchestration with many parallel workers. Browser automation patterns are more sequential. Can be added trivially later (just set `background: true` by default). |
| In-process teammates | Claudy's teammate system (`src/utils/swarm/`) provides persistent, long-lived agents that run a continuous idle→work→idle loop in the same Node.js process, isolated via `AsyncLocalStorage`. They communicate via a file-based mailbox system (`~/.claude/teams/{team}/inboxes/{name}.json`) polled every 500ms, and support team coordination patterns (leader/teammate roles, permission delegation, shutdown negotiation). This solves synchronous team coordination for CLI coding workflows where multiple agents need ongoing collaboration with accumulated context. Browser automation patterns are more sequential and task-oriented — sub-agents are sufficient. However, the refactoring in 2.6 (`IAgentRunner` interface, `drainPendingMessages` hook, `AgentContext`) is explicitly designed so teammates could be added as a new `IAgentRunner` implementation without changing existing infrastructure. |
| Global message queue | Claudy's `messageQueueManager.ts` is a process-global singleton array that serves as a universal input bus — 14 different producers (user typing, Chrome extension, MCP servers, cron jobs, bridge connections, task completions) all push into it, and the `query()` loop drains it between turns with priority ordering (`'now'` > `'next'` > `'later'`) and agent-scoped filtering. BrowserX has a single parent and max 3 sub-agents, so direct delivery into the parent session's pending-input path is sufficient. A global queue should be considered if BrowserX adds multiple external input sources that need fan-in coordination. |

---

## 4. Phase Plan

Legend: ✅ shipped on `design-sub-agent` · 🟡 partial · ❌ not started.

### Phase 0: Structural Refactoring (prerequisite, no new features) — ✅ complete

| Task | Status | Description | Files |
|------|--------|-------------|-------|
| 0.1 | ✅ | Move `src/core/subagent/` to `src/tools/AgentTool/`, update all imports (2.0) | All files listed in 2.0 |
| 0.2 | ✅ | Define `IAgentRunner` interface and `AgentContext` type (2.6.1) | `src/tools/AgentTool/types.ts` |
| 0.3 | ✅ | Refactor `SubAgentRunner.run()` into `prepare()` / `execute()` / `cleanup()` (2.6.1) | `src/tools/AgentTool/SubAgentRunner.ts` |
| 0.4 | ✅ | Extend `createChildEngine()` with abort and drain callback config (2.6.2) | `RepublicAgentEngine.ts`, `RepublicAgentEngineConfig.ts` |
| 0.5 | ✅ | Add `drainPendingMessages` hook point in `TaskRunner.runLoop()` (2.6.3) | `RegularTask.ts` (loop) |
| 0.6 | ✅ | Add `onProgress` callback to `RunOptions` and wire through TaskRunner (2.6.4) | `RepublicAgentEngine.ts`, `TaskRunner.ts`, types |
| 0.7 | 🟡 | Tests: verify refactored pipeline produces identical behavior to current implementation | `__tests__/` (add explicit drain-noop / onProgress-noop tests) |

**Deliverable:** Same behavior, cleaner structure, correct module location. ✅ Achieved.

### Phase 1: Safety & Correctness — ✅ structural; 🟡 tests

| Task | Status | Description | Files |
|------|--------|-------------|-------|
| 1.1 | ✅ | Add recursion depth metadata and enforcement in addition to keeping `sub_agent` denylist enforcement | `RepublicAgentEngineConfig.ts`, `RepublicAgentEngine.ts`, `SubAgentRunner.ts`, `ToolRegistryCloner.ts` |
| 1.2 | ✅ | Add parent-lifecycle-linked cancellation for foreground sub-agents (2.4) | `SubAgentRunner.ts`, `RepublicAgentEngine.ts` |
| 1.3 | ✅ | Add retained token usage summaries to SubAgentRegistry (2.5) | `SubAgentRegistry.ts`, `SubAgentRunner.ts`, `types.ts` |
| 1.4 | 🟡 | Tests for depth enforcement, cancellation linkage, token tracking | `__tests__/` |

**Deliverable:** Recursion blocked by both tool filtering and explicit depth checks; foreground sub-agents stop with parent teardown; sub-agent usage retained. ✅ Achieved structurally; tests pending.

### Phase 2: Background Execution — ❌ THE BLOCKING GAP

| Task | Status | Description | Files |
|------|--------|-------------|-------|
| 2.1 | ✅ | Add `background` flag to `SubAgentToolParams` and tool definition | `types.ts`, `SubAgentTool.ts` |
| 2.2 | ❌ | **Implement background execution in `SubAgentRunner` (detach vs await decision)** — see §1.6 step 1 | `SubAgentRunner.ts` |
| 2.3 | ✅ | Add retained run summaries plus `list_sub_agents` and `cancel_sub_agent` tools | `managementTools.ts`, `SubAgentRegistry.ts` |
| 2.4 | ❌ | **Implement task notification delivery via parent's pending-input path** — `enqueueSyntheticUserTurn()` exists but is never called | `SubAgentRunner.ts` (handlers on detached promise), notification formatter |
| 2.5 | ❌ | Tests for background execution, notification injection, cancellation | `__tests__/SubAgentRunner.background.test.ts`, `notification.test.ts` |

**Deliverable:** LLM can spawn background sub-agents, continue working, and receive notifications on completion. ❌ **Not yet.** 2.2 and 2.4 are the load-bearing work; 2.5 lands with them.

### Phase 3: Cross-Agent Messaging — ✅ wired, 🟡 unobservable until Phase 2 lands

| Task | Status | Description | Files |
|------|--------|-------------|-------|
| 3.1 | ✅ | Add pending message queue to `SubAgentRegistry` | `SubAgentRegistry.ts` |
| 3.2 | ✅ | Add `send_message` tool | `managementTools.ts` |
| 3.3 | ✅ | Wire `drainPendingMessages` callback from Phase 0.4 to SubAgentRegistry and queue messages into child pending input | `SubAgentRunner.ts`, `SubAgentRegistry.ts`, task loop |
| 3.4 | ❌ | Tests for message routing, drain timing, invalid targets | `__tests__/SubAgentRunner.messaging.test.ts` |

**Deliverable:** Parent can send follow-up instructions to running background sub-agents. ✅ Plumbing is in place; functional end-to-end test depends on Phase 2.

### Phase 4: Custom Types from Config — ✅ structural; 🟡 tests

| Task | Status | Description | Files |
|------|--------|-------------|-------|
| 4.1 | ✅ | Define config schema for `subAgentTypes` | `config/types.ts` |
| 4.2 | ✅ | Load and validate custom types in `registerSubAgentTool()` | `register.ts` |
| 4.3 | ✅ | Merge precedence: built-in < config < programmatic | `register.ts` |
| 4.4 | 🟡 | Tests for config loading, override precedence, validation | `__tests__/register.config.test.ts` |

**Deliverable:** Users can define custom sub-agent types in config without code changes. ✅ Achieved; tests pending.

---

## 5. Architectural Diagrams

### 5.1 Refactored Agent Execution Pipeline

```
    LLM calls sub_agent(type, prompt, background?)
                               │
                    ┌──────────▼───────────────────────┐
                    │   SubAgentRunner (IAgentRunner)   │
                    │                                   │
                    │   ┌─────────────────────────────┐ │
                    │   │ prepare()                    │ │
                    │   │  1. Resolve type config      │ │
                    │   │  2. Create restricted tools  │ │
                    │   │  3. Create event router      │ │
                    │   │  4. Resolve abort strategy   │ │
                    │   │  5. Create child engine      │ │
                    │   │  6. Register in registry     │ │
                    │   │  → return AgentContext        │ │
                    │   └──────────────┬──────────────┘ │
                    │                  │                 │
                    │   ┌──────────────▼──────────────┐ │
                    │   │ execute(context)             │ │
                    │   │  • Initialize engine         │ │
                    │   │  • Run (await or detach)     │ │
                    │   │  • Emit events               │ │
                    │   │  • Format result              │ │
                    │   └──────────────┬──────────────┘ │
                    │                  │                 │
                    │   ┌──────────────▼──────────────┐ │
                    │   │ cleanup(context)             │ │
                    │   │  • Dispose engine             │ │
                    │   │  • Unregister from registry   │ │
                    │   │  • Release resources          │ │
                    │   └─────────────────────────────┘ │
                    └───────────────────────────────────┘
```

### 5.2 Execution Modes (Foreground vs Background)

```
                    ┌──────────────────────────────────┐
                    │         Parent Agent              │
                    │  RepublicAgent → Engine → Session │
                    │  TaskRunner.runLoop() [ReAct]     │
                    └──────────┬───────────────────────┘
                               │
                    SubAgentRunner.execute(context)
                               │
              ┌────────────────┴────────────────┐
              │                                 │
     background=false                  background=true
     (foreground)                      (background)
              │                                 │
    ┌─────────▼─────────┐            ┌──────────▼──────────┐
    │  await engine.run()│            │  Detach: engine.run()│
    │  Block parent      │            │  Return immediately  │
    │  Return result     │            │  Track in registry   │
    └────────────────────┘            └──────────┬──────────┘
                                                 │
                                      On completion/failure:
                                                 │
                                      ┌──────────▼──────────┐
                                      │ parentEngine         │
                                      │  .injectNotification │
                                      │ (task-notification)  │
                                      └──────────┬──────────┘
                                                 │
                                      Parent LLM sees result
                                      on next turn
                                                 │
                                      ┌──────────▼──────────┐
                                      │ send_message(runId)  │
                                      │ (optional follow-up) │
                                      └─────────────────────┘
```

### 5.3 Message Flow Between Agents

```
    Parent LLM                          Background Sub-Agent
        │                                       │
        │  send_message(runId, "focus on auth")  │
        ├───────────────────────────────────────>│
        │                                       │
        │    SubAgentRegistry                   │
        │    pendingMessages[runId].push(msg)    │
        │                                       │
        │                          TaskRunner.runLoop()
        │                          ┌────────────┤
        │                          │ After turn: │
        │                          │ drain       │
        │                          │ pending     │
        │                          │ messages    │
        │                          └─────┬──────┘
        │                                │
        │                          Inject as user message
        │                          into conversation
        │                                │
        │                          Next turn sees it
        │                                │
        │   <task-notification>          │
        │   status: completed            │
        │<───────────────────────────────┤
        │                                │
        │  (via parentEngine             │
        │   .enqueueSyntheticUserTurn    │
        │   -> pending input)            │
        │                               done

    All agents share: TaskRunner.runLoop() → TurnManager.runTurn()
    (single ReAct loop, different configurations)
```

### 5.4 Comparison with Claudy Architecture

```
    Claudy                              BrowserX (after refactoring)
    ──────                              ────────────────────────────

    AgentTool.call()                    sub_agent tool handler
        │                                   │
    runAgent() [async generator]        SubAgentRunner.prepare()
    ├─ resolve agent identity           ├─ resolve type config
    ├─ build system prompt              ├─ create restricted tools
    ├─ set up permissions               ├─ create event router
    ├─ resolve tools                    ├─ resolve abort strategy
    ├─ create abort controller          ├─ create child engine
    ├─ load MCP servers/skills          └─ register in registry
    ├─ createSubagentContext()
    │   └─ clone file state                 │
    │   └─ wrap AppState access         SubAgentRunner.execute()
    │   └─ null UI callbacks            ├─ initialize engine
    │   └─ scope permissions            ├─ engine.run() [await or detach]
    │                                   └─ format result
    ├─ query() [ReAct loop]                 │
    │   ├─ callModel()                  engine.run()
    │   ├─ execute tools                └─ Session.spawnTask()
    │   ├─ drain messageQueueManager        └─ TaskRunner.runLoop() [ReAct]
    │   │   └─ pending notifications            ├─ TurnManager.runTurn()
    │   │   └─ cross-agent messages             │   ├─ modelClient.stream()
    │   └─ yield messages                       │   ├─ execute tools
    │                                           ├─ drainPendingMessages()
    ├─ recordSidechainTranscript()              └─ onProgress() callback
    │                                       │
    └─ finally: cleanup                 SubAgentRunner.cleanup()
        ├─ MCP servers                  ├─ engine.dispose()
        ├─ session hooks                └─ unregister from registry
        ├─ file state cache
        ├─ Perfetto traces
        └─ shell tasks
```

---

## 6. Key Design Decisions

### 6.1 Why no forked agent?

Claudy's fork path is **cache-shape engineering**, not just "inherit parent context." It threads the parent's rendered system prompt bytes, exact tool array, thinking config, and synthetic placeholder tool results to produce byte-identical API request prefixes. All fork children share a single prompt cache entry, dramatically cutting API costs for parallel spawns. The context inheritance is a side effect — the purpose is cache optimization.

BrowserX's usage patterns don't justify this complexity:
- Browser automation conversations are typically shorter (fewer turns, less history to cache)
- Parallel research across multiple tabs is less common than sequential navigation
- BrowserX doesn't have prompt caching infrastructure at the engine level
- The engineering cost of maintaining byte-identical prefixes across tool serialization, system prompt rendering, and thinking config is high

The sub-agent path (fresh context + self-contained prompt) is sufficient. If prompt cache optimization becomes necessary, it can be added as a separate concern at the `ModelClient` layer without changing the sub-agent architecture.

### 6.2 Why not couple tab with sub-agent?

A sub-agent is an **LLM execution orchestration** concept: spawn a child with restricted tools, custom prompt, and isolated session.

A browser tab is a **tool context** concept: which tab does `browser_dom` operate on?

These are orthogonal:
- A `researcher` sub-agent analyzing code structure needs no tab at all
- A `worker` sub-agent filling a form needs a tab, but that's the `browser_dom` tool's concern, not the sub-agent system's
- Multiple sub-agents could share the same tab (reading the same page)

If a sub-agent needs a specific tab, it should use the existing tab management tools (`browser_navigate`, etc.) as part of its task execution. The sub-agent system should not pre-allocate or manage tabs.

### 6.3 Why background before messaging?

Background execution (Phase 2) is a prerequisite for cross-agent messaging (Phase 3). Without background agents, there's nothing to send messages to — foreground agents block the parent and complete before any message could be sent.

### 6.4 Why refactor before adding features?

Every improvement in section 2 (background execution, notifications, messaging) adds code to `SubAgentRunner.run()`. Without restructuring:
- Background execution adds a foreground/background branch with different abort strategies, detached promise tracking, and notification callbacks (~80 lines)
- Cross-agent messaging adds a `drainPendingMessages` callback wired through engine config to TaskRunner (~40 lines)
- Signal propagation adds linked/unlinked abort controller creation (~30 lines)

That's ~150 lines of new logic in a method that's already ~200 lines. The result would be a single 350-line method handling type resolution, tool filtering, event routing, abort strategies, engine creation, registry management, foreground/background branching, notification injection, progress tracking, cleanup, and error handling.

Splitting into `prepare()` / `execute()` / `cleanup()` costs ~30 minutes of refactoring and makes every subsequent phase land cleanly in a clear location. It also means `IAgentRunner` is available as an interface if teammates are ever needed — no second refactoring required.

### 6.5 Why `onProgress` callback instead of async generator for `engine.run()`?

Converting `engine.run()` from `Promise<EngineResult>` to `AsyncGenerator<ProgressEvent, EngineResult>` would be the cleanest design (matching Claudy's `runAgent()` generator pattern), but it requires changing:
- `Session.spawnTask()` — currently fire-and-forget
- `TaskRunner` — currently drives the loop internally
- Every consumer of `engine.run()` — `SubAgentRunner`, `ServerAgentBootstrap`, `DesktopAgentBootstrap`

The `onProgress` callback achieves the same observability (sub-agent progress tracking, transcript recording hooks) without changing the control flow. It's additive — existing callers that don't pass `onProgress` work unchanged. If the generator pattern becomes necessary (e.g., for streaming sub-agent responses to UI), it can be added later as a wrapper around the callback mechanism.

### 6.6 Why no teammates now but teammate-compatible interfaces?

Claudy's teammate system (`src/utils/swarm/`) solves **synchronous team coordination** — persistent agents that run a continuous idle→work→idle loop, communicate via file-based mailboxes, and support leader/teammate roles with permission delegation. This is a substantial system (~2000 lines across `inProcessRunner.ts`, `spawnInProcess.ts`, `teammateContext.ts`, `teammateMailbox.ts`, `permissionSync.ts`, `teamHelpers.ts`).

BrowserX's browser automation patterns don't need this — sub-agent tasks are short-lived and sequential. But building `IAgentRunner` with `prepare/execute/cleanup` and a generic `drainPendingMessages` hook costs nothing extra and means a teammate implementation would be a new class implementing the same interface, not a fork of the sub-agent code.

The rule: **make interface decisions that don't block teammates, but only build implementations for sub-agents.**

### 6.7 Notification delivery via pending input

Using the parent's existing pending-input path is the minimal design that still actually delivers the notification into the next parent turn. Appending history via `AddToHistory` would make the transcript look correct, but it would not guarantee the parent task loop consumes the notification. Queueing synthetic user input keeps the change local to the engine/session boundary and matches how the task loop already accepts new user text.

This is a deliberate simplification over Claudy's approach (process-global command queue with agentId-scoped drainage and priority ordering). Direct delivery into the parent session's pending-input path is sufficient when there is a single parent engine with a small number of sub-agents (max 3). If BrowserX later supports multiple independent parent agents or needs notification priority ordering, a queue-based delivery model should be considered.
