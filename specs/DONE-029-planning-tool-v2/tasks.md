# Tasks: PlanningTool V2

**Input**: Design documents from `/specs/029-planning-tool-v2/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Extend type definitions and storage schema to support the enriched plan model

- [ ] T001 [P] Extend StepStatus enum with `Blocked` value and add PlanAction enum (`create`, `update`, `resume`), PlanStatus enum (`active`, `completed`), and StoredPlan interface in `src/core/protocol/events.ts`
- [ ] T002 [P] Extend PlanItemArg interface with optional `id`, `files`, `reuse`, `verification`, `activeDescription`, and `dependsOn` fields in `src/core/protocol/events.ts`
- [ ] T003 [P] Extend UpdatePlanArgs interface with required `action` field (PlanAction) and update `plan` to be conditional (required for create/update, ignored for resume) in `src/core/protocol/events.ts`
- [ ] T004 [P] Add StoredPlan type to `src/types/storage.ts` matching the IndexedDB storage schema from data-model.md (id, sessionId, status, explanation, steps, version, createdAt, updatedAt)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Storage infrastructure that MUST be complete before any user story can be implemented

**Warning**: No user story work can begin until this phase is complete

- [ ] T005 Add `plans` object store to IndexedDBAdapter with `sessionId` as keyPath, bump DB_VERSION from 3 to 4 with version-guarded migration in `src/storage/IndexedDBAdapter.ts`
- [ ] T006 Create PlanStore class with get(sessionId), save(plan), delete(sessionId) methods, in-memory Map fallback when IndexedDB is unavailable, and version counter auto-increment on save in `src/storage/PlanStore.ts`

**Checkpoint**: Storage layer ready — plan persistence can now be implemented

---

## Phase 3: User Story 1 - Persistent Plans That Survive Session Loss (Priority: P1) MVP

**Goal**: Plans are stored in IndexedDB and survive sidebar close/reopen. The agent can create, update, and resume plans with the enriched schema.

**Independent Test**: Create a plan, close the sidebar, reopen it, verify the plan state is intact with all step statuses and metadata preserved.

### Implementation for User Story 1

- [ ] T007 [US1] Update PLANNING_TOOL_DEFINITION.description with full behavioral guidance text from contracts/internal-api.md (when to plan, how to create/update/resume, what metadata to include) in `src/tools/PlanningTool.ts`
- [ ] T008 [US1] Update PLANNING_TOOL_DEFINITION.inputSchema to add `action` (required), `id` on steps, and all optional step fields (`files`, `reuse`, `verification`, `activeDescription`, `dependsOn`) in `src/tools/PlanningTool.ts`
- [ ] T009 [US1] Refactor PlanningTool.executeImpl to dispatch on `action` field: route to handleCreate, handleUpdate, handleResume private methods in `src/tools/PlanningTool.ts`
- [ ] T010 [US1] Implement handleCreate: auto-generate UUIDs for plan and steps, set plan status to `active`, persist via PlanStore.save(), emit PlanUpdate event, return success response in `src/tools/PlanningTool.ts`
- [ ] T011 [US1] Implement handleUpdate: load existing plan from PlanStore, merge step status changes, increment version, persist via PlanStore.save(), emit PlanUpdate event in `src/tools/PlanningTool.ts`
- [ ] T012 [US1] Implement handleResume: load plan from PlanStore.get(sessionId), return full plan data if exists or null response if no plan exists in `src/tools/PlanningTool.ts`
- [ ] T013 [US1] Wire PlanStore into PlanningTool constructor (dependency injection or lazy initialization) and handle storage unavailability with in-memory fallback warning in `src/tools/PlanningTool.ts`
- [ ] T014 [US1] Update PlanUpdate event emission to include action, planId, version, and plan status in the event payload per the Event Contract in contracts/internal-api.md in `src/tools/PlanningTool.ts`
- [ ] T015 [US1] Load persisted plan from PlanStore on sidebar reopen and emit PlanUpdate event to restore UI display in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`

**Checkpoint**: Plans persist across sidebar close/reopen. Agent can create, update, and resume plans. MVP complete.

---

## Phase 4: User Story 2 - Agent Always Knows the Current Plan (Priority: P1)

