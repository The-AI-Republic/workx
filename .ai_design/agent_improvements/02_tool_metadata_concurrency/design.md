# Track 02: Tool Metadata & Concurrency

## Problem

BrowserX tools have minimal metadata: a name, description, parameters, and an optional loosely-typed `ToolMetadata` bag. There is no standard way to declare:

- Whether a tool is safe to run concurrently with other tools
- Whether a tool is read-only vs. write (mutation)
- Whether a tool is destructive (irreversible)
- How a tool reports progress during execution
- How to classify a tool for UI display (search vs. action vs. read)

Claudy tools carry 40+ properties including concurrency safety, progress reporting via typed callbacks, read/write/destructive classification, and activity descriptions for spinner display.

## What Claudy Does

### Concurrency Metadata (Per-Input)

```typescript
// Each tool declares these methods:
isConcurrencySafe(input: ToolInput): boolean   // Safe to run in parallel?
isReadOnly(input: ToolInput): boolean          // Doesn't mutate state?
isDestructive(input: ToolInput): boolean       // Irreversible operation?

// Examples:
// FileReadTool: always concurrency-safe, always read-only
// BashTool: depends on command analysis (read-only commands are concurrent-safe)
// FileEditTool: never concurrency-safe (writes to files)
// MCPTool: reads from server annotations (readOnlyHint, destructiveHint)
```

Key insight: concurrency safety is **per-input**, not per-tool. A BashTool running `ls` is read-only; running `rm -rf` is destructive. Claudy's BashTool parses the command AST to determine this.

### Progress Reporting

```typescript
type ToolCallProgress<P extends ToolProgressData> = (
  progress: ToolProgress<P>
) => void

// Each tool type has its own progress type:
type BashProgress = { type: 'bash_progress'; lines: number; bytes: number; ... }
type MCPProgress = { type: 'mcp_progress'; status: 'started'|'completed'|'failed'; ... }

// Progress callback passed at call time:
tool.call(input, context, canUse, parentMsg, onProgress)
```

### Tool Classification

```typescript
// For UI: collapsible sections, spinners, search results
isSearchOrReadCommand(input): { isSearch: boolean; isRead: boolean; isList: boolean }
getActivityDescription(input): string | null  // "Reading src/foo.ts", "Running tests"

// For deduplication:
inputsEquivalent(a, b): boolean  // Same file read? Skip duplicate.
```

### Tool Defaults (Fail-Closed)

```typescript
const TOOL_DEFAULTS = {
  isConcurrencySafe: () => false,   // Assume NOT safe
  isReadOnly: () => false,          // Assume writes
  isDestructive: () => false,       // Assume reversible
  isEnabled: () => true,
}
```

### Result Size Management

```typescript
maxResultSizeChars: number  // Threshold before result persisted to disk
// BashTool: 30,000 chars
// FileEditTool: 100,000 chars
// Prevents large tool results from bloating conversation context
```

## BrowserX Mapping

### Current Tool Contract

```typescript
// From BaseTool.ts
type ToolDefinition =
  | { type: 'function'; function: ResponsesApiTool; metadata?: ToolMetadata }
  | { type: 'local_shell' }
  | { type: 'web_search' }
  | { type: 'custom'; custom: FreeformTool }

interface ToolMetadata {
  capabilities?: string[]
  permissions?: string[]
  platforms?: Platform[]
  [key: string]: unknown  // Loosely typed bag
}
```

### Proposed Extensions

```typescript
interface ToolConcurrencyMetadata {
  /** Per-input concurrency safety check */
  isConcurrencySafe(input: Record<string, unknown>): boolean
  /** Per-input read-only check */
  isReadOnly(input: Record<string, unknown>): boolean
  /** Per-input destructive check (irreversible operations) */
  isDestructive(input: Record<string, unknown>): boolean
}

interface ToolProgressMetadata<P extends ToolProgressData = ToolProgressData> {
  /** Callback type for progress reporting */
  onProgress?: (progress: ToolProgress<P>) => void
  /** Human-readable activity description for spinner/status */
  getActivityDescription?(input: Record<string, unknown>): string | null
}

interface ToolResultMetadata {
  /** Max chars before result is persisted to disk instead of kept in context */
  maxResultSizeChars?: number
  /** Classification for UI display */
  isSearchOrReadCommand?(input: Record<string, unknown>): {
    isSearch: boolean
    isRead: boolean
    isList: boolean
  }
}

// Extended ToolDefinition
interface ExtendedToolDefinition extends ToolDefinition {
  concurrency?: ToolConcurrencyMetadata
  progress?: ToolProgressMetadata
  result?: ToolResultMetadata
}
```

