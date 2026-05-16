# Track 34 — Tasks

Cross-track integration bug. See `design.md` for full evidence (file:line). Order: BUG-1 → BUG-3 → BUG-2 → BUG-4.

## Phase 1 — BUG-1 (Critical): symmetric register/terminal for quiet extractor

- [ ] 1.1 Thread `quietBackground` into the `registerTaskState` call site
      (`SubAgentRunner.ts:435-460`); skip registration when `quietBackground === true`
      (preferred) — OR always call `markTypedTaskTerminated` in the run `finally`
      regardless of `suppressNotification()`.
- [ ] 1.2 Regression test: a `quietBackground` sub-agent leaves `listTaskStates()`
      unchanged and lets the eviction timer reach its stop condition.

## Phase 2 — BUG-3 (High): stop eviction timer + abort tasks on shutdown

- [ ] 2.1 In `Session.shutdown()` (`Session.ts:1452-1475`): clear `evictionTimerId` and
      `await abortAllTasks('Shutdown')` (or clear `activeTasks`) before detaching.
- [ ] 2.2 Test (fake timers): no eviction tick fires after `shutdown()`.

## Phase 3 — BUG-2 (High): fully suppress quiet extractor lifecycle events

- [ ] 3.1 Add `SESSION_SUMMARY_EXTRACTOR_TYPE_ID` to `SubAgentEventRouter` `suppressedTypes`
      (`SubAgentRunner.ts:289-293`) so `SubAgentStart`/`SubAgentComplete` are not emitted to
      the parent stream for the quiet extractor.
- [ ] 3.2 Test: an auto-extraction emits no `SubAgentStart`/`SubAgentComplete` on the
      parent engine.

## Phase 4 — BUG-4 (Med): dispose extractor child engine on parent teardown

- [ ] 4.1 `SessionSummaryHook.detach()` (or `Session.shutdown` via internal
      `SubAgentRegistry`) aborts the extractor child engine / `abortController`; wire to
      `lifetimeAbort`.
- [ ] 4.2 Test: parent dispose mid-extraction cancels the child engine (no leaked
      CDP/debugger attachment).

## Exit criteria

- A `quietBackground` extractor never appears in `listTaskStates()` and never blocks the
  eviction timer's stop condition.
- After `Session.shutdown()`, no eviction `setInterval` continues firing.
- Auto-extraction emits zero parent-visible sub-agent lifecycle events.
- Parent teardown mid-extraction tears down the extractor's child engine.
