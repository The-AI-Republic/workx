# Track 02: Tool Metadata & Concurrency

## Goal

Bring the useful parts of Claudy's tool metadata and safe parallel execution model into BrowserX, but adapt them to BrowserX's actual architecture instead of doing a literal port.

The output of this track is:

- a runtime metadata model for tools that is fail-closed
- per-input concurrency/read-only/destructive classification
- a safe batching executor for multiple tool calls returned in one assistant message
- progress events that can be consumed by BrowserX's existing event pipeline
- enough detail to implement the change without rediscovering architecture decisions

## Non-goals

- Do not rewrite BrowserX's tool system into Claudy's `buildTool()` object model
- Do not change model prompting or provider flags in the first pass unless required
- Do not introduce context-modifier semantics unless a BrowserX tool actually needs them
- Do not store runtime execution metadata in the API-facing `ToolDefinition.metadata` bag

---

## Claudy Patterns Worth Porting

Claudy's relevant design is sound and should be copied conceptually:

1. Concurrency is evaluated per input, not per tool class.
2. Defaults are fail-closed:
   - `isConcurrencySafe() -> false`
   - `isReadOnly() -> false`
   - `isDestructive() -> false`
3. Safe calls are partitioned into consecutive batches and only those batches run in parallel.
4. Progress is callback-based and optional.
5. Tools expose UI-oriented metadata such as activity descriptions and search/read classification.
6. Large outputs are bounded by per-tool limits.

Relevant Claudy code paths:

- `src/Tool.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/toolExecution.ts`
- `src/utils/toolResultStorage.ts`
- `src/services/mcp/client.ts`

The key difference is where those concepts live. In Claudy they live on the tool object itself. In BrowserX they need to live in registration/runtime metadata around `ToolRegistry`, because BrowserX tools are class-based `BaseTool` subclasses and MCP tools are adapted dynamically.

---

## BrowserX Findings

### 1. The current extension point is `ToolRegistry`, not `BaseTool`

BrowserX's current execution path is:

1. `TurnManager.handleResponseItem()` inspects `item.tool_calls`
2. `TurnManager.executeToolCall()` parses arguments and routes execution
3. Browser tools call `executeBrowserTool()`
4. `ToolRegistry.execute()` validates, approval-checks, emits events, and invokes the handler
5. The handler usually calls `toolInstance.execute(params, options)`

Relevant files:

- `src/core/TurnManager.ts`
- `src/tools/ToolRegistry.ts`
- `src/tools/BaseTool.ts`
- `src/tools/index.ts`

This means the metadata defaults and lookup helpers should be introduced at registration time in `ToolRegistry`, not by trying to retrofit a Claudy-style `buildTool()` across all BrowserX tools.

### 2. BrowserX already receives multi-tool responses, but still executes them sequentially

`TurnManager.handleResponseItem()` currently loops sequentially over `item.tool_calls`.

That is the exact insertion point for batch partitioning and bounded concurrent execution.

Important nuance:

- BrowserX currently sets `parallel_tool_calls: false` in the OpenAI clients:
  - `src/core/models/client/OpenAIChatCompletionClient.ts`
  - `src/core/models/client/OpenAIResponsesClient.ts`
- Despite that, the code already documents that Gemini can still return multiple tool calls in one message.

So the first implementation should make execution safe for multi-call responses without immediately changing provider request flags.

### 3. `ToolDefinition.metadata` is the wrong place for runtime execution metadata

`ToolDefinition.metadata` today is a loose bag used for capabilities, permissions, and platforms. It is part of the tool definition surface and conceptually belongs to discovery and prompting.

Concurrency/read-only/destructive/activity/result-limit data are runtime execution concerns. They should live on `ToolRegistryEntry`, not inside the schema-definition bag.

### 4. MCP annotation data is currently lossy

BrowserX already receives MCP tool annotations in:

- `src/core/mcp/MCPClient.ts`
- `src/server/mcp/NodeMCPBridge.ts`

But it currently maps:

- `readOnlyHint -> annotations.audience = ['user']`
- `destructiveHint -> annotations.costLevel = 'high'`

