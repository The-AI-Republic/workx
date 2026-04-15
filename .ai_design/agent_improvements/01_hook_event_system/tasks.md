# Track 01: Hook & Event System - Tasks

## Phase 1: Core Infrastructure

- [ ] Define `HookEvent` type union in `src/core/hooks/types.ts`
  - Start with: PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, UserPromptSubmit, PermissionRequest, PermissionDenied, TaskCreated, TaskCompleted
- [ ] Define `HookCommand` type (command/prompt/agent/http) in `src/core/hooks/types.ts`
- [ ] Define `HookResponse` type with continue, stopReason, updatedInput, decision fields
- [ ] Define `HookMatcher` interface: `{ matcher?: string; hooks: HookCommand[] }`
- [ ] Implement `HookRegistry.ts`: register(event, matcher), unregister(id), query(event, toolName)
- [ ] Implement `HookMatcher.ts`: parse tool name patterns (e.g., `Bash(git:*)`, `Write|Edit`)
- [ ] Implement `HookExecutor.ts`: execute command-type hooks (shell execution with timeout)
- [ ] Wire PreToolUse into `ToolRegistry.execute()` - call before approval gate
- [ ] Wire PostToolUse into `ToolRegistry.execute()` - call after successful execution
- [ ] Wire PostToolUseFailure into `ToolRegistry.execute()` - call on execution error
- [ ] Add unit tests for HookMatcher pattern parsing
- [ ] Add unit tests for HookExecutor command execution
- [ ] Add integration test: PreToolUse hook blocks tool execution

## Phase 2: Hook Types & Async

- [ ] Implement prompt hook type in HookExecutor (send prompt to model, get response)
- [ ] Implement HTTP hook type in HookExecutor (POST to URL with JSON body)
- [ ] Add `async` flag support: hooks with `async: true` run without blocking
- [ ] Add `once` flag support: hooks with `once: true` auto-unregister after first execution
- [ ] Implement `HookAggregator.ts`: merge results from multiple hooks per event
  - continue = all must be true
  - updatedInput = last wins (with merge strategy)
  - stopReason = first non-null
- [ ] Add timeout handling with configurable default (10s)
- [ ] Add error isolation: hook failure logs warning but doesn't block execution

## Phase 3: Configuration & Modification

- [ ] Define hook configuration schema in agent config
- [ ] Implement `SettingsHookLoader.ts`: load hooks from config at startup
- [ ] Wire SessionStart/SessionEnd into RepublicAgent lifecycle
- [ ] Wire UserPromptSubmit into submission processing
- [ ] Add `updatedInput` support: PreToolUse hooks can modify tool parameters
- [ ] Wire PermissionRequest into ApprovalGate: hooks can approve/deny
- [ ] Add `$FILE_PATH`, `$TOOL_NAME`, `$ARGUMENTS` variable substitution in hook commands
- [ ] Add tests for hook-based input modification
- [ ] Add tests for hook-based permission decisions

## Phase 4: Event Subscriber Pattern

- [ ] Create `EventBus.ts` with subscribe/unsubscribe/emit
- [ ] Migrate existing event dispatcher callbacks to EventBus
- [ ] Add event filtering (subscribe to specific event types only)
- [ ] Add event correlation: link related events with correlation ID
- [ ] Add event history buffer (last N events for debugging)
- [ ] Wire hooks as EventBus subscribers (unify hook and event systems)
