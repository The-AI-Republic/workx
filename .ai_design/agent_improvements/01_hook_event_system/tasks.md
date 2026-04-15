# Track 01: Hook & Event System - Tasks

## Phase 1: Core Infrastructure

### Types & Interfaces
- [ ] Create `src/core/hooks/types.ts` with:
  - `HookEvent` type union (11 events: PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, UserPromptSubmit, Stop, PermissionRequest, PermissionDenied, TaskCreated, TaskCompleted)
  - `HookCommandType` = 'command' | 'prompt' | 'http'
  - `HookCommand` interface (command, prompt, url, timeout, if, once, async, shell, statusMessage)
  - `HookMatcherEntry` interface (matcher pattern + hooks array)
  - `HookSource` = 'config' | 'session' | 'plugin'
  - `RegisteredHook` interface (id, event, matcher, command, source, registeredAt)
  - `HookOutcome` = 'success' | 'blocking_error' | 'non_blocking_error' | 'cancelled' | 'timeout'
  - `HookResult` interface (hookId, outcome, exitCode, stdout, stderr, duration, continue, decision, updatedInput, etc.)
  - `AggregatedHookResult` interface (shouldContinue, stopReason, updatedInput, permissionDecision, results, totalDuration)
  - `HookInput` interface (hook_event_name, session_id, tool_name, tool_input, tool_output, user_prompt, current_url, tab_id, etc.)
  - `HooksConfig` type (Record<string, HookMatcherEntry[]>)

### HookMatcher
- [ ] Create `src/core/hooks/HookMatcher.ts`:
  - `matches(pattern, toolName, parameters)` — tool name pattern matching
    - undefined/empty → matches everything
    - Pipe-separated alternatives: `browser_dom|web_search`
    - Parenthesized action filter: `browser_dom(click|type)`
    - Wildcard: `*`
  - `matchesCondition(condition, toolName, parameters)` — `if` field evaluation
  - `parse(pattern)` → `{ toolNames: string[], actions: string[] }`
- [ ] Unit tests for HookMatcher:
  - Exact tool name match
  - Pipe-separated alternatives
  - Action parameter matching (parenthesized)
  - Wildcard matching
  - Empty/undefined matcher matches all
  - `if` condition filtering

### HookRegistry
- [ ] Create `src/core/hooks/HookRegistry.ts`:
  - `register(event, command, source, matcher?)` → hookId
  - `registerFromConfig(config: HooksConfig, source)` → hookId[]
  - `unregister(hookId)` → boolean
  - `unregisterBySource(source)` → count
  - `getMatchingHooks(event, toolName?, parameters?)` → RegisteredHook[]
    - Applies matcher pattern filtering
    - Applies `if` condition filtering
  - `getAllHooks()` → Map<HookEvent, RegisteredHook[]>
  - `clear()`
- [ ] Unit tests for HookRegistry:
  - Register and retrieve hooks
  - Matcher filtering in getMatchingHooks
  - Unregister by ID and by source
  - Multiple hooks per event

### HookExecutor (Command type only in Phase 1)
- [ ] Create `src/core/hooks/HookExecutor.ts`:
  - `execute(hook, input, signal?)` → HookResult
  - Command execution via child_process.spawn (desktop/server) or Tauri shell API (desktop)
  - Variable substitution: $TOOL_NAME, $FILE_PATH, $ARGUMENTS, $SESSION_ID, $CWD, $CURRENT_URL, $TAB_ID
  - HookInput piped as JSON to stdin
  - Exit code semantics: 0=success, 1=non_blocking_error, 2=blocking_error
  - JSON stdout parsing (optional — plain text treated as unstructured)
  - Timeout via AbortSignal (default 30s)
  - Recursion guard: static depth counter, MAX_DEPTH=3
  - Platform detection: skip command hooks in extension mode with warning
- [ ] Unit tests for HookExecutor:
  - Successful command execution
  - Exit code 0/1/2 semantics
  - Timeout handling
  - JSON stdout parsing
  - Variable substitution
  - Recursion depth limit

### HookAggregator
- [ ] Create `src/core/hooks/HookAggregator.ts`:
  - `aggregate(results: HookResult[])` → AggregatedHookResult
  - shouldContinue: ALL must have continue !== false
  - stopReason: first non-null
  - updatedInput: last-writer-wins per key
  - permissionDecision: deny/block > approve > undefined
  - additionalContext: concatenated
  - systemMessages: concatenated
  - totalDuration: max of all (parallel execution)
- [ ] Unit tests for HookAggregator:
  - All success → shouldContinue=true
  - One blocking → shouldContinue=false
  - Permission precedence: deny wins over approve
  - updatedInput merge (last-writer-wins)

### Integration: TurnManager.executeToolCall()
- [ ] Add `hookRegistry` and `hookExecutor` fields to TurnManager (injected via constructor/setter)
- [ ] Wire PreToolUse hooks at the start of `executeToolCall()` (TurnManager.ts:630):
  - Build HookInput with tool_name, tool_input, session_id, current_url, tab_id
  - Get matching hooks, execute in parallel
  - If !shouldContinue → return function_call_output with hook block message
  - If updatedInput → merge into parsed parameters
  - Remove once-hooks after firing
- [ ] Wire PostToolUse hooks after successful tool execution:
  - Build HookInput with tool_name, tool_input, tool_output
  - Get matching hooks, execute in parallel
  - If updatedOutput → modify result before returning
