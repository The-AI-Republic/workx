# Track 06: Multi-Agent Coordination

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

```typescript
// Coordinator gets special tools:
// - Agent: spawn worker agents
// - SendMessage: send follow-up instructions to running agents
// - TaskStop: kill running agents

// Workers get restricted tools:
// SIMPLE mode: Bash, Read, Edit (minimal for focused tasks)
// FULL mode: All tools minus internal coordinator tools
```

### Worker Spawning

```typescript
AgentTool.call({
  prompt: "Research the top 3 React state management libraries...",
  description: "React state management research",
  subagent_type: "general-purpose",
  isolation: "worktree",      // Optional: git worktree isolation
  run_in_background: true,    // Background execution
})
```

### Cross-Agent Messaging

```typescript
SendMessageTool.call({
  to: "agent-123",
  message: "Focus on Zustand specifically, compare bundle size with Jotai"
})
```

### Task Notifications

Workers automatically notify the coordinator on completion:

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

**2. Tool Restriction by Worker Role**

> **Note:** Tool names below use function-definition names (what the LLM sees). See Track 02 for the full name mapping where registry keys differ.

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
// New tools available only in coordinator mode:
SpawnWorkerTool    // Create a worker with dedicated tab and tool set
SendMessageTool    // Send follow-up to running worker
StopWorkerTool     // Kill a running worker
ListWorkersTool    // Show active workers and their status
```

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

**Phase 3: Cross-Agent Messaging** (Week 5)
- Implement `SendMessageTool` for coordinator → worker communication
- Add `pendingMessages` queue in worker context
- Drain messages at tool-round boundaries
- Implement `ListWorkersTool` for status overview

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

- **Tab management**: Multiple workers opening tabs can overwhelm browser resources. Limit concurrent workers (default: 3).
- **Domain conflicts**: Two workers on the same domain may share cookies/auth state. Use separate browser contexts or incognito tabs.
- **Coordinator context size**: Worker results flowing back as notifications can bloat coordinator's context. Apply summarization.
