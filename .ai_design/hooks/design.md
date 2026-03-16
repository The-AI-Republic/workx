# Hook Infrastructure Design

## 1. Problem Statement

BrowserX has rich internal event/callback systems (session events, tool execution events, channel communication, service registry, plugin system), but **no user-configurable hook system**. All lifecycle interception is hardcoded — there is no way for users, plugin authors, or platform integrators to declaratively inject behavior at key lifecycle points without modifying core code.

### Current State

```
User/Plugin Author
      │
      ╳  No hook points
      │
  ┌───▼──────────────────────────────────────────────────┐
  │                  BrowserX Core                        │
  │                                                       │
  │  Session ─► TaskRunner ─► TurnManager ─► ToolRegistry │
  │     │           │             │              │         │
  │  (internal   (internal    (internal     (internal     │
  │   events)     events)      events)       events)      │
  └───────────────────────────────────────────────────────┘
```

### What's Missing

1. **No pre/post interception** — Users cannot run custom logic before or after tool execution, task start/end, turn completion, or session lifecycle transitions. The `ApprovalGate` handles risk-based blocking but isn't extensible for arbitrary pre-execution logic (logging, parameter transformation, custom validation).

2. **No declarative configuration** — The plugin system (`src/server/plugins/`) requires writing TypeScript modules and registering them programmatically. There's no settings-driven way to say "run this when X happens."

3. **No cross-platform hook parity** — Desktop has no plugin system. Extension has no lifecycle extensibility. Server has plugins but they're channel-focused, not lifecycle-focused.

4. **No user-defined automation** — Common patterns like "auto-format after file writes," "notify me when a task completes," "inject context after compaction," or "block navigation to certain domains" require core code changes.

### Motivating Use Cases

| Use Case | Hook Point | Type |
|----------|-----------|------|
| Auto-format code after agent writes a file | PostToolUse (`local_shell`, `browser_dom`) | Command |
| Block navigation to sensitive domains | PreToolUse (`browser_navigate`) | Blocking |
| Send Slack notification when task completes | TaskComplete | Command / HTTP |
| Audit all tool executions to external log | PostToolUse (`*`) | HTTP |
| Inject project context after compaction | SessionEvent (`compaction`) | Context injection |
| Custom approval logic for high-risk actions | PreToolUse (`*`) | Blocking |
| Run tests before agent declares task done | TaskComplete | Blocking |
| Rate-limit tool calls per session | PreToolUse (`*`) | Blocking |
| Transform tool parameters (e.g., rewrite paths) | PreToolUse (`local_shell`) | Parameter mutation |

## 2. Design Goals

1. **Declarative** — Hooks are defined in configuration (JSON settings files), not in code
2. **Platform-agnostic** — Core hook engine lives in `src/core/`, works on extension, desktop, and server
3. **Non-blocking by default** — Hooks observe lifecycle events; blocking is opt-in
4. **Composable** — Multiple hooks can register for the same event; they execute in order
5. **Fail-safe** — Hook failures are isolated; a broken hook doesn't crash the agent
6. **Consistent with existing patterns** — Uses the existing `ChannelEvent`/`EventMsg` vocabulary and settings infrastructure
7. **Minimal core changes** — Hook dispatch points are thin wrappers at natural boundaries, not invasive rewrites

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        HOOK CONFIGURATION                               │
│                                                                         │
│  Settings sources (merged, highest priority wins):                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │
│  │ User Settings    │  │ Project Settings │  │ Plugin Settings  │      │
│  │ (~/.browserx/    │  │ (.browserx/      │  │ (plugin manifest)│      │
│  │  settings.json)  │  │  settings.json)  │  │                  │      │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘      │
│           └──────────────┬──────┘──────────────────────┘               │
│                          ▼                                              │
│              ┌─────────────────────┐                                    │
│              │   HookRegistry      │                                    │
│              │                     │                                    │
│              │  - loadFromConfig() │                                    │
│              │  - getHooks(event)  │                                    │
│              │  - reload()         │                                    │
│              └──────────┬──────────┘                                    │
│                         │                                               │
└─────────────────────────┼───────────────────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────────────────┐
│                         ▼            HOOK ENGINE                        │
│              ┌─────────────────────┐                                    │
│              │    HookExecutor     │                                    │
│              │                     │                                    │
│              │  - execute(event,   │                                    │
│              │    context, hooks)  │                                    │
│              │  - handles timeout  │                                    │
│              │  - handles errors   │                                    │
│              │  - collects results │                                    │
│              └──────────┬──────────┘                                    │
│                         │                                               │
│    ┌────────────────────┼────────────────────┐                         │
│    │                    │                    │                          │
│    ▼                    ▼                    ▼                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                         │
│  │ Command  │    │  HTTP    │    │ Internal │                          │
│  │ Handler  │    │ Handler  │    │ Handler  │                          │
│  │          │    │          │    │ (TS fn)  │                          │
│  │ stdin←   │    │ POST     │    │          │                          │
│  │  JSON    │    │ JSON     │    │ direct   │                          │
│  │ exit code│    │ response │    │ return   │                          │
│  └──────────┘    └──────────┘    └──────────┘                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────────────────┐
│                         ▼          DISPATCH POINTS                      │
│                                                                         │
│  AgentSession        TaskRunner       TurnManager       ToolRegistry    │
│  ┌──────────┐       ┌──────────┐     ┌──────────┐     ┌──────────┐    │
│  │SessionStart│     │TaskStarted│    │PreTurn   │     │PreToolUse│    │
│  │SessionEnd │     │TaskComplete│   │PostTurn  │     │PostToolUse│   │
│  │Compaction │     │TaskFailed │    └──────────┘     └──────────┘    │
│  └──────────┘       └──────────┘                                       │
│                                                                         │
│  ChannelManager     ApprovalGate     AgentConfig                       │
│  ┌──────────┐       ┌──────────┐     ┌──────────┐                     │
│  │Submission│       │PreApproval│    │ConfigChange│                   │
│  │Notification│     └──────────┘     └──────────┘                     │
│  └──────────┘                                                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 4. Hook Events

