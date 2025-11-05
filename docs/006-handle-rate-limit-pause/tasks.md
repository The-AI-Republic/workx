# Tasks: Rate Limit Pause Handling

**Input**: Design documents from `/specs/006-handle-rate-limit-pause/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included - comprehensive test coverage for all user stories

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions
- **Single project**: `src/`, `tests/` at repository root
- Paths assume Chrome extension architecture per plan.md

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure for rate limit pause handling

- [X] T001 Review existing error handling infrastructure in src/models/ModelClientError.ts and src/models/types/StreamAttemptError.ts
- [X] T002 Review existing TurnManager implementation in src/core/TurnManager.ts to understand turn execution flow
- [X] T003 [P] Review existing event system in src/protocol/events.ts to understand event emission patterns

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 [P] Create timer utility file src/utils/time.ts with PauseTimer class stub
- [X] T005 [P] Add IRateLimitPauseConfig interface to src/config/types.ts
- [X] T006 [P] Add PersistedPauseState interface to src/core/session/state/types.ts
- [X] T007 [P] Add RateLimitPausedEvent and RateLimitResumedEvent interfaces to src/protocol/events.ts
- [X] T008 Add DEFAULT_RATE_LIMIT_PAUSE_CONFIG to src/config/defaults.ts
- [X] T009 Add RateLimitPauseConfigSchema to src/config/validators.ts with Zod validation rules
- [X] T010 Add TurnPauseState interface as private type in src/core/TurnManager.ts

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Basic Rate Limit Pause (Priority: P1) 🎯 MVP

**Goal**: When an agent encounters a rate limit error during API calls, the system automatically pauses the current turn execution for a configurable duration instead of retrying immediately, allowing the rate limit window to reset before continuing.

**Independent Test**: Can be fully tested by triggering a rate limit error response and verifying the turn pauses for the configured duration without retrying, then resumes automatically.

### Tests for User Story 1 ⚠️

**NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T011 [P] [US1] Create contract test for RateLimitPausedEvent schema in tests/contract/pause-notification.test.ts
- [ ] T012 [P] [US1] Create contract test for RateLimitResumedEvent schema in tests/contract/pause-notification.test.ts
- [ ] T013 [P] [US1] Create unit test for PauseTimer.delay() short pause (<60s) in tests/unit/pause-timer.test.ts
- [ ] T014 [P] [US1] Create unit test for PauseTimer.delay() long pause (>=60s) in tests/unit/pause-timer.test.ts
- [ ] T015 [P] [US1] Create unit test for TurnManager.pauseForRateLimit() in tests/unit/TurnManager-pause.test.ts
- [ ] T016 [P] [US1] Create unit test for TurnManager.resumeFromPause() in tests/unit/TurnManager-pause.test.ts
- [ ] T017 [P] [US1] Create unit test for TurnManager.cancel() during pause in tests/unit/TurnManager-pause.test.ts
- [ ] T018 [P] [US1] Create integration test for full pause/resume flow in tests/integration/rate-limit-pause.test.ts
- [ ] T019 [P] [US1] Create integration test for pause state persistence in tests/integration/pause-resume-state.test.ts

### Implementation for User Story 1

- [ ] T020 [P] [US1] Implement PauseTimer.delay() method with setTimeout for short pauses in src/utils/time.ts
- [ ] T021 [P] [US1] Implement PauseTimer.delay() method with chrome.alarms for long pauses in src/utils/time.ts
- [ ] T022 [US1] Add pauseState private property to TurnManager class in src/core/TurnManager.ts
- [ ] T023 [US1] Implement TurnManager.calculatePauseDuration() helper method in src/core/TurnManager.ts (depends on T022)
- [ ] T024 [US1] Implement TurnManager.pauseForRateLimit() method with default duration in src/core/TurnManager.ts (depends on T020, T021, T023)
- [ ] T025 [US1] Implement TurnManager.resumeFromPause() method in src/core/TurnManager.ts (depends on T022, T024)
- [ ] T026 [US1] Modify TurnManager.runTurn() to detect rate limit errors and call pauseForRateLimit() in src/core/TurnManager.ts (depends on T024)
- [ ] T027 [US1] Extend TurnManager.cancel() to clear pause timers and emit resume event in src/core/TurnManager.ts (depends on T022, T025)
- [ ] T028 [US1] Add pauseState persistence to SessionState.save() in src/core/session/state/SessionState.ts
- [ ] T029 [US1] Add pauseState restoration to SessionState.load() in src/core/session/state/SessionState.ts (depends on T028)
- [ ] T030 [US1] Implement resumeFromPersistence() method for service worker wake recovery in src/core/TurnManager.ts (depends on T025, T029)
- [ ] T031 [US1] Add RateLimitPausedEvent emission to pauseForRateLimit() in src/core/TurnManager.ts (depends on T024)
- [ ] T032 [US1] Add RateLimitResumedEvent emission to resumeFromPause() in src/core/TurnManager.ts (depends on T025)
- [ ] T033 [US1] Verify all tests pass and pause/resume flow works end-to-end

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently. Rate limit errors trigger pause with default 60s duration, turn resumes automatically, state persists across hibernation.

---

## Phase 4: User Story 2 - Configurable Pause Duration (Priority: P2)

**Goal**: Users can configure the rate limit pause duration in the agent configuration to match their API provider's rate limit window or organizational policies.

**Independent Test**: Can be tested independently by configuring different pause durations in agent config and verifying the system respects those settings when rate limit errors occur.

### Tests for User Story 2 ⚠️

- [ ] T034 [P] [US2] Create unit test for config validation with valid pause config in tests/unit/config-validation.test.ts
- [ ] T035 [P] [US2] Create unit test for config validation rejecting negative defaultDuration in tests/unit/config-validation.test.ts
- [ ] T036 [P] [US2] Create unit test for config validation rejecting defaultDuration > maxDuration in tests/unit/config-validation.test.ts
- [ ] T037 [P] [US2] Create unit test for config validation rejecting maxDuration > 600000 in tests/unit/config-validation.test.ts
- [ ] T038 [P] [US2] Create integration test for custom pause duration config in tests/integration/rate-limit-pause.test.ts
- [ ] T039 [P] [US2] Create integration test for invalid config fallback to defaults in tests/integration/rate-limit-pause.test.ts

### Implementation for User Story 2

- [ ] T040 [US2] Update TurnManager.calculatePauseDuration() to read provider-specific rateLimitPause config in src/core/TurnManager.ts
- [ ] T041 [US2] Add config validation on provider config updates in src/config/validators.ts using RateLimitPauseConfigSchema
- [ ] T042 [US2] Update default provider config to include rateLimitPause in src/config/defaults.ts
- [ ] T043 [US2] Add rateLimitPause field to IProviderConfig type in src/config/types.ts
- [ ] T044 [US2] Test that custom pause durations are respected when configured
- [ ] T045 [US2] Test that invalid configs are rejected and fallback to defaults works

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently. Users can configure custom pause durations, invalid configs are rejected.

---

## Phase 5: User Story 3 - API Provider Retry-After Header Support (Priority: P3)

**Goal**: When the API provider includes a `Retry-After` header in the rate limit response, the system uses that duration instead of the configured default, optimizing the pause to match the provider's specific guidance.

**Independent Test**: Can be tested by simulating rate limit responses with various `Retry-After` header values and verifying the system uses those values for pause duration.

### Tests for User Story 3 ⚠️

- [ ] T046 [P] [US3] Create unit test for calculatePauseDuration() with Retry-After header in tests/unit/TurnManager-pause.test.ts
- [ ] T047 [P] [US3] Create unit test for calculatePauseDuration() capping header value at maxDuration in tests/unit/TurnManager-pause.test.ts
- [ ] T048 [P] [US3] Create unit test for calculatePauseDuration() fallback when useRetryAfterHeader=false in tests/unit/TurnManager-pause.test.ts
- [ ] T049 [P] [US3] Create integration test for Retry-After header precedence in tests/integration/rate-limit-pause.test.ts
- [ ] T050 [P] [US3] Create integration test for malformed Retry-After header handling in tests/integration/rate-limit-pause.test.ts

### Implementation for User Story 3

- [ ] T051 [US3] Update TurnManager.calculatePauseDuration() to check useRetryAfterHeader config flag in src/core/TurnManager.ts
- [ ] T052 [US3] Update TurnManager.calculatePauseDuration() to extract Retry-After from error metadata in src/core/TurnManager.ts (depends on T051)
- [ ] T053 [US3] Update TurnManager.calculatePauseDuration() to convert Retry-After seconds to milliseconds in src/core/TurnManager.ts (depends on T052)
- [ ] T054 [US3] Update TurnManager.calculatePauseDuration() to cap Retry-After at maxDuration in src/core/TurnManager.ts (depends on T053)
- [ ] T055 [US3] Update RateLimitPausedEvent emission to include retryAfterHeader and durationSource in src/core/TurnManager.ts (depends on T054)
- [ ] T056 [US3] Test that Retry-After header values are used when present and config allows
- [ ] T057 [US3] Test that Retry-After values exceeding maxDuration are capped correctly

**Checkpoint**: All user stories should now be independently functional. System uses Retry-After when available, falls back to config defaults otherwise.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories and edge cases

- [ ] T058 [P] Add edge case handling for multiple sequential rate limits in src/core/TurnManager.ts
- [ ] T059 [P] Add edge case handling for rate limit during existing pause in src/core/TurnManager.ts
- [ ] T060 [P] Add logging for pause/resume events in src/core/TurnManager.ts
- [ ] T061 [P] Update CLAUDE.md documentation with rate limit pause feature
- [ ] T062 [P] Add inline documentation to all new public methods in TurnManager
- [ ] T063 Code cleanup and refactoring for consistency across all modified files
- [ ] T064 Performance profiling to verify <500ms notification latency and <1s resume accuracy
- [ ] T065 Run quickstart.md validation steps to verify all implementation phases
- [ ] T066 [P] Optional: Add UI notification component in src/sidepanel/ for pause status display
- [ ] T067 Final integration test covering all three user stories working together

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User Story 1 can start after Foundational (Phase 2)
  - User Story 2 can start after US1 (needs pause mechanism to configure)
  - User Story 3 can start after US1 (needs pause mechanism to add header support)
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Depends on Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Depends on User Story 1 (needs basic pause to be configurable)
- **User Story 3 (P3)**: Depends on User Story 1 (needs basic pause to add header support)

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Timer utilities before TurnManager integration
- TurnManager pause/resume methods before runTurn() modification
- State persistence before hibernation recovery
- Event emission after pause/resume logic
- Verify tests pass before moving to next story

### Parallel Opportunities

- All Setup tasks (T001-T003) can run in parallel
- All Foundational tasks marked [P] (T004-T007) can run in parallel
- Within User Story 1 tests: T011-T019 can run in parallel
- Within User Story 1 implementation: T020-T021 can run in parallel (different timer branches)
- Within User Story 2 tests: T034-T039 can run in parallel
- Within User Story 3 tests: T046-T050 can run in parallel
- Polish tasks marked [P] (T058-T062, T066) can run in parallel

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Create contract test for RateLimitPausedEvent schema in tests/contract/pause-notification.test.ts"
Task: "Create contract test for RateLimitResumedEvent schema in tests/contract/pause-notification.test.ts"
Task: "Create unit test for PauseTimer.delay() short pause in tests/unit/pause-timer.test.ts"
Task: "Create unit test for PauseTimer.delay() long pause in tests/unit/pause-timer.test.ts"
Task: "Create unit test for TurnManager.pauseForRateLimit() in tests/unit/TurnManager-pause.test.ts"
Task: "Create unit test for TurnManager.resumeFromPause() in tests/unit/TurnManager-pause.test.ts"
Task: "Create unit test for TurnManager.cancel() during pause in tests/unit/TurnManager-pause.test.ts"
Task: "Create integration test for full pause/resume flow in tests/integration/rate-limit-pause.test.ts"
Task: "Create integration test for pause state persistence in tests/integration/pause-resume-state.test.ts"

# After tests fail, launch timer implementations together:
Task: "Implement PauseTimer.delay() with setTimeout in src/utils/time.ts"
Task: "Implement PauseTimer.delay() with chrome.alarms in src/utils/time.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (review existing code)
2. Complete Phase 2: Foundational (CRITICAL - type definitions and infrastructure)
3. Complete Phase 3: User Story 1 (basic pause/resume with default 60s)
4. **STOP and VALIDATE**: Test User Story 1 independently
   - Trigger rate limit error
   - Verify 60s pause with no retries
   - Verify automatic resume
   - Verify state persistence across hibernation
   - Verify cancellation works during pause
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready (types, interfaces, validators)
2. Add User Story 1 → Test independently → Deploy/Demo (MVP! Basic pause working)
3. Add User Story 2 → Test independently → Deploy/Demo (Configurable durations)
4. Add User Story 3 → Test independently → Deploy/Demo (Retry-After header support)
5. Add Polish → Final release (edge cases, logging, documentation)

Each story adds value without breaking previous stories.

### Sequential Strategy (Recommended)

Since US2 and US3 build on US1, recommended execution order:

1. Complete Phase 1 + 2 (foundation)
2. Complete Phase 3 (US1) → Validate independently
3. Complete Phase 4 (US2) → Validate independently
4. Complete Phase 5 (US3) → Validate independently
5. Complete Phase 6 (polish)

---

## Task Summary

- **Total Tasks**: 67
- **Setup Phase**: 3 tasks
- **Foundational Phase**: 7 tasks (blocking)
- **User Story 1 (P1)**: 23 tasks (9 tests + 14 implementation)
- **User Story 2 (P2)**: 12 tasks (6 tests + 6 implementation)
- **User Story 3 (P3)**: 12 tasks (5 tests + 7 implementation)
- **Polish Phase**: 10 tasks

### Tasks by Type

- **Test Tasks**: 20 (contract, unit, integration)
- **Implementation Tasks**: 37
- **Review/Setup Tasks**: 3
- **Documentation/Polish Tasks**: 7

### Parallel Opportunities

- **Phase 1**: 3 tasks can run in parallel (T001-T003)
- **Phase 2**: 4 tasks can run in parallel (T004-T007)
- **US1 Tests**: 9 tasks can run in parallel (T011-T019)
- **US1 Implementation**: 2 tasks can run in parallel (T020-T021)
- **US2 Tests**: 6 tasks can run in parallel (T034-T039)
- **US3 Tests**: 5 tasks can run in parallel (T046-T050)
- **Polish**: 5 tasks can run in parallel (T058-T062, T066)

**Total Parallel Opportunities**: 34 tasks (51% of all tasks)

### Independent Test Criteria

**User Story 1**: Trigger HTTP 429 → verify 60s pause without retry → verify auto-resume → verify state persists across service worker hibernation → verify cancellation clears pause

**User Story 2**: Set custom pause duration in config → trigger HTTP 429 → verify pause uses custom duration → set invalid config → verify rejection and fallback to default

**User Story 3**: Trigger HTTP 429 with Retry-After: 30 header → verify 30s pause (not 60s default) → trigger with Retry-After exceeding maxDuration → verify capped at maxDuration

### Suggested MVP Scope

**Minimum Viable Product**: User Story 1 only (Phase 1 + Phase 2 + Phase 3)
- **Tasks**: T001-T033 (33 tasks)
- **Deliverable**: Rate limit errors pause turn for 60s (fixed), auto-resume, state persists, cancellation works
- **Value**: Core functionality prevents wasted API retry attempts, respects rate limits
- **Test**: Manually trigger rate limit, observe pause notification, verify resume

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US2 and US3 build on US1, so sequential execution recommended
- Focus on US1 for MVP, add US2/US3 as enhancements
