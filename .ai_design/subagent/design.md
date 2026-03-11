# Sub-Agent System Design

## 1. Overview

Add a sub-agent capability where the main agent can spawn child agent instances to handle delegated tasks. Inspired by Claude Code's architecture: **a sub-agent is just another instance of the same agentic loop**, invoked via a tool call, with different configuration.

**Prerequisite:** This design depends on the AgentExecutor refactoring described in `refactor-republic-agent.md`. Sub-agents use `AgentExecutor` (the lightweight core execution engine), NOT the full `RepublicAgent`.

### Design Principles

1. **Same loop, different config** — Sub-agents reuse AgentExecutor (Session + TurnManager + TaskRunner), not RepublicAgent
2. **Tool-driven spawning** — The LLM decides when to delegate via a `sub_agent` tool call
3. **Context isolation** — Each sub-agent gets a fresh Session with no parent history
4. **Single context bridge** — Only the tool's `prompt` parameter crosses the boundary
5. **Result compression** — Only the sub-agent's final text response returns to the parent
6. **No nesting** — Sub-agents cannot spawn their own sub-agents (flat hierarchy)
7. **Platform-agnostic** — Core sub-agent logic lives in `src/core/`, works on all platforms

### What We Already Have

| Component | Status | Notes |
|---|---|---|
| RepublicAgent (instanceable) | Ready | Each instance has own session, tools, queues |
| AgentRegistry (multi-instance) | Ready | Already manages concurrent agents for scheduler |
| ToolRegistry (per-agent) | Ready | Different tool subsets per instance |
| TurnContext (configurable) | Ready | Per-instance system prompt, model, policies |
| Session (isolated history) | Ready | Per-instance conversation history |
| ApprovalManager (per-agent) | Ready | Different approval policies per instance |
| ModelClientFactory (per-agent) | Ready | Different models per instance |
| EventDispatcher (per-agent) | Ready | Factory pattern for routing |

### What We Need to Build

1. **SubAgentTool** — Tool definition + handler the LLM invokes
2. **SubAgentConfig** — Configuration profiles for sub-agent types
3. **SubAgentRunner** — Orchestrator that spawns, runs, and collects results
4. **SubAgentRegistry** — Tracks active sub-agents within a parent session
5. **Tool subsetting** — Mechanism to restrict which tools a sub-agent can use

---

## 2. Architecture

### Execution Flow

```
Parent Agent (Turn N)
  │
  ├─ LLM outputs: tool_call("sub_agent", {
  │     type: "researcher",
  │     prompt: "Find all API endpoints in src/routes/",
  │     background: false
  │   })
  │
  ├─ SubAgentTool.handler() receives call
  │   │
  │   ├─ Load SubAgentConfig for type "researcher"
  │   ├─ Create AgentExecutor via parentAgent.createExecutor():
  │   │   - Fresh Session (empty history, non-persistent)
  │   │   - Restricted ToolRegistry (per config)
  │   │   - Custom system prompt (per config)
  │   │   - Model override (per config, or inherit parent)
  │   │   - Auto-approve policy (no user interaction)
  │   │   - Shared ModelClientFactory (parent's auth/credentials)
  │   ├─ executor.run(prompt) — awaitable, runs to completion
  │   ├─ Returns ExecutorResult with final text + metadata
  │   └─ Executor garbage collected (non-persistent session)
  │
  ├─ Tool result: "Found 12 endpoints: GET /api/users, ..."
  │
  └─ Parent continues (Turn N+1) with result in context
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│ Parent RepublicAgent                                    │
│                                                         │
│  ToolRegistry                                           │
│    ├─ browser_dom, browser_navigate, ...                │
│    ├─ planning_tool                                     │
│    ├─ sub_agent  ◄── NEW                                │
│    └─ mcp_*, a2a_*                                      │
│                                                         │
│  When sub_agent tool called:                            │
│    ┌─────────────────────────────────────────────────┐  │
│    │ SubAgentRunner                                  │  │
│    │                                                 │  │
│    │  ┌─ AgentExecutor ───────────────────────────┐  │  │
│    │  │  - Fresh Session (empty, non-persistent)   │  │  │
│    │  │  - Restricted ToolRegistry                 │  │  │
│    │  │  - Custom TurnContext (system prompt, model)│  │  │
│    │  │  - Auto-approve (approvalPolicy: 'never')  │  │  │
│    │  │  - onEvent callback (not routed to UI)     │  │  │
│    │  │                                            │  │  │
│    │  │  Runs: prompt → tools → tools → ... → text │  │  │
│    │  └────────────────────────────────────────────┘  │  │
│    │                                                 │  │
│    │  Returns: final text message                    │  │
│    └─────────────────────────────────────────────────┘  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Data Model

### SubAgentConfig

```typescript
// File: src/core/subagent/types.ts

