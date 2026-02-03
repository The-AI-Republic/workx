# Tasks: Multi-Agent Instances for Parallel Task Execution

**Input**: Design documents from `/specs/015-multi-agent-instances/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Unit tests included as specified in plan.md for critical registry components.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root (Chrome Extension)
- Paths follow plan.md structure with new `src/core/registry/` module

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create new registry module structure and type definitions

- [X] T001 Create registry module directory structure at src/core/registry/
- [X] T002 [P] Create session types in src/core/registry/types.ts (SessionState, SessionType, SessionConfig, SessionMetadata)
- [X] T003 [P] Add session lifecycle types to src/models/types/SessionContracts.ts

---

## Phase 2: Foundational - Agent Registry Core (Blocking Prerequisites)

**Purpose**: Core AgentRegistry and AgentSession infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 Implement AgentSession class with lifecycle states in src/core/registry/AgentSession.ts
- [X] T005 Implement AgentRegistry class with Map storage in src/core/registry/AgentRegistry.ts (depends on T004)
- [X] T006 Add sessionId property to BrowserxAgent constructor in src/core/BrowserxAgent.ts
- [X] T007 [P] Create unit tests for AgentSession in tests/unit/registry/AgentSession.test.ts
- [X] T008 [P] Create unit tests for AgentRegistry in tests/unit/registry/AgentRegistry.test.ts
- [X] T009 Export registry module from src/core/registry/index.ts

**Checkpoint**: Foundation ready - AgentRegistry and AgentSession classes functional with unit tests passing

---

## Phase 3: User Story 2 - Agent Registry Manages Multiple Sessions (Priority: P1) 🎯 MVP

**Goal**: System maintains a registry of active agent instances, each identified by unique session ID

**Independent Test**: Create multiple sessions via internal API and verify each has independent state

**Why US2 First**: This is the foundational architecture that US1 (parallel execution) depends on

### Implementation for User Story 2

- [ ] T010 [US2] Replace singleton agent with AgentRegistry in src/background/service-worker.ts
- [ ] T011 [US2] Implement session factory method in AgentRegistry.createSession() in src/core/registry/AgentRegistry.ts
- [ ] T012 [US2] Add getSession(sessionId) retrieval method in src/core/registry/AgentRegistry.ts
- [ ] T013 [US2] Add getPrimarySession() method for backward compatibility in src/core/registry/AgentRegistry.ts
- [ ] T014 [US2] Implement session cleanup in removeSession(sessionId) in src/core/registry/AgentRegistry.ts
- [ ] T015 [US2] Add session lifecycle event broadcasting (created, destroyed) in src/core/registry/AgentRegistry.ts
- [ ] T016 [P] [US2] Create integration test for multi-session creation in tests/integration/multi-session.test.ts

**Checkpoint**: AgentRegistry manages multiple sessions with independent state. Can create, retrieve, and remove sessions.

---

## Phase 4: User Story 1 - Scheduled Task Runs Without Interrupting Active Session (Priority: P1)

**Goal**: Scheduled tasks execute in isolated sessions without interfering with user's active conversation

**Independent Test**: Start conversation in side panel, schedule task for 1 minute, continue conversation, verify both complete successfully

### Implementation for User Story 1

- [ ] T017 [US1] Extend message types with sessionId field in src/models/types/messages.ts
- [ ] T018 [US1] Update MessageRouter to route by sessionId in src/core/MessageRouter.ts
- [ ] T019 [US1] Add default-to-primary-session fallback for backward compatibility in src/core/MessageRouter.ts
- [ ] T019a [US1] Audit and update all message senders to include sessionId in payload (src/sidepanel/Main.svelte, src/sidepanel/App.svelte, src/core/scheduler/Scheduler.ts, src/background/service-worker.ts)
- [ ] T020 [US1] Modify Scheduler to create AgentSession for each scheduled task in src/core/scheduler/Scheduler.ts
- [ ] T021 [US1] Add scheduledTaskId to SessionConfig for task-session linking in src/core/registry/types.ts
- [ ] T022 [US1] Implement session cleanup on task completion in Scheduler in src/core/scheduler/Scheduler.ts
- [ ] T023 [US1] Update Main.svelte scheduled task detection to use session routing in src/sidepanel/Main.svelte
- [ ] T024 [P] [US1] Create integration test for parallel user + scheduled task in tests/integration/parallel-execution.test.ts

**Checkpoint**: User can have active conversation while scheduled tasks run in parallel without interference

---

## Phase 5: User Story 3 - Independent Tab Binding Per Session (Priority: P2)

**Goal**: Each agent session manages its own tab binding independently

**Independent Test**: Open two tabs, start sessions in each, verify each session operates only on its bound tab

### Implementation for User Story 3

- [ ] T025 [US3] Add sessionLetter allocation (a, b, c...) in AgentRegistry.createSession() in src/core/registry/AgentRegistry.ts
- [ ] T026 [US3] Add tabId, tabGroupId, tabGroupName fields to AgentSession metadata in src/core/registry/AgentSession.ts
- [ ] T027 [US3] Implement createTabGroup() to create Chrome tab group with name browserx_s_<letter> in src/core/registry/AgentSession.ts
- [ ] T028 [US3] Implement bindTab(tabId) method that moves tab to session's group in src/core/registry/AgentSession.ts
- [ ] T029 [US3] Implement unbindTab() method in AgentSession in src/core/registry/AgentSession.ts
- [ ] T030 [US3] Add tab closure listener per session in AgentSession in src/core/registry/AgentSession.ts
- [ ] T031 [US3] Implement session termination on tab closure (FR-022) in src/core/registry/AgentSession.ts
- [ ] T032 [US3] Clean up tab group on session termination in src/core/registry/AgentSession.ts
- [ ] T033 [US3] Update tool execution to use session's bound tab in src/core/BrowserxAgent.ts
- [ ] T034 [P] [US3] Create test for independent tab binding and tab groups in tests/integration/tab-binding.test.ts

**Checkpoint**: Multiple sessions have separate tab groups (browserx_s_a, browserx_s_b, etc.); tab closure terminates only that session

---

## Phase 6: User Story 4 - Session Persistence and Resumption (Priority: P2)

**Goal**: Sessions persist to storage and resume after service worker restarts

**Independent Test**: Start session, restart service worker, verify session resumes with history intact

### Implementation for User Story 4

- [ ] T035 [US4] Implement persistSession() method to save SessionMetadata to IndexedDB in src/core/registry/AgentSession.ts
- [ ] T036 [US4] Implement loadPersistedSessions() in AgentRegistry in src/core/registry/AgentRegistry.ts
- [ ] T037 [US4] Add resumeSession(sessionId) method in AgentRegistry in src/core/registry/AgentRegistry.ts
- [ ] T038 [US4] Persist session on state changes automatically in src/core/registry/AgentSession.ts
- [ ] T039 [US4] Load and resume sessions on service worker startup in src/background/service-worker.ts
- [ ] T040 [US4] Handle orphaned session cleanup (no connected clients) in src/core/registry/AgentRegistry.ts
- [ ] T041 [P] [US4] Create test for session persistence and resumption in tests/integration/session-persistence.test.ts

**Checkpoint**: Sessions survive service worker restarts with full conversation history preserved

---

## Phase 7: User Story 5 - Concurrent Execution Limits (Priority: P3)

**Goal**: System limits concurrent sessions to prevent resource exhaustion

**Independent Test**: Attempt to create more sessions than limit, verify proper queuing/rejection

### Implementation for User Story 5

- [ ] T042 [US5] Add maxConcurrent configuration to AgentRegistry in src/core/registry/AgentRegistry.ts
- [ ] T043 [US5] Implement canCreateSession() check in AgentRegistry in src/core/registry/AgentRegistry.ts
- [ ] T044 [US5] Add getMaxConcurrent() and setMaxConcurrent() methods in src/core/registry/AgentRegistry.ts
- [ ] T045 [US5] Throw error when session limit reached in createSession() in src/core/registry/AgentRegistry.ts
- [ ] T046 [US5] Add session limit setting to extension settings UI in src/sidepanel/Settings.svelte
- [ ] T047 [P] [US5] Create test for concurrent limit enforcement in tests/unit/registry/AgentRegistry.test.ts

**Checkpoint**: System enforces configurable session limits and provides appropriate feedback

---

## Phase 8: User Story 6 - Session Status Visibility (Priority: P3)

**Goal**: Users can see status of all active sessions in the scheduler popup

**Independent Test**: Check scheduler popup shows accurate status for multiple running tasks

### Implementation for User Story 6

- [ ] T048 [US6] Expose listSessions() via message API in src/background/service-worker.ts
- [ ] T049 [US6] Add getActiveCount() exposure via message API in src/background/service-worker.ts
- [ ] T050 [US6] Update SchedulerPopup to fetch and display session list in src/sidepanel/SchedulerPopup.svelte
- [ ] T051 [US6] Add real-time status updates using session lifecycle events in src/sidepanel/SchedulerPopup.svelte
- [ ] T052 [US6] Display session states (initializing, active, idle) in SchedulerPopup in src/sidepanel/SchedulerPopup.svelte
- [ ] T053 [US6] Show queue position for sessions waiting due to capacity limits in src/sidepanel/SchedulerPopup.svelte

**Checkpoint**: Users can view all session statuses in real-time via scheduler popup

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T054 [P] Code cleanup: Remove deprecated singleton agent references across codebase
- [ ] T055 [P] Add JSDoc documentation to AgentRegistry and AgentSession classes
- [ ] T056 Performance validation: Verify <100ms overhead with concurrent sessions (SC-006)
- [ ] T057 Error handling: Ensure graceful degradation when sessions fail
- [ ] T058 Run quickstart.md validation scenarios manually

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Story 2 (Phase 3)**: Depends on Foundational - provides registry infrastructure
- **User Story 1 (Phase 4)**: Depends on US2 completion (needs registry to create task sessions)
- **User Story 3 (Phase 5)**: Depends on Foundational - can run parallel to US1/US2 after foundation
- **User Story 4 (Phase 6)**: Depends on Foundational - can run parallel to other stories after foundation
- **User Story 5 (Phase 7)**: Depends on US2 (limit enforcement on registry)
- **User Story 6 (Phase 8)**: Depends on US2 and US5 (status display needs registry + limits)
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

```
Phase 1: Setup
    ↓
