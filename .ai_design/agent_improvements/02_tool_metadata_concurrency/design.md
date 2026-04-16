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

---

## Deep Dive: Claudy Implementation Details

> These details were extracted from claudy source code to guide BrowserX implementation.

### `buildTool()` Pattern (claudy `src/Tool.ts:783-792`)

Claudy uses a **builder function** that merges fail-closed defaults with tool-specific overrides. This eliminates `?.() ?? default` checks everywhere:

```typescript
// claudy src/Tool.ts
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,    // FAIL-CLOSED
  isReadOnly: (_input?: unknown) => false,            // FAIL-CLOSED
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (input) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,          // defaults first
    userFacingName: () => def.name,
    ...def,                     // tool overrides win
  } as BuiltTool<D>
}
```

**BrowserX equivalent**: We don't have `buildTool()` — our tools are class-based (`BaseTool` subclasses). The defaults must live in `ToolRegistry.register()` or in a `ToolRegistryEntry` wrapper.

### Orchestrator: `partitionToolCalls()` (claudy `src/services/tools/toolOrchestration.ts:91-116`)

The core concurrency decision happens by **partitioning** tool calls into batches:

```typescript
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)

    // Call isConcurrencySafe — catch-wrapped, fail-closed
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try { return Boolean(tool?.isConcurrencySafe(parsedInput.data)) }
          catch { return false }  // parse failure → not safe
        })()
      : false

    // Merge consecutive safe tools into one batch
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

**Decision flow:**
```
LLM returns [tool_A, tool_B, tool_C, tool_D, tool_E]
                ↓
partitionToolCalls() checks each:
  tool_A: isConcurrencySafe(input_A) → true
  tool_B: isConcurrencySafe(input_B) → true
  tool_C: isConcurrencySafe(input_C) → false  ← batch break
  tool_D: isConcurrencySafe(input_D) → true
  tool_E: isConcurrencySafe(input_E) → true
                ↓
Result: [
  { safe: true,  blocks: [A, B] },      ← run A+B in parallel
  { safe: false, blocks: [C] },          ← run C alone
  { safe: true,  blocks: [D, E] },      ← run D+E in parallel
]
                ↓
