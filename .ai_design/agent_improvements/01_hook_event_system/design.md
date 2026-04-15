# Track 01: Hook & Event System

## Problem

BrowserX has no hook system. Tools execute atomically with no extensibility points before, during, or after execution. Events are one-way callbacks with no subscriber pattern. This prevents:

- Plugins from modifying tool behavior
- Custom formatters/linters running after file edits
- Permission hooks that modify input before approval
- Session lifecycle hooks for cleanup, persistence, diagnostics
- Post-tool-use hooks for logging, metrics, notifications

Claudy has 28 hook event types with 4 hook command types (shell, prompt, agent, HTTP), composable middleware, and async execution support.

## What Claudy Does

### Hook Events (28 types)

```typescript
type HookEvent =
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd' | 'Stop'
  | 'SubagentStart' | 'SubagentStop'
  | 'PreCompact' | 'PostCompact'
  | 'PermissionRequest' | 'PermissionDenied'
  | 'TaskCreated' | 'TaskCompleted'
  | 'CwdChanged' | 'FileChanged'
  | 'Elicitation' | 'ElicitationResult'
  | 'ConfigChange' | 'WorktreeCreate' | 'WorktreeRemove'
  | 'InstructionsLoaded' | 'Notification'
  | 'Setup' | 'StopFailure' | 'TeammateIdle'
```

### Hook Command Types

1. **Command** (shell): Execute a shell command, get stdout/stderr
2. **Prompt** (LLM): Send a prompt to a model, get text response
3. **Agent** (agentic): Spawn an agent to verify/modify
4. **HTTP** (webhook): POST to an external service

### Claudy Hook Execution Pipeline (Deep Dive)

Claudy's core execution lives in `src/utils/hooks.ts` (~7000 lines). The pipeline:

```
executeHooks(event, context)
├─ Trust check: workspace trust required in interactive mode (skipped for SDK)
├─ Env check: CLAUDE_CODE_SIMPLE disables all hooks
├─ getMatchingHooks():
│  ├─ Collect from all sources (user settings > project settings > local settings > plugins > built-in)
│  ├─ Filter by matcher pattern (tool name, glob-like syntax)
│  ├─ Apply `if` condition filtering (permission rule syntax, e.g. "Bash(git *)")
│  ├─ Deduplicate by command+if condition
│  └─ Exclude HTTP hooks for SessionStart/Setup (deadlock prevention)
├─ Execute ALL matched hooks in parallel (async generator pattern)
│  ├─ Each hook type has its own executor:
│  │   ├─ execCommandHook() — shell via child_process, exit codes matter
│  │   ├─ execPromptHook() — LLM evaluation, model configurable
│  │   ├─ execAgentHook() — agentic verification, spawns subagent
│  │   └─ execHttpHook() — POST to URL with JSON body
│  ├─ Individual per-hook timeout (default 10min for tools, 1.5s for SessionEnd)
│  └─ Output validated via Zod schema
├─ Yield results individually as hooks complete (async generator)
├─ Aggregate results:
│  ├─ Permission precedence: deny > ask > allow > passthrough
│  ├─ Collect: additionalContext, watchPaths, updatedInput, updatedMCPToolOutput
│  └─ Track outcomes: success | blocking | non_blocking_error | cancelled
└─ Analytics logging
```

**Exit code semantics (command hooks):**
| Exit Code | Meaning | Behavior |
|-----------|---------|----------|
| 0 | Success | stdout shown in transcript mode |
| 1 | Non-blocking error | stderr shown to user only, execution continues |
| 2 | Blocking error | stderr shown to model, blocks the operation |

**Hook response schema** (validated by Zod in `src/schemas/hooks.ts`):
```typescript
interface SyncHookJSONOutput {
  continue?: boolean;           // false = block execution
  suppressOutput?: boolean;     // hide stdout from transcript
  stopReason?: string;          // message when continue is false
  decision?: 'approve' | 'block';  // permission decision
  systemMessage?: string;       // warning shown to user
  hookSpecificOutput?: {
    updatedInput?: Record<string, unknown>;    // modify tool input (PreToolUse)
    updatedMCPToolOutput?: unknown;            // modify tool output (PostToolUse)
    permissionRequestResult?: PermissionResult;
    watchPaths?: string[];
    additionalContext?: string;
  };
}

interface AsyncHookJSONOutput {
  async: true;
  asyncTimeout?: number;  // custom timeout for background execution
}
```

### Claudy Hook Registration Architecture

**Source priority (highest to lowest):**
1. User settings (`~/.claude/settings.json`) — user-scoped
2. Project settings (`.claude/settings.json`) — repo-scoped
3. Local settings (`.claude/settings.local.json`) — gitignored overrides
4. Plugin hooks — from plugin manifests
5. Session hooks — in-memory, temporary (function callbacks)
6. Built-in hooks — internal SDK callbacks

**Session hooks** (`src/utils/hooks/sessionHooks.ts`) use Map-based storage (not Record) for identity preservation, supporting:
- `addSessionHook()` — register command/prompt/agent/http hooks at runtime
- `addFunctionHook()` — register TypeScript callback hooks (session-scoped only)
- `removeFunctionHook()` / `removeSessionHook()` — cleanup by ID
- `OnHookSuccess` callbacks — react to hook completion

**Plugin hooks** (`src/utils/plugins/loadPluginHooks.ts`):
- Plugins define hooks in manifest via `hooksConfig` field
- Hot-reload support: subscribes to policySettings changes, reloads on plugin toggle
- Plugin context injected: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${user_config.X}`

### Claudy Hook Configuration Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash lint.sh",
            "timeout": 10,
            "if": "Bash(git *)",
            "once": false,
            "async": false,
            "statusMessage": "Running lint..."
          },
          {
            "type": "prompt",
            "prompt": "Is this a dangerous bash command? Arguments: $ARGUMENTS",
            "model": "claude-haiku-4-5-20251001"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "echo 'Session started'" }
        ]
      }
    ]
  }
}
```

### Claudy Hook Input Schema

All hooks receive JSON input via stdin (command) or body (HTTP):
```typescript
interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  hook_event_name: HookEvent;  // discriminator

  // Event-specific fields (union):
  // PreToolUse/PostToolUse: tool_name, tool_input, tool_output
  // UserPromptSubmit: user_prompt
  // SessionStart: source ('startup' | 'resume' | 'clear' | 'compact')
  // SessionEnd: reason
  // etc.
}
```

**Matcher fields by event:**
| Event | Matches On |
|-------|------------|
| PreToolUse / PostToolUse / PermissionDenied | `tool_name` |
| SessionStart | `source` |
| Setup | `trigger` |
| Notification | `notification_type` |
| SubagentStart / SubagentStop | `agent_type` |
| FileChanged | filename (via `basename()`) |
| Elicitation / ElicitationResult | `mcp_server_name` |
| ConfigChange | `source` |
| InstructionsLoaded | `load_reason` |