- [ ] Wire PostToolUseFailure hooks in catch block:
  - Build HookInput with tool_name, tool_input, tool_error
  - Fire-and-forget (don't block error propagation)
- [ ] Integration test: PreToolUse hook blocks a browser_dom(click) call
- [ ] Integration test: PostToolUse hook fires after successful tool execution
- [ ] Integration test: PostToolUseFailure hook fires on tool execution error

### Integration: RepublicAgent Lifecycle
- [ ] Add `hookRegistry` and `hookExecutor` fields to RepublicAgent
- [ ] Initialize hook system in RepublicAgent constructor
- [ ] Wire SessionStart hooks at end of `RepublicAgent.initialize()`:
  - Non-blocking: errors logged, not thrown
  - HookInput includes session_start_source ('startup' or 'resume')
- [ ] Wire SessionEnd hooks in `RepublicAgent.handleShutdown()`:
  - Short timeout (1.5s, matching claudy)
  - HookInput includes session_end_reason
- [ ] Pass hookRegistry/hookExecutor to TurnManager and Session

## Phase 2: Hook Types & Async

### Prompt Hook Executor
- [ ] Add prompt hook execution to HookExecutor:
  - Resolve model: hook.model ?? cheapest configured model via ModelClientFactory
  - Build single-turn prompt with system instructions for JSON response
  - Variable substitution on hook.prompt
  - Default timeout: 60s
  - Parse response as JSON HookResult
- [ ] Unit test: prompt hook returns structured response

### HTTP Hook Executor
- [ ] Add HTTP hook execution to HookExecutor:
  - POST to hook.url with HookInput as JSON body
  - Custom headers with env var interpolation
  - Parse response body as JSON HookResult
  - HTTP errors → non_blocking_error
  - Default timeout: 30s
  - Works in extension mode (via fetch) subject to CORS
- [ ] Unit test: HTTP hook posts and parses response

### Async Support
- [ ] Add async hook separation in hook firing logic:
  - Split matching hooks into sync (async !== true) and async (async === true)
  - Execute sync hooks with await, aggregate results
  - Fire async hooks in background (no await), log errors
- [ ] Add `once` flag support: auto-unregister after execution via `hookRegistry.unregister(id)`

### Error Isolation
- [ ] Wrap all hook execution in try-catch at every firing site
- [ ] Hook failures produce non_blocking_error by default
- [ ] Only exit code 2 (blocking_error) can stop execution

## Phase 3: Configuration & Input Modification

### Config Integration
- [ ] Add `hooks?: HooksConfig` field to `IStoredConfig` in `src/config/types.ts`
- [ ] Add `'hooks'` to `IConfigChangeEvent.section` union
- [ ] Create `src/core/hooks/loaders/ConfigHookLoader.ts`:
  - `load(config, registry)` — clear config-source hooks, register from stored config
  - `watch(config, registry)` — subscribe to config-changed, reload on hooks section change
- [ ] Call `ConfigHookLoader.load()` during `RepublicAgent.initialize()`
- [ ] Call `ConfigHookLoader.watch()` to enable hot-reload

### Session Hook Store
- [ ] Create `src/core/hooks/loaders/SessionHookStore.ts`:
  - `addSessionHook(registry, event, matcher, command)` → hookId
  - `removeSessionHook(registry, hookId)` → boolean
  - `clearSessionHooks(registry)` — remove all session-source hooks
  - Used for runtime-registered hooks (e.g., from skills or plugins)

### Additional Integration Points
- [ ] Wire UserPromptSubmit hooks into `RepublicAgent.handleSubmission()`:
  - Fire for UserInput and UserTurn ops
  - Extract text content from input items
  - If !shouldContinue → emit Error event, skip processing
- [ ] Wire PermissionRequest hooks into `ApprovalGate.check()`:
  - Fire when decision is 'ask_user', before calling approvalManager.requestApproval()
  - If hook returns approve → return auto_approve, skip user prompt
  - If hook returns block → return deny, skip user prompt
- [ ] Wire PermissionDenied hooks into `ApprovalGate.check()`:
  - Fire-and-forget after deny decisions (informational)
- [ ] Wire TaskCreated hooks into `Session.spawnTask()`:
  - Fire after task creation, before execution
  - Fire-and-forget
- [ ] Wire TaskCompleted hooks into `Session.spawnTask()` promise resolution:
  - Fire after task completes (success or failure)
  - Fire-and-forget
- [ ] Implement `updatedInput` merging: PreToolUse hooks can modify tool parameters
- [ ] Implement variable substitution in hook commands:
  - $TOOL_NAME, $FILE_PATH, $ARGUMENTS, $SESSION_ID, $CWD
  - BrowserX-specific: $CURRENT_URL, $TAB_ID, $CURRENT_DOMAIN
- [ ] Tests: hook-based input modification (updatedInput changes parameters)
- [ ] Tests: PermissionRequest hook auto-approves a tool call
- [ ] Tests: PermissionRequest hook auto-denies a tool call

### Hook Observability Events
- [ ] Add `HookFired`, `HookResult`, `HookBlocked` to EventMsg union in `src/core/protocol/events.ts`
- [ ] Emit HookFired when hooks begin execution
- [ ] Emit HookResult when individual hook completes
- [ ] Emit HookBlocked when aggregated result blocks execution

## Phase 4: Event Subscriber Pattern

- [ ] Create `EventBus.ts` with subscribe/unsubscribe/emit
- [ ] Migrate existing event dispatcher callbacks to EventBus
- [ ] Add event filtering (subscribe to specific event types only)
- [ ] Add event correlation: link related events with correlation ID
- [ ] Add event history buffer (last N events for debugging)
- [ ] Wire hooks as EventBus subscribers (unify hook and event systems)