That translation loses the raw semantics needed for concurrency classification. BrowserX needs to preserve raw MCP hints in its own `IMCPTool.annotations` shape so `MCPToolAdapter` can derive runtime metadata correctly.

### 5. Browser tool lifecycle events are already duplicated

`TurnManager.executeBrowserTool()` emits:

- `ToolExecutionStart`
- `ToolExecutionEnd`
- `ToolExecutionError`

`ToolRegistry.execute()` also emits:

- `ToolExecutionStart`
- `ToolExecutionEnd`
- `ToolExecutionError`
- `ToolExecutionTimeout`

Adding progress on top of that without consolidating ownership will make the event stream worse. The design should make `ToolRegistry` the single owner of browser-tool lifecycle emission.

### 6. `web_search` is special-cased outside the registry

`TurnManager.executeToolCall()` handles `web_search` before consulting `ToolRegistry`.

That matters because concurrency lookup through the registry will not see `web_search` unless we either:

- remove the special case, or
- teach `TurnManager` to classify built-ins like `web_search` directly

For the first implementation, keeping the special case is fine, but `TurnManager` must have a synthetic execution profile for `web_search`.

### 7. Several tools need a more careful classification than the current draft assumes

The current draft overgeneralizes some tools. Based on the actual BrowserX code:

- `browser_dom`
  - `snapshot` is read-only and concurrency-safe
  - `click`, `type`, `keypress`, `scroll` are not
- `browser_navigation`
  - `navigate`, `reload`, `goBack`, `goForward`, `stop` are not safe
  - `getHistory`, `getCurrentUrl` are read-only and safe
  - `waitForLoad` should remain non-safe because it coordinates with page lifecycle
- `web_scraping`
  - read-only only when operating on the already-bound tab
  - if `url` is provided, it may create a new tab, so initial implementation should treat `url != null` as non-safe
- `form_automation`
  - mutative by nature
  - if `url` is provided it may also create/navigate a tab
- `data_extraction`
  - should not be marked concurrency-safe until it is fixed to use the session tab from execution context
  - current implementation queries the active tab directly instead of using `options.metadata.tabId`
- `page_vision`
  - `screenshot` is read-only and safe
  - `click`, `type`, `scroll`, `keypress` are not
- `cache_storage_tool`
  - `read`, `list` are safe
  - `write`, `update`, `delete` are not
  - `delete` is destructive
- `planning_tool`
  - `list`, `get`, `get_plan` are safe
  - `plan`, `update` are not
- `setting_tool`
  - `get`, `list` are safe
  - `set` is not
- `network_intercept`
  - never concurrency-safe
  - stateful lifecycle through shared browser rule state
- `web_search`
  - effectively read-only from the session's point of view and may be marked safe
  - implementation still creates a hidden/minimized window, so this should remain bounded by the global concurrency cap

---

## Target Design

## 1. Runtime Metadata Model

Add a new runtime-only metadata module, for example:

- `src/tools/runtimeMetadata.ts`

This module should define:

```ts
export interface ToolConcurrencyProfile {
  isConcurrencySafe(input: Record<string, unknown>): boolean
  isReadOnly(input: Record<string, unknown>): boolean
  isDestructive(input: Record<string, unknown>): boolean
}

export interface ToolUIProfile {
  getActivityDescription?(input: Record<string, unknown>): string | null
  isSearchOrReadCommand?(input: Record<string, unknown>): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
}

export interface ToolResultProfile {
  maxResultSizeChars?: number
  inputsEquivalent?(a: Record<string, unknown>, b: Record<string, unknown>): boolean
}

export interface ToolRuntimeMetadata {
  concurrency: ToolConcurrencyProfile
  ui?: ToolUIProfile
  result?: ToolResultProfile
}

export const DEFAULT_TOOL_CONCURRENCY_PROFILE: ToolConcurrencyProfile = {
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
}
```

### Why registry-side metadata is the right shape

