# BrowserX vs Claudy: Architecture Analysis and Improvement Suggestions

Date: 2026-04-07 (updated)

## Scope

This report compares:

- `browserx`: `/home/rich/dev/airepublic/open_source/s1/browserx`
- `claudy`: `/home/rich/dev/study/claudy`

The goal is not to clone Claudy. BrowserX is a multi-platform in-person general AI agent, while Claudy is a terminal-native coding agent. The useful question is: which Claudy design decisions improve BrowserX's extensibility, operability, and implementation quality without breaking BrowserX's product identity.

## Executive Summary

BrowserX already has a stronger platform abstraction layer than Claudy. Its shared core, platform adapters, channels, scheduler, approval pipeline, MCP manager, and service registry are all good foundations. In that sense, BrowserX is not architecturally weak.

Claudy's advantages are different:

- it has a much richer operator surface around the core engine
- it treats commands, permissions, background tasks, plugins, skills, and remote/bridge flows as first-class subsystems
- it keeps more complexity out of the central query loop by pushing concerns into dedicated loaders, registries, handlers, and state modules
- it has stronger productized workflows for extensibility and runtime control
- it has a far richer tool contract with progress reporting, rendering hooks, concurrency metadata, and permission strategies baked into each tool
- it has compile-time feature flags for dead code elimination and optional subsystem isolation

The main improvement opportunity for BrowserX is therefore not "rewrite the core loop like Claudy". The opportunity is to import Claudy's surrounding architecture:

1. a real command/workflow layer above raw chat
2. a richer tool contract with progress, concurrency, and rendering metadata
3. a richer task model for background and delegated work
4. a more modular permission pipeline with context-specific handlers
5. a stronger plugin/skill loading model with frontmatter and conditional activation
6. centralized operational state with selectors and side-effect handlers
7. a more deliberate runtime feature-flag and lazy-loading strategy
8. better operational surfaces for remote control, diagnostics, and observability
9. streaming tool execution and concurrency orchestration

## Method and Evidence

Primary BrowserX sources reviewed:

- `docs/ARCHITECTURE.md`
- `src/core/RepublicAgent.ts` (1318 lines)
- `src/core/Session.ts` (1836 lines)
- `src/core/TurnManager.ts` (500+ lines)
- `src/core/TurnContext.ts` (200+ lines)
- `src/core/ApprovalManager.ts` (400+ lines)
- `src/tools/ToolRegistry.ts` (340+ lines)
- `src/tools/BaseTool.ts` (400+ lines)
- `src/core/approval/ApprovalGate.ts`
- `src/core/channels/ChannelManager.ts` (240 lines)
- `src/core/messaging/UIChannelClient.ts` (220 lines)
- `src/core/registry/AgentRegistry.ts`
- `src/core/mcp/MCPManager.ts`
- `src/core/skills/SkillRegistry.ts`
- `src/webfront/commands/CommandRegistry.ts`
- `src/config/AgentConfig.ts` (500+ lines)
- `src/core/protocol/types.ts` (385 lines)
- `src/core/session/state/SessionState.ts`
- `src/core/session/state/SessionServices.ts`
- `src/desktop/agent/DesktopAgentBootstrap.ts` (400+ lines)
- `src/server/agent/ServerAgentBootstrap.ts`

Primary Claudy sources reviewed:

- `v2/docs/architecture.md`
- `src/query.ts` (3000+ lines)
- `src/QueryEngine.ts` (3000+ lines)
- `src/Tool.ts` (3000+ lines)
- `src/tools.ts` (2000+ lines)
- `src/commands.ts` (758 lines)
- `src/bridge/bridgeMain.ts` (3001 lines)
- `src/state/AppStateStore.ts` (570 lines)
- `src/state/store.ts`
- `src/state/selectors.ts`
- `src/state/onChangeAppState.ts`
- `src/tasks/types.ts`
- `src/tasks/LocalMainSessionTask.ts`
- `src/hooks/useCanUseTool.tsx` (26000+ lines)
- `src/hooks/toolPermission/PermissionContext.ts`
- `src/hooks/toolPermission/interactiveHandler.ts`
- `src/hooks/toolPermission/coordinatorHandler.ts`
- `src/hooks/toolPermission/swarmWorkerHandler.ts`
- `src/skills/loadSkillsDir.ts`
- `src/utils/plugins/loadPluginCommands.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/StreamingToolExecutor.ts`
- `src/tools/BashTool/BashTool.tsx`
- `src/tools/FileEditTool/FileEditTool.ts`
- `src/tools/GrepTool/GrepTool.ts`
- `src/shims/bun-bundle.ts`

Repo shape snapshot:

- BrowserX: `src/core` has 288 files, `src/tools` has 100 files, about 263 test/spec files, about 801 TS/TSX/Svelte/Rust files
- Claudy: `src+v2` has 2162 files, `src/commands` has 209 files, `src/tools` has 184 files, `src/tasks` has 12 task-specific files, about 2074 TS/TSX files

---

## Part 1: High-Level Architectural Differences

### 1.1 Core Topology: BrowserX is Platform-First, Claudy is Workflow-First

BrowserX centers architecture on platform independence:

- `docs/ARCHITECTURE.md` describes a shared core consumed by extension, desktop, and server
- `src/core/channels`, `src/core/storage`, `src/core/mcp`, `src/core/services`, `src/core/registry` reinforce this
- Platform-specific bootstraps: `DesktopAgentBootstrap.ts`, `ServerAgentBootstrap.ts`, `service-worker.ts`
- Compile-time `__BUILD_MODE__` branching: `'extension' | 'desktop' | 'server'`

Claudy centers architecture on user workflow surfaces:

- `src/commands.ts` — command catalog and registry
- `src/tasks/*` — typed task families with lifecycle management
- `src/bridge/*` — remote agent execution
- `src/state/*` — centralized operational state
- `src/hooks/toolPermission/*` — context-aware permission handlers
- `src/skills/*` — skill loading with frontmatter and conditional activation
- `src/utils/plugins/*` — plugin command loading and namespacing

Implication:

- BrowserX is better at "run the same agent on multiple runtimes"
- Claudy is better at "make the agent operable, scriptable, extensible, and safe in many day-2 scenarios"

### 1.2 Central Complexity Placement

