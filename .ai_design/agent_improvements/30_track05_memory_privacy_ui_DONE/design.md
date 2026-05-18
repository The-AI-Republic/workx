# Track 30 — Session Memory Privacy UI (follow-up to Track 05)

Date: 2026-05-15
Status: DONE — P2 (implemented 2026-05-18)
Follows up: [Track 05 — Session Memory](../05_session_memory_DONE/design.md) (shipped PR #167)
Audit source: design-vs-implementation audit 2026-05-15 (independently verified against source on `agent-improvements`; re-verified 2026-05-18 on `origin/agent-improvements` at `cd1e339e`; re-verified after pull 2026-05-18 on `origin/agent-improvements` at `e9bbff26`)

> Follow-up track. Track 05's design doc is **not** modified. Track 05's shipped scope
> (LLM-controlled save/search/forget, daily + core memory, prompt injection, off-by-default,
> extension build excluded) is fully implemented. The original automatic-extraction
> architecture in Track 05's Phases 1-4 was explicitly deferred to **Track 05b** by Track 05's
> own design — that is **not** a gap here (Track 05b shipped via PR #206, audited separately).

## Verified gaps

### G1 — No in-UI view/clear of stored memory (privacy requirement)

Track 05's design *Risks* section (privacy) calls for users to view/clear their memory.
`src/webfront/.../MemorySettings.svelte` exposes only the enable toggle and API-key controls
(lines ~157-226); there is no "view current memory" panel and no "clear all memory" action.
Today a user can only inspect or delete memory by manually editing files under
`~/.airepublic-pi/memory/`. For a privacy-sensitive feature this is the one real gap.

### G2 — Core-memory injection cap diverges from design (minor, document or align)

Track 05 design states a ~12k-token core-memory injection budget; the implementation caps
core memory at ~8000 chars (~2k tokens) (`MemoryService.ts:27,119-121`), and topical search
results are uncapped per-fact. No functional risk, but design and code disagree.

## Goals

1. Add a memory **view** panel and a **clear-all** action to `MemorySettings.svelte`,
   satisfying Track 05's privacy requirement (G1).
2. Reconcile the core-memory cap by recording the implemented 8k-char cap as the intended
   v1 behavior (G2).

## Implementation decisions locked 2026-05-18

1. **V1 is read-only view + clear-all.** Do not add per-entry editing/deletion in this track.
   The privacy requirement is satisfied by visibility plus a confirmed full clear.
2. **Keep the 8k-character core-memory cap.** The implemented cap is intentionally
   token-cost conscious and safer than the older 12k-token design target. Record the 8k-char
   value here as the intended behavior; do not edit Track 05's shipped design doc.
3. **UI talks through a narrow service API.** `MemorySettings.svelte` should not perform
   direct filesystem traversal. Add a small desktop/server-only memory service request API
   returning a sanitized snapshot and supporting confirmed clear-all.

## Non-goals

- Auto-extraction / compaction interlock — owned by Track 05b (PR #206) and its follow-up
  Track 31. Not in scope here.
- Changing the memory storage format or the LLM save/search/forget model.

## Approach

- **G1**: add `MemoryService.getSnapshot()` returning `{ enabled, coreMemory, dailyFiles }`
  with bounded daily-file count and bounded per-file preview, and `MemoryService.clearAll()`
  that clears core memory and all daily memory files then refreshes the global context cache.
  Expose those through the existing UI client/service-request bridge for desktop/server.
  `MemorySettings.svelte` renders the read-only snapshot and a confirmed destructive
  "Clear all memory" action. Honor the off-by-default and extension-build-excluded
  constraints (panel hidden when memory service is null on extension).
- **G2**: add a short code/doc assertion that `MAX_CORE_MEMORY_CHARS = 8000` is the intended
  cap for v1.

## Risks

- A "clear all" must be irreversible-by-confirmation only; never auto-clear. Make the
  destructive action explicit and confirmed.
- Viewing memory must not leak when memory is disabled / on extension builds (service null).

## Validation

- G1: with memory enabled (desktop), the settings panel shows current core memory and
  recent daily entries; "Clear all" (after confirm) empties them and the next prompt no
  longer injects the cleared facts. On extension build the panel is absent.
- G2: a test/document asserting the effective core-injection cap is 8000 chars.