### 4.1 Event Taxonomy

Each hook event has a **timing** (pre/post/on), a **scope** (session/task/turn/tool/channel), and a **blocking capability**.

| Event | Timing | Scope | Can Block? | Matcher Target | Description |
|-------|--------|-------|-----------|---------------|-------------|
| `SessionStart` | on | session | No | `startup`, `resume`, `compact` | Session begins, resumes, or recovers from compaction |
| `SessionEnd` | on | session | No | `terminate`, `timeout`, `user_close` | Session terminates |
| `TaskStarted` | on | task | No | — | Agent starts processing a submission |
| `TaskComplete` | pre | task | Yes | — | Agent is about to declare task done. Blocking hook can force continuation |
| `TaskFailed` | on | task | No | — | Task failed or was aborted |
| `PreTurn` | pre | turn | Yes | — | Before a model API call. Can inject additional context or block |
| `PostTurn` | post | turn | No | — | After model response processed. Receives turn results |
| `PreToolUse` | pre | tool | Yes | Tool name regex | Before tool executes. Can block, modify params, or override |
| `PostToolUse` | post | tool | Yes | Tool name regex | After tool executes. Can modify result, trigger follow-up |
| `Submission` | pre | channel | Yes | Op type regex | Before a user submission reaches the agent |
| `Notification` | on | channel | No | Notification type | Agent needs user attention (approval, idle, error) |
| `ConfigChange` | on | system | No | Config source | Configuration updated at runtime |
| `Compaction` | post | session | No | `auto`, `manual` | After context compaction completes |

### 4.2 Event Context (Input to Hooks)

Every hook receives a JSON context object on stdin (for command hooks) or as the POST body (for HTTP hooks):

```typescript
interface HookEventContext {
  // Common fields (always present)
  hook_event: string;            // e.g., 'PreToolUse'
  session_id: string;
  timestamp: number;             // Unix ms
  platform: 'extension' | 'desktop' | 'server';

  // Event-specific fields (vary by event type)
  [key: string]: unknown;
}
```

#### Per-Event Context Fields

**PreToolUse / PostToolUse:**
```typescript
{
  hook_event: 'PreToolUse' | 'PostToolUse';
  session_id: string;
  timestamp: number;
  platform: string;
  tool_name: string;             // e.g., 'browser_navigate', 'local_shell'
  tool_input: Record<string, unknown>;  // Tool parameters
  // PostToolUse only:
  tool_output?: unknown;         // Tool execution result
  tool_error?: string;           // Error message if tool failed
  tool_duration_ms?: number;     // Execution time
}
```

**TaskComplete:**
```typescript
{
  hook_event: 'TaskComplete';
  session_id: string;
  timestamp: number;
  platform: string;
  submission_id: string;
  turn_count: number;
  last_agent_message?: string;
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}
```

**SessionStart:**
```typescript
{
  hook_event: 'SessionStart';
  session_id: string;
  timestamp: number;
  platform: string;
  source: 'startup' | 'resume' | 'compact';
  session_name?: string;
}
```

**PreTurn:**
```typescript
{
  hook_event: 'PreTurn';
  session_id: string;
  timestamp: number;
  platform: string;
  turn_index: number;
  model: string;
  token_usage?: { used: number; max: number };
}
```

**Submission:**
```typescript
{
  hook_event: 'Submission';
  session_id: string;
  timestamp: number;
  platform: string;
  op_type: string;               // e.g., 'UserTurn', 'Interrupt'
  channel_id: string;
  channel_type: string;
}
```

**Compaction:**
```typescript
{
  hook_event: 'Compaction';
  session_id: string;
  timestamp: number;
  platform: string;
  trigger: 'auto' | 'manual';
  tokens_before: number;
  tokens_after: number;
  items_trimmed: number;
}
```

## 5. Hook Configuration

### 5.1 Settings Schema

Hooks are defined in the existing settings files. The settings hierarchy already exists (`AgentConfig` with platform-specific `ConfigStorage`), so hooks piggyback on it:

```jsonc
// In any settings file: user, project, or plugin
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "browser_navigate|browser_dom",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/validate-navigation.sh",
            "timeout": 5000
          }
        ]
      },
      {
        "matcher": "local_shell",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/audit-commands.sh",
            "timeout": 3000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "local_shell",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8080/hooks/tool-complete",
            "timeout": 5000
          }
        ]
      }
    ],
    "TaskComplete": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "notify-send 'BrowserX' 'Task completed'"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Reminder: Use Bun, not npm. Current sprint: auth refactor.'"
          }
        ]
      }
    ]
  }
}
```

### 5.2 Type Definitions