**Goal**: The current plan is automatically injected into the system prompt at the start of each agent turn, so the agent can reference plan state without calling a tool.

**Independent Test**: Verify the system prompt contains the current plan content before the agent's first response, and that the agent references plan state without calling planning_tool with resume.

### Implementation for User Story 2

- [ ] T016 [US2] Extend RuntimeContext interface with optional `currentPlan: StoredPlan` field in `src/prompts/PromptComposer.ts`
- [ ] T017 [US2] Implement buildPlanContext(plan: StoredPlan) method that formats plan as structured text with status markers ([checkmark], [arrow], [dot], [x]), indented metadata fields, and numbered steps per the Prompt Injection Contract in contracts/internal-api.md in `src/prompts/PromptComposer.ts`
- [ ] T018 [US2] Add conditional plan section to composeMainInstruction() — insert after task execution policies section, only when context.currentPlan is defined, using buildPlanContext() output in `src/prompts/PromptComposer.ts`
- [ ] T019 [US2] Load current plan from PlanStore in TurnManager before calling composeMainInstruction() and pass it as context.currentPlan in `src/core/TurnManager.ts`

**Checkpoint**: Agent sees the current plan in every turn. Combined with US1, the agent has persistent, context-aware planning.

---

## Phase 5: User Story 3 - Richer Plan Steps with Context (Priority: P2)

**Goal**: The UI renders enriched step metadata (file references, reuse references, verification descriptions) when present, and displays cleanly when absent.

**Independent Test**: Have the agent create a plan with file references and verification descriptions, verify the UI renders them. Create a plan without optional fields, verify no empty placeholders.

### Implementation for User Story 3

- [ ] T020 [P] [US3] Update PlanEvent.svelte to render `files` array as a list of file path elements (monospace, muted color) below each step description in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`
- [ ] T021 [P] [US3] Update PlanEvent.svelte to render `reuse` array as reference links below step description (similar style to files, distinct label) in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`
- [ ] T022 [P] [US3] Update PlanEvent.svelte to render `verification` string as a muted verification criteria line below step description in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`
- [ ] T023 [US3] Ensure all optional field rendering in PlanEvent.svelte uses conditional blocks ({#if}) so absent fields produce no DOM elements or empty whitespace in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`

**Checkpoint**: UI displays rich plan metadata. Plans are visually informative and actionable.

---

## Phase 6: User Story 4 - Steps with Dependencies (Priority: P3)

**Goal**: Steps can declare dependencies via `dependsOn`. Circular dependencies are rejected. Blocked steps are visualized in the UI.

**Independent Test**: Create a plan with dependsOn references, verify blocked steps show correctly. Submit a circular dependency, verify validation error.

### Implementation for User Story 4

