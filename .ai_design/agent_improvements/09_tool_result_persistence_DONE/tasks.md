# Track 09: Tool Result Persistence — Tasks

References to `design.md` are by section number. References to existing BrowserX code are by `file:line`.

## Phase 1: Storage Backend

### 1A. Define `ToolResultStore` interface and helpers
- [ ] Create `src/tools/resultStore.ts`.
- [ ] Define `PersistedResult` type with fields `reference`, `kind: 'cache' | 'file'`, `originalSize`, `preview`, `hasMore` (see design §1).
- [ ] Define `ToolResultStore` interface with `persist(sessionId, toolUseId, content)`, `retrieve(reference)`, `cleanup(sessionId)`.
- [ ] Implement `generatePreview(content, maxBytes)` — port of Claudy `utils/toolResultStorage.ts:339-356`. Cut at last newline if it lies in the second half of the byte window; otherwise cut at exact limit.
- [ ] Implement `formatFileSize(bytes)` producing strings like `"1.2 KB"`, `"245 KB"`, `"1.5 MB"`.
- [ ] Implement `buildPersistedOutputMessage(result: PersistedResult)`:
  - Branch on `result.kind`.
  - `cache`: instruct agent to call `cache_storage_tool` with `action: 'read'` and the stored key.
  - `file`: name the file path directly.
  - Both end with `Preview (first {previewLimit}):\n{preview}{hasMore ? '...\n' : ''}</persisted-output>`.

### 1B. Implement `CacheToolResultStore` (extension / desktop / mobile)
- [ ] Wraps `SessionCacheManager`.
- [ ] `persist`:
  - Reject `content.length > 5 * 1024 * 1024` with a typed error (caller will fall back to truncation).
  - Call `cache.write(sessionId, { content }, description, undefined, undefined, { kind: 'tool_result', toolUseId })`.
  - Use the returned `metadata.storageKey` as `reference`.
  - Compute preview via `generatePreview`.
- [ ] `retrieve`: `cache.read(reference)`, unwrap `.data.content`. Return `null` on `ItemNotFoundError`.
- [ ] `cleanup`: `cache.list(sessionId)` → filter `customMetadata?.kind === 'tool_result'` → `Promise.all(cache.delete(...))`.

### 1C. Implement `FileToolResultStore` (server)
- [ ] Constructor takes `rootDir` (e.g. `{dataDir}/sessions`).
- [ ] Path: `{rootDir}/{sessionId}/tool-results/{toolUseId}.txt`.
- [ ] `persist`:
  - Dynamic-import `node:fs/promises`, `node:path`.
  - `mkdir(dirname, { recursive: true })`.
  - `writeFile(path, content, { encoding: 'utf-8', flag: 'wx' })`.
  - On `EEXIST` (replay), swallow — file already there from a prior turn.
  - On other errors, rethrow (caller falls back to truncation).
  - Compute preview.
- [ ] `retrieve`: `readFile(path, 'utf-8')`. Return `null` on `ENOENT`.
- [ ] `cleanup`: `rm(join(rootDir, sessionId, 'tool-results'), { recursive: true, force: true })`.

### 1D. Factory and platform selection
- [ ] Implement `createToolResultStore(deps: { cache?, serverRootDir? })` switching on `__BUILD_MODE__`:
  - `extension` / `desktop` / `mobile` → `CacheToolResultStore` (requires `deps.cache`).
  - `server` → `FileToolResultStore` (requires `deps.serverRootDir`, which is the already-joined `{dataDir}/sessions` path).
- [ ] Throw a typed error if the required dep is missing for the current platform.
- [ ] (Session-side wiring is covered in §2C.2, not here.)