```typescript
// src/core/hooks/types.ts

/**
 * Hook event names — the lifecycle points where hooks can fire.
 */
export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'TaskStarted'
  | 'TaskComplete'
  | 'TaskFailed'
  | 'PreTurn'
  | 'PostTurn'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Submission'
  | 'Notification'
  | 'ConfigChange'
  | 'Compaction';

/**
 * A single hook definition — one executable unit.
 */
export type HookDefinition =
  | CommandHookDefinition
  | HttpHookDefinition
  | InternalHookDefinition;

export interface CommandHookDefinition {
  type: 'command';
  /** Shell command to execute. Receives JSON on stdin. */
  command: string;
  /** Timeout in ms. Default: 10000. Max: 300000 (5 min). */
  timeout?: number;
  /** Environment variable names that are allowed to be expanded in the command. */
  allowedEnvVars?: string[];
}

export interface HttpHookDefinition {
  type: 'http';
  /** URL to POST event context to. */
  url: string;
  /** Additional headers. Values can reference env vars with $VAR syntax. */
  headers?: Record<string, string>;
  /** Timeout in ms. Default: 10000. Max: 30000. */
  timeout?: number;
  /** Environment variable names allowed in header value expansion. */
  allowedEnvVars?: string[];
}

export interface InternalHookDefinition {
  type: 'internal';
  /** Handler ID — resolved by platform-specific hook handler registry. */
  handler: string;
  /** Configuration passed to the handler. */
  config?: Record<string, unknown>;
}

/**
 * A hook event registration — groups hooks by matcher pattern.
 */
export interface HookEventRegistration {
  /**
   * Regex pattern to filter when this group fires.
   * What it matches depends on the event:
   * - PreToolUse/PostToolUse: tool name
   * - SessionStart: source ('startup', 'resume', 'compact')
   * - Submission: op type
   * - Empty string or omitted: matches all
   */
  matcher?: string;
  /** Hooks to execute when the event fires and matcher matches. */
  hooks: HookDefinition[];
}

/**
 * Full hooks configuration block.
 */
export type HooksConfig = {
  [E in HookEventName]?: HookEventRegistration[];
};

/**
 * Result from executing a single hook.
 */
export interface HookResult {
  /** Whether the hook executed successfully. */
  success: boolean;
  /** For blocking hooks: 'allow', 'deny', or 'skip' (hook had nothing to say). */
  decision?: 'allow' | 'deny' | 'skip';
  /** Reason for deny (shown to agent as feedback). */
  reason?: string;
  /** Optional message to inject into the conversation (e.g., context after compaction). */
  message?: string;
  /** Optional parameter mutations for PreToolUse hooks. */
  mutatedInput?: Record<string, unknown>;
  /** Execution duration in ms. */
  durationMs: number;
  /** Error if the hook failed. */
  error?: string;
}

/**
 * Aggregate result from executing all hooks for an event.
 */
export interface HookExecutionResult {
  /** Whether any hook denied the action. */
  blocked: boolean;
  /** Deny reason from the first blocking hook. */
  blockReason?: string;
  /** Messages to inject from hooks. */
  messages: string[];
  /** Merged parameter mutations (last writer wins per key). */
  mutatedInput?: Record<string, unknown>;
  /** Individual hook results. */
  results: HookResult[];
  /** Total execution time across all hooks. */
  totalDurationMs: number;
}
```

### 5.3 Matcher Semantics

Matchers are regex patterns tested against an event-specific target string:

| Event | Matcher Target | Examples |
|-------|---------------|----------|
| `PreToolUse`, `PostToolUse` | `tool_name` | `"browser_navigate"`, `"local_shell\|browser_dom"`, `"mcp__.*"` |
| `SessionStart`, `SessionEnd` | `source` | `"startup"`, `"resume"`, `"compact"` |
| `Submission` | `op.type` | `"UserTurn"`, `"Interrupt"` |
| `Notification` | notification type | `"approval"`, `"idle"`, `"error"` |
| `ConfigChange` | config source | `"user_settings"`, `"project_settings"` |
| `TaskStarted`, `TaskComplete`, `TaskFailed` | — (always matches) | `""` or omitted |
| `PreTurn`, `PostTurn` | — (always matches) | `""` or omitted |
| `Compaction` | trigger reason | `"auto"`, `"manual"` |

An empty string or omitted `matcher` matches all events of that type.

## 6. Core Components

### 6.1 HookRegistry

Loads and indexes hook definitions from configuration. Handles config reloads.

```typescript
// src/core/hooks/HookRegistry.ts

export class HookRegistry {
  private hooks: Map<HookEventName, HookEventRegistration[]> = new Map();

  /**
   * Load hooks from a HooksConfig object (from settings).
   * Merges with existing hooks (for multi-source config).
   */
  loadFromConfig(config: HooksConfig): void;

  /**
   * Replace all hooks with a fresh config (for config reload).
   */
  reload(config: HooksConfig): void;

  /**
   * Get all hook registrations for an event, filtered by matcher.
   */
  getHooks(event: HookEventName, matchTarget?: string): HookDefinition[];

  /**
   * Check if any hooks are registered for an event.
   */
  hasHooks(event: HookEventName): boolean;

  /**
   * List all registered events (for debug/UI).
   */
  listEvents(): HookEventName[];

  /**
   * Get total hook count (for diagnostics).
   */
  getStats(): { totalHooks: number; byEvent: Record<string, number> };
}
```

