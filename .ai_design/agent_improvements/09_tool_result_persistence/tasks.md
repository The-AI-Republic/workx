# Track 09: Tool Result Persistence - Tasks

## Phase 1: Storage Backend

### 1A. Define `ToolResultStore` interface
- [ ] Create `src/tools/resultStore.ts`
- [ ] Define `ToolResultStore` interface: `persist()`, `retrieve()`, `cleanup()`
- [ ] Define `PersistedResult` type: `reference`, `originalSize`, `preview`, `hasMore`
- [ ] Implement `generatePreview(content, maxBytes)` — truncate at last newline within limit

### 1B. Implement `CacheToolResultStore` (extension/desktop)
- [ ] Implement using `SessionCacheManager`
- [ ] Storage key format: `__tool_result__{toolUseId}`
- [ ] `persist()`: write to cache, return key as reference
- [ ] `retrieve()`: read from cache by key
- [ ] `cleanup()`: delete all keys with `__tool_result__` prefix for session
- [ ] Handle quota exceeded: fall back to truncation

### 1C. Implement `FileToolResultStore` (server)
- [ ] Implement using `node:fs`
- [ ] File path: `.browserx/sessions/{sessionId}/tool-results/{toolUseId}.txt`
- [ ] `persist()`: write with `flag: 'wx'` (idempotent), return file path as reference
- [ ] `retrieve()`: read file by path
- [ ] `cleanup()`: delete session tool-results directory
- [ ] `mkdir` with `recursive: true` on first write

### 1D. Platform selection
- [ ] Detect platform (`__BUILD_MODE__` or runtime check)
- [ ] Factory function: `createToolResultStore(platform)` → appropriate implementation
- [ ] Initialize in `TurnManager` or `Session` setup

### 1E. Unit tests for storage backend
- [ ] Test `generatePreview` cuts at newline boundary
- [ ] Test `generatePreview` returns full content when under limit
- [ ] Test `CacheToolResultStore.persist()` stores and returns reference
- [ ] Test `CacheToolResultStore.retrieve()` returns stored content
- [ ] Test `FileToolResultStore.persist()` writes file with `wx` flag
- [ ] Test `FileToolResultStore.persist()` is idempotent (second call doesn't fail)
- [ ] Test `FileToolResultStore.retrieve()` reads persisted file
- [ ] Test `cleanup()` removes all persisted results for a session

## Phase 2: Persist Instead of Truncate

### 2A. Remove truncation from `ToolRegistry.execute()`
- [ ] Remove the `maxResultSizeChars` truncation block from `ToolRegistry.execute()`
- [ ] Keep `maxResultSizeChars` on `ToolResultProfile` — it's still used as the threshold

### 2B. Add persistence in `TurnManager.executeToolCall()`
- [ ] After `JSON.stringify(result)`, check serialized size against `maxResultSizeChars`
- [ ] If over limit: call `toolResultStore.persist(sessionId, callId, output)`
- [ ] Build `<persisted-output>` message with:
  - Original size
  - Retrieval instruction (tool name + action + key/path)
  - Preview (first ~2000 chars)
- [ ] If persistence fails: fall back to truncation (current behavior as safety net)
- [ ] If under limit: return unchanged

### 2C. Build persisted-output message
- [ ] `buildPersistedOutputMessage(result: PersistedResult, platform: string)` function
- [ ] Extension/desktop format: references `cache_storage_tool` with `action: 'read'`
- [ ] Server format: references file path directly
- [ ] Include preview content

### 2D. Handle object results correctly
- [ ] Ensure size check happens AFTER `JSON.stringify()`, not before
- [ ] Test with DOM snapshot (object → large JSON string)

### 2E. Tests for persist-instead-of-truncate
- [ ] Test: result under limit passes through unchanged
- [ ] Test: oversized string result is persisted, preview returned
- [ ] Test: oversized object result (post-stringify) is persisted
- [ ] Test: persistence failure falls back to truncation
- [ ] Test: `<persisted-output>` message contains correct retrieval instructions
- [ ] Test: preview is ~2000 chars and cuts at newline

## Phase 3: Per-Message Aggregate Budget

### 3A. Implement aggregate size check
- [ ] After all tool results collected in `handleResponseItem()`, sum serialized sizes
- [ ] If total exceeds `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` (200K):
  - Sort results by size descending
  - Persist largest results until total is under budget
  - Replace their `function_call_output` with `<persisted-output>` messages
- [ ] Define constant: `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`

### 3B. Implement `ContentReplacementState`
- [ ] Define type: `{ seenIds: Set<string>, replacements: Map<string, string> }`
- [ ] Track per tool_use_id: was it persisted or passed through?
- [ ] Once decided, freeze the decision — never change on replay
- [ ] Re-application is a Map lookup, no storage I/O

### 3C. Wire replacement state into conversation lifecycle
- [ ] Create state when session starts
- [ ] Apply on each turn in `handleResponseItem()`
- [ ] On compaction/resume: reconstruct state from transcript

### 3D. Tests for aggregate budget
- [ ] Test: 5 results at 30K each (150K total) → all pass through (under 200K)
- [ ] Test: 5 results at 50K each (250K total) → largest persisted until under 200K
- [ ] Test: replay produces byte-identical output (replacement state is stable)
- [ ] Test: previously-seen results are never re-decided

## Phase 4: Cleanup and Lifecycle

### 4A. Session cleanup
- [ ] Call `toolResultStore.cleanup(sessionId)` when session ends
- [ ] Extension: integrate with `SessionCacheManager` cleanup
- [ ] Server: delete `tool-results/` directory

### 4B. Opt-out for read-back tools
- [ ] `cache_storage_tool` with `action: 'read'` should never have its result persisted
- [ ] Set `maxResultSizeChars: Infinity` for read-back operations (or skip persistence for specific tools)
- [ ] Test: read-back of persisted content is not re-persisted

### 4C. Integration tests
- [ ] Test: full round-trip — tool returns oversized result → persisted → agent retrieves via cache_storage_tool
- [ ] Test: server mode — persisted to file → preview references file path
- [ ] Test: session end cleans up persisted results

## Exit Criteria

- [ ] Oversized tool results are persisted (not discarded) across all three platforms
- [ ] Agent receives a preview with retrieval instructions
- [ ] Agent can retrieve full content through existing tools
- [ ] Per-message aggregate budget prevents context flooding from parallel tools
- [ ] Replacement decisions are stable across conversation replay
- [ ] Session cleanup removes persisted results
- [ ] Fallback to truncation when persistence fails
