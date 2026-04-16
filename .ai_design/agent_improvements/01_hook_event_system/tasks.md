# Track 01: Hook & Event System - Tasks

## Phase 1: Core Infrastructure

### Types & Interfaces
- [ ] Create `src/core/hooks/types.ts` with:
  - `HookEvent` union matching the design doc event set
  - `HookCommandType` = `'command' | 'prompt' | 'http'`
  - `HookCommand`, `HookMatcherEntry`, `HookSource`, `RegisteredHook`
  - `HookOutcome`, `HookResult`, `AggregatedHookResult`
  - `HookInput` with session/tool/task/approval/browser context fields
  - `HooksConfig`
- [ ] Update type tests or add new unit tests for the hook type surface

### HookMatcher
- [ ] Create `src/core/hooks/HookMatcher.ts`:
  - `matches(pattern, toolName, parameters)`
  - `matchesCondition(condition, toolName, parameters)`
  - `parse(pattern)`
- [ ] Unit tests for exact match, pipe alternatives, action matching, wildcard, empty matcher, and `if` filtering

### HookRegistry
- [ ] Create `src/core/hooks/HookRegistry.ts`:
  - `register(event, command, source, matcher?)`
  - `registerFromConfig(config, source)`
  - `unregister(hookId)`
  - `unregisterBySource(source)`
  - `getMatchingHooks(event, toolName?, parameters?)`
  - `getAllHooks()` and `clear()`
- [ ] Unit tests for registration, matcher filtering, unregister by id/source, and multi-hook events

### HookExecutor (Command type only in Phase 1)
- [ ] Create `src/core/hooks/HookExecutor.ts`:
  - `execute(hook, input, signal?)`
  - Runtime split:
    - extension: command hooks return structured non-blocking unsupported result
    - desktop: command hooks execute through Tauri/Rust bridge
    - server: command hooks execute through Node process APIs
  - Variable substitution for `$TOOL_NAME`, `$FILE_PATH`, `$ARGUMENTS`, `$SESSION_ID`, `$CWD`, `$CURRENT_URL`, `$CURRENT_DOMAIN`, `$TAB_ID`
  - Hook input piped as JSON to stdin/body for command execution path
  - Exit code semantics: `0=success`, `1=non_blocking_error`, `2=blocking_error`
  - Optional JSON stdout parsing with plain-text fallback
  - Timeout support
  - Recursion guard
- [ ] Unit tests for exit-code semantics, timeout, JSON parsing, substitution, recursion guard, and extension-mode unsupported behavior

### HookAggregator
- [ ] Create `src/core/hooks/HookAggregator.ts`:
  - `aggregate(results)`
  - `shouldContinue`, `stopReason`, `updatedInput`, `updatedOutput`
  - permission precedence
  - `additionalContext`, `systemMessages`
  - `totalDuration` = max settled duration
- [ ] Unit tests for blocking behavior, precedence, merge behavior, and duration semantics

### HookDispatcher
- [ ] Create `src/core/hooks/HookDispatcher.ts`:
  - owns matching + sync/async split + execution + aggregation
  - removes `once` hooks after scheduling/execution
  - emits hook observability events through BrowserX event flow
  - exposes a single `fire(event, input, options)` API used by call sites
- [ ] Unit tests for:
  - sync + async split
  - `once` cleanup
  - no-hook fast path
  - hook failure isolation
  - observability event emission

### Integration: TurnManager.executeToolCall()
- [ ] Inject `HookDispatcher` into `TurnManager`
- [ ] Add helper to resolve runtime context for a tool call:
  - `currentUrl`
  - `currentDomain`
  - `cwd`
- [ ] Wire `PreToolUse` at the start of `executeToolCall()`:
  - build `HookInput`
  - call `hookDispatcher.fire()`
  - block on `!shouldContinue`
  - merge `updatedInput`
- [ ] Wire `PostToolUse` after successful dispatch:
  - call `hookDispatcher.fire()`
  - apply `updatedOutput` before returning `function_call_output`
