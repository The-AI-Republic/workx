# Track 31 — Tasks

Follows up [Track 05b](../05b_auto_extraction_compaction_interlock_DONE/design.md). See `design.md` for gap evidence.

## Phase 1 — End-to-end loop test (G1)

- [x] 1.1 Build a Node integration harness: real `MemoryFileSystem`, deterministic mocked
      extractor model client, synthetic multi-turn session > 15k tokens.
- [x] 1.2 Assert post-turn hook triggers extraction; `summary.md` written and ≠ empty
      template.
- [x] 1.3 Trigger compaction; assert it blocks on in-flight extraction (hard 15s/60s
      escapes) and folds the summary (`<session_summary>` wrap / `compact_with_summary`).
- [x] 1.4 Ensure it runs in CI without a browser.

## Phase 2 — Feature-flag reconciliation (G2)

- [x] 2.1 Decide relocate vs document.
- [ ] 2.2a Relocate: add `MemoryConfig.sessionSummary?: { enabled }`
      (`src/core/memory/types.ts`); read in `RepublicAgent.ts:327-338`; back-compat read of
      `preferences.sessionSummaryEnabled`.
- [x] 2.2b Document: record `preferences.sessionSummaryEnabled` as accepted in *this* doc
      (do not edit Track 05b).
- [x] 2.3 Test: flag resolves from the chosen location; defaults off; back-compat covered.

Decision: keep `preferences.sessionSummaryEnabled` as the accepted v1 flag location.
It lives with the other user-visible settings toggles, defaults off, and existing
`RepublicAgent` coverage verifies the absent/false path and extension-build no-op. No
`MemoryConfig` relocation is required for this follow-up.

## Exit criteria

- The full trigger → extract → write → interlock → fold loop is exercised once together
  against a real `MemoryFileSystem`, deterministically in CI.
- The feature-flag location is consistent between code and the active design record.
