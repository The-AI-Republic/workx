# Track 33 — Integration Defect: Tier-2 Budget Skipped on the Legacy Tool-Exec Route

Date: 2026-05-15
Status: DONE — fixed 2026-05-18
Type: Cross-track integration bug
Tracks involved: [Track 09 Tool Result Persistence](../09_tool_result_persistence_DONE/design.md) × [Track 11 Parallel Tool Calls](../11_parallel_tool_calls_DONE/design.md) × [Track 02 Concurrency](../02_tool_metadata_concurrency_DONE/design.md)
Source: cross-track integration audit 2026-05-15, independently re-verified against on-disk source on `agent-improvements`; re-verified 2026-05-18 on `origin/agent-improvements` at `cd1e339e`; re-verified after pull 2026-05-18 on `origin/agent-improvements` at `e9bbff26`.

## Summary

There are **three** tool-execution routes in `TurnManager`. Track 09's tier-2 *per-turn
aggregate* budget enforcement was added to two of them but **not** the legacy single-call
route — which is the **default path** for OpenAI-Responses and xAI (the most common
providers) when `parallelToolCalls` is off (the default). The other Track-09/Track-01/Track-02
behaviours are consistent across all three routes; this is the only inconsistency, but it is
a real correctness/safety gap.

## The three routes (verified)

- **Route A — legacy single-call:** `TurnManager.handleResponseItem`, `function_call`
  branch — `const result = await this.executeToolCall(...); return result;`
  (`src/core/TurnManager.ts:659-672`). Used for OpenAI-Responses/xAI `function_call` items
  when `parallelToolCalls` is **off (default)**.
- **Route B — orchestrator (unified `message`+`tool_calls[]`):**
  `handleResponseItem:689-729`, calls `maybeEnforceTier2` at `:722`.
- **Route C — buffered/parallel:** `executeBufferedToolCalls`, calls `maybeEnforceTier2` at
  `:1004`.

All three converge on `executeToolCall` for per-call Track-01 hooks + Track-09 **tier-1**
persistence, and on `ToolRegistry.execute()` for Track-02 lifecycle events — those are
consistent. The divergence is **tier-2 only**.

## BUG — Resolved 2026-05-18: Route A now reaches tier-2 aggregate enforcement

**Original evidence:** `maybeEnforceTier2` was defined at `TurnManager.ts:1013` and invoked
only from route B (`:722`) and route C (`:1004`). Route A (`:659-672`) returned the
`executeToolCall` result verbatim with no tier-2 call.

**Impact:** Track 09 defines two tiers — tier-1 (per-result, applied in `executeToolCall`)
and tier-2 (per-turn aggregate cap, `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`,
`src/tools/toolLimits.ts:14`). On the **default** configuration, an OpenAI-Responses/xAI
turn that emits several sequential `function_call` items routes each through route A. Each
result can individually pass tier-1 (e.g. 5 × ~45K DOM snapshots, each under the 50K
per-tool threshold) while their **aggregate (~225K) exceeds the 200K per-turn budget and is
never enforced**. The identical multi-call workload routed through B or C *is* capped. So
context-flooding protection silently disappears for the default flag state on the most
common providers — a provider/flag-dependent inconsistency that is security-adjacent
(unbounded context growth → cost, latency, truncation of system/safety content).

This is **independent of Track 32** (the SessionServices-injection follow-up):
`maybeEnforceTier2` itself no-ops when no store is present
(`TurnManager.ts:1017-1019`), so adding the call to route A is safe even when persistence is
disabled, and becomes effective once Track 32 wires the store.

## Fix shipped

Route A still executes immediately when `parallelToolCalls` is off, preserving Track 11's
flag-off execution behavior. At `Completed`, `TurnManager` now collects all immediate legacy
`function_call_output` responses from that model response and calls `maybeEnforceTier2` once
over the aggregate. This is stricter than the original one-element minimal sketch because it
actually catches the documented "5 × 45K" aggregate overflow case.

## Validation

- Unit test: a synthetic turn with N sequential `function_call` items whose individual
  results pass tier-1 but whose aggregate exceeds `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` →
  assert route A now enforces tier-2 identically to routes B and C.
- Regression: flag-off single-call path still returns an un-enforced result when the
  aggregate is *under* budget (no behaviour change in the common case).

## Assessed safe (recorded)

PreToolUse/PostToolUse/PostToolUseFailure (incl. block + `updatedInput`/`updatedOutput`
merge), ToolRegistry-as-sole-event-owner, and tier-1 persistence are **consistent across all
three routes** because every route funnels through the single `executeToolCall` body
(`TurnManager.ts:776-909`) and `ToolRegistry.execute()`. No defect there.