BrowserX complexity is concentrated in a few large core classes:

- `Session.ts` (~1836 lines) — persistence, history, compaction, title gen, event emission, task coordination, turn state
- `RepublicAgent.ts` (~1318 lines) — main orchestrator, SQ/EQ queues, model switching, tool coordination
- `TurnManager.ts` (~500 lines) — turn execution, streaming, retry
- `TurnContext.ts` (~200 lines) — per-turn configuration

Claudy also has large files, but more concerns are split outward into dedicated registries, handlers, context builders, and loaders:

- command catalog in `src/commands.ts` plus per-command modules under `src/commands/*`
- tool definitions in `src/Tool.ts` (3000+ lines for the type system alone) but execution in `src/services/tools/*`
- permission flow in `src/hooks/useCanUseTool.tsx` plus 3 context-specific handlers
- task types under `src/tasks/*` with framework in `src/utils/task/framework.ts`
- plugin/skill loaders under `src/skills/*` and `src/utils/plugins/*`
- state management in `src/state/*` with selectors and side-effect handlers
- query loop in `src/query.ts` with deps injection via `QueryDeps`

Implication:

- BrowserX has better conceptual grouping at subsystem level, but several classes are becoming "gravity wells"
- Claudy's decomposition makes extension work easier because more boundaries are product-domain boundaries, not only technical boundaries

### 1.3 Agent Core Loop Comparison

**BrowserX (SQ/EQ Pattern):**

```
User → Submission Queue → RepublicAgent.handleSubmission()
  → Session.processUserTurn()
  → TurnManager.runTurn()
    → ModelClient.stream()
    → Parse ResponseItems (text, tool calls, reasoning)
    → Tool calls → ToolRegistry.execute() → ApprovalGate.check()
    → Emit Events → EventDispatcher → ChannelManager → UI
```

**Claudy (Generator Pattern):**

```
User → REPL/SDK → query(messages, deps)
  → queryModelWithStreaming() yields StreamEvents
  → Tool calls → toolOrchestration.runTools() (generator)
    → Partition: read-only tools parallel, writes serial
    → StreamingToolExecutor: execute as they stream
    → checkPermissions() → useCanUseTool() → handler
  → autoCompactIfNeeded() if near token budget
  → Yield events to caller for rendering
```

Key differences:

- **Concurrency**: Claudy partitions tools by safety (`isConcurrencySafe`) and runs read-only tools in parallel. BrowserX executes tools sequentially.
- **Streaming execution**: Claudy's `StreamingToolExecutor` begins tool execution while the model is still streaming. BrowserX waits for complete tool call before executing.
- **Dependency injection**: Claudy injects `QueryDeps` (model caller, compactor, UUID generator) for testability. BrowserX uses class-level DI via constructor.
- **Compaction**: Claudy has `autoCompactIfNeeded()` triggered within the query loop. BrowserX has `CompactService` triggered externally.

---

## Part 2: Structural Differences (Deep Analysis)

### 2.1 Tool System

This is one of the largest gaps between the two systems.

**Claudy Tool Contract** (`src/Tool.ts`, 40+ properties per tool):

```typescript
type Tool<Input, Output, P> = {
  name: string
  aliases?: string[]
  searchHint?: string  // 3-10 words for ToolSearch keyword matching

  // Core execution
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  inputSchema: ZodType  // Zod schema, compile-time validated
  outputSchema?: ZodType

  // Validation & permissions
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>

  // Concurrency & safety metadata
  isConcurrencySafe(input): boolean  // Can run in parallel with other tools
  isReadOnly(input): boolean         // No side effects
  isDestructive?(input): boolean     // Irreversible ops (delete, send)
  interruptBehavior?(): 'cancel' | 'block'

  // Rendering (6+ methods)
  renderToolUseMessage(input, options): ReactNode       // Before execution
  renderToolResultMessage?(output, progress, options): ReactNode  // After completion
  renderToolUseProgressMessage?(progress, options): ReactNode     // During execution
  renderToolUseErrorMessage?(result, options): ReactNode          // On error
  renderToolUseRejectedMessage?(input, options): ReactNode        // Permission denied
  renderGroupedToolUse?(toolUses[], options): ReactNode           // Batch display

  // Progress reporting
  onProgress?: ToolCallProgress<P>  // Typed progress callback

  // Persistence
  maxResultSizeChars: number  // Threshold for disk persistence

  // Deferred loading
  shouldDefer?: boolean    // Lazy-load via ToolSearch
  alwaysLoad?: boolean     // Never defer

  // Display hints
  userFacingName(input?): string
  getToolUseSummary?(input?): string
  getActivityDescription?(input?): string
  isSearchOrReadCommand?(input): { isSearch, isRead, isList? }

  // Auto-classifier integration
  toAutoClassifierInput(input): unknown
  preparePermissionMatcher?(input): Promise<(pattern: string) => boolean>
}
```

**Claudy Tool Factory** (`buildTool()`):

```typescript
const GrepTool = buildTool({
  name: 'Grep',
  searchHint: 'search file contents with regex (ripgrep)',
  maxResultSizeChars: 20_000,
  strict: true,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  async call(input, context, canUseTool, parentMessage, onProgress) { ... },
  renderToolUseMessage(input, options) { ... },
  renderToolResultMessage(output, progress, options) { ... },
})
```

**Claudy Tool Execution Pipeline** (`src/services/tools/`):

1. `toolOrchestration.ts` — partitions tool calls into batches: read-only parallel, writes serial
2. `toolExecution.ts` — validates input, checks permissions, runs tool, applies result budget
3. `StreamingToolExecutor.ts` — begins execution while model still streaming, buffers results

**Claudy ToolUseContext** (30+ fields passed to every tool):

```typescript
type ToolUseContext = {
  options: {
    commands: Command[]
    tools: Tools
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    refreshTools?: () => Tools
    agentDefinitions: AgentDefinitionsResult
    ...
  }
  abortController: AbortController
  readFileState: FileStateCache  // LRU cache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  messages: Message[]
  toolDecisions?: Map<string, { source, decision, timestamp }>
  contentReplacementState?: ContentReplacementState  // Result budget tracking
  ...
}
```

**BrowserX Tool Contract** (`src/tools/BaseTool.ts` + `ToolRegistry.ts`):

