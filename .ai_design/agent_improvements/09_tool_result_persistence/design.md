# Track 09: Tool Result Persistence

## Problem

Track 02 introduced `maxResultSizeChars` per tool with in-memory truncation. When a tool result exceeds the limit, the tail is sliced off and a marker is appended:

```
[Result truncated from 150000 to 100000 chars]
```

The discarded content is gone forever. The agent cannot retrieve it.

Claudy solves this differently: oversized results are persisted to disk, and the agent receives a preview plus a file path. The agent can then use `Read` to access the full content if needed. No information is lost — it's deferred, not destroyed.

BrowserX should adopt the same pattern, adapted for its multi-platform runtime (extension, desktop, server).

## What Claudy Does

Source: `claudy/src/utils/toolResultStorage.ts`, `claudy/src/constants/toolLimits.ts`

### Two-tier result management

**Tier 1: Per-tool persistence** (`maybePersistLargeToolResult`)

When a single tool result exceeds `getPersistenceThreshold(toolName, maxResultSizeChars)`:

1. Full result written to `{projectDir}/{sessionId}/tool-results/{toolUseId}.{txt|json}`
2. File write uses `flag: 'wx'` (exclusive create) — idempotent across replayed turns
3. Agent receives a preview message:
   ```
   <persisted-output>
   Output too large (68.3KB). Full output saved to: /path/to/tool-results/abc123.txt

   Preview (first 2KB):
   [first 2000 bytes, cut at a newline boundary]
   ...
   </persisted-output>
   ```
4. Preview cuts at the last newline within 2000 bytes to avoid mid-line truncation
5. The agent can call `Read` on the file path to get the full content

**Tier 2: Per-message aggregate budget** (`enforceToolResultBudget`)

When N parallel tool results in a single turn collectively exceed `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` (200K):

1. The largest fresh (never-before-seen) results are selected for persistence
2. They go through the same persist-to-disk + preview flow
3. Decisions are frozen per `tool_use_id` — once a result is seen, its fate never changes across turns
4. This preserves prompt cache stability: re-applying the same replacement on subsequent turns produces byte-identical content

### Key constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_MAX_RESULT_SIZE_CHARS` | 50,000 | Global per-tool cap |
| `MAX_TOOL_RESULT_BYTES` | 400,000 | Hard byte limit (~100K tokens) |
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | 200,000 | Per-turn aggregate budget |
| `PREVIEW_SIZE_BYTES` | 2,000 | Preview length in persisted-output message |

### Design properties worth preserving

1. **Lossless** — full content is always accessible via file path
2. **Idempotent** — `'wx'` flag means replay never overwrites
3. **Cache-stable** — `ContentReplacementState` freezes decisions so re-application is a Map lookup, not file I/O
4. **Graceful degradation** — if persistence fails, original content is returned unchanged (not truncated)
5. **Opt-out** — tools with `maxResultSizeChars: Infinity` (e.g., Read) are never persisted to avoid circular Read → file → Read loops

---

## BrowserX Findings

### 1. Three runtime environments with different storage capabilities

| Mode | Filesystem | IndexedDB | SessionCacheManager |
|------|-----------|-----------|---------------------|
| Extension | No | Yes | Yes (via IndexedDB) |
| Desktop | Yes (Tauri fs) | Yes | Yes |
| Server | Yes (Node fs) | No | No (uses file-based persistence) |

Claudy's approach assumes a filesystem. BrowserX needs a storage abstraction that works across all three modes.

### 2. BrowserX already has `SessionCacheManager` and `StorageTool`

`SessionCacheManager` (used by `StorageTool`) provides:
- Session-scoped key-value storage
- Auto-eviction when quota exceeded (oldest 50%)
- Max 5MB per item, 200MB per session
- Available in extension and desktop modes

This is a natural fit for persisting oversized tool results in extension/desktop mode. In server mode, the filesystem is available directly.

### 3. BrowserX has no `Read` tool equivalent

