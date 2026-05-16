# Track 34 — Integration Defect: 05b Extractor ↔ Track 04 Task Seam (+ teardown leaks)

Date: 2026-05-15
Status: OPEN — **P0 (Critical)**
Type: Cross-track integration bug (not a single-track design gap)
Tracks involved: [Track 04 Typed Task Families](../04_typed_task_families_DONE/design.md) × [Track 05b Auto-Extraction/Interlock](../05b_auto_extraction_compaction_interlock_DONE/design.md) × [Track 01 Hooks](../01_hook_event_system_DONE/design.md)
Source: cross-track integration audit 2026-05-15, each defect independently re-verified against on-disk source on `agent-improvements`.

## Summary

Track 05b runs its background summary extractor as a **sub-agent**. Track 04 added a
`Session` task seam that *unconditionally* registers every sub-agent as a tracked task but
marks it terminal *conditionally*. Because the 05b extractor is `quietBackground: true`, the
terminal-marking is gated out — so the extractor becomes a **permanent phantom "running"
task** that never settles. This single defect cascades into a UI-pollution bug, an
eviction-timer leak, and a teardown resource leak. None of these are in tracks 26–32.

---

## BUG-1 — Critical: quiet extractor is registered as a Track-04 task but never marked terminal

**Evidence (verified):**
- `SubAgentRunner` registers a synthetic `BackgroundAgentTaskState` (`status: 'running'`,
  `notified: false`) into the parent `Session` for **every** sub-agent — the call is guarded
  only by `typeof parentSession.registerTaskState === 'function'`, *not* by `quietBackground`:
  `src/tools/AgentTool/SubAgentRunner.ts:435-460` (registerTaskState at `:453`).
- The only transition to terminal is `markTypedTaskTerminated`, called **only inside**
  `if (!suppressNotification())`: `SubAgentRunner.ts:133,139` (success) and `:143,155`
  (failure).
- `suppressNotification()` returns `true` whenever `params.quietBackground === true`:
  `SubAgentRunner.ts:127-128`.
- The 05b extractor is constructed with `quietBackground: true`:
  `src/core/sessionSummary/cacheSafeParams.ts:32,36`.

**Result:** the extractor's task entry is created but `markTypedTaskTerminated` is never
called for it → it remains `status: 'running'` forever.

**Impact:**
1. It appears in `Session.listTaskStates()` (`src/core/Session.ts:2057-2062`) → pollutes the
   background-task badge / transcript — exactly what `quietBackground` exists to prevent.
2. Track 04's eviction timer's "stop when nothing non-terminal remains" check
   (`Session.ts:2127-2133`) sees a perpetually non-terminal task and **the timer never
   stops** (feeds BUG-3).

**Fix:** make registration and terminal-marking symmetric. Either (a) skip
`registerTaskState` when `quietBackground === true` (thread the flag into the
`registerTaskState` call site in `SubAgentRunner.prepare`), or (b) always call
`markTypedTaskTerminated` in the run `finally` regardless of notification suppression
(suppress only the *notification*, not the state transition). Option (a) is cleaner: the
quiet extractor should be outside the user-facing task seam entirely. Add a regression test
asserting a `quietBackground` sub-agent leaves `listTaskStates()` unchanged and lets the
eviction timer stop.

---

## BUG-2 — High: `SubAgentStart`/`SubAgentComplete` events fired for the quiet extractor

**Evidence:** `SubAgentRunner` pushes `SubAgentStart` (`SubAgentRunner.ts:417-427`) and
`SubAgentComplete` (`:496-508`) onto the **parent** engine's event stream unconditionally —
the `quietBackground` contract suppresses the *notification* but not these lifecycle events.
The extractor is therefore half-visible (notification hidden, but Start/Complete leak into
the parent transcript/UI).

**Fix:** route the extractor's lifecycle events through the existing suppression mechanism —
`SubAgentEventRouter` already supports `suppressedTypes` (`SubAgentRunner.ts:289-293`); add
`SESSION_SUMMARY_EXTRACTOR_TYPE_ID` to it so the quiet extractor is fully invisible.

---

## BUG-3 — High: `Session.shutdown()` leaks the Track-04 eviction `setInterval` past teardown

**Evidence:** `Session.shutdown()` (`src/core/Session.ts:1452-1475`) detaches the 05b hook,
closes memory, flushes rollout — but never calls `abortAllTasks` and never clears
`evictionTimerId`. `clearInterval` only happens inside `runEvictionTick` when no
non-terminal task remains (`Session.ts:2130-2132`). Per BUG-1 the quiet-extractor task is
permanently non-terminal, so the timer keeps firing `runEvictionTick` on a shut-down
`Session` indefinitely (a `setInterval` leak in the service worker; also touches
`taskOutputStore` after shutdown). `RepublicAgentEngine.dispose()` calls
`session.shutdown()` (`RepublicAgentEngine.ts:269-271`) and adds no task cleanup. Even
without BUG-1, any still-running background task at shutdown leaves the timer armed.

**Fix:** in `Session.shutdown()`, before detaching: `if (this.evictionTimerId) {
clearInterval(this.evictionTimerId); this.evictionTimerId = null; }` and `await
this.abortAllTasks('Shutdown')` (or at minimum clear `activeTasks`). Test: after
`shutdown()`, no eviction tick fires (fake timers).

---

## BUG-4 — Medium: extractor's orphaned child engine is not disposed on parent teardown

**Evidence:** On dispose, a `Shutdown`/`Interrupt` at priority `now` jumps the queue
(`src/core/queue/priorityForOp.ts:22-26`) and `handleShutdown` only clears queues
(`RepublicAgentEngine.ts:827-835`). `SessionSummaryHook.detach()` aborts `lifetimeAbort`
(`src/core/sessionSummary/SessionSummaryHook.ts:171`) which short-circuits `runExtraction`
*after* its await, but `detach()` never cancels the extractor's in-flight child
`RepublicAgentEngine`/`runner.run`; the underlying sub-agent run is explicitly "discarded
but may continue" (`SessionSummaryHook.ts:165-167`). The interlock *flag* is safe (cleared
in `runExtraction`'s `finally` + a 60s staleness escape in
`src/core/sessionSummary/extractionLifecycle.ts:73-76`), but the orphaned child engine —
which may hold a CDP/debugger attachment — is never torn down on parent shutdown.

**Fix:** have `SessionSummaryHook.detach()` (or `Session.shutdown()` via the internal
`SubAgentRegistry`) abort the extractor's child engine / its `abortController`, wiring it to
`lifetimeAbort`. Test: parent dispose mid-extraction cancels the child engine.

---

## Assessed safe (no defect — recorded so it isn't re-investigated)

- **Post-turn re-entrancy:** `firePostTurnHooks` is awaited inside TurnManager's `Completed`
  case before returning (`src/core/TurnManager.ts:337-377`); the 05b hook is fire-and-forget
  and guarded by the `isExtractionInFlight` skip
  (`SessionSummaryHook.ts:213-217`). A queued `Compact` (priority `later`) running its
  interlock while the spawning turn is still extracting is the *intended* path, correctly
  bounded by the 15s/60s escapes (`extractionLifecycle.ts:63-83`). No new defect beyond
  BUG-1/3 which make the task-state never settle.

## Relationship to other tracks

Distinct from Track 29 (Track-04 follow-up, which covers events-not-emitted / UI-not-mounted
/ Q7 hang) — this track is about the *05b-sub-agent ↔ Track-04-seam interaction*, which
Track 29 does not address. Sequence: fix BUG-1 first (it makes BUG-3 permanent); BUG-3's
`shutdown` fix is independently valuable and should land regardless.
