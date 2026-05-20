# Track 34 — Integration Defect: 05b Extractor ↔ Track 04 Task Seam (+ teardown leaks)

Date: 2026-05-15
Status: DONE — shutdown timer/task teardown fixed 2026-05-18
Type: Cross-track integration bug (not a single-track design gap)
Tracks involved: [Track 04 Typed Task Families](../04_typed_task_families_DONE/design.md) × [Track 05b Auto-Extraction/Interlock](../05b_auto_extraction_compaction_interlock_DONE/design.md) × [Track 01 Hooks](../01_hook_event_system_DONE/design.md)
Source: cross-track integration audit 2026-05-15, each defect independently re-verified against on-disk source on `agent-improvements`; re-verified 2026-05-18 on `origin/agent-improvements` at `cd1e339e`; re-verified after pull 2026-05-18 on `origin/agent-improvements` at `e9bbff26`.

## Summary

Track 41 migrated the 05b summary extractor away from the user-facing `sub_agent` seam and
onto `ShadowAgentScheduler`. The original P0 extractor phantom is therefore resolved on the
current branch: session summary no longer registers a quiet background sub-agent, no longer
emits user-facing `SubAgentStart` / `SubAgentComplete`, and parent engine disposal shuts down
active shadow jobs before `Session.shutdown()`.

One teardown bug from the original audit remains: `Session.shutdown()` still does not clear
an already armed Track-04 eviction interval and still does not abort active typed tasks.

---

## BUG-1 — Resolved by Track 41: quiet extractor is no longer a sub-agent task

**Current evidence:** `SessionSummaryHook` now calls
`parentEngine.getShadowAgentScheduler().run({ kind: ShadowAgentKind.SessionSummary, ... })`
and no longer imports or constructs `SubAgentRunner`, `SubAgentRegistry`,
`cacheSafeParams.ts`, or `session_summary_extractor`. Track 41 also removed those old helper
files. Shadow jobs do not register typed background task state or consume sub-agent registry
slots.

`SubAgentRunner` itself was also hardened: detached background runs now call
`markTypedTaskTerminated(...)` after execution even when `quietBackground` suppresses the
LLM-visible notification. That makes the old failure mode less likely for compatibility
callers, but the important extractor fix is that internal extraction no longer enters this
seam at all.

---

## BUG-2 — Resolved by Track 41: extractor lifecycle no longer emits sub-agent events

**Current evidence:** session summary extraction is a `ShadowAgentKind.SessionSummary`
request. The shadow runner/scheduler uses shadow telemetry and typed shadow results; it does
not call `SubAgentRunner` and does not inject user-facing sub-agent lifecycle events by
default.

---

## BUG-3 — Resolved 2026-05-18: `Session.shutdown()` no longer leaks the Track-04 eviction `setInterval`

**Fix shipped:** `Session.shutdown()` now aborts active tasks with `Shutdown`, clears
`activeTasks`/foreground state through the existing abort path, and clears the armed
eviction interval after abort propagation. A fake-timer regression test verifies shutdown
aborts an active typed task and leaves zero active timers.

---

## BUG-4 — Resolved by Track 41: extractor child engine is owned by the shadow scheduler

**Current evidence:** `RepublicAgentEngine.dispose()` calls
`this.shadowAgentScheduler?.shutdown()` before `session.shutdown()`. The scheduler cancels
queued jobs and aborts active jobs. `SessionSummaryHook.detach()` still aborts its local
lifetime controller to suppress orphaned cache/state writes after detach.

---

## Assessed safe (no defect — recorded so it isn't re-investigated)

- **Post-turn re-entrancy:** `firePostTurnHooks` is awaited inside TurnManager's `Completed`
  case before returning; the 05b hook is still fire-and-forget and guarded by the
  `isExtractionInFlight` skip. A queued `Compact` running its interlock while the spawning
  turn is still extracting is the intended path, correctly bounded by the 15s/60s escapes.
  Track 41's shadow migration does not introduce a new re-entrancy defect.

## Relationship to other tracks

Distinct from Track 29 (Track-04 follow-up, which covers events-not-emitted / UI-not-mounted
/ Q7 hang). The extractor-specific seam is now resolved by Track 41; only the independent
Track-04 shutdown cleanup remains here.