```typescript
type ToolDefinition =
  | { type: 'function', function: ResponsesApiTool }
  | { type: 'local_shell' }
  | { type: 'web_search' }
  | { type: 'custom', custom: FreeformTool }

class ToolRegistry {
  register(tool: ToolDefinition, handler: ToolHandler, riskAssessor?: IRiskAssessor)
  execute(toolName: string, params: Record<string, any>, context: ToolContext): Promise<any>
  setApprovalGate(gate: ApprovalGate)
}
```

**Gap Analysis:**

| Aspect | Claudy | BrowserX | Gap |
|--------|--------|----------|-----|
| Properties per tool | 40+ | ~5 | Large |
| Input validation | Zod schema + validateInput() | JSON schema only | Medium |
| Concurrency metadata | `isConcurrencySafe()`, `isReadOnly()`, `isDestructive()` | None | Large |
| Progress reporting | Typed `onProgress` callback per tool | Event-based (ExecCommandBegin/End) | Medium |
| Rendering hooks | 6+ render methods | None (events only) | Large |
| Permission strategy | Per-tool `checkPermissions()` + `preparePermissionMatcher()` | External ApprovalGate only | Medium |
| Deferred loading | `shouldDefer` + ToolSearch | None | Medium |
| Result persistence | `maxResultSizeChars` thresholds | None | Medium |
| Concurrency execution | Read-only parallel, writes serial | Sequential only | Large |
| Streaming execution | `StreamingToolExecutor` | Wait for complete call | Medium |

### 2.2 Command System

**Claudy Command Architecture** (`src/commands.ts`):

Three command types with distinct execution models:

```typescript
type PromptCommand = {
  type: 'prompt'
  progressMessage: string
  getPromptForCommand(args, context): Promise<ContentBlockParam[]>
  context?: 'inline' | 'fork'  // fork = runs as sub-agent
  agent?: string
  model?: string
  effort?: EffortValue
  allowedTools?: string[]
  paths?: string[]  // Conditional activation (gitignore-style)
  disableModelInvocation?: boolean
}

type LocalCommand = {
  type: 'local'
  load: () => Promise<{ call: LocalCommandCall }>  // Lazy-loaded
}

type LocalJSXCommand = {
  type: 'local-jsx'
  load: () => Promise<{ call: LocalJSXCommandCall }>  // Renders React/Ink UI
}
```

Source precedence hierarchy:

1. Bundled skills (highest priority)
2. Built-in plugin skills
3. Skill directory commands (`.claude/skills/`)
4. Workflow commands
5. Plugin commands
6. Plugin skills
7. Built-in commands (lowest priority)

Remote safety enforcement:

```typescript
const REMOTE_SAFE_COMMANDS: Set<Command>   // Safe in --remote mode
const BRIDGE_SAFE_COMMANDS: Set<Command>   // Safe from mobile/web bridge
function isBridgeSafeCommand(cmd): boolean // Prompt = always safe, local-jsx = blocked
```

Conditional skill activation:

```typescript
// Skills with `paths` frontmatter are dormant until files match
// e.g., paths: "src/**/*.{ts,tsx}"
// Activated when Read/Glob touches matching files
activateConditionalSkillsForPaths(filePaths, cwd)
```

**BrowserX Command System** (`src/webfront/commands/`):

- `CommandRegistry.ts` — simple singleton registry
- `builtinCommands.ts` — minimal built-ins: `/new`, `/help`, `/settings`
- Skill commands mapped through UI client
- No command types, no lazy loading, no source precedence, no remote safety

**Gap Analysis:**

| Aspect | Claudy | BrowserX | Gap |
|--------|--------|----------|-----|
| Command types | 3 (prompt, local, local-jsx) | 1 (simple handler) | Large |
| Source precedence | 7-level hierarchy | None | Large |
| Built-in commands | ~50+ | ~3 | Large |
| Remote safety | REMOTE_SAFE + BRIDGE_SAFE sets | None | Medium |
| Conditional activation | paths frontmatter (gitignore-style) | None | Medium |
| Lazy loading | `load: () => Promise<...>` | None | Medium |
| Memoized discovery | `memoize()` with explicit cache invalidation | None | Small |

### 2.3 Task System

**Claudy Task Architecture** (`src/tasks/`):

7 concrete task types with shared base:

```typescript
type TaskStateBase = {
  id: string  // Prefixed: 'b' (bash), 'a' (agent), 'r' (remote), 't' (teammate), 'w' (workflow), 'm' (monitor)
  type: TaskType
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  outputFile: string    // Disk-persisted output
  outputOffset: number  // Current read position
  notified: boolean     // Completion notification guard
}

// Concrete types:
type LocalShellTaskState    // Background bash commands, stall detection
type LocalAgentTaskState    // Sub-agents, main session backgrounding
type RemoteAgentTaskState   // Remote Claude Code running (CCR)
type InProcessTeammateTaskState  // Swarm teammates in same process
type LocalWorkflowTaskState // Workflow execution
type MonitorMcpTaskState    // MCP stream monitoring
type DreamTaskState         // Future feature
```

Key capabilities:

- **Disk output persistence**: `DiskTaskOutput` class with append queue, flush drain, 5GB watchdog
- **Offset-based delta reads**: `getTaskOutputDelta(taskId, offset)` — tail semantics, non-blocking
- **Task notifications**: XML format injected into message queue on completion
- **Stall detection**: Shell tasks detect prompt-like output (waiting for interactive input)
- **Background/foreground transitions**: `isBackgrounded` flag, `foregroundMainSessionTask()`
- **Progress tracking**: `progress.toolUseCount`, `progress.tokenCount`, `progress.recentActivities`
- **Eviction**: Terminal + notified tasks auto-evict after `STOPPED_DISPLAY_MS`
- **Polling**: `POLL_INTERVAL_MS = 1000` for output and state checks

```typescript
// Task notification format:
<task-notification>
  <task-id>{taskId}</task-id>
  <status>completed|failed|killed</status>
  <summary>human-readable description</summary>
</task-notification>
```

**BrowserX Task System** (`src/core/tasks/`, `src/core/taskmanager/`):

- `TaskRunner` — generic task execution
- `RegularTask`, `SessionTask` — two task types
- Task store under `src/core/taskmanager`
- No disk output persistence, no offset reads, no stall detection
- No background/foreground transitions
- No typed progress model
- No eviction or polling framework

