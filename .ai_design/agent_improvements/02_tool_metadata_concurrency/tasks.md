# Track 02: Tool Metadata & Concurrency - Tasks

## Phase 1: Type Definitions

### 1A. Create `src/tools/types.ts`
- [ ] Define `ToolConcurrencyInfo` interface: `isConcurrencySafe(input)`, `isReadOnly(input)`, `isDestructive(input)`
- [ ] Define `TOOL_CONCURRENCY_DEFAULTS` object (all return `false` — fail-closed)
- [ ] Define `ToolProgressData` base type with `type: string` discriminant
- [ ] Define `ToolProgress<P>` wrapper: `{ toolUseID: string; data: P }`
- [ ] Define `ToolProgressCallback<P>` function type
- [ ] Define `ToolUIInfo` interface: `getActivityDescription(input)`, `isSearchOrReadCommand?(input)`
- [ ] Define `ToolResultInfo` interface: `maxResultSizeChars`, `inputsEquivalent?(a, b)`
- [ ] Define tool-specific progress types:
  - `DOMToolProgress` — action, selector, status, nodeCount
  - `NavigationProgress` — url, status (loading/loaded/failed)
  - `WebScrapingProgress` — contentType, bytesExtracted, status
  - `DataExtractionProgress` — mode, rowsExtracted, status
  - `PageVisionProgress` — status, screenshotSizeBytes
  - `NetworkInterceptProgress` — action, status, requestsIntercepted

### 1B. Extend `ToolRegistryEntry` in `src/tools/ToolRegistry.ts`
- [ ] Add `concurrency: ToolConcurrencyInfo` field (always present, defaults applied at registration)
- [ ] Add `ui?: ToolUIInfo` field (optional)
- [ ] Add `result?: ToolResultInfo` field (optional)

### 1C. Extend `ToolRegistry.register()` signature
- [ ] Define `ToolRegistrationOptions` interface: `{ riskAssessor?, concurrency?, ui?, result? }`
- [ ] Accept `ToolRegistrationOptions | IRiskAssessor` as 3rd param (backward compat via type guard: check for `assessRisk` property)
- [ ] Merge `TOOL_CONCURRENCY_DEFAULTS` with provided `concurrency` using spread: `{ ...TOOL_CONCURRENCY_DEFAULTS, ...opts.concurrency }`

### 1D. Extend `ToolRegistry.execute()` signature
- [ ] Add optional `onProgress?: ToolProgressCallback` parameter
- [ ] Thread `onProgress` into `ToolContext.metadata` so handlers can call it
- [ ] When `onProgress` is provided, wrap it to also emit `ToolExecutionProgress` event

### 1E. Add `ToolExecutionProgress` event type
- [ ] Add `| { type: 'ToolExecutionProgress'; data: ToolExecutionProgressEvent }` to `EventMsg` union in `src/core/protocol/events.ts`
- [ ] Define `ToolExecutionProgressEvent`: `{ tool_name, call_id?, session_id?, progress_data: ToolProgressData, timestamp }`

### 1F. Add concurrency query methods to `ToolRegistry`
- [ ] `isConcurrencySafe(toolName, input): boolean` — try/catch wrapped, returns `false` on error
- [ ] `isReadOnly(toolName, input): boolean` — try/catch wrapped
- [ ] `isDestructive(toolName, input): boolean` — try/catch wrapped
- [ ] `getActivityDescription(toolName, input): string | null` — returns `null` if no UI info

### 1G. Unit tests for Phase 1
- [ ] Test `TOOL_CONCURRENCY_DEFAULTS` returns `false` for all methods
- [ ] Test `register()` with bare `IRiskAssessor` (backward compat)
- [ ] Test `register()` with `ToolRegistrationOptions` — verify defaults merge
- [ ] Test `isConcurrencySafe()` returns `false` for unknown tool
- [ ] Test `isConcurrencySafe()` returns `false` when handler throws

## Phase 2: Annotate Existing Tools

