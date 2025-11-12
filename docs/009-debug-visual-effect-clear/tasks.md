# Tasks: Visual Effect Clearing Communication Debug

**Input**: Design documents from `/specs/009-debug-visual-effect-clear/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: No automated tests required for this debugging feature. Verification is manual via console logs and visual effect behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Chrome Extension**: `src/background/`, `src/content/`, `src/core/`
- Paths use existing project structure from plan.md

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Validate prerequisites and verify current bug state

- [x] T001 Verify Chrome extension build environment (npm run build succeeds)
- [x] T002 Reproduce the visual effects bug per quickstart.md instructions
- [x] T003 [P] Document baseline console logs showing message delivery failure

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Analyze existing message flow in src/core/BrowserxAgent.ts (lines 639-661)
- [x] T005 [P] Analyze existing broadcast logic in src/background/service-worker.ts (lines 197-230)
- [x] T006 [P] Analyze existing listener registration in src/content/ui_effect/VisualEffectController.svelte (lines 296-364)
- [x] T007 Confirm root cause: listener registered in onMount() causing race condition

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Background-to-Content Message Delivery (Priority: P1) 🎯 MVP

**Goal**: Fix the race condition preventing visual effects from clearing when tasks complete

**Independent Test**: Trigger task completion → Verify visual effects clear within 500ms → Verify console shows message received by VisualEffectController

### Implementation for User Story 1

- [ ] T008 [US1] Create src/content/content-script.ts with top-level chrome.runtime.onMessage listener
- [ ] T009 [US1] Add message validation in content-script.ts: Check type === 'EVENT' and payload.msg structure
- [ ] T010 [US1] Add DOM custom event dispatch in content-script.ts: browserx:task-lifecycle event with eventType detail
- [ ] T011 [US1] Add registration log in content-script.ts: "[ContentScript] $$$ Message listener registered"
- [ ] T012 [US1] Update src/content/ui_effect/VisualEffectController.svelte to remove chrome.runtime.onMessage listener (lines 296-333)
- [ ] T013 [US1] Add DOM custom event listener in VisualEffectController.svelte: Listen for browserx:task-lifecycle
- [ ] T014 [US1] Update taskLifecycleHandler in VisualEffectController.svelte to handle CustomEvent detail
- [ ] T015 [US1] Verify handleAgentStop() is called correctly when DOM event fires
- [ ] T016 [US1] Update manifest.json to ensure content-script.ts is loaded in content_scripts configuration
- [ ] T017 [US1] Build and reload extension in chrome://extensions
- [ ] T018 [US1] Manual test: Trigger task completion and verify visual effects clear within 500ms
- [ ] T019 [US1] Verify console logs show: "[ContentScript] $$$ Message received: EVENT" followed by "[VisualEffectController] $$$ Task lifecycle event: TaskComplete"

**Checkpoint**: At this point, User Story 1 should be fully functional - visual effects clear automatically on task completion

---

## Phase 4: User Story 2 - Diagnostic Logging and Root Cause Identification (Priority: P1)

**Goal**: Add comprehensive logging throughout the message delivery chain to enable debugging

**Independent Test**: Trigger task completion → Examine console logs → Verify all 5 stages logged (emission → receipt → broadcast → delivery → handler)

### Implementation for User Story 2

- [ ] T020 [P] [US2] Enhance logging in src/core/BrowserxAgent.ts emitEvent() (line 652): Add "[BrowserxAgent] $$$ Sending event to service worker: {eventType}"
- [ ] T021 [P] [US2] Enhance logging in src/background/service-worker.ts EVENT listener (line 200): Add "[ServiceWorker] $$$ DIRECT listener caught EVENT: {eventType}"
- [ ] T022 [US2] Add tab count logging in service-worker.ts before broadcast: "[ServiceWorker] $$$ Broadcasting EVENT to {count} tabs"
- [ ] T023 [US2] Add per-tab logging in service-worker.ts broadcast loop: "[ServiceWorker] $$$ Attempting broadcast to tab {tabId}"
- [ ] T024 [US2] Enhance error logging in service-worker.ts .catch() (line 213): Include tab ID and error message
- [ ] T025 [US2] Add message receipt logging in src/content/content-script.ts: "[ContentScript] $$$ Message received: {type}"
- [ ] T026 [US2] Add event dispatch logging in content-script.ts: "[ContentScript] $$$ Dispatching DOM event: {eventType}"
- [ ] T027 [US2] Add handler invocation logging in VisualEffectController.svelte: "[VisualEffectController] $$$ Task lifecycle event: {eventType}"
- [ ] T028 [US2] Add cleanup logging in VisualEffectController.svelte handleAgentStop(): "[VisualEffectController] $$$ Clearing visual effects"
- [ ] T029 [US2] Build and reload extension
- [ ] T030 [US2] Manual test: Trigger task completion and verify all log stages appear in correct order
- [ ] T031 [US2] Document log correlation pattern in quickstart.md troubleshooting section

**Checkpoint**: At this point, User Stories 1 AND 2 should both work - visual effects clear AND full diagnostic logging is available

---

## Phase 5: User Story 3 - Content Script Lifecycle Verification (Priority: P2)

**Goal**: Filter out tabs where content scripts cannot be injected to reduce console errors

**Independent Test**: Open chrome:// tab → Trigger task completion → Verify no errors logged for chrome:// tab → Verify message sent to injectable tabs only

### Implementation for User Story 3

- [ ] T032 [US3] Create tab filtering helper in src/background/service-worker.ts: isInjectableTab(tab) function
- [ ] T033 [US3] Implement URL filtering logic in isInjectableTab(): Check !url.startsWith('chrome://') && !url.startsWith('chrome-extension://')
- [ ] T034 [US3] Apply tab filtering in service-worker.ts EVENT broadcast (line 205): Filter tabs before sending
- [ ] T035 [US3] Add filtered tab count logging: "[ServiceWorker] $$$ Broadcasting EVENT to {injectable} tabs (filtered {restricted} restricted)"
- [ ] T036 [US3] Add skip logging for restricted tabs: "[ServiceWorker] $$$ Skipping tab {tabId} - restricted URL: {url}"
- [ ] T037 [US3] Verify chrome.tabs.sendMessage is NOT called for chrome:// tabs
- [ ] T038 [US3] Build and reload extension
- [ ] T039 [US3] Manual test: Open mix of chrome:// and regular web pages (10+ tabs)
- [ ] T040 [US3] Trigger task completion and verify no errors for chrome:// tabs
- [ ] T041 [US3] Verify messages only sent to injectable tabs per logs

**Checkpoint**: All user stories should now be independently functional - visual effects clear, full logging, smart tab filtering

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T042 [P] Update quickstart.md with final log patterns and filtering instructions
- [ ] T043 [P] Add edge case documentation to quickstart.md troubleshooting section
- [ ] T044 Remove or comment out old debug logs with $$$ marker (lines with test broadcasts and pings)
- [ ] T045 Verify all console.log statements follow consistent format: [Context] $$$ Message
- [ ] T046 Test with 10+ simultaneous tabs (Success Criteria SC-003)
- [ ] T047 Verify visual effects clear within 500ms (Success Criteria SC-001)
- [ ] T048 Verify root cause identification within 2 minutes via logs (Success Criteria SC-002)
- [ ] T049 [P] Update CLAUDE.md with any new debugging patterns learned
- [ ] T050 Final manual testing: Run through all acceptance scenarios from spec.md
- [ ] T051 Document known limitations in quickstart.md (service worker restart, late content script loading)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3, 4, 5)**: All depend on Foundational phase completion
  - User Story 1 (P1): Must complete first - fixes the core bug
  - User Story 2 (P1): Can run in parallel with US1 OR sequentially after US1
  - User Story 3 (P2): Should complete after US1/US2 - builds on their work
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories - **THIS IS THE MVP**
- **User Story 2 (P1)**: Can start after Foundational (Phase 2) - No hard dependency on US1 but shares file edits (BrowserxAgent, service-worker)
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) - Enhances US1 broadcast logic but independently testable

### Within Each User Story

- **US1 (Message Delivery)**:
  - T008-T011 (content-script.ts creation) can run in parallel with T012-T015 (VisualEffectController updates)
  - T016-T019 (build, test, verify) must run sequentially after implementation

- **US2 (Diagnostic Logging)**:
  - T020-T021 (BrowserxAgent + service-worker) can run in parallel
  - T022-T024 (service-worker details) depend on T021
  - T025-T029 (content script + VisualEffectController) can run in parallel after T020
  - T030-T031 (test, document) must run after all logging added

- **US3 (Tab Filtering)**:
  - T032-T033 (helper function) must complete before T034-T037 (apply filtering)
  - T038-T041 (test, verify) must run after implementation

### Parallel Opportunities

- Phase 1: All 3 setup tasks can run in parallel
- Phase 2: T005 and T006 can run in parallel after T004 completes
- Within US1: Content script creation (T008-T011) || VisualEffectController updates (T012-T015)
- Within US2: BrowserxAgent logging (T020) || service-worker logging (T021) || content script logging (T025-T027)
- Phase 6: Documentation tasks (T042, T043, T049) can run in parallel

---

## Parallel Example: User Story 1

```bash
# Launch content script work and VisualEffectController work together:
Task: "Create src/content/content-script.ts with top-level chrome.runtime.onMessage listener"
Task: "Update src/content/ui_effect/VisualEffectController.svelte to remove chrome.runtime.onMessage listener"