Batches execute sequentially, but tools within a safe batch run concurrently
```

### Concurrent Execution with Context Modifiers (claudy `toolOrchestration.ts:30-63`)

```typescript
if (isConcurrencySafe) {
  const queuedContextModifiers: Record<string, ((ctx) => ctx)[]> = {}
  
  // Run batch concurrently — but QUEUE context modifiers (don't apply mid-flight)
  for await (const update of runToolsConcurrently(blocks, ...)) {
    if (update.contextModifier) {
      const { toolUseID, modifyContext } = update.contextModifier
      queuedContextModifiers[toolUseID] ??= []
      queuedContextModifiers[toolUseID].push(modifyContext)
    }
    yield { message: update.message, newContext: currentContext }  // unchanged context
  }
  
  // AFTER all concurrent tools complete, apply modifiers IN ORDER of original blocks
  for (const block of blocks) {
    for (const modifier of queuedContextModifiers[block.id] ?? []) {
      currentContext = modifier(currentContext)
    }
  }
  yield { newContext: currentContext }
}
```

**Key pattern**: Context modifiers from concurrent tools are **queued** and applied **after** the batch completes, in the original tool order. This prevents race conditions.

### Max Concurrency (claudy `toolOrchestration.ts:8-12`)

```typescript
function getMaxToolUseConcurrency(): number {
  return parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
}
```

Default: **10 parallel tools max**. Configurable via env var.

### Async Generator Interleaving (`all()` utility)

Claudy uses `all()` from `src/utils/generators.ts` to run multiple async generators concurrently with bounded parallelism. Each generator yields progress/messages independently and `all()` interleaves them:

```typescript
async function* runToolsConcurrently(blocks, ...) {
  yield* all(
    blocks.map(async function* (toolUse) {
      yield* runToolUse(toolUse, ...)  // each tool is its own async generator
    }),
    getMaxToolUseConcurrency(),        // max concurrent generators
  )
}
```

### Concrete Tool Metadata Examples

**FileReadTool** (always safe):
```typescript
isConcurrencySafe() { return true },
isReadOnly() { return true },
isSearchOrReadCommand() { return { isSearch: false, isRead: true } },
maxResultSizeChars: Infinity,  // Never persisted — already self-bounded
```

**BashTool** (input-dependent safety, `src/tools/BashTool/BashTool.tsx:285-315`):
```typescript
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false  // Safe IFF read-only
},
isReadOnly(input) {
  const compoundCommandHasCd = commandHasAnyCd(input.command)
  const result = checkReadOnlyConstraints(input, compoundCommandHasCd)
  return result.behavior === 'allow'
},
maxResultSizeChars: 30_000,
getActivityDescription(input) { return `Running: ${truncate(input.command, 60)}` },
```

**FileEditTool** (never safe, `src/tools/FileEditTool/FileEditTool.ts:86-102`):
```typescript
// Omits isConcurrencySafe and isReadOnly → TOOL_DEFAULTS (false, false)
maxResultSizeChars: 100_000,
getActivityDescription(input) {
  const summary = getToolUseSummary(input)
  return summary ? `Editing ${summary}` : 'Editing file'
},
inputsEquivalent(input1, input2) {
  return areFileEditsInputsEquivalent(...)  // Deduplicates identical edits
},
```

**ExitWorktreeTool** (conditionally destructive):
```typescript
isDestructive(input) {
  return input.action === 'remove'  // Only destructive when removing
}
```

### Result Size Persistence (claudy `src/utils/toolResultStorage.ts`)

When a tool result exceeds `maxResultSizeChars`:
1. Result written to `/{projectDir}/{sessionId}/tool-results/{toolUseId}.{txt|json}`
2. Model receives a **preview** (first ~2000 bytes) + file path reference wrapped in `<persisted-output>` XML
3. Global cap: `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000` — tools declare their own, but the system clamps to this global max

### Progress Callback Threading (claudy BashTool example)

```typescript
async call(input, toolUseContext, _canUseTool, parentMessage, onProgress) {
  const commandGenerator = runShellCommand({...})
  let progressCounter = 0
  let generatorResult
  do {
    generatorResult = await commandGenerator.next()
    if (!generatorResult.done && onProgress) {
      onProgress({
        toolUseID: `bash-progress-${progressCounter++}`,
        data: {
          type: 'bash_progress',
          output: progress.output,
          fullOutput: progress.fullOutput,
          elapsedTimeSeconds: progress.elapsedTimeSeconds,
          totalLines: progress.totalLines,
          totalBytes: progress.totalBytes,
        }
      })
    }
  } while (!generatorResult.done)
}
```

**Key**: Progress is opt-in — the callback is only called when `onProgress` is provided. No overhead for callers that don't need it.

---

## BrowserX Mapping

### Current Tool Contract

```typescript
// From BaseTool.ts (src/tools/BaseTool.ts:67-77)
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

### Current Tool Execution Flow

Understanding the existing flow is critical to knowing where to inject concurrency decisions:

```
1. LLM returns response items (may include tool_calls)
         ↓
2. TurnManager.processResponseItem() (src/core/TurnManager.ts:551-583)
   - Iterates item.tool_calls array
   - Calls executeToolCall() for EACH call SEQUENTIALLY (for loop)
         ↓
3. TurnManager.executeToolCall() (TurnManager.ts:630-707)
   - Parses parameters (JSON string → object)
   - Routes: web_search → WebSearchTool, registry tools → executeBrowserTool(), MCP → executeMcpTool()
         ↓
4. TurnManager.executeBrowserTool() (TurnManager.ts:795-870)
   - Creates ToolExecutionRequest { toolName, parameters, sessionId, turnId, tabId, timeout }
   - Calls toolRegistry.execute(request)
         ↓
5. ToolRegistry.execute() (src/tools/ToolRegistry.ts:236-420)
   - Validates tool exists + parameter schema
   - Approval gate check (enriches DOM params for risk assessment)
   - Emits ToolExecutionStart event
   - Calls handler(parameters, context) with Promise.race timeout (default 120s)
   - Emits ToolExecutionEnd/Error/Timeout event
   - Returns ToolExecutionResponse { success, data, error, duration }
         ↓
6. Result formatted as { type: 'function_call_output', call_id, output: JSON.stringify(result) }
```

