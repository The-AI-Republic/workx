# Track 37 — Integration Defect: Persisted Tool Results Can Vanish Out From Under Rollout Pointers

Date: 2026-05-15
Status: OPEN — P1
Type: Cross-track integration / coexistence bug
Tracks involved: [Track 09 Tool Result Persistence](../09_tool_result_persistence_DONE/design.md) × [Track 04 Typed Task Families](../04_typed_task_families_DONE/design.md) × shared cache/quota/rollout × `StorageTool`
Source: cross-track integration audit 2026-05-15, independently re-verified against on-disk source on `agent-improvements`.

## Summary

Track 09 persists oversized tool results into the **shared** `SessionCacheManager`
(`cache_items`) and records a `<persisted-output>` pointer in the rollout for resume. Three
shared-storage behaviours can destroy that blob while the pointer still exists, so the agent
(or a resumed session) later tries to read a result that is gone.

> Distinct from the known Track 29 G3 / Track 32 P5 "wire a TieredEvictor + agree on tier
> ordering" coordination note — these are concrete *active-misbehaviour* defects, not the
> wiring-absence note.

---

## BUG-1 — High: session `autoEvict` deletes Track 09 results kind-blind

**Evidence (verified):** `CacheToolResultStore.persist` writes via
`SessionCacheManager.write(sessionId, …, { kind: 'tool_result' })`
(`src/tools/resultStore.ts:178-189`; `CACHE_TOOL_RESULT_KIND = 'tool_result'` at
`resultStore.ts:165`). `write` enforces a per-session quota and on overflow calls
`autoEvict` (`src/storage/SessionCacheManager.ts:243`), which loads all session entries,
sorts oldest-first (`:421`), and deletes the oldest
`SESSION_EVICTION_PERCENTAGE = 0.5` (`:80`) → `slice(0, evictCount)` (`:425`) **with no
`customMetadata.kind` filter**. So a later Track 09 persist (or any LLM
`cache_storage_tool` write in the same session) can evict an *earlier* Track 09
`tool_result` entry. For a persistent session, `Session.close()` deliberately keeps these
entries because the rollout still holds the pointer for resume
(`src/core/Session.ts:880-894`) — but `autoEvict` already destroyed the blob. On the
model's `cache_storage_tool {action:'read'}`, the lookup misses and
`CacheToolResultStore.retrieve` returns `null` (`resultStore.ts:196-208,226`) — a dangling
pointer the agent was explicitly instructed to read.

**Fix:** make `SessionCacheManager.autoEvict` skip entries with
`customMetadata.kind === 'tool_result'` (mirror the selective filter
`CacheToolResultStore.cleanup` already uses), or give Track 09 entries an un-evictable flag.

---

## BUG-2 — High: the model can delete/mutate its own persisted-result blob

**Evidence (verified):** Track 09 surfaces the cache `storageKey` verbatim to the model in
the retrieval instruction — `{ "action": "read", "storageKey": "<ref>" }`
(`src/tools/resultStore.ts:132-137`). The same `cache_storage_tool` exposes `delete` and
`update` actions keyed by `storageKey` (`src/tools/StorageTool.ts:494-498`,
`handleDelete:609`, `handleUpdate:644`) with **no guard** rejecting
`customMetadata.kind === 'tool_result'` (grep confirms no `CACHE_TOOL_RESULT`/kind check in
those handlers). A model that "tidies up" a key it saw in a `<persisted-output>` message
permanently removes/alters the blob while the rollout still records the pointer + preview →
later replay/resume read fails exactly as BUG-1.

**Fix:** in `StorageTool.handleDelete` and `handleUpdate`, reject keys whose entry
`customMetadata.kind === CACHE_TOOL_RESULT_KIND` with a clear error ("this key is a
system-managed tool result and cannot be deleted/modified").

---

## BUG-3 — Medium: prod quota manager clears the wrong store under pressure

**Evidence (verified):** production wires `new StorageQuotaManager(cacheManager)` — the
single-arg legacy form, so `tieredEvictor` is `null`
(`src/extension/service-worker.ts:1269`; `StorageQuotaManager.ts:51-53`). On critical quota
the legacy branch runs `cacheManager.cleanup()` then `cacheManager.clear()`
(`StorageQuotaManager.ts:196-212`), but `CacheManager` only touches
`STORE_NAMES.ROLLOUT_CACHE` (`src/storage/CacheManager.ts:135,237-276`). The actual space
consumers — Track 04 `task_output_chunks` and Track 09 `cache_items` — are **never**
reclaimed by the quota manager in prod, while a global storage-pressure event nukes the
unrelated rollout cache (which itself holds Track 09 resume pointers).

This is distinct from Track 29 G3 / Track 32 P5: even with correct tier ordering, the prod
*constructor* never engages tiers, and the legacy fallback actively clears the wrong store.

**Fix:** construct `StorageQuotaManager` in `service-worker.ts` with the options-bag form
including a `TieredEvictor` (tier 0 → `TaskOutputManager`, tier 1 →
`cache_items`/`SessionCacheManager` evictor). Coordinate the exact tier ordering with
**Track 29 G3** and **Track 32 Phase 5** (single shared decision — do not let the three
diverge).

## Validation

- BUG-1: fill a session past quota with mixed `tool_result` + ordinary cache entries →
  assert no `kind:'tool_result'` entry is evicted; a still-referenced persisted result is
  readable.
- BUG-2: model issues `cache_storage_tool {action:'delete', storageKey:<a tool_result key>}`
  → rejected; the blob survives; non-tool-result keys still deletable.
- BUG-3: simulate critical quota → `task_output_chunks`/`cache_items` are the reclaim
  targets; `ROLLOUT_CACHE` (and its Track 09 resume pointers) is not wiped.

## Assessed safe (recorded — do not re-investigate)

- **No namespace collision:** Track 04 uses store `task_output_chunks` (PK
  `${taskId}:${seq}`, `src/core/tasks/TaskOutputStore.ts:34-38`); Track 09 uses
  `cache_items` (PK `${sessionId}_${taskId}_${turnId}`,
  `SessionCacheManager.ts:174-182`) — distinct IndexedDB stores and distinct Rust
  `ALLOWED_COLLECTIONS` tables; each cleanup filters its own store.
- **Truncation relocation consistent:** `getInfinityTools()` and `getPersistenceThreshold`
  derive from the same profile (`src/tools/ToolRegistry.ts:636-645`,
  `src/tools/toolLimits.ts:29-36`); no residual ToolRegistry truncation, no Infinity/50K
  disagreement.
- **Rollout schema:** Track 04 task state is not serialized into the rollout
  (`src/storage/rollout/policy.ts:17-34`); only the verbatim preview is persisted and
  re-applied without re-emitting — Track 04 eviction cannot corrupt the rollout *record*
  (the only resume risk is the dangling-blob read in BUG-1).
