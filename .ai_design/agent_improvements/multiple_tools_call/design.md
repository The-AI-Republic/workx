# Multiple Tool Calls & Streaming Tool Execution

Date: 2026-04-07

## Problem Statement

BrowserX currently limits the model to **one tool call per turn**. Every model client sends `parallel_tool_calls: false` in the request, forcing the model to emit a single tool call, wait for the result, then emit the next. This creates a sequential bottleneck:

```
Turn 1: Model → tool_call(snapshot) → execute → result → 
Turn 2: Model → tool_call(click) → execute → result →
Turn 3: Model → tool_call(snapshot) → execute → result →
```

When the model needs to perform multiple independent operations (e.g., reading DOM state from multiple frames, performing multiple searches, gathering data from multiple sources), it must burn a full model round-trip for each one.

Claudy (Claude Code) solves this with two complementary systems:
1. **Parallel tool calls** — the model emits multiple tool calls in one response
2. **Streaming tool execution** — tools begin executing while the model is still streaming later content

## Current BrowserX Pipeline

### Where `parallel_tool_calls: false` is set

| File | Line |
|------|------|
| `src/core/models/client/OpenAIResponsesClient.ts` | 404 |
| `src/core/models/client/OpenAIChatCompletionClient.ts` | 819 |
| `src/core/models/client/FireworksClient.ts` | 53 |
| `src/core/models/client/GroqClient.ts` | 51 |
| `src/core/models/types/ResponsesAPI.ts` | 20 (type-level enforcement) |

### Current execution flow

```
ModelClient.stream(prompt)
  → ResponseStream (async iterable of ResponseEvent)
  → TurnManager.tryRunTurn() iterates events:
      for await (const event of stream) {
        if event.type === 'OutputItemDone':
          response = await handleResponseItem(event.item)
          // ^ blocks here until tool executes
          processedItems.push({ item, response })
      }
  → processedItems returned to TaskRunner
  → TaskRunner adds items + results to history
  → If tool was called → next turn starts (model sees result)
```

### What already supports multiple tools

The code at `TurnManager.handleResponseItem()` (lines 555-582) already contains a `for` loop over `item.tool_calls[]`:

```typescript
if (item.tool_calls && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
  const toolCallResults: any[] = [];
  for (const toolCall of item.tool_calls) {
    const result = await this.executeToolCall(...);  // sequential await
    toolCallResults.push(result);
  }
  return toolCallResults.length === 1 ? toolCallResults[0] : toolCallResults;
}
```

This loop executes tools **sequentially** via `await` inside the loop. It handles the multi-result case but doesn't parallelize.

### What blocks multiple tools

1. **`parallel_tool_calls: false`** — The model never emits multiple tool calls
2. **Sequential `await` in the tool call loop** — Even if the model emitted multiple calls, they'd execute one at a time
3. **No concurrency metadata on tools** — No way to know which tools are safe to run in parallel
4. **No streaming tool execution** — Tools only start after the complete response item arrives via `OutputItemDone`

## Design

### Layer 1: Enable Parallel Tool Calls from the Model

**Change**: Replace `parallel_tool_calls: false` with a configurable value.

```typescript
// In ResponsesAPI.ts type:
parallel_tool_calls: boolean;  // was: false (literal)

// In each model client:
parallel_tool_calls: this.config.parallelToolCalls ?? true,  // default to enabled
```

**Configuration path**: `AgentConfig.tools.parallelToolCalls: boolean` (default `true`).

**Provider support**:

| Provider | Responses API | Chat Completions API | parallel_tool_calls support |
|----------|--------------|---------------------|---------------------------|
| OpenAI | Yes | Yes | Yes |
| xAI | Yes | Yes | Yes |
| Anthropic | N/A (uses Messages API) | N/A | N/A (separate content blocks) |
| Google AI | Yes | Yes | Yes (default true) |
| Groq | No Responses API | Yes | Yes |
| Fireworks | No Responses API | Yes | Unclear — default false as fallback |
| Together | No Responses API | Yes | Unclear — default false as fallback |
| Moonshot | No Responses API | Yes | Unclear — default false as fallback |

For providers with unclear support, keep `parallel_tool_calls: false` as the safe default and allow per-provider override in config.

