# Track 30 — Tasks

Follows up [Track 05](../05_session_memory_DONE/design.md). See `design.md` for gap evidence.

## Phase 1 — Memory view + clear UI (G1)

- [x] 1.1 Add a read-only "Current memory" panel to `MemorySettings.svelte` showing core
      memory + recent daily entries from a bounded snapshot service API.
- [x] 1.2 Add `MemoryService.getSnapshot()` and `MemoryService.clearAll()`; clear core and
      daily memory, then refresh the global context cache.
- [x] 1.3 Expose snapshot/clear through the existing desktop/server UI service-request bridge;
      do not read memory files directly from the Svelte component.
- [x] 1.4 Add a confirmed "Clear all memory" action in the UI.
- [x] 1.5 Hide the panel when memory is disabled / on extension builds (service null).
- [x] 1.6 Test: view renders; clear (after confirm) empties memory and stops injection;
      panel absent on extension build.

## Phase 2 — Core-memory cap reconciliation (G2)

- [x] 2.1 Keep `MAX_CORE_MEMORY_CHARS = 8000` as the intended v1 cap.
- [x] 2.2 Add/adjust a test or nearby code comment asserting the 8000-char cap is deliberate.

## Exit criteria

- Users can view and clear their stored memory from settings (desktop), respecting
  off-by-default and extension-exclusion constraints.
- The effective core-injection cap is documented and matches code.