**Current parallel tool call handling (TurnManager.ts:555-583):**
```typescript
// CURRENT: Sequential execution of all tool calls
if (item.type === 'message' && item.tool_calls?.length > 0) {
  const toolCallResults: any[] = [];
  for (const toolCall of item.tool_calls) {      // ← sequential for-loop
    const result = await this.executeToolCall(
      toolCall.function.name,
      toolCall.function.arguments,
      toolCall.id
    );
    toolCallResults.push(result);
  }
  return toolCallResults.length === 1 ? toolCallResults[0] : toolCallResults;
}
```

**This is the exact point where we inject the partitioning logic.**

### Current ToolRegistryEntry (src/tools/ToolRegistry.ts:37-42)

```typescript
interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;           // (params, context) => Promise<any>
  registrationTime: number;
  riskAssessor?: IRiskAssessor;
}
```

### Current Event Types for Tools (src/core/protocol/events.ts:84-90)

```typescript
| { type: 'ToolExecutionStart'; data: ToolExecutionStartEvent }
| { type: 'ToolExecutionEnd'; data: ToolExecutionEndEvent }
| { type: 'ToolExecutionError'; data: ToolExecutionErrorEvent }
| { type: 'ToolExecutionTimeout'; data: ToolExecutionTimeoutEvent }
```

These events already have `tool_name`, `session_id`, `duration`. We add `ToolExecutionProgress` alongside.

### Existing Browser Action Events (events.ts:100-103)

```typescript
| { type: 'DOMActionStart'; data: DOMActionStartEvent }
| { type: 'StorageActionStart'; data: StorageActionStartEvent }
| { type: 'NavigationActionStart'; data: NavigationActionStartEvent }
```

These can be repurposed as progress events rather than duplicating.

---

## Proposed Changes — Implementation Details

### Phase 1: Type Definitions

#### 1A. New Interfaces in `src/tools/types.ts` (new file)