### Concrete BrowserX Tool Mapping

> **Note on tool naming:** Some tools have different function-definition names (what the LLM sees) vs. registry keys (internal dispatch). This table uses function-definition names. Where they differ, the registry key is noted in parentheses.

| Tool | Concurrent-Safe | Read-Only | Destructive | Progress |
|------|----------------|-----------|-------------|----------|
| `browser_dom` (snapshot) [registry: `dom_tool`] | Yes | Yes | No | DOM tree size |
| `browser_dom` (click) | No | No | No | Click target |
| `browser_dom` (type) | No | No | No | Input content |
| `browser_navigation` [registry: `navigation_tool`] | No | No | No | URL loading |
| `web_scraping` | Yes | Yes | No | Content extraction |
| `form_automation` | No | No | No | Form fields filled |
| `data_extraction` | Yes | Yes | No | Data rows extracted |
| `cache_storage_tool` (read) [registry: `storage_tool`] | Yes | Yes | No | - |
| `cache_storage_tool` (write) | No | No | No | - |
| `page_vision` | Yes | Yes | No | Screenshot capture |
| `network_intercept` | **No** | **No** | No | Requests intercepted |
| `planning_tool` | Yes | No | No | - |

> **`network_intercept` is NOT read-only.** Despite monitoring network traffic, this tool calls `chrome.declarativeNetRequest.updateDynamicRules()` to add/remove interception rules, tracks `modifiedRequests` in its metrics, and has a stateful start/stop lifecycle. It must be classified as a write operation that is not concurrency-safe.

### Integration with Existing Parallel Tool Call Design

This track directly feeds into the existing `multiple_tools_call/` design:

1. **Concurrency metadata** tells the parallel tool orchestrator which tools can run together
2. **Progress callbacks** enable the UI to show status for concurrent tools
3. **Result size management** prevents context bloat when multiple tools return large results

### Phase Plan

**Phase 1: Type Definitions** (Week 1)
- Define `ToolConcurrencyMetadata`, `ToolProgressMetadata`, `ToolResultMetadata` interfaces
- Extend `ToolDefinition` with optional metadata fields
- Add fail-closed defaults in ToolRegistry

**Phase 2: Annotate Existing Tools** (Week 2)
- Add concurrency metadata to all 11 registered tools
- Implement per-input checks for `browser_dom` / `dom_tool` (read vs. click vs. type)
- Implement per-input checks for `cache_storage_tool` / `storage_tool` (read vs. write)
- Mark `network_intercept` as non-concurrent, non-read-only (stateful interception rules)
- Add `getActivityDescription()` to all tools

**Phase 3: Progress Reporting** (Week 3)
- Define tool-specific progress types (DOMProgress, NavigationProgress, etc.)
- Thread `onProgress` callback through `ToolRegistry.execute()`
- Implement progress emission in `browser_dom`, `browser_navigation`, `web_scraping`
- Connect progress events to existing EventMsg types

**Phase 4: Result Management** (Week 4)
- Add `maxResultSizeChars` to tools with large outputs (`web_scraping`, `data_extraction`)
- Implement disk persistence for oversized results
- Add result reference in conversation (pointer to disk file instead of inline content)

## Risks

- **Input analysis complexity**: Per-input concurrency checks for dom_tool require understanding the action parameter. Start with action-type dispatch (read actions = safe, mutation actions = unsafe).
- **Progress overhead**: Progress callbacks on every tool call add overhead. Use opt-in (only emit when onProgress callback is provided).
