# Multiple Tool Calls — Implementation Tasks

## Phase 1: Parallel Tool Calls (No Streaming)

### 1.1 Add concurrency types
- [ ] Create `src/core/tools/types.ts` with `ToolConcurrencyMetadata`, `ToolCallInfo`, `ToolBatch`
- [ ] Export from `src/core/tools/index.ts`

### 1.2 Extend ToolRegistry
- [ ] Add `concurrency?: ToolConcurrencyMetadata` to `ToolRegistryEntry`
- [ ] Add `getConcurrencyMeta(toolName: string)` method
- [ ] Extend `register()` signature with optional concurrency param

### 1.3 Tag existing tools with concurrency metadata
- [ ] `browser_dom`: `isConcurrencySafe: (p) => p.action === 'snapshot'`, `isReadOnly: (p) => p.action === 'snapshot'`
- [ ] `browser_navigation`: `isConcurrencySafe: false`, `isReadOnly: false`
- [ ] `browser_storage`: `isConcurrencySafe: (p) => p.action === 'get'`, `isReadOnly: (p) => p.action === 'get'`
- [ ] `browser_form_automation`: `isConcurrencySafe: false`
- [ ] `browser_data_extraction`: `isConcurrencySafe: true`, `isReadOnly: true`
- [ ] `browser_web_scraping`: `isConcurrencySafe: true`, `isReadOnly: true`
- [ ] `browser_network_intercept`: `isConcurrencySafe: true`, `isReadOnly: true`
- [ ] `web_search`: `isConcurrencySafe: true`, `isReadOnly: true`
- [ ] MCP tools: default `isConcurrencySafe: false`

### 1.4 Create ToolOrchestrator
- [ ] Create `src/core/tools/ToolOrchestrator.ts`
- [ ] Implement `partition(calls)` — single-pass reduce into batches
- [ ] Implement `execute(calls, executor)` — async generator, parallel batches via Promise.all
- [ ] Write tests: `src/core/tools/__tests__/ToolOrchestrator.test.ts`
  - [ ] All read-only tools → single parallel batch
  - [ ] Mixed read + write → split into batches
  - [ ] All write tools → each gets own serial batch
  - [ ] Single tool → single serial batch
  - [ ] Error in one parallel tool doesn't affect others
  - [ ] Results yielded in original order

### 1.5 Enable parallel_tool_calls
- [ ] Change `ResponsesAPI.ts` type: `parallel_tool_calls: boolean`
- [ ] Add `parallelToolCalls` to `AgentConfig.tools` (default `true`)
- [ ] `OpenAIResponsesClient.ts`: read from config, default `true`
- [ ] `OpenAIChatCompletionClient.ts`: read from config, default `true`
- [ ] `GroqClient.ts`: read from config, default `true`
- [ ] `FireworksClient.ts`: keep `false` (unclear support)
- [ ] `TogetherChatCompletionClient.ts`: keep `false` (unclear support)
- [ ] Remove console.warn for multiple tool calls in `OpenAIChatCompletionClient`

### 1.6 Integrate ToolOrchestrator into TurnManager
- [ ] Replace sequential `for` loop in `handleResponseItem()` (lines 555-582) with `ToolOrchestrator.execute()`
- [ ] Ensure results are collected and returned correctly (single vs array)
- [ ] Update `BrowserAdaptations.test.ts` to remove `parallel_tool_calls: false` assertion

## Phase 2: Streaming Tool Execution

### 2.1 Create StreamingToolExecutor
- [ ] Create `src/core/tools/StreamingToolExecutor.ts`
- [ ] Implement `addTool()` — queue + immediate processQueue
- [ ] Implement `canExecute()` — concurrency gate
- [ ] Implement `processQueue()` — start tools when gate allows
- [ ] Implement `getCompletedResults()` — non-blocking ordered yield
- [ ] Implement `getRemainingResults()` — blocking async drain
- [ ] Implement `discard()` — cancel pending work
- [ ] Write tests: `src/core/tools/__tests__/StreamingToolExecutor.test.ts`
  - [ ] Single tool executes immediately
  - [ ] Multiple concurrent-safe tools execute in parallel
  - [ ] Non-concurrent tool waits for prior tools
  - [ ] Results yielded in arrival order, not completion order
  - [ ] discard() prevents further execution
  - [ ] Error handling per tool

### 2.2 Add feature flag
- [ ] Add `streamingToolExecution: boolean` to `AgentConfig.tools` (default `false` initially)
- [ ] Add to `DEFAULT_TOOLS_CONFIG` in `defaults.ts`

### 2.3 Refactor TurnManager.tryRunTurn()
- [ ] Extract `extractToolCalls(item)` helper
- [ ] Extract `handleNonToolItem(item)` helper
- [ ] When `streamingToolExecution` enabled:
  - [ ] Create `StreamingToolExecutor` before stream loop
  - [ ] Feed tool calls to executor during streaming via `addTool()`
  - [ ] Poll `getCompletedResults()` on each stream event
  - [ ] After stream: drain `getRemainingResults()`
  - [ ] Match results to processedItems
- [ ] When disabled: use Phase 1 ToolOrchestrator (current behavior)

### 2.4 Handle streaming fallback/retry
- [ ] Call `streamingExecutor.discard()` on retry
- [ ] Create fresh executor for retry attempt
- [ ] Ensure no orphan tool results leak across retries

## Phase 3: Batch Approval UI

### 3.1 Add parallel tool events
- [ ] Add `ParallelToolsBegin`, `ParallelToolProgress`, `ParallelToolsEnd` to EventMsg union
- [ ] Emit events from ToolOrchestrator/StreamingToolExecutor

### 3.2 UI updates
- [ ] Handle new events in sidepanel
- [ ] Show concurrent execution indicators
- [ ] Design batch approval dialog (multiple tools at once)
