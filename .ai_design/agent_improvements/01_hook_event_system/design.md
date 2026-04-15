# Track 01: Hook & Event System

## Problem

BrowserX has no hook system. Tools execute atomically with no extensibility points before, during, or after execution. Events are one-way callbacks with no subscriber pattern. This prevents:

- Plugins from modifying tool behavior
- Custom formatters/linters running after file edits
- Permission hooks that modify input before approval
- Session lifecycle hooks for cleanup, persistence, diagnostics
- Post-tool-use hooks for logging, metrics, notifications

Claudy has 27 hook event types with 4 hook command types (shell, prompt, agent, HTTP), composable middleware, and async execution support.

## What Claudy Does

### Hook Events (27 types)

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

### Hook Response Structure

```typescript
type HookResponse = {
  continue?: boolean          // false = block execution
  suppressOutput?: boolean    // hide stdout from user
  stopReason?: string         // message if blocked
  decision?: 'approve' | 'block'  // permission decision
  systemMessage?: string      // inject into conversation
  hookSpecificOutput: {
    updatedInput?: Record<string, unknown>   // modify tool input
    updatedMCPToolOutput?: unknown           // modify tool output
    permissionRequestResult?: PermissionResult
    watchPaths?: string[]
  }
}
```

### Hook Configuration (settings.json or skill frontmatter)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write \"$FILE_PATH\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash(rm:*)",
        "hooks": [
          {
            "type": "agent",
            "prompt": "Verify this delete is safe",
            "model": "claude-sonnet-4-6"
          }
        ]
      }
    ]
  }
}
```

### Key Patterns

- **Matcher syntax**: Tool name + optional parameter pattern (`Bash(git:*)`)
- **Async hooks**: `async: true` runs without blocking; `asyncRewake: true` runs async but wakes model on exit code 2
- **Once hooks**: `once: true` runs once then auto-removes (useful for one-time setup)
- **Hook aggregation**: Multiple hooks per event; results merged into `AggregatedHookResult`
- **Input modification**: PreToolUse hooks can return `updatedInput` to change tool parameters

## BrowserX Mapping

### What BrowserX Has Today

- **Events**: 80+ event types in `core/protocol/events.ts`, structured emission through `Session`/`TurnManager` — not a blank callback world
- **Approval pipeline**: `ApprovalGate.check()` (`src/core/approval/ApprovalGate.ts:92`) implements a multi-step pipeline: fast-path domain checking (blocked/trusted at lines 105-120) → risk assessment → policy evaluation → decision. This is not a simple boolean gate.
- **Tool execution entry point**: `ToolRegistry.execute()` (`src/tools/ToolRegistry.ts:236`) handles tool lookup, validation, and dispatch
- **No hook registration**: Tools execute atomically via `ToolRegistry.execute()` with no extensibility points
- **No hook configuration**: No settings.json or frontmatter-based hook definitions
- **Existing skill infrastructure**: `SkillRegistry` already exists (see Track 03) and could host skill-scoped hooks via frontmatter

### Proposed Architecture

```
src/core/hooks/
├── HookRegistry.ts          # Central hook registration and discovery
├── HookExecutor.ts          # Hook execution engine (shell, prompt, agent, HTTP)
├── HookMatcher.ts           # Pattern matching for tool names and parameters
├── HookAggregator.ts        # Merge multiple hook results
├── types.ts                 # HookEvent, HookCommand, HookResponse types
└── loaders/
    ├── SettingsHookLoader.ts # Load hooks from config/settings
    └── SkillHookLoader.ts   # Load hooks from skill frontmatter