Phase 2: Foundational (AgentRegistry Core)
    ↓
Phase 3: US2 - Agent Registry ← MVP Entry Point
    ↓
Phase 4: US1 - Parallel Execution (depends on US2)
    ↓
Phase 5: US3 - Tab Binding (can start after Phase 2)
Phase 6: US4 - Persistence (can start after Phase 2)
    ↓
Phase 7: US5 - Concurrent Limits (depends on US2)
    ↓
Phase 8: US6 - Status Visibility (depends on US2, US5)
    ↓
Phase 9: Polish
```

### Within Each User Story

- Tests (if included) written alongside implementation
- Core data structures before services
- Services before API/UI integration
- Validate story independently before next story

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tests (T007, T008) can run in parallel with each other
- Once Foundational phase completes:
  - US3 (Tab Binding) and US4 (Persistence) can start in parallel
  - US2 must complete before US1, US5, US6
- Within each story, tasks marked [P] can run in parallel

---

## Parallel Example: Phase 2 (Foundational)

```bash
# Sequential: Core implementation
Task T004: "Implement AgentSession class with lifecycle states"
Task T005: "Implement AgentRegistry class with Map storage" (depends on T004)
Task T006: "Add sessionId property to BrowserxAgent constructor"

# Parallel: Tests (after T004, T005)
Task T007: "Create unit tests for AgentSession"
Task T008: "Create unit tests for AgentRegistry"
```

---

## Implementation Strategy

### MVP First (User Story 2 + User Story 1)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 2 (Registry)
4. Complete Phase 4: User Story 1 (Parallel Execution)
5. **STOP and VALIDATE**: Test scheduled task + active session in parallel
6. Deploy/demo if ready - core problem solved!

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 2 → Test registry independently
3. Add User Story 1 → Test parallel execution → **MVP Complete!**
4. Add User Story 3 → Test tab binding → Enhanced stability
5. Add User Story 4 → Test persistence → Service worker resilience
6. Add User Story 5 → Test limits → Production readiness
7. Add User Story 6 → Test visibility → User experience polish

### Critical Path

```
Setup → Foundational → US2 (Registry) → US1 (Parallel) = MVP
                                              ↓
                         US3 + US4 can proceed in parallel
                                              ↓
                         US5 → US6 = Full feature
```

---

## Summary

| Phase | User Story | Priority | Task Count | Parallel Tasks |
|-------|------------|----------|------------|----------------|
| 1 | Setup | - | 3 | 2 |
| 2 | Foundational | - | 6 | 2 |
| 3 | US2: Agent Registry | P1 | 7 | 1 |
| 4 | US1: Parallel Execution | P1 | 9 | 1 |
| 5 | US3: Tab Binding + Tab Groups | P2 | 10 | 1 |
| 6 | US4: Persistence | P2 | 7 | 1 |
| 7 | US5: Concurrent Limits | P3 | 6 | 1 |
| 8 | US6: Status Visibility | P3 | 6 | 0 |
| 9 | Polish | - | 5 | 2 |

**Total**: 59 tasks
**MVP Scope**: Phases 1-4 (25 tasks) - Registry + Parallel Execution
**Full Feature**: All phases (58 tasks)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US2 is implemented before US1 because US1 depends on the registry infrastructure