### 1E. Unit tests (`src/tools/__tests__/toolResultStore.test.ts`)
- [ ] `generatePreview` returns full content when `content.length <= maxBytes`, `hasMore: false`.
- [ ] `generatePreview` cuts at last newline when newline is > 50% of `maxBytes`.
- [ ] `generatePreview` cuts at exact `maxBytes` when no newline in second half.
- [ ] `CacheToolResultStore.persist` writes via `SessionCacheManager` with `customMetadata.kind === 'tool_result'`.
- [ ] `CacheToolResultStore.retrieve` round-trips the content unchanged.
- [ ] `CacheToolResultStore.persist` rejects content > 5 MB with a typed error.
- [ ] `CacheToolResultStore.cleanup` deletes only entries tagged `kind === 'tool_result'`; leaves other user entries intact.
- [ ] `FileToolResultStore.persist` creates parent dir, writes with `wx`.
- [ ] `FileToolResultStore.persist` second call with same ids is a no-op (idempotent via `EEXIST` swallow).
- [ ] `FileToolResultStore.retrieve` reads back; returns `null` on missing path.
- [ ] `FileToolResultStore.cleanup` removes the session's `tool-results/` directory.

---

## Phase 2: Tier-1 — Persist Instead of Truncate

### 2A. Constants and threshold helper
- [ ] Create `src/tools/toolLimits.ts`.
- [ ] Export `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`, `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`, `PREVIEW_SIZE_BYTES = 2_000`.
- [ ] Implement `getPersistenceThreshold(toolName, declaredMax)`:
  - `declaredMax === undefined` → return default.
  - `!Number.isFinite(declaredMax)` → return `declaredMax` unchanged (Infinity opt-out).
  - finite number → return `Math.min(declaredMax, DEFAULT_MAX_RESULT_SIZE_CHARS)`.

### 2B. Remove inline truncation from `ToolRegistry`
- [ ] Delete `src/tools/ToolRegistry.ts:464-475` (the `maxResultSizeChars` truncation block).
- [ ] Keep `getResultProfile()` (`lines 583-587`) and the `maxResultSizeChars` field on `ToolResultProfile` — still used as the threshold input.
- [ ] Add `getInfinityTools(): Set<string>` to `ToolRegistry`: returns names of registered tools whose `runtime.result?.maxResultSizeChars` is non-finite. Used by tier-2.

### 2C. `ContentReplacementState`
- [ ] Create `src/tools/replacementState.ts`.
- [ ] Define `ContentReplacementRecord` type: `{ kind: 'tool-result'; toolUseId: string; replacement: string }`.
- [ ] Implement `ContentReplacementState` class with:
  - Constructor: `constructor(opts: { onRecord?: (rec: ContentReplacementRecord) => void } = {})`.
  - Readonly fields `seenIds: Set<string>`, `replacements: Map<string, string>`.
  - `record(callId, replacement)`: adds to both, fires `opts.onRecord`.
  - `seedFromResume(rec)`: adds to both, does NOT fire `onRecord`.
  - `freezeUnreplaced(callId)`: adds to `seenIds` only.
  - `reapply(callId): string | undefined`: Map lookup.

### 2C.2. Session wiring (no TurnManager constructor change)
- [ ] Extend `SessionServices` (locate file during impl) with optional `sessionCache?: SessionCacheManager` and `serverDataDir?: string`.
- [ ] In `src/core/Session.ts` constructor (`lines 73-132`), after `sessionId` is minted:
  - `this.replacementState = new ContentReplacementState({ onRecord: rec => services?.rollout?.recordItems([{ type: 'content_replacement', payload: rec }]).catch(logError) })`.
  - `this.toolResultStore = createToolResultStore({ cache: services?.sessionCache, serverRootDir: services?.serverDataDir ? join(services.serverDataDir, 'sessions') : undefined })` inside a try/catch — on failure leave both fields undefined.
- [ ] Add public accessors `getToolResultStore()` and `getContentReplacementState()` returning the (possibly undefined) instances.
- [ ] **Do not** change `TurnManager`'s constructor. Tier-1 and tier-2 read from `this.session.getToolResultStore()` / `this.session.getContentReplacementState()` and short-circuit when either is `undefined`.
- [ ] Caller plumbing:
  - Extension/desktop/mobile: pass `sessionCache: <SessionCacheManager instance>` into `SessionServices` from the existing bootstrap.
  - Server: pass `serverDataDir: dataDir` into `SessionServices` from `ServerAgentBootstrap.initialize()` (`src/server/agent/ServerAgentBootstrap.ts:105-107`).