```typescript
// src/tools/types.ts

/**
 * Per-input concurrency metadata.
 * Methods receive the parsed tool input and return concurrency classification.
 * All methods are synchronous — concurrency decisions must be fast.
 */
export interface ToolConcurrencyInfo {
  isConcurrencySafe(input: Record<string, unknown>): boolean
  isReadOnly(input: Record<string, unknown>): boolean
  isDestructive(input: Record<string, unknown>): boolean
}

/**
 * Fail-closed defaults. Applied by ToolRegistry when a tool doesn't declare
 * its own concurrency info. Mirrors claudy's TOOL_DEFAULTS pattern.
 */
export const TOOL_CONCURRENCY_DEFAULTS: ToolConcurrencyInfo = {
  isConcurrencySafe: () => false,   // Assume NOT safe to run in parallel
  isReadOnly: () => false,          // Assume it mutates state
  isDestructive: () => false,       // Assume it's reversible
}

/**
 * Base type for tool-specific progress data.
 * Each tool defines its own progress shape extending this.
 */
export interface ToolProgressData {
  type: string  // Discriminant: 'dom_progress' | 'navigation_progress' | etc.
}

/**
 * Progress event wrapper (matches claudy's ToolProgress<P>)
 */
export interface ToolProgress<P extends ToolProgressData = ToolProgressData> {
  toolUseID: string
  data: P
}

/**
 * Progress callback type (matches claudy's ToolCallProgress<P>)
 */
export type ToolProgressCallback<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>
) => void

/**
 * Activity description and UI classification for tools.
 */
export interface ToolUIInfo {
  /** Human-readable description for spinner/status display.
   *  e.g., "Clicking element #submit-btn", "Navigating to https://..." */
  getActivityDescription(input: Record<string, unknown>): string | null

  /** Classification for UI display (collapsible sections, search results) */
  isSearchOrReadCommand?(input: Record<string, unknown>): {
    isSearch: boolean
    isRead: boolean
    isList: boolean
  }
}

/**
 * Result size management for tools with potentially large outputs.
 */
export interface ToolResultInfo {
  /** Max chars before result is truncated/summarized instead of kept in full context.
   *  In browser extension context, we truncate + summarize rather than persist to disk
   *  (unlike claudy which writes to filesystem). */
  maxResultSizeChars: number

  /** Check if two inputs would produce equivalent results (for deduplication).
   *  e.g., two identical DOM snapshots → skip the second one. */
  inputsEquivalent?(a: Record<string, unknown>, b: Record<string, unknown>): boolean
}

// ============================================================================
// Tool-specific progress types
// ============================================================================

export interface DOMToolProgress extends ToolProgressData {
  type: 'dom_progress'
  action: 'snapshot' | 'click' | 'type' | 'keypress' | 'scroll'
  selector?: string
  status: 'started' | 'serializing' | 'executing' | 'completed' | 'failed'
  /** For snapshot: number of DOM nodes serialized so far */
  nodeCount?: number
}

export interface NavigationProgress extends ToolProgressData {
  type: 'navigation_progress'
  url: string
  status: 'loading' | 'loaded' | 'failed'
}

export interface WebScrapingProgress extends ToolProgressData {
  type: 'scraping_progress'
  contentType: string
  bytesExtracted: number
  status: 'started' | 'extracting' | 'completed' | 'failed'
}

export interface DataExtractionProgress extends ToolProgressData {
  type: 'extraction_progress'
  mode: string
  rowsExtracted: number
  status: 'started' | 'extracting' | 'completed' | 'failed'
}

export interface PageVisionProgress extends ToolProgressData {
  type: 'vision_progress'
  status: 'capturing' | 'captured' | 'failed'
  screenshotSizeBytes?: number
}

export interface NetworkInterceptProgress extends ToolProgressData {
  type: 'intercept_progress'
  action: string
  status: 'started' | 'rule_applied' | 'monitoring' | 'completed' | 'failed'
  requestsIntercepted?: number
}
```

#### 1B. Extend ToolRegistryEntry (modify `src/tools/ToolRegistry.ts:37-42`)

```typescript
// BEFORE
interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  registrationTime: number;
  riskAssessor?: IRiskAssessor;
}

// AFTER
interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  registrationTime: number;
  riskAssessor?: IRiskAssessor;
  // NEW: Concurrency and metadata fields
  concurrency: ToolConcurrencyInfo;        // Always present (defaults applied at registration)
  ui?: ToolUIInfo;                          // Optional UI classification
  result?: ToolResultInfo;                  // Optional result size management
}
```

#### 1C. Extend `ToolRegistry.register()` Signature

```typescript
// BEFORE (ToolRegistry.ts:77)
async register(tool: ToolDefinition, handler: ToolHandler, riskAssessor?: IRiskAssessor): Promise<void>

// AFTER
interface ToolRegistrationOptions {
  riskAssessor?: IRiskAssessor;
  concurrency?: Partial<ToolConcurrencyInfo>;   // Partial → defaults fill gaps
  ui?: ToolUIInfo;
  result?: ToolResultInfo;
}

async register(
  tool: ToolDefinition,
  handler: ToolHandler,
  options?: ToolRegistrationOptions | IRiskAssessor  // Backward compat: bare IRiskAssessor still works
): Promise<void> {
  // Normalize options
  const opts: ToolRegistrationOptions = options && 'assessRisk' in options
    ? { riskAssessor: options }  // Legacy: bare IRiskAssessor
    : (options ?? {});

  const entry: ToolRegistryEntry = {
    definition: tool,
    handler,
    registrationTime: Date.now(),
    riskAssessor: opts.riskAssessor,
    concurrency: { ...TOOL_CONCURRENCY_DEFAULTS, ...opts.concurrency },  // Fail-closed merge
    ui: opts.ui,
    result: opts.result,
  };
  // ... rest of registration
}
```