**Implementation notes:**
- `getHooks()` compiles matcher regexes lazily and caches them
- Invalid regex in matcher logs a warning and is skipped (fail-safe)
- Config validation happens at load time — malformed entries are logged and skipped

### 6.2 HookExecutor

Executes hooks and collects results. Handles timeouts, errors, and result aggregation.

```typescript
// src/core/hooks/HookExecutor.ts

export class HookExecutor {
  private registry: HookRegistry;
  private logger: HookLogger;

  constructor(registry: HookRegistry, logger?: HookLogger);

  /**
   * Execute all matching hooks for an event.
   *
   * For blocking events (PreToolUse, TaskComplete, Submission, PreTurn):
   *   - Hooks execute sequentially (order matters for blocking)
   *   - First 'deny' result short-circuits remaining hooks
   *   - 'allow' and 'skip' continue to next hook
   *
   * For non-blocking events (PostToolUse, SessionStart, TaskStarted, etc.):
   *   - Hooks execute concurrently (order doesn't matter)
   *   - Failures are logged but don't affect the agent
   */
  async execute(
    event: HookEventName,
    context: HookEventContext,
    matchTarget?: string
  ): Promise<HookExecutionResult>;
}
```

**Execution semantics:**

```
Blocking event (PreToolUse, TaskComplete, Submission, PreTurn):
  for each hook in order:
    result = await executeOne(hook, context)
    if result.decision === 'deny':
      return { blocked: true, blockReason: result.reason }
    if result.mutatedInput:
      context.tool_input = merge(context.tool_input, result.mutatedInput)
  return { blocked: false, ... }

Non-blocking event (all others):
  results = await Promise.allSettled(hooks.map(h => executeOne(h, context)))
  return { blocked: false, messages: collectMessages(results), ... }
```

### 6.3 Hook Handlers

Each hook type has a handler that knows how to execute it.

#### CommandHookHandler

```typescript
// src/core/hooks/handlers/CommandHookHandler.ts

export class CommandHookHandler {
  /**
   * Execute a shell command hook.
   *
   * - Spawns a child process with the command
   * - Pipes HookEventContext as JSON to stdin
   * - Reads stdout for structured JSON response
   * - Reads stderr for human-readable messages
   * - Interprets exit codes:
   *     0 = allow (stdout parsed as HookOutput JSON)
   *     2 = deny  (stderr used as deny reason)
   *     other = allow (logged as warning)
   */
  async execute(
    definition: CommandHookDefinition,
    context: HookEventContext
  ): Promise<HookResult>;
}
```

**Exit code protocol:**

| Exit Code | Meaning | stdout | stderr |
|-----------|---------|--------|--------|
| 0 | Allow / Success | Optional JSON `HookOutput` | Ignored (logged in verbose) |
| 2 | Deny / Block | Ignored | Used as deny reason (shown to agent) |
| 1, 3+ | Allow (hook error) | Ignored | Logged as warning |

**stdout JSON schema (`HookOutput`):**
```typescript
interface HookOutput {
  /** For PreToolUse: mutated parameters. */
  mutatedInput?: Record<string, unknown>;
  /** Message to inject into conversation context. */
  message?: string;
  /** Explicit decision override. */
  decision?: 'allow' | 'deny';
  /** Reason for decision. */
  reason?: string;
}
```

**Platform considerations:**
- **Desktop (Tauri):** Uses Tauri's `Command` sidecar API or Node.js child_process via Tauri plugin
- **Server:** Uses Node.js `child_process.spawn`
- **Extension:** Command hooks are **not supported** (no shell access). Only HTTP and internal hooks work. Config validation warns if command hooks are defined in extension mode.

#### HttpHookHandler

```typescript
// src/core/hooks/handlers/HttpHookHandler.ts

export class HttpHookHandler {
  /**
   * Execute an HTTP hook.
   *
   * - POSTs HookEventContext as JSON to the configured URL
   * - Interprets response:
   *     2xx = allow (body parsed as HookOutput JSON)
   *     403 = deny  (body.reason used as deny reason)
   *     4xx/5xx = allow (logged as warning)
   *     timeout = allow (logged as warning)
   */
  async execute(
    definition: HttpHookDefinition,
    context: HookEventContext
  ): Promise<HookResult>;
}
```

#### InternalHookHandler

```typescript
// src/core/hooks/handlers/InternalHookHandler.ts

/**
 * Registry for platform-provided TypeScript hook handlers.
 * Used for hooks that need direct access to BrowserX internals
 * (e.g., built-in formatters, custom approval logic).
 */
export class InternalHookHandler {
  private handlers: Map<string, InternalHookFn> = new Map();

  register(id: string, fn: InternalHookFn): void;

  async execute(
    definition: InternalHookDefinition,
    context: HookEventContext
  ): Promise<HookResult>;
}

type InternalHookFn = (
  context: HookEventContext,
  config?: Record<string, unknown>
) => Promise<HookResult>;
```

### 6.4 HookDispatcher

Convenience facade that sits at each lifecycle point. Thin integration layer.

```typescript
// src/core/hooks/HookDispatcher.ts

export class HookDispatcher {
  private executor: HookExecutor;

  constructor(executor: HookExecutor);

  /**
   * Dispatch a blocking hook event. Returns whether the action should proceed.
   */
  async dispatchBlocking(
    event: HookEventName,
    context: HookEventContext,
    matchTarget?: string
  ): Promise<{ proceed: boolean; reason?: string; mutatedInput?: Record<string, unknown> }>;

  /**
   * Dispatch a non-blocking hook event. Fire and forget (errors logged).
   */
  async dispatchAsync(
    event: HookEventName,
    context: HookEventContext,
    matchTarget?: string
  ): Promise<void>;

  /**
   * Dispatch and collect messages (for context injection, e.g., post-compaction).
   */
  async dispatchWithMessages(
    event: HookEventName,
    context: HookEventContext,
    matchTarget?: string
  ): Promise<string[]>;
}
```