### Layer 2: Tool Concurrency Metadata

Add safety metadata to each tool so the system knows which tools can run in parallel.

```typescript
// New interface extending current tool registration:
interface ToolConcurrencyMetadata {
  /**
   * Whether this tool can safely execute concurrently with other concurrent-safe tools.
   * Default: false (conservative — unknown tools run serially)
   */
  isConcurrencySafe?: (params: Record<string, any>) => boolean;

  /**
   * Whether this tool only reads state without side effects.
   * Read-only tools are always concurrency-safe with each other.
   * Default: false
   */
  isReadOnly?: (params: Record<string, any>) => boolean;
}
```

**Classification of existing BrowserX tools:**

> **Tool naming convention:** The names below are the function-definition names (what the LLM sees when invoking tools). Some tools have different internal registry keys — see Track 02 design doc for the full mapping. Registry keys are noted where they differ.

| Tool | isConcurrencySafe | isReadOnly | Rationale |
|------|-------------------|-----------|-----------|
| `browser_dom` (snapshot) [registry: `dom_tool`] | true | true | Read-only DOM observation |
| `browser_dom` (click) | false | false | Mutates page state |
| `browser_dom` (type) | false | false | Mutates input fields |
| `browser_dom` (scroll) | false | false | Changes viewport |
| `browser_dom` (keypress) | false | false | Sends input events |
| `browser_navigation` [registry: `navigation_tool`] | false | false | Changes page URL |
| `cache_storage_tool` (get) [registry: `storage_tool`] | true | true | Read-only storage access |
| `cache_storage_tool` (set) | false | false | Mutates storage |
| `form_automation` | false | false | Mutates forms |
| `data_extraction` | true | true | Read-only scraping |
| `web_scraping` | true | true | Read-only scraping |
| `network_intercept` | **false** | **false** | **Stateful**: calls `chrome.declarativeNetRequest.updateDynamicRules()`, tracks `modifiedRequests`, has start/stop lifecycle |
| `page_vision` | true | true | Read-only screenshot capture |
| `planning_tool` | true | false | Internal state tracking |
| MCP tools | false | false | Unknown side effects (conservative default) |

**Note on `browser_dom`**: This tool uses an `action` parameter. Concurrency safety depends on the action:

```typescript
// DOMTool concurrency check:
isConcurrencySafe: (params) => params.action === 'snapshot',
isReadOnly: (params) => params.action === 'snapshot',
```

### Layer 3: Tool Concurrency Orchestrator

New class that partitions tool calls and manages parallel execution.

```typescript
// src/core/tools/ToolOrchestrator.ts

type ToolBatch = {
  calls: ToolCallInfo[];
  parallel: boolean;  // true = all calls in this batch run concurrently
};

type ToolCallInfo = {
  name: string;
  arguments: string;
  callId: string;
  isConcurrencySafe: boolean;
};

class ToolOrchestrator {
  constructor(
    private registry: ToolRegistry,
    private approvalGate?: ApprovalGate,
  ) {}

  /**
   * Partition tool calls into sequential batches.
   * Within each batch, tools either all run in parallel or run serially.
   *
   * Algorithm (single-pass reduce, same as Claudy):
   * - If a tool is concurrency-safe AND the previous batch is concurrent → append to batch
   * - Otherwise → start a new batch
   */
  partition(calls: ToolCallInfo[]): ToolBatch[] {
    return calls.reduce<ToolBatch[]>((batches, call) => {
      const lastBatch = batches[batches.length - 1];
      if (call.isConcurrencySafe && lastBatch?.parallel) {
        lastBatch.calls.push(call);
      } else {
        batches.push({
          calls: [call],
          parallel: call.isConcurrencySafe,
        });
      }
      return batches;
    }, []);
  }

  /**
   * Execute partitioned batches, yielding results in order.
   */
  async *execute(
    calls: ToolCallInfo[],
    executor: (name: string, args: string, callId: string) => Promise<any>,
  ): AsyncGenerator<ToolCallResult> {
    const batches = this.partition(calls);

    for (const batch of batches) {
      if (batch.parallel && batch.calls.length > 1) {
        // Run all calls in this batch concurrently
        const promises = batch.calls.map(call =>
          executor(call.name, call.arguments, call.callId)
            .catch(error => ({
              type: 'function_call_output',
              call_id: call.callId,
              output: `Error: ${error instanceof Error ? error.message : String(error)}`,
            }))
        );
        const results = await Promise.all(promises);
        // Yield in original order
        for (const result of results) {
          yield result;
        }
      } else {
        // Run calls serially
        for (const call of batch.calls) {
          try {
            yield await executor(call.name, call.arguments, call.callId);
          } catch (error) {
            yield {
              type: 'function_call_output',
              call_id: call.callId,
              output: `Error: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
      }
    }
  }
}
```

### Layer 4: Streaming Tool Executor

New class that begins executing tools while the model is still streaming, borrowed from Claudy's `StreamingToolExecutor`.

```typescript
// src/core/tools/StreamingToolExecutor.ts

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded';