/**
 * Configuration for a sub-agent type.
 * Analogous to Claude Code's .claude/agents/*.md frontmatter.
 */
export interface SubAgentTypeConfig {
  /** Unique identifier for this sub-agent type (e.g., "researcher", "coder") */
  id: string;

  /** Human-readable name shown in tool description */
  name: string;

  /** Description of when to use this sub-agent — included in the sub_agent
   *  tool schema so the LLM knows when to delegate */
  description: string;

  /** System prompt for this sub-agent type */
  systemPrompt: string;

  /** Tool access control */
  tools?: {
    /** If set, only these tools are available (allowlist) */
    allow?: string[];
    /** If set, these tools are removed from available set (denylist) */
    deny?: string[];
  };

  /** Model override. If omitted, inherits parent's model */
  model?: string;

  /** Max turns before forced stop. Prevents runaway agents. Default: 25 */
  maxTurns?: number;

  /** Approval policy for the sub-agent. Default: 'never' (auto-approve) */
  approvalPolicy?: 'never' | 'inherit';

  /** Whether this type always runs in background. Default: false */
  background?: boolean;
}

/**
 * Parameters for the sub_agent tool call (what the LLM provides)
 */
export interface SubAgentToolParams {
  /** Which sub-agent type to invoke */
  type: string;

  /** The task/prompt to send to the sub-agent */
  prompt: string;

  /** Short description of what the sub-agent will do (for UI/logging) */
  description?: string;

  /** Run in background (parent continues without waiting). Default: false */
  background?: boolean;
}

/**
 * Result returned from a sub-agent execution
 */
export interface SubAgentResult {
  /** Whether the sub-agent completed successfully */
  success: boolean;

  /** The sub-agent's final text response */
  response: string;

  /** Unique ID for this sub-agent run (for resumption/reference) */
  runId: string;

  /** Token usage for the sub-agent's execution */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };

  /** Number of turns the sub-agent took */
  turnCount: number;

  /** Why the sub-agent stopped */
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled';

  /** Error message if stopReason is 'error' */
  error?: string;
}

/**
 * Tracks an active sub-agent within a parent session
 */
export interface ActiveSubAgent {
  runId: string;
  type: string;
  description: string;
  parentSessionId: string;
  agent: RepublicAgent;
  startTime: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}
```

### Built-in Sub-Agent Types

```typescript
// File: src/core/subagent/builtinTypes.ts

import type { SubAgentTypeConfig } from './types';

export const BUILTIN_SUBAGENT_TYPES: SubAgentTypeConfig[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Fast read-only agent for exploring the codebase, searching files, reading documentation, and gathering information. Use when you need to find or understand something before acting.',
    systemPrompt: `You are a research assistant. Your job is to find information, read files, search code, and report back concisely.

Rules:
- Focus on gathering facts, not making changes
- Be thorough but concise in your findings
- Report file paths and line numbers when referencing code
- If you can't find what you're looking for, say so clearly`,
    tools: {
      deny: ['browser_dom', 'browser_navigate', 'browser_screenshot', 'exec_command', 'sub_agent'],
    },
    maxTurns: 15,
    approvalPolicy: 'never',
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Agent for analyzing requirements and creating implementation plans. Use when you need to break down a complex task into steps before executing.',
    systemPrompt: `You are a planning assistant. Analyze the task, identify the files and components involved, and create a clear step-by-step plan.

Rules:
- Read relevant code before planning
- Identify dependencies between steps
- Note potential risks or edge cases
- Keep plans actionable and concrete`,
    tools: {
      deny: ['browser_dom', 'browser_navigate', 'exec_command', 'sub_agent'],
    },
    maxTurns: 20,
    approvalPolicy: 'never',
  },
  {
    id: 'worker',
    name: 'Worker',
    description: 'General-purpose agent that can read, write, and execute. Use for independent sub-tasks that can be fully described in the prompt without needing back-and-forth.',
    systemPrompt: `You are a task executor. Complete the assigned task efficiently and report what you did.

Rules:
- Do exactly what is asked, no more
- Report what you changed and why
- If you encounter an unexpected situation, describe it clearly`,
    tools: {
      deny: ['sub_agent'],  // No nesting
    },
    maxTurns: 25,
    approvalPolicy: 'never',
  },
];
```

---

## 4. Core Components

### 4.1 SubAgentTool

The tool definition registered in the parent's ToolRegistry.

```typescript
// File: src/core/subagent/SubAgentTool.ts