## 7. Integration Points

### 7.1 ToolRegistry — PreToolUse / PostToolUse

The `ToolRegistry.execute()` method (lines 236-422) is the natural integration point. Hooks wrap the existing execution pipeline:

```typescript
// ToolRegistry.ts — execute() method, modified sections only

async execute(request: ToolExecutionRequest): Promise<ToolExecutionResponse> {
  const startTime = Date.now();

  // ... existing validation ...

  // --- NEW: PreToolUse hook ---
  if (this.hookDispatcher) {
    const hookContext: HookEventContext = {
      hook_event: 'PreToolUse',
      session_id: request.sessionId,
      timestamp: Date.now(),
      platform: this.platform,
      tool_name: request.toolName,
      tool_input: request.parameters,
    };

    const hookResult = await this.hookDispatcher.dispatchBlocking(
      'PreToolUse',
      hookContext,
      request.toolName  // matcher target
    );

    if (!hookResult.proceed) {
      return {
        success: false,
        error: {
          code: 'HOOK_BLOCKED',
          message: hookResult.reason ?? `Blocked by PreToolUse hook`,
        },
        duration: Date.now() - startTime,
      };
    }

    // Apply parameter mutations from hooks
    if (hookResult.mutatedInput) {
      request = { ...request, parameters: { ...request.parameters, ...hookResult.mutatedInput } };
    }
  }

  // ... existing approval gate check ...
  // ... existing tool execution ...

  // --- NEW: PostToolUse hook ---
  if (this.hookDispatcher) {
    const postContext: HookEventContext = {
      hook_event: 'PostToolUse',
      session_id: request.sessionId,
      timestamp: Date.now(),
      platform: this.platform,
      tool_name: request.toolName,
      tool_input: request.parameters,
      tool_output: result,
      tool_duration_ms: Date.now() - startTime,
    };

    // PostToolUse is async (non-blocking by default)
    // but CAN block to force result modification
    await this.hookDispatcher.dispatchAsync(
      'PostToolUse',
      postContext,
      request.toolName
    );
  }

  // ... existing return ...
}
```

### 7.2 TaskRunner — TaskStarted / TaskComplete / TaskFailed

Hooks integrate at the task lifecycle boundaries in `TaskRunner.run_task()`:

```typescript
// TaskRunner.ts — modified sections

async run_task(submissionId?: string, signal?: AbortSignal): Promise<TaskResult> {
  // ... existing setup ...

  await this.emitTaskStarted();

  // --- NEW: TaskStarted hook (non-blocking) ---
  await this.hookDispatcher?.dispatchAsync('TaskStarted', {
    hook_event: 'TaskStarted',
    session_id: this.session.getSessionId(),
    timestamp: Date.now(),
    platform: this.platform,
    submission_id: this.submissionId,
  });

  // ... existing task loop ...

  // --- NEW: TaskComplete hook (blocking — can prevent agent from stopping) ---
  if (this.hookDispatcher) {
    const completeResult = await this.hookDispatcher.dispatchBlocking('TaskComplete', {
      hook_event: 'TaskComplete',
      session_id: this.session.getSessionId(),
      timestamp: Date.now(),
      platform: this.platform,
      submission_id: this.submissionId,
      turn_count: outcome.turnCount,
      last_agent_message: outcome.lastAgentMessage,
    });

    if (!completeResult.proceed) {
      // Hook says "not done yet" — inject reason as context and continue
      // This enables "run tests before stopping" patterns
      this.session.injectSystemMessage(
        completeResult.reason ?? 'A hook has requested that you continue working.'
      );
      // Re-enter the task loop (implementation detail)
    }
  }

  // ... existing completion logic ...
}
```

### 7.3 AgentSession — SessionStart / SessionEnd

```typescript
// AgentSession.ts — modified sections

async initialize(): Promise<void> {
  // ... existing init ...

  // --- NEW: SessionStart hook ---
  const messages = await this.hookDispatcher?.dispatchWithMessages('SessionStart', {
    hook_event: 'SessionStart',
    session_id: this.sessionId,
    timestamp: Date.now(),
    platform: this.platform,
    source: this.resumeMode ? 'resume' : 'startup',
    session_name: this.name,
  }, this.resumeMode ? 'resume' : 'startup');

  // Inject hook messages into session context
  if (messages?.length) {
    for (const msg of messages) {
      this.session.injectSystemMessage(msg);
    }
  }
}
```

### 7.4 TaskRunner — Compaction

```typescript
// TaskRunner.ts — notifyCompactionComplete(), modified

private async notifyCompactionComplete(result: CompactionResult): Promise<void> {
  // ... existing event emission ...

  // --- NEW: Compaction hook (with context injection) ---
  const messages = await this.hookDispatcher?.dispatchWithMessages('Compaction', {
    hook_event: 'Compaction',
    session_id: this.session.getSessionId(),
    timestamp: Date.now(),
    platform: this.platform,
    trigger: result.triggerReason === 'auto' ? 'auto' : 'manual',
    tokens_before: result.tokensBefore,
    tokens_after: result.tokensAfter,
    items_trimmed: result.itemsTrimmed,
  }, result.triggerReason);

  // Inject compaction hook messages into session context
  if (messages?.length) {
    for (const msg of messages) {
      this.session.injectSystemMessage(msg);
    }
  }
}
```