- It preserves `BaseTool` subclassing
- It works for dynamically-adapted MCP tools
- It allows backward-compatible registration defaults
- It avoids leaking runtime policy into the model-facing tool definition

## 2. Extend `ToolRegistryEntry`

Change `ToolRegistryEntry` in `src/tools/ToolRegistry.ts` to store the runtime metadata:

```ts
interface ToolRegistryEntry {
  definition: ToolDefinition
  handler: ToolHandler
  registrationTime: number
  riskAssessor?: IRiskAssessor
  runtime: ToolRuntimeMetadata
}
```

## 3. Registration API

Extend `ToolRegistry.register()` to accept either the existing risk assessor or a structured registration options object.

```ts
export interface ToolRegistrationOptions {
  riskAssessor?: IRiskAssessor
  runtime?: Partial<{
    concurrency: Partial<ToolConcurrencyProfile>
    ui: ToolUIProfile
    result: ToolResultProfile
  }>
}
```

Backward compatibility rule:

- if the third argument has `assessRisk`, treat it as `IRiskAssessor`
- otherwise treat it as `ToolRegistrationOptions`

Registration behavior:

```ts
const runtime: ToolRuntimeMetadata = {
  concurrency: {
    ...DEFAULT_TOOL_CONCURRENCY_PROFILE,
    ...(opts.runtime?.concurrency ?? {}),
  },
  ui: opts.runtime?.ui,
  result: opts.runtime?.result,
}
```

This gives BrowserX the same fail-closed guarantee Claudy gets from `buildTool()`.

## 4. Add ToolRegistry query helpers

Add these methods to `ToolRegistry`:

- `isConcurrencySafe(toolName, input): boolean`
- `isReadOnly(toolName, input): boolean`
- `isDestructive(toolName, input): boolean`
- `getActivityDescription(toolName, input): string | null`
- `getResultProfile(toolName): ToolResultProfile | undefined`

All of them should be fail-closed and catch exceptions:

- unknown tool -> false / null / undefined
- thrown classifier -> false / null

This mirrors Claudy's conservative behavior and keeps orchestration logic small.

---

## Execution Model

## 5. Extend execution request/context for correlation and progress

### `ToolExecutionRequest`

Add to `src/tools/BaseTool.ts`:

```ts
export interface ToolExecutionRequest {
  toolName: string
  parameters: Record<string, any>
  sessionId: string
  turnId: string
  callId?: string
  tabId?: number
  timeout?: number
  metadata?: Record<string, any>
  onProgress?: ToolProgressCallback
}
```

### `ToolContext`

Add:

```ts
export interface ToolContext {
  sessionId: string
  turnId: string
  toolName: string
  callId?: string
  metadata?: Record<string, any>
  onProgress?: ToolProgressCallback
}
```

### `BaseToolOptions`

Add:

```ts
export interface BaseToolOptions {
  timeout?: number
  retries?: number
  metadata?: Record<string, any>
  onProgress?: ToolProgressCallback
  callId?: string
}
```

This is the least invasive threading path:

- `ToolRegistry.execute()` receives `onProgress`
- passes it into `ToolContext`
- tool registration wrappers pass `context.onProgress` and `context.callId` into `toolInstance.execute(...)`
- tools that care can emit progress through `options.onProgress`

This is better than smuggling callbacks through `metadata`.

## 6. Centralize browser-tool lifecycle events in `ToolRegistry`

`ToolRegistry.execute()` should remain the single owner of:

- `ToolExecutionStart`
- `ToolExecutionProgress`
- `ToolExecutionEnd`
- `ToolExecutionError`
- `ToolExecutionTimeout`

`TurnManager.executeBrowserTool()` should stop emitting those same browser-tool lifecycle events directly.

Reason:

- avoids duplicate start/end/error events
- makes progress emission consistent
- keeps all browser-tool execution bookkeeping in one place

`ToolExecutionStartEvent` should now include `call_id` when available.

Add a new event:

```ts
export interface ToolExecutionProgressEvent {
  tool_name: string
  call_id?: string
  session_id?: string
  turn_id?: string
  progress_data: ToolProgressData
  timestamp: number
}
```