### Claudy Async Hook Registry

**File:** `src/utils/hooks/AsyncHookRegistry.ts`

Background hooks that return `{"async": true}`:
- Registered in `AsyncHookRegistry` for polling
- Registry monitors `shellCommand.status` for completion
- On completion, emits response via `emitHookResponse()`
- `asyncRewake: true` variant: runs async but blocks on exit code 2 (wakes the model)

### Claudy Hook Observability

**File:** `src/utils/hooks/hookEvents.ts`

Event emission for SDK consumers:
- `HookStartedEvent` — hook began execution
- `HookProgressEvent` — stdout/stderr streaming
- `HookResponseEvent` — hook completed with outcome

Always emitted (regardless of `includeHookEvents`): SessionStart, Setup.
Pending events buffered (up to 100) until handler is registered.

---

## BrowserX Mapping

### What BrowserX Has Today

- **Events**: 80+ event types in `core/protocol/events.ts`, structured emission through `Session`/`TurnManager` — not a blank callback world
- **Approval pipeline**: `ApprovalGate.check()` (`src/core/approval/ApprovalGate.ts:92`) implements a multi-step pipeline:
  ```
  domain check (blocked/trusted fast path, lines 105-120)
  → risk assessment via IRiskAssessor.assess() (lines 122-134)
  → context enhancers chain (lines 137-139)
  → PolicyRulesEngine.evaluate() deny rules (lines 146-151)
  → YOLO mode bypass (lines 153-156)
  → session memory with risk ceiling guard (lines 159-171)
  → mode-based threshold (lines 174-185)
  → ApprovalManager.requestApproval() for ask_user (lines 195-231)
  ```
- **Tool execution flow**: Two-tier dispatch in `TurnManager`:
  1. `TurnManager.handleResponseItem()` (`TurnManager.ts:524`) receives `function_call` items from model stream
  2. Calls `TurnManager.executeToolCall()` (`TurnManager.ts:630`) which routes:
     - `web_search` → `executeWebSearch()`
     - Everything else → `ToolRegistry.execute()` or MCP fallback
  3. `ToolRegistry.execute()` (`ToolRegistry.ts:236`) handles: lookup → validation → approval gate → handler dispatch
- **DOM parameter enrichment**: `ToolRegistry.enrichDomParameters()` (`ToolRegistry.ts:469`) enriches browser_dom parameters with ARIA labels, roles, and text content before risk assessment — read-only, does not modify execution params
- **No hook registration**: Tools execute atomically with no extensibility points
- **No hook configuration**: `IAgentConfig` and `IStoredConfig` (`src/config/types.ts`) have no hook fields
- **Event emission pattern**: `Session.emitEvent()` → `eventEmitter` callback → `RepublicAgent.emitEvent()` → `EventDispatcher` → UI channel transport

### Proposed Architecture

```
src/core/hooks/
├── types.ts                 # HookEvent, HookCommand, HookResponse, HookInput types
├── HookRegistry.ts          # Central hook registration, discovery, source management
├── HookExecutor.ts          # Hook execution engine (command, prompt, HTTP)
├── HookMatcher.ts           # Pattern matching for tool names and parameters
├── HookAggregator.ts        # Merge multiple hook results into AggregatedHookResult
├── AsyncHookTracker.ts      # Track background async hooks
└── loaders/
    ├── ConfigHookLoader.ts  # Load hooks from AgentConfig / IStoredConfig
    └── SessionHookStore.ts  # In-memory session-scoped hook storage
```

---

## Detailed Implementation

### 1. Type Definitions (`src/core/hooks/types.ts`)

```typescript
/**
 * Hook events supported by BrowserX.
 * Phase 1 ships the first 10; remaining events added in later phases.
 */
export type HookEvent =
  // Phase 1: Core tool lifecycle
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  // Phase 1: Session lifecycle
  | 'SessionStart'
  | 'SessionEnd'
  // Phase 1: User interaction
  | 'UserPromptSubmit'
  | 'Stop'
  // Phase 1: Approval integration
  | 'PermissionRequest'
  | 'PermissionDenied'
  // Phase 1: Task tracking
  | 'TaskCreated'
  | 'TaskCompleted'
  // Phase 2+
  | 'PreCompact'
  | 'PostCompact'
  | 'ConfigChange';

/**
 * Hook command types — what the hook actually does.
 * Phase 1 ships "command" only (desktop/server mode).
 * Phase 2 adds "prompt" and "http".
 */
export type HookCommandType = 'command' | 'prompt' | 'http';

/**
 * A single hook command definition (matches claudy's HookCommand schema).
 */
export interface HookCommand {
  type: HookCommandType;

  // Command-type fields
  command?: string;           // Shell command to execute
  shell?: 'bash' | 'powershell';

  // Prompt-type fields
  prompt?: string;            // Prompt template with $ARGUMENTS, $TOOL_NAME, $FILE_PATH
  model?: string;             // Model ID for prompt hooks (default: cheapest available)

  // HTTP-type fields
  url?: string;               // POST target
  headers?: Record<string, string>;

  // Common fields
  timeout?: number;           // Seconds (default: 30 for commands, 60 for prompts)
  if?: string;                // Condition filter (e.g., "browser_dom(click)")
  once?: boolean;             // Auto-remove after first execution
  async?: boolean;            // Run without blocking
  statusMessage?: string;     // UI spinner text
}

/**
 * A matcher entry: an event can have multiple matcher groups,
 * each with a pattern and a list of hooks.
 */
export interface HookMatcherEntry {
  matcher?: string;           // Pattern to match (tool name, glob). Omit = match all.
  hooks: HookCommand[];
}

/**
 * Where a hook was registered from, for display and priority ordering.
 */
export type HookSource =
  | 'config'         // From AgentConfig / stored settings
  | 'session'        // In-memory, runtime-registered
  | 'plugin';        // From plugin manifest (future)

/**
 * Internal registered hook with source metadata.
 */
export interface RegisteredHook {
  id: string;                 // Unique ID for removal
  event: HookEvent;
  matcher?: string;
  command: HookCommand;
  source: HookSource;
  registeredAt: number;
}

/**
 * Hook execution outcome for a single hook.
 */
export type HookOutcome = 'success' | 'blocking_error' | 'non_blocking_error' | 'cancelled' | 'timeout';

/**
 * Result from a single hook execution.
 */
export interface HookResult {
  hookId: string;
  outcome: HookOutcome;
  exitCode?: number;          // For command hooks
  stdout?: string;
  stderr?: string;
  duration: number;           // ms

  // Parsed response fields (from JSON stdout or HTTP response body)
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  updatedInput?: Record<string, unknown>;
  updatedOutput?: unknown;
  additionalContext?: string;
}

/**
 * Aggregated result from all hooks for a single event firing.
 */
export interface AggregatedHookResult {
  /** True if all hooks returned continue !== false */
  shouldContinue: boolean;
  /** First non-null stopReason from any hook */
  stopReason?: string;
  /** Merged updatedInput (last-writer-wins per key) */
  updatedInput?: Record<string, unknown>;
  /** Merged updatedOutput */
  updatedOutput?: unknown;
  /** Combined additional context strings */
  additionalContext: string[];
  /** Combined system messages */
  systemMessages: string[];
  /** Permission decision (deny > ask > allow > passthrough) */
  permissionDecision?: 'approve' | 'block';
  /** Individual hook results for diagnostics */
  results: HookResult[];
  /** Total wall-clock time for all hooks (parallel) */
  totalDuration: number;
}

/**
 * Hook input — the context passed to each hook when it fires.
 * Serialized as JSON to stdin for command hooks, or as POST body for HTTP hooks.
 */
export interface HookInput {
  hook_event_name: HookEvent;
  session_id: string;
  cwd?: string;

  // Tool-related (PreToolUse, PostToolUse, PostToolUseFailure)
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_error?: string;

  // User interaction (UserPromptSubmit)
  user_prompt?: string;

  // Session lifecycle
  session_start_source?: 'startup' | 'resume';
  session_end_reason?: string;

  // Approval (PermissionRequest, PermissionDenied)
  risk_score?: number;
  risk_level?: string;
  approval_decision?: string;

  // Task tracking
  task_id?: string;
  task_type?: string;

  // BrowserX-specific context
  current_url?: string;
  current_domain?: string;
  tab_id?: number;
}

/**
 * Configuration shape for hooks in settings (matches claudy's JSON format).
 * This will be added to IStoredConfig.
 */
export interface HooksConfig {
  [event: string]: HookMatcherEntry[];
}
```

