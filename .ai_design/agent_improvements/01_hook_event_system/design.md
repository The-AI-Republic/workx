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

The full set, sourced from `entrypoints/sdk/coreTypes.ts`:

```typescript
type HookEvent =
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart' | 'SessionEnd'
  | 'Stop' | 'StopFailure'
  | 'SubagentStart' | 'SubagentStop'
  | 'PreCompact' | 'PostCompact'
  | 'PermissionRequest' | 'PermissionDenied'
  | 'Setup' | 'TeammateIdle'
  | 'TaskCreated' | 'TaskCompleted'
  | 'Elicitation' | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate' | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged' | 'FileChanged'
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
│  ├─ Collect from all sources (user settings, project settings, local settings, plugins, built-in)
│  │   NOTE: claudy `utils/hooks.ts:getHooksConfig()` *concatenates* all sources.
│  │   There is no override-by-source semantic — every matching hook from every
│  │   source fires in parallel. Earlier doc revisions described this as a
│  │   priority/override chain; that is incorrect.
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
│  ├─ Individual per-hook timeout (default 10min for tools, 1.5s for SessionEnd —
│  │   SessionEnd is special-cased and capped together; configurable via
│  │   `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`)
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

**Async hook response shape** — when a hook returns `{"async": true, "asyncTimeout": <ms>}`, claudy's executor immediately yields a placeholder result, registers the still-running hook in `AsyncHookRegistry`, and re-enters via `emitHookResponse()` once the underlying shell command (or HTTP request) settles. This re-entry pattern lets long-running hooks avoid blocking tool dispatch while still feeding their final stdout/exit-code back into the same hook pipeline.

### Claudy Hook Registration Architecture

**Hook sources (concatenated, not prioritized):**

> **Correction:** Earlier revisions of this doc described user > project > local > plugins > built-in as a priority/override chain. That is wrong. Claudy's `utils/hooks.ts:getHooksConfig()` *concatenates* hooks from every source; all matching hooks from all sources fire in parallel for the event. There is no override-by-source semantic. Per-hook merge precedence applies only to permission decisions and `updatedInput`.

1. User settings (`~/.claude/settings.json`) — user-scoped
2. Project settings (`.claude/settings.json`) — repo-scoped
3. Local settings (`.claude/settings.local.json`) — gitignored
4. Plugin hooks — from plugin manifests
5. Session hooks — in-memory, temporary (function callbacks)
6. Built-in hooks — internal SDK callbacks

**Session hooks** (`src/utils/hooks/sessionHooks.ts`) use Map-based storage (not Record) for identity preservation, supporting:
- `addSessionHook()` — register command/prompt/agent/http hooks at runtime
- `addFunctionHook()` — register TypeScript callback hooks (session-scoped only)
- `removeFunctionHook()` / `removeSessionHook()` — cleanup by ID
- `OnHookSuccess` callbacks — react to hook completion

**Function hooks (in-process callbacks)**

Beyond the four serializable hook command types, claudy supports raw TypeScript callback hooks registered through `addFunctionHook()`. Key properties:

- Signature: `(messages: Message[], signal?: AbortSignal) => boolean | Promise<boolean>`
- Session-scoped only — never persisted to settings, never loaded from plugins
- Stored in a `Map` (not a `Record`) so callback identity is preserved across registrations and `removeFunctionHook()` calls can target a specific function reference
- Primary use case is structured-output validation inside the SDK, where the host needs synchronous in-process access to the live message list rather than a stdin/HTTP boundary

**Plugin hooks** (`src/utils/plugins/loadPluginHooks.ts`):
- Plugins define hooks in manifest via `hooksConfig` field
- Hot-reload support: subscribes to policySettings changes, reloads on plugin toggle
- Plugin context substitution: plugin-loaded hook commands and HTTP URLs/headers can reference `${CLAUDE_PLUGIN_ROOT}` (the plugin install dir), `${CLAUDE_PLUGIN_DATA}` (per-plugin data dir), and `${user_config.X}` (resolved from the plugin's user-config schema). Substitution happens at hook-execution time, not at registration, so user-config edits take effect on the next firing without re-registering the hook.

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

### Claudy HTTP Hook Security

**File:** `utils/hooks/execHttpHook.ts`

HTTP hooks have a hardened execution path that the design must mirror if BrowserX ever loads HTTP hooks from anywhere outside trusted local config:

- **URL allowlist**: every target URL is checked against `allowedHttpHookUrls` (settings + plugin-declared) before the request goes out. Unlisted URLs are rejected before any DNS lookup.
- **Header env-var allowlist**: `$VAR` interpolation inside `headers` only resolves variables that appear in an explicit allowlist; arbitrary process env is not exposed via headers.
- **CRLF sanitization**: header values are stripped of `\r` / `\n` so a malicious value cannot inject extra headers or split the request.
- **Sandbox proxy routing**: when running under the workspace sandbox, requests are routed through the sandbox proxy rather than the agent's own network stack, so HTTP hooks inherit the same egress policy as user-tool network access.

### Claudy Permission Gates Around Hook Execution

Hooks are gated by trust and global-disable checks before any matching/dispatch happens, via `shouldSkipHookDueToTrust` and the `CLAUDE_CODE_SIMPLE` env var:

- **Workspace trust dialog gate**: in interactive mode, hooks are skipped until the user has accepted the workspace trust dialog for the current cwd. Untrusted workspaces silently no-op all hooks.
- **`CLAUDE_CODE_SIMPLE` global disable**: setting this env var disables *all* hooks globally regardless of source — useful for debugging and for environments that must run with no extension behavior.
- **Non-interactive (SDK) implicit trust**: when claudy is embedded via the SDK with no interactive surface, trust is implicit; the trust gate is bypassed but `CLAUDE_CODE_SIMPLE` still applies.

### Claudy Hook Telemetry

Each hook execution emits:

- A `tengu_run_hook` analytics event with hook type, event name, source, and outcome
- An OpenTelemetry span pair via `startHookSpan()` / `endHookSpan()`, scoped per hook so parallel hooks each get their own span

These two layers are independent: analytics fires even when OTEL is unconfigured, and OTEL spans capture timing/attributes for downstream APM tooling without depending on the analytics pipeline.

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
├── HookDispatcher.ts        # Match + execute + aggregate + observability orchestration
└── loaders/
    ├── ConfigHookLoader.ts  # Load hooks from AgentConfig / IStoredConfig
    └── SessionHookStore.ts  # In-memory session-scoped hook storage
```

