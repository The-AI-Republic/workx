# Track 36 — Integration Defect: Concurrent Tool Calls Race the Approval Gate

Date: 2026-05-15
Status: OPEN — P2 (Medium)
Type: Cross-track integration bug
Tracks involved: [Track 02 Concurrency](../02_tool_metadata_concurrency_DONE/design.md) × [Track 01 Hooks](../01_hook_event_system_DONE/design.md) (approval gate)
Source: cross-track integration audit 2026-05-15, independently re-verified against on-disk source on `agent-improvements`.

## Summary

Track 02's orchestrator runs up to 5 concurrency-safe tool calls truly in parallel. The
approval gate (`ApprovalGate.check()`) has no per-key serialization, so N concurrent calls
that resolve to the **same** approval key each independently miss the session-memory
dedupe, each fire Track 01's `PermissionRequest` hook, and each raise their own
`ApprovalManager` prompt. The user sees interleaved duplicate prompts and a "remember this
decision" from one in-flight call does not short-circuit its concurrent siblings.

## BUG — Medium: no per-key mutex in `ApprovalGate.check()`

**Evidence (verified):**
- `executeBatchConcurrently` runs a refilling worker pool of up to
  `MAX_SAFE_TOOL_CALL_CONCURRENCY = 5` executors with no approval-side coordination
  (`src/core/tools/toolOrchestration.ts:120-133`).
- `ApprovalGate.check()` reads the session-memory dedupe (`sessionMemory.get`,
  `src/core/approval/ApprovalGate.ts:172`) then, on miss, fires the Track 01
  `PermissionRequest` hook (`ApprovalGate.ts:215`) and calls
  `ApprovalManager.requestApproval` (`:256`). There is **no mutex / in-flight map** between
  the read and the eventual write of the remembered decision.

**Bug:** for N concurrent calls with the same `buildMemoryKey`, all N pass the dedupe miss
before any writes it back → the hook fires N times and N prompts are raised in parallel
instead of one. `rememberDecision` from the first to resolve never short-circuits the others
(they already passed the check). User-visible effect: duplicate/interleaved approval prompts
for what is logically one decision. Exposure is bounded — only `isConcurrencySafe` tools
batch concurrently — but concurrency-safe DOM *read* actions can still produce same-key
duplicates.

**Not a security leak (recorded):** `ApprovalManager` keys pending requests by a unique
random `id` (`ApprovalGate.ts:233`, `src/core/ApprovalManager.ts:138`) and each
`PendingApproval` has its own resolver (`ApprovalManager.ts:141`); `handleDecision` resolves
only the matching id (`:191`). One concurrent call's approve/deny **cannot** resolve
another's promise — so no cross-call decision leak. The defect is duplicate prompting +
ineffective dedupe under concurrency, not authorization bypass.

## Fix

Serialize `ApprovalGate.check()` per approval key with an in-flight promise map: the first
caller for a given `buildMemoryKey` performs the hook + prompt; concurrent callers for the
same key await that single in-flight decision and then re-read the (now-written) session
memory. Clear the map entry in `finally`. This collapses N duplicate prompts to one and
makes `rememberDecision` effective across a concurrent batch. Add a test: 3 concurrent
same-key calls → exactly one `PermissionRequest` hook fire and one prompt; the decision
applies to all three.

## Validation

- Test: 3 concurrent concurrency-safe calls with the same approval key → 1 hook fire, 1
  prompt, decision (incl. "remember") applied to all 3; distinct-key concurrent calls still
  prompt independently.
- Regression: sequential calls and single calls behave exactly as before (no added latency
  on the uncontended path).