#### 1D. Extend `ToolRegistry.execute()` to Accept Progress Callback

```typescript
// BEFORE (ToolRegistry.ts:236)
async execute(request: ToolExecutionRequest): Promise<ToolExecutionResponse>

// AFTER
async execute(
  request: ToolExecutionRequest,
  onProgress?: ToolProgressCallback,
): Promise<ToolExecutionResponse> {
  // ... existing validation, approval gate ...

  const context: ToolContext = {
    sessionId: request.sessionId,
    turnId: request.turnId,
    toolName: request.toolName,
    metadata: {
      tabId: request.tabId,
      onProgress,  // Thread progress callback to handler
    },
  };

  result = await entry.handler(request.parameters, context);
  // ... rest unchanged
}
```

#### 1E. New Event Type: `ToolExecutionProgress` (modify `src/core/protocol/events.ts`)

```typescript
// Add to EventMsg union:
| { type: 'ToolExecutionProgress'; data: ToolExecutionProgressEvent }

// New event payload:
export interface ToolExecutionProgressEvent {
  tool_name: string;
  call_id?: string;
  session_id?: string;
  progress_data: ToolProgressData;  // Discriminated union by .type field
  timestamp: number;
}
```

#### 1F. New Method on ToolRegistry for Concurrency Queries

```typescript
// Add to ToolRegistry class
/**
 * Check if a tool call is concurrency-safe given its input.
 * Returns false (fail-closed) if tool not found or check throws.
 */
isConcurrencySafe(toolName: string, input: Record<string, unknown>): boolean {
  const entry = this.tools.get(toolName);
  if (!entry) return false;
  try {
    return entry.concurrency.isConcurrencySafe(input);
  } catch {
    return false;  // Fail-closed on error (mirrors claudy's catch block)
  }
}

isReadOnly(toolName: string, input: Record<string, unknown>): boolean {
  const entry = this.tools.get(toolName);
  if (!entry) return false;
  try {
    return entry.concurrency.isReadOnly(input);
  } catch {
    return false;
  }
}

isDestructive(toolName: string, input: Record<string, unknown>): boolean {
  const entry = this.tools.get(toolName);
  if (!entry) return false;
  try {
    return entry.concurrency.isDestructive(input);
  } catch {
    return false;
  }
}

getActivityDescription(toolName: string, input: Record<string, unknown>): string | null {
  const entry = this.tools.get(toolName);
  return entry?.ui?.getActivityDescription(input) ?? null;
}
```

### Phase 2: Annotate Existing Tools

#### 2A. Modify Tool Registration in `src/tools/index.ts`

Each tool registration call gains concurrency/ui/result metadata. Example for DOM tool:

```typescript
// BEFORE (index.ts:146-148)
const domTool = new DOMTool();
await registerTool('dom_tool', domTool, domRiskAssessor);

// AFTER
const domTool = new DOMTool();
await registry.register(domTool.getDefinition(), async (params, context) => {
  return domTool.execute(params, { metadata: { ...context.metadata, sessionId: context.sessionId, turnId: context.turnId, toolName: context.toolName } });
}, {
  riskAssessor: domRiskAssessor,
  concurrency: {
    isConcurrencySafe(input) {
      // snapshot is read-only → safe. All mutation actions → not safe.
      return input.action === 'snapshot';
    },
    isReadOnly(input) {
      return input.action === 'snapshot';
    },
    isDestructive(_input) {
      return false;  // DOM mutations are reversible (page reload resets)
    },
  },
  ui: {
    getActivityDescription(input) {
      switch (input.action) {
        case 'snapshot': return 'Capturing DOM snapshot';
        case 'click': return `Clicking element ${input.node_id ?? ''}`.trim();
        case 'type': return `Typing into element ${input.node_id ?? ''}`.trim();
        case 'keypress': return `Pressing key ${input.key ?? ''}`.trim();
        case 'scroll': return 'Scrolling page';
        default: return null;
      }
    },
  },
  result: {
    maxResultSizeChars: 100_000,  // DOM snapshots can be very large
  },
});
```

