# Track 09: Tool Result Persistence

## Problem

Track 02 introduced `ToolResultProfile.maxResultSizeChars` and applies in-memory truncation inside `ToolRegistry.execute()` (`src/tools/ToolRegistry.ts:464-475`):

```typescript
const maxChars = entry.runtime.result?.maxResultSizeChars;
if (maxChars) {
  const serialized = typeof result === 'string' ? result : safeJsonStringify(result);
  if (serialized !== undefined && serialized.length > maxChars) {
    const originalLength = serialized.length;
    result = serialized.slice(0, maxChars) +
      `\n\n[Result truncated from ${originalLength} to ${maxChars} chars]`;
  }
}
```

When a result exceeds the cap, the tail is sliced off and a marker is appended. The discarded content is gone forever — the agent cannot retrieve it.

Claudy solves this differently: oversized results are **persisted** (to disk in server mode, to a backing store in extension/desktop mode), and the agent receives a **preview plus a retrieval reference**. The agent can fetch the full content on demand. No information is lost — it's deferred, not destroyed.

BrowserX should adopt the same pattern, adapted for its four-platform runtime (`extension`, `desktop`, `server`, `mobile`).

---

## What Claudy Does

All Claudy citations are to `/home/rich/dev/study/claudy/src`.

### Two-tier result management

#### Tier 1 — per-tool persistence

`maybePersistLargeToolResult()` (`utils/toolResultStorage.ts:272-334`) runs on every tool result block before it is appended to the conversation. Decision tree:

1. **Empty content** (`lines 287-295`): if the content is empty/whitespace-only, inject `(${toolName} completed with no output)` to avoid the model treating an empty `tool_result` as a stop signal. Return.
2. **Image blocks** (`lines 302-304`): if the content array contains any image block, return the block unchanged — images must reach the API intact.
3. **Size check** (`lines 306-312`): compute `contentSize(content)` (sum of text block lengths, no JSON framing). If `size <= threshold`, return unchanged.
4. **Persist** (`lines 314-319`): call `persistToolResult(content, toolUseId)`. If it fails, return the original block (graceful degradation — full content still flows through).
5. **Replace** (`lines 321-333`): replace the block's `content` with the `<persisted-output>` preview message and emit a `tengu_tool_result_persisted` analytics event.

`persistToolResult()` (`utils/toolResultStorage.ts:137-184`) is the actual write:

- **Path**: `{projectDir}/{sessionId}/tool-results/{toolUseId}.{txt|json}`. Extension is `.json` if the content is a content-block array, `.txt` if a plain string.
- **Idempotent write**: `writeFile(path, content, { encoding: 'utf-8', flag: 'wx' })` — `wx` is exclusive-create. On `EEXIST` (same id was already persisted on a prior replayed turn), the catch silently falls through to preview generation; the file is left as-is. Non-`EEXIST` errors return `{ error }` and the caller emits the original content unchanged.
- **Preview**: calls `generatePreview(content, PREVIEW_SIZE_BYTES)`.

#### Tier 2 — per-message aggregate budget

`enforceToolResultBudget()` (`utils/toolResultStorage.ts:769-909`) runs over the assembled message list before the API call. It exists because N parallel tool calls can each pass tier 1 (e.g. 5 × 50K under-threshold results) and collectively flood the wire with 250K.

The algorithm, simplified:

```
for each API user message in messages:
  candidates = tool_result blocks in that message

  partition by prior decision (using ContentReplacementState):
    mustReapply  = ids already in state.replacements      → Map lookup, byte-identical
    frozen       = ids in state.seenIds but not replacements (seen-but-unreplaced)
    fresh        = never-before-seen ids

  apply mustReapply replacements (no I/O)

  skipped = fresh filtered by tool name (Infinity opt-outs)
  for c in skipped: state.seenIds.add(c.toolUseId)   // freeze decision
  eligible = fresh \ skipped

  if frozenSize + eligibleSize > limit:
    selected = selectFreshToReplace(eligible, frozenSize, limit)
    persist all selected in parallel
    atomically:
      for c in selected: state.seenIds.add(c.toolUseId)
                         state.replacements.set(c.toolUseId, replacement)
                         newlyReplaced.push(record)
```

`selectFreshToReplace()` (`utils/toolResultStorage.ts:675-691`) sorts eligible by size descending and persists largest-first until the running total drops below the limit.

**Concurrency model**: `Promise.all` over the selected candidates. State mutations happen **after** all awaits resolve so a concurrent reader can't see a half-applied decision.

### `ContentReplacementState` (cache stability)

Definition (`utils/toolResultStorage.ts:390-393`):

```typescript
export type ContentReplacementState = {
  seenIds: Set<string>;
  replacements: Map<string, string>;   // tool_use_id → exact preview string sent to API
};
```

**Why this exists**: the Anthropic API caches prompt prefixes by byte. If turn N+1 re-applies a *different* replacement to the same `tool_use_id` that turn N saw, the wire bytes differ → cache miss. Storing the literal replacement string ensures byte-identical re-application across turns, compaction, and resume.

Lifecycle:

- **Created**: `provisionContentReplacementState()` (`lines 447-463`) — gated by feature flag `tengu_hawthorn_steeple`; off → returns `undefined` and the whole tier-2 path becomes a no-op.
- **Mutated in place** by the query loop across turns.
- **Cloned** (`lines 405-412`) for cache-sharing subagent forks so identical parent decisions are re-applied.
- **Reconstructed on resume** (`lines 960-988`) from `ContentReplacementRecord[]` persisted to the transcript sidechain. Fork-resume case: gap-fills from the parent's live state (parent's `mustReapply` was never persisted as a new record).

`ContentReplacementRecord` (`lines 475-479`):

```typescript
type ContentReplacementRecord = {
  kind: 'tool-result';
  toolUseId: string;
  replacement: string;   // stored verbatim — NOT derived on resume
};
```

The replacement is stored (not regenerated) precisely so that future template changes can't silently break cache.

### `getPersistenceThreshold(toolName, declaredMax)` (`constants/toolLimits.ts:55-78`)

```
if (!Number.isFinite(declaredMax)) return declaredMax;   // Infinity passes through (opt-out)

override = growthbook('tengu_satin_quoll', {})[toolName];
if (typeof override === 'number' && finite && > 0) return override;

return Math.min(declaredMax, DEFAULT_MAX_RESULT_SIZE_CHARS);   // 50K clamp
```

Note: `DEFAULT_MAX_RESULT_SIZE_CHARS` (50,000) is a **clamp on the declared max**, not a global default for tools that omit the field. Tools must declare a max; `Infinity` opts out.

### Constants (`constants/toolLimits.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_MAX_RESULT_SIZE_CHARS` | `50_000` | Upper clamp on declared per-tool max |
| `BYTES_PER_TOKEN` | `4` | Conservative estimate |
| `MAX_TOOL_RESULT_TOKENS` | `100_000` | API hard ceiling |
| `MAX_TOOL_RESULT_BYTES` | `400_000` | `MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN` |
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | `200_000` | Tier-2 aggregate budget |
| `PREVIEW_SIZE_BYTES` | `2_000` | Preview length |

### Preview algorithm (`utils/toolResultStorage.ts:339-356`)

```
generatePreview(content, maxBytes):
  if content.length <= maxBytes: return { preview: content, hasMore: false }
  truncated = content.slice(0, maxBytes)
  lastNewline = truncated.lastIndexOf('\n')
  cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes
  return { preview: content.slice(0, cutPoint), hasMore: true }
```

The 50% heuristic means a newline-rich text gets a clean cut, but a one-long-line blob is cut at the exact byte boundary instead of cutting almost everything off chasing a faraway newline.

### Exact `<persisted-output>` template (`utils/toolResultStorage.ts:189-199`)

