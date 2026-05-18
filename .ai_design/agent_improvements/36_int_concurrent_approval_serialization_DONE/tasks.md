# Track 36 — Tasks

Cross-track integration bug. See `design.md` for evidence (file:line).

## Phase 1 — Per-key serialization in ApprovalGate

- [x] 1.1 Add an in-flight promise map keyed by `buildMemoryKey` in `ApprovalGate.check()`
      (`src/core/approval/ApprovalGate.ts`): first caller does hook + prompt; concurrent
      same-key callers await it, then re-read session memory. Clear entry in `finally`.

## Phase 2 — Validate

- [x] 2.1 Test: 3 concurrent same-key concurrency-safe calls → exactly 1 `PermissionRequest`
      hook fire + 1 prompt; decision (incl. remember) applied to all 3.
- [x] 2.2 Test: distinct-key concurrent calls still prompt independently.
- [x] 2.3 Regression: single/sequential calls unchanged; no added latency on the
      uncontended path.

## Exit criteria

- N concurrent tool calls resolving to the same approval key produce exactly one hook fire
  and one user prompt, with the decision (and "remember") applied to the whole batch; no
  cross-call decision leak (already safe — keep it that way).