**Gap Analysis:**

| Aspect | Claudy | BrowserX | Gap |
|--------|--------|----------|-----|
| Task types | 7 typed families | 2 generic types | Large |
| Disk persistence | DiskTaskOutput with 5GB watchdog | None | Large |
| Delta reads | Offset-based tail semantics | None | Large |
| Stall detection | Prompt-like output detection | None | Medium |
| Background/foreground | Explicit transitions, Ctrl+B | None | Large |
| Progress model | toolUseCount, tokenCount, activities | None | Large |
| Eviction/polling | Auto-evict + 1s poll interval | None | Medium |
| Notifications | XML injection into message queue | Events only | Medium |

### 2.4 State Architecture

**Claudy Centralized State** (`src/state/`):

```typescript
// AppState (~80+ fields):
type AppState = {
  // Permission & tool context
  toolPermissionContext: ToolPermissionContext
  denialTracking?: DenialTrackingState

  // UI state
  verbose: boolean
  expandedView: 'none' | 'tasks' | 'teammates'
  footerSelection: FooterItem | null

  // Model & settings
  mainLoopModel: ModelSetting
  settings: SettingsJson

  // Bridge/remote (always-on fields)
  replBridgeEnabled: boolean
  replBridgeConnected: boolean
  replBridgeSessionActive: boolean

  // Tasks & collaboration
  tasks: { [taskId: string]: TaskState }
  agentNameRegistry: Map<string, AgentId>
  foregroundedTaskId?: string

  // MCP & plugins
  mcp: { clients, tools, commands, resources }
  plugins: { enabled, disabled, errors, needsRefresh }

  // Speculation & prediction
  speculation: SpeculationState
  promptSuggestion: { text, promptId, shownAt, acceptedAt }
  ...
}
```

Store implementation (pub/sub):

```typescript
type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}
```

Key patterns:

