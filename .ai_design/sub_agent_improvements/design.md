# Sub-Agent System Improvements

## 1. Context

### 1.1 Current State (PR #191, `design-sub-agent` branch)

The sub-agent system extracts a reusable `RepublicAgentEngine` from `RepublicAgent` and builds a sub-agent module on top of it:

| Component | File | Purpose |
|-----------|------|---------|
| `SubAgentRunner` | `src/core/subagent/SubAgentRunner.ts` | Orchestrates sub-agent lifecycle: create child engine, run, capture result |
| `SubAgentRegistry` | `src/core/subagent/SubAgentRegistry.ts` | Tracks active sub-agents, enforces concurrency (default max 3) |
| `SubAgentTool` | `src/core/subagent/SubAgentTool.ts` | Builds the `sub_agent` tool definition for the LLM |
| `SubAgentEventRouter` | `src/core/events/SubAgentEventRouter.ts` | Namespaces and filters sub-agent events |
| `RepublicAgentEngine` | `src/core/engine/RepublicAgentEngine.ts` | Reusable engine with SQ/EQ, dual-mode (interactive + awaitable) |
| Built-in types | `src/core/subagent/builtinTypes.ts` | researcher (read-only), planner (analysis), worker (full execution) |

**Execution flow:**
```
LLM calls sub_agent(type, prompt)
  -> SubAgentRunner.run()
    -> parentEngine.createChildEngine(restricted tools, custom prompt)
      -> engine.initialize() -> creates Session
        -> engine.run() -> Session.spawnTask() -> TaskRunner.runLoop()
          -> TurnManager.runTurn() [the ReAct loop, same as main agent]
    -> await result
  -> return SubAgentResult as tool output to parent LLM
```

The sub-agent shares the same ReAct loop as the main agent (`TaskRunner.runLoop()` -> `TurnManager.runTurn()`). This is correct and matches the reference architecture.

### 1.2 Reference Architecture (Claudy)

Claudy has three distinct agent concepts built on a single shared ReAct loop (`query()` generator):

| Concept | Context | System Prompt | Tools | Async? | Cache Sharing |
|---------|---------|---------------|-------|--------|---------------|
| **Sub-agent** | Fresh (prompt only) | Agent's own | Filtered per type | Optional | No |
| **Forked agent** | Parent's full prefix (cache-shaped)* | Parent's rendered bytes | Parent's exact set | Always | Yes (all forks share prefix) |
| **Coordinator mode** | N/A (modifier) | N/A | N/A | Forces async | N/A |

*Forked agents don't just "inherit parent history" — they are **cache-shape engineered**. The parent's rendered system prompt bytes, exact tool array, thinking config, and synthetic placeholder tool results are all specifically shaped to produce byte-identical API request prefixes across all fork children, maximizing prompt cache hits. Context inheritance is a side effect of the cache engineering, not its purpose.

Key capabilities BrowserX lacks:
1. **Background/async execution** - parent blocks until sub-agent completes
2. **Cross-agent messaging** (`SendMessage`) - no follow-up instructions to running agents
3. **Task notification pipeline** - no mechanism to inject results into parent's conversation
4. **Forked agent path** - no cache-optimized spawning with inherited context
5. **Agent resume** - sub-agents are ephemeral, cannot be resumed
6. **Recursion depth enforcement** - worker type allows nesting but no depth limit
7. **Signal propagation** - AbortSignal accepted but not properly wired

### 1.3 Design Principles

1. **Same ReAct loop for all agents** - already achieved; do not create separate loops
2. **Sub-agent is not tab** - sub-agent is an LLM execution orchestration concern; tab is a browser tool context concern; keep them decoupled
3. **Incremental improvement** - each phase delivers standalone value
4. **No speculative abstractions** - only build what's needed now

---

## 2. Improvements

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

### 2.2 Task Notification Pipeline

**Problem:** When a background sub-agent completes, there is no mechanism to inform the parent LLM of the result. The parent would need to poll.

**What Claudy does:** Claudy uses a process-global command queue (`messageQueueManager.ts`). `enqueuePendingNotification()` enqueues notifications with `priority: 'later'` into a singleton queue. The `query()` loop drains this queue between turns, filtering by `agentId` so notifications reach only the intended parent. Notifications are converted to attachment blocks in the API request. This decouples the completing agent from needing a reference to the parent — it just enqueues to the global queue and the parent's loop picks it up.

**Proposed design (BrowserX simplification):**

