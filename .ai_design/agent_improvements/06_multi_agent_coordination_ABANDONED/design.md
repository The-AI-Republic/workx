# Track 06: Multi-Agent Coordination ❌ ABANDONED (2026-05-14)

> **Status: Abandoned.** Track 04 (Typed Task Families, PR #205) already shipped the coordinator/worker primitives this track was proposing — see `src/tools/AgentTool/SubAgentRegistry.ts` and the `sub_agent` / `send_message` / `cancel_sub_agent` / `list_sub_agents` tools. Sub-agents are scoped to a parent session via `parentSessionId`, which respects BrowserX's invariant that sessions ("tabs") are independent — coupling sessions would be a bug, not a feature. The four claudy "coordinator-only" tools this track listed map 1:1 onto already-shipped sub-agent tools (`TEAM_CREATE` → `sub_agent`, `TEAM_DELETE` → `cancel_sub_agent`, `SEND_MESSAGE` → `send_message`; `SYNTHETIC_OUTPUT` not needed — the parent already produces its own output). Residual items (coordinator-mode system prompt, role-based tool allowlists, shared scratchpad) are prompt-engineering / config / a separate feature, not coordination concerns, and don't justify a track. The original design below is preserved for historical reference.

## Problem

BrowserX has multi-agent instance support (Feature 015) via `AgentRegistry`, but no coordinator mode for orchestrating multiple agents working on related tasks. There is no:

- Coordinator agent that delegates sub-tasks to workers
- Worker agents with restricted tool sets
- Cross-agent messaging (agent-to-agent communication)
- Task notification pipeline (worker results flowing to coordinator)
- Shared scratchpad for cross-worker knowledge

Claudy has a full coordinator mode with worker spawning, SendMessage for follow-ups, task notifications, and worker-specific tool restrictions.

## What Claudy Does

### Coordinator Mode

Activation: `isCoordinatorMode()` checks the GrowthBook `feature('COORDINATOR_MODE')` flag and the `CLAUDE_CODE_COORDINATOR_MODE` env var (`coordinator/coordinatorMode.ts:36–41`). Coordinator mode and fork-subagent (`coordinator/forkSubagent.ts`) are **mutually exclusive** features — fork inherits parent context exactly, while coordinator is explicit delegation.

```typescript
// Coordinator-only tools (INTERNAL_WORKER_TOOLS, coordinatorMode.ts:29–34):
// - TEAM_CREATE_TOOL_NAME       (spawn worker / teammate)
// - TEAM_DELETE_TOOL_NAME       (terminate worker)
// - SEND_MESSAGE_TOOL_NAME      (send follow-up to running worker)
// - SYNTHETIC_OUTPUT_TOOL_NAME  (emit synthesized output)
//
// The Agent tool (tools/AgentTool/) is a separate spawning surface.
// TaskStop is excluded from workers via ALL_AGENT_DISALLOWED_TOOLS
// (constants/tools.ts:36–46) — workers cannot stop other tasks.

// Worker tool sets are gated by TASK TYPE, not by role:
// SIMPLE coordinator mode: Bash, Read, Edit only (coordinatorMode.ts:88–91)
// FULL mode:               ASYNC_AGENT_ALLOWED_TOOLS minus INTERNAL_WORKER_TOOLS
// In-process teammates:    IN_PROCESS_TEAMMATE_ALLOWED_TOOLS
//                          (adds TaskCreate / TaskUpdate / SendMessage / Cron)
```

### Worker Spawning

Workers are spawned **on demand with no built-in queue or cap**. The runtime does not enforce a maximum concurrent worker count; an in-source comment notes ~125 MB RAM per concurrent agent, and resource limits are expected to be enforced at deployment, not in the runtime. Per-teammate `model` override is supported, but **system-prompt override is not** — persona is implicit via agent definition or `subagent_type` (see `tasks/InProcessTeammateTask/types.ts`).

```typescript
AgentTool.call({
  prompt: "Research the top 3 React state management libraries...",
  description: "React state management research",
  subagent_type: "general-purpose",
  model: "claude-sonnet-4-5",  // Optional: per-teammate model override
  isolation: "worktree",       // Optional: git worktree isolation
  run_in_background: true,     // Background execution
})
```

### Cross-Agent Messaging

`SendMessage` is a **tool**, not a background protocol. It routes via `tools/SendMessageTool/SendMessageTool.ts`. Messages are appended to a `pendingMessages` queue on the target task (`tasks/LocalAgentTask/LocalAgentTask.tsx`) and **drained at turn boundaries** — they do not interrupt an in-flight tool invocation.

```typescript
SendMessageTool.call({
  to: "agent-123",
  message: "Focus on Zustand specifically, compare bundle size with Jotai"
})
```

### Task Notifications

Workers automatically notify the coordinator on completion via `enqueueAgentNotification()`, which delivers a `<task-notification>` XML block into the coordinator's conversation:

```xml
<task-notification>
  <task-id>agent-123</task-id>
  <status>completed</status>
  <summary>Compared 3 state management libraries...</summary>
  <result>Zustand: 1.2KB, Jotai: 2.1KB, Redux: 7.8KB...</result>
  <usage>
    <total_tokens>15000</total_tokens>
    <tool_uses>8</tool_uses>
    <duration_ms>45000</duration_ms>
  </usage>
</task-notification>
```

### Coordinator System Prompt

Key directives baked into the coordinator's system prompt:

1. **Self-contained prompts**: "Workers can't see your conversation. Every prompt must be self-contained."
2. **No rubber-stamping**: "Prove the code works, don't just confirm it exists."
3. **Internal signals**: "Never thank or acknowledge worker results — they're internal signals."
4. **Synthesis**: "Your job is to synthesize worker results into user-facing answers."

### Shared Scratchpad

Feature-gated behind the `tengu_scratch` GrowthBook flag. The scratchpad is **directory-based** (workers receive file write access to a shared directory) — there is **no key-value API**. Workers must invent their own structure (filenames, JSON shape, indexing). This is intentional: the coordinator and workers negotiate convention via prompt.

## BrowserX Mapping

### Current State

BrowserX has:
- `AgentRegistry` for multi-agent instance tracking
- `AgentSession` with lifecycle states (created → running → paused → completed)
- `SessionStorage` for persistent session state
- No coordinator mode or worker delegation

### BrowserX Multi-Agent Use Cases

Browser automation has natural coordinator/worker patterns:

1. **Comparison shopping**: Coordinator spawns workers for different shopping sites
2. **Multi-tab research**: Workers each research a topic in separate tabs
3. **Form filling across sites**: Workers fill forms on different platforms
4. **Data aggregation**: Workers extract data from multiple pages, coordinator merges
5. **Monitoring**: Workers watch different pages, coordinator synthesizes alerts

### Proposed Architecture

```
src/core/coordinator/
├── CoordinatorMode.ts         # Mode activation and system prompt
├── WorkerManager.ts           # Worker lifecycle, tool restriction
├── WorkerSpawner.ts           # Create workers with isolated contexts
├── CrossAgentMessaging.ts     # SendMessage implementation
├── TaskNotificationPipeline.ts # Worker → Coordinator notification flow
└── SharedScratchpad.ts        # Cross-worker knowledge persistence
```

### Key Design Decisions

**1. Tab-based Worker Isolation**

Unlike Claudy's git worktree isolation, BrowserX workers are isolated by **browser tab**. Each worker operates in its own tab, preventing DOM conflicts.

```typescript
type WorkerContext = {
  workerId: string
  tabId: number               // Dedicated tab for this worker
  allowedTools: string[]      // Restricted tool set
  parentSessionId: string     // Coordinator's session
}
```

**2. Tool Restriction by Worker Role (BrowserX extension)**

> **Note:** Tool names below use function-definition names (what the LLM sees). See Track 02 for the full name mapping where registry keys differ.
>
> **Divergence from claudy:** Claudy gates worker tools by **task type** (SIMPLE vs FULL vs in-process teammate), not by role. Role-based tool sets are a **net-new BrowserX extension** layered on top of claudy's task-type gating. The role bundles below would be applied **in addition to** the FULL-mode allowlist (`ASYNC_AGENT_ALLOWED_TOOLS` minus `INTERNAL_WORKER_TOOLS`), not as a replacement.

```typescript
// Research worker: read-only tools
const RESEARCH_TOOLS = ['web_scraping', 'data_extraction', 'page_vision', 'planning_tool']

// Automation worker: full browser tools
const AUTOMATION_TOOLS = ['browser_dom', 'browser_navigation', 'form_automation', 'web_scraping']

// Analysis worker: data processing tools
const ANALYSIS_TOOLS = ['data_extraction', 'web_scraping', 'planning_tool']
```

**3. Coordinator-Specific Tools**

```typescript
// Tools available only in coordinator mode (mirroring claudy's INTERNAL_WORKER_TOOLS):
SpawnWorkerTool    // TEAM_CREATE_TOOL_NAME equivalent: create worker with dedicated tab + tool set
SendMessageTool    // SEND_MESSAGE_TOOL_NAME equivalent: send follow-up to running worker
StopWorkerTool     // TEAM_DELETE_TOOL_NAME equivalent: terminate a running worker
SyntheticOutputTool // SYNTHETIC_OUTPUT_TOOL_NAME equivalent: emit synthesized output to user
```

> Worker enumeration is intentionally **not** a separate tool. Claudy does not implement a `ListWorkersTool`; status is surfaced via task-notification stream and existing task introspection. BrowserX should follow the same pattern and expose worker status through `AgentRegistry` queries rather than a new LLM-facing tool.

### Phase Plan

**Phase 1: Coordinator Mode Foundation** (Week 1-2)
- Define coordinator mode activation (config flag or explicit entry)
- Implement coordinator system prompt with BrowserX-specific directives
- Define worker context type with tab isolation
- Implement tool restriction per worker role

**Phase 2: Worker Spawning** (Week 3-4)
- Implement `WorkerSpawner` that creates workers with dedicated tabs
- Register `SpawnWorkerTool` in coordinator's ToolRegistry
- Wire worker lifecycle into existing `AgentRegistry`
- Implement worker cleanup on completion (close tab, release resources)
- Mirror claudy's lifecycle model: each task owns its own `AbortController` (`Task.ts:39`); use `createChildAbortController()` so parent termination cascades to workers; register cleanups via `registerCleanup()` to fire on abort; evict the worker after a `STOPPED_DISPLAY_MS` grace window so the UI can surface final state

**Phase 3: Cross-Agent Messaging** (Week 5)
- Implement `SendMessageTool` for coordinator → worker communication
- Add `pendingMessages` queue in worker context
- Drain messages at tool-round boundaries (not mid-tool)
- Surface worker status via `AgentRegistry` queries (no separate `ListWorkersTool`)

**Phase 4: Task Notifications** (Week 6)
- Implement notification pipeline: worker completion → coordinator
- Define notification format (structured JSON or XML)
- Add notification to coordinator's conversation as system message
- Implement result synthesis prompt for coordinator

## BrowserX-Specific Coordinator Patterns

### Multi-Site Comparison

```
Coordinator: "Compare prices for iPhone 16 across Amazon, BestBuy, and Walmart"
  → Worker 1: Opens Amazon tab, searches, extracts price
  → Worker 2: Opens BestBuy tab, searches, extracts price
  → Worker 3: Opens Walmart tab, searches, extracts price
  → Coordinator: Merges results, presents comparison table
```

### Parallel Form Submission

```
Coordinator: "Submit this job application to LinkedIn, Indeed, and Glassdoor"
  → Worker 1: Opens LinkedIn, fills form, submits
  → Worker 2: Opens Indeed, fills form, submits
  → Worker 3: Opens Glassdoor, fills form, submits
  → Coordinator: Reports submission status for each
```

## Dependencies

- **Track 01** (Hook System): Notifications use event system
- **Track 04** (Typed Tasks): Workers are `BackgroundAgentTask` instances. **Important:** Track 04's task families must be built as extensions of the existing `Session.spawnTask()` / `ActiveTurn` / `TaskRunner` infrastructure, not as a parallel system. Worker spawning here should use `Session.spawnTask()` as the underlying mechanism.
- **Track 07** (Centralized State): Worker state tracked centrally

## Risks

- **Tab management**: Multiple workers opening tabs can overwhelm browser resources. Claudy itself ships **no built-in queue or concurrent-worker cap** (~125 MB RAM per agent per source comment) and expects deployment-level limits. BrowserX should likewise enforce caps at the deployment / `AgentRegistry` policy layer rather than baking a hard runtime limit into the coordinator.
- **Domain conflicts**: Two workers on the same domain may share cookies/auth state. Use separate browser contexts or incognito tabs.
- **Coordinator context size**: Worker results flowing back as notifications can bloat coordinator's context. Apply summarization.

## Validation Notes (re-checked vs claudy 2026-05-11)

This document was re-validated against claudy source on 2026-05-11. Corrections applied:

1. **Coordinator-only tool names** — Replaced ad-hoc names with the real `INTERNAL_WORKER_TOOLS` set: `TEAM_CREATE_TOOL_NAME`, `TEAM_DELETE_TOOL_NAME`, `SEND_MESSAGE_TOOL_NAME`, `SYNTHETIC_OUTPUT_TOOL_NAME` (`coordinator/coordinatorMode.ts:29–34`). Noted that `Agent` is a separate spawning surface (`tools/AgentTool/`) and `TaskStop` is excluded from workers via `ALL_AGENT_DISALLOWED_TOOLS` (`constants/tools.ts:36–46`).
2. **Mode activation** — Documented that `isCoordinatorMode()` checks the GrowthBook `feature('COORDINATOR_MODE')` flag and the `CLAUDE_CODE_COORDINATOR_MODE` env var (`coordinatorMode.ts:36–41`).
3. **Worker spawning** — Removed the implied "default 3 max workers" framing. Claudy spawns workers on demand with no built-in queue or cap; resource limits are deployment-enforced (~125 MB RAM per agent).
4. **Worker tool sets** — Replaced the role-based (RESEARCH / AUTOMATION / ANALYSIS) framing as a claudy primitive. Claudy gates by **task type**: SIMPLE = Bash/Read/Edit (`coordinatorMode.ts:88–91`); FULL = `ASYNC_AGENT_ALLOWED_TOOLS` minus `INTERNAL_WORKER_TOOLS`; in-process teammates = `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` (adds TaskCreate/TaskUpdate/SendMessage/Cron). BrowserX role bundles are flagged as a net-new extension layered on top.
5. **SendMessage** — Clarified it is a **tool** (`tools/SendMessageTool/SendMessageTool.ts`), not a background protocol. Messages queue in `pendingMessages` (`tasks/LocalAgentTask/LocalAgentTask.tsx`) and drain at turn boundaries. Coordinator-bound notifications use `<task-notification>` XML via `enqueueAgentNotification()`.
6. **Scratchpad** — Added that it is feature-gated behind the `tengu_scratch` GrowthBook flag and is **directory-based** (file write access; no key-value API).
7. **Per-agent system prompt** — Documented that claudy supports `model` override per teammate but **not** system-prompt override (see `tasks/InProcessTeammateTask/types.ts`); persona is implicit via agent definition or `subagent_type`.
8. **Coordinator vs fork mutual exclusivity** — Added that coordinator mode and fork-subagent (`coordinator/forkSubagent.ts`) are mutually exclusive: fork inherits parent context exactly; coordinator is explicit delegation.
9. **Worker lifecycle / cleanup** — Added that each task has its own `AbortController` (`Task.ts:39`), `createChildAbortController()` cascades parent termination, cleanups registered via `registerCleanup()` fire on abort, and eviction happens after `STOPPED_DISPLAY_MS` grace.
10. **`ListWorkersTool` removed** — Not implemented in claudy; status surfaces via the task-notification stream and existing introspection. BrowserX should follow suit and use `AgentRegistry` queries.

Source citations: `coordinator/coordinatorMode.ts`, `constants/tools.ts`, `tasks/InProcessTeammateTask/types.ts`, `tasks/LocalAgentTask/LocalAgentTask.tsx`, `tools/SendMessageTool/SendMessageTool.ts`, `coordinator/forkSubagent.ts`.