### BrowserX-Specific Implementation Decisions

Claudy's model is useful, but BrowserX needs a different ownership split because its execution graph is different.

**Hook firing ownership**

| Hook Event | Owner | Why |
|-----------|-------|-----|
| `SessionStart`, `SessionEnd`, `UserPromptSubmit` | `RepublicAgent` | These are session/submission lifecycle concerns |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `TurnManager` | `TurnManager.executeToolCall()` is the only funnel that sees registry tools, `web_search`, and MCP tools together |
| `PermissionRequest`, `PermissionDenied` | `ApprovalGate` | Approval decisions already centralize risk scoring, policy rules, session memory, and user prompting |
| `TaskCreated`, `TaskCompleted` | `Session` | Task lifecycle lives in `Session.spawnTask()` |
| `PreCompact`, `PostCompact` | compaction call sites | Compaction is not a tool operation |

**Non-goal for Phase 1**

- Do not fire tool lifecycle hooks inside `ToolRegistry.execute()`. That would miss `web_search` and MCP, and it would overlap with `TurnManager.executeBrowserTool()` which already wraps registry execution and emits its own tool events.
- Do not turn hooks into a replacement for `EventMsg`. Hooks are control-plane middleware; `EventMsg` remains the observation plane.

**Runtime-specific execution**

| Runtime | Command hooks | Prompt hooks | HTTP hooks |
|--------|---------------|--------------|------------|
| Extension | Unsupported | Supported | Supported subject to extension fetch/CORS rules |
| Desktop | Supported via Tauri invoke/Rust backend | Supported | Supported |
| Server | Supported via Node process APIs | Supported | Supported |