#### 2B. Complete Tool Annotation Table

| Tool (registry key) | `isConcurrencySafe(input)` | `isReadOnly(input)` | `isDestructive(input)` | `getActivityDescription(input)` | `maxResultSizeChars` |
|---|---|---|---|---|---|
| `dom_tool` | `input.action === 'snapshot'` | `input.action === 'snapshot'` | `false` | Action-based (see 2A) | 100,000 |
| `navigation_tool` | `false` | `false` (changes URL) | `false` | `"Navigating to {url}"` | 10,000 |
| `web_scraping` | `true` | `true` | `false` | `"Scraping content from page"` | 50,000 |
| `form_automation` | `false` | `false` (fills forms) | `false` | `"Filling form fields"` | 10,000 |
| `data_extraction` | `true` | `true` | `false` | `"Extracting {mode} data"` | 30,000 |
| `storage_tool` | `['read','list'].includes(input.action)` | `['read','list'].includes(input.action)` | `input.action === 'delete'` | Action-based | 50,000 |
| `page_vision` | `true` | `true` | `false` | `"Capturing screenshot"` | 50,000 |
| `network_intercept` | `false` | `false` (modifies rules) | `false` | `"Configuring network intercept"` | 10,000 |
| `planning_tool` | `true` | `false` (modifies plan) | `false` | `"Updating plan"` | 10,000 |
| `setting_tool` | `input.action === 'get'` | `input.action === 'get'` | `false` | `"Reading settings"` / `"Updating settings"` | 10,000 |
| `web_search` | `true` | `true` | `false` | `"Searching for {query}"` | 30,000 |

#### 2C. Storage Tool Per-Input Logic (example)

```typescript
concurrency: {
  isConcurrencySafe(input) {
    const action = input.action as string;
    return action === 'read' || action === 'list';
  },
  isReadOnly(input) {
    const action = input.action as string;
    return action === 'read' || action === 'list';
  },
  isDestructive(input) {
    return input.action === 'delete';
  },
},
```

### Phase 3: Parallel Execution in TurnManager

#### 3A. New Helper: `partitionToolCalls()` (new file `src/core/toolOrchestration.ts`)

This is the core change — adapted from claudy's `toolOrchestration.ts`:

```typescript
// src/core/toolOrchestration.ts

import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolProgressCallback } from '../tools/types';

interface ToolCall {
  id: string;
  function: { name: string; arguments: any };
}

interface Batch {
  isConcurrencySafe: boolean;
  calls: ToolCall[];
}

const MAX_TOOL_CONCURRENCY = 5;  // Conservative default for browser context
// (claudy uses 10, but browser tools are heavier — DOM, navigation, etc.)

/**
 * Partition tool calls into batches of consecutive concurrency-safe tools
 * and single non-safe tools. Mirrors claudy's partitionToolCalls().
 */
export function partitionToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
): Batch[] {
  return toolCalls.reduce((acc: Batch[], call) => {
    let parsedArgs = call.function.arguments;
    if (typeof parsedArgs === 'string') {
      try { parsedArgs = JSON.parse(parsedArgs); } catch { parsedArgs = {}; }
    }

    const isSafe = registry.isConcurrencySafe(call.function.name, parsedArgs);

    // Merge consecutive safe calls into one batch
    if (isSafe && acc.length > 0 && acc[acc.length - 1]!.isConcurrencySafe) {
      acc[acc.length - 1]!.calls.push(call);
    } else {
      acc.push({ isConcurrencySafe: isSafe, calls: [call] });
    }

    return acc;
  }, []);
}

/**
 * Execute a batch of tool calls concurrently using Promise.all with bounded concurrency.
 */
export async function executeToolCallsConcurrently(
  calls: ToolCall[],
  executor: (call: ToolCall) => Promise<any>,
): Promise<any[]> {
  // Simple bounded concurrency with chunking
  const results: any[] = [];
  for (let i = 0; i < calls.length; i += MAX_TOOL_CONCURRENCY) {
    const chunk = calls.slice(i, i + MAX_TOOL_CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(executor));
    results.push(...chunkResults);
  }
  return results;
}
```