### 7.5 ChannelManager — Submission

```typescript
// ChannelManager.ts — submission handler, modified

channel.onSubmission(async (op, context) => {
  // --- NEW: Submission hook (blocking) ---
  if (this.hookDispatcher && op.type !== 'ServiceRequest') {
    const hookResult = await this.hookDispatcher.dispatchBlocking('Submission', {
      hook_event: 'Submission',
      session_id: context.sessionId ?? '',
      timestamp: Date.now(),
      platform: this.platform,
      op_type: op.type,
      channel_id: context.channelId,
      channel_type: context.channelType,
    }, op.type);

    if (!hookResult.proceed) {
      // Reject submission — send error back to channel
      await channel.sendEvent({
        msg: { type: 'Error', data: { message: hookResult.reason ?? 'Blocked by hook' } },
      }, context.userId);
      return;
    }
  }

  // ... existing routing (ServiceRequest vs AgentHandler) ...
});
```

## 8. Bootstrap Integration

Each platform bootstrap creates the hook infrastructure during initialization:

```typescript
// Shared hook setup (called from each bootstrap)
// src/core/hooks/createHookInfrastructure.ts

export function createHookInfrastructure(
  config: AgentConfig,
  platform: 'extension' | 'desktop' | 'server'
): { registry: HookRegistry; executor: HookExecutor; dispatcher: HookDispatcher } {
  const registry = new HookRegistry();
  const logger = new HookLogger(platform);

  // Load hooks from config
  const hooksConfig = config.getConfig().hooks;
  if (hooksConfig) {
    registry.loadFromConfig(hooksConfig);
  }

  // Create handlers
  const commandHandler = platform !== 'extension' ? new CommandHookHandler() : null;
  const httpHandler = new HttpHookHandler();
  const internalHandler = new InternalHookHandler();

  // Create executor with available handlers
  const executor = new HookExecutor(registry, logger, {
    command: commandHandler,
    http: httpHandler,
    internal: internalHandler,
  });

  const dispatcher = new HookDispatcher(executor);

  // Listen for config changes to hot-reload hooks
  config.on('hooks', (event) => {
    registry.reload(event.newValue as HooksConfig);
    logger.info('Hooks reloaded from config change');
  });

  return { registry, executor, dispatcher };
}
```

```typescript
// DesktopAgentBootstrap.ts — in initialize()
const hookInfra = createHookInfrastructure(agentConfig, 'desktop');
// Pass dispatcher to ToolRegistry, TaskRunner factory, AgentSession factory, ChannelManager
```

```typescript
// ServerAgentBootstrap.ts — in initialize()
const hookInfra = createHookInfrastructure(agentConfig, 'server');
// Same wiring as desktop
```

```typescript
// Extension service-worker — in doInitialize()
const hookInfra = createHookInfrastructure(agentConfig, 'extension');
// Note: commandHandler is null — command hooks will log warning and skip
```

## 9. Platform Considerations

### 9.1 Platform Capability Matrix

| Feature | Extension | Desktop | Server |
|---------|-----------|---------|--------|
| Command hooks | No (no shell) | Yes (Tauri sidecar / Node child_process) | Yes (Node child_process) |
| HTTP hooks | Yes (fetch) | Yes (fetch / Tauri HTTP) | Yes (Node fetch) |
| Internal hooks | Yes | Yes | Yes |
| Config source | `chrome.storage` | File system | File system |
| Hot-reload | Via `chrome.storage.onChanged` | Via `AgentConfig.on('hooks')` | Via `AgentConfig.on('hooks')` + file watcher |

### 9.2 Extension Limitations

The Chrome Extension environment cannot spawn child processes. Command hooks defined in extension-mode configuration will:
1. Log a warning at config load time: `[HookRegistry] Command hooks are not supported in extension mode, skipping`
2. Be excluded from the registry (not silently fail at execution time)

### 9.3 Server Process Model

Server mode may have multiple concurrent sessions. Hook execution must be:
- **Session-isolated:** Each hook invocation receives `session_id` in its context
- **Concurrency-safe:** Multiple hooks for different sessions can execute in parallel
- **Resource-bounded:** Per-hook timeouts prevent runaway processes from blocking the server

### 9.4 Desktop Security

Desktop command hooks run with the user's full OS permissions. The hook system:
- Does **not** sandbox hook commands (user explicitly configured them)
- Logs all hook executions to the debug transcript (visible via verbose mode)
- Validates that command paths exist at config load time (warning if not)

## 10. Error Handling

### 10.1 Fail-Safe Principles

| Failure | Behavior |
|---------|----------|
| Hook command not found | Log error, treat as `exit 1` (allow) |
| Hook timeout | Kill process, log warning, treat as allow |
| Hook stderr output | Log in verbose mode, not shown to user unless exit 2 |
| Hook stdout malformed JSON | Log warning, treat as allow with no output |
| HTTP hook unreachable | Log warning, treat as allow |
| HTTP hook 5xx | Log warning, treat as allow |
| Internal hook throws | Log error, treat as allow |
| Regex matcher invalid | Log warning at config load, skip that registration |
| All hooks for event fail | Proceed as if no hooks registered |

