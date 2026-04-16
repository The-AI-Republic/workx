# Track 02: Tool Metadata & Concurrency - Tasks

## Phase 1: Runtime Metadata Foundation

### 1A. Create runtime metadata module
- [ ] Create `src/tools/runtimeMetadata.ts`
- [ ] Define `ToolConcurrencyProfile` with `isConcurrencySafe(input)`, `isReadOnly(input)`, `isDestructive(input)`
- [ ] Define `ToolUIProfile` with `getActivityDescription?(input)` and `isSearchOrReadCommand?(input)`
- [ ] Define `ToolResultProfile` with `maxResultSizeChars?` and `inputsEquivalent?(a, b)`
- [ ] Define `ToolRuntimeMetadata` as `{ concurrency, ui?, result? }`
- [ ] Define `DEFAULT_TOOL_CONCURRENCY_PROFILE` with fail-closed defaults returning `false`

### 1B. Extend `ToolRegistryEntry`
- [ ] Update `src/tools/ToolRegistry.ts` so `ToolRegistryEntry` stores `runtime: ToolRuntimeMetadata`
- [ ] Keep runtime metadata separate from `ToolDefinition.metadata`

### 1C. Extend `ToolRegistry.register()`
- [ ] Define `ToolRegistrationOptions` in `src/tools/ToolRegistry.ts`
- [ ] Support `IRiskAssessor | ToolRegistrationOptions` as the 3rd argument
- [ ] Add backward-compat type guard: if arg has `assessRisk`, treat it as `IRiskAssessor`
- [ ] Merge runtime metadata defaults at registration time:
  - `concurrency` always present
  - `ui` and `result` optional
- [ ] Preserve existing registration behavior for callers that only pass a risk assessor

### 1D. Add ToolRegistry metadata query helpers
- [ ] Add `isConcurrencySafe(toolName, input): boolean`
- [ ] Add `isReadOnly(toolName, input): boolean`
- [ ] Add `isDestructive(toolName, input): boolean`
- [ ] Add `getActivityDescription(toolName, input): string | null`
- [ ] Add `getResultProfile(toolName): ToolResultProfile | undefined`
- [ ] Make all helpers fail-closed and catch exceptions

### 1E. Unit tests for runtime metadata foundation
- [ ] Test `DEFAULT_TOOL_CONCURRENCY_PROFILE` returns `false` for all methods
- [ ] Test `register()` with bare `IRiskAssessor` still works
- [ ] Test `register()` with `ToolRegistrationOptions` merges defaults correctly
- [ ] Test unknown tool returns `false` / `null` / `undefined` from query helpers
- [ ] Test thrown classifier is handled conservatively

## Phase 2: Execution Context and Progress Plumbing

### 2A. Extend execution request/context types
- [ ] Update `src/tools/BaseTool.ts`:
  - add `callId?: string` to `ToolExecutionRequest`
  - add `onProgress?: ToolProgressCallback` to `ToolExecutionRequest`
  - add `callId?: string` to `ToolContext`
  - add `onProgress?: ToolProgressCallback` to `ToolContext`
  - add `callId?: string` to `BaseToolOptions`
  - add `onProgress?: ToolProgressCallback` to `BaseToolOptions`
- [ ] Define `ToolProgressData`, `ToolProgress`, and `ToolProgressCallback` in the appropriate shared tool type surface

### 2B. Centralize browser-tool lifecycle events in `ToolRegistry`
- [ ] Make `ToolRegistry.execute()` the single owner of:
  - `ToolExecutionStart`
  - `ToolExecutionProgress`
  - `ToolExecutionEnd`
  - `ToolExecutionError`
  - `ToolExecutionTimeout`
- [ ] Remove duplicate browser-tool lifecycle emission from `TurnManager.executeBrowserTool()`
- [ ] Include `call_id` in start/end/error/progress events when available

### 2C. Add `ToolExecutionProgress` event
- [ ] Add `ToolExecutionProgressEvent` to `src/core/protocol/events.ts`
- [ ] Add `| { type: 'ToolExecutionProgress'; data: ToolExecutionProgressEvent }` to `EventMsg`
- [ ] Add routing in `src/core/protocol/event-scope.ts`
- [ ] Add wire-format conversion in `src/server/streaming/agent-events.ts`
- [ ] Add event-name routing in `src/server/channels/ServerChannel.ts`
- [ ] Update any UI event categorization that groups tool lifecycle events

### 2D. Wire progress callback through execution
- [ ] Update `ToolRegistry.execute()` to wrap `request.onProgress` and emit `ToolExecutionProgress`
- [ ] Pass `callId` and `onProgress` into `ToolContext`
- [ ] Ensure registration wrappers pass `context.callId` and `context.onProgress` into `toolInstance.execute(...)`
- [ ] Emit an initial activity/progress event using `getActivityDescription()` when available