- [ ] T024 [US4] Implement detectCycle(steps: PlanStep[]) utility function using DFS with visited/in-stack tracking, returning the cycle path string on detection or null if valid DAG in `src/tools/PlanningTool.ts`
- [ ] T025 [US4] Add dependsOn validation to handleCreate and handleUpdate: verify all referenced IDs exist in the plan, run detectCycle, return VALIDATION_ERROR with cycle path if detected in `src/tools/PlanningTool.ts`
- [ ] T026 [US4] Implement deriveBlockedStatus(steps: PlanStep[]) that sets status to `Blocked` for any step whose dependsOn includes incomplete steps, and unblocks steps whose dependencies are all Completed in `src/tools/PlanningTool.ts`
- [ ] T027 [US4] Update PlanEvent.svelte to render `Blocked` status with [x] marker (distinct color, e.g., orange/amber), show "blocked by: step N, step M" text below the step in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`

**Checkpoint**: Dependency graph is validated and visualized. Agent can express parallel vs sequential step relationships.

---

## Phase 7: User Story 5 - Active Step Description in UI (Priority: P3)

**Goal**: InProgress steps with an activeDescription show an animated indicator with the present-tense description text.

**Independent Test**: Set a step to InProgress with activeDescription, verify spinner and text appear. Complete the step, verify animation is removed.

### Implementation for User Story 5

- [ ] T028 [US5] Update PlanEvent.svelte to render `activeDescription` text in italics/muted next to the step description when status is InProgress and activeDescription is present in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`
- [ ] T029 [US5] Add CSS spinner animation (small inline rotating indicator) next to InProgress steps that have an activeDescription, replacing the static arrow marker in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`
- [ ] T030 [US5] Ensure steps without activeDescription still show the standard arrow marker and steps transitioning to Completed remove the spinner and show checkmark in `src/extension/sidepanel/components/event_display/PlanEvent.svelte`

**Checkpoint**: Active step descriptions provide real-time awareness of agent activity.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, graceful degradation, and validation

- [ ] T031 Handle edge case: `action: update` with no existing plan in storage — treat as `create` and log warning in `src/tools/PlanningTool.ts`
- [ ] T032 Handle edge case: IndexedDB unavailable — PlanStore falls back to in-memory Map, PlanningTool returns success with `warning` field in response in `src/storage/PlanStore.ts`
- [ ] T033 Handle edge case: race condition on rapid plan updates — ensure PlanStore.save() uses version counter check (last-write-wins) in `src/storage/PlanStore.ts`
- [ ] T034 Run quickstart.md verification scenarios (all 7 scenarios) and validate against acceptance criteria in spec.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately. All T001-T004 are parallel.
- **Foundational (Phase 2)**: Depends on Phase 1 (T001-T004) for type definitions. T005 and T006 are sequential (T006 depends on T005).
- **US1 (Phase 3)**: Depends on Phase 2 (PlanStore must exist). Tasks T007-T008 are parallel, T009-T014 are sequential.
- **US2 (Phase 4)**: Depends on Phase 2 (PlanStore for loading). Can run in parallel with US1 Phase 3.
- **US3 (Phase 5)**: Depends on Phase 1 (extended types). UI-only changes, can run in parallel with US1/US2.
- **US4 (Phase 6)**: Depends on Phase 3 (needs handleCreate/handleUpdate). T024-T026 are sequential, T027 is parallel (UI).
- **US5 (Phase 7)**: Depends on Phase 1 (activeDescription type). UI-only, can run in parallel with US3/US4.
- **Polish (Phase 8)**: Depends on all user stories being complete.

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational (Phase 2) — no dependencies on other stories
- **US2 (P1)**: Can start after Foundational (Phase 2) — independent of US1 but ideally both complete for MVP
- **US3 (P2)**: Can start after Setup (Phase 1) — UI-only, no dependency on persistence
- **US4 (P3)**: Depends on US1 (needs create/update handlers for DAG validation integration)
- **US5 (P3)**: Can start after Setup (Phase 1) — UI-only, no dependency on persistence

### Parallel Opportunities

- T001, T002, T003, T004 can all run in parallel (different type additions, same file but different sections)
- T007, T008 can run in parallel (tool description vs schema, same file but different constants)
- T020, T021, T022 can run in parallel (different UI elements in PlanEvent.svelte)
- US2 (Phase 4) and US3 (Phase 5) can run in parallel with US1 (Phase 3)
- US5 (Phase 7) can run in parallel with US4 (Phase 6)

---

## Parallel Example: User Story 3

```bash
# Launch all UI enrichment tasks together (different rendering sections):
Task: "Render files array in PlanEvent.svelte"
Task: "Render reuse array in PlanEvent.svelte"
Task: "Render verification string in PlanEvent.svelte"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup (type definitions)
2. Complete Phase 2: Foundational (IndexedDB store + PlanStore)
3. Complete Phase 3: US1 — Plan Persistence
4. Complete Phase 4: US2 — System Prompt Injection
5. **STOP and VALIDATE**: Test plan persistence and prompt injection independently
6. Deploy/demo if ready — this alone is a significant improvement

### Incremental Delivery

1. Setup + Foundational → Storage ready
2. US1 + US2 → Plans persist and agent sees them (MVP!)
3. US3 → Rich UI metadata rendering
4. US4 → Dependency graph validation and visualization
5. US5 → Active step animation polish
6. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files or non-overlapping sections, no dependencies
- [Story] label maps task to specific user story for traceability
- No test tasks included (not explicitly requested) — existing PlanningTool.test.ts should be updated alongside implementation
- The tool description update (T007) is critical for agent behavior — without it, the agent won't know how to use the new features
- PlanEvent.svelte changes (T020-T023, T027-T030) are all UI-only and can be validated visually
- Commit after each task or logical group
