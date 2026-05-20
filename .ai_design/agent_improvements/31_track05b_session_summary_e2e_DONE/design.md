# Track 31 — Session Summary E2E Coverage & Flag Reconciliation (follow-up to Track 05b)

Date: 2026-05-15
Status: DONE — P2 (implemented 2026-05-18)
Follows up: [Track 05b — Auto-Extraction & Compaction Interlock](../05b_auto_extraction_compaction_interlock_DONE/design.md) (shipped PR #206)
Audit source: design-vs-implementation audit 2026-05-15 (independently verified against source on `agent-improvements`; re-verified 2026-05-18 on `origin/agent-improvements` at `cd1e339e`; re-verified after pull 2026-05-18 on `origin/agent-improvements` at `e9bbff26`)

> Follow-up track. Track 05b's design doc is **not** modified. Track 05b's mechanism
> (post-turn trigger, prompt injection, and compaction interlock with hard 15s/60s escapes)
> genuinely shipped. As of Track 41, extraction now runs through the shadow-agent scheduler
> instead of the old quiet background sub-agent path. These are the residual follow-ups.

## Verified gaps

### G1 — End-to-end test missing (full loop never exercised together)

Track 05b design §13/§14 specified an E2E test (`tests/e2e/sessionSummary.e2e.test.ts`).
The `tests/e2e/` directory still does not exist. Track 41 added stronger coverage around the
new shadow path:

- `SessionSummaryHook.test.ts` exercises scheduler invocation, in-flight guarding, detach
  suppression, and manual extraction cache refresh.
- `compact/__tests__/extractionInterlock.test.ts` exercises compaction waiting for
  extraction and folding a non-empty summary into the compaction prompt.
- `ShadowAgentRunner` / `ShadowAgentScheduler` tests cover the runtime substrate.

That is materially better than the original isolated mocks, but still not the full
extractor → real `summary.md` write → interlock → fold-into-compaction loop in one harness
against a real `MemoryFileSystem`.

### G2 — Feature-flag location diverges from design (minor)

Track 05b design §15 specified gating via `MemoryConfig.sessionSummary?: { enabled }`.
Implementation gates via `preferences.sessionSummaryEnabled` (`src/config/types.ts:347`,
`RepublicAgent.ts:327-338`); `MemoryConfig` (`src/core/memory/types.ts:49`) has no
`sessionSummary` field. Functionally equivalent (gate works, defaults off) but the config
shape disagrees with the design.

## Goals

1. Add an end-to-end (or heavier integration) test that drives the full Track 05b loop once,
   together, against a real `MemoryFileSystem` (G1).
2. Reconcile the feature-flag location: relocate under `MemoryConfig.sessionSummary` to match
   design §15, or record `preferences.sessionSummaryEnabled` as the accepted decision (G2).

## Non-goals

- Re-testing the units already covered (utils, lifecycle, fileStore, truncate, shadow
  scheduler, interlock, post-turn hook) — those exist and pass.
- Any change to the interlock semantics — verified correct.

## Approach

- **G1**: build a synthetic multi-turn session that exceeds the 15k-token trigger, run the
  post-turn hook, assert `summary.md` is written and differs from the empty template, then
  trigger a compaction and assert it blocks on the in-flight extraction and folds the summary
  hint (`compact_with_summary` / `<session_summary>` wrap). Prefer a Node integration harness
  with a real `MemoryFileSystem` + mocked model client over a full browser fixture, so it can
  run in CI without a browser.
- **G2**: decide relocate vs document. If relocate: add `sessionSummary?: { enabled }` to
  `MemoryConfig` (`src/core/memory/types.ts`), read it in `RepublicAgent.ts:327-338`, keep a
  back-compat read of `preferences.sessionSummaryEnabled` if any stored config uses it. If
  document: record the `preferences` location as the accepted decision in *this* doc (Track
  05b's doc stays untouched per the user's rule).

## Risks

- An E2E that depends on real model output is flaky — mock the extractor model client
  deterministically; only the file/interlock/fold path needs to be real.
- A flag relocation could orphan an existing user setting — include a back-compat read.

## Validation

- G1: the new test exercises trigger → extract → `summary.md` write → compaction interlock
  wait → summary folded, against a real `MemoryFileSystem`, deterministically in CI.
- G2: flag resolves correctly from whichever location is chosen; defaults off; back-compat
  path covered if relocated.

## Open questions

1. G1: Node integration harness vs true browser E2E — recommend Node harness for CI
   determinism; revisit if a browser-only seam is discovered.
2. G2: is `preferences.sessionSummaryEnabled` already persisted in any shipped user config?
   If yes, relocation must migrate it (coordinate with Track 19 migration framework if/when
   that lands).

## Implementation decision

Implemented with the Node integration harness. The active flag location remains
`preferences.sessionSummaryEnabled`; this is the accepted v1 shape because it is a user-visible
settings toggle, defaults off, and already has runtime wiring coverage. No `MemoryConfig`
relocation was performed.