# Both modify different files, no conflicts
```

---

## Parallel Example: User Story 2

```bash
# Launch all logging enhancements together:
Task: "Enhance logging in src/core/BrowserxAgent.ts emitEvent()"
Task: "Enhance logging in src/background/service-worker.ts EVENT listener"
Task: "Add message receipt logging in src/content/content-script.ts"

# All modify different files, can be done simultaneously
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003) - **~30 minutes**
2. Complete Phase 2: Foundational (T004-T007) - **~30 minutes**
3. Complete Phase 3: User Story 1 (T008-T019) - **~2 hours**
4. **STOP and VALIDATE**: Test User Story 1 independently
   - Trigger task completion
   - Verify visual effects clear within 500ms
   - Verify console shows message received
5. **MVP COMPLETE** - Core bug is fixed

**Total MVP Time**: ~3 hours

### Incremental Delivery (Add Logging + Filtering)

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → **MVP DEPLOYED** (visual effects clear)
3. Add User Story 2 → Test independently → **Enhanced debugging** (full log visibility)
4. Add User Story 3 → Test independently → **Production ready** (clean error handling)
5. Complete Polish phase → **Final release**

**Total Implementation Time**: ~6-8 hours

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (~1 hour)
2. Once Foundational is done:
   - **Developer A**: User Story 1 (T008-T019) - **CRITICAL PATH**
   - **Developer B**: User Story 2 (T020-T031) - Can start in parallel
   - **Developer C**: User Story 3 (T032-T041) - Can start in parallel
3. Stories complete and integrate independently
4. Team completes Polish phase together

**Total Time with 3 developers**: ~3-4 hours

---

## Notes

- **[P] tasks** = different files, no dependencies
- **[Story] label** maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Manual verification required (no automated tests for this debugging feature)
- Use Chrome DevTools Console filter: `$$$` to see all debug logs
- Commit after each logical group of tasks (e.g., after each user story phase)
- Stop at any checkpoint to validate story independently
- **MVP = User Story 1 only** - Fixes the core bug (visual effects clearing)
- User Stories 2 and 3 enhance debugging but are not critical for functionality

---

## Success Criteria Verification

After completing all tasks, verify against spec.md success criteria:

- ✅ **SC-001**: Visual effects clear automatically within 500ms (Test with T018, verify with T047)
- ✅ **SC-002**: Diagnostic logs enable root cause identification within 2 minutes (Test with T030, verify with T048)
- ✅ **SC-003**: System handles 10+ simultaneous tabs without failures (Test with T046)
- ✅ **SC-004**: Error reporting clearly indicates failure point in 100% of cases (Verify with US2 logging tasks)
- ✅ **SC-005**: No false positives for expected scenarios (Verify with US3 tab filtering tasks)