import type { ToolDefinition } from '../tools/ToolRegistry';
import type { SubAgentTypeConfig } from './types';

/**
 * Build the sub_agent tool definition.
 * The type enum is dynamically populated from registered sub-agent types.
 */
export function buildSubAgentToolDefinition(
  types: SubAgentTypeConfig[]
): ToolDefinition {
  const typeDescriptions = types
    .map(t => `- "${t.id}": ${t.description}`)
    .join('\n');

  return {
    type: 'function',
    function: {
      name: 'sub_agent',
      description: `Delegate a task to a specialized sub-agent. The sub-agent runs independently with its own context and returns a result. Use this when a task is self-contained and can be fully described in the prompt.

Available types:
${typeDescriptions}`,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: types.map(t => t.id),
            description: 'Which sub-agent type to invoke',
          },
          prompt: {
            type: 'string',
            description: 'Complete task description with all necessary context. The sub-agent has NO access to your conversation history — include everything it needs.',
          },
          description: {
            type: 'string',
            description: 'Short (3-5 word) summary of what the sub-agent will do',
          },
          background: {
            type: 'boolean',
            description: 'Run in background (you continue without waiting). Default: false',
          },
        },
        required: ['type', 'prompt'],
      },
    },
  };
}
```

### 4.2 SubAgentRunner

Orchestrates sub-agent lifecycle: create executor → run → return result.

```typescript
// File: src/core/subagent/SubAgentRunner.ts

/**
 * SubAgentRunner creates and manages AgentExecutor instances for sub-agent tasks.
 *
 * Responsibilities:
 * - Create AgentExecutor with correct config (tools, prompt, model)
 * - Run the prompt to completion (awaitable via executor.run())
 * - Return structured ExecutorResult
 * - Emit SubAgentStart/Complete/Error events to parent
 * - Handle cancellation (parent cancelled → cancel executor)
 *
 * Design decisions:
 * - Uses AgentExecutor, NOT RepublicAgent (no SQ/EQ, no tabs, no UI)
 * - Sub-agent events collected via onEvent callback, NOT forwarded to parent UI
 * - Sub-agent approval policy is 'never' (auto-approve all tools)
 * - Sub-agent cannot spawn sub-agents (sub_agent tool excluded from registry)
 * - Sub-agent shares parent's ModelClientFactory (credentials/auth)
 * - Sub-agent Session is non-persistent (no disk writes)
 */
```

**Key Implementation Details:**

1. **Executor Creation**:
   - Call `parentAgent.createExecutor()` with sub-agent config
   - Pass restricted `ToolRegistry` (from `createSubAgentToolRegistry()`)
   - Pass custom system prompt from `SubAgentTypeConfig`
   - Pass optional model override (or inherit parent's model)
   - Set `persistent: false` (no rollout recording, no title generation)

2. **Execution**:
   - Call `executor.run(inputItems, { maxTurns, signal })` — **awaitable**
   - Returns `ExecutorResult` with success, response, turnCount, tokenUsage, stopReason
   - No event queue polling needed — `run()` returns when done

3. **Result Return**:
   - `ExecutorResult.response` is the final assistant text (extracted by RegularTask)
   - Map to `SubAgentResult` with additional metadata
   - Return as tool_call_output to parent

4. **Cleanup**:
   - AgentExecutor's Session is non-persistent — no disk state to clean
   - Executor + Session garbage collected after run() returns
   - No explicit shutdown needed

### 4.3 SubAgentRegistry

Tracks active sub-agents within a parent session scope.

```typescript
// File: src/core/subagent/SubAgentRegistry.ts

/**
 * SubAgentRegistry tracks active sub-agent runs within a parent session.
 *
 * Responsibilities:
 * - Track active sub-agents per parent session
 * - Enforce concurrency limits (max 3 concurrent sub-agents per parent)
 * - Cancel all sub-agents when parent session ends
 * - Provide status queries for UI display
 *
 * NOT a singleton — one per parent agent instance.
 */
```

**Concurrency Limits:**
- Max 3 concurrent sub-agents per parent session
- Background sub-agents count toward the limit
- If limit reached, foreground calls wait; background calls are rejected

### 4.4 Tool Subsetting

How we restrict which tools a sub-agent can use.

```typescript
// File: src/core/subagent/toolSubset.ts