BrowserX uses direct parent-engine injection rather than a global queue. This is simpler and sufficient for our scope (single parent, max 3 sub-agents, no multi-parent coordination). If BrowserX later needs notification routing across multiple independent parents, a queue-based model closer to Claudy's should be considered.

Add a notification injection mechanism to `RepublicAgentEngine`:

```typescript
// In RepublicAgentEngine
injectNotification(notification: TaskNotification): void {
  // Create a synthetic user message containing the notification
  // Submit as a 'UserTurn' operation to the SQ
  this.submitOperation({
    type: 'AddToHistory',
    text: formatNotification(notification),
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

**When notifications are injected:**
- After a background sub-agent completes/fails/is cancelled
- `SubAgentRunner` holds a reference to the parent engine and calls `parentEngine.injectNotification()`
- If the parent engine is currently in a turn (processing an LLM response), the notification is queued and delivered after the current turn completes

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
1. `SubAgentRegistry` gains a `pendingMessages: Map<string, string[]>` per agent
2. `send_message` tool validates the agent exists and is running, then appends to its pending queue
3. The child engine's turn loop checks for pending messages after each turn (between tool rounds)
4. Pending messages are injected as user messages into the child's conversation

This requires a hook point in `TaskRunner.runLoop()`:

```typescript
// In TaskRunner.runLoop(), after each turn:
const pendingMessages = this.getPendingMessages?.();
if (pendingMessages?.length) {
  // Inject as user message, continue loop
  session.addUserMessage(pendingMessages.join('\n'));
}
```

**Scope limitation:** No broadcast (`*`), no structured messages, no agent resume in this phase. Keep it simple: send a text message to a running background agent by ID.

### 2.4 Recursion Depth Enforcement (BrowserX-specific)

**Problem:** The `worker` built-in type only denies `sub_agent` in its tool list. But if a custom type allows it (or if the deny is accidentally removed), unbounded recursion is possible. The `_subAgent.depth` metadata exists in events but is not enforced.

**Note:** This is a BrowserX-original safety measure, not adopted from Claudy. Claudy prevents recursion through tool deny lists (`AgentTool` is removed from sub-agent tool pools via `ALL_AGENT_DISALLOWED_TOOLS`) and fork-specific guards (`isInForkChild`). It tracks `queryTracking.depth` but only for telemetry, not enforcement. BrowserX adds an explicit depth cap as defense-in-depth alongside tool deny lists.

**Proposed design:**

Add a `maxDepth` parameter to engine config:

```typescript
// In RepublicAgentEngineConfig
parentEngineId?: string;
depth?: number;           // NEW: current nesting depth (0 for main agent)
maxDepth?: number;        // NEW: maximum allowed depth (default: 3)
```

Enforcement in `SubAgentRunner.run()`:

```typescript
const currentDepth = this.parentEngine.getDepth();
const maxDepth = this.parentEngine.getMaxDepth();
if (currentDepth >= maxDepth) {
  return {
    success: false,
    response: `Sub-agent nesting depth limit (${maxDepth}) reached`,
    stopReason: 'error',
    // ...
  };
}
```

When creating a child engine via `createChildEngine()`, increment depth:

```typescript
createChildEngine(config) {
  return new RepublicAgentEngine({
    ...config,
    depth: this.depth + 1,
    maxDepth: this.maxDepth,
    parentEngineId: this.engineId,
  });
}
```

This makes the `sub_agent` tool deny in `worker` optional — depth is enforced structurally regardless of tool configuration.

### 2.5 Cancellation Chain & Signal Propagation

**Problem:** `SubAgentToolParams` accepts `signal` but it's not properly wired through the execution chain. Parent aborting doesn't reliably cancel foreground sub-agents.

**Proposed design:**

Wire the signal through the full chain:

```
SubAgentRunner.run(params)
  -> params.signal passed to engine.run(input, { signal: params.signal })
    -> engine passes signal to Session.spawnTask()
      -> TaskRunner uses signal in runLoop() abort check
```

For **foreground** sub-agents: create a child `AbortController` linked to both the parent's signal AND the params signal:

```typescript
const childController = new AbortController();

// Link to parent engine's abort
const parentUnsub = parentEngine.onDispose(() => childController.abort());