and add it to:

- `src/core/protocol/events.ts`
- `src/core/protocol/event-scope.ts`
- `src/server/streaming/agent-events.ts`
- `src/server/channels/ServerChannel.ts`
- any UI event categorization code that groups tool events

## 7. Progress callback behavior

Progress should be optional and cheap when unused.

`ToolRegistry.execute()` should wrap the request callback:

```ts
const emitProgress: ToolProgressCallback | undefined = request.onProgress
  ? progress => {
      request.onProgress?.(progress)
      this.emitEvent({
        id: ...,
        msg: {
          type: 'ToolExecutionProgress',
          data: {
            tool_name: request.toolName,
            call_id: request.callId,
            session_id: request.sessionId,
            turn_id: request.turnId,
            progress_data: progress.data,
            timestamp: Date.now(),
          },
        },
      })
    }
  : undefined
```

Initial implementation should support lightweight progress from:

- `browser_dom`
- `browser_navigation`
- `web_scraping`
- `page_vision`

But tool execution must not depend on progress support.

---

## Orchestration

## 8. New orchestration helper in `src/core/toolOrchestration.ts`

Add a new helper module that works on already-parsed tool calls.

Recommended types:

```ts
type PreparedToolCall = {
  id: string
  name: string
  rawArguments: string | Record<string, unknown>
  parsedArguments: Record<string, unknown>
  isConcurrencySafe: boolean
}

type ToolCallBatch = {
  isConcurrencySafe: boolean
  calls: PreparedToolCall[]
}
```

### Step 1: prepare calls

Parse JSON arguments once in `TurnManager`, not repeatedly.

If parsing fails:

- preserve the existing error behavior for execution
- classify the call as non-safe during partitioning

### Step 2: classify calls

Classification source should be:

1. synthetic built-in profile for `web_search`
2. `toolRegistry.isConcurrencySafe(name, parsedArguments)` for everything registered, including MCP tools
3. fail-closed for unknown tools

That means MCP concurrency should be available through registration metadata, not by adding a separate orchestration-only MCP lookup path.

### Step 3: partition into consecutive batches

Use Claudy's same rule:

- merge consecutive safe calls into one batch
- every non-safe call becomes a singleton batch
- batches run in original order

### Step 4: execute each batch

For non-safe batch:

- execute sequentially

For safe batch:

- execute concurrently with bounded parallelism
- preserve result ordering in the returned `function_call_output[]`
- allow progress events to interleave naturally

Bounded parallelism:

```ts
export const MAX_SAFE_TOOL_CALL_CONCURRENCY = 5
```

Five is a better BrowserX default than Claudy's ten because BrowserX tools frequently use Chrome APIs, debugger sessions, DOM serialization, screenshots, or hidden tabs/windows.

If later made configurable, the setting should be internal-only at first. It does not need public config surface in the first implementation.

## 9. `TurnManager` integration

Modify `src/core/TurnManager.ts`:

- extract argument parsing into a small helper
- replace the sequential tool-call loop in `handleResponseItem()`
- pass the original `toolCall.id` through as `callId`
- keep output ordering identical to the input order

Important detail:

`executeToolCall()` currently reparses JSON strings. After introducing `PreparedToolCall`, either:

- add a second overload that accepts already-parsed args, or
- make `executeToolCall()` tolerate both string and object input and skip reparsing when it already has an object

That avoids duplicate parse work and avoids inconsistent classification vs execution.

## 10. Provider flags

Do not flip `parallel_tool_calls` to `true` in the first implementation.

First ship:

- metadata model
- safe partitioning
- bounded concurrent execution
- progress events

Then add a follow-up experiment to enable provider-side parallel tool planning per model/provider once:

- event ordering is verified
- UI handling is verified
- browser tool safety annotations are complete

This avoids coupling two behavior changes into one rollout.

---

## MCP Integration

## 11. Preserve raw MCP tool hints

Extend `IMCPTool.annotations` in `src/core/mcp/types.ts` to preserve raw hints BrowserX actually needs:

```ts
annotations?: {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
  audience?: ('user' | 'assistant')[]
  priority?: number
  costLevel?: 'low' | 'medium' | 'high'
}
```

Then update:

- `src/core/mcp/MCPClient.ts`
- `src/server/mcp/NodeMCPBridge.ts`

to populate the raw hint fields rather than only translating them into `audience` and `costLevel`.

## 12. Register MCP runtime metadata in `MCPToolAdapter`

Update `src/core/mcp/MCPToolAdapter.ts` so `registerMCPTools()` passes `ToolRegistrationOptions` into `registry.register(...)`.

Derived profile:

```ts
runtime: {
  concurrency: {
    isConcurrencySafe: () => tool.annotations?.readOnlyHint ?? false,
    isReadOnly: () => tool.annotations?.readOnlyHint ?? false,
    isDestructive: () => tool.annotations?.destructiveHint ?? false,
  },
  result: {
    maxResultSizeChars: 50_000,
  },
}
```

This gives BrowserX the same benefit Claudy gets from MCP annotations, but through BrowserX's registry.

---

## Tool-by-Tool Metadata Plan

## 13. Built-in BrowserX tool classification matrix

These are the implementation decisions the code should follow.

### `browser_dom`

- `snapshot`:
  - concurrency-safe: true
  - read-only: true
  - destructive: false
- `click`, `type`, `keypress`, `scroll`:
  - concurrency-safe: false
  - read-only: false
  - destructive: false
- activity descriptions:
  - `snapshot` -> `Capturing DOM snapshot`
  - `click` -> `Clicking DOM node ${node_id}`
  - `type` -> `Typing into DOM node ${node_id}`
  - `keypress` -> `Pressing ${key}`
  - `scroll` -> `Scrolling DOM node ${node_id}`
- result limit:
  - `100_000`

### `browser_navigation`

- `getHistory`, `getCurrentUrl`:
  - concurrency-safe: true
  - read-only: true
- `navigate`, `reload`, `goBack`, `goForward`, `stop`, `waitForLoad`:
  - concurrency-safe: false
  - read-only: false
- destructive: false for all
- result limit:
  - `10_000`

### `web_scraping`

- if `input.url` is provided:
  - concurrency-safe: false
  - read-only: false for the first implementation
  - reason: may create a new tab via `getTab(tabId, url)`
- otherwise:
  - concurrency-safe: true
  - read-only: true
- destructive: false
- result limit:
  - `50_000`

### `form_automation`

- always:
  - concurrency-safe: false
  - read-only: false
  - destructive: false
- result limit:
  - `10_000`

### `data_extraction`

Before classification, fix the tool to use the bound session tab from execution context rather than querying the active tab directly.

After that fix:

- concurrency-safe: true
- read-only: true
- destructive: false
- result limit:
  - `30_000`

Until that fix lands, treat it as non-safe.

### `page_vision`

- `screenshot`:
  - concurrency-safe: true
  - read-only: true
- `click`, `type`, `scroll`, `keypress`:
  - concurrency-safe: false
  - read-only: false
- destructive: false
- result limit:
  - `50_000`

### `network_intercept`

- always:
  - concurrency-safe: false
  - read-only: false
  - destructive: false
- reason:
  - global mutable rule state
  - start/stop lifecycle is shared
  - monitoring listeners are shared
- result limit:
  - `10_000`

### `cache_storage_tool`

- `read`, `list`:
  - concurrency-safe: true
  - read-only: true
- `write`, `update`, `delete`:
  - concurrency-safe: false
  - read-only: false
- `delete`:
  - destructive: true
- result limit:
  - `50_000`

### `planning_tool`

- `list`, `get`, `get_plan`:
  - concurrency-safe: true
  - read-only: true
- `plan`, `update`:
  - concurrency-safe: false
  - read-only: false
- destructive: false
- result limit:
  - `10_000`

### `setting_tool`

- `get`, `list`:
  - concurrency-safe: true
  - read-only: true
- `set`:
  - concurrency-safe: false
  - read-only: false
