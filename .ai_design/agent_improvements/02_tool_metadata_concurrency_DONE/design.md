# Track 02: Tool Metadata & Concurrency

> **Status: DONE** — shipped via PR #197 (`feat/tool-metadata-concurrency` → `agent-improvements`, merged 2026-05-13).
>
> Implemented runtime metadata model on `ToolRegistryEntry` (concurrency / UI / result profiles with fail-closed defaults), per-input classification for all 11 built-in tools, batch partitioning orchestrator with bounded parallelism (max 5), `ToolExecutionProgress` event wired through the pipeline, result truncation via `maxResultSizeChars` (covers both string and structured payloads), MCP raw `readOnlyHint`/`destructiveHint` preservation with derived metadata, and `call_id` propagation through all tool lifecycle events. Sole owner of tool lifecycle event emission is `ToolRegistry` (duplicate emission from `TurnManager` was removed). The original design notes below are kept for historical reference.

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

1. **Concurrency is evaluated per input, not per tool class.** This is a stated principle, not a footnote. Classification depends on the actual call arguments, because the same tool name can be safe or unsafe depending on what it is asked to do. The canonical Claudy example is `BashTool`, where `isConcurrencySafe(input)` simply returns `isReadOnly(input)`, and `isReadOnly(input)` parses the `command` string to detect mutating shell verbs (e.g. `cd`, which mutates the working directory and is therefore disqualified from concurrent execution). See `tools/BashTool/BashTool.tsx`. The BrowserX equivalents are `web_scraping(url=…)` and `form_automation(url=…)`: presence of `url` means the call may create or navigate a tab and must be classified as non-safe, whereas the same tool without `url` operates on the bound session tab and can be safe. The classifier API therefore takes `input` and is allowed (encouraged) to inspect it.
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
  // Optional UI hint used to collapse/dim read-only operations in the
  // transcript view (parity with claudy's `Tool.isSearchOrReadCommand`,
  // see `Tool.ts`). Purely cosmetic — does NOT influence concurrency
  // classification, which is governed by `ToolConcurrencyProfile`.
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

export interface ToolLifecycleProfile {
  // Whether a tool is exposed to the model. Tools may be conditionally
  // hidden by returning `false`. Parity with claudy `Tool.isEnabled()`.
  isEnabled?(): boolean

  // Whether a new user message can preempt this tool while it is running.
  //   - 'cancel': aborting in-flight execution is safe (default for most tools)
  //   - 'block':  the user message must wait for the tool to finish
  // Defaults to 'block'. BrowserX use case: `browser_navigation.waitForLoad`
  // should declare `'block'` because cancelling mid-load leaves the page in
  // an indeterminate state. Parity with claudy `Tool.interruptBehavior`.
  interruptBehavior?(): 'cancel' | 'block'

  // Optional context mutation hook. When a tool finishes, it may return a
  // function that produces an updated `ToolUseContext` for downstream calls
  // — e.g. to record the active tab after `browser_navigation.navigate`,
  // or the new `cwd` after a Bash `cd`. Claudy only honors `contextModifier`
  // for **non**-concurrency-safe tools, because applying mutation hooks
  // from concurrent siblings would race. BrowserX must follow the same
  // rule: the orchestrator MUST skip `contextModifier` when the tool is
  // executing inside a concurrent batch. See `Tool.ts`.
  contextModifier?(context: ToolUseContext): ToolUseContext
}

