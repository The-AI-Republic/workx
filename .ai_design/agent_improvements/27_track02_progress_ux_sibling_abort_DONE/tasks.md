# Track 27 — Tasks

Follows up [Track 02](../02_tool_metadata_concurrency_DONE/design.md). See `design.md` for gap evidence.

## Phase 1 — Activate progress UX (G1)

- [x] 1.1 Pass an `onProgress` callback from `TurnManager.executeBrowserTool()` into
      `ToolRegistry.execute`; verify `ToolRegistry` emits `ToolExecutionProgress`.
- [x] 1.2 Emit one initial activity event via `getActivityDescription()` at tool execution
      entry; ensure UI categorization consumes it.
- [x] 1.3 Call `options.onProgress` at checkpoints in `NavigationTool`, `DOMTool`,
      `WebScrapingTool`, `PageVisionTool`; throttle/cap emissions.
- [x] 1.4 Sidepanel renders progress for a running tool.
- [x] 1.5 Integration test: navigation+scrape emits ordered, bounded progress events.

## Phase 2 — Sibling abort (G2)

- [x] 2.1 Add `AbortSignal` to `ToolExecutionRequest`/`ToolContext`.
- [x] 2.2 Orchestrator: one `AbortController` per batch; abort on first failure/denial;
      synthesize errors for cancelled siblings.
- [x] 2.3 Only cancel concurrency-safe (read-only) siblings; never cancel an in-flight
      unsafe/mutating sibling — let it finish, then report batch error.
- [x] 2.4 Enumerate per-tool cancellation contract (honor signal vs synthetic-error-only).
- [x] 2.5 Orchestrator test: 2 safe + 1 failing → safe siblings cancelled, unsafe not.

## Phase 3 — data_extraction bound-tab fix (G3)

- [x] 3.1 Audit callers for active-tab dependence.
- [x] 3.2 Replace `tabs.query({active:true})` with bound session tab in
      `DataExtractionTool.ts:213,248,284,358`.
- [x] 3.3 Flip registration to `isConcurrencySafe: () => true`
      (`registerExtensionTools.ts:245`).
- [x] 3.4 Test: two concurrent extractions on distinct bound tabs are independent.

## Implementation notes

- Progress events are bounded to entry/checkpoint/completion/failure events; no polling loop
  was introduced.
- Cancellation contract: concurrent safe batches receive one shared `AbortSignal`; tools may
  honor it if they support cooperative cancellation, and the orchestrator still emits a
  synthetic cancelled result for siblings that finish after the batch was aborted. Unsafe
  batches execute sequentially and receive no batch abort signal.

## Exit criteria

- Users see per-tool progress + initial activity in the sidepanel.
- A failing call in a parallel batch cancels safe siblings (synthetic errors), leaves unsafe
  siblings to finish.
- `data_extraction` uses the bound tab and is concurrency-safe.
