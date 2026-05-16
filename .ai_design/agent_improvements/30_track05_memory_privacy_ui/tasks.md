# Track 30 — Tasks

Follows up [Track 05](../05_session_memory_DONE/design.md). See `design.md` for gap evidence.

## Phase 1 — Memory view + clear UI (G1)

- [ ] 1.1 Add a read-only "Current memory" panel to `MemorySettings.svelte` showing core
      memory + recent daily entries, via existing `MemoryService`/`MemoryFileSystem` reads.
- [ ] 1.2 Add a confirmed "Clear all memory" action calling existing forget/clear primitives
      (`MemoryService.ts:148-176`, `DailyMemoryStore.removeEntries`,
      `CoreMemoryManager.removeFacts`).
- [ ] 1.3 Hide the panel when memory is disabled / on extension builds (service null).
- [ ] 1.4 Test: view renders; clear (after confirm) empties memory and stops injection;
      panel absent on extension build.

## Phase 2 — Core-memory cap reconciliation (G2)

- [ ] 2.1 Decide: raise cap toward designed budget, or record 8k-char as intended.
- [ ] 2.2 Apply the decision (code change or a note in *this* doc; do not edit Track 05).

## Exit criteria

- Users can view and clear their stored memory from settings (desktop), respecting
  off-by-default and extension-exclusion constraints.
- The effective core-injection cap is documented and matches code.