### 2E. Unit tests for progress plumbing
- [ ] Test `ToolExecutionProgress` is emitted when `onProgress` is provided
- [ ] Test no progress overhead or callback invocation occurs when `onProgress` is absent
- [ ] Test `call_id` is preserved in emitted lifecycle events
- [ ] Test removing duplicate lifecycle emission does not regress browser-tool events

## Phase 3: Register Runtime Metadata for Built-in Tools

### 3A. Add a shared registration helper
- [ ] Refactor `src/tools/index.ts` to use a helper for registering `BaseTool` instances with runtime metadata
- [ ] Ensure the helper passes:
  - `sessionId`
  - `turnId`
  - `toolName`
  - `tabId`
  - `callId`
  - `onProgress`
  into `tool.execute(...)`

### 3B. Register metadata for `browser_dom`
- [ ] `snapshot` -> concurrency-safe/read-only
- [ ] `click`, `type`, `keypress`, `scroll` -> non-safe/non-read-only
- [ ] `isDestructive` always `false`
- [ ] Add action-based activity descriptions
- [ ] Set `maxResultSizeChars = 100_000`

### 3C. Register metadata for `browser_navigation`
- [ ] `getHistory` and `getCurrentUrl` -> concurrency-safe/read-only
- [ ] `navigate`, `reload`, `goBack`, `goForward`, `stop`, `waitForLoad` -> non-safe/non-read-only
- [ ] Set `isDestructive` always `false`
- [ ] Add action-based activity descriptions
- [ ] Set `maxResultSizeChars = 10_000`

### 3D. Register metadata for `web_scraping`
- [ ] If `input.url` is present -> treat as non-safe in v1
- [ ] If `input.url` is absent -> treat as concurrency-safe/read-only
- [ ] Set `isDestructive` always `false`
- [ ] Add activity description
- [ ] Set `maxResultSizeChars = 50_000`

### 3E. Register metadata for `form_automation`
- [ ] Mark always non-safe/non-read-only
- [ ] Set `isDestructive` always `false`
- [ ] Add activity description
- [ ] Set `maxResultSizeChars = 10_000`

### 3F. Fix `data_extraction` tab binding before marking safe
- [ ] Update `src/tools/DataExtractionTool.ts` to use the bound session tab from execution context instead of querying the active tab directly
- [ ] Add tests proving the tool uses the bound tab
- [ ] After the tab fix, register metadata:
  - concurrency-safe: true
  - read-only: true
  - destructive: false
  - `maxResultSizeChars = 30_000`

### 3G. Register metadata for `page_vision`
- [ ] `screenshot` -> concurrency-safe/read-only
- [ ] `click`, `type`, `scroll`, `keypress` -> non-safe/non-read-only
- [ ] Set `isDestructive` always `false`
- [ ] Add action-based activity descriptions
- [ ] Set `maxResultSizeChars = 50_000`

### 3H. Register metadata for `network_intercept`
- [ ] Mark always non-safe/non-read-only
- [ ] Set `isDestructive` always `false`
- [ ] Add activity description
- [ ] Set `maxResultSizeChars = 10_000`

### 3I. Register metadata for `cache_storage_tool`
- [ ] `read`, `list` -> concurrency-safe/read-only
- [ ] `write`, `update`, `delete` -> non-safe/non-read-only
- [ ] `delete` -> destructive
- [ ] Add action-based activity descriptions
- [ ] Set `maxResultSizeChars = 50_000`

### 3J. Register metadata for `planning_tool`
- [ ] `list`, `get`, `get_plan` -> concurrency-safe/read-only
- [ ] `plan`, `update` -> non-safe/non-read-only
- [ ] Set `isDestructive` always `false`
- [ ] Add action-based activity descriptions
- [ ] Set `maxResultSizeChars = 10_000`

### 3K. Register metadata for `setting_tool`
- [ ] `get`, `list` -> concurrency-safe/read-only
- [ ] `set` -> non-safe/non-read-only
- [ ] Set `isDestructive` always `false`
- [ ] Add action-based activity descriptions
- [ ] Set `maxResultSizeChars = 10_000`

### 3L. Handle special-case `web_search`
- [ ] Keep `web_search` special-cased in `TurnManager` for v1
- [ ] Add a synthetic execution profile for orchestration:
  - concurrency-safe: true
  - read-only: true
  - destructive: false
  - activity description based on query
  - `maxResultSizeChars = 30_000`

### 3M. Unit tests for built-in tool metadata
- [ ] `browser_dom`: snapshot safe, actions unsafe
- [ ] `browser_navigation`: read actions safe, navigation actions unsafe
- [ ] `web_scraping`: with `url` unsafe, without `url` safe
- [ ] `page_vision`: screenshot safe, coordinate actions unsafe
- [ ] `cache_storage_tool`: read/list safe, write/update/delete unsafe, delete destructive
- [ ] `planning_tool`: read commands safe, mutating commands unsafe
- [ ] `setting_tool`: get/list safe, set unsafe