```
<persisted-output>
Output too large ({formatFileSize(originalSize)}). Full output saved to: {filepath}

Preview (first {formatFileSize(PREVIEW_SIZE_BYTES)}):
{preview}
{hasMore ? '...\n' : ''}</persisted-output>
```

`formatFileSize` produces human-readable strings like `2 KB`, `245.3 KB`.

### Opt-out tool: `FileReadTool`

`FileReadTool` has `maxResultSizeChars: Infinity` because Read's own output is already token-bounded via `validateContentTokens`, and persisting a Read result that the model then re-reads with Read is circular. This is the **only** Claudy tool with `Infinity`.

In `enforceToolResultBudget()` (`lines 816-822`), Infinity-tools are added to `skipped` *and* recorded in `state.seenIds` so the decision (don't persist) is frozen across turns.

### Cleanup (`utils/cleanup.ts:155-250`)

- Periodic background task, default 30-day TTL.
- Walks `{projectsDir}/{project}/{session}/tool-results/`, deletes files older than cutoff by `mtime`.
- Sessions are not removed if their `tool-results` dir empties out.
- **No orphan detection** (crashed sessions); TTL eventually catches them.

### Tests

Claudy has **no dedicated unit tests** for `toolResultStorage.ts` or `toolLimits.ts`. Edge cases are implicit in the code: idempotency (`wx` flag), empty content marker, exactly-at-threshold (`size <= threshold` → boundary is *not* persisted), persistence failure → original sent through, all-frozen-message → no budget check (fresh.length === 0).

---

## BrowserX Findings

### 1. Three (actually four) runtime environments

`__BUILD_MODE__` (`src/types/globals.d.ts:14`) is a compile-time constant set by Vite:

```typescript
declare const __BUILD_MODE__: 'extension' | 'desktop' | 'server' | 'mobile';
```

| Mode | Filesystem | IndexedDB | `SessionCacheManager` | Tool result store target |
|------|------------|-----------|------------------------|---------------------------|
| `extension` | No | Yes | Yes | `SessionCacheManager` (IndexedDB) |
| `desktop` | Yes (Tauri) | Yes | Yes | `SessionCacheManager` (IndexedDB) |
| `server` | Yes (Node) | No | No | `node:fs` |
| `mobile` | Limited | Yes | Yes (assumed) | `SessionCacheManager` (IndexedDB) — same as extension |

The earlier doc treated mobile as out-of-scope. It isn't: it's another build mode and needs explicit handling. Treat it as extension-equivalent (IndexedDB-backed).

### 2. Current truncation is post-serialization, not pre-

The earlier draft of this doc claimed the size check happens before stringification — that is **wrong**. The current code at `src/tools/ToolRegistry.ts:464-475` already runs `safeJsonStringify(result)` and measures the serialized length. So a 200K DOM-snapshot object *does* get truncated correctly today.

What's still wrong about it:

- The truncated string then becomes the `result`. So an object input → truncated string output: the tool's return type silently flips from `T` to `string` mid-pipeline. The agent sees a "string that used to be an object".
- The truncation site has no access to the session lifecycle (`Session`, rollout recorder) or to a backing store, so it can only delete content, not persist it.
- It can't do the tier-2 aggregate budget because it runs per-execute, before the batch is assembled.

So: persistence moves to `TurnManager`, but the reason is "where the lifecycle lives", not "current code can't see object size".

### 3. `ToolRegistry.execute()` interface

`src/tools/ToolRegistry.ts:295-523`:

```typescript
async execute(request: ToolExecutionRequest): Promise<ToolExecutionResponse>

interface ToolExecutionRequest {
  toolName: string;
  parameters: Record<string, any>;
  sessionId: string;
  turnId: string;
  callId?: string;
  tabId?: number;
  timeout?: number;
  metadata?: Record<string, any>;
  onProgress?: ToolProgressCallback;
}

interface ToolExecutionResponse {
  success: boolean;
  data?: any;
  error?: ToolError;
  duration: number;
}
```

`getResultProfile(toolName)` (`lines 583-587`) is a simple lookup on the registered entry's `runtime.result`.

### 4. `TurnManager` call sites

`src/core/TurnManager.ts`:

- `executeToolCall(toolName, parameters, callId): Promise<any>` (`line 651`) — single-tool path. Calls `executeBrowserTool` which calls `toolRegistry.execute(...)` (`lines 889-903`). `sessionId` is available via `this.session.getSessionId()`.
- Final serialization (`lines 728-737`):
  ```typescript
  const output = typeof result === 'string' ? result : JSON.stringify(result);
  return { type: 'function_call_output', call_id: callId, output };
  ```
- `handleResponseItem()` (`lines 538-646`) — assembles per-turn tool results. Legacy `function_call` (`lines 540-553`) is single-shot; unified `message.tool_calls` (`lines 570-604`) is batch-prepared via `prepareToolCall` and dispatched through `executeToolCallBatches` (safe calls concurrent, unsafe sequential). This is the natural seam for tier-2 budget enforcement.

### 5. `SessionCacheManager` API surface

`src/storage/SessionCacheManager.ts`:

- `write(sessionId, data, description, taskId?, turnId?, customMetadata?) → CacheMetadata` (`lines 212-267`). Returns metadata; storage key shape is `{sessionId}_{taskId}_{turnId}`. Caller does not pick the key.
- `read(storageKey): CachedItem` (`lines 272-304`). Throws `ItemNotFoundError`.
- `list(sessionId): CacheMetadata[]` (`lines 309-322`).
- `delete(storageKey): boolean` (`lines 327-348`).
- `update(storageKey, ...)` (`lines 353-401`).
- `clearSession(sessionId): number` (`lines 508-524`) — wipes everything for a session in one shot.

Limits (`CACHE_CONSTANTS`, `lines 71-81`):

| Constant | Value |
|----------|-------|
| `MAX_ITEM_SIZE` | 5 MB |
| `MAX_SESSION_QUOTA` | 200 MB |
| `MAX_TOTAL_QUOTA` | 5 GB |
| `SESSION_EVICTION_PERCENTAGE` | 0.5 (oldest 50%) |

Two API gaps to be aware of:

- **No prefix-listing.** There is no `list(sessionId, prefix)`. Cleanup of just our keys would need either (a) a new `listByPrefix` API, (b) `clearSession()` (nukes everything — only safe at session-end), or (c) tag the entries via `customMetadata` and filter the `list()` results in-memory.
- **Caller doesn't pick the key.** Keys are computed from `sessionId_taskId_turnId`. To put tool results under a controlled namespace we either change the API to allow caller-supplied keys, or accept that the reference returned to the agent is the auto-generated key and `customMetadata` carries `{ kind: 'tool_result', tool_use_id }`.

### 6. `StorageTool` / `cache_storage_tool`

`src/tools/StorageTool.ts`. Registered in `src/extension/tools/registerExtensionTools.ts:257-283` with:

```typescript
runtime: {
  concurrency: { ... },
  ui: { ... },
  result: { maxResultSizeChars: 50_000 },
}
```

**This is a problem.** The retrieval tool itself is capped at 50K, so a `read` action that returns a 200K cached blob would be truncated by the same system we're trying to fix. The agent would be unable to recover the persisted content.

Two fixes available:

1. **Per-action exemption**: `read` and `list` actions get `Infinity`; `write`/`update`/`delete` keep 50K. Needs `maxResultSizeChars` to be a function `(input) => number` (currently a static `number`) — minor type change to `ToolResultProfile`.
2. **Whole-tool exemption**: simpler — set `maxResultSizeChars: Infinity` for the whole tool. Acceptable since the non-read actions return small confirmation payloads anyway.

Recommend option 2 for the first cut; option 1 is reserve.

### 7. Platform detection

`__BUILD_MODE__` is the source of truth (`src/types/globals.d.ts:14`). `platformStore.ts:34-48` derives feature booleans from it. There is **no existing storage abstraction that bridges IndexedDB and filesystem** — server mode uses `ServerStorageProvider` (SQLite via `better-sqlite3`), extension/desktop use `IndexedDBAdapter`. The new `ToolResultStore` is the first such abstraction.

### 8. Server-mode filesystem

`src/server/storage/ServerStorageProvider.ts:44-84` shows the pattern:

```typescript
const { default: Database } = await import('better-sqlite3');
const { join } = await import('node:path');
const { existsSync, mkdirSync } = await import('node:fs');

const dir = join(this.dataDir, 'storage');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
```

- Dynamic imports of `node:*` so the bundle stays buildable for non-Node targets.
- `dataDir` is injected at construction.
- **No existing per-session directory structure**. Sessions live as rows in SQLite, not on disk. The server tool-result store has to invent `{dataDir}/sessions/{sessionId}/tool-results/{toolUseId}.{txt|json}` (or similar) — and that directory must be created on first write.

### 9. `ToolResultProfile` and runtime metadata

`src/tools/runtimeMetadata.ts:64-69`:

```typescript
export interface ToolResultProfile {
  maxResultSizeChars?: number;
  inputsEquivalent?(a: Record<string, unknown>, b: Record<string, unknown>): boolean;
}
```

All current per-tool maxes (in `src/extension/tools/registerExtensionTools.ts`):

| Tool | maxResultSizeChars |
|------|--------------------|
| `browser_dom` | 100,000 |
| `navigation_tool` | 10,000 |
| `web_scraping` | 50,000 |
| `form_automation` | 20,000 |
| `network_intercept` | 50,000 |
| `data_extraction` | 50,000 |
| `storage_tool` | 50,000 (← bug, see §6) |
| `page_vision` | 100,000 |
| `planning_tool` | 10,000 |

MCP tools default to 50,000 (`src/core/mcp/MCPToolAdapter.ts:217`).

**Zero tools currently use `Infinity`.** That semantic needs to be wired up (at minimum for `cache_storage_tool`'s read path).

### 10. Session lifecycle

`src/core/Session.ts`:

- **Mint**: constructor (`lines 73-132`). `sessionId = uuidv4()` (or restored from `initialHistory.sessionId`).
- **Teardown**: `close()` (`lines 720-744`). Currently only flushes the rollout recorder. **No tool-store cleanup hook exists** — needs to be added.
- **Compaction**: `CompactService` (instantiated `lines 28-30`) — not fully inspected. Replacement state would need to survive compaction.

### 11. Test layout

Vitest. Co-located in `__tests__/` subfolders next to source. Patterns to follow:

- `src/tools/__tests__/ToolRegistry.coverage.test.ts` — registry tests.
- `src/storage/__tests__/SessionCacheManager.test.ts` — cache tests.
- `src/extension/tools/__tests__/StorageTool.test.ts` — tool tests.

New file: `src/tools/__tests__/ToolResultPersistence.test.ts` (and/or split per-store).

---

## Target Design

### 1. Platform-aware `ToolResultStore`

`src/tools/resultStore.ts` — new file.

```typescript
export interface PersistedResult {
  /**
   * Opaque retrieval reference.
   * - CacheToolResultStore: storage key returned by SessionCacheManager.write()
   * - FileToolResultStore:  absolute file path
   */
  reference: string;

  /** Format hint for the agent — 'cache' uses cache_storage_tool, 'file' uses file path. */
  kind: 'cache' | 'file';

  /** Length in chars of the full serialized content. */
  originalSize: number;

  /** First ~PREVIEW_SIZE_BYTES of content, cut at a newline boundary when feasible. */
  preview: string;

  /** True iff preview was truncated. */
  hasMore: boolean;
}

export interface ToolResultStore {
  /**
   * Persist a tool result and return a retrieval reference.
   * Implementations MUST be idempotent on (sessionId, toolUseId) — a second
   * call with the same ids and same content must not error.
   */
  persist(
    sessionId: string,
    toolUseId: string,
    content: string,
  ): Promise<PersistedResult>;

  /** Retrieve persisted content by reference. Returns null if not found. */
  retrieve(reference: string): Promise<string | null>;

  /** Remove all persisted results for a session. */
  cleanup(sessionId: string): Promise<void>;
}
```

#### `CacheToolResultStore` (extension / desktop / mobile)

Uses `SessionCacheManager`. Key concerns:

- `SessionCacheManager.write()` does not accept a caller-chosen key. We have two options:
  - **(A)** Add an optional `customStorageKey` parameter to `write()`. Storage keys for tool results would be `__tool_result__{toolUseId}`. Cleanest, but a public API change.
  - **(B)** Accept the auto-generated key (`{sessionId}_{taskId}_{turnId}`). Tag entries via `customMetadata: { kind: 'tool_result', toolUseId }`. Cleanup scans `list(sessionId)` and deletes entries where `customMetadata.kind === 'tool_result'`.

  **Choose (B)** for the first cut — no API change required, and `list()` already returns metadata-only (cheap). Revisit if cleanup latency becomes a concern.

- 5 MB per-item cap: if `content.length > 5 MB`, the cache rejects. Fall back to legacy truncation (single tier safety net).
- Quota exhaustion: caught and surfaced as a failed persistence; caller falls back to truncation.

```typescript
class CacheToolResultStore implements ToolResultStore {
  constructor(private cache: SessionCacheManager) {}

  async persist(sessionId, toolUseId, content): Promise<PersistedResult> {
    if (content.length > 5 * 1024 * 1024) throw new Error('too large for cache store');
    const metadata = await this.cache.write(
      sessionId,
      { content },                            // wrapped so retrieve unwraps
      `tool_result:${toolUseId}`,             // description
      undefined,                              // taskId
      undefined,                              // turnId
      { kind: 'tool_result', toolUseId },     // customMetadata — used by cleanup
    );
    const { preview, hasMore } = generatePreview(content, PREVIEW_SIZE_BYTES);
    return {
      reference: metadata.storageKey,
      kind: 'cache',
      originalSize: content.length,
      preview,
      hasMore,
    };
  }

  async retrieve(reference): Promise<string | null> {
    try {
      const item = await this.cache.read(reference);
      return item.data?.content ?? null;
    } catch (e) {
      if (e instanceof ItemNotFoundError) return null;
      throw e;
    }
  }

  async cleanup(sessionId): Promise<void> {
    const items = await this.cache.list(sessionId);
    const toDelete = items.filter(
      m => m.customMetadata?.kind === 'tool_result',
    );
    await Promise.all(toDelete.map(m => this.cache.delete(m.storageKey)));
  }
}
```

#### `FileToolResultStore` (server)

Mirrors Claudy directly.

```typescript
class FileToolResultStore implements ToolResultStore {
  constructor(private rootDir: string) {}   // e.g. {dataDir}/sessions

  private pathFor(sessionId: string, toolUseId: string): string {
    return join(this.rootDir, sessionId, 'tool-results', `${toolUseId}.txt`);
  }

  async persist(sessionId, toolUseId, content): Promise<PersistedResult> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const filepath = this.pathFor(sessionId, toolUseId);
    await mkdir(dirname(filepath), { recursive: true });
    try {
      await writeFile(filepath, content, { encoding: 'utf-8', flag: 'wx' });
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      // EEXIST → already persisted on a prior replayed turn; leave existing file.
    }
    const { preview, hasMore } = generatePreview(content, PREVIEW_SIZE_BYTES);
    return {
      reference: filepath,
      kind: 'file',
      originalSize: content.length,
      preview,
      hasMore,
    };
  }

  async retrieve(reference): Promise<string | null> {
    const { readFile } = await import('node:fs/promises');
    try {
      return await readFile(reference, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async cleanup(sessionId): Promise<void> {
    const { rm } = await import('node:fs/promises');
    const dir = join(this.rootDir, sessionId, 'tool-results');
    await rm(dir, { recursive: true, force: true });
  }
}
```

#### Factory and platform selection

```typescript
export function createToolResultStore(deps: {
  cache?: SessionCacheManager;
  serverRootDir?: string;
}): ToolResultStore {
  switch (__BUILD_MODE__) {
    case 'extension':
    case 'desktop':
    case 'mobile':
      if (!deps.cache) throw new Error('cache required for this platform');
      return new CacheToolResultStore(deps.cache);
    case 'server':
      if (!deps.serverRootDir) throw new Error('serverRootDir required');
      return new FileToolResultStore(deps.serverRootDir);
  }
}
```

The factory is invoked once during `Session` construction; the store is held on the session and passed to `TurnManager`.

### 2. Preview helper

`src/tools/resultStore.ts`:

```typescript
export const PREVIEW_SIZE_BYTES = 2_000;

export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) return { preview: content, hasMore: false };
  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}
```

Direct port of Claudy `lines 339-356`.

### 3. Persisted-output message templates

```typescript
function buildPersistedOutputMessage(r: PersistedResult): string {
  const sizeStr = formatFileSize(r.originalSize);
  const previewLimit = formatFileSize(PREVIEW_SIZE_BYTES);
  const tail = r.hasMore ? '\n...\n' : '\n';

  if (r.kind === 'cache') {
    return `<persisted-output>
Output too large (${sizeStr}). Full output stored with key: ${r.reference}

To retrieve the full output, call cache_storage_tool with:
  { "action": "read", "storageKey": "${r.reference}" }

Preview (first ${previewLimit}):
${r.preview}${tail}</persisted-output>`;
  }

  // kind === 'file' (server)
  return `<persisted-output>
Output too large (${sizeStr}). Full output saved to: ${r.reference}

Preview (first ${previewLimit}):
${r.preview}${tail}</persisted-output>`;
}
```

`formatFileSize` formats `1234 → "1.2 KB"`. Implement in the same file.

### 4. Move size enforcement to `TurnManager`

#### 4a. Construction wiring

Current `TurnManager` constructor (`src/core/TurnManager.ts:96-111`):

```typescript
constructor(
  session: Session,
  turnContext: TurnContext,
  toolRegistry: ToolRegistry,
  config: TurnConfig = {}
)
```

We do **not** add new positional params. Instead, `TurnManager` pulls the two new dependencies off `Session`:

```typescript
// Inside executeToolCall / handleResponseItem:
const store = this.session.getToolResultStore();
const state = this.session.getContentReplacementState();
```

This keeps the single production call site (`src/core/tasks/RegularTask.ts:48-52`) unchanged and avoids editing the 33 `new TurnManager(...)` test fixtures in `src/core/__tests__/`. `Session` mints both dependencies in its constructor (see §A below).

The `Session` accessors return `undefined` until the persistence subsystem is initialised, which lets us roll out behind a config flag without nullable-everywhere noise — `TurnManager` simply skips persistence when either is missing.

#### 4b. Remove inline truncation

Delete the `maxResultSizeChars` block at `src/tools/ToolRegistry.ts:464-475`. Keep `ToolResultProfile.maxResultSizeChars` — it's now a *threshold*, consulted by `TurnManager`.

#### 4c. Tier-1 in `executeToolCall`

`src/core/TurnManager.ts:651`, after the existing serialization at `lines 728-737`:

```typescript
const output = typeof result === 'string' ? result : JSON.stringify(result);

const profile = this.toolRegistry.getResultProfile(toolName);
const threshold = getPersistenceThreshold(toolName, profile?.maxResultSizeChars);

if (Number.isFinite(threshold) && output.length > threshold) {
  try {
    const persisted = await this.toolResultStore.persist(
      this.session.getSessionId(),
      callId,
      output,
    );
    this.replacementState?.record(callId, buildPersistedOutputMessage(persisted));
    return {
      type: 'function_call_output',
      call_id: callId,
      output: buildPersistedOutputMessage(persisted),
    };
  } catch (e) {
    // Graceful fallback: legacy truncation marker (NOT byte-truncated content loss
    // beyond what we'd lose anyway with no persistence).
    const truncated = output.slice(0, threshold) +
      `\n\n[Result truncated from ${output.length} to ${threshold} chars — persistence failed: ${(e as Error).message}]`;
    return { type: 'function_call_output', call_id: callId, output: truncated };
  }
}

return { type: 'function_call_output', call_id: callId, output };
```

`getPersistenceThreshold(toolName, declaredMax)` lives in a new `src/tools/toolLimits.ts`:

```typescript
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;
export const PREVIEW_SIZE_BYTES = 2_000;

export function getPersistenceThreshold(
  toolName: string,
  declaredMax: number | undefined,
): number {
  if (declaredMax === undefined) return DEFAULT_MAX_RESULT_SIZE_CHARS;
  if (!Number.isFinite(declaredMax)) return declaredMax;   // Infinity opt-out
  return Math.min(declaredMax, DEFAULT_MAX_RESULT_SIZE_CHARS);
}
```

(We don't have GrowthBook in BrowserX — drop that branch entirely. If runtime config is desired later, hook into existing config plumbing.)

#### 4d. Tier-2 in `handleResponseItem`

`handleResponseItem` (`src/core/TurnManager.ts:538`) currently returns `any | undefined`. After `executeToolCallBatches` (`src/core/toolOrchestration.ts:139-159`) returns `T[]` where each `T` is the `function_call_output` object, the code returns either the single element or the array (`TurnManager.ts:600-603`):

```typescript
if (toolCallResults.length === 1) {
  return toolCallResults[0];
}
return toolCallResults;
```

There is **no BrowserX type called `FunctionCallOutput`**. The shape `{ type: 'function_call_output'; call_id: string; output: string }` is a variant of `ResponseItem`, defined at `src/core/protocol/types.ts:246-249`. We'll introduce a local alias to keep call sites readable:

```typescript
// In src/tools/resultBudget.ts:
import type { ResponseItem } from '@/core/protocol/types';

export type FunctionCallOutputItem = Extract<ResponseItem, { type: 'function_call_output' }>;

export async function enforceToolResultBudget(
  results: FunctionCallOutputItem[],
  state: ContentReplacementState | undefined,
  opts: {
    store: ToolResultStore;
    sessionId: string;
    limit: number;
    skipToolNames: ReadonlySet<string>;
  },
): Promise<FunctionCallOutputItem[]>;
```

Wiring in `handleResponseItem` after the batch returns:

```typescript
const enforced = await enforceToolResultBudget(
  toolCallResults as FunctionCallOutputItem[],
  this.session.getContentReplacementState(),
  {
    store: this.session.getToolResultStore(),
    sessionId: this.session.getSessionId(),
    limit: MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
    skipToolNames: this.toolRegistry.getInfinityTools(),
  },
);

if (enforced.length === 1) return enforced[0];
return enforced;
```

(If the session lacks store/state — i.e. feature off — `enforceToolResultBudget` short-circuits and returns `results` unchanged.)

Algorithm (direct port of Claudy `lines 769-909` for the single-message case):

1. **Partition** each result by prior decision via `state`:
   - `mustReapply`: `call_id` ∈ `state.replacements` → swap `output` to the stored replacement string.
   - `frozen`: `call_id` ∈ `state.seenIds` but not in `replacements` → leave alone, count toward `frozenSize`.
   - `fresh`: never seen → eligible for new decision.
2. **Skip Infinity tools** in `fresh`: mark seen, do not persist.
3. **Budget check**: if `frozenSize + eligibleSize <= limit`, mark all eligible as seen-unreplaced and return.
4. **Selection**: sort eligible by `output.length` desc, persist largest-first until total under limit.
5. **Persist** selected in parallel via `Promise.all`. Atomically (post-await), mutate `state.seenIds` and `state.replacements` for each persisted result. Replace `output` in the returned array.
6. **On per-result persistence failure**: mark seen, leave `output` unchanged, do not add to `replacements`. The result still contributes to budget overflow, but we accepted that risk over crashing the turn.

**Tier-1 / tier-2 interaction** (not a double-persist bug, just worth pinning):
- Tier-1 ran during `executeToolCall`. The result's `output` is already the preview message AND `state.replacements` already contains the entry.
- Tier-2 partitions by state, sees the `call_id` as `mustReapply`, and swaps `output` to `state.replacements.get(callId)` — which is the **same string** that's already there. No-op.
- Tier-2's size accounting uses `output.length` after this swap. The already-persisted entry contributes its preview-size (~2KB), not its original size, so it does not push the budget over.

Each tier-1 persistence is **already recorded** in `state.replacements` (via `state.record()` in §4c). So by the time tier-2 runs on the assembled batch, tier-1 decisions are already frozen, and tier-2 only ever adds more.

### 5. `ContentReplacementState` in BrowserX

`src/tools/replacementState.ts` — full shape and rollout integration are documented in §A below. Quick summary:

```typescript
export class ContentReplacementState {
  readonly seenIds = new Set<string>();
  readonly replacements = new Map<string, string>();

  constructor(private opts: { onRecord?: (rec: ContentReplacementRecord) => void } = {}) {}

  record(callId: string, replacement: string): void;          // adds to both + fires onRecord
  seedFromResume(rec: ContentReplacementRecord): void;        // adds to both, NO onRecord
  freezeUnreplaced(callId: string): void;                     // adds to seenIds only
  reapply(callId: string): string | undefined;                // Map lookup
}

export type ContentReplacementRecord = {
  kind: 'tool-result';
  toolUseId: string;
  replacement: string;
};
```

- **Ownership**: instance lives on `Session`. Exposed via `Session.getContentReplacementState()` and passed to `TurnManager` at construction (see §A below).
- **Persistence**: each `record()` writes to the rollout recorder. The recorder lives at `src/storage/rollout/RolloutRecorder.ts:230` with signature:
  ```typescript
  async recordItems(items: RolloutItem[]): Promise<void>
  ```
  Add a new `RolloutItem` variant to the union in `src/storage/rollout/types.ts:149-155`:
  ```typescript
  export type RolloutItem =
    | { type: 'session_meta'; payload: SessionMetaLine }
    | { type: 'response_item'; payload: ResponseItem }
    | { type: 'compacted'; payload: CompactedItem }
    | { type: 'turn_context'; payload: TurnContextItem }
    | { type: 'event_msg'; payload: EventMsg }
    | { type: 'turn_completion'; payload: { turnId: string; stats: any } }
    | { type: 'content_replacement'; payload: ContentReplacementRecord };   // NEW
  ```
  Update the persistence policy filter at `src/storage/rollout/policy.ts:17-32` to include `content_replacement` (verify it isn't filtered out by default).
- **Resume**: `Session.reconstructHistoryFromRollout()` (`src/core/Session.ts:1626-1651`) currently maps `response_item` and `compacted` into history. Add a branch for `content_replacement` that populates `this.replacementState.replacements`. The `seenIds` set is then seeded by walking restored `response_item`s whose `type === 'function_call_output'` and adding their `call_id` — this is the gap-fill that Claudy does for fork-resume.

  ```typescript
  for (const rolloutItem of rolloutItems) {
    if (rolloutItem.type === 'response_item') {
      responseItems.push(rolloutItem.payload as ResponseItem);
      // Seed seenIds from any function_call_output we see
      const r = rolloutItem.payload as any;
      if (r.type === 'function_call_output' && r.call_id) {
        this.replacementState?.freezeUnreplaced(r.call_id);
      }
    } else if (rolloutItem.type === 'compacted') {
      // ... existing ...
    } else if (rolloutItem.type === 'content_replacement') {
      const rec = rolloutItem.payload as ContentReplacementRecord;
      this.replacementState?.record(rec.toolUseId, rec.replacement);
      // record() also adds to seenIds, so the freezeUnreplaced above is redundant
      // for replaced entries — that's fine, Set semantics handle it.
    }
  }
  ```
- **Compaction**: `CompactService` (`src/core/Session.ts:28-30`) needs to preserve the replacement state across the compaction boundary. Tool result blocks that survive compaction must keep their `replacements` entries; ids that get dropped can be pruned. Compaction integration is properly handled in Phase 4D.

### 6. Retrieval path

#### 6a. Extension / desktop / mobile: fix `cache_storage_tool`

`src/extension/tools/registerExtensionTools.ts:257-283` — change:

```diff
  await registerTool('storage_tool', new StorageTool(), {
    riskAssessor: staticRiskAssessor,
    runtime: {
      concurrency: { ... },
      ui: { ... },
-     result: { maxResultSizeChars: 50_000 },
+     result: { maxResultSizeChars: Number.POSITIVE_INFINITY },
    },
  });
```

This makes `cache_storage_tool` opt out of persistence entirely. Justification: read responses are exactly the content being retrieved — re-persisting them is circular; write/update/delete responses are small confirmation objects.

#### 6b. Server: add `read_persisted_result` tool

Server mode names a file path in the persisted-output message, so the agent needs a tool that can read that path. Purpose-built rather than a general filesystem reader, so the security surface stays narrow.

New file: `src/server/tools/ReadPersistedResultTool.ts`.

```typescript
export const READ_PERSISTED_RESULT_TOOL = {
  name: 'read_persisted_result',
  description:
    'Read the full content of a tool result that was persisted to disk. ' +
    'Use this when a previous tool result was too large and returned a ' +
    '<persisted-output> block with a file path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute file path from a <persisted-output> block.',
      },
    },
    required: ['path'],
  },
} as const;

export class ReadPersistedResultTool implements BaseTool {
  constructor(private rootDir: string) {}   // {dataDir}/sessions

  async execute(input: { path: string }): Promise<string> {
    const { readFile, realpath } = await import('node:fs/promises');
    const { resolve, sep } = await import('node:path');

    const requested = resolve(input.path);
    const root = await realpath(this.rootDir);
    // Guard: must live under {rootDir}/{sessionId}/tool-results/
    // realpath collapses symlinks so a symlink-escape is caught too.
    let real: string;
    try {
      real = await realpath(requested);
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        throw new Error(`File not found: ${input.path} (may have been cleaned up)`);
      }
      throw e;
    }
    if (!real.startsWith(root + sep)) {
      throw new Error(`Path is outside the tool-results directory: ${input.path}`);
    }
    if (!real.includes(`${sep}tool-results${sep}`)) {
      throw new Error(`Path is not a tool-results file: ${input.path}`);
    }

    return readFile(real, 'utf-8');
  }
}
```

**Registration**: add inside `registerServerTools()` at `src/server/tools/registerServerTools.ts:36-111`, following the `PlanningTool` pattern (`lines 44-67`). The function takes `dataDir` as a new optional parameter:

```typescript
// src/server/tools/registerServerTools.ts
export async function registerServerTools(
  registry: ToolRegistry,
  dataDir?: string,                                  // NEW
): Promise<void> {
  // ... existing planning_tool, mcp tools, etc ...

  if (dataDir) {
    try {
      const { ReadPersistedResultTool, READ_PERSISTED_RESULT_TOOL } =
        await import('@/server/tools/ReadPersistedResultTool');
      const { StaticRiskAssessor } =
        await import('@/core/approval/assessors/StaticRiskAssessor');

      const rootDir = join(dataDir, 'sessions');
      const tool = new ReadPersistedResultTool(rootDir);

      if (!registry.getTool('read_persisted_result')) {
        await registry.register(
          READ_PERSISTED_RESULT_TOOL,
          async (params) => tool.execute(params as { path: string }),
          new StaticRiskAssessor(0),
          {
            concurrency: { isConcurrencySafe: () => true, isReadOnly: () => true, isDestructive: () => false },
            ui: { getActivityDescription: (i: any) => `Reading persisted result: ${i.path}` },
            result: { maxResultSizeChars: Number.POSITIVE_INFINITY },
          },
        );
      }
    } catch (err) {
      console.warn('[registerServerTools] Failed to register read_persisted_result:', err);
    }
  }
}
```

Caller side at `src/server/agent/ServerAgentBootstrap.ts:44` — `dataDir` is already in scope (computed at `ServerAgentBootstrap.ts:105-107` from `APPLEPI_DATA_DIR` env var with a home-dir fallback):

```diff
-await registerServerTools(registry);
+await registerServerTools(registry, dataDir);
```

**Security posture**:
- Path is `realpath`-resolved before the prefix check, so symlink escapes are caught.
- Must live under `{rootDir}/.../tool-results/...` — bare `{rootDir}/foo` is rejected.
- `ENOENT` returns a descriptive error (likely the TTL sweep got there first); the agent learns the result is unrecoverable and can replan.
- The tool only reads, never writes/deletes. Concurrency-safe and read-only.

**Why not reuse `cache_storage_tool` for server mode?** It's IndexedDB-backed; server has no IndexedDB. A unified retrieval tool would need its own platform branch internally — cleaner to have a separate server-only tool whose `<persisted-output>` template already names it explicitly.

### 7. Session cleanup hook

`src/core/Session.ts:720-744`, in `close()`:

```diff
async close(): Promise<void> {
+  try {
+    await this.toolResultStore?.cleanup(this.sessionId);
+  } catch (e) {
+    console.error('Failed to clean up tool result store:', e);
+  }
   if (this.services?.rollout) { ... }
}
```

Server mode also gets the same Claudy-style background TTL sweep: at server start, walk `{dataDir}/sessions/*/tool-results/*` and delete files older than N days (default 30). Implement in a new `src/server/maintenance/toolResultCleanup.ts`, invoked from server bootstrap.

### A. Session wiring (single source of truth)

`Session` becomes the owner of both the `ToolResultStore` and `ContentReplacementState`. Two reasons: (1) it already owns `sessionId`, `services.rollout`, and `close()`; (2) the existing `TurnManager` constructor is called from 1 production site (`src/core/tasks/RegularTask.ts:48-52`) and 33 test fixtures — adding positional params there is high-noise. Pulling deps from `Session` keeps the surface unchanged.

#### Additions to `Session` (`src/core/Session.ts`)

1. **Private fields** (alongside existing fields ~line 70):
   ```typescript
   private toolResultStore?: ToolResultStore;
   private replacementState?: ContentReplacementState;
   ```

2. **Initialise in constructor** (after `sessionId` is minted, ~`lines 73-132`):
   ```typescript
   // Persistence is gated: if AgentConfig disables it, leave undefined.
   if (config.toolResultPersistence?.enabled !== false) {
     this.replacementState = new ContentReplacementState();
     try {
       this.toolResultStore = createToolResultStore({
         cache: services?.sessionCache,           // for cache-backed platforms
         serverRootDir: services?.serverDataDir   // for server platform
           ? join(services.serverDataDir, 'sessions')
           : undefined,
       });
     } catch (e) {
       console.warn('Tool result persistence unavailable:', e);
       this.toolResultStore = undefined;
       this.replacementState = undefined;
     }
   }
   ```

   `services.sessionCache` and `services.serverDataDir` are new entries on `SessionServices`. Caller plumbing:
   - **Extension/desktop/mobile**: the bootstrap that creates `Session` already constructs (or can obtain) a `SessionCacheManager`. Pass it in.
   - **Server**: `ServerAgentBootstrap` already has `dataDir` in scope (`ServerAgentBootstrap.ts:105-107`). Pass it as `serverDataDir`.

3. **Accessors** (public, used by `TurnManager`):
   ```typescript
   getToolResultStore(): ToolResultStore | undefined { return this.toolResultStore; }
   getContentReplacementState(): ContentReplacementState | undefined { return this.replacementState; }
   ```

4. **Cleanup hook** in `close()` (`lines 720-744`): see §7 below — unchanged from the existing design.

5. **Resume hook** in `reconstructHistoryFromRollout()` (`lines 1626-1651`): walks `response_item`s for `function_call_output` (seeds `seenIds`) and `content_replacement` items (populates `replacements`) — see §5 above.

#### `TurnManager` access pattern

`TurnManager` does not own these — it pulls them off `this.session` at use sites:

```typescript
// In executeToolCall (tier-1):
const store = this.session.getToolResultStore();
const state = this.session.getContentReplacementState();
if (!store || !state) {
  return { type: 'function_call_output', call_id: callId, output };
}
// ... persistence logic ...

// In handleResponseItem (tier-2):
const state = this.session.getContentReplacementState();
const store = this.session.getToolResultStore();
if (!state || !store) return toolCallResults;     // feature off → no-op
// ... budget enforcement ...
```

This means **zero** changes to the `TurnManager` constructor signature and **zero** test-fixture churn.

#### Rollout-record on `record()`

`ContentReplacementState.record()` needs to also write to the rollout. It can't reach the recorder directly — instead, `Session` wires it via a callback at construction time:

```typescript
this.replacementState = new ContentReplacementState({
  onRecord: (rec) => {
    void this.services?.rollout?.recordItems([
      { type: 'content_replacement', payload: rec },
    ]).catch(e => console.error('rollout record failed', e));
  },
});
```

The `ContentReplacementState` constructor takes `{ onRecord?: (rec: ContentReplacementRecord) => void }`. On resume, `Session.reconstructHistoryFromRollout` calls `record()` to seed state — the `onRecord` callback runs and the recorder no-ops on the duplicate (or, more cleanly, resume seeding uses a separate `seedFromResume(rec)` method that bypasses the callback).

```typescript
class ContentReplacementState {
  constructor(private opts: { onRecord?: (rec: ContentReplacementRecord) => void } = {}) {}

  record(callId: string, replacement: string): void {
    this.seenIds.add(callId);
    this.replacements.set(callId, replacement);
    this.opts.onRecord?.({ kind: 'tool-result', toolUseId: callId, replacement });
  }

  /** Used during resume — populates state without re-recording to rollout. */
  seedFromResume(rec: ContentReplacementRecord): void {
    this.seenIds.add(rec.toolUseId);
    this.replacements.set(rec.toolUseId, rec.replacement);
  }

  freezeUnreplaced(callId: string): void { this.seenIds.add(callId); }
  reapply(callId: string): string | undefined { return this.replacements.get(callId); }
}
```

### 8. Edge cases and decisions captured

- **Empty results**: keep current behavior (no marker injection). Claudy's empty-content marker is an artifact of how it builds `content` arrays; BrowserX's `output: string` field has no such ambiguity.
- **Exactly-at-threshold**: `output.length > threshold` → boundary value (`length === threshold`) is **not** persisted. Matches Claudy.
- **Idempotency on tier-1**: `CacheToolResultStore.persist` is not idempotent today because `SessionCacheManager.write()` always creates a new entry. Replay would orphan the prior entry. Mitigation: at the tier-1 call site, only invoke `persist` when `state.replacements` does not already contain the `call_id` (use `state.record()` to ensure this). On replay, `state.replacements` is reconstructed first; the existing replacement is reused via `mustReapply`.
- **5 MB items in IndexedDB**: explicit fallback to truncation marker. Test with a 6 MB synthetic result.
- **Image-content tools**: not applicable today — no BrowserX tool returns content-block arrays with images. If `page_vision` ever does, we'll need Claudy's image-block check; for now, skip.
- **Per-turn budget when tier-1 already persisted everything**: tier-2 should still be invoked but will be a no-op (all relevant ids are already in `replacements`). The mustReapply path keeps everything byte-identical.
- **`JSON.stringify` throws on circular refs**: the current `TurnManager.ts:731` uses raw `JSON.stringify`, so the new code inherits that behavior. If a tool returns a graph with a cycle, the turn throws — same as today. Not in scope to fix here.
- **`SessionCacheManager.list()` return shape**: `list()` returns `CacheMetadata[]` (`src/storage/SessionCacheManager.ts:309-322`). Verify during implementation that `customMetadata` is included in the metadata projection; if it's stripped for size reasons (`TARGET_METADATA_SIZE = 700`), cleanup needs a small tweak (e.g. expose `customMetadata.kind` as a first-class field, or do a streaming filter via `read()` per item — slower but correct).
- **Multi-turn concurrency on `ContentReplacementState`**: the state is mutated in place by `TurnManager`. BrowserX runs one turn at a time per session (turns are sequential), so no locking is needed. If parallel turns per session are ever introduced, mutations would need synchronization.

---

## Files to Change

| File | Change | Reference |
|------|--------|-----------|
| `src/tools/resultStore.ts` | **New**: `ToolResultStore` interface, `PersistedResult`, `CacheToolResultStore`, `FileToolResultStore`, `createToolResultStore` factory, `generatePreview`, `formatFileSize`, `buildPersistedOutputMessage`. | new |
| `src/tools/toolLimits.ts` | **New**: constants (`DEFAULT_MAX_RESULT_SIZE_CHARS`, `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`, `PREVIEW_SIZE_BYTES`) and `getPersistenceThreshold`. | new |
| `src/tools/resultBudget.ts` | **New**: `enforceToolResultBudget` for tier-2. | new |
| `src/tools/replacementState.ts` | **New**: `ContentReplacementState` class and `ContentReplacementRecord` type. | new |
| `src/tools/ToolRegistry.ts` | Remove inline truncation block. Add `getInfinityTools(): Set<string>` helper. | `lines 464-475`, `lines 583-587` |
| `src/core/TurnManager.ts` | Pull `store` and `state` from `this.session` at call sites (no constructor change). Add tier-1 persistence after serialization. Invoke tier-2 after batch execution. | `lines 728-737` (tier-1), `lines 570-604` (tier-2) |
| `src/core/Session.ts` | Add `toolResultStore`/`replacementState` fields + accessors. Initialise in constructor. Add `cleanup(sessionId)` in `close()`. Extend `reconstructHistoryFromRollout()` to seed state. | `lines 73-132` (ctor), `lines 720-744` (close), `lines 1626-1651` (resume) |
| `src/core/SessionServices.ts` (or wherever `SessionServices` lives) | Add `sessionCache?: SessionCacheManager` and `serverDataDir?: string` fields. | locate during impl |
| `src/storage/rollout/types.ts` | Add `content_replacement` variant to `RolloutItem` union. | `lines 149-155` |
| `src/storage/rollout/policy.ts` | Ensure `content_replacement` is allowed by `filterPersistedItems`. | `lines 17-32` |
| `src/extension/tools/registerExtensionTools.ts` | Change `cache_storage_tool` to `maxResultSizeChars: Number.POSITIVE_INFINITY`. | `line 280` |
| `src/server/tools/ReadPersistedResultTool.ts` | **New**: server-only retrieval tool with path-traversal guard. | new |
| `src/server/tools/registerServerTools.ts` | Accept new `dataDir?: string` param; register `read_persisted_result` when present, following `PlanningTool` pattern. | `lines 36-111`, pattern at `lines 44-67` |
| `src/server/agent/ServerAgentBootstrap.ts` | Pass `dataDir` to `registerServerTools(...)`. | `line 44` (call site), `lines 105-107` (dataDir source) |
| `src/server/maintenance/toolResultCleanup.ts` | **New**: TTL-based background sweep for server mode. | new |
| `src/storage/SessionCacheManager.ts` | No source change required for first cut (cleanup uses `list` + filter on `customMetadata`). Optional follow-up: add `listByCustomMetadata` for efficiency. | optional |
| `src/tools/__tests__/toolResultStore.test.ts` | **New** unit tests. | new |
| `src/tools/__tests__/resultBudget.test.ts` | **New** unit tests. | new |
| `src/tools/__tests__/replacementState.test.ts` | **New** unit tests. | new |
| `src/core/__tests__/TurnManager.persistence.test.ts` | **New** integration tests for tier-1 and tier-2. | new |

---

## Implementation Phases

### Phase 1: Storage backend

**1A. `ToolResultStore` interface + helpers** (`src/tools/resultStore.ts`)
- [ ] Define `PersistedResult`, `ToolResultStore`.
- [ ] Implement `generatePreview(content, maxBytes)` — direct port of Claudy `lines 339-356`.
- [ ] Implement `formatFileSize(bytes)` producing `"1.2 KB"`, `"245 KB"`, etc.
- [ ] Implement `buildPersistedOutputMessage(result)` for both `kind: 'cache'` and `kind: 'file'`.

**1B. `CacheToolResultStore`**
- [ ] Use `SessionCacheManager.write/read/delete/list` with `customMetadata: { kind: 'tool_result', toolUseId }`.
- [ ] Wrap content in `{ content: string }` so `retrieve` can unwrap.
- [ ] `persist` rejects content > 5 MB with a typed error → caller falls back to truncation.
- [ ] `cleanup` lists session items and deletes those tagged `kind === 'tool_result'`.

**1C. `FileToolResultStore`**
- [ ] Dynamic-import `node:fs/promises`, `node:path`.
- [ ] Path: `{rootDir}/{sessionId}/tool-results/{toolUseId}.txt`.
- [ ] `mkdir({ recursive: true })` then `writeFile(... { flag: 'wx' })` with `EEXIST` swallow.
- [ ] `retrieve` returns `null` on `ENOENT`; rethrows otherwise.
- [ ] `cleanup` does `rm(dir, { recursive: true, force: true })`.

**1D. Factory + platform selection**
- [ ] `createToolResultStore({ cache?, serverRootDir? })` switches on `__BUILD_MODE__`.
- [ ] Wire into `Session` constructor.

**1E. Unit tests** (`src/tools/__tests__/toolResultStore.test.ts`)
- [ ] `generatePreview` cuts at newline if last newline > 50% of limit.
- [ ] `generatePreview` cuts at exact limit when no newline in second half.
- [ ] `generatePreview` returns full content when under limit, `hasMore: false`.
- [ ] `CacheToolResultStore.persist` writes, returns reference; `retrieve` round-trips.
- [ ] `CacheToolResultStore.persist` on content > 5 MB throws (typed).
- [ ] `CacheToolResultStore.cleanup` deletes only tool_result entries (not user entries).
- [ ] `FileToolResultStore.persist` writes with `wx` flag; second call with same id silently no-ops (idempotent).
- [ ] `FileToolResultStore.retrieve` reads back; returns `null` on missing file.
- [ ] `FileToolResultStore.cleanup` removes session directory.

### Phase 2: Tier-1 — persist instead of truncate

**2A. Constants + threshold helper** (`src/tools/toolLimits.ts`)
- [ ] Define `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`, `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`, `PREVIEW_SIZE_BYTES = 2_000`.
- [ ] Implement `getPersistenceThreshold(toolName, declaredMax)` — Infinity opt-out, undefined → default, finite → `min(declared, DEFAULT)`.

**2B. Remove old truncation**
- [ ] Delete the `maxResultSizeChars` block in `ToolRegistry.execute()` (`src/tools/ToolRegistry.ts:464-475`).
- [ ] Keep `getResultProfile` and `maxResultSizeChars` field — they're still used as the threshold input.

**2C. Replacement state**
- [ ] Implement `ContentReplacementState` class (`src/tools/replacementState.ts`).
- [ ] Instantiate on `Session`. Pass to `TurnManager`.

**2D. Tier-1 persist in `TurnManager.executeToolCall`**
- [ ] After `const output = typeof result === 'string' ? result : JSON.stringify(result)` (`src/core/TurnManager.ts:728`):
  - [ ] Look up `getResultProfile(toolName)`.
  - [ ] Compute threshold via `getPersistenceThreshold`.
  - [ ] If `Number.isFinite(threshold) && output.length > threshold`:
    - [ ] Check `replacementState.reapply(callId)` first — replay path, use cached replacement.
    - [ ] Else: `await toolResultStore.persist(sessionId, callId, output)`, build message, `replacementState.record(callId, message)`, return.
    - [ ] On error: fallback to legacy truncation marker; log; do not record in state.
- [ ] Always emit `function_call_output`.

**2E. Fix `cache_storage_tool` exemption**
- [ ] Set `maxResultSizeChars: Number.POSITIVE_INFINITY` in `registerExtensionTools.ts:280`.
- [ ] (Optional) Move tool registration's `maxResultSizeChars` for `storage_tool` to a per-action computation if writes-with-huge-payloads ever become a concern.

**2F. Tests**
- [ ] Result under threshold → passes through unchanged.
- [ ] Oversized string result → persisted, preview returned.
- [ ] Oversized object result (post-stringify) → persisted; this exercises the path the current code already handles but verifies it still works after the move.
- [ ] Persistence failure → falls back to truncation marker with reason.
- [ ] Replay of the same `call_id` with state pre-populated → no `persist()` call; cached replacement reused.
- [ ] `cache_storage_tool` read of large persisted content → not re-persisted (Infinity opt-out).

### Phase 3: Tier-2 — per-message aggregate budget

**3A. `enforceToolResultBudget`** (`src/tools/resultBudget.ts`)
- [ ] Partition by `state` (mustReapply / frozen / fresh).
- [ ] Skip Infinity tools (mark seen, exclude from eligible).
- [ ] Selection: sort eligible by `output.length` desc, persist until total under limit.
- [ ] Parallel `Promise.all`. Atomic state mutation post-await.
- [ ] On individual persist failure: mark seen, leave output unchanged.

**3B. Wire into `handleResponseItem`**
- [ ] After `executeToolCallBatches` returns (`TurnManager.ts:570-604`), pass `toolCallResults` through `enforceToolResultBudget` before returning.
- [ ] Provide a `getInfinityTools(): Set<string>` helper on `ToolRegistry` — set of tool names whose `maxResultSizeChars` is non-finite.

**3C. Rollout-record replacement decisions**
- [ ] New `RolloutItem` variant: `{ type: 'content_replacement', payload: ContentReplacementRecord }`.
- [ ] On each `state.record(...)` call, also call `services.rollout.recordItems(...)`.
- [ ] On `Session` resume, scan loaded rollout items and rebuild `replacementState` (seenIds from tool_use_ids in restored messages; replacements from `content_replacement` items).

**3D. Tests**
- [ ] 5 × 30K (150K total, under 200K) → all pass through, no extra persistence.
- [ ] 5 × 50K (250K total) → largest persisted first until under 200K (expect 1 persisted; running total 250K → 200K).
- [ ] Replay produces byte-identical output (replacement state reused).
- [ ] Mixed batch with Infinity-tagged tool → that tool's result excluded from budget math.
- [ ] Per-result persist failure during tier-2 → that result keeps original output; state.seenIds marks it; budget may remain over.

### Phase 4: Cleanup, resume, compaction

**4A. Session cleanup**
- [ ] Add `toolResultStore.cleanup(sessionId)` call in `Session.close()` (`src/core/Session.ts:720-744`).
- [ ] Extension/desktop/mobile: cleanup via `CacheToolResultStore.cleanup` (lists + filters by `customMetadata.kind`).
- [ ] Server: `rm` of session dir.

**4B. Server-mode TTL sweep**
- [ ] New `src/server/maintenance/toolResultCleanup.ts`.
- [ ] On server start, schedule a periodic walk of `{dataDir}/sessions/*/tool-results/*`; delete files older than 30 days by `mtime`.
- [ ] Wire from server bootstrap.

**4C. Resume**
- [ ] In `Session` constructor when `initialHistory.mode === 'resumed'`:
  - Walk restored messages, collect every `tool_use_id` appearing in `function_call_output` items → `seenIds`.
  - Walk restored rollout items for `content_replacement` payloads → `replacements`.
  - The two sets need not match; ids in messages without records are "seen but unreplaced" (frozen).
- [ ] Tests for resume produce byte-identical wire on next turn.

**4D. Compaction**
- [ ] Audit `CompactService` (`src/core/Session.ts:28-30`) — out of scope for first PR if compaction doesn't yet preserve tool_result blocks.
- [ ] If compaction drops some tool_result blocks: their entries can be removed from `state.replacements` and `state.seenIds`; surviving blocks keep entries intact.

---

## Risks and Mitigations

### Risk: `SessionCacheManager` quota contention

Tool results compete with user-stored entries for the 200 MB per-session quota. If eviction triggers, tool result entries can be deleted out from under the agent.

**Mitigation**:
- Tag tool result entries via `customMetadata.kind === 'tool_result'`.
- (Follow-up if eviction becomes a problem) Modify `autoEvict` to prefer evicting tool_result entries over user entries — or run tool results in a separate IndexedDB store with its own quota.
- The agent retrieves persisted content immediately after seeing the preview in typical flows, so eviction-before-retrieve is unlikely in practice.

### Risk: 5 MB IndexedDB item cap

Cache rejects single items > 5 MB. A 6 MB DOM snapshot would persist-fail and fall back to truncation.

**Mitigation**:
- Already covered by Phase 2's "persistence failure → truncation marker" fallback.
- For very large results, follow-up could chunk into N entries with a manifest entry; not in scope.

### Risk: `cache_storage_tool` retrieval requires Infinity

If the retrieval tool is itself capped, the agent can never see the full content it just persisted.

**Mitigation**: Phase 2E sets `cache_storage_tool` to `Number.POSITIVE_INFINITY`. Verified by Phase 2F's read-back test.

### Risk: Path-traversal via `read_persisted_result`

The server tool reads a file path supplied by the agent. A malicious or buggy model could try paths outside the tool-results dir.

**Mitigation**: `realpath`-resolve and prefix-check (see §6b). Symlink escapes are caught because `realpath` follows the symlink before the check. Reject if not under `{rootDir}/.../tool-results/...`.

### Risk: Replacement state diverges across replay

If the rollout recorder fails to persist a `content_replacement` item, resume reconstructs partial state and re-decides — wire bytes diverge → cache miss.

**Mitigation**:
- Replacement records and the messages that reference them must commit atomically. Rollout already batches; verify `recordItems` for tool-result outputs *and* replacement records appear in the same batch.
- Add an integration test: persist, force a "crash" (recorder flushed mid-turn), resume, verify byte-identical output.

### Risk: Idempotency on tier-1 with `SessionCacheManager`

The cache store creates a new entry per write — without a guard, replay duplicates entries.

**Mitigation**: Guard at the call site with `replacementState.reapply(callId)` first. Only call `persist` when there is no recorded replacement. On true crash-replay with no prior rollout record, a duplicate entry is possible but harmless (orphaned by `cleanup`).

### Risk: Mobile mode is untested

Mobile uses IndexedDB but with platform quirks (some Android WebViews have stricter quotas).

**Mitigation**: Treat mobile as extension-equivalent for the first cut. Add a mobile smoke test in a follow-up if real users hit quota issues.

---

## Open Questions (defer)

1. Do we want to expose persisted-result metadata in the UI (badge on tool results that were persisted)? Not required for correctness.
2. Should `ContentReplacementState` be feature-flagged like Claudy's `tengu_hawthorn_steeple`? Probably yes for safe rollout, but BrowserX doesn't have GrowthBook. Plumb through `AgentConfig`?
3. Compaction integration — when does CompactService actually run? Audit needed before Phase 4D can be implemented.
4. Should the per-message budget limit be configurable per session (e.g. via `AgentConfig`)? Default-only is fine for v1.
