# Track 29 — Tasks

Follows up [Track 04](../04_typed_task_families_DONE/design.md). See `design.md` for gap evidence.

Ordering: G6 scaffolding alongside each phase. G1→G2 (delivery), G3 (eviction), G4/G5 (fixes).

## Phase 1 — Event emission + routing (G1)

- [x] 1.1 Emit `BackgroundTaskStarted` at typed-task registration in `Session`.
- [x] 1.2 Emit `BackgroundTaskStateChanged` on task status transitions.
- [x] 1.3 Emit `BackgroundTaskOutputDelta` at `TaskOutputStore` append anchors
      (`SubAgentRunner`/`TaskRunner` chunk sites).
- [x] 1.4 Emit `BackgroundTaskTerminated` on success AND abort/failure paths.
- [x] 1.5 Add `ThreadEventRouter` handlers dispatching the 4 events into
      `backgroundTaskStore`; keep them on `SubAgentEventRouter.ts:24` suppression.
- [x] 1.6 Test: events reach the store but never the main transcript.

## Phase 2 — UI delivery (G2)

- [x] 2.1 Import + mount `BackgroundTasksBadge.svelte` in the chat top-bar.
- [x] 2.2 Call `startBackgroundTaskPolling(getEngine)` on chat-page mount.
- [x] 2.3 Create `src/webfront/lib/hooks/usePolledTaskOutput.ts` per Track 04 contract.
- [x] 2.4 Test: spawned background task renders in the badge with live state/output.

## Phase 3 — Production TieredEvictor (G3)

- [x] 3.1 In `service-worker.ts`, construct `TaskOutputStore` + `TaskOutputManager`.
- [x] 3.2 Build a `TieredEvictor` (tier0 → `TaskOutputManager`, tier1 → cache).
- [x] 3.3 Pass `{ cacheManager, tieredEvictor }` to `new StorageQuotaManager(...)`.
- [x] 3.4 Port the designed quota-eviction test; assert tier-0 evicts before tier-1.

## Phase 4 — Correctness fixes

- [x] 4.1 (G4) `Session.ts:1701-1707`: resolve pending approvals `{decision:'denied'}` per
      task instead of `clearPending()`; gate on task identity.
- [x] 4.2 (G4) Test: abort with pending approval → awaiting call unwinds, no hang.
- [x] 4.3 (G5) Assign `TaskOutputStore` `lastSeq` → `taskState.outputOffset` (e.g. in
      `markTypedTaskTerminated`), or delete the dead `<output-offset>` branch
      (`SubAgentRunner.ts:674`).
- [x] 4.4 (G5) Test: terminated notification carries correct offset (or branch removed).

## Phase 5 — Behavioral test backfill (G6)

- [x] 5.1 concurrency-seam + spawn-replacement (protects abort-on-spawn removal).
- [x] 5.2 background-isolation + tab-close + handle-task-abort.
- [x] 5.3 eviction / quota-eviction / notification-format / engine integration.

## Exit criteria

- Spawning a background sub-agent shows a live badge with streaming output; events stay out
  of the main transcript.
- Tier-0 task-output eviction runs under quota pressure in the shipped extension.
- Aborting a task with a pending approval never hangs.
- `<output-offset>` is correct or removed.
- The designed behavioral tests exist and pass.