This is important for implementation: BrowserX desktop is a Tauri app, so the design should not assume desktop can just call Node `child_process.spawn`. Desktop command hooks need the same runtime class as the existing terminal tool and Tauri terminal commands.

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

**Platform considerations**: BrowserX runs in three environments and the command execution path differs by runtime:
- **Extension mode**: command hooks are unsupported and should return a structured non-blocking result. Prompt hooks work through the existing model stack. HTTP hooks work subject to extension fetch/CORS rules.
- **Desktop mode**: command hooks must execute through a Tauri invoke/Rust backend path, analogous to the existing desktop terminal tool.
- **Server mode**: command hooks can execute through normal Node process APIs.

The executor should branch using BrowserX's existing build-mode split instead of browser sniffing:

```typescript
const buildMode =
  typeof __BUILD_MODE__ !== 'undefined' ? __BUILD_MODE__ : 'extension';

if (hook.type === 'command' && buildMode === 'extension') {
  return {
    hookId,
    outcome: 'non_blocking_error',
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
   * - updatedInput: last-writer-wins per key. Because hooks execute in parallel,
   *   completion order is non-deterministic — when two hooks rewrite the same
   *   key the surviving value depends on which hook's promise settles last.
   *   Document this and discourage having two hooks rewrite the same key.
   * - permissionDecision: deny > ask > allow > passthrough (claudy ordering).
   *   In this codebase that surfaces as block > approve > undefined; the
   *   semantic remains "most restrictive wins" and is fully deterministic
   *   regardless of completion order.
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

### 6. Integration Point: `TurnManager.executeToolCall()` Is The Canonical Tool Hook Site

This is the most important BrowserX-specific design detail missing from the original draft.

`ToolRegistry.execute()` is not the right ownership boundary for tool lifecycle hooks because:

- `web_search` bypasses `ToolRegistry` entirely.
- MCP tools bypass `ToolRegistry` entirely.
- `TurnManager.executeBrowserTool()` already wraps `ToolRegistry.execute()` and emits `ToolExecutionStart` / `ToolExecutionEnd` / `ToolExecutionError`, so firing hooks in both layers would create duplicate observability and potential double execution.

The recommended ownership model is:

- `TurnManager.executeToolCall()` fires `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` for every model-issued tool call.
- `ToolRegistry.execute()` remains responsible for validation, approval checks, registry dispatch, and its existing registry-level events.
- `ToolRegistry` may later receive hook-aware helpers, but it should not be the lifecycle firing site.

**Concrete execution order inside `TurnManager.executeToolCall()`**

```
1. Parse tool arguments if they arrive as JSON string
2. Collect runtime context available at the orchestration layer:
   - session_id
   - tab_id
   - current_url / current_domain when available
   - cwd when available from Session / TurnContext
3. Fire PreToolUse hooks
   - if blocked: return `function_call_output` explaining the block
   - if updatedInput exists: merge before dispatch
4. Dispatch to one of:
   - `executeWebSearch()`
   - `executeBrowserTool()`
   - `executeMcpTool()`
5. On success, fire PostToolUse hooks
   - if updatedOutput exists: rewrite the result before returning to the model
6. On error, fire PostToolUseFailure hooks
   - include the original error string in `tool_error`
7. Convert final result into Responses API `function_call_output`
```

A thin orchestration helper keeps this logic out of every call site individually:

```typescript
export class HookDispatcher {
  async fire(
    event: HookEvent,
    input: HookInput,
    options?: { session?: Session; signal?: AbortSignal }
  ): Promise<AggregatedHookResult>;
}
```

`HookDispatcher` owns matching, sync/async splitting, `once` cleanup, aggregation, and hook observability event emission.

**TurnManager sketch**

```typescript
private hookDispatcher?: HookDispatcher;

