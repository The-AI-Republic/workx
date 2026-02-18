# Tasks: Seamless Model Switch

**Input**: Design documents from `/specs/024-seamless-model-switch/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Tests are included as they align with Constitution Principle III (Test-Driven Quality).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: Shared type and interface changes that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T001 [P] Add optional `modelKey` field to the `message` variant of the ResponseItem union type in src/core/protocol/types.ts. The field is `modelKey?: string` and represents a composite key in format `"providerId:modelIdentifier"`. Only the `message` type variant needs this field. Preserve all existing fields. This is a backward-compatible additive change.

- [X] T002 [P] Add `setModelClient(client: ModelClient): void` method to TurnContext in src/core/TurnContext.ts. This method replaces the internal `modelClient` reference so that subsequent calls to `getModelClient()` and `getModel()` return values from the new client. This is needed for cross-provider switching where `setModel()` alone is insufficient (different ModelClient class required). Import ModelClient type if not already imported.

**Checkpoint**: Foundation ready — type system and TurnContext support model switching

---

## Phase 2: User Story 1 - Conversation Continuity Across Model Switch (Priority: P1) MVP

**Goal**: Model switching preserves conversation history and the new model receives full context of prior messages.

**Independent Test**: Start a conversation with Model A, switch to Model B, send a follow-up. Model B responds with awareness of all prior messages. No confirmation dialog appears.

### Implementation for User Story 1

- [ ] T003 [US1] Rewrite `handleModelConfigChange()` in src/core/BrowserxAgent.ts (lines 278-312). Remove `session.shutdown()`, `session.clearHistory()`, new TurnContext creation, and `session.initializeSession()`. Replace with: (1) create new ModelClient via `this.modelClientFactory.createClientForCurrentModel()`, (2) call `this.session.getTurnContext().setModelClient(newClient)` to update the existing TurnContext. Wrap in try/catch — on failure, emit error event and leave current model unchanged. Do NOT touch conversation history or session state.

- [ ] T004 [US1] Update `saveModel()` success message in src/extension/sidepanel/settings/ModelSettings.svelte. If there is a confirmation dialog about clearing conversation, remove it. Update the success notification text to reflect that conversation is preserved (e.g., "Model changed successfully! Conversation preserved." instead of any warning about clearing). The `notifyConfigUpdate()` call and `AgentConfig.setSelectedModel()` call remain unchanged.

- [ ] T005 [US1] Annotate assistant response items with `modelKey` in src/core/TurnManager.ts. Find where assistant response items (type: 'message', role: 'assistant') are constructed or recorded after an LLM response. Before recording, set `item.modelKey = this.turnContext.getModel()` (or equivalent composite key from the TurnContext). This ensures every assistant message carries the model identity for persistence and display.

- [ ] T006 [US1] Verify that `Session.recordConversationItemsDual()` in src/core/Session.ts correctly persists ResponseItems with the new `modelKey` field to both SessionState (in-memory) and RolloutRecorder (IndexedDB). Since `modelKey` is just an optional field on ResponseItem and both stores serialize the full object, this should work without code changes — but verify by reading the recording code path and confirming no field stripping occurs. If any serialization strips unknown fields, add `modelKey` to the allow-list.

**Checkpoint**: At this point, model switching preserves conversation and the new model gets full history context. Testable independently per quickstart.md Test 1 and Test 4.

---

## Phase 3: User Story 2 - Mid-Task Model Switch Protection (Priority: P2)

**Goal**: When a model switch occurs while a task is actively running, the task completes with the original model. The new model applies only on the next user submission.

**Independent Test**: Trigger a long-running task, switch models during execution, verify task completes with original model. Send a new message and verify it uses the new model.

### Implementation for User Story 2

- [ ] T007 [US2] Add `pendingModelKey: string | null` private field to BrowserxAgent class in src/core/BrowserxAgent.ts. Initialize to `null` in the constructor. This field stores the user's model selection when a switch occurs during an active task.

- [ ] T008 [US2] Modify `handleModelConfigChange()` in src/core/BrowserxAgent.ts to check for running tasks before applying the model switch. Use `this.session.getRunningTasks().size > 0` (or `this.session.isActiveTurn()`) to detect active tasks. If a task IS running: store `this.pendingModelKey = event.newValue` and return without changing the TurnContext. If NO task is running: apply the switch immediately (reuse the logic from T003). This ensures rapid switches (A→B→C) always resolve to the last value since `pendingModelKey` is overwritten each time.

- [ ] T009 [US2] Add pending model application logic to the user submission processing path in src/core/BrowserxAgent.ts. Find the method that processes user submissions (the submission queue handler). Before dispatching a new task, check if `this.pendingModelKey !== null`. If pending: create a new ModelClient for the pending model key via `this.modelClientFactory.createClientForCurrentModel()`, call `turnContext.setModelClient(newClient)`, then set `this.pendingModelKey = null`. Then proceed with normal submission processing using the updated model.

- [ ] T010 [US2] Handle edge case: model switch during pending user approval. In the approval handling path in src/core/BrowserxAgent.ts, ensure that a pending model switch does NOT affect the currently awaiting approval. The approval MUST be processed with the original model's TurnContext. Only after the current turn completes and a new user message arrives should the pending model take effect. Verify this is naturally handled by the deferred approach (T008/T009) — the pending model is only applied on new submissions, not on approval responses.

**Checkpoint**: Mid-task model switches are safely deferred. Testable independently per quickstart.md Test 2.

---

## Phase 4: User Story 3 - Visual Model Indicator in Conversation (Priority: P3)

**Goal**: Each assistant response in the chat thread displays a small indicator showing which model generated it.

**Independent Test**: Start a conversation, switch models, send messages with each model. Each response shows the correct model name label.

### Implementation for User Story 3

- [ ] T011 [US3] Add a model indicator label to assistant message rendering in src/extension/sidepanel/pages/chat/Main.svelte. For each assistant message in the chat thread, read the `modelKey` field from the ResponseItem. Display a small, unobtrusive label below or beside the message showing a human-readable model name (extract the model identifier portion after the colon in "providerId:modelId", e.g., "gpt-5.1" from "openai:gpt-5.1"). If `modelKey` is missing (legacy messages), display nothing or "unknown model". Style the label with muted/secondary text color and small font size using Tailwind CSS utility classes.

**Checkpoint**: All user stories should now be independently functional.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Tests, validation, and cleanup

- [ ] T012 [P] Create unit tests for `TurnContext.setModelClient()` in tests/unit/core/TurnContext.test.ts (or new file if TurnContext tests don't exist). Test: (1) setModelClient replaces the client, (2) getModel() returns new model after set, (3) getModelClient() returns new client after set.

- [ ] T013 [P] Create unit tests for the rewritten `handleModelConfigChange()` in tests/unit/core/BrowserxAgent.model-switch.test.ts (new file). Test: (1) model switch without active task applies immediately, (2) model switch with active task stores pendingModelKey, (3) pendingModelKey is applied on next submission, (4) rapid switches A→B→C resolves to C, (5) conversation history is NOT cleared on model switch.

- [ ] T014 [P] Create integration test for seamless model switch flow in tests/integration/seamless-model-switch.test.ts (new file). Test the end-to-end flow: create a session, record some conversation history, trigger a model config change event, verify history is preserved, verify TurnContext has new model. If possible, test that the ResponseItem modelKey annotation is persisted through the rollout recorder.

- [ ] T015 Run `npm test && npm run lint` to verify all existing tests still pass and no lint errors are introduced. Fix any type errors from the ResponseItem change (callers constructing message-type ResponseItems may need to handle the new optional field).

- [ ] T016 Run quickstart.md validation: manually verify Test 1 (basic switch), Test 2 (mid-task switch), Test 3 (model indicator), and Test 4 (cross-provider switch) pass as described.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — can start immediately. BLOCKS all user stories.
- **User Story 1 (Phase 2)**: Depends on Phase 1 completion (T001, T002).
- **User Story 2 (Phase 3)**: Depends on Phase 2 completion (builds on T003's rewritten method).
- **User Story 3 (Phase 4)**: Depends on Phase 1 (T001 for modelKey field) and Phase 2 (T005 for modelKey annotation). Can start in parallel with US2 if T001+T005 are done.
- **Polish (Phase 5)**: Depends on all user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Depends on Foundational (T001, T002) only — no other story dependencies
- **User Story 2 (P2)**: Depends on US1 (T003 specifically — extends the same method)
- **User Story 3 (P3)**: Depends on T001 (type change) and T005 (annotation). Can run in parallel with US2.

### Within Each User Story

- Models/types before services
- Core implementation before UI
- Verify persistence before assuming it works

### Parallel Opportunities

- T001 and T002 can run in parallel (different files)
- T012, T013, T014 can all run in parallel (different test files)
- US3 (T011) can run in parallel with US2 (T007-T010) once T005 is complete

---

## Parallel Example: Phase 1

```bash
# Launch foundational tasks together:
Task: "Add modelKey to ResponseItem in src/core/protocol/types.ts"
Task: "Add setModelClient to TurnContext in src/core/TurnContext.ts"
```

## Parallel Example: Phase 5

```bash
# Launch all test tasks together:
Task: "Unit tests for TurnContext.setModelClient in tests/unit/core/TurnContext.test.ts"
Task: "Unit tests for handleModelConfigChange in tests/unit/core/BrowserxAgent.model-switch.test.ts"
Task: "Integration test in tests/integration/seamless-model-switch.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational (T001, T002)
2. Complete Phase 2: User Story 1 (T003-T006)
3. **STOP and VALIDATE**: Test model switching preserves history
4. Build and test in Chrome

### Incremental Delivery

1. Phase 1 → Foundation ready
2. Phase 2 (US1) → Conversation continuity works (MVP!)
3. Phase 3 (US2) → Mid-task protection added
4. Phase 4 (US3) → Model indicator displayed
5. Phase 5 → Tests and validation
6. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- T006 is a verification task — may require no code changes
- T010 is an edge case verification — may be naturally handled by T008/T009
- T016 requires a built extension loaded in Chrome for manual testing
- Context window overflow is explicitly OUT OF SCOPE (FR-008)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