### 2C.3. Rollout schema for replacement records
- [ ] In `src/storage/rollout/types.ts:149-155`, add `| { type: 'content_replacement'; payload: ContentReplacementRecord }` to the `RolloutItem` union.
- [ ] In `src/storage/rollout/policy.ts:17-32`, ensure `content_replacement` survives `filterPersistedItems` (allowlist it if the policy is allow-list based; no-op if deny-list).
- [ ] In `src/core/Session.ts:1626-1651` (`reconstructHistoryFromRollout`):
  - For each `response_item` whose `payload.type === 'function_call_output'`: call `this.replacementState?.freezeUnreplaced(payload.call_id)` to seed `seenIds`.
  - Add a new branch: `if (rolloutItem.type === 'content_replacement') this.replacementState?.seedFromResume(rolloutItem.payload)`.
  - `seedFromResume` deliberately bypasses `onRecord` so resume doesn't re-write everything back to rollout.

### 2D. Tier-1 persistence in `TurnManager.executeToolCall`
- [ ] In `src/core/TurnManager.ts`, after the existing serialization at `lines 728-737`:
  - `const store = this.session.getToolResultStore(); const state = this.session.getContentReplacementState();`
  - If `!store || !state` → return `{ type: 'function_call_output', call_id, output }` unchanged (feature off).
  - Look up `profile = this.toolRegistry.getResultProfile(toolName)`.
  - Compute `threshold = getPersistenceThreshold(toolName, profile?.maxResultSizeChars)`.
  - If `Number.isFinite(threshold) && output.length > threshold`:
    - Check `cached = state.reapply(callId)`. If set, return `{ type: 'function_call_output', call_id, output: cached }` — replay path, no I/O.
    - Else: `persisted = await store.persist(this.session.getSessionId(), callId, output)`.
    - `message = buildPersistedOutputMessage(persisted)`.
    - `state.record(callId, message)` (also fires `onRecord` → rollout).
    - Return `{ type: 'function_call_output', call_id, output: message }`.
  - On persistence error: build legacy truncation marker (`output.slice(0, threshold) + "\n\n[Result truncated from X to Y chars — persistence failed: ...]"`), log, do **not** record in state, return.
- [ ] If `threshold` is `Infinity` or `output.length <= threshold`: return unchanged.

### 2E. Fix `cache_storage_tool` to opt out (extension / desktop / mobile)
- [ ] In `src/extension/tools/registerExtensionTools.ts:280`, change `result: { maxResultSizeChars: 50_000 }` → `result: { maxResultSizeChars: Number.POSITIVE_INFINITY }`.

### 2E.2. Add `read_persisted_result` tool (server)
- [ ] Create `src/server/tools/ReadPersistedResultTool.ts` per design §6b.
- [ ] Tool definition: name `read_persisted_result`, input schema `{ path: string }` (required).
- [ ] Implement `execute`:
  - `realpath(input.path)` and `realpath(rootDir)` before comparison (catches symlink escapes).
  - Reject if resolved path does not start with `realRoot + sep`.
  - Reject if resolved path does not contain `${sep}tool-results${sep}`.
  - `ENOENT` → descriptive error ("may have been cleaned up").
  - Otherwise `readFile(resolved, 'utf-8')` and return.
- [ ] Update `src/server/tools/registerServerTools.ts:36-111` to accept a new optional `dataDir?: string` parameter, and add the registration block (follow the `PlanningTool` pattern at `lines 44-67`).
- [ ] Update `src/server/agent/ServerAgentBootstrap.ts:44` to pass `dataDir` (already in scope at `lines 105-107`) to `registerServerTools(registry, dataDir)`.
- [ ] Build `rootDir` inside the registration block as `join(dataDir, 'sessions')` so it matches `FileToolResultStore`'s root.
- [ ] Registration metadata:
  - `concurrency: { isConcurrencySafe: () => true, isReadOnly: () => true, isDestructive: () => false }`.
  - `result: { maxResultSizeChars: Number.POSITIVE_INFINITY }`.