- destructive: false
- result limit:
  - `10_000`

### `web_search`

This remains a special-case built-in in `TurnManager` for now.

- concurrency-safe: true
- read-only: true
- destructive: false
- activity description:
  - `Searching the web for "${query}"`
- result limit:
  - `30_000`

---

## Result Size Handling

## 14. First implementation: truncate in-memory, do not add filesystem persistence

Claudy persists oversized outputs to disk because it is a local CLI with a stable filesystem contract.

BrowserX spans extension, desktop, and server modes. A direct filesystem persistence port is not the right first move.

First implementation:

- support `maxResultSizeChars`
- truncate oversized string results in `ToolRegistry.execute()`
- attach metadata showing truncation occurred

Behavior:

```ts
if (typeof result === 'string' && limit && result.length > limit) {
  result = result.slice(0, limit) +
    `\n\n[Result truncated from ${originalLength} to ${limit} chars]`
}
```

For object results:

- do not attempt deep truncation in the first pass
- rely on tool-specific result shaping
- optionally apply truncation after `JSON.stringify()` in `TurnManager` when producing `function_call_output`

Filesystem-backed persistence can be a later server/desktop enhancement if it proves necessary.

---

## Implementation Notes By File

### Files to change

- `src/tools/BaseTool.ts`
- `src/tools/ToolRegistry.ts`
- `src/tools/index.ts`
- `src/core/TurnManager.ts`
- `src/core/protocol/events.ts`
- `src/core/protocol/event-scope.ts`
- `src/server/streaming/agent-events.ts`
- `src/server/channels/ServerChannel.ts`
- `src/core/mcp/types.ts`
- `src/core/mcp/MCPClient.ts`
- `src/server/mcp/NodeMCPBridge.ts`
- `src/core/mcp/MCPToolAdapter.ts`
- `src/tools/DataExtractionTool.ts`
- new `src/tools/runtimeMetadata.ts`
- new `src/core/toolOrchestration.ts`

### Registration helper cleanup

`src/tools/index.ts` currently has repeated registration wrappers. This is a good place to add a small helper:

```ts
async function registerBaseTool(
  registry: ToolRegistry,
  tool: BaseTool,
  opts?: ToolRegistrationOptions
) { ... }
```

That helper should:

- read `tool.getDefinition()`
- register the handler
- pass `context.callId`, `context.onProgress`, and metadata into `tool.execute(...)`
- apply runtime metadata options in one place

This will keep metadata rollout consistent across all tools.

---

## Risks and Mitigations

### Risk: unsafe tool marked safe

Mitigation:

- fail-closed defaults
- explicit per-action classification
- keep `parallel_tool_calls: false` initially
- bounded concurrency cap

### Risk: event stream regressions

Mitigation:

- centralize lifecycle emission in `ToolRegistry`
- preserve `call_id`
- add dedicated progress event instead of overloading unrelated action events

### Risk: MCP metadata drift

Mitigation:

- preserve raw `readOnlyHint` and `destructiveHint`
- derive registry runtime metadata from the raw hints at registration time

### Risk: tool result ordering changes

Mitigation:

- run safe tools concurrently
- store results by original index
- return `function_call_output[]` in original call order

### Risk: hidden browser resources contend under concurrency

Mitigation:

- default cap of `5`
- conservative classification for tools that create tabs, attach debugger sessions, or touch shared browser state

---

## Ready-to-Implement Decisions

These decisions should be treated as settled for implementation:

1. Runtime execution metadata lives on `ToolRegistryEntry`, not `ToolDefinition.metadata`.
2. Metadata defaults are fail-closed and applied during registration.
3. `ToolRegistry` owns browser-tool lifecycle and progress event emission.
4. `TurnManager` gets a new batching helper and stops executing multi-tool messages purely sequentially.
5. Provider request flags remain unchanged in the first pass.
6. MCP raw hints must be preserved and converted into registry runtime metadata.
7. `data_extraction` must be fixed to use the bound session tab before it can be classified as concurrency-safe.

With those constraints, the implementation can proceed directly.