- **Selectors**: Pure functions returning existing references for `Object.is()` comparison
- **React integration**: `useAppState(selector)` via `useSyncExternalStore`
- **Centralized side effects**: `onChangeAppState({ newState, oldState })` — single choke point for persistence, credential cache invalidation, CCR/SDK sync
- **Immutable top-level, mutable nested**: `tasks`, `mcp`, `plugins` objects mutated in-place (function types can't be frozen)

**BrowserX Distributed State:**

- `AgentConfig` singleton — config and provider state
- `SessionState` — pure data container per session (history, tokens, tabId)
- `ActiveTurn` — turn-scoped state (turnId, streaming flag, pending approvals)
- `SessionServices` — lazily initialized services
- Svelte stores in `src/webfront/stores/` — UI state
- No centralized AppState, no selectors, no unified side-effect handler

**Gap Analysis:**

| Aspect | Claudy | BrowserX | Gap |
|--------|--------|----------|-----|
| Centralized state | ~80+ field AppState | Distributed across singletons | Large |
| Store pattern | Pub/sub with `subscribe()` | Observer on AgentConfig, Svelte stores | Medium |
| Selectors | Pure functions, `Object.is()` | None | Medium |
| Side-effect handler | `onChangeAppState()` single choke point | Scattered | Large |
| React/UI integration | `useSyncExternalStore` | Svelte stores (good for Svelte) | N/A |
| Cross-cutting visibility | Single operational picture | Requires multiple service queries | Large |

### 2.5 Permission System

**Claudy Permission Architecture** (deeply layered):

Permission modes:

```typescript
// Internal: 'default' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'
// External (user-visible): 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk'
// Externalization: 'auto' externalizes to 'default' (internal-only mode)
```

Permission decision flow:

```
1. Tool.checkPermissions(input, context) → tool-specific logic
2. executePermissionRequestHooks() → hook-based override
3. Classifier check (if BASH_CLASSIFIER enabled) → ML auto-approve
4. Context-specific handler:
   ├─ interactiveHandler → REPL: show dialog, race classifier
   ├─ coordinatorHandler → coordinator: await hooks+classifier before dialog
   └─ swarmWorkerHandler → teammate: classifier → mailbox → leader
```

`PermissionContext` (generic, decoupled from React):

```typescript
type PermissionContext = {
  tool, input, toolUseContext, assistantMessage, toolUseID

  // Atomic resolve-once guard (prevents race condition double-resolution)
  resolveIfAborted(resolve)
  cancelAndAbort(feedback?, isAbort?)

  // Fast paths
  tryClassifier(pendingCheck, updatedInput)
  runHooks(mode, suggestions, updatedInput)

  // Approval paths
  handleUserAllow(updatedInput, updates, feedback?)
  handleHookAllow(finalInput, updates)

  // Persistence
  persistPermissions(updates: PermissionUpdate[])
}
```

`ResolveOnce` guard for race conditions:

```typescript
const { resolve: resolveOnce, claim } = createResolveOnce(resolve)
// Multiple async paths (hooks, classifier, user) can trigger
if (!claim()) return  // Lost the race
resolveOnce(decision)  // Won the race
```

**BrowserX Permission Architecture:**

```
Tool Call → ApprovalGate.check()
  → Risk Assessment (StaticRiskAssessor, DomToolRiskAssessor, etc.)
  → Context Enhancement (DomainSensitivityEnhancer, SemanticElementEnhancer)
  → PolicyRulesEngine evaluation
  → ApprovalManager.requestApproval() if needed
```

Approval modes: `'aggressive' | 'balanced' | 'defensive'`

Strengths:

- Risk assessor/enhancer pipeline is more systematic than Claudy's
- Domain sensitivity detection (finance/auth contexts)
- Session memory for trusted domains

Weaknesses vs Claudy:

- No context-specific permission handlers (all contexts use same path)
- No race condition guards (ResolveOnce)
- No classifier-assisted fast paths
- No per-tool permission matching patterns
- Approval modes are threshold configs, not runtime behavior contracts
- No special handling for remote/worker/bridge/coordinator contexts

### 2.6 Plugin and Skill Loading

**Claudy Skill System** (`src/skills/loadSkillsDir.ts`):

Source hierarchy:

```typescript
const sources = [
  'policySettings',      // Managed (.claude/skills/)
  'userSettings',        // Home directory (~/.claude/skills/)
  'projectSettings',     // Project root (./.claude/skills/)
  'commands_DEPRECATED', // Legacy .claude/commands/
]
```

Directory format:

```
.claude/skills/
├── verify/
│   └── SKILL.md        # One SKILL.md per directory
├── format/
│   └── SKILL.md
└── lint/
    └── SKILL.md
```

Frontmatter schema:

```yaml
---
description: Lint TypeScript files
when-to-use: When user asks to check code quality
argument-hint: <file-path>
allowed-tools: Bash, FileRead
paths: "src/**/*.{ts,tsx}"   # Conditional activation
model: inherit
user-invocable: true
context: fork                # Run as sub-agent
agent: code-reviewer
effort: medium
hooks:
  pre_tool_use:
    - matcher: Bash
      command: validate-command.sh
---
```

Plugin command namespacing:

```typescript
// File: plugin-root/commands/a/b/c.md
// Name: pluginName:a:b:c
```

Conditional skill activation:

```typescript
// Skills with `paths` frontmatter dormant until files match
activateConditionalSkillsForPaths(filePaths, cwd)
// Uses `ignore` lib (gitignore semantics)
// Activated at tool use time (Read/Glob report touched files)
```

**BrowserX Skill System** (`src/core/skills/SkillRegistry.ts`):

- Discovery, invocation, metadata caching, trust/invocation mode
- No directory conventions, no frontmatter parsing
- No namespacing, no source precedence
- No conditional activation, no collision protection
- No command generation from skills

### 2.7 Feature Flags and Lazy Loading

**Claudy Feature Flag System** (`src/shims/bun-bundle.ts`):

```typescript
import { feature } from 'bun:bundle'

// ~30 compile-time flags:
FEATURE_FLAGS = {
  PROACTIVE: envBool('CLAUDE_CODE_PROACTIVE', false),
  COORDINATOR_MODE: envBool('CLAUDE_CODE_COORDINATOR_MODE', false),
  BASH_CLASSIFIER: envBool('CLAUDE_CODE_BASH_CLASSIFIER', false),
  TRANSCRIPT_CLASSIFIER: envBool('CLAUDE_CODE_TRANSCRIPT_CLASSIFIER', false),
  VOICE_MODE: envBool('CLAUDE_CODE_VOICE_MODE', false),
  // ...
}

// Usage — disabled branches stripped from binary:
const VoiceProvider = feature('VOICE_MODE')
  ? require('../context/voice.js').VoiceProvider
  : ({ children }) => children

// Permission modes conditionally include 'auto':
export const PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  ...(feature('TRANSCRIPT_CLASSIFIER') ? ['auto'] : [])
]
```

Lazy imports for circular dependency breaking:

```typescript
const teammateUtils = require('../utils/teammate.js')
```

Dynamic imports for heavy modules:

```typescript
const { PERMISSION_MODES } = await import('../types/permissions.js')
```

**BrowserX Feature Flags:**

- `__BUILD_MODE__` compile-time platform branching (good for platforms)
- No feature-level gating within a platform
- No dead code elimination for optional subsystems
- No dynamic import boundaries for heavy optional features

### 2.8 Startup and Initialization

**Claudy Startup** (aggressive parallelization):

```
1. Before imports (3 side effects in parallel):
   - startMdmRawRead() — OS policy checks
   - startKeychainPrefetch() — Credential prefetch
   
2. Module imports (~135ms, parallel with above)

3. Initialization:
   - ensureKeychainPrefetchCompleted() — Wait for credentials
   - Load config, telemetry, OAuth, plugins (parallel where possible)
   - Initialize GrowthBook, permissions

4. Session start:
   - Bootstrap session state
   - Process hooks (setup, session_start)
```

**BrowserX Startup** (platform-specific bootstraps):

```
Desktop:
1. new DesktopAgentBootstrap()
2. initialize():
   - AgentConfig.getInstance()
   - configurePromptWithPlatformInfo()  // Must happen BEFORE agent.initialize()
   - initializeStorageProvider()
   - TauriChannel creation
   - AgentRegistry with factories
   - ChannelManager.registerChannel()
   - Scheduler + skill registry setup
   - Auth manager initialization
```

BrowserX's platform-specific bootstraps are clean and modular. Claudy's startup is more aggressively parallelized but less modular.

---

## Part 3: What BrowserX Is Already Doing Better

These parts should be preserved and treated as non-regression constraints:

### 3.1 Cross-Platform Architecture

BrowserX's shared-core plus adapter model is better than Claudy's for a browser/desktop/server product family. The `ChannelAdapter` abstraction, platform bootstraps, and `__BUILD_MODE__` branching are all stronger than anything Claudy has.

### 3.2 Service Registry and Channel Abstraction

`ChannelManager` + `ServiceRegistry` + `UIChannelClient` is a strong architectural seam. The RPC pattern (`serviceRequest()` → ServiceResponse events) is clean. Claudy often solves equivalent problems in more product-specific ways.

### 3.3 Approval Policy Core

BrowserX's `ApprovalGate` + `PolicyRulesEngine` + assessor/enhancer pipeline is more systematic than Claudy's more distributed permission handling. The risk assessment model with domain sensitivity and semantic element enhancers is ahead of Claudy.

### 3.4 SQ/EQ Protocol Design

BrowserX's Submission Queue / Event Queue pattern with typed `Op` and `EventMsg` unions is a clean concurrent protocol. The 40+ event types and 8+ operation types create a well-defined contract between frontend and backend.

### 3.5 Scheduler and Server-Mode Separation

BrowserX already has first-class scheduler and server packages. Claudy has strong bridge/remote support, but BrowserX's foundation is more general.

### 3.6 DOM/Browser Automation

BrowserX's `DomService` with CDP integration, frame-scoped node IDs, shadow DOM traversal, and serialized DOM snapshots is domain-specific strength that has no equivalent in Claudy.

---

## Part 4: Concrete BrowserX Improvement Suggestions

Priority is based on impact vs implementation risk.

### Priority 1: Build a Real Command/Workflow Subsystem

**Reason:** Highest leverage, low architectural risk, directly imports one of Claudy's strongest product decisions.

**Current state:** BrowserX has `CommandRegistry` as a simple singleton with 3 built-ins (`/new`, `/help`, `/settings`).

**Suggested shape:**

```typescript
// Command types (import from Claudy):
type PromptCommand = {
  type: 'prompt'
  getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlock[]>
  context?: 'inline' | 'fork'  // fork = sub-agent execution
  agent?: string
  model?: string
  allowedTools?: string[]
  paths?: string[]  // Conditional activation
}

type LocalCommand = {
  type: 'local'
  load: () => Promise<{ call: LocalCommandCall }>  // Lazy-loaded
}

type ServiceCommand = {
  type: 'service'
  serviceTarget: string
  params: Record<string, unknown>
}

// Command metadata:
type Command = CommandBase & (PromptCommand | LocalCommand | ServiceCommand)

type CommandBase = {
  name: string
  aliases?: string[]
  description: string
  source: 'builtin' | 'skill' | 'plugin' | 'mcp'
  isEnabled?: () => boolean
  isHidden?: boolean
  argumentHint?: string
  whenToUse?: string
}
```

Source precedence:

1. Built-in commands (highest priority)
2. Policy-managed skills
3. Project skills
4. User skills
5. Plugin commands
6. MCP commands (lowest priority)

Remote safety:

```typescript
const REMOTE_SAFE_COMMANDS: Set<Command>  // Safe in server mode
const CHANNEL_SAFE_COMMANDS: Set<Command> // Safe from external channels
```

Initial command set:

| Command | Type | Purpose |
|---------|------|---------|
| `/new` | local | New session |
| `/help` | local | Show help |
| `/settings` | local | Open settings |
| `/sessions` | service | List/switch sessions |
| `/tasks` | service | List/inspect tasks |
| `/approvals` | service | Approval queue and history |
| `/mcp` | service | MCP connections and tools |
| `/skills` | local | List/manage skills |
| `/scheduler` | service | Scheduler jobs |
| `/doctor` | service | Diagnostics |
| `/config` | service | Runtime config |
| `/compact` | local | Manual history compaction |

### Priority 2: Enrich Tool Contract with Runtime Metadata

**Reason:** Enables concurrent tool execution, progress reporting, and smarter approval integration. Builds on existing `BaseTool` without replacing it.

**Current state:** BrowserX tools are `ToolDefinition` + `ToolHandler` pairs with external risk assessors.

**Suggested additions to tool registration:**

```typescript
interface ToolRuntimeMetadata {
  // Concurrency & safety
  isConcurrencySafe?: (params: Record<string, any>) => boolean
  isReadOnly?: (params: Record<string, any>) => boolean
  isDestructive?: (params: Record<string, any>) => boolean

  // Progress reporting
  progressType?: 'streaming' | 'polling' | 'none'
  onProgress?: (progress: ToolProgress) => void

  // Approval strategy hint
  approvalStrategy?: 'auto' | 'ask' | 'deny' | 'inherit'
  checkPermissions?: (params: Record<string, any>, context: ToolContext) => PermissionResult

  // Result handling
  maxResultSizeChars?: number  // Threshold for disk persistence
  resultFormatter?: (result: any) => string  // UI display formatter

  // Platform constraints
  platforms?: ('extension' | 'desktop' | 'server')[]
  requiresTab?: boolean

  // Deferred loading
  shouldDefer?: boolean
  searchHint?: string
}
```

**Tool concurrency orchestration** (new subsystem):

```typescript
// In TurnManager or new ToolOrchestrator:
function partitionToolCalls(calls: ToolCall[], registry: ToolRegistry): ToolBatch[] {
  const readOnly = calls.filter(c => registry.getMeta(c.name)?.isReadOnly?.(c.params))
  const mutating = calls.filter(c => !registry.getMeta(c.name)?.isReadOnly?.(c.params))

  return [
    { calls: readOnly, parallel: true },   // Run concurrently
    ...mutating.map(c => ({ calls: [c], parallel: false }))  // Run serially
  ]
}
```

### Priority 3: Introduce Typed Task Families

**Reason:** BrowserX already has task execution logic, so this builds on existing assets. It will pay off in A2A, scheduler, server mode, and UI transparency.

**Suggested task state model:**

```typescript
type TaskStateBase = {
  id: string
  type: TaskType
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  description: string
  startTime: number
  endTime?: number
  outputFile?: string    // Disk-persisted output path
  outputOffset?: number  // Current read position for delta reads
  notified: boolean      // Completion notification dedup guard
  isBackgrounded: boolean
  channelId?: string     // Which channel spawned this task
}

// Typed families:
type InteractiveSessionTask = TaskStateBase & {
  type: 'interactive_session'
  sessionId: string
  tabId?: number
  agentId: string
}

type BackgroundAgentTask = TaskStateBase & {
  type: 'background_agent'
  agentId: string
  prompt: string
  progress?: {
    toolUseCount: number
    tokenCount: number
    lastActivity?: string
  }
  result?: any
  abortController?: AbortController
}

type ScheduledTask = TaskStateBase & {
  type: 'scheduled'
  scheduleId: string
  cronExpression: string
  lastRunTime?: number
  nextRunTime?: number
}

type BrowserAutomationTask = TaskStateBase & {
  type: 'browser_automation'
  tabId: number
  steps: AutomationStep[]
  currentStep: number
}

type RemoteServiceTask = TaskStateBase & {
  type: 'remote_service'
  endpoint: string
  method: string
}

type A2AWorkerTask = TaskStateBase & {
  type: 'a2a_worker'
  a2aSessionId: string
  peerId: string
}
```

**Disk output persistence** (import from Claudy):

```typescript
class DiskTaskOutput {
  constructor(taskId: string)
  append(content: string): void     // Queue write
  flush(): Promise<void>            // Wait for drain
  cancel(): void                    // Clear queue
}

async function getTaskOutputDelta(
  taskId: string,
  offset: number
): Promise<{ content: string; newOffset: number }>

const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024  // 5GB watchdog
```

**Task lifecycle framework:**

```typescript
function registerTask(task: TaskState, dispatcher: EventDispatcher): void
function updateTaskState<T extends TaskState>(taskId: string, updater: (task: T) => T): void
async function pollTasks(getState, setState): Promise<void>  // 1s interval
const STOPPED_DISPLAY_MS = 3_000  // Grace period before eviction
```

### Priority 4: Split Approval Scoring from Approval Interaction

**Reason:** BrowserX's scoring core is already good. The missing piece is runtime behavior across contexts.

**Suggested refactor:**

```
Current:  ApprovalGate → PolicyRulesEngine → ApprovalManager (single path)

Proposed: ApprovalGate → PolicyRulesEngine → ApprovalOrchestrator
                                                ├─ InteractiveHandler (sidepanel/desktop)
                                                ├─ ServerHandler (API/webhook callback)
                                                ├─ BackgroundHandler (auto-approve or queue)
                                                ├─ SchedulerHandler (policy-based)
                                                └─ A2AHandler (peer delegation)
```

Import Claudy's `ResolveOnce` guard pattern:

```typescript
function createResolveOnce<T>(resolve: (value: T) => void) {
  let claimed = false
  return {
    claim: () => { if (claimed) return false; claimed = true; return true },
    resolve: (value: T) => { if (claim()) resolve(value) }
  }
}
```

Permission modes as runtime contracts (not just threshold configs):

```typescript
type ApprovalMode =
  | 'balanced'             // Ask for non-trivial (current default)
  | 'plan'                 // Show plan, ask once at end
  | 'yolo'                 // Auto-approve everything
  | 'remote-supervised'    // Queue for remote approval
  | 'background-worker'    // Auto-deny destructive, auto-approve safe
  | 'a2a-delegated'        // Peer-defined policy
```

### Priority 5: Expand Skill/Plugin Loading Pipeline

**Reason:** Needed before the ecosystem becomes large. Easier to do before many incompatible conventions are shipped.

**Suggested additions:**

Source precedence model:

```
built-in > policy-managed > project > user > imported/plugin
```

Directory conventions:

```
.browserx/skills/
├── scrape-data/
│   └── SKILL.md          # One SKILL.md per directory
├── fill-form/
│   └── SKILL.md
└── review-page/
    └── SKILL.md
```

Frontmatter schema (adapted from Claudy):

```yaml
---
description: Scrape structured data from web pages
when-to-use: When user asks to extract data from a website
argument-hint: <url>
allowed-tools: browser_dom, browser_navigation, browser_data_extraction
paths: null  # Always available (no conditional activation)
model: inherit
user-invocable: true
context: inline
approval-mode: balanced
platforms: [extension, desktop]
---
```

Namespaced identifiers for plugins:

```typescript
// pluginName:skillName
// e.g., "commerce:checkout-flow"
```

Collision diagnostics:

```typescript
function detectCollisions(skills: Command[]): Collision[] {
  // Warn on duplicate names from different sources
  // Higher-precedence source wins silently
  // Log collision for diagnostics command
}
```

### Priority 6: Centralized Operational State

**Reason:** BrowserX has complex runtime state but no unified operational picture.

**Suggested shape** (adapted for BrowserX's multi-platform context):

```typescript
type AgentOperationalState = {
  // Sessions
  sessions: Map<string, SessionSummary>
  activeSessionId?: string

  // Tasks
  tasks: Map<string, TaskState>
  foregroundedTaskId?: string

  // Channels
  channels: Map<string, ChannelStatus>

  // Approval
  pendingApprovals: Map<string, ApprovalRequest>
  recentDecisions: ApprovalDecision[]

  // MCP
  mcpConnections: Map<string, MCPConnectionStatus>
  mcpTools: Map<string, MCPToolInfo>

  // Scheduler
  schedulerJobs: Map<string, SchedulerJobStatus>

  // Skills/Plugins
  loadedSkills: Map<string, SkillInfo>
  loadedPlugins: Map<string, PluginInfo>

  // Model
  currentModel: string
  modelAuthStatus: 'authenticated' | 'expired' | 'missing'

  // Diagnostics
  lastError?: { message: string, timestamp: number }
  uptime: number
}
```

**Store pattern** (Svelte-compatible):

```typescript
// Use Svelte stores instead of React's useSyncExternalStore
import { writable, derived } from 'svelte/store'

const operationalState = writable<AgentOperationalState>(initialState)

// Derived selectors:
const activeTasks = derived(operationalState, $s =>
  Object.values($s.tasks).filter(t => t.status === 'running')
)

const pendingApprovalCount = derived(operationalState, $s =>
  $s.pendingApprovals.size
)
```

**Centralized side-effect handler:**

```typescript
operationalState.subscribe(($new, $old) => {
  // Permission mode change → notify channels
  // Model change → update settings
  // Settings change → invalidate credential caches
  // Task completion → send notification
})
```

### Priority 7: Create Operational Diagnostics Layer

**Reason:** BrowserX already has complex runtime state but limited operator tooling.

**Suggested `/doctor` command output:**

```
Session: active (session_abc123)
Model: openai:gpt-4o (authenticated)
Tab: #42 (https://example.com)
Channel: sidepanel (connected)

MCP Servers:
  - browsertools (connected, 5 tools)
  - file-server (disconnected, last error: timeout)

Scheduler:
  - daily-scrape (next: 2026-04-08 09:00, last: success)

Tasks:
  - background_agent_1 (running, 45s, 12 tool calls)
  - scheduled_2 (completed, 2m ago)

Approval Queue: 0 pending
Skills: 8 loaded (3 built-in, 5 project)
```

**Expose via:**

- `/doctor` command in UI
- `GET /api/health` endpoint in server mode
- `diagnostics` service request via channels

### Priority 8: Add Feature-Level Lazy Loading

**Reason:** Lower performance risk, cleaner experimental boundaries.

**Suggested feature flag system:**

```typescript
// In build config or runtime:
const FEATURE_FLAGS = {
  A2A: envBool('BROWSERX_A2A', false),
  ADVANCED_SCRAPING: envBool('BROWSERX_ADVANCED_SCRAPING', true),
  VISION_TOOLS: envBool('BROWSERX_VISION_TOOLS', false),
  REMOTE_COPILOT: envBool('BROWSERX_REMOTE_COPILOT', false),
  ANALYTICS: envBool('BROWSERX_ANALYTICS', false),
  MCP_HEAVY_BRIDGES: envBool('BROWSERX_MCP_HEAVY_BRIDGES', false),
}

// Usage with dynamic imports:
if (FEATURE_FLAGS.A2A) {
  const { A2AManager } = await import('./core/a2a/A2AManager')
  // register A2A subsystem
}
```

**Suggested targets for feature gating:**

- A2A subsystem
- Heavy MCP bridges
- Advanced diagnostics
- Optional analytics
- Browser vision/image-heavy tooling
- Remote copiloting
- Experimental scheduler features

---

## Part 5: Recommended Refactors Inside BrowserX Core

These are structural improvements influenced by Claudy's decomposition style.

### 5.1 Reduce `Session.ts` Responsibility

Current file (~1836 lines) is carrying:

- Persistence, history, compaction, title generation, event emission, task coordination, turn state

Suggested split:

| Module | Responsibility |
|--------|----------------|
| `SessionRuntime` | Core turn lifecycle, abort handling |
| `SessionHistoryManager` | History append, snapshot, search |
| `SessionPersistence` | RolloutRecorder integration, save/load |
| `SessionCompactionManager` | CompactService integration, triggers |
| `SessionMetadataManager` | Title generation, token tracking |
| `SessionTaskCoordinator` | Task state, background transitions |

### 5.2 Reduce `RepublicAgent.ts` Orchestration Weight

Current file (~1318 lines) handles: SQ/EQ processing, model switching, tool registration, prompt loading, config changes, service routing.

Suggested split:

| Module | Responsibility |
|--------|----------------|
| `AgentSubmissionRouter` | Route ops to handlers |
| `AgentModelManager` | Model switching, deferred swap, hot-swap |
| `AgentToolingRuntime` | Tool registration, platform tools |
| `AgentPromptManager` | Base/user instructions, PromptComposer |
| `AgentEventBridge` | Event emission, channel dispatch |

### 5.3 Add Tool Concurrency Orchestrator

New subsystem between TurnManager and ToolRegistry:

```typescript
class ToolOrchestrator {
  constructor(private registry: ToolRegistry) {}

  async executeToolCalls(
    calls: ToolCall[],
    context: ToolContext,
    approvalGate: ApprovalGate
  ): AsyncGenerator<ToolResult> {
    const batches = this.partitionByReadOnlySafety(calls)
    for (const batch of batches) {
      if (batch.parallel) {
        const results = await Promise.all(
          batch.calls.map(c => this.executeSingle(c, context, approvalGate))
        )
        for (const r of results) yield r
      } else {
        for (const call of batch.calls) {
          yield this.executeSingle(call, context, approvalGate)
        }
      }
    }
  }
}
```

### 5.4 Introduce Query Dependencies Injection

Import Claudy's `QueryDeps` pattern for testability:

```typescript
type TurnDeps = {
  callModel: typeof ModelClient.prototype.stream
  compact: typeof CompactService.prototype.compact
  uuid: () => string
}

// Production:
const productionDeps: TurnDeps = {
  callModel: (client, params) => client.stream(params),
  compact: (service, history) => service.compact(history),
  uuid: () => crypto.randomUUID(),
}

// Test:
const testDeps: TurnDeps = {
  callModel: mockStream,
  compact: mockCompact,
  uuid: () => 'test-uuid-1',
}
```

---

## Part 6: Adoption Plan

### Phase 1: Product Surface (Low Risk, High Visibility)

- Build command subsystem v2 with typed commands
- Add diagnostics/status commands (`/doctor`, `/sessions`, `/tasks`)
- Add command source precedence and lazy loading
- Estimated scope: New `src/core/commands/` module, ~800-1200 lines

### Phase 2: Tool Runtime Enrichment (Medium Risk, High Impact)

- Add runtime metadata to tool registration
- Implement tool concurrency orchestrator (read-only parallel)
- Add progress reporting infrastructure
- Add result size thresholds for disk persistence
- Estimated scope: Extend `BaseTool` + new `ToolOrchestrator`, ~600-800 lines

### Phase 3: Task Model (Medium Risk, High Impact)

- Introduce typed task families with shared base
- Add disk output persistence (`DiskTaskOutput`)
- Add background/foreground transitions
- Add task polling and eviction framework
- Estimated scope: New `src/core/tasks/` rewrite, ~1500-2000 lines

### Phase 4: Safety/Runtime Orchestration (Medium Risk)

- Split approval scoring from interaction handling
- Add context-specific permission handlers
- Add `ResolveOnce` race condition guard
- Add runtime permission modes beyond simple thresholding
- Estimated scope: Refactor `src/core/approval/`, ~500-800 lines

### Phase 5: Extensibility (Lower Risk)

- Expand skill/plugin loader pipeline
- Add frontmatter parsing with schema validation
- Add namespacing, precedence, collision diagnostics
- Add conditional activation via paths
- Estimated scope: New `src/core/skills/loader/`, ~800-1200 lines

### Phase 6: Operational State (Medium Risk, Cross-Cutting)

- Introduce centralized `AgentOperationalState`
- Add Svelte-compatible store with selectors
- Add centralized side-effect handler
- Estimated scope: New `src/core/state/`, ~400-600 lines

### Phase 7: Core Simplification (Higher Risk, Do Last)

- Shrink `Session.ts` into focused modules
- Shrink `RepublicAgent.ts` into focused modules
- Add query deps injection for testability
- Estimated scope: Refactor existing code, net-zero or negative lines

---

## Final Assessment

BrowserX should not become Claudy.

BrowserX's strongest advantage is its platform-agnostic core and adapter architecture. Claudy's strongest advantage is the richness of the runtime ecosystem around its core — especially the tool contract, command system, task model, permission pipeline, skill loader, and operational state.

The best path is:

- keep BrowserX's shared-core/platform architecture
- import Claudy's tool runtime metadata and concurrency patterns
- import Claudy's command/task/plugin/permission-operability patterns
- use those patterns to reduce pressure on BrowserX's large orchestration classes

If only three Claudy ideas are adopted, they should be:

1. **A real command/workflow subsystem** — highest leverage, enables operator workflows
2. **Enriched tool contract with concurrency orchestration** — enables parallel tool execution, progress, and smarter approvals
3. **Typed task families with disk persistence** — enables background work, A2A, scheduler transparency

If five, add:

4. **Context-specific permission handlers** — different approval behavior for interactive/server/background/A2A contexts
5. **Centralized operational state** — unified runtime picture for diagnostics, monitoring, and cross-cutting features

Those changes would materially improve BrowserX without fighting its current architecture.