// Link to caller's signal
if (params.signal) {
  params.signal.addEventListener('abort', () => childController.abort());
}
```

For **background** sub-agents: create an independent `AbortController` (not linked to parent). Only cancelled explicitly via `cancel_sub_agent` tool.

### 2.6 Token Usage Aggregation

**Problem:** Each engine reports token usage independently. The parent has no visibility into total cost including sub-agents.

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

`SubAgentRunner` updates the registry with token usage when each sub-agent completes. The parent engine can query aggregate usage for reporting.

Include sub-agent token usage in the task notification (2.2) so the parent LLM is aware of cost.

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

---

## 4. Phase Plan

### Phase 1: Safety & Correctness (no new features)

| Task | Description | Files |
|------|-------------|-------|
| 1.1 | Add recursion depth enforcement (2.4) | `RepublicAgentEngine.ts`, `RepublicAgentEngineConfig.ts`, `SubAgentRunner.ts` |
| 1.2 | Wire signal propagation (2.5) | `SubAgentRunner.ts`, `RepublicAgentEngine.ts` |
| 1.3 | Add token usage aggregation to SubAgentRegistry (2.6) | `SubAgentRegistry.ts`, `SubAgentRunner.ts`, `types.ts` |
| 1.4 | Tests for recursion depth, signal cancellation, token tracking | `__tests__/` |

**Deliverable:** Sub-agents are safe from infinite recursion, properly cancellable, and report aggregate token usage.

### Phase 2: Background Execution

| Task | Description | Files |
|------|-------------|-------|
| 2.1 | Add `background` flag to `SubAgentToolParams` and tool definition | `types.ts`, `SubAgentTool.ts` |
| 2.2 | Implement background execution in `SubAgentRunner` (detached promise, separate AbortController) | `SubAgentRunner.ts` |
| 2.3 | Add `list_sub_agents` and `cancel_sub_agent` tools | `register.ts` or new file |
| 2.4 | Implement task notification pipeline (2.2) | `RepublicAgentEngine.ts`, `SubAgentRunner.ts` |
| 2.5 | Tests for background execution, notification injection, cancellation | `__tests__/` |

**Deliverable:** LLM can spawn background sub-agents, continue working, and receive notifications on completion.

### Phase 3: Cross-Agent Messaging

| Task | Description | Files |
|------|-------------|-------|
| 3.1 | Add pending message queue to `SubAgentRegistry` | `SubAgentRegistry.ts` |
| 3.2 | Add `send_message` tool | `register.ts` or new file |
| 3.3 | Add message drain hook to `TaskRunner.runLoop()` | `TaskRunner.ts`, `SubAgentRunner.ts` |
| 3.4 | Tests for message routing, drain timing, invalid targets | `__tests__/` |

**Deliverable:** Parent can send follow-up instructions to running background sub-agents.

### Phase 4: Custom Types from Config

| Task | Description | Files |
|------|-------------|-------|
| 4.1 | Define config schema for `subAgentTypes` | `config/types.ts` |
| 4.2 | Load and validate custom types in `registerSubAgentTool()` | `register.ts` |
| 4.3 | Merge precedence: built-in < config < programmatic | `register.ts` |
| 4.4 | Tests for config loading, override precedence, validation | `__tests__/` |

**Deliverable:** Users can define custom sub-agent types in config without code changes.

---

## 5. Architectural Diagram

```
                    ┌──────────────────────────────────┐
                    │         Parent Agent              │
                    │  RepublicAgent → Engine → Session │
                    │  TaskRunner.runLoop() [ReAct]     │
                    └──────────┬───────────────────────┘
                               │
                    LLM calls sub_agent(type, prompt, background?)
                               │
                    ┌──────────▼───────────────────────┐
                    │       SubAgentRunner.run()        │
                    │  1. Resolve type config           │
                    │  2. Check depth limit             │
                    │  3. Create restricted tool registry│
                    │  4. Create event router           │
                    │  5. Create child engine           │
                    └──────────┬───────────────────────┘
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

    All agents share: TaskRunner.runLoop() → TurnManager.runTurn()
    (single ReAct loop, different configurations)
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

### 6.4 Notification injection via AddToHistory

Using the existing `AddToHistory` operation in `RepublicAgentEngine` to inject notifications keeps the change minimal. The notification becomes part of the conversation history, so the LLM sees it naturally on its next turn. No new event types or special handling needed in the Session/TurnManager layer.

This is a deliberate simplification over Claudy's approach (process-global command queue with agentId-scoped drainage and priority ordering). Direct injection is sufficient when there is a single parent engine with a small number of sub-agents (max 3). If BrowserX later supports multiple independent parent agents or needs notification priority ordering, a queue-based delivery model should be considered.