> **Tool names:** Function-definition name (LLM-facing) / registry key noted where they differ.

### 2A. Annotate `dom_tool` (browser_dom)
- [ ] `isConcurrencySafe(input)`: `input.action === 'snapshot'` → true, else false
- [ ] `isReadOnly(input)`: `input.action === 'snapshot'` → true, else false
- [ ] `isDestructive(_input)`: always false (DOM mutations reversible via page reload)
- [ ] `getActivityDescription(input)`: switch on `input.action` — "Capturing DOM snapshot", "Clicking element {node_id}", etc.
- [ ] `maxResultSizeChars`: 100,000 (DOM snapshots are large)

### 2B. Annotate `navigation_tool` (browser_navigation)
- [ ] All actions: not concurrent-safe, not read-only (changes page URL)
- [ ] `getActivityDescription(input)`: "Navigating to {url}" / "Reloading page" / "Going back"
- [ ] `maxResultSizeChars`: 10,000

### 2C. Annotate `web_scraping`
- [ ] Always concurrent-safe, always read-only
- [ ] `getActivityDescription(input)`: "Scraping content from page"
- [ ] `maxResultSizeChars`: 50,000

### 2D. Annotate `form_automation`
- [ ] Not concurrent-safe, not read-only (fills form fields)
- [ ] `getActivityDescription(input)`: "Filling form fields"
- [ ] `maxResultSizeChars`: 10,000

### 2E. Annotate `data_extraction`
- [ ] Always concurrent-safe, always read-only
- [ ] `getActivityDescription(input)`: "Extracting {mode} data"
- [ ] `maxResultSizeChars`: 30,000

### 2F. Annotate `storage_tool` (cache_storage_tool)
- [ ] `isConcurrencySafe(input)`: `['read','list'].includes(input.action)` → true, else false
- [ ] `isReadOnly(input)`: `['read','list'].includes(input.action)` → true, else false
- [ ] `isDestructive(input)`: `input.action === 'delete'` → true, else false
- [ ] `getActivityDescription(input)`: "Reading cache" / "Writing to cache" / "Deleting cache entry"
- [ ] `maxResultSizeChars`: 50,000

### 2G. Annotate `page_vision`
- [ ] Always concurrent-safe, always read-only
- [ ] `getActivityDescription(input)`: "Capturing screenshot"
- [ ] `maxResultSizeChars`: 50,000

### 2H. Annotate `network_intercept`
- [ ] **Not concurrent-safe, not read-only** — modifies declarativeNetRequest rules, stateful start/stop lifecycle
- [ ] `getActivityDescription(input)`: "Configuring network intercept"
- [ ] `maxResultSizeChars`: 10,000