/**
 * Create a restricted ToolRegistry for a sub-agent.
 *
 * Strategy:
 * 1. Start with parent's registered tools
 * 2. Apply allowlist (if specified): keep only listed tools
 * 3. Apply denylist: remove listed tools
 * 4. Always remove 'sub_agent' tool (no nesting)
 * 5. Register tools into a new ToolRegistry instance
 *
 * The sub-agent's ToolRegistry is a fresh instance with
 * copied tool definitions and handlers — not a reference
 * to the parent's registry.
 */

export function createSubAgentToolRegistry(
  parentRegistry: ToolRegistry,
  config: SubAgentTypeConfig
): ToolRegistry {
  const childRegistry = new ToolRegistry();
  const parentTools = parentRegistry.listTools();

  for (const tool of parentTools) {
    const name = getToolName(tool);

    // Always exclude sub_agent (no nesting)
    if (name === 'sub_agent') continue;

    // Apply allowlist
    if (config.tools?.allow && !config.tools.allow.includes(name)) continue;

    // Apply denylist
    if (config.tools?.deny?.includes(name)) continue;

    // Copy tool to child registry
    const entry = parentRegistry.getToolEntry(name);
    if (entry) {
      childRegistry.register(entry.definition, entry.handler, entry.riskAssessor);
    }
  }

  return childRegistry;
}
```

> **Note:** This requires exposing `getToolEntry(name)` on ToolRegistry to access the handler and risk assessor alongside the definition. Currently `getTool()` only returns the definition.

---

## 5. Integration Points

### 5.1 Registration in Bootstrap

Each platform bootstrap registers the sub_agent tool after other tools.

```typescript
// In ServerAgentBootstrap.ts, DesktopAgentBootstrap.ts, service-worker.ts

// After registering platform tools...
import { registerSubAgentTool } from '../core/subagent/register';

// Register sub-agent tool with built-in types
registerSubAgentTool(agent, {
  types: BUILTIN_SUBAGENT_TYPES,
  // Platform-specific overrides
  maxConcurrent: 3,
});
```

### 5.2 Event Handling

Sub-agent events are **not** forwarded to the parent's UI channel. Instead:

- Sub-agent events are collected internally by `SubAgentRunner`
- Parent UI sees only: `SubAgentStart`, `SubAgentComplete`, `SubAgentError` events (new event types)
- These lightweight events show progress without flooding the UI

```typescript
// New event types in src/core/protocol/events.ts

interface SubAgentStartEvent {
  type: 'SubAgentStart';
  runId: string;
  subAgentType: string;
  description: string;
  background: boolean;
}

interface SubAgentCompleteEvent {
  type: 'SubAgentComplete';
  runId: string;
  subAgentType: string;
  turnCount: number;
  tokenUsage?: { input: number; output: number; total: number };
  duration: number;  // ms
}

interface SubAgentErrorEvent {
  type: 'SubAgentError';
  runId: string;
  subAgentType: string;
  error: string;
}
```

### 5.3 Approval Policy

Sub-agents default to `approvalPolicy: 'never'` (auto-approve everything). Rationale:

- The parent agent is already approved by the user
- Sub-agents operate within the scope the parent delegates
- Interactive approval would block the agent loop (sub-agents can't prompt the user)
- If a sub-agent type needs restrictions, use tool deny lists instead

Exception: `approvalPolicy: 'inherit'` can be set to use the parent's policy. This only works for foreground sub-agents where the UI can display prompts.

### 5.4 Model Selection

Sub-agents can use a different model than the parent:

```
config.model = undefined  → inherit parent's current model (default)
config.model = "providerId:modelId"  → use specific model
```

This enables cost optimization: use a cheaper/faster model for research sub-agents, the primary model for worker sub-agents.

---

## 6. Background Execution

### Foreground (default)

```
Parent turn blocked → SubAgentRunner.run() → awaits completion → returns result
```

- Parent's agentic loop pauses on this tool call
- Sub-agent runs to completion
- Result returned as tool_call_output

### Background

```
Parent continues → SubAgentRunner.runBackground() → tracks in registry
  ...later...