export interface ToolRuntimeMetadata {
  concurrency: ToolConcurrencyProfile
  ui?: ToolUIProfile
  result?: ToolResultProfile
  lifecycle?: ToolLifecycleProfile
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

**Divergence note vs Claudy.** Claudy does **not** model tool progress as a distinct event type. It emits progress as a regular `'tool_progress'` *message* in its assistant/tool stream, alongside tool_use and tool_result messages — see how `StreamingToolExecutor` interleaves progress into the same async iterator that yields tool results. BrowserX's plan to define a first-class `ToolExecutionProgressEvent` is a deliberate divergence: it fits BrowserX's existing typed event bus and avoids overloading message channels. Implementers should be aware that any future code that ports a Claudy stream consumer will need an adapter layer to translate `'tool_progress'` messages into `ToolExecutionProgressEvent` (or vice versa).

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
- **sibling abort propagation:** when one call in a concurrent batch errors (or is rejected by approval), all sibling in-flight calls in the same batch must be aborted and replaced with synthetic error results so the model sees a consistent batch outcome rather than partial mystery silence. This mirrors Claudy's `StreamingToolExecutor` (see `services/tools/StreamingToolExecutor.ts`), which cancels the remaining concurrent tool uses on the first failure and emits a synthetic error message for each. BrowserX should plumb a per-batch `AbortController` into `ToolExecutionRequest` so executors can react.

Bounded parallelism:

```ts
export const MAX_SAFE_TOOL_CALL_CONCURRENCY = 5
```

Claudy defaults to **10**, configurable via the `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` environment variable (see `services/tools/toolOrchestration.ts`). BrowserX's chosen `5` is a deliberate tightening, not parity: BrowserX tools frequently use Chrome APIs, debugger sessions, DOM serialization, screenshots, or hidden tabs/windows, so the per-batch ceiling is lower by design.

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

### Opting out of truncation

Some tools must not be truncated, because their output is the very content the agent will then act on, and a truncated result would force the agent to re-issue the same call in a loop. Claudy's `Read` tool is the canonical example: it sets `maxResultSizeChars: Infinity` so file contents flow through to the model untouched. BrowserX should follow the same convention — any tool whose result would create a re-read / re-fetch persistence loop (a future BrowserX `Read`-equivalent, or a content-snapshot tool) should set `maxResultSizeChars: Infinity` to disable truncation. The truncation branch in `ToolRegistry.execute()` must therefore guard against `Infinity` and skip slicing in that case.

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

---

## Validation Notes (re-checked vs claudy 2026-05-11)

This section records corrections applied after a re-validation pass against the claudy source. Each bullet cites the claudy file the correction was derived from.

- **Concurrency cap.** Claudy defaults to `10`, configurable via the `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` environment variable, not `5`. BrowserX's `MAX_SAFE_TOOL_CALL_CONCURRENCY = 5` is now framed as a deliberate tightening for browser/tab overhead rather than as parity. Source: `services/tools/toolOrchestration.ts`.
- **Input-dependent classification promoted to a stated principle.** Concurrency classification takes the call's `input` and inspects it; the canonical claudy example is `BashTool`, where `isConcurrencySafe(input) === isReadOnly(input)` and `isReadOnly(input)` parses the `command` string to disqualify shell verbs like `cd`. BrowserX equivalents are `web_scraping(url=…)` and `form_automation(url=…)`. Sources: `Tool.ts`, `tools/BashTool/BashTool.tsx`.
- **`contextModifier` documented.** Tools may return a `contextModifier(context) => context` function that updates downstream `ToolUseContext` (e.g. active tab, cwd). Claudy only honors `contextModifier` for **non**-concurrency-safe tools, because applying mutation hooks from concurrent siblings would race; BrowserX must enforce the same rule. Source: `Tool.ts`.
- **`interruptBehavior` documented.** Tools may declare `interruptBehavior(): 'cancel' | 'block'`, defaulting to `'block'`. Controls whether a new user message can preempt the in-flight tool. BrowserX use case: `browser_navigation.waitForLoad` should be `'block'`. Source: `Tool.ts`.
- **`isSearchOrReadCommand` documented.** Optional UI hint that lets the transcript view collapse/dim read-only operations. It does not influence concurrency classification. Source: `Tool.ts`.
- **`isEnabled` documented.** Tools may be conditionally hidden from the model by returning `false` from `isEnabled()`. Source: `Tool.ts`.
- **`maxResultSizeChars: Infinity` documented.** Tools whose results would otherwise create a re-fetch / re-read persistence loop (claudy's `Read` is the canonical example) should set `maxResultSizeChars: Infinity` to disable truncation. The `ToolRegistry.execute()` truncation branch must guard against `Infinity`. Source: `Tool.ts`.
- **Sibling abort propagation in concurrent batches.** When one call in a concurrent batch errors, sibling in-flight calls in the same batch must be aborted and replaced with synthetic error results so the model sees a consistent batch outcome. Source: `services/tools/StreamingToolExecutor.ts`.
- **Progress-event shape divergence flagged.** Claudy emits progress as a regular `'tool_progress'` message in its tool stream, not as a distinct typed event. BrowserX's plan to define a first-class `ToolExecutionProgressEvent` is acceptable but is now explicitly flagged as a divergence so future stream-consumer ports remember to bridge the two shapes. Source: `services/tools/StreamingToolExecutor.ts`.
