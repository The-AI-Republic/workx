# Track 33 — Tasks

Cross-track integration bug. See `design.md` for evidence (file:line).

## Phase 1 — Decide fix shape

- [ ] 1.1 Choose: minimal (route A calls `maybeEnforceTier2` for the single call, preserves
      Track 11's flag-off byte-for-byte guarantee) vs structural (always fold single
      `function_call` into the buffered route C; 2 routes instead of 3, needs its own QA).
      Recommend minimal first; structural as a separate follow-up if drift recurs.

## Phase 2 — Implement (minimal)

- [ ] 2.1 In `TurnManager.handleResponseItem` `function_call` branch (`:659-672`), route the
      result through tier-2: wrap as one-element `[result]`/`[prepared]` and
      `return (await this.maybeEnforceTier2(...))[0]`.

## Phase 3 — Validate

- [ ] 3.1 Unit test: N sequential `function_call` items, each under per-tool threshold but
      aggregate over `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` → route A enforces tier-2
      identically to B/C.
- [ ] 3.2 Regression: under-budget single-call path unchanged (no behaviour change in the
      common case); confirm no-op when no result store (Track 32 not yet wired).

## Exit criteria

- All three tool-exec routes apply Track 09 tier-2 aggregate enforcement identically,
  independent of provider and the `parallelToolCalls` flag state.