private async executeToolCall(toolName: string, parameters: any, callId: string): Promise<any> {
  let parsedParams = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
  const tabId = this.session.getTabId();
  const runtimeContext = await this.getToolRuntimeContext(tabId);

  if (this.hookDispatcher) {
    const pre = await this.hookDispatcher.fire('PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: this.session.getSessionId(),
      tool_name: toolName,
      tool_input: parsedParams,
      tab_id: tabId > 0 ? tabId : undefined,
      current_url: runtimeContext.currentUrl,
      current_domain: runtimeContext.currentDomain,
      cwd: runtimeContext.cwd,
    }, { session: this.session });

    if (!pre.shouldContinue) {
      return {
        type: 'function_call_output',
        call_id: callId,
        output: `Hook blocked: ${pre.stopReason ?? 'PreToolUse hook denied this tool call'}`,
      };
    }

    if (pre.updatedInput) {
      parsedParams = { ...parsedParams, ...pre.updatedInput };
    }
  }

  // Existing dispatch remains the same:
  // web_search -> executeWebSearch
  // registry-backed tool -> executeBrowserTool
  // MCP tool -> executeMcpTool
}
```

**Required helper omitted in the original draft**

```typescript
private async getToolRuntimeContext(tabId: number): Promise<{
  currentUrl?: string;
  currentDomain?: string;
  cwd?: string;
}> { ... }
```

Notes:

- In extension mode, URL/domain come from `chrome.tabs.get(tabId)` when the session is tab-bound.
- In desktop/server mode, URL may not exist for non-browser tools; hook input fields should simply be omitted.
- `cwd` should come from BrowserX session state or `TurnContext`, not from a new ad hoc source.

### 7. ToolRegistry Role After Hooks

`ToolRegistry.execute()` still matters, but as an internal execution stage for registry-backed tools only. With the ownership split above, its responsibilities remain:

1. tool lookup
2. parameter validation
3. approval gate check
4. handler dispatch with timeout
5. registry-level execution events

This avoids the current draft's double-fire problem and matches BrowserX's real call graph more closely than pushing hook lifecycle logic down into the registry.

### 8. Integration Point: RepublicAgent Lifecycle

`RepublicAgent` owns session-level and submission-level hook events. After the hook system is initialized, these call sites should use `HookDispatcher`, not direct `HookRegistry`/`HookExecutor` access.

**SessionStart** — fire near the end of `RepublicAgent.initialize()` after config, tools, model client, and session context are ready:

```typescript
await this.hookDispatcher.fire('SessionStart', {
  hook_event_name: 'SessionStart',
  session_id: this.session.getSessionId(),
  session_start_source: initialHistory?.mode === 'resumed' ? 'resume' : 'startup',
}, { session: this.session });
```

Rules:

- `SessionStart` is non-blocking. Failures are logged and surfaced through hook events, but agent initialization continues.
- The hook should run after `ConfigHookLoader.load()` so config-defined hooks are already present.

**SessionEnd** — fire during agent shutdown before final session teardown:

```typescript
await this.hookDispatcher.fire('SessionEnd', {
  hook_event_name: 'SessionEnd',
  session_id: this.session.getSessionId(),
  session_end_reason: 'shutdown',
}, {
  session: this.session,
  signal: AbortSignal.timeout(1500),
});
```

Rules:

- `SessionEnd` is best-effort.
- Timeout should be capped aggressively so shutdown is not held open by hooks.

**UserPromptSubmit** — fire in `RepublicAgent.handleSubmission()` for `UserInput` and `UserTurn` before dispatching into the existing handlers:

```typescript
const promptText = extractSubmissionText(submission.op);
const result = await this.hookDispatcher.fire('UserPromptSubmit', {
  hook_event_name: 'UserPromptSubmit',
  session_id: this.session.getSessionId(),
  user_prompt: promptText,
}, { session: this.session });