- [ ] Tests (`src/server/tools/__tests__/ReadPersistedResultTool.test.ts`):
  - [ ] Reads a persisted file under `tool-results/`.
  - [ ] Rejects path outside `rootDir` (absolute path elsewhere).
  - [ ] Rejects path inside `rootDir` but not under `tool-results/` (e.g. session dir directly).
  - [ ] Rejects `..` traversal attempts.
  - [ ] Rejects symlink that resolves outside `rootDir`.
  - [ ] Returns descriptive error on `ENOENT`.

### 2F. Tests (`src/core/__tests__/TurnManager.persistence.test.ts`)
- [ ] Result under threshold passes through unchanged.
- [ ] Oversized string result is persisted; output is the `<persisted-output>` message; preview cut at newline.
- [ ] Oversized object result (post-`JSON.stringify` > threshold) is persisted.
- [ ] Persistence failure falls back to truncation marker; state is **not** populated.
- [ ] Replay with `replacementState` pre-populated reuses cached replacement; `toolResultStore.persist` is **not** called.
- [ ] `cache_storage_tool` read of a 100KB cached blob is not re-persisted (Infinity opt-out).
- [ ] `<persisted-output>` message contains retrieval instructions referencing `cache_storage_tool` (extension/desktop/mobile) or `read_persisted_result` + file path (server).
- [ ] Server-mode round-trip: `FileToolResultStore.persist` → preview includes file path → `read_persisted_result` returns the full original content byte-for-byte.

---

## Phase 3: Tier-2 — Per-Message Aggregate Budget

### 3A. `enforceToolResultBudget`
- [ ] Create `src/tools/resultBudget.ts`.
- [ ] BrowserX has no `FunctionCallOutput` type — define a local alias for the `function_call_output` variant of `ResponseItem` (`src/core/protocol/types.ts:246-249`):
  ```typescript
  import type { ResponseItem } from '@/core/protocol/types';
  export type FunctionCallOutputItem = Extract<ResponseItem, { type: 'function_call_output' }>;
  ```
- [ ] Signature:
  ```typescript
  enforceToolResultBudget(
    results: FunctionCallOutputItem[],
    state: ContentReplacementState | undefined,
    opts: {
      store: ToolResultStore;
      sessionId: string;
      limit: number;
      skipToolNames: ReadonlySet<string>;
    },
  ): Promise<FunctionCallOutputItem[]>
  ```
- [ ] If `state` is `undefined`, short-circuit and return `results` unchanged.
- [ ] Partition each result by prior decision: `mustReapply` (id in `state.replacements`), `frozen` (id in `state.seenIds` only), `fresh` (unseen).
- [ ] For `mustReapply`: swap `output` to `state.replacements.get(callId)`.
- [ ] For fresh entries whose tool name is in `skipToolNames`: `state.freezeUnreplaced(callId)`, exclude from eligible.
- [ ] Compute `frozenSize` + `eligibleSize`. If `<= limit`: freeze all eligible as seen-unreplaced; return.
- [ ] Else: sort eligible by `output.length` desc; select largest-first until running total `<= limit`.
- [ ] `Promise.all` persist for selected. After all settle:
  - For each succeeded: `state.record(callId, message)`, replace `output` in the returned array.
  - For each failed: `state.freezeUnreplaced(callId)`, leave `output` unchanged.
- [ ] All non-selected fresh entries get `state.freezeUnreplaced(callId)`.

### 3B. Wire into `handleResponseItem`
- [ ] In `src/core/TurnManager.ts:570-604` (unified `message.tool_calls` path), after `executeToolCallBatches` returns the `T[]`:
  - `const store = this.session.getToolResultStore(); const state = this.session.getContentReplacementState();`
  - Call `enforceToolResultBudget(toolCallResults as FunctionCallOutputItem[], state, { store, sessionId: this.session.getSessionId(), limit: MAX_TOOL_RESULTS_PER_MESSAGE_CHARS, skipToolNames: this.toolRegistry.getInfinityTools() })`. If `store` is undefined, skip the call.
  - Preserve the existing single-vs-array return shape: `if (enforced.length === 1) return enforced[0]; return enforced;` (`TurnManager.ts:600-603`).