#### 3B. Modify TurnManager.processResponseItem() (src/core/TurnManager.ts:555-583)

```typescript
// BEFORE: Sequential for-loop
if (item.type === 'message' && item.tool_calls?.length > 0) {
  const toolCallResults: any[] = [];
  for (const toolCall of item.tool_calls) {
    const result = await this.executeToolCall(...);
    toolCallResults.push(result);
  }
  return ...;
}

// AFTER: Partition + concurrent/sequential execution
if (item.type === 'message' && item.tool_calls?.length > 0) {
  const batches = partitionToolCalls(item.tool_calls, this.toolRegistry);
  const allResults: any[] = [];

  for (const batch of batches) {
    if (batch.isConcurrencySafe) {
      // Run batch concurrently
      const batchResults = await executeToolCallsConcurrently(
        batch.calls,
        (call) => this.executeToolCall(call.function.name, call.function.arguments, call.id),
      );
      allResults.push(...batchResults);
    } else {
      // Run batch sequentially (single non-safe tool per batch)
      for (const call of batch.calls) {
        const result = await this.executeToolCall(call.function.name, call.function.arguments, call.id);
        allResults.push(result);
      }
    }
  }

  return allResults.length === 1 ? allResults[0] : allResults;
}
```

#### 3C. Progress Event Emission (modify ToolRegistry.execute)

```typescript
// In ToolRegistry.execute(), after handler completes OR during execution:

// Option 1: Handler calls onProgress directly
const context: ToolContext = {
  ...existingContext,
  metadata: {
    ...existingMetadata,
    onProgress: onProgress ? (progressData: ToolProgressData) => {
      // Wrap in event and emit
      this.emitEvent({
        id: `evt_progress_${request.toolName}_${Date.now()}`,
        msg: {
          type: 'ToolExecutionProgress',
          data: {
            tool_name: request.toolName,
            session_id: request.sessionId,
            progress_data: progressData,
            timestamp: Date.now(),
          },
        },
      });
      // Also forward to caller's callback
      onProgress({ toolUseID: request.toolName, data: progressData });
    } : undefined,
  },
};
```

### Phase 4: Result Size Management

#### 4A. Result Truncation in ToolRegistry.execute()

In browser extension context, we can't write to filesystem like claudy does. Instead, we **truncate + summarize**:

```typescript
// After handler returns result, before returning ToolExecutionResponse:
const entry = this.tools.get(request.toolName)!;
const maxChars = entry.result?.maxResultSizeChars;

if (maxChars && result) {
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
  if (resultStr.length > maxChars) {
    // Truncate and add summary marker
    const truncated = resultStr.slice(0, maxChars);
    const summary = `[Result truncated: ${resultStr.length} chars → ${maxChars} chars. ` +
      `Full result was ${Math.round(resultStr.length / 1024)}KB]`;
    result = truncated + '\n\n' + summary;
  }
}
```

#### 4B. Storage-Based Result Persistence (Server Mode Only)

For server mode (which has filesystem access), implement claudy-style disk persistence:

```typescript
// src/tools/resultStorage.ts (new file, server mode only)

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const RESULT_STORAGE_DIR = '.browserx/tool-results';

export async function persistOversizedResult(
  sessionId: string,
  toolUseId: string,
  result: string,
  previewChars: number = 2000,
): Promise<{ preview: string; filePath: string }> {
  const dir = join(RESULT_STORAGE_DIR, sessionId);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, `${toolUseId}.txt`);
  await writeFile(filePath, result, 'utf-8');

  const preview = result.slice(0, previewChars);
  return {
    preview: `${preview}\n\n<persisted-output path="${filePath}" size="${result.length}" />`,
    filePath,
  };
}
```

---

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

---

## Phase Plan

**Phase 1: Type Definitions** (Week 1)
- Create `src/tools/types.ts` with all interfaces defined in section 1A
- Extend `ToolRegistryEntry` per section 1B
- Extend `ToolRegistry.register()` per section 1C (backward-compatible)
- Extend `ToolRegistry.execute()` per section 1D (add `onProgress` parameter)
- Add `ToolExecutionProgress` event type per section 1E
- Add concurrency query methods per section 1F

**Phase 2: Annotate Existing Tools** (Week 2)
- Modify `src/tools/index.ts` to pass concurrency/ui/result metadata per section 2A-2C
- Add metadata for all 11 tools per the table in section 2B
- Write unit tests for per-input checks:
  - `dom_tool`: snapshot → safe, click/type/keypress/scroll → not safe
  - `storage_tool`: read/list → safe, write/delete → not safe
  - `setting_tool`: get → safe, set → not safe
  - All tools: verify fail-closed defaults when no metadata provided

**Phase 3: Parallel Execution** (Week 3)
- Create `src/core/toolOrchestration.ts` per section 3A
- Modify `TurnManager.processResponseItem()` per section 3B
- Wire progress events per section 3C
- Add integration tests:
  - 2 concurrent-safe tools → run in parallel (timing assertion)
  - 1 non-safe tool between safe tools → creates 3 batches
  - Tool that throws in isConcurrencySafe → falls back to sequential

**Phase 4: Result Management** (Week 4)
- Add result truncation in `ToolRegistry.execute()` per section 4A
- Add disk persistence for server mode per section 4B
- Set `maxResultSizeChars` per the table in section 2B
- Add tests for truncation at boundary

---

## Key Differences from Claudy

| Aspect | Claudy | BrowserX |
|--------|--------|----------|
| Tool definition | Functional (`buildTool()`) | Class-based (`BaseTool` subclass) |
| Metadata location | On the tool object itself | In `ToolRegistryEntry` (separate from tool) |
| Execution model | Async generators (`yield*`) | Promise-based (`async/await`) |
| Result persistence | Filesystem (project dir) | Truncation (extension), filesystem (server) |
| Max concurrency | 10 (env configurable) | 5 (conservative for browser context) |
| Context modifiers | Queued during concurrent batch, applied after | Not needed (BrowserX tools don't modify execution context) |
| Input validation | Zod schemas | JSON Schema validation in ToolRegistry |
| Progress format | Typed per-tool (BashProgress, MCPProgress, etc.) | Typed per-tool (DOMToolProgress, NavigationProgress, etc.) |

## Risks

- **Input analysis complexity**: Per-input concurrency checks for dom_tool require understanding the action parameter. Start with action-type dispatch (read actions = safe, mutation actions = unsafe).
- **Progress overhead**: Progress callbacks on every tool call add overhead. Use opt-in (only emit when onProgress callback is provided).
- **Browser tab contention**: Even "read-only" tools like `page_vision` and `web_scraping` may contend for the same browser tab's CDP connection. Phase 3 should validate that CDP handles concurrent reads without race conditions.
- **Backward compatibility**: The `register()` signature change must accept both `IRiskAssessor` (legacy) and `ToolRegistrationOptions` (new). Section 1C handles this with a type guard.
- **Extension vs Server mode**: Result persistence strategy differs by platform. Extension mode truncates; server mode can write to disk. Use platform detection from `registerPlatformTools.ts`.