```

### Integration Points

> **Critical: Hook execution ordering must be precisely defined relative to the existing approval pipeline.** The `ApprovalGate.check()` pipeline is multi-step (domain check → risk assessment → policy evaluation → decision). Hooks must slot into specific positions, not just "before" or "after" the gate.

1. **ToolRegistry.execute()** - Wire PreToolUse/PostToolUse/PostToolUseFailure

   **Execution order within `ToolRegistry.execute()`:**
   ```
   1. Tool lookup + validation (existing)
   2. PreToolUse hooks fire (NEW) — can modify input via updatedInput, or block via continue=false
   3. ApprovalGate.check() (existing) — domain check → risk assessment → policy → decision
   4. PermissionRequest hooks fire (NEW) — only if approval decision is 'ask'
   5. Tool execution (existing)
   6. PostToolUse hooks fire (NEW) — receive tool result, can modify output
   7. On failure: PostToolUseFailure hooks fire (NEW) — before any retry logic
   ```

   **On retry:** If tool execution fails and the system retries, PreToolUse hooks fire again for the retry attempt. PostToolUseFailure hooks see each failure independently.

2. **RepublicAgent.processSubmission()** - Wire UserPromptSubmit
3. **RepublicAgent.initialize()/shutdown()** - Wire SessionStart/SessionEnd
4. **ApprovalGate.check()** - Wire PermissionRequest/PermissionDenied (fires within the approval pipeline, after risk assessment but before the user prompt)
5. **Session.recordItems()** - Wire FileChanged (for DOM mutations)
6. **TaskRunner** - Wire TaskCreated/TaskCompleted

### Event Protocol Reconciliation

BrowserX already has structured event emission through `Session`/`TurnManager` using `EventMsg` types. The hook system should **not** replace this protocol but should integrate with it:

- **Hook events** (PreToolUse, PostToolUse, etc.) are interceptors that can modify behavior — they are NOT the same as observation events
- **EventMsg events** (existing) are notifications for UI and persistence — they are downstream consumers
- **Ordering**: Hook execution → EventMsg emission. A hook that blocks a tool call should also suppress the corresponding EventMsg.
- **Future EventBus migration** (Phase 4): When converting to pub/sub, existing `EventMsg` consumers become subscribers. Hook handlers remain a separate mechanism (middleware, not pub/sub) because they can modify/block execution.

### Phase Plan

**Phase 1: Core Infrastructure** (Week 1-2)
- Define `HookEvent` enum (start with 10 most useful events)
- Implement `HookRegistry` with register/unregister/query
- Implement `HookMatcher` with tool name + parameter pattern matching
- Implement `HookExecutor` for command type only (shell execution)
- Wire PreToolUse and PostToolUse into ToolRegistry

**Phase 2: Hook Types** (Week 3)
- Add prompt hook type (LLM evaluation)
- Add HTTP hook type (webhook)
- Add async hook support (non-blocking execution)
- Implement HookAggregator for multi-hook result merging

**Phase 3: Configuration** (Week 4)
- Hook loading from agent config/settings
- Hook loading from skill frontmatter (depends on Track 03)
- Input modification via `updatedInput`
- Permission hooks that can approve/deny tool execution

**Phase 4: Event Subscriber Pattern** (Week 5)
- Convert existing event callbacks to pub/sub
- Add event filtering and transformation
- Add event correlation (link approval events to tool execution events)

## Priority Events for BrowserX

Given BrowserX is a browser automation agent, these events matter most:

| Event | Use Case |
|-------|----------|
| `PreToolUse` | Validate DOM actions, inject safety checks before click/type |
| `PostToolUse` | Screenshot after navigation, log DOM mutations |
| `PostToolUseFailure` | Retry logic, fallback strategies |
| `PermissionRequest` | Custom approval logic for sensitive domains |
| `SessionStart` | Load user preferences, initialize browser state |
| `SessionEnd` | Cleanup tabs, persist session state |
| `UserPromptSubmit` | Input validation, prompt enhancement |

## Risks

- **Performance**: Hook execution adds latency to every tool call. Mitigate with async hooks and fast matcher.
- **Error handling**: Hook failures should not crash the main execution. Use try-catch with logging.
- **Circular hooks**: PreToolUse hook that triggers another tool call. Mitigate with recursion depth limit.
