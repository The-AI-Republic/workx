# Track 29 — Background Task Delivery: events + UI + production eviction (follow-up to Track 04)

Date: 2026-05-15
Status: OPEN — P1 (feature built but not delivered to the user)
Follows up: [Track 04 — Typed Task Families](../04_typed_task_families_DONE/design.md) (shipped PR #205)
Audit source: design-vs-implementation audit 2026-05-15 (independently verified against source on `agent-improvements`; re-verified 2026-05-18 on `origin/agent-improvements` at `cd1e339e`; re-verified after pull 2026-05-18 on `origin/agent-improvements` at `e9bbff26`)

> Follow-up track. Track 04's design doc is **not** modified. This captures the Track 04
> commitments PR #205 did not deliver, verified against on-disk source.

## Why this track exists

Track 04's core/storage/concurrency layers are real and solid (type model, `TaskOutputStore`,
`TaskOutputManager`, `StorageQuotaManager`, the `Session` concurrency seam removing
abort-on-spawn). But the **entire event + UI delivery path is non-functional**, and the
production eviction wiring is absent. PR #205's own body conceded items were "UI unverified"
and "mount points not wired"; those gaps were never closed. The feature exists internally but
the user can never see a background task and tier-0 task-output eviction never runs in the
shipped extension.

## Verified gaps

### G1 — The 4 background-task events are never emitted or routed

`BackgroundTaskStarted`, `BackgroundTaskOutputDelta`, `BackgroundTaskStateChanged`,
`BackgroundTaskTerminated` are declared (`events.ts:119-122`) and listed in
`SubAgentEventRouter.ts:24` suppression, but a grep for real emit sites and
`ThreadEventRouter` handlers returns **zero** results. The badge/store has no live data
source.

### G2 — UI never mounted; polling never started; hook file missing

- `BackgroundTasksBadge.svelte` exists but no `.svelte` file imports/mounts it (only a
  comment reference in `BackgroundTaskPanel.svelte:5`).
- `startBackgroundTaskPolling()` is defined (`backgroundTaskStore.ts:61`) but has no caller.
- `usePolledTaskOutput.ts` does not exist — `src/webfront/lib/hooks/` directory is absent.

### G3 — Production `TieredEvictor` not wired

`StorageQuotaManager` now has options-bag / tiered-evictor support, but production
`service-worker.ts` still constructs `new StorageQuotaManager(cacheManager)` with **no**
`tieredEvictor`; `TaskOutputManager`/`TaskOutputStore` are not imported in the service
worker. The tier-0 (task-output) eviction path designed in Track 04 is still unreachable in
the shipped extension.

### G4 — Q7 approval handling drops resolvers instead of denying (hang risk)

Track 04 design Q7 Step 1 requires aborted tasks to resolve pending approvals with an
explicit `'denied'` so the awaiting tool call unwinds. `Session.ts:1701-1707` calls
`activeTurn.clearPending()` (drops resolvers) instead — the awaiting tool call is left
hanging, the exact failure the design forbids.

### G5 — `<output-offset>` notification is dead code

`SubAgentRunner.ts:674` reads `taskState.outputOffset`, but that field is never assigned
anywhere (always 0), so the `<output-offset>` notification segment is never meaningfully
emitted.

### G6 — Designed behavioral tests were never written

~11 designed test files (concurrency-seam, spawn-replacement, background-isolation,
eviction, handle-task-abort, tab-close, notification-format, quota-eviction, engine
integration) are absent; only `tasks/__tests__/{types,TaskOutputStore}.test.ts` exist. These
tests gate the highest-risk Track 04 change (removing unconditional abort-on-spawn).

## Goals

1. Emit and route the 4 background-task events from the real `Session`/`SubAgentRunner`
   lifecycle transitions into `backgroundTaskStore` (G1).
2. Mount `BackgroundTasksBadge` in the chat top-bar, bootstrap polling, and add the missing
   `usePolledTaskOutput` hook (G2).
3. Wire a concrete `TieredEvictor` (tier0 = `TaskOutputManager`, tier1 = cache) into the
   production `StorageQuotaManager` in `service-worker.ts` (G3).
4. Fix Q7: resolve pending approvals `{ decision: 'denied' }` per task instead of
   `clearPending()` (G4).
5. Fix or remove the `<output-offset>` path (G5).
6. Add the designed behavioral tests (G6).

## Non-goals

- Phase-2 task families, `TaskRegistry`, `injectUserInput`, restart recovery, Track-06
  coordination — Track 04 design explicitly defers these.

## Approach

- **G1**: emit `BackgroundTaskStarted` at typed-task registration, `StateChanged` on status
  transitions, `OutputDelta` at `TaskOutputStore` append anchors, `Terminated` from the
  termination path (success **and** abort/failure). Add `ThreadEventRouter` handlers that
  dispatch into `backgroundTaskStore`. Keep them on the `SubAgentEventRouter` suppression
  list (so they don't leak into the main transcript) — they route only to the badge store.
- **G2**: import `BackgroundTasksBadge` into the chat top-bar component; call
  `startBackgroundTaskPolling(getEngine)` on chat-page mount; create
  `src/webfront/lib/hooks/usePolledTaskOutput.ts` per Track 04's contract.
- **G3**: in `service-worker.ts`, construct `TaskOutputStore` + `TaskOutputManager`, build a
  `TieredEvictor` (tier0 → `TaskOutputManager`, tier1 → existing cache), and pass
  `{ cacheManager, tieredEvictor }` to `StorageQuotaManager`.
- **G4**: in `Session.ts:1701-1707`, replace `clearPending()` with per-task resolution of
  pending approvals to `{ decision: 'denied' }` so awaiters unwind deterministically.
- **G5**: assign `TaskOutputStore` `lastSeq` into `taskState.outputOffset` at the
  termination/serialization point (e.g. in `markTypedTaskTerminated`) — or delete the dead
  `<output-offset>` branch if the notification format no longer needs it.
- **G6**: write the behavioral tests, prioritising concurrency-seam / background-isolation /
  tab-close (they protect the abort-on-spawn removal).

## Risks

- **Event leakage**: the 4 events must reach only the badge store, never the main transcript
  (keep `SubAgentEventRouter` suppression). Test this explicitly.
- **Eviction correctness**: a misordered `TieredEvictor` could evict live task output —
  cover with the designed eviction/quota tests before shipping G3.
- **G4 regressions**: resolving denied must not double-resolve a still-running turn; gate on
  task identity.

## Validation

- G1/G2: spawn a background sub-agent → badge appears, shows live state, output streams via
  `usePolledTaskOutput`; events do **not** appear in the main transcript.
- G3: simulate quota pressure → tier-0 task output evicted before tier-1 cache; designed
  quota-eviction test green.
- G4: abort a task with a pending tool approval → awaiting call resolves denied, no hang.
- G5: terminated task notification carries a correct non-zero offset (or branch removed).
- G6: the ~11 behavioral tests exist and pass.

## Open questions

1. Badge mount location — chat top-bar confirmed by Track 04 Q10; confirm exact component.
2. Poll interval / backpressure for `usePolledTaskOutput` — reuse Track 04 timing constants
   (`src/core/tasks/timing.ts`).