Claudy agents use `Read` to retrieve persisted files. BrowserX has `StorageTool` with a `read` action, but it reads from session cache — not from arbitrary file paths.

The retrieval path must work through the existing tool surface:
- Extension/Desktop: Agent calls `cache_storage_tool` with `action: 'read'` and the storage key
- Server: Agent calls `cache_storage_tool` (if available) or a new retrieval mechanism

### 4. Current truncation happens in `ToolRegistry.execute()` at the wrong layer

Track 02 truncates inside `ToolRegistry.execute()`:

```typescript
if (maxChars && typeof result === 'string' && result.length > maxChars) {
  result = result.slice(0, maxChars) +
    `\n\n[Result truncated from ${originalLength} to ${maxChars} chars]`;
}
```

This is too late — the result is already a raw value. Claudy's persistence works at the message-assembly layer (`processToolResultBlock`), where the result is being formatted for the API. BrowserX should similarly intercept at the point where `function_call_output` is being produced, not inside the registry execution path.

### 5. Only string results are truncated

Track 02 only truncates `typeof result === 'string'`. Many tools return objects that get `JSON.stringify()`-ed in `TurnManager.executeToolCall()`. A 200K DOM snapshot object becomes a 200K JSON string — but the truncation check happened before stringification, so it passes through uncut.

The size check must happen after serialization, not before.

---

## Target Design

### 1. Platform-aware storage backend

Create a `ToolResultStore` abstraction with two implementations:

```typescript
// src/tools/resultStore.ts

interface ToolResultStore {
  /** Persist a tool result and return a retrieval reference. */
  persist(sessionId: string, toolUseId: string, content: string): Promise<PersistedResult>;
  /** Retrieve persisted content by reference. */
  retrieve(reference: string): Promise<string | null>;
  /** Clean up all persisted results for a session. */
  cleanup(sessionId: string): Promise<void>;
}

interface PersistedResult {
  reference: string;          // Storage key or file path
  originalSize: number;
  preview: string;            // First ~2000 chars
  hasMore: boolean;
}
```

**Extension/Desktop implementation** — uses `SessionCacheManager`:
- Storage key: `__tool_result__{toolUseId}`
- Retrieval: `SessionCacheManager.read(key)`
- Cleanup: automatic via session cache eviction, plus explicit cleanup on session end

**Server implementation** — uses filesystem:
- File path: `.browserx/sessions/{sessionId}/tool-results/{toolUseId}.txt`
- Write with `flag: 'wx'` (idempotent, like claudy)
- Cleanup: delete directory on session end

### 2. Move size enforcement from `ToolRegistry.execute()` to `TurnManager`

The size check should happen in `TurnManager.executeToolCall()` after `JSON.stringify()`, when producing `function_call_output`:

```typescript
// In TurnManager.executeToolCall(), after getting the result:
const output = typeof result === 'string' ? result : JSON.stringify(result);

// Check against maxResultSizeChars AFTER serialization
const maxChars = this.toolRegistry.getResultProfile(toolName)?.maxResultSizeChars;
if (maxChars && output.length > maxChars) {
  const persisted = await this.toolResultStore.persist(sessionId, callId, output);
  const preview = buildPersistedOutputMessage(persisted);
  return { type: 'function_call_output', call_id: callId, output: preview };
}

return { type: 'function_call_output', call_id: callId, output };
```

Remove the truncation logic from `ToolRegistry.execute()`.

### 3. Preview message format

Adapt claudy's `<persisted-output>` format for BrowserX:

```
<persisted-output>
Output too large ({originalSize} chars). Full output stored with key: {reference}

To retrieve the full output, use cache_storage_tool with action "read" and key "{reference}".

Preview (first 2000 chars):
{preview content, cut at newline boundary}
...
</persisted-output>
```

In server mode with filesystem storage:
```
<persisted-output>
Output too large ({originalSize} chars). Full output saved to: {filePath}

Preview (first 2000 chars):
{preview content}
...
</persisted-output>
```

### 4. Per-message aggregate budget (tier 2)