### 10.2 Timeout Defaults

| Hook Type | Default Timeout | Max Timeout |
|-----------|----------------|-------------|
| Command | 10,000 ms | 300,000 ms (5 min) |
| HTTP | 10,000 ms | 30,000 ms |
| Internal | 5,000 ms | 60,000 ms |

### 10.3 Logging

```typescript
// src/core/hooks/HookLogger.ts

export class HookLogger {
  constructor(private platform: string) {}

  /** Always logged — hook registration, reload, validation errors. */
  info(message: string, data?: Record<string, unknown>): void;

  /** Logged in verbose/debug mode — hook execution details, timing. */
  debug(message: string, data?: Record<string, unknown>): void;

  /** Always logged — hook failures, timeouts, malformed output. */
  warn(message: string, data?: Record<string, unknown>): void;

  /** Always logged — critical failures. */
  error(message: string, error?: Error, data?: Record<string, unknown>): void;
}
```

Log format: `[Hooks] [<event>] <message>` — consistent with existing `[TaskRunner]`, `[Compaction]` log prefixes.

## 11. Service Integration (UI Management)

Hooks are manageable via the existing ServiceRegistry, enabling a UI settings page:

```typescript
// src/core/services/hook-services.ts

export function createHookServices(
  registry: HookRegistry
): Record<string, ServiceHandler> {
  return {
    'hooks.list': async () => registry.listEvents(),
    'hooks.getStats': async () => registry.getStats(),
    'hooks.getForEvent': async (params) =>
      registry.getHooks(params.event as HookEventName),
  };
}
```

This enables a future "Hooks" settings panel in the UI that shows configured hooks, their status, and execution statistics.

## 12. Relationship to Existing Systems

### 12.1 Hooks vs. ApprovalGate

The `ApprovalGate` (`src/core/approval/ApprovalGate.ts`) handles **risk-based tool call interception** with domain sensitivity, semantic analysis, and policy rules. Hooks do **not** replace ApprovalGate — they complement it:

```
Tool Execution Pipeline (with hooks):

  ToolRegistry.execute()
       │
       ▼
  1. Parameter validation
       │
       ▼
  2. PreToolUse hooks ◄── NEW (user-defined, declarative)
       │
       ├── blocked? → return HOOK_BLOCKED
       ├── mutated? → update parameters
       │
       ▼
  3. ApprovalGate.check() ◄── EXISTING (risk-based, automatic)
       │
       ├── denied? → return APPROVAL_DENIED
       ├── ask_user? → emit ApprovalRequest
       │
       ▼
  4. Execute tool handler
       │
       ▼
  5. PostToolUse hooks ◄── NEW
       │
       ▼
  6. Return result
```

Hooks run **before** the approval gate. This means hooks can:
- Block tools that would otherwise be auto-approved
- Transform parameters before risk assessment
- Log all tool attempts (even ones that get denied by ApprovalGate later)

Hooks **cannot** override an ApprovalGate denial. The approval system is a security boundary; hooks are a user customization layer.

### 12.2 Hooks vs. Plugin System

The server plugin system (`src/server/plugins/`) handles **channel bridges** — connecting external messaging platforms (Telegram, Slack) to the agent. Hooks are orthogonal:

| Aspect | Plugins | Hooks |
|--------|---------|-------|
| Scope | Channel communication | Agent lifecycle |
| Configuration | TypeScript modules | JSON settings |
| Platform | Server only | All platforms |
| Purpose | Connect external channels | Customize behavior |
| Execution | Long-running (gateway start/stop) | Short-lived (per-event) |

A plugin could register internal hooks for its own lifecycle events, but the two systems don't overlap in purpose.

### 12.3 Hooks vs. EventMsg System

The `EventMsg` system (`src/core/protocol/events.ts`) is the **output** event stream — it flows from agent to UI. Hooks are an **input** interception system — they run at lifecycle points and can influence behavior. They coexist:

- Hook execution can **emit** EventMsgs (e.g., `BackgroundEvent` for hook status)
- Hook events are **not** EventMsgs — they're a separate lifecycle concept
- Some EventMsg types correspond to hook events (e.g., `ToolExecutionStart` → `PreToolUse`), but hooks fire before the event is emitted

## 13. Files to Create

| File | Purpose |
|------|---------|
| `src/core/hooks/types.ts` | Type definitions (HookEventName, HookDefinition, HookResult, etc.) |
| `src/core/hooks/HookRegistry.ts` | Hook registration, config loading, matcher resolution |
| `src/core/hooks/HookExecutor.ts` | Hook execution engine (sequential/concurrent, timeout, error handling) |
| `src/core/hooks/HookDispatcher.ts` | Convenience facade for dispatch points |
| `src/core/hooks/HookLogger.ts` | Logging utility |
| `src/core/hooks/handlers/CommandHookHandler.ts` | Shell command execution |
| `src/core/hooks/handlers/HttpHookHandler.ts` | HTTP POST execution |
| `src/core/hooks/handlers/InternalHookHandler.ts` | Internal TypeScript handler registry |
| `src/core/hooks/createHookInfrastructure.ts` | Factory function for bootstrap |
| `src/core/hooks/index.ts` | Public API exports |
| `src/core/services/hook-services.ts` | ServiceRegistry integration for UI |

## 14. Files to Modify