- [ ] Legacy `function_call` path (`lines 540-553`) — single result. Wrap in array, call enforce, unwrap. Trivially a no-op in the common case; keeps behavior uniform.

### 3C. Rollout-record replacement decisions
- [ ] Schema/policy changes are covered in §2C.3.
- [ ] No additional code in tier-2 path: `state.record()` already fires the `onRecord` callback wired up by `Session` (§2C.2). Tier-1 and tier-2 share the same recording mechanism — no double-write because tier-2 only calls `record()` for newly-persisted entries, never for `mustReapply` ones.

### 3D. Tests (`src/tools/__tests__/resultBudget.test.ts`)
- [ ] 5 × 30K results (150K total, under 200K) → all pass through, no persistence calls.
- [ ] 5 × 50K results (250K total) → largest persisted first; running total drops below 200K (expect 1 persisted).
- [ ] Two turns with the same `tool_use_id`s and identical content → byte-identical output array on turn 2 (replacement state reused, no fresh persistence).
- [ ] Mixed batch including a tool registered with `maxResultSizeChars: Infinity` → that result is excluded from budget math (and from selection candidates).
- [ ] Per-result persist failure during tier-2 → that result keeps original output; `state.seenIds` includes the call_id; budget may remain over limit (acceptable).
- [ ] Tier-1 already persisted some results in the same turn → tier-2 sees them via `mustReapply` and does not re-persist.

---

## Phase 4: Cleanup, Resume, Compaction

### 4A. Session cleanup hook
- [ ] In `src/core/Session.ts:720-744` (`close()`), call `await this.toolResultStore?.cleanup(this.sessionId)` inside a try/catch that logs but does not throw.
- [ ] Verify Cache-store cleanup leaves user-stored entries (those without `kind === 'tool_result'`) intact.

### 4B. Server-mode TTL sweep
- [ ] Create `src/server/maintenance/toolResultCleanup.ts`.
- [ ] Periodic task (default 30-day TTL by `mtime`):
  - Walk `{dataDir}/sessions/*/tool-results/*`.
  - `unlink` files older than cutoff.
  - Skip empty directories (don't remove the session dir itself).
- [ ] Invoke from server bootstrap. Schedule via `setInterval` or whatever existing periodic-task plumbing the server uses.

### 4C. Resume integration tests
- [ ] Cold start, persist a result, "crash" (do not flush), resume from disk → state rebuilt from rollout items → next turn produces byte-identical output as if no crash happened.
- [ ] Resume with rollout items that reference a `tool_use_id` no longer present in restored messages → that entry is dropped from `replacements` (not load-bearing, but cleaner).
- [ ] Resume in server mode reads back persisted file content via the file path.

### 4D. Compaction
- [ ] Audit `CompactService` (`src/core/Session.ts:28-30`) to determine when it runs and what it does to tool_result blocks.
- [ ] If compaction preserves tool_result blocks: nothing to do; state stays valid.
- [ ] If compaction summarizes / drops tool_result blocks: prune the corresponding entries from `state.seenIds` and `state.replacements` so they don't keep growing across long sessions.
- [ ] (May be follow-up PR — flag if blocking exit criteria.)

---

## Exit Criteria

- [ ] Oversized tool results are persisted, not discarded, on all four platforms (extension, desktop, server, mobile).
- [ ] Agent receives a `<persisted-output>` message with concrete retrieval instructions.
- [ ] Agent can retrieve the full content via `cache_storage_tool` (cache-backed platforms) or by file path (server).
- [ ] Per-message aggregate budget enforced at 200K; parallel tool calls cannot collectively flood context.
- [ ] Replacement decisions stable across replay: same `tool_use_id` always produces byte-identical wire bytes.
- [ ] Session close removes all persisted results for that session.
- [ ] Server-mode TTL sweep removes stale persisted files from crashed sessions.
- [ ] Persistence failures fall back to legacy truncation marker; do not crash the turn.
- [ ] `cache_storage_tool` reads are exempt from persistence (no circular Read→file→Read loop).