When multiple tool calls in one turn collectively produce more than `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` (200K), apply the same logic: persist the largest results first until under budget.

This prevents 5 parallel safe tool calls from each returning 50K and flooding the context with 250K in one turn.

Implementation:
- After all tool results are collected in `handleResponseItem()`, sum their serialized sizes
- If over budget, sort by size descending, persist the largest until under budget
- This runs after batch execution completes, before returning results to the conversation

### 5. Retrieval path

The agent retrieves persisted results through existing tools — no new tool needed:

- **Extension/Desktop**: `cache_storage_tool` with `action: 'read'`, `key: '__tool_result__{toolUseId}'`
- **Server**: The file path in the preview message can be read by any file-access tool available in server mode

The `<persisted-output>` message explicitly tells the agent which tool and arguments to use.

### 6. Cache stability for conversation replay

Adopt claudy's `ContentReplacementState` pattern:

- Track which `tool_use_id` values have been seen and what replacement was applied
- On conversation replay (compaction, resume), re-apply the same replacement from the cached preview string — no storage I/O needed
- Once a result's fate is decided (persisted or not), it never changes

This ensures prompt cache stability: replayed turns produce byte-identical content.

---

## Files to Change

| File | Change |
|------|--------|
| `src/tools/resultStore.ts` | **New** — `ToolResultStore` interface + platform implementations |
| `src/core/TurnManager.ts` | Move size enforcement after serialization; add per-message budget |
| `src/tools/ToolRegistry.ts` | Remove inline truncation from `execute()` |
| `src/tools/runtimeMetadata.ts` | No changes needed (types are fine) |
| `src/tools/index.ts` | No changes needed (per-tool limits are fine) |

---

## Implementation Phases

### Phase 1: Storage Backend

- Define `ToolResultStore` interface
- Implement `CacheToolResultStore` using `SessionCacheManager` (extension/desktop)
- Implement `FileToolResultStore` using `node:fs` (server)
- Platform detection to select the right implementation
- Preview generation: truncate at last newline within 2000 chars

### Phase 2: Persist Instead of Truncate

- Remove truncation from `ToolRegistry.execute()`
- Add persistence in `TurnManager.executeToolCall()` after serialization
- Build `<persisted-output>` message with retrieval instructions
- Graceful fallback: if persistence fails, fall back to truncation (current behavior)

### Phase 3: Per-Message Aggregate Budget

- After batch execution in `handleResponseItem()`, check aggregate size
- If over 200K, persist the largest results until under budget
- Track decisions in `ContentReplacementState` for replay stability

### Phase 4: Cleanup and Lifecycle

- Clean up persisted results on session end
- Handle compaction: re-apply cached replacements without storage I/O
- Handle resume: reconstruct replacement state from transcript

---

## Risks and Mitigations

### Risk: SessionCacheManager quota contention

Tool results compete with user-stored cache entries for the 200MB per-session quota.

Mitigation: Use a distinct key prefix (`__tool_result__`) so eviction policy can prioritize tool results as lower-priority than user data. Or use a separate storage namespace.

### Risk: Large persisted results in IndexedDB

IndexedDB performance degrades with very large values (>10MB).

Mitigation: `SessionCacheManager` already caps items at 5MB. If a tool result exceeds 5MB, fall back to truncation with the marker. This is an extreme edge case — most oversized results are 50K-500K.

### Risk: Agent doesn't know how to retrieve

The agent may not realize it can call `cache_storage_tool` to get the full content.

Mitigation: The `<persisted-output>` message explicitly names the tool and arguments. This is the same approach claudy uses — the agent sees the instruction in the tool result and can act on it.

### Risk: Circular persistence for read-back tools

If a tool reads persisted content and returns it, that result could itself be persisted, creating a loop.

Mitigation: Follow claudy's pattern — `cache_storage_tool` with `action: 'read'` should have `maxResultSizeChars: Infinity` (opt out of persistence). The read-back tool's own output is never persisted.