type TrackedTool = {
  id: string;
  name: string;
  arguments: string;
  callId: string;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  promise?: Promise<void>;
  result?: any;
};

class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private discarded = false;

  constructor(
    private registry: ToolRegistry,
    private executor: (name: string, args: string, callId: string) => Promise<any>,
  ) {}

  /**
   * Add a tool to the queue. Starts executing immediately if concurrency allows.
   * Called as each tool_use block arrives from the model stream.
   */
  addTool(name: string, args: string, callId: string): void {
    const meta = this.registry.getConcurrencyMeta(name);
    const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
    const isConcurrencySafe = meta?.isConcurrencySafe?.(parsedArgs) ?? false;

    const tool: TrackedTool = {
      id: callId,
      name,
      arguments: args,
      callId,
      status: 'queued',
      isConcurrencySafe,
    };
    this.tools.push(tool);
    void this.processQueue();
  }

  /**
   * Can this tool start executing now?
   */
  private canExecute(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter(t => t.status === 'executing');
    return (
      executing.length === 0 ||
      (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
    );
  }

  /**
   * Process the queue, starting tools when concurrency allows.
   */
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue;
      if (this.discarded) return;

      if (this.canExecute(tool.isConcurrencySafe)) {
        this.startExecution(tool);
      } else if (!tool.isConcurrencySafe) {
        // Non-concurrent tool must wait — stop scanning
        break;
      }
    }
  }

  private startExecution(tool: TrackedTool): void {
    tool.status = 'executing';
    const promise = this.executor(tool.name, tool.arguments, tool.callId)
      .then(result => {
        tool.result = result;
        tool.status = 'completed';
      })
      .catch(error => {
        tool.result = {
          type: 'function_call_output',
          call_id: tool.callId,
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
        tool.status = 'completed';
      })
      .finally(() => {
        void this.processQueue();
      });
    tool.promise = promise;
  }

  /**
   * Non-blocking: yield any completed results in original order.
   * Called periodically during streaming to collect early results.
   */
  *getCompletedResults(): Generator<any> {
    if (this.discarded) return;

    for (const tool of this.tools) {
      if (tool.status === 'yielded') continue;
      if (tool.status === 'completed' && tool.result !== undefined) {
        tool.status = 'yielded';
        yield tool.result;
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        // Non-concurrent tool still running — preserve order, stop here
        break;
      }
    }
  }

  /**
   * Blocking: wait for all remaining tools and yield results in order.
   * Called after model streaming completes.
   */
  async *getRemainingResults(): AsyncGenerator<any> {
    if (this.discarded) return;

    while (this.tools.some(t => t.status !== 'yielded')) {
      await this.processQueue();

      for (const result of this.getCompletedResults()) {
        yield result;
      }

      // Wait for any executing tool to complete
      const executing = this.tools
        .filter(t => t.status === 'executing' && t.promise)
        .map(t => t.promise!);

      if (executing.length > 0 && !this.tools.some(t => t.status === 'completed')) {
        await Promise.race(executing);
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result;
    }
  }

  /**
   * Discard all pending work (e.g., on streaming fallback/retry).
   */
  discard(): void {
    this.discarded = true;
  }
}
```

### Layer 5: TurnManager Integration

Modify `TurnManager.tryRunTurn()` to use the streaming executor.

#### Current flow:

```typescript
for await (const event of stream) {
  if (event.type === 'OutputItemDone') {
    const response = await this.handleResponseItem(event.item);  // blocks
    processedItems.push({ item, response });
  }
}
```

#### New flow:

```typescript
const streamingExecutor = new StreamingToolExecutor(
  this.toolRegistry,
  (name, args, callId) => this.executeToolCall(name, args, callId),
);

for await (const event of stream) {
  if (event.type === 'OutputItemDone') {
    const item = event.item;

    // Extract tool calls and feed to streaming executor
    const toolCalls = this.extractToolCalls(item);
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        streamingExecutor.addTool(tc.name, tc.arguments, tc.callId);
      }
      processedItems.push({ item, toolCalls });
    } else {
      // Non-tool items: handle immediately (text, reasoning, etc.)
      await this.handleNonToolItem(item);
      processedItems.push({ item, response: undefined });
    }

    // Drain any already-completed tool results (non-blocking)
    for (const result of streamingExecutor.getCompletedResults()) {
      toolResults.push(result);
    }
  }
}

