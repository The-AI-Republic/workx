# Track 37 — Tasks

Cross-track integration / coexistence bug. See `design.md` for evidence (file:line).

## Phase 1 — BUG-1 (High): kind-aware session eviction

- [x] 1.1 `SessionCacheManager.autoEvict` skips `customMetadata.kind === 'tool_result'`
      entries (mirror `CacheToolResultStore.cleanup`'s filter), or add an un-evictable flag.
- [x] 1.2 Test: session over quota with mixed entries → no `tool_result` evicted; a
      referenced persisted result stays readable.

## Phase 2 — BUG-2 (High): protect persisted results from model delete/update

- [x] 2.1 `StorageTool.handleDelete` + `handleUpdate` reject keys whose entry
      `customMetadata.kind === CACHE_TOOL_RESULT_KIND` with a clear error.
- [x] 2.2 Test: model `delete`/`update` on a tool_result key → rejected, blob survives;
      ordinary keys still deletable.

## Phase 3 — BUG-3 (Med): quota manager targets the real consumers

- [x] 3.1 Construct `StorageQuotaManager` (service-worker.ts:1269) with the options-bag +
      `TieredEvictor` (tier0 `TaskOutputManager`, tier1 `cache_items`/`SessionCacheManager`).
- [x] 3.2 **Coordinate tier ordering with Track 29 G3 and Track 32 Phase 5** — one shared
      decision, recorded in all three docs.
- [x] 3.3 Test: critical quota reclaims `task_output_chunks`/`cache_items`, not
      `ROLLOUT_CACHE`.

## Exit criteria

- A referenced Track 09 persisted result is never silently evicted or model-deleted while
  its rollout/replay pointer still exists.
- Storage-pressure reclamation targets the actual large stores, not the rollout cache.
- The TieredEvictor tier ordering is identical across Tracks 29 G3 / 32 P5 / 37 (no drift).