## Phase 4: Preserve and Use MCP Tool Hints

### 4A. Preserve raw MCP annotation hints
- [ ] Extend `src/core/mcp/types.ts` so `IMCPTool.annotations` preserves:
  - `readOnlyHint?: boolean`
  - `destructiveHint?: boolean`
  - `openWorldHint?: boolean`
  - existing display-oriented fields as needed
- [ ] Update `src/core/mcp/MCPClient.ts` to populate the raw hint fields
- [ ] Update `src/server/mcp/NodeMCPBridge.ts` to populate the raw hint fields

### 4B. Register MCP runtime metadata through `MCPToolAdapter`
- [ ] Update `src/core/mcp/MCPToolAdapter.ts` so `registerMCPTools()` passes `ToolRegistrationOptions`
- [ ] Derive MCP runtime metadata from raw hints:
  - `readOnlyHint` -> concurrency-safe/read-only
  - `destructiveHint` -> destructive
- [ ] Set a default MCP `maxResultSizeChars` for v1

### 4C. MCP tests
- [ ] Test raw MCP annotation hints are preserved
- [ ] Test MCP tools get fail-closed runtime metadata when hints are absent
- [ ] Test MCP tools become concurrency-safe when `readOnlyHint` is `true`
- [ ] Test MCP tools become destructive when `destructiveHint` is `true`

## Phase 5: Tool Call Orchestration

### 5A. Create `src/core/toolOrchestration.ts`
- [ ] Define `PreparedToolCall`
- [ ] Define `ToolCallBatch`
- [ ] Add helper to parse arguments once and prepare calls
- [ ] Add `partitionToolCalls(...)`:
  - merge consecutive safe calls into one batch
  - keep non-safe calls as singleton batches
  - use fail-closed classification
- [ ] Add bounded concurrent executor for safe batches
- [ ] Export `MAX_SAFE_TOOL_CALL_CONCURRENCY = 5`

### 5B. Integrate orchestration in `TurnManager`
- [ ] Update `handleResponseItem()` to prepare tool calls once
- [ ] Replace sequential loop over `item.tool_calls` with batch execution
- [ ] Preserve original result ordering in returned `function_call_output[]`
- [ ] Pass original tool call ids through as `callId`
- [ ] Avoid reparsing tool arguments after preparation

### 5C. Support special-case `web_search` classification in orchestration
- [ ] Ensure partitioning can classify `web_search` even though it is not registry-backed
- [ ] Keep unknown tools fail-closed

### 5D. Integration tests for orchestration
- [ ] Test two safe tools in the same message run in parallel
- [ ] Test safe/non-safe/safe sequence partitions into three batches
- [ ] Test thrown classifier falls back to non-safe
- [ ] Test single tool call behaves as before
- [ ] Test all unsafe tools still run sequentially
- [ ] Test concurrency limit of `5` is respected
- [ ] Test returned results preserve original tool-call order
- [ ] Test `web_search` participates correctly in batching

## Phase 6: Result Size Handling

### 6A. Add v1 in-memory truncation
- [ ] In `ToolRegistry.execute()`, consult `entry.runtime.result?.maxResultSizeChars`
- [ ] For oversized string results, truncate and append a marker
- [ ] Attach truncation metadata if useful for debugging/UI
- [ ] Keep behavior consistent across extension, desktop, and server in v1

### 6B. Do not implement filesystem persistence in this track
- [ ] Remove any assumption of server-only disk persistence from this track
- [ ] Leave filesystem-backed persistence as a follow-up if needed

### 6C. Result-size tests
- [ ] Test result under limit is unchanged
- [ ] Test oversized string result is truncated with marker
- [ ] Test tool without `maxResultSizeChars` is unchanged
- [ ] Test object results are not deep-truncated in v1

## Phase 7: Provider and Rollout Constraints

### 7A. Keep provider request flags unchanged in v1
- [ ] Do not change `parallel_tool_calls: false` in OpenAI clients during this track
- [ ] Document that execution is now safe for multi-call responses even with provider flags unchanged

### 7B. Regression coverage
- [ ] Add regression tests around duplicate lifecycle events
- [ ] Add regression tests around call id preservation
- [ ] Add regression tests ensuring approval-gate behavior is unchanged

## Exit Criteria

- [ ] Runtime metadata is registry-owned and fail-closed
- [ ] Browser built-in tools have correct per-input concurrency/read-only/destructive classification
- [ ] MCP raw hints are preserved and used to derive runtime metadata
- [ ] `ToolRegistry` is the single owner of browser-tool lifecycle/progress events
- [ ] `TurnManager` batches safe tool calls and preserves result order
- [ ] `data_extraction` uses the bound session tab before being marked safe
- [ ] Result-size handling is implemented as v1 truncation only
- [ ] The track ships without changing provider-side `parallel_tool_calls` flags