// After streaming completes: wait for remaining tools
for await (const result of streamingExecutor.getRemainingResults()) {
  toolResults.push(result);
}

// Match results back to processedItems for history recording
this.matchResultsToItems(processedItems, toolResults);
```

#### Helper to extract tool calls from any item format:

```typescript
private extractToolCalls(item: any): ToolCallInfo[] {
  const calls: ToolCallInfo[] = [];

  // Legacy function_call format
  if (item.type === 'function_call') {
    calls.push({
      name: item.name,
      arguments: item.arguments,
      callId: item.call_id,
      isConcurrencySafe: this.checkConcurrencySafe(item.name, item.arguments),
    });
  }

  // Unified format: tool_calls[] embedded in message
  if (item.type === 'message' && item.tool_calls?.length > 0) {
    for (const tc of item.tool_calls) {
      calls.push({
        name: tc.function.name,
        arguments: tc.function.arguments,
        callId: tc.id,
        isConcurrencySafe: this.checkConcurrencySafe(tc.function.name, tc.function.arguments),
      });
    }
  }

  return calls;
}

private checkConcurrencySafe(name: string, args: any): boolean {
  const meta = this.toolRegistry.getConcurrencyMeta(name);
  if (!meta?.isConcurrencySafe) return false;
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    return meta.isConcurrencySafe(parsed);
  } catch {
    return false;
  }
}
```

### Layer 6: ToolRegistry Extension

Add concurrency metadata registration to `ToolRegistry`.

```typescript
// In ToolRegistry:

interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  riskAssessor?: IRiskAssessor;
  concurrency?: ToolConcurrencyMetadata;  // NEW
}

// New method:
getConcurrencyMeta(toolName: string): ToolConcurrencyMetadata | undefined {
  return this.tools.get(toolName)?.concurrency;
}

// Extended register():
async register(
  tool: ToolDefinition,
  handler: ToolHandler,
  riskAssessor?: IRiskAssessor,
  concurrency?: ToolConcurrencyMetadata,  // NEW optional param
): Promise<void> {
  // ... existing logic ...
  this.tools.set(name, { definition: tool, handler, riskAssessor, concurrency });
}
```

### Layer 7: Approval Gate Integration

When tools run in parallel, approval must be handled carefully.

**Rule**: Approval checks happen **before** parallel execution starts. If any tool in a concurrent batch requires approval, all tools in that batch wait for approval before any execute.

```typescript
// In ToolOrchestrator.execute(), before running a parallel batch:
if (batch.parallel && this.approvalGate) {
  // Check all tools in the batch first
  const approvalResults = await Promise.all(
    batch.calls.map(call => this.approvalGate!.check(call.name, call.parsedArgs))
  );

  // If any tool is denied, cancel the entire batch
  const denied = approvalResults.filter(r => r.decision === 'deny');
  if (denied.length > 0) {
    // Yield error results for denied tools, execute approved ones
    // ...
  }

  // If any tool needs user approval, collect all approval requests
  // and present them as a batch to the user
  const needsApproval = approvalResults.filter(r => r.decision === 'ask');
  if (needsApproval.length > 0) {
    // Batch approval request (new UI pattern)
    // User sees: "The agent wants to do 3 things: [snapshot], [extract data], [search]"
    // ...
  }
}
```

**For streaming executor**: Approval is checked inside `executeToolCall()` which already calls `ApprovalGate.check()` via `ToolRegistry.execute()`. This means each tool is independently approved. The streaming executor doesn't need special approval handling — it just starts execution (which includes the approval step) and the approval dialog appears naturally.

### Layer 8: Event Emission for UI

New events for the UI to show parallel tool execution state:

```typescript
// In protocol/types.ts, add to EventMsg union:

| {
  type: 'ParallelToolsBegin';
  data: {
    batchId: string;
    tools: Array<{ callId: string; name: string; params: Record<string, any> }>;
  };
}
| {
  type: 'ParallelToolProgress';
  data: {
    batchId: string;
    callId: string;
    status: 'executing' | 'completed' | 'error';
    result?: string;
  };
}
| {
  type: 'ParallelToolsEnd';
  data: {
    batchId: string;
    totalMs: number;
    results: Array<{ callId: string; success: boolean }>;
  };
}
```

## Concrete Example

### Before (current): 3 turns, 3 model round-trips

```
User: "Compare the prices on these 3 product pages"

Turn 1: Model → tool_call(browser_dom, {action: "snapshot"}) → 800ms → result
Turn 2: Model → tool_call(browser_navigation, {url: "page2"}) → 500ms → result
Turn 3: Model → tool_call(browser_dom, {action: "snapshot"}) → 800ms → result
Turn 4: Model → tool_call(browser_navigation, {url: "page3"}) → 500ms → result
Turn 5: Model → tool_call(browser_dom, {action: "snapshot"}) → 800ms → result
Turn 6: Model → "Here are the prices..."

Total: 6 model round-trips + 3400ms tool execution
```

### After: Model emits independent tools together

```
User: "Compare the prices on these 3 product pages"

Turn 1: Model → tool_call(browser_dom, {action: "snapshot"})  → result
Turn 2: Model → [
          tool_call(browser_data_extraction, {selector: ".price", tabId: 1}),  ← parallel
          tool_call(browser_data_extraction, {selector: ".price", tabId: 2}),  ← parallel
          tool_call(browser_data_extraction, {selector: ".price", tabId: 3}),  ← parallel
        ] → all 3 execute concurrently → results
Turn 3: Model → "Here are the prices..."

Total: 3 model round-trips + extraction runs in parallel
```

### Streaming execution timeline

```
Time 0ms:   Model starts streaming response text...
Time 100ms: Model streams tool_use: data_extraction(tab1)
            → StreamingToolExecutor.addTool() → starts immediately (read-only)
Time 130ms: Model streams tool_use: data_extraction(tab2)
            → addTool() → concurrent-safe, starts in parallel
Time 160ms: Model streams tool_use: data_extraction(tab3)
            → addTool() → concurrent-safe, starts in parallel
Time 200ms: Model finishes streaming
Time 250ms: extraction(tab1) completes → yielded
Time 280ms: extraction(tab2) completes → yielded
Time 300ms: extraction(tab3) completes → yielded
            → All results ready, feed back to model