if (!result.shouldContinue) {
  this.emitEvent({
    type: 'Error',
    data: { message: result.stopReason ?? 'UserPromptSubmit hook blocked this input' },
  });
  return;
}
```

Rules:

- `UserPromptSubmit` is blocking.
- If later needed, the aggregated result can grow an `updatedPrompt` field, but that is not required for phase 1.

### 9. Integration Point: ApprovalGate

`ApprovalGate` remains the sole owner of approval decisions. Hooks are an interception layer inside that pipeline, not a replacement for the approval manager.

**PermissionRequest** — fire only when the approval pipeline has decided `ask_user`, and fire before calling `approvalManager.requestApproval()`:

```typescript
const hookResult = await this.hookDispatcher.fire('PermissionRequest', {
  hook_event_name: 'PermissionRequest',
  session_id: fullContext.sessionId ?? '',
  tool_name: toolName,
  tool_input: parameters,
  risk_score: assessment.score,
  risk_level: assessment.level,
  current_domain: domain,
}, { session: sessionRef });

if (hookResult.permissionDecision === 'approve') {
  return 'auto_approve';
}
if (hookResult.permissionDecision === 'block') {
  return 'deny';
}
```

Rules:

- Only `ApprovalGate` may translate hook output into `auto_approve`, `deny`, or `ask_user`.
- Hook output must not bypass risk assessment or policy evaluation; it only intercepts the final `ask_user` branch.

**PermissionDenied** — fire after a deny decision is final:

```typescript
void this.hookDispatcher.fire('PermissionDenied', {
  hook_event_name: 'PermissionDenied',
  session_id: fullContext.sessionId ?? '',
  tool_name: toolName,
  tool_input: parameters,
  approval_decision: 'deny',
  current_domain: domain,
}, { session: sessionRef });
```

Rules:

- `PermissionDenied` is informational and fire-and-forget.
- It must not reopen the approval decision.

### 10. Integration Point: Session.spawnTask() for TaskCreated / TaskCompleted

`Session.spawnTask()` is the correct owner for task lifecycle hooks because it already manages task start, completion, and abort paths.

**TaskCreated** — fire after the running task has been registered but before the task body begins meaningful execution:

```typescript
void this.hookDispatcher.fire('TaskCreated', {
  hook_event_name: 'TaskCreated',
  session_id: this.sessionId,
  task_id: subId,
  task_type: task.kind(),
}, { session: this });
```

**TaskCompleted** — fire in the promise resolution path once the task has either completed successfully or terminated with failure/abort:

```typescript
void this.hookDispatcher.fire('TaskCompleted', {
  hook_event_name: 'TaskCompleted',
  session_id: this.sessionId,
  task_id: subId,
  task_type: task.kind(),
}, { session: this });
```

Rules:

- These are non-blocking lifecycle hooks.
- If BrowserX later needs separate success/failure task events, add explicit new hook events rather than overloading `TaskCompleted` semantics.

### 11. Configuration Integration

Add hooks to both config shapes in `src/config/types.ts`:

```typescript
export interface IAgentConfig {
  // ... existing fields ...
  hooks?: import('../core/hooks/types').HooksConfig;
}

export interface IStoredConfig {
  // ... existing fields ...
  hooks?: import('../core/hooks/types').HooksConfig;
}
```

Add `hooks` to `IConfigChangeEvent.section`. While doing this, it is worth reconciling the union with the actual persisted sections BrowserX already carries, because today the type is already narrower than the stored config shape.

**ConfigHookLoader** (`src/core/hooks/loaders/ConfigHookLoader.ts`):

```typescript
import type { AgentConfig } from '../../../config/AgentConfig';
import { extractStoredConfig } from '../../../config/defaults';
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

    // AgentConfig currently exposes runtime config via getConfig(). Either add
    // a dedicated getStoredConfig() helper or derive the persisted shape from
    // the runtime config using extractStoredConfig().
    const storedConfig = extractStoredConfig(config.getConfig());
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

The hook system should be constructed once per agent instance and then passed into the real owning surfaces through explicit injection.

```typescript
export class RepublicAgent {
  private hookRegistry: HookRegistry;
  private hookExecutor: HookExecutor;
  private hookDispatcher: HookDispatcher;

  constructor(config: AgentConfig, initialHistory?: InitialHistory, agentId?: string, userNotifier?: IUserNotifier) {
    // ... existing constructor code ...

    this.hookRegistry = new HookRegistry();
    this.hookExecutor = new HookExecutor(/* runtime-specific deps */);
    this.hookDispatcher = new HookDispatcher(this.hookRegistry, this.hookExecutor);
  }
}
```