| File | Change |
|------|--------|
| `src/tools/ToolRegistry.ts` | Add `hookDispatcher` field, insert PreToolUse/PostToolUse calls around execute() |
| `src/core/TaskRunner.ts` | Add `hookDispatcher` field, insert TaskStarted/TaskComplete/TaskFailed/Compaction calls |
| `src/core/registry/AgentSession.ts` | Add `hookDispatcher` field, insert SessionStart/SessionEnd calls |
| `src/core/channels/ChannelManager.ts` | Add `hookDispatcher` field, insert Submission call in onSubmission handler |
| `src/config/types.ts` | Add `hooks?: HooksConfig` to `IAgentConfig` |
| `src/desktop/agent/DesktopAgentBootstrap.ts` | Create hook infrastructure, wire to components |
| `src/server/agent/ServerAgentBootstrap.ts` | Create hook infrastructure, wire to components |
| `src/extension/background/service-worker.ts` | Create hook infrastructure (no command handler) |
| `src/core/services/index.ts` | Register hook services |

## 15. Migration Plan

### Phase 1: Core Hook Engine (Non-Breaking)

Create all files in `src/core/hooks/`. No existing behavior changes. The hook system exists but nothing calls it yet.

**Deliverables:**
- `types.ts`, `HookRegistry.ts`, `HookExecutor.ts`, `HookDispatcher.ts`, `HookLogger.ts`
- All three handlers: `CommandHookHandler.ts`, `HttpHookHandler.ts`, `InternalHookHandler.ts`
- `createHookInfrastructure.ts`, `index.ts`
- Unit tests for registry, executor, and each handler

### Phase 2: Config Integration

Add `hooks` field to `IAgentConfig` and wire config loading/reload.

**Deliverables:**
- Config schema update in `src/config/types.ts`
- Config validation for hook definitions
- Hot-reload support via `AgentConfig.on('hooks')`
- Config documentation

### Phase 3: Dispatch Points — Tool Execution

Wire PreToolUse and PostToolUse hooks into `ToolRegistry.execute()`.

**Deliverables:**
- Modified `ToolRegistry.ts`
- Integration tests: hook blocks tool, hook mutates params, hook observes post-execution
- Verify ApprovalGate still works correctly after hooks

### Phase 4: Dispatch Points — Task Lifecycle

Wire TaskStarted, TaskComplete, TaskFailed, and Compaction hooks.

**Deliverables:**
- Modified `TaskRunner.ts`
- Integration tests: notification on task complete, blocking task completion, context injection after compaction

### Phase 5: Dispatch Points — Session & Channel

Wire SessionStart, SessionEnd, Submission, and remaining events.

**Deliverables:**
- Modified `AgentSession.ts`, `ChannelManager.ts`
- Integration tests: context injection on session start, submission blocking

### Phase 6: Bootstrap Wiring

Wire hook infrastructure into all three platform bootstraps.

**Deliverables:**
- Modified `DesktopAgentBootstrap.ts`, `ServerAgentBootstrap.ts`, extension service-worker
- Service registration for UI management
- End-to-end tests on each platform

## 16. Verification

### Unit Tests

- `HookRegistry`: load, reload, getHooks with matchers, invalid config handling
- `HookExecutor`: sequential blocking, concurrent non-blocking, timeout, error isolation
- `CommandHookHandler`: exit codes (0, 2, 1), stdout parsing, stdin piping, timeout
- `HttpHookHandler`: 2xx, 403, 5xx, timeout, header expansion
- `InternalHookHandler`: handler resolution, config passing, error isolation

### Integration Tests

- **PreToolUse blocking:** Configure hook that blocks `browser_navigate` to `*.evil.com` → verify tool returns HOOK_BLOCKED
- **PreToolUse mutation:** Configure hook that rewrites file paths → verify tool receives mutated params
- **PostToolUse notification:** Configure HTTP hook → verify POST received with tool output
- **TaskComplete blocking:** Configure hook that runs tests → verify task continues if tests fail
- **SessionStart context injection:** Configure hook that echoes project context → verify context appears in session
- **Compaction context injection:** Configure hook → verify context injected after compaction
- **Config hot-reload:** Change hooks config at runtime → verify new hooks take effect
- **Multi-hook ordering:** Two PreToolUse hooks → verify sequential execution, first deny wins
- **Fail-safe:** Hook that crashes → verify agent continues normally

### Manual Verification

- Configure desktop hook that sends OS notification on task complete → verify notification appears
- Configure server hook that POSTs to webhook.site on tool use → verify webhook receives data
- Configure extension HTTP hook → verify it works (no command hooks)
- Check verbose mode shows hook execution details
- Verify hook timeout doesn't block agent (10s+ hook with 3s timeout)

## 17. Future Extensions

These are **not** in scope for the initial implementation but are natural follow-ons:

1. **Hook UI management page** — Settings panel showing configured hooks, execution stats, and test buttons
2. **Hook marketplace** — Shareable hook scripts/configs (like VS Code extensions)
3. **Conditional hooks** — Beyond regex matchers, support JSONPath-style conditions on event context
4. **Hook chains** — Output of one hook feeds into the next (pipeline pattern)
5. **Agent-type hooks** — LLM-based hooks that use a model call for complex decisions (similar to Claude Code's `prompt` hook type)
6. **Webhook verification** — HMAC signature on HTTP hook payloads for security
7. **Hook execution history** — Persistent log of hook executions for debugging