Without streaming execution: all 3 would start at 200ms
Saved: ~200ms (tools started executing 100-160ms earlier)
```

## Files to Modify

### New files

| File | Purpose |
|------|---------|
| `src/core/tools/ToolOrchestrator.ts` | Partitioning + parallel batch execution |
| `src/core/tools/StreamingToolExecutor.ts` | Execute tools while model streams |
| `src/core/tools/types.ts` | `ToolConcurrencyMetadata`, `ToolCallInfo`, `ToolBatch` |

### Modified files

| File | Change |
|------|--------|
| `src/core/models/types/ResponsesAPI.ts` | `parallel_tool_calls: boolean` (was `false` literal) |
| `src/core/models/client/OpenAIResponsesClient.ts` | Configurable `parallel_tool_calls` |
| `src/core/models/client/OpenAIChatCompletionClient.ts` | Configurable `parallel_tool_calls` |
| `src/core/models/client/FireworksClient.ts` | Keep `false` (unclear support) |
| `src/core/models/client/GroqClient.ts` | Configurable `parallel_tool_calls` |
| `src/core/TurnManager.ts` | Integrate `StreamingToolExecutor` in `tryRunTurn()` |
| `src/tools/ToolRegistry.ts` | Add `concurrency` field, `getConcurrencyMeta()` |
| `src/tools/registerPlatformTools.ts` | Add concurrency metadata to each tool registration |
| `src/core/protocol/types.ts` | Add parallel tool events |
| `src/config/types.ts` | Add `parallelToolCalls` config option |
| `src/config/defaults.ts` | Default `parallelToolCalls: true` |

### Test files

| File | Purpose |
|------|---------|
| `src/core/tools/__tests__/ToolOrchestrator.test.ts` | Partitioning logic, batch execution |
| `src/core/tools/__tests__/StreamingToolExecutor.test.ts` | Concurrency gating, result ordering, discard |
| `src/core/models/__tests__/OpenAIChatCompletionClient.unit.test.ts` | Update existing test (remove `parallel_tool_calls=false` assertion) |

## Implementation Phases

### Phase 1: Parallel tool calls (no streaming)

Enable `parallel_tool_calls: true` and use `ToolOrchestrator` for concurrent execution in `handleResponseItem()`. This is the minimum viable change.

1. Add `ToolConcurrencyMetadata` to `ToolRegistry`
2. Tag existing tools with concurrency metadata
3. Create `ToolOrchestrator` with partition + execute
4. Change `parallel_tool_calls` to `true` in OpenAI/xAI clients
5. Replace sequential `for` loop in `handleResponseItem()` with orchestrator
6. Update tests

### Phase 2: Streaming tool execution

Add `StreamingToolExecutor` for early execution while model streams.

1. Create `StreamingToolExecutor`
2. Refactor `tryRunTurn()` to feed tool calls to executor during streaming
3. Add feature flag: `AgentConfig.tools.streamingToolExecution: boolean`
4. Add parallel tool events for UI
5. Update tests

### Phase 3: Batch approval UI

Add UI support for approving multiple tools at once.

1. Design batch approval dialog in sidepanel
2. Add `ParallelToolsBegin`/`Progress`/`End` event handling in UI
3. Show concurrent execution progress indicators

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Model emits dependent tools in parallel | Low | Models are trained to serialize dependent calls. Claudy relies on this successfully. |
| DOM tool conflicts (two mutations in parallel) | Medium | `isConcurrencySafe` prevents mutating DOM tools from running in parallel. Only snapshot/read tools are concurrent-safe. |
| Provider doesn't support `parallel_tool_calls` | Low | Per-provider default. Keep `false` for unclear providers. |
| Approval UX with multiple tools | Medium | Phase 3 handles batch approval. Phase 1 uses sequential approval within the orchestrator. |
| Streaming executor race conditions | Medium | Result ordering enforced by sequential yield in `getCompletedResults()`. Claudy has validated this pattern at scale. |
| MCP tool side effects unknown | Low | MCP tools default to `isConcurrencySafe: false`. Conservative. |

## Relationship to Claudy

This design borrows directly from Claudy's implementation:

| Claudy | BrowserX (this design) |
|--------|----------------------|
| `Tool.isConcurrencySafe(input)` | `ToolConcurrencyMetadata.isConcurrencySafe(params)` |
| `Tool.isReadOnly(input)` | `ToolConcurrencyMetadata.isReadOnly(params)` |
| `toolOrchestration.ts` partitioning | `ToolOrchestrator.partition()` |
| `StreamingToolExecutor` class | `StreamingToolExecutor` class (adapted) |
| `canExecuteTool()` concurrency gate | `canExecute()` concurrency gate |
| `getCompletedResults()` ordered yield | `getCompletedResults()` ordered yield |
| `getRemainingResults()` async drain | `getRemainingResults()` async drain |
| `discard()` for streaming fallback | `discard()` for streaming fallback |
| Statsig feature gate | `AgentConfig.tools.streamingToolExecution` config flag |

Key adaptations for BrowserX:
- No React/Ink rendering hooks (BrowserX uses Svelte + events)
- Approval integration via existing `ApprovalGate` pipeline
- DOM tool action-level concurrency checking (Claudy doesn't have DOM tools)
- Platform-aware feature gating via `__BUILD_MODE__`