**Required injection path**

Because BrowserX currently assembles parts of the runtime in different places, implementation needs one explicit collaborator path:

1. `RepublicAgent` constructs `HookRegistry`, `HookExecutor`, and `HookDispatcher`.
2. `RepublicAgent.initialize()` loads config hooks through `ConfigHookLoader`.
3. `TurnManager` instances receive `HookDispatcher` when they are created for a turn.
4. `Session` receives `HookDispatcher` so task lifecycle hooks can fire from `spawnTask()`.
5. `ApprovalGate` receives `HookDispatcher` from the platform bootstrap path that currently assembles approval and injects it into the tool stack.

That last point is the important BrowserX-specific gap: today `ApprovalGate` is assembled by desktop/extension bootstrap and injected into `ToolRegistry`, not retained directly on `RepublicAgent`. Before implementation starts, choose one of these two approaches and document it in code:

- promote `ApprovalGate` to a first-class `RepublicAgent` field, or
- keep bootstrap ownership, but thread `HookDispatcher` into `ApprovalGate` at bootstrap time before the gate is given to `ToolRegistry`.

Do not leave this as an implicit future decision; without it, `PermissionRequest` and `PermissionDenied` wiring is underspecified.

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

For hooks marked `async: true`, async handling should live in `HookDispatcher`, not be duplicated at every firing site.

```typescript
export class HookDispatcher {
  async fire(event: HookEvent, input: HookInput, options?: FireOptions) {
    const matched = this.registry.getMatchingHooks(...);
    const syncHooks = matched.filter(h => !h.command.async);
    const asyncHooks = matched.filter(h => h.command.async);

    const syncResults = await Promise.all(
      syncHooks.map(h => this.executor.execute(h.command, input, options?.signal))
    );

    for (const hook of asyncHooks) {
      void this.executor.execute(hook.command, input, options?.signal).catch(err => {
        this.reportAsyncHookFailure(hook, err, options);
      });
    }

    return HookAggregator.aggregate(syncResults);
  }
}
```

Rules:

- Call sites should only invoke `hookDispatcher.fire(...)`.
- They should not repeat sync/async split logic or `once` cleanup logic locally.
- Async hook failures are reported through hook observability and logs, but do not block the caller.

---

## Event Protocol Reconciliation

BrowserX already has structured event emission through `Session`/`TurnManager` using `EventMsg` types. The hook system should **not** replace this protocol but should integrate with it:

- **Hook events** (PreToolUse, PostToolUse, etc.) are interceptors that can modify behavior — they are NOT the same as observation events
- **EventMsg events** (existing) are notifications for UI and persistence — they are downstream consumers
- **Ordering**: Hook execution → EventMsg emission. A hook that blocks a tool call should suppress the outer `TurnManager`-level tool execution events, not merely the inner registry event.
- **Future EventBus migration** (Phase 4): When converting to pub/sub, existing `EventMsg` consumers become subscribers. Hook handlers remain a separate mechanism (middleware, not pub/sub) because they can modify/block execution.

BrowserX already emits overlapping tool execution events from `TurnManager.executeBrowserTool()` and `ToolRegistry.execute()`. Hook observability should therefore have a single owner: `HookDispatcher` emits hook-facing events through `Session.emitEvent()`, and `ToolRegistry` does not emit separate hook-derived events.

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
- Define types in `src/core/hooks/types.ts`
- Implement `HookMatcher.ts`
- Implement `HookRegistry.ts`
- Implement `HookExecutor.ts` for command hooks with runtime-aware execution paths
- Implement `HookAggregator.ts`
- Implement `HookDispatcher.ts` as the only orchestration surface for matching, async split, `once` cleanup, aggregation, and observability
- Wire `PreToolUse` / `PostToolUse` / `PostToolUseFailure` into `TurnManager.executeToolCall()`
- Wire `SessionStart` / `SessionEnd` / `UserPromptSubmit` into `RepublicAgent`
- Add recursion guard
- Unit tests for matcher, registry, executor, aggregator, and dispatcher
- Integration tests for registry tools, `web_search`, and MCP paths

