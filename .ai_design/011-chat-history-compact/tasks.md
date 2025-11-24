# Tasks: Chat History Compaction

**Input**: Design documents from `/specs/011-chat-history-compact/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in specification - tests are NOT included.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root (Chrome extension)
- New module: `src/core/compact/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the compaction module structure and shared types

- [x] T001 Create compaction module directory structure at src/core/compact/
- [x] T002 [P] Create compaction types in src/core/compact/types.ts (CompactionConfig, CompactionResult, CompactedHistory, CompactionTrigger)
- [x] T003 [P] Create compaction constants in src/core/compact/constants.ts (SUMMARIZATION_PROMPT, SUMMARY_PREFIX, NO_SUMMARY_PLACEHOLDER, DEFAULT_COMPACTION_CONFIG)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core components that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Add compaction state fields to SessionState in src/core/session/state/SessionState.ts (compactionCount, lastCompactionTime, lastCompactionTokensSaved)
- [x] T005 Add compaction state methods to SessionState: incrementCompactionCount(), getCompactionCount(), resetCompactionState()
- [x] T006 Implement token approximation helper function in src/core/compact/utils.ts (approxTokenCount using word count * 1.3)
- [x] T007 Implement text truncation helper in src/core/compact/utils.ts (truncateText with token limit and TRUNCATION_MARKER)
- [x] T008 [P] Implement isSummaryMessage helper in src/core/compact/utils.ts (checks SUMMARY_PREFIX)
- [x] T009 [P] Implement backoff helper in src/core/compact/utils.ts (exponential backoff calculation)

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Automatic Context Compaction (Priority: P1) 🎯 MVP

**Goal**: System automatically compacts history at 90% context threshold using LLM summarization

**Independent Test**: Start conversation, perform actions until 90% threshold, verify compaction triggers and conversation continues

### Implementation for User Story 1

- [x] T010 [US1] Implement SummaryGenerator class in src/core/compact/SummaryGenerator.ts with generateSummary() method
- [x] T011 [US1] Add collectUserMessages() method to SummaryGenerator to extract user messages from history (filtering summaries)
- [x] T012 [US1] Add formatSummaryWithPrefix() method to SummaryGenerator to prepend SUMMARY_PREFIX
- [x] T013 [US1] Implement HistoryReconstructor class in src/core/compact/HistoryReconstructor.ts with extractInitialContext() method
- [x] T014 [US1] Add buildHistory() method to HistoryReconstructor to assemble compacted history
- [x] T015 [US1] Add toResponseItems() method to HistoryReconstructor to convert CompactedHistory to flat array
- [x] T016 [US1] Implement CompactService class in src/core/compact/CompactService.ts with shouldCompact() method (90% threshold check)
- [x] T017 [US1] Add compact() method to CompactService orchestrating summary generation, history reconstruction, and error handling
- [x] T018 [US1] Add buildCompactedHistory() method to CompactService as public interface
- [x] T019 [US1] Implement retry logic with exponential backoff in CompactService.compact() (FR-010)
- [x] T020 [US1] Implement context overflow handling in CompactService - trim oldest items and retry (FR-006)
- [x] T021 [US1] Add auto-compaction trigger check in TaskRunner.processTurn() in src/core/TaskRunner.ts
- [x] T022 [US1] Add triggerCompaction() private method to TaskRunner to execute compaction flow
- [x] T023 [US1] Update Session.replaceHistory() usage in TaskRunner after successful compaction
- [x] T024 [US1] Add debug logging for compaction events in CompactService (FR-012: trigger reason, tokens before/after, items trimmed, status)

**Checkpoint**: Automatic compaction at 90% threshold is functional

---

## Phase 4: User Story 2 - Preserved User Messages After Compaction (Priority: P2)

**Goal**: Recent user messages preserved within token budget after compaction

**Independent Test**: Have conversation, trigger compaction, verify recent user messages exist in new history

### Implementation for User Story 2

- [x] T025 [US2] Implement selectUserMessages() method in HistoryReconstructor in src/core/compact/HistoryReconstructor.ts
- [x] T026 [US2] Add token budget tracking in selectUserMessages() - prioritize most recent messages up to 20k tokens
- [x] T027 [US2] Add truncateMessage() method to HistoryReconstructor for long messages exceeding remaining budget
- [x] T028 [US2] Update buildHistory() to include preserved user messages between initial context and summary
- [x] T029 [US2] Add userMessageBudget to CompactionConfig and wire through CompactService

**Checkpoint**: User messages are preserved within budget after compaction

