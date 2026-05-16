# Track 27 — Tool Progress UX & Sibling Abort Activation (follow-up to Track 02)

Date: 2026-05-15
Status: OPEN — P1/P2
Follows up: [Track 02 — Tool Metadata & Concurrency](../02_tool_metadata_concurrency_DONE/design.md) (shipped PR #197)
Audit source: design-vs-implementation audit 2026-05-15 (independently verified against source on `agent-improvements`)

> Follow-up track. Track 02's design doc is **not** modified. Track 02's metadata model,
> registry helpers, concurrency orchestrator, MCP hints, and event-ownership all shipped
> correctly and completely. These are the design-promised items left inert.

## Verified gaps

### G1 — Progress UX pipeline is plumbed but dead

Track 02 designed: tools emit lightweight progress via `options.onProgress`, plus an initial
activity event via `getActivityDescription()`, with UI categorization. The pipeline exists
(`ToolRegistry.ts:436-468` wraps the callback and emits `ToolExecutionProgress`;
`ToolExecutionProgressEvent` is wired through events/scope/agent-events/ServerChannel) but:

- **No tool calls `options.onProgress`** — grep across `src/extension/tools/` and `src/tools/`
  finds zero invocations. The designed emitters (`DOMTool`, `NavigationTool`,
  `WebScrapingTool`, `PageVisionTool`) emit nothing.
- **No initial activity event** — `getActivityDescription()` is only called by its own helper
  (`ToolRegistry.ts:611`); no caller emits an initial activity/categorization event.

The entire progress UX is inert dead code: users see no per-tool progress.

### G2 — Sibling abort propagation absent

Track 02 designed per-batch `AbortController` propagation: when one concurrent tool call in a
parallel batch fails/denies, in-flight siblings are cancelled and given synthetic errors. No
`AbortController`/abort plumbing exists in `toolOrchestration.ts`, `TurnManager.ts`, or
`BaseTool.ts`. A failing call in a parallel batch only produces its own error output;
siblings keep running to completion.

### G3 — `data_extraction` bound-tab fix unmet (exit criterion)

Track 02's exit criterion: `data_extraction` should use the bound session tab (not
`chrome.tabs.query({active:true})`) and then be marked concurrency-safe. The tool still
queries the active tab (`DataExtractionTool.ts:213,248,284,358`). The fallback is correctly
honored — it stays `isConcurrencySafe: () => false`
(`registerExtensionTools.ts:245`) — so this is not a correctness bug, but the promised fix
(and the resulting parallelizability) never landed.

## Goals

1. Activate the progress UX: have the designed tools emit `onProgress`, emit the initial
   activity event, and surface progress/categorization in the UI (G1).
2. Implement per-batch sibling abort with synthetic errors for cancelled siblings (G2).
3. Land the `data_extraction` bound-tab fix and then mark it concurrency-safe (G3).

## Non-goals

- The Track 02 metadata model / orchestrator / MCP hints — shipped correctly, untouched.
- Provider `parallel_tool_calls` flag — owned by Track 11 (shipped).

## Approach

- **G1**: thread `options.onProgress` calls into the long-running tools at natural
  checkpoints (navigation lifecycle, DOM capture phases, scrape page count, vision stages).
  Emit one initial activity event from the execution entry using `getActivityDescription()`,
  and ensure the sidepanel categorizes/render progress (event already reaches
  `ServerChannel`). Keep emissions throttled to avoid event spam.
- **G2**: add an `AbortSignal` to `ToolExecutionRequest`/`ToolContext`; the orchestrator
  creates one `AbortController` per batch, aborts it on the first failure/denial, and
  synthesizes error outputs for siblings that were cancelled. Tools that can honor
  cancellation should check the signal; tools that cannot still get a synthetic error so the
  transcript is consistent.
- **G3**: change `DataExtractionTool` to resolve the bound session tab id (the same source
  Track 26 G2 / Track 02 use for the bound tab) instead of `tabs.query({active:true})`; once
  it no longer depends on global active-tab state, flip its registration to
  `isConcurrencySafe: () => true` with a test proving two concurrent extractions on distinct
  tabs don't interfere.

## Risks

- **G2** is the riskiest: aborting mid-tool can leave partial side effects (a half-typed
  form). Only auto-abort *concurrency-safe* siblings (read-only by classification); never
  cancel an in-flight unsafe/mutating sibling — let it finish, then report the batch error.
  This must be explicit in the orchestrator.
- **G1** event spam — throttle and cap progress emissions.
- **G3** changing concurrency classification is behavior-affecting — gate behind the existing
  test matrix and Track 11's opt-in `parallelToolCalls` flag (still dark by default).

## Validation

- G1: integration — a navigation + scrape sequence emits ordered progress events the
  sidepanel renders; initial activity event present; emission count bounded.
- G2: orchestrator test — batch of 2 safe + 1 failing call → safe siblings receive
  cancellation/synthetic error on first failure; an unsafe sibling is **not** cancelled.
- G3: test — two concurrent `data_extraction` calls on different bound tabs return correct
  independent results; classification is now `safe`.

## Open questions

1. G2: exact cancellation contract per tool — which tools can truly honor `AbortSignal` vs
   only receive a synthetic error? Enumerate before implementing.
2. G3: does any caller rely on `data_extraction` reading the *active* tab rather than the
   bound tab? Audit callers before changing tab resolution.
