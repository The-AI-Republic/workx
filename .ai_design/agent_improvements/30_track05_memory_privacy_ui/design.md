# Track 30 — Session Memory Privacy UI (follow-up to Track 05)

Date: 2026-05-15
Status: OPEN — P2
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
2. Reconcile the core-memory cap: either raise it toward the designed budget or record the
   8k-char decision (G2).

## Non-goals

- Auto-extraction / compaction interlock — owned by Track 05b (PR #206) and its follow-up
  Track 31. Not in scope here.
- Changing the memory storage format or the LLM save/search/forget model.

## Approach

- **G1**: surface, in `MemorySettings.svelte`, a read-only view of current core memory plus
  recent daily files (read via the existing `MemoryService`/`MemoryFileSystem` APIs;
  `RepublicAgent.ts:384-387` already exposes the prompt-extension path — reuse the read
  surface, do not re-implement file IO). Add a guarded "Clear all memory" action calling the
  existing forget/clear primitives (`MemoryService.ts:148-176`,
  `DailyMemoryStore.removeEntries`, `CoreMemoryManager.removeFacts`) with a confirm dialog.
  Honor the off-by-default and extension-build-excluded constraints (panel hidden when memory
  service is null on extension).
- **G2**: pick one — raise the cap to the designed budget, or add a short note to *this*
  doc recording 8k chars as the intended value (Track 05's doc stays untouched per the
  user's rule). Recommend: keep 8k (token-cost conscious), record the decision.

## Risks

- A "clear all" must be irreversible-by-confirmation only; never auto-clear. Make the
  destructive action explicit and confirmed.
- Viewing memory must not leak when memory is disabled / on extension builds (service null).

## Validation

- G1: with memory enabled (desktop), the settings panel shows current core memory and
  recent daily entries; "Clear all" (after confirm) empties them and the next prompt no
  longer injects the cleared facts. On extension build the panel is absent.
- G2: a test/document asserting the effective core-injection cap matches the recorded value.

## Open questions

1. Should the view be read-only, or also allow per-entry deletion (finer-grained than
   clear-all)? Recommend read-only + clear-all for v1; per-entry later if asked.