### 2. HookMatcher (`src/core/hooks/HookMatcher.ts`)

Pattern matching for tool names and parameters, following claudy's matcher syntax.

```typescript
/**
 * Match a hook's matcher pattern against a tool name and parameters.
 *
 * Matcher syntax (from claudy):
 * - undefined / empty → matches everything
 * - "browser_dom" → exact tool name match
 * - "browser_dom|web_search" → pipe-separated alternatives
 * - "browser_dom(click)" → tool name + action parameter match
 * - "browser_dom(click|type)" → tool name + multiple action alternatives
 * - "*" → wildcard, matches anything
 *
 * The `if` condition field provides additional filtering using parameter patterns.
 * Format: "ToolName(paramValue)" — checked against tool_name + first string param.
 */
export class HookMatcher {
  /**
   * Check if a matcher pattern matches a given tool call.
   */
  static matches(
    pattern: string | undefined,
    toolName: string,
    parameters?: Record<string, unknown>
  ): boolean;

  /**
   * Check if an `if` condition matches the tool call.
   * Used for pre-execution filtering without spawning the hook process.
   */
  static matchesCondition(
    condition: string | undefined,
    toolName: string,
    parameters?: Record<string, unknown>
  ): boolean;

  /**
   * Parse a matcher pattern into structured form.
   * "browser_dom(click|type)" → { toolNames: ['browser_dom'], actions: ['click', 'type'] }
   */
  static parse(pattern: string): {
    toolNames: string[];
    actions: string[];
  };
}
```

**Implementation detail**: For BrowserX, the primary tool is `browser_dom` with an `action` parameter (click, type, keypress, scroll, etc.). The matcher must understand `browser_dom(click)` means "browser_dom tool where parameters.action === 'click'". This maps to how claudy matches `Bash(git *)` — tool name + first significant parameter.

### 3. HookRegistry (`src/core/hooks/HookRegistry.ts`)

Central registration, discovery, and lifecycle management.

```typescript
import { v4 as uuidv4 } from 'uuid';
import type {
  HookEvent, HookCommand, HookMatcherEntry, HookSource,
  RegisteredHook, HooksConfig,
} from './types';
import { HookMatcher } from './HookMatcher';

export class HookRegistry {
  /** All registered hooks, keyed by event type */
  private hooks: Map<HookEvent, RegisteredHook[]> = new Map();

  /**
   * Register a single hook for an event.
   * Returns the hook ID for later removal.
   */
  register(
    event: HookEvent,
    command: HookCommand,
    source: HookSource,
    matcher?: string
  ): string {
    const id = `hook_${uuidv4()}`;
    const entry: RegisteredHook = {
      id, event, matcher, command, source,
      registeredAt: Date.now(),
    };

    const existing = this.hooks.get(event) ?? [];
    existing.push(entry);
    this.hooks.set(event, existing);
    return id;
  }

  /**
   * Bulk register hooks from a HooksConfig object (settings.json format).
   */
  registerFromConfig(config: HooksConfig, source: HookSource): string[] {
    const ids: string[] = [];
    for (const [eventName, matcherEntries] of Object.entries(config)) {
      const event = eventName as HookEvent;
      for (const entry of matcherEntries) {
        for (const hookCmd of entry.hooks) {
          ids.push(this.register(event, hookCmd, source, entry.matcher));
        }
      }
    }
    return ids;
  }

  /**
   * Unregister a hook by ID.
   */
  unregister(hookId: string): boolean {
    for (const [event, hooks] of this.hooks.entries()) {
      const idx = hooks.findIndex(h => h.id === hookId);
      if (idx !== -1) {
        hooks.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Unregister all hooks from a specific source.
   * Used when reloading config or clearing session hooks.
   */
  unregisterBySource(source: HookSource): number {
    let count = 0;
    for (const [event, hooks] of this.hooks.entries()) {
      const before = hooks.length;
      const filtered = hooks.filter(h => h.source !== source);
      this.hooks.set(event, filtered);
      count += before - filtered.length;
    }
    return count;
  }

  /**
   * Get all hooks matching an event + tool context.
   * Applies matcher pattern filtering and `if` condition checking.
   * Returns hooks ordered by source priority (config > session > plugin).
   */
  getMatchingHooks(
    event: HookEvent,
    toolName?: string,
    parameters?: Record<string, unknown>
  ): RegisteredHook[] {
    const candidates = this.hooks.get(event) ?? [];
    return candidates.filter(hook => {
      // Check matcher pattern
      if (!HookMatcher.matches(hook.matcher, toolName ?? '', parameters)) {
        return false;
      }
      // Check `if` condition
      if (!HookMatcher.matchesCondition(hook.command.if, toolName ?? '', parameters)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Get all registered hooks (for diagnostics/UI).
   */
  getAllHooks(): Map<HookEvent, RegisteredHook[]> {
    return new Map(this.hooks);
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.hooks.clear();
  }
}
```

### 4. HookExecutor (`src/core/hooks/HookExecutor.ts`)

Executes individual hooks and returns structured results. Each hook type has its own execution path.