Parent can query: sub_agent_status tool call → check if done
```

Background execution requires:
1. A `sub_agent_status` companion tool to check/retrieve results
2. The parent emits `SubAgentStart` event so UI can show a spinner
3. When done, result stored in `SubAgentRegistry` keyed by `runId`
4. Parent gets `SubAgentComplete` notification in its event stream

**Phase 1 scope:** Foreground only. Background is Phase 2.

---

## 7. Error Handling

| Scenario | Behavior |
|---|---|
| Sub-agent exceeds maxTurns | Stop, return partial result + `stopReason: 'max_turns'` |
| Sub-agent tool call fails | Sub-agent handles internally (retry or give up) |
| Sub-agent throws unhandled error | Catch, return `stopReason: 'error'` with message |
| Parent cancelled while sub-agent running | Cancel sub-agent, return `stopReason: 'cancelled'` |
| Invalid sub-agent type | Return error immediately (no agent spawned) |
| Max concurrent sub-agents reached | Foreground: wait. Background: reject with error |
| Model API error (auth, rate limit) | Sub-agent retries per TurnManager logic, then fails |

---

## 8. Constraints & Non-Goals

### Hard Constraints
- **No nesting**: Sub-agents cannot invoke sub_agent tool (enforced by tool exclusion)
- **No parent history**: Sub-agents start with empty conversation history
- **No shared state**: Sub-agents don't share Session, history, or tool state with parent
- **No peer communication**: Sub-agents can't talk to each other

### Phase 1 Non-Goals (future consideration)
- Background execution (Phase 2)
- Sub-agent resume/continuation (Phase 2)
- User-defined sub-agent types via UI (Phase 2)
- Sub-agent memory persistence across sessions (Phase 3)
- Token budget per sub-agent (Phase 2)
- Sub-agent streaming to parent UI (Phase 2)

---

## 9. File Structure

```
src/core/subagent/
  ├── types.ts                 # Type definitions
  ├── builtinTypes.ts          # Built-in sub-agent type configs
  ├── SubAgentTool.ts          # Tool definition builder
  ├── SubAgentRunner.ts        # Spawn, run, collect, cleanup
  ├── SubAgentRegistry.ts      # Track active sub-agents per parent
  ├── toolSubset.ts            # Create restricted ToolRegistry
  ├── register.ts              # Bootstrap registration helper
  └── index.ts                 # Public API exports
```

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Token cost explosion (sub-agent makes many tool calls) | High cost | maxTurns limit + future token budget |
| Context bloat (large sub-agent results) | Parent context consumed | Sub-agent instructed to be concise in system prompt; consider truncation |
| Stale model client (sub-agent uses expired auth) | API errors | Share parent's ModelClientFactory (auto-refreshes) |
| Resource leak (sub-agent not cleaned up) | Memory/connection leak | Non-persistent Session + GC after run(). Add maxDurationMs timeout via Promise.race() |
| LLM over-delegates (uses sub-agent for simple tasks) | Unnecessary cost | System prompt guidance: "only delegate complex tasks" |
| Sub-agent hangs on a single tool call | Parent blocks indefinitely | maxDurationMs wall-clock timeout wrapping executor.run() |

---

## 11. Required Changes to Existing Code

**Prerequisite:** The AgentExecutor refactoring (`refactor-republic-agent.md`) must be completed first. It provides:
- `AgentExecutor` class (the core execution engine)
- `RepublicAgent.createExecutor()` factory method
- `ToolRegistry.getToolEntry()` method

### Event Types (additive)

Add `SubAgentStart`, `SubAgentComplete`, `SubAgentError` to event types enum in `src/core/protocol/events.ts`.

### System Prompt (additive)

Add sub_agent usage guidance to base system prompt via PromptComposer.

---

## 12. Comparison with Claude Code

| Aspect | Claude Code | Our Design |
|---|---|---|
| Tool name | `Agent` | `sub_agent` |
| Type definitions | `.md` files with YAML frontmatter | TypeScript config objects (Phase 1), file-based (Phase 2) |
| Context passing | `prompt` param only | `prompt` param only (same) |
| Result return | Last text message | Last AgentMessage event text (same pattern) |
| Nesting | Sub-agents cannot spawn sub-agents | Same |
| Tool restrictions | `tools`/`disallowedTools` fields | `tools.allow`/`tools.deny` (same semantics) |
| Model override | `model` field (sonnet/opus/haiku/inherit) | `model` field (compositeKey or inherit) |
| Background | Yes, with pre-approved permissions | Phase 2 |
| Resume | Yes, via agentId | Phase 2 |
| Worktree isolation | Yes, git worktree per agent | N/A (browser context, not filesystem) |
| Max turns | `maxTurns` field | `maxTurns` field (same) |
| Discovery | Auto-load from `.claude/agents/` | Programmatic registration (Phase 1) |
| Memory | Persistent memory directories | Phase 3 |