---

## Phase 5: User Story 3 - Compaction Transparency (Priority: P3)

**Goal**: Users notified when compaction occurs with relevant details

**Independent Test**: Trigger compaction, verify notification appears with token reduction and items trimmed

### Implementation for User Story 3

- [x] T030 [US3] Add CompactionCompletedEvent type to src/protocol/events.ts for UI notification
- [x] T031 [US3] Add notifyCompactionComplete() method to TaskRunner to send notification event
- [x] T032 [US3] Display compaction notification in sidepanel UI in src/sidepanel/App.svelte (FR-007)
- [x] T033 [US3] Add multi-compaction warning logic - check compactionCount > 1 and show accuracy warning (FR-008)
- [x] T034 [US3] Add manual compaction button to sidepanel UI in src/sidepanel/App.svelte (FR-002)
- [x] T035 [US3] Wire manual compaction button to send ManualCompact submission to service worker
- [x] T036 [US3] Handle ManualCompact submission in BrowserxAgent.ts, triggering compaction with 'manual' reason

**Checkpoint**: Users receive notifications and can manually trigger compaction

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T037 [P] Create index.ts barrel export in src/core/compact/index.ts
- [x] T038 Invalidate cached state after compaction in TaskRunner (FR-009)
- [x] T039 Add config getter/setter methods to CompactService (getConfig, updateConfig)
- [x] T040 Run quickstart.md validation - verify integration guide matches implementation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - Core compaction mechanism
- **User Story 2 (P2)**: Can start after US1 T015 (HistoryReconstructor.toResponseItems) - Enhances history reconstruction
- **User Story 3 (P3)**: Can start after US1 T017 (CompactService.compact) - Adds UI layer on top of core

### Within Each User Story

- Core classes before orchestration
- Orchestration before integration points
- Integration before UI

### Parallel Opportunities

**Phase 1 (Setup)**:
```
T002 (types.ts) || T003 (constants.ts)
```

**Phase 2 (Foundational)**:
```
T006 → T007 (sequential - utils build on each other)
T008 (isSummaryMessage) || T009 (backoff) - can run in parallel
```

**User Story 1** - Sequential due to class dependencies:
```
T010 → T011 → T012 (SummaryGenerator)
T013 → T014 → T015 (HistoryReconstructor)
T016 → T017 → T018 → T019 → T020 (CompactService)
T021 → T022 → T023 → T024 (TaskRunner integration)
```

**User Story 2** - Sequential:
```
T025 → T026 → T027 → T028 → T029
```

**User Story 3** - Parallel UI tasks:
```
T030 → T031 (notification event)
T034 || T032 || T033 (UI components can be built in parallel)
T035 → T036 (wiring depends on button)
```

---

## Parallel Example: Phase 1 Setup

```bash
# Launch in parallel:
Task: "Create compaction types in src/core/compact/types.ts"
Task: "Create compaction constants in src/core/compact/constants.ts"
```

## Parallel Example: User Story 3

```bash
# Launch in parallel (different files):
Task: "Display compaction notification in sidepanel UI in src/sidepanel/App.svelte"
Task: "Add manual compaction button to sidepanel UI in src/sidepanel/App.svelte"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test automatic compaction at 90% threshold
5. Deploy/demo if ready - conversations can now exceed context limits!

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test auto-compaction → Deploy (MVP!)
3. Add User Story 2 → Test user message preservation → Deploy
4. Add User Story 3 → Test notifications + manual trigger → Deploy
5. Each story adds value without breaking previous stories

### File Touch Summary

| File | Stories | Tasks |
|------|---------|-------|
| src/core/compact/types.ts | Setup | T002 |
| src/core/compact/constants.ts | Setup | T003 |
| src/core/compact/utils.ts | Foundation | T006, T007, T008, T009 |
| src/core/session/state/SessionState.ts | Foundation | T004, T005 |
| src/core/compact/SummaryGenerator.ts | US1 | T010, T011, T012 |
| src/core/compact/HistoryReconstructor.ts | US1, US2 | T013, T014, T015, T025, T026, T027, T028 |
| src/core/compact/CompactService.ts | US1, US2 | T016, T017, T018, T019, T020, T029, T039 |
| src/core/TaskRunner.ts | US1, US3 | T021, T022, T023, T024, T031, T038 |
| src/protocol/types.ts | US3 | T030 |
| src/sidepanel/App.svelte | US3 | T032, T033, T034, T035 |
| src/core/compact/index.ts | Polish | T037 |

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- FR references map to Functional Requirements in spec.md