```typescript
import type { HookCommand, HookInput, HookResult, HookOutcome } from './types';

export class HookExecutor {
  /**
   * Execute a single hook command with the given input context.
   *
   * Command hooks: spawn child_process, pipe HookInput as JSON to stdin,
   *   read stdout/stderr, parse JSON output if present.
   * Prompt hooks: call ModelClientFactory to get a model, send prompt, parse response.
   * HTTP hooks: POST HookInput as JSON to url, parse response body.
   */
  async execute(
    hook: HookCommand,
    input: HookInput,
    signal?: AbortSignal
  ): Promise<HookResult>;

  /**
   * Execute a command-type hook.
   *
   * Implementation:
   * 1. Perform variable substitution on hook.command:
   *    - $TOOL_NAME → input.tool_name
   *    - $FILE_PATH → extracted from input.tool_input (for file-related tools)
   *    - $ARGUMENTS → JSON.stringify(input.tool_input)
   *    - $SESSION_ID → input.session_id
   *    - $CWD → input.cwd
   *    - $CURRENT_URL → input.current_url (BrowserX-specific)
   *    - $TAB_ID → input.tab_id (BrowserX-specific)
   * 2. Spawn child process (default: bash, or hook.shell)
   * 3. Pipe JSON-serialized HookInput to stdin
   * 4. Apply timeout (hook.timeout seconds, default 30s)
   * 5. Collect stdout/stderr
   * 6. Interpret exit code:
   *    - 0 → success
   *    - 1 → non_blocking_error (stderr shown to user, execution continues)
   *    - 2 → blocking_error (stderr shown to model, operation blocked)
   * 7. If stdout is valid JSON matching HookResponse schema, parse it
   *    Otherwise, treat as plain text (no structured response)
   *
   * NOTE: Command hooks only work in desktop/server mode.
   * In extension mode, command hooks are skipped with a warning.
   */
  private async executeCommand(
    hook: HookCommand,
    input: HookInput,
    signal?: AbortSignal
  ): Promise<HookResult>;

  /**
   * Execute a prompt-type hook.
   *
   * Implementation:
   * 1. Perform variable substitution on hook.prompt
   * 2. Resolve model: hook.model ?? cheapest configured model
   * 3. Build a single-turn prompt:
   *    System: "You are evaluating a hook for BrowserX. Respond with JSON: {continue, decision, stopReason}"
   *    User: substituted prompt + "\n\nContext:\n" + JSON.stringify(input)
   * 4. Call model via ModelClientFactory.getClient().complete()
   * 5. Parse response as JSON HookResponse
   * 6. Timeout: hook.timeout seconds, default 60s
   */
  private async executePrompt(
    hook: HookCommand,
    input: HookInput,
    signal?: AbortSignal
  ): Promise<HookResult>;

  /**
   * Execute an HTTP-type hook.
   *
   * Implementation:
   * 1. POST to hook.url with:
   *    - Body: JSON-serialized HookInput
   *    - Headers: hook.headers (with env var interpolation) + Content-Type: application/json
   * 2. Parse response body as JSON HookResponse
   * 3. Timeout: hook.timeout seconds, default 30s
   * 4. HTTP errors (4xx/5xx) → non_blocking_error
   * 5. Network errors → non_blocking_error
   *
   * NOTE: HTTP hooks only work in desktop/server mode.
   * In extension mode, they can work via fetch() but are restricted by CORS.
   */
  private async executeHttp(
    hook: HookCommand,
    input: HookInput,
    signal?: AbortSignal
  ): Promise<HookResult>;
}
```

**Platform considerations**: BrowserX runs in three environments:
- **Extension mode** (Chrome): No child_process access. Command hooks are unavailable. HTTP hooks work but are CORS-restricted. Prompt hooks work via the existing ModelClientFactory.
- **Desktop mode** (Tauri): Full child_process access via Tauri's shell API. All hook types work.
- **Server mode** (Node.js): Full child_process access. All hook types work.

The executor must detect the runtime environment and gracefully degrade:

```typescript
// In HookExecutor constructor or a utility:
const isExtensionMode = typeof chrome !== 'undefined' && chrome.runtime?.id;
const isDesktopMode = typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop';
const isServerMode = !isExtensionMode && !isDesktopMode;

// Command hooks in extension mode → skip with warning
if (hook.type === 'command' && isExtensionMode) {
  return {
    hookId, outcome: 'non_blocking_error',
    stderr: 'Command hooks are not available in extension mode',
    duration: 0,
  };
}
```

### 5. HookAggregator (`src/core/hooks/HookAggregator.ts`)

Merges results from multiple hooks fired for the same event.

```typescript
import type { HookResult, AggregatedHookResult } from './types';

export class HookAggregator {
  /**
   * Aggregate results from multiple hook executions.
   *
   * Rules (matching claudy):
   * - shouldContinue: ALL hooks must have continue !== false
   * - stopReason: first non-null from any hook
   * - updatedInput: last-writer-wins per key (hooks execute in parallel,
   *   so order is non-deterministic; documented as "last settled wins")
   * - permissionDecision: deny > block > approve > undefined
   *   (most restrictive wins, matching claudy's deny > ask > allow > passthrough)
   * - additionalContext: concatenated from all hooks
   * - systemMessages: concatenated from all hooks
   */
  static aggregate(results: HookResult[]): AggregatedHookResult {
    const aggregated: AggregatedHookResult = {
      shouldContinue: true,
      additionalContext: [],
      systemMessages: [],
      results,
      totalDuration: 0,
    };

    let mergedInput: Record<string, unknown> | undefined;

    for (const result of results) {
      // Track wall-clock time (parallel, so take max)
      aggregated.totalDuration = Math.max(aggregated.totalDuration, result.duration);

      // Blocking error or explicit continue=false → stop
      if (result.outcome === 'blocking_error' || result.continue === false) {
        aggregated.shouldContinue = false;
        if (result.stopReason && !aggregated.stopReason) {
          aggregated.stopReason = result.stopReason;
        }
      }

      // Permission decision: most restrictive wins
      if (result.decision) {
        if (result.decision === 'block') {
          aggregated.permissionDecision = 'block';
        } else if (result.decision === 'approve' && aggregated.permissionDecision !== 'block') {
          aggregated.permissionDecision = 'approve';
        }
      }

      // Merge updatedInput (last-writer-wins per key)
      if (result.updatedInput) {
        mergedInput = { ...mergedInput, ...result.updatedInput };
      }

      // Merge updatedOutput (last wins entirely)
      if (result.updatedOutput !== undefined) {
        aggregated.updatedOutput = result.updatedOutput;
      }

      // Collect context and messages
      if (result.additionalContext) {
        aggregated.additionalContext.push(result.additionalContext);
      }
      if (result.systemMessage) {
        aggregated.systemMessages.push(result.systemMessage);
      }
    }

    if (mergedInput) {
      aggregated.updatedInput = mergedInput;
    }

    return aggregated;
  }
}
```