**Phase 2: Hook Types & Async** (Week 3)
- Add prompt hook support in `HookExecutor`
- Add HTTP hook support in `HookExecutor`
- Centralize async hook handling in `HookDispatcher`
- Centralize `once` hook semantics in `HookDispatcher`
- Add timeout handling and error isolation
- Preserve graceful degradation in extension mode for command hooks

**Phase 3: Configuration, Approval, and Task Integration** (Week 4)
- Add `hooks` to both `IAgentConfig` and `IStoredConfig`
- Implement `ConfigHookLoader.ts`
- Wire `PermissionRequest` / `PermissionDenied` into `ApprovalGate`
- Wire `TaskCreated` / `TaskCompleted` into `Session.spawnTask()`
- Confirm and implement the bootstrap injection path for `ApprovalGate` ownership
- Add hook observability events (`HookFired`, `HookResult`, `HookBlocked`) to `EventMsg`
- Add tests for config hot reload, approval interception, task lifecycle hooks, and observability single ownership

**Phase 4: EventBus Follow-up** (Week 5)
- Create `EventBus.ts` with subscribe/unsubscribe/emit
- Migrate existing event dispatcher callbacks to EventBus
- Add filtering, correlation, and event history buffer
- Keep hooks as middleware/interceptors even if the observation layer moves to pub/sub

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

---

## Validation Notes (re-checked vs claudy 2026-05-11)

Re-validated this design against claudy source. Corrections applied:

- **Hook event list (28)**: Replaced the previous list with the canonical 28 events from `entrypoints/sdk/coreTypes.ts`. The earlier list was ordered ad-hoc and missing the canonical grouping; the count was already correct but the membership had drift.
- **Source priority is wrong**: `utils/hooks.ts:getHooksConfig()` *concatenates* all sources rather than overriding by source. Removed "highest to lowest" framing and added an explicit correction note. Per-hook merge precedence still applies (deny > ask > allow > passthrough; `updatedInput` last-writer-wins).
- **SessionEnd timeout**: Documented the 1.5s default cap and the `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` override that makes SessionEnd a special case versus the 10-minute default for tool hooks.
- **Async hook response**: Documented the `{"async": true, "asyncTimeout": <ms>}` shape and the `AsyncHookRegistry` re-entry pattern via `emitHookResponse()`.
- **Function hooks**: Added a subsection covering the in-process TypeScript callback path, its `(messages, signal) => boolean | Promise<boolean>` signature, session-only scoping, `Map`-based identity preservation, and structured-output validation use case.
- **HTTP hook security**: Added a subsection covering URL allowlist (`allowedHttpHookUrls`), env-var allowlist for `$VAR` header interpolation, CRLF sanitization, and sandbox proxy routing. Cited `utils/hooks/execHttpHook.ts`.
- **Permission gates around hook execution**: Added a subsection covering the workspace trust dialog gate, `CLAUDE_CODE_SIMPLE` global disable, and SDK implicit-trust path. Cited `shouldSkipHookDueToTrust`.
- **Plugin context substitution**: Documented `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${user_config.X}` interpolation, and noted that substitution happens at execution time so user-config edits take effect on next firing.
- **Telemetry**: Documented the `tengu_run_hook` analytics event plus per-hook OpenTelemetry spans via `startHookSpan`/`endHookSpan`, and noted the two layers are independent.
- **Merge non-determinism**: Strengthened the `HookAggregator` comment to make explicit that `updatedInput` last-writer-wins depends on parallel completion order (non-deterministic), while permission decisions remain deterministic under `deny > ask > allow > passthrough`.

References: `utils/hooks.ts`, `entrypoints/sdk/coreTypes.ts`, `utils/hooks/execHttpHook.ts`, `schemas/hooks.ts`.