### 2I. Annotate `planning_tool`
- [ ] Concurrent-safe (reads don't conflict), not read-only (modifies plan state)
- [ ] `getActivityDescription(input)`: "Updating plan"
- [ ] `maxResultSizeChars`: 10,000

### 2J. Annotate `setting_tool`
- [ ] `isConcurrencySafe(input)`: `input.action === 'get'` → true, else false
- [ ] `isReadOnly(input)`: `input.action === 'get'` → true, else false
- [ ] `getActivityDescription(input)`: "Reading settings" / "Updating settings"
- [ ] `maxResultSizeChars`: 10,000

### 2K. Annotate `web_search`
- [ ] Always concurrent-safe, always read-only
- [ ] `getActivityDescription(input)`: "Searching for {query}"
- [ ] `maxResultSizeChars`: 30,000

### 2L. Unit tests for per-input concurrency checks
- [ ] `dom_tool`: snapshot → safe/read-only; click → not safe/not read-only; type → not safe; scroll → not safe
- [ ] `storage_tool`: read → safe/read-only; list → safe/read-only; write → not safe; delete → destructive
- [ ] `setting_tool`: get → safe/read-only; set → not safe
- [ ] Verify unannotated tool gets `TOOL_CONCURRENCY_DEFAULTS` (all false)

## Phase 3: Parallel Execution

### 3A. Create `src/core/toolOrchestration.ts`
- [ ] Implement `partitionToolCalls(toolCalls, registry)` → `Batch[]`
  - Input: array of `{ id, function: { name, arguments } }` from LLM response
  - Calls `registry.isConcurrencySafe(name, parsedArgs)` for each
  - Merges consecutive safe calls into one batch
  - Non-safe calls get their own single-item batch
- [ ] Implement `executeToolCallsConcurrently(calls, executor)` → `Promise<any[]>`
  - Bounded concurrency: process in chunks of `MAX_TOOL_CONCURRENCY` (default 5)
  - Uses `Promise.all()` within each chunk
- [ ] Export `MAX_TOOL_CONCURRENCY` constant (5 for browser context)

### 3B. Modify `TurnManager.processResponseItem()` (src/core/TurnManager.ts:555-583)
- [ ] Import `partitionToolCalls`, `executeToolCallsConcurrently` from `toolOrchestration.ts`
- [ ] Replace sequential for-loop with:
  1. `const batches = partitionToolCalls(item.tool_calls, this.toolRegistry)`
  2. For each batch: if `isConcurrencySafe` → `executeToolCallsConcurrently()`, else → sequential loop
  3. Collect all results into `allResults` array
  4. Return single result or array (backward compat)

### 3C. Wire progress events through execution
- [ ] Modify `ToolRegistry.execute()` to emit `ToolExecutionProgress` events when `onProgress` is provided
- [ ] Modify `TurnManager.executeBrowserTool()` to pass `onProgress` to `toolRegistry.execute()`
- [ ] Emit `getActivityDescription()` as initial progress event when tool execution starts

### 3D. Integration tests
- [ ] Test: 2 concurrent-safe tools (e.g., `web_scraping` + `data_extraction`) run in parallel — verify both complete, timing < sequential
- [ ] Test: 1 non-safe tool between safe tools → 3 batches (safe, serial, safe)
- [ ] Test: `isConcurrencySafe` throws → treated as non-safe (fail-closed)
- [ ] Test: Single tool call → no partitioning needed, works as before
- [ ] Test: All tools non-safe → all run sequentially (no behavior change from current)
- [ ] Test: `MAX_TOOL_CONCURRENCY` limit respected (6 safe tools with limit 5 → first 5 parallel, then 1)

## Phase 4: Result Management

### 4A. Result truncation in ToolRegistry.execute()
- [ ] After handler returns, check result string length against `entry.result.maxResultSizeChars`
- [ ] If exceeded: truncate to max chars, append `[Result truncated: {original}→{max} chars]` marker
- [ ] This works for both extension and server mode

### 4B. Disk persistence for server mode (optional enhancement)
- [ ] Create `src/tools/resultStorage.ts` with `persistOversizedResult(sessionId, toolUseId, result)`
- [ ] Writes to `.browserx/tool-results/{sessionId}/{toolUseId}.txt`
- [ ] Returns `{ preview: first2000chars + path reference, filePath }`
- [ ] Only used when `__BUILD_MODE__ === 'server'` (detected via platform check)
- [ ] Session cleanup: delete tool-result files when session ends

### 4C. Set maxResultSizeChars per tool (in registration metadata)
- [ ] `dom_tool`: 100,000 (DOM snapshots)
- [ ] `web_scraping`: 50,000
- [ ] `data_extraction`: 30,000
- [ ] `web_search`: 30,000
- [ ] `storage_tool`: 50,000
- [ ] `page_vision`: 50,000
- [ ] `navigation_tool`: 10,000
- [ ] `form_automation`: 10,000
- [ ] `network_intercept`: 10,000
- [ ] `planning_tool`: 10,000
- [ ] `setting_tool`: 10,000

### 4D. Unit tests for result management
- [ ] Test: Result under limit → returned unchanged
- [ ] Test: Result over limit → truncated with marker
- [ ] Test: Tool without `maxResultSizeChars` → no truncation
- [ ] Test: Server mode persistence writes file and returns preview