### 6. Integration Point: ToolRegistry.execute() (`src/tools/ToolRegistry.ts`)

The most critical integration. Hook execution wraps the existing tool pipeline.

**Current flow** (`ToolRegistry.execute()` at line 236):
```
1. Tool lookup (line 239-249)
2. Validate parameters (line 252-264)
3. ApprovalGate.check() (line 267-310)
4. Emit ToolExecutionStart event (line 312-324)
5. Execute handler with timeout (line 337-374)
6. Emit ToolExecutionEnd event (line 377-388)
```

**New flow with hooks:**
```
1. Tool lookup + validation (existing, unchanged)
2. ── NEW: Build HookInput for PreToolUse ──
3. ── NEW: Fire PreToolUse hooks (parallel) ──
   - If any hook returns continue=false → return early with HOOK_BLOCKED error
   - If hooks return updatedInput → merge into request.parameters
4. ApprovalGate.check() (existing, uses potentially modified parameters)
   - ── NEW: On 'ask_user' decision → fire PermissionRequest hooks ──
     - If hook returns decision='approve' → skip user prompt, auto_approve
     - If hook returns decision='block' → deny without user prompt
   - ── NEW: On 'deny' decision → fire PermissionDenied hooks ──
5. Emit ToolExecutionStart event (existing)
6. Execute handler with timeout (existing)
7. ── NEW: On success → fire PostToolUse hooks (parallel) ──
   - If hooks return updatedOutput → modify the result before returning
8. ── NEW: On failure → fire PostToolUseFailure hooks (parallel) ──
   - PostToolUseFailure fires BEFORE the error is returned to caller
9. Emit ToolExecutionEnd/Error event (existing)
```

**Concrete code change to `ToolRegistry.execute()`:**

```typescript
// New field on ToolRegistry:
private hookRegistry?: HookRegistry;
private hookExecutor?: HookExecutor;

setHookSystem(registry: HookRegistry, executor: HookExecutor): void {
  this.hookRegistry = registry;
  this.hookExecutor = executor;
}

// Inside execute(), after validation (line 264) and before approval gate (line 267):

// ── PreToolUse hooks ──
if (this.hookRegistry && this.hookExecutor) {
  const hookInput: HookInput = {
    hook_event_name: 'PreToolUse',
    session_id: request.sessionId,
    tool_name: request.toolName,
    tool_input: request.parameters,
    current_url: request.metadata?.currentUrl as string | undefined,
    current_domain: request.metadata?.currentDomain as string | undefined,
    tab_id: request.tabId,
  };

  const matchingHooks = this.hookRegistry.getMatchingHooks(
    'PreToolUse', request.toolName, request.parameters
  );

  if (matchingHooks.length > 0) {
    const results = await Promise.all(
      matchingHooks.map(hook => this.hookExecutor!.execute(hook.command, hookInput))
    );

    // Remove once-hooks that fired
    for (let i = 0; i < matchingHooks.length; i++) {
      if (matchingHooks[i].command.once) {
        this.hookRegistry.unregister(matchingHooks[i].id);
      }
    }

    const aggregated = HookAggregator.aggregate(results);

    if (!aggregated.shouldContinue) {
      return {
        success: false,
        error: {
          code: 'HOOK_BLOCKED',
          message: aggregated.stopReason ?? `PreToolUse hook blocked ${request.toolName}`,
        },
        duration: Date.now() - startTime,
      };
    }

    // Apply input modifications
    if (aggregated.updatedInput) {
      request = { ...request, parameters: { ...request.parameters, ...aggregated.updatedInput } };
    }
  }
}

// ... existing approval gate code ...

// After successful tool execution (line 388), before return:

// ── PostToolUse hooks ──
if (this.hookRegistry && this.hookExecutor) {
  const postHookInput: HookInput = {
    hook_event_name: 'PostToolUse',
    session_id: request.sessionId,
    tool_name: request.toolName,
    tool_input: request.parameters,
    tool_output: result,
    current_url: request.metadata?.currentUrl as string | undefined,
    current_domain: request.metadata?.currentDomain as string | undefined,
    tab_id: request.tabId,
  };

  const postHooks = this.hookRegistry.getMatchingHooks(
    'PostToolUse', request.toolName, request.parameters
  );

  if (postHooks.length > 0) {
    const postResults = await Promise.all(
      postHooks.map(hook => this.hookExecutor!.execute(hook.command, postHookInput))
    );

    for (let i = 0; i < postHooks.length; i++) {
      if (postHooks[i].command.once) {
        this.hookRegistry.unregister(postHooks[i].id);
      }
    }

    const postAggregated = HookAggregator.aggregate(postResults);

    // Apply output modifications
    if (postAggregated.updatedOutput !== undefined) {
      result = postAggregated.updatedOutput;
    }
  }
}
```

### 7. Integration Point: TurnManager.executeToolCall() (`src/core/TurnManager.ts:630`)

The `TurnManager` is the **actual** call site where tool calls happen during a conversation turn. The `ToolRegistry.execute()` integration above covers registry-based tools, but `TurnManager.executeToolCall()` also handles:
- `web_search` (bypasses ToolRegistry entirely, line 645-647)
- MCP tools (via `McpToolHandler`, lines 650-670)

For consistent hook coverage, `TurnManager.executeToolCall()` needs a hook wrapper too:

```typescript
// In TurnManager, add hookRegistry + hookExecutor refs (injected via constructor or setter)
// Wrap the entire executeToolCall() method:

private async executeToolCall(toolName: string, parameters: any, callId: string): Promise<any> {
  let parsedParams = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;

  // ── PreToolUse hooks at TurnManager level ──
  // This catches web_search and MCP tools that bypass ToolRegistry
  if (this.hookRegistry) {
    const hookInput: HookInput = {
      hook_event_name: 'PreToolUse',
      session_id: this.session.sessionId,
      tool_name: toolName,
      tool_input: parsedParams,
    };
    const hooks = this.hookRegistry.getMatchingHooks('PreToolUse', toolName, parsedParams);
    if (hooks.length > 0) {
      const results = await Promise.all(
        hooks.map(h => this.hookExecutor!.execute(h.command, hookInput))
      );
      const agg = HookAggregator.aggregate(results);
      if (!agg.shouldContinue) {
        return {
          type: 'function_call_output',
          call_id: callId,
          output: `Hook blocked: ${agg.stopReason ?? 'PreToolUse hook denied this tool call'}`,
        };
      }
      if (agg.updatedInput) {
        parsedParams = { ...parsedParams, ...agg.updatedInput };
      }
    }
  }

  // ... existing switch/case dispatch ...
  // ... existing error handling ...

  // ── PostToolUse hooks at TurnManager level ──
  // (fire after successful result, before returning function_call_output)
}
```