- [ ] Wire `PostToolUseFailure` in the error path:
  - include `tool_error`
  - preserve original tool failure propagation
- [ ] Integration tests covering registry tool, `web_search`, and MCP tool paths

### Integration: RepublicAgent Lifecycle
- [ ] Add `hookRegistry`, `hookExecutor`, and `hookDispatcher` fields to `RepublicAgent`
- [ ] Initialize the hook system in `RepublicAgent` constructor
- [ ] Load hooks from config during `RepublicAgent.initialize()`
- [ ] Wire `SessionStart` hooks near the end of `initialize()` as non-blocking
- [ ] Wire `SessionEnd` hooks during shutdown with short timeout
- [ ] Wire `UserPromptSubmit` hooks in `handleSubmission()` for `UserInput` and `UserTurn`

## Phase 2: Hook Types & Async

### Prompt Hooks
- [ ] Add prompt hook execution to `HookExecutor`:
  - resolve model through BrowserX model stack
  - apply variable substitution
  - parse structured JSON result
  - enforce prompt-hook timeout
- [ ] Unit tests for prompt hook structured responses and failures

### HTTP Hooks
- [ ] Add HTTP hook execution to `HookExecutor`:
  - POST hook input as JSON body
  - support custom headers and env interpolation where allowed
  - parse JSON response
  - classify HTTP/network failures as non-blocking
- [ ] Unit tests for response parsing and error classification

### Async and Once Semantics
- [ ] Move async hook handling entirely into `HookDispatcher`
- [ ] Ensure `once` semantics are enforced centrally in `HookDispatcher`, not duplicated at call sites
- [ ] Add tests for async fire-and-forget behavior and `once` removal

## Phase 3: Configuration, Approval, and Task Integration

### Config Integration
- [ ] Add `hooks?: HooksConfig` to both `IAgentConfig` and `IStoredConfig` in `src/config/types.ts`
- [ ] Add `'hooks'` to `IConfigChangeEvent.section`
- [ ] Reconcile `IConfigChangeEvent.section` with the actual persisted config sections while touching the type
- [ ] Create `src/core/hooks/loaders/ConfigHookLoader.ts`:
  - `load(config, registry)`
  - `watch(config, registry)`
  - use the real `AgentConfig` API shape (`getConfig()` + `extractStoredConfig()` unless a new accessor is added)
- [ ] Add tests for config load and hot-reload behavior

### Session Hook Store
- [ ] Create `src/core/hooks/loaders/SessionHookStore.ts` for runtime-registered session hooks
- [ ] Add tests for add/remove/clear semantics

### Approval Integration
- [ ] Inject `HookDispatcher` into `ApprovalGate`
- [ ] Wire `PermissionRequest` inside `ApprovalGate.check()` only on the final `ask_user` branch
- [ ] Map hook decisions to `auto_approve` / `deny` without bypassing the rest of the approval pipeline
- [ ] Wire `PermissionDenied` as informational fire-and-forget hook
- [ ] Add tests for hook-driven approval and denial

### Task Lifecycle Integration
- [ ] Inject `HookDispatcher` into `Session`
- [ ] Wire `TaskCreated` from `Session.spawnTask()` after task registration
- [ ] Wire `TaskCompleted` from the task completion path
- [ ] Add tests for task lifecycle hook firing

### Hook Observability Events
- [ ] Add `HookFired`, `HookResult`, `HookBlocked` to `EventMsg`
- [ ] Emit them from `HookDispatcher` only
- [ ] Do not emit duplicate hook-derived events from `ToolRegistry`
- [ ] Add tests to prove single-owner observability

## Phase 4: EventBus Follow-up
- [ ] Create `EventBus.ts` with subscribe/unsubscribe/emit
- [ ] Migrate existing event dispatcher callbacks to EventBus
- [ ] Add filtering, correlation, and event history buffer
- [ ] Keep hooks as middleware/interceptors even if event transport moves to pub/sub
