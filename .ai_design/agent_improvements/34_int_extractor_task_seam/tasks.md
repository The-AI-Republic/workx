# Track 34 — Tasks

Cross-track integration bug. See `design.md` for full evidence. Track 41 resolved the
extractor-specific seam; only the independent shutdown leak remains open.

## Phase 1 — BUG-1 (Critical): symmetric register/terminal for quiet extractor

- [x] 1.1 Session summary extraction no longer uses `SubAgentRunner`; it runs through
      `ShadowAgentScheduler` as `ShadowAgentKind.SessionSummary`.
- [x] 1.2 `SubAgentRunner` compatibility path marks typed task state terminal even when
      `quietBackground` suppresses notification delivery.

## Phase 2 — BUG-3 (High): stop eviction timer + abort tasks on shutdown

- [ ] 2.1 In `Session.shutdown()` (`Session.ts:1452-1475`): clear `evictionTimerId` and
      `await abortAllTasks('Shutdown')` (or clear `activeTasks`) before detaching.
- [ ] 2.2 Test (fake timers): no eviction tick fires after `shutdown()`.

## Phase 3 — BUG-2 (High): fully suppress quiet extractor lifecycle events

- [x] 3.1 Auto-extraction no longer emits parent-visible `SubAgentStart` /
      `SubAgentComplete` because it no longer goes through `SubAgentRunner`.
- [x] 3.2 Shadow-agent tests verify shadow jobs do not enter user-facing sub-agent
      lifecycle by default.

## Phase 4 — BUG-4 (Med): dispose extractor child engine on parent teardown

- [x] 4.1 `RepublicAgentEngine.dispose()` shuts down the shadow-agent scheduler before
      `Session.shutdown()`, aborting active extractor jobs.
- [x] 4.2 `SessionSummaryHook.detach()` still aborts its lifetime controller so completed
      orphan work cannot update cache/state after detach.

## Exit criteria

- A session-summary extractor never appears in `listTaskStates()` and cannot block
  all-tasks-terminal logic.
- After `Session.shutdown()`, no eviction `setInterval` continues firing.
- Auto-extraction emits zero parent-visible sub-agent lifecycle events.
- Parent teardown mid-extraction tears down the extractor's child engine.