**Important**: To avoid double-firing hooks (once in TurnManager, once in ToolRegistry), we need a convention:
- `ToolRegistry.execute()` fires hooks for **registry-based tools** (browser_dom, terminal, etc.)
- `TurnManager.executeToolCall()` fires hooks for **non-registry tools** (web_search, MCP tools)
- The `HookInput` includes a `source` field so hooks can distinguish if needed

OR (simpler): Only fire hooks at the `TurnManager` level, remove hook logic from `ToolRegistry`. This is the recommended approach because:
1. TurnManager is the single funnel for ALL tool calls
2. Avoids double-fire complexity
3. Matches claudy's pattern where hooks fire at the orchestration layer, not the tool layer

**Recommendation**: Wire hooks into `TurnManager.executeToolCall()` only. Remove hook logic from `ToolRegistry.execute()` (keep the design for reference but don't implement it there).

### 8. Integration Point: RepublicAgent Lifecycle

**SessionStart** — fire during `RepublicAgent.initialize()` (`RepublicAgent.ts:90`):

```typescript
async initialize(): Promise<void> {
  // ... existing initialization code (lines 90-153) ...

  // ── NEW: Fire SessionStart hooks ──
  if (this.hookRegistry) {
    const hookInput: HookInput = {
      hook_event_name: 'SessionStart',
      session_id: this.session.sessionId,
      session_start_source: 'startup',  // or 'resume' for resumed sessions
    };
    const hooks = this.hookRegistry.getMatchingHooks('SessionStart');
    if (hooks.length > 0) {
      // SessionStart hooks run in parallel, non-blocking (errors logged, not thrown)
      const results = await Promise.allSettled(
        hooks.map(h => this.hookExecutor.execute(h.command, hookInput))
      );
      // Log any hook failures but don't block initialization
      for (const r of results) {
        if (r.status === 'rejected') {
          console.warn('[RepublicAgent] SessionStart hook failed:', r.reason);
        }
      }
    }
  }

  console.log('[RepublicAgent] DEBUG: initialize() complete');
}
```

**SessionEnd** — fire during `RepublicAgent.handleShutdown()` (`RepublicAgent.ts:970`):

```typescript
private async handleShutdown(): Promise<void> {
  // ── NEW: Fire SessionEnd hooks (with short timeout) ──
  if (this.hookRegistry) {
    const hookInput: HookInput = {
      hook_event_name: 'SessionEnd',
      session_id: this.session.sessionId,
      session_end_reason: 'shutdown',
    };
    const hooks = this.hookRegistry.getMatchingHooks('SessionEnd');
    if (hooks.length > 0) {
      // SessionEnd hooks get a short timeout (1.5s, matching claudy)
      const shortTimeoutSignal = AbortSignal.timeout(1500);
      await Promise.allSettled(
        hooks.map(h => this.hookExecutor.execute(
          { ...h.command, timeout: Math.min(h.command.timeout ?? 30, 1.5) },
          hookInput,
          shortTimeoutSignal
        ))
      );
    }
  }

  // Existing cleanup
  this.submissionQueue = [];
  this.eventQueue = [];
  this.emitEvent({ type: 'ShutdownComplete' });
}
```

**UserPromptSubmit** — fire in `RepublicAgent.handleSubmission()` (`RepublicAgent.ts:344`) for UserInput/UserTurn ops:

```typescript
private async handleSubmission(submission: Submission): Promise<void> {
  try {
    switch (submission.op.type) {
      case 'UserInput':
      case 'UserTurn': {
        // ── NEW: Fire UserPromptSubmit hooks ──
        if (this.hookRegistry) {
          const items = submission.op.items;
          const textContent = items
            .filter(i => i.type === 'input_text')
            .map(i => (i as any).text)
            .join('\n');

          const hookInput: HookInput = {
            hook_event_name: 'UserPromptSubmit',
            session_id: this.session.sessionId,
            user_prompt: textContent,
          };
          const hooks = this.hookRegistry.getMatchingHooks('UserPromptSubmit');
          if (hooks.length > 0) {
            const results = await Promise.all(
              hooks.map(h => this.hookExecutor.execute(h.command, hookInput))
            );
            const agg = HookAggregator.aggregate(results);

            // Exit code 2 in claudy: block processing, erase prompt, show stderr to user
            if (!agg.shouldContinue) {
              this.emitEvent({
                type: 'Error',
                data: {
                  message: agg.stopReason ?? 'UserPromptSubmit hook blocked this input',
                },
              });
              return; // Don't process this submission
            }
          }
        }

        // Existing dispatch
        if (submission.op.type === 'UserInput') {
          await this.handleUserInput(submission.op, submission.context);
        } else {
          await this.handleUserTurn(submission.op, submission.context);
        }
        break;
      }
      // ... rest of switch cases unchanged
    }
  }
}
```

### 9. Integration Point: ApprovalGate (`src/core/approval/ApprovalGate.ts`)

**PermissionRequest** — fire when `ApprovalGate.check()` decides `ask_user` (line 194):

```typescript
// In ApprovalGate, add hook support:
private hookRegistry?: HookRegistry;
private hookExecutor?: HookExecutor;

setHookSystem(registry: HookRegistry, executor: HookExecutor): void {
  this.hookRegistry = registry;
  this.hookExecutor = executor;
}

// Inside check(), before calling approvalManager.requestApproval() (line 219):

if (decision === 'ask_user') {
  // ── NEW: Fire PermissionRequest hooks ──
  if (this.hookRegistry && this.hookExecutor) {
    const hookInput: HookInput = {
      hook_event_name: 'PermissionRequest',
      session_id: fullContext.sessionId ?? '',
      tool_name: toolName,
      tool_input: parameters,
      risk_score: assessment.score,
      risk_level: assessment.level,
      current_domain: domain,
    };
    const hooks = this.hookRegistry.getMatchingHooks('PermissionRequest', toolName, parameters);
    if (hooks.length > 0) {
      const results = await Promise.all(
        hooks.map(h => this.hookExecutor!.execute(h.command, hookInput))
      );
      const agg = HookAggregator.aggregate(results);

      // Hook can auto-approve or auto-deny without prompting user
      if (agg.permissionDecision === 'approve') {
        await this.recordHistory(toolName, assessment.score, assessment.level, 'auto_approve', 'auto', ['Approved by hook']);
        return 'auto_approve';
      }
      if (agg.permissionDecision === 'block') {
        await this.recordHistory(toolName, assessment.score, assessment.level, 'deny', 'auto', ['Blocked by hook']);
        return 'deny';
      }
    }
  }

  // Existing: delegate to ApprovalManager (user prompt)
  const approvalRequest: ApprovalRequest = { ... };
  const response = await this.approvalManager.requestApproval(approvalRequest);
  // ...
}
```

**PermissionDenied** — fire after a deny decision (lines 109, 149, 226):
```typescript
// Add a helper method that fires PermissionDenied hooks:
private async firePermissionDeniedHooks(
  toolName: string,
  parameters: Record<string, any>,
  reason: string
): Promise<void> {
  if (!this.hookRegistry || !this.hookExecutor) return;

  const hookInput: HookInput = {
    hook_event_name: 'PermissionDenied',
    tool_name: toolName,
    tool_input: parameters,
    approval_decision: 'deny',
    session_id: '', // filled from context
  };
  const hooks = this.hookRegistry.getMatchingHooks('PermissionDenied', toolName, parameters);
  if (hooks.length > 0) {
    // Fire-and-forget: PermissionDenied hooks are informational
    Promise.allSettled(hooks.map(h => this.hookExecutor!.execute(h.command, hookInput)));
  }
}
```

### 10. Integration Point: Session.spawnTask() for TaskCreated/TaskCompleted

**TaskCreated** — fire in `Session.spawnTask()` (`Session.ts:1316`) after creating the task:

```typescript
async spawnTask(task: SessionTask, context: TurnContext, subId: string, input: InputItem[]): Promise<void> {
  // Existing: abort existing tasks, create AbortController, etc.
  // ...

  // ── NEW: Fire TaskCreated hooks ──
  if (this.hookRegistry) {
    const hookInput: HookInput = {
      hook_event_name: 'TaskCreated',
      session_id: this.sessionId,
      task_id: subId,
      task_type: task.constructor.name,
    };
    const hooks = this.hookRegistry.getMatchingHooks('TaskCreated');
    // Fire-and-forget
    if (hooks.length > 0) {
      Promise.allSettled(hooks.map(h => this.hookExecutor.execute(h.command, hookInput)));
    }
  }

  // Existing: create promise wrapper, execute task...
}
```

**TaskCompleted** — fire when the task promise resolves (inside the promise wrapper in `spawnTask()`):

```typescript
const promise = (async (): Promise<string | null> => {
  try {
    // Execute task (existing)
    const result = await task.run(/* ... */);

    // ── NEW: Fire TaskCompleted hooks ──
    if (this.hookRegistry) {
      const hookInput: HookInput = {
        hook_event_name: 'TaskCompleted',
        session_id: this.sessionId,
        task_id: subId,
        task_type: task.constructor.name,
      };
      const hooks = this.hookRegistry.getMatchingHooks('TaskCompleted');
      if (hooks.length > 0) {
        Promise.allSettled(hooks.map(h => this.hookExecutor.execute(h.command, hookInput)));
      }
    }

    return result;
  } catch (error) {
    // ... existing error handling
  }
})();
```

### 11. Configuration Integration

Add hooks to `IStoredConfig` (`src/config/types.ts`):

```typescript
export interface IStoredConfig {
  // ... existing fields ...

  /** Hook configuration */
  hooks?: import('../core/hooks/types').HooksConfig;
}
```

Add hooks section to `IConfigChangeEvent`:

```typescript
export interface IConfigChangeEvent {
  type: 'config-changed';
  section: 'model' | 'provider' | 'profile' | 'preferences' | 'cache' | 'extension' | 'security' | 'approval' | 'hooks';
  // ...
}
```

**ConfigHookLoader** (`src/core/hooks/loaders/ConfigHookLoader.ts`):

```typescript
import type { AgentConfig } from '../../../config/AgentConfig';
import type { HookRegistry } from '../HookRegistry';
import type { HooksConfig } from '../types';

export class ConfigHookLoader {
  /**
   * Load hooks from AgentConfig and register them.
   * Called during RepublicAgent.initialize() and on config-changed events.
   */
  static load(config: AgentConfig, registry: HookRegistry): void {
    // Clear existing config-sourced hooks
    registry.unregisterBySource('config');

    // Load from stored config
    const storedConfig = config.getStoredConfig();
    if (storedConfig.hooks) {
      registry.registerFromConfig(storedConfig.hooks, 'config');
    }
  }

  /**
   * Subscribe to config changes and reload hooks when the 'hooks' section changes.
   */
  static watch(config: AgentConfig, registry: HookRegistry): void {
    config.on('config-changed', (event) => {
      if (event.section === 'hooks') {
        ConfigHookLoader.load(config, registry);
      }
    });
  }
}
```

### 12. Initialization Wiring in RepublicAgent

Add hook system initialization to `RepublicAgent` constructor:

```typescript
export class RepublicAgent {
  // ... existing fields ...
  private hookRegistry: HookRegistry;
  private hookExecutor: HookExecutor;

  constructor(config: AgentConfig, initialHistory?: InitialHistory, agentId?: string, userNotifier?: IUserNotifier) {
    // ... existing constructor code ...

    // Initialize hook system
    this.hookRegistry = new HookRegistry();
    this.hookExecutor = new HookExecutor();

    // Wire hook system into tool registry
    this.toolRegistry.setHookSystem(this.hookRegistry, this.hookExecutor);

    // Wire hook system into approval gate (after approval gate is created)
    // Note: ApprovalGate is created inside ApprovalManager or set on ToolRegistry
    // This wiring happens after the approval pipeline is assembled.
  }

  async initialize(): Promise<void> {
    // ... existing initialization ...

    // Load hooks from config
    ConfigHookLoader.load(this.config, this.hookRegistry);
    ConfigHookLoader.watch(this.config, this.hookRegistry);

    // Wire hooks into session (for TaskCreated/TaskCompleted)
    this.session.setHookSystem(this.hookRegistry, this.hookExecutor);

    // Fire SessionStart hooks
    // ... (as described in section 8)
  }
}
```

### 13. Recursion Guard

Hooks that trigger tool calls (e.g., a PostToolUse hook that calls another tool) could create infinite loops. Add a depth counter:

```typescript
// In HookExecutor:
private static executionDepth = 0;
private static readonly MAX_DEPTH = 3;

async execute(hook: HookCommand, input: HookInput, signal?: AbortSignal): Promise<HookResult> {
  if (HookExecutor.executionDepth >= HookExecutor.MAX_DEPTH) {
    return {
      hookId: 'depth_exceeded',
      outcome: 'non_blocking_error',
      stderr: `Hook recursion depth exceeded (max ${HookExecutor.MAX_DEPTH})`,
      duration: 0,
    };
  }

  HookExecutor.executionDepth++;
  try {
    // ... actual execution ...
  } finally {
    HookExecutor.executionDepth--;
  }
}
```

### 14. Async Hook Support

For hooks marked `async: true`, execute without blocking the main flow:

```typescript
// In the hook firing logic (e.g., inside ToolRegistry or TurnManager):
const syncHooks = matchingHooks.filter(h => !h.command.async);
const asyncHooks = matchingHooks.filter(h => h.command.async);

// Execute sync hooks and wait for results
const syncResults = await Promise.all(
  syncHooks.map(h => this.hookExecutor.execute(h.command, hookInput))
);
const aggregated = HookAggregator.aggregate(syncResults);

// Fire async hooks in background (no await)
if (asyncHooks.length > 0) {
  for (const hook of asyncHooks) {
    this.hookExecutor.execute(hook.command, hookInput).catch(err => {
      console.warn(`[HookSystem] Async hook ${hook.id} failed:`, err);
    });
  }
}
```

---

## Event Protocol Reconciliation

BrowserX already has structured event emission through `Session`/`TurnManager` using `EventMsg` types. The hook system should **not** replace this protocol but should integrate with it:

- **Hook events** (PreToolUse, PostToolUse, etc.) are interceptors that can modify behavior — they are NOT the same as observation events
- **EventMsg events** (existing) are notifications for UI and persistence — they are downstream consumers
- **Ordering**: Hook execution → EventMsg emission. A hook that blocks a tool call should also suppress the corresponding `ToolExecutionStart`/`ToolExecutionEnd` EventMsg.
- **Future EventBus migration** (Phase 4): When converting to pub/sub, existing `EventMsg` consumers become subscribers. Hook handlers remain a separate mechanism (middleware, not pub/sub) because they can modify/block execution.

### New EventMsg Types for Hook Observability

Add hook-specific event types to `src/core/protocol/events.ts`:

```typescript
// Add to EventMsg union:
| { type: 'HookFired'; data: HookFiredEvent }
| { type: 'HookResult'; data: HookResultEvent }
| { type: 'HookBlocked'; data: HookBlockedEvent }

export interface HookFiredEvent {
  hook_event_name: string;
  hook_id: string;
  hook_type: string;      // 'command' | 'prompt' | 'http'
  tool_name?: string;
  matcher?: string;
}

export interface HookResultEvent {
  hook_id: string;
  outcome: string;
  duration: number;
  exit_code?: number;
}

export interface HookBlockedEvent {
  hook_event_name: string;
  tool_name?: string;
  stop_reason?: string;
  hook_id: string;
}
```

---

## Phase Plan

**Phase 1: Core Infrastructure** (Week 1-2)
- Define types in `src/core/hooks/types.ts` (HookEvent, HookCommand, HookResponse, HookInput, AggregatedHookResult)
- Implement `HookMatcher.ts` with tool name + parameter pattern matching
- Implement `HookRegistry.ts` with register/unregister/query, source management
- Implement `HookExecutor.ts` for command type only (shell execution with exit code semantics)
- Implement `HookAggregator.ts` for multi-hook result merging
- Wire PreToolUse and PostToolUse into `TurnManager.executeToolCall()`
- Wire SessionStart into `RepublicAgent.initialize()`
- Wire SessionEnd into `RepublicAgent.handleShutdown()`
- Add recursion guard (depth limit = 3)
- Unit tests: HookMatcher pattern parsing, HookAggregator merge rules, HookExecutor command execution
- Integration test: PreToolUse hook blocks tool execution, PostToolUse hook modifies output

**Phase 2: Hook Types & Async** (Week 3)
- Add prompt hook type in HookExecutor (LLM evaluation via ModelClientFactory)
- Add HTTP hook type in HookExecutor (POST with JSON body)
- Add `async: true` flag support (fire-and-forget execution)
- Add `once: true` flag support (auto-unregister after first execution)
- Add timeout handling with configurable defaults (30s command, 60s prompt, 30s HTTP)
- Add error isolation: hook failure logs warning but doesn't block execution
- Platform detection: graceful degradation for extension mode (no command hooks)

**Phase 3: Configuration & Input Modification** (Week 4)
- Add `hooks` field to `IStoredConfig` in `src/config/types.ts`
- Implement `ConfigHookLoader.ts`: load hooks from config at startup, watch for changes
- Wire UserPromptSubmit into `RepublicAgent.handleSubmission()`
- Wire PermissionRequest/PermissionDenied into `ApprovalGate.check()`
- Wire TaskCreated/TaskCompleted into `Session.spawnTask()`
- Add `updatedInput` support: PreToolUse hooks can modify tool parameters
- Add `$TOOL_NAME`, `$FILE_PATH`, `$ARGUMENTS`, `$CURRENT_URL`, `$TAB_ID` variable substitution
- Tests for hook-based input modification and permission decisions
- Add hook observability events (HookFired, HookResult, HookBlocked) to EventMsg

**Phase 4: Event Subscriber Pattern** (Week 5)
- Create `EventBus.ts` with subscribe/unsubscribe/emit
- Migrate existing event dispatcher callbacks to EventBus
- Add event filtering (subscribe to specific event types only)
- Add event correlation: link related events with correlation ID
- Add event history buffer (last N events for debugging)
- Wire hooks as EventBus subscribers (unify hook and event systems)

## Priority Events for BrowserX

Given BrowserX is a browser automation agent, these events matter most:

| Event | Use Case | Integration Point |
|-------|----------|-------------------|
| `PreToolUse` | Validate DOM actions, inject safety checks before click/type | `TurnManager.executeToolCall()` |
| `PostToolUse` | Screenshot after navigation, log DOM mutations | `TurnManager.executeToolCall()` |
| `PostToolUseFailure` | Retry logic, fallback strategies | `TurnManager.executeToolCall()` |
| `PermissionRequest` | Custom approval logic for sensitive domains | `ApprovalGate.check()` |
| `PermissionDenied` | Audit logging for denied actions | `ApprovalGate.check()` |
| `SessionStart` | Load user preferences, initialize browser state | `RepublicAgent.initialize()` |
| `SessionEnd` | Cleanup tabs, persist session state | `RepublicAgent.handleShutdown()` |
| `UserPromptSubmit` | Input validation, prompt enhancement | `RepublicAgent.handleSubmission()` |
| `TaskCreated` | Task tracking, progress UI | `Session.spawnTask()` |
| `TaskCompleted` | Task completion logging | `Session.spawnTask()` promise resolution |

## Risks

- **Performance**: Hook execution adds latency to every tool call. Mitigate with async hooks, fast matcher (no regex compilation per call), and short-circuit when no hooks registered.
- **Error handling**: Hook failures must not crash the main execution. All hook execution paths use try-catch. Blocking errors (exit code 2) are the only way hooks can stop execution; all other errors are non-blocking.
- **Circular hooks**: PreToolUse hook that triggers another tool call. Mitigate with recursion depth limit (MAX_DEPTH = 3).
- **Platform compatibility**: Command hooks don't work in extension mode (no child_process). HTTP hooks are CORS-restricted in extension mode. Prompt hooks work everywhere. Platform detection must be robust.
- **Double-firing**: If hooks are wired at both TurnManager and ToolRegistry levels, they fire twice. Recommendation: wire at TurnManager level only (single funnel for all tool calls).
- **Async hook ordering**: Parallel execution means hook result ordering is non-deterministic. `updatedInput` merge uses last-writer-wins which may surprise users. Document this clearly.
- **Config hot-reload**: When hooks config changes mid-session, existing hooks are replaced atomically. Running hooks are not aborted — they complete but their results may be stale.
