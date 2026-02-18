# Tasks: ResponseItem Provider-Agnostic Architecture Audit

**Input**: Design documents from `/specs/026-provider-agnostic-audit/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Tests ARE the primary deliverable for this audit feature (FR-010 explicitly requires guard-rail tests).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Discover all files that reference ResponseItem and set up the test scaffold

- [ ] T001 Discover all source files importing or referencing ResponseItem by searching `src/**/*.ts` (excluding `__tests__/` and `node_modules/`). Categorize each file as: client class (`src/core/models/client/`), type definition, shared component, or other. Output a categorized list for use in subsequent test tasks.
- [ ] T002 Create the architectural guard-rail test file scaffold at `src/core/models/__tests__/provider-agnostic.architecture.test.ts`. Define the banned provider SDK import patterns (`openai`, `@google/genai`, `@anthropic-ai/sdk`, `groq-sdk`, `fireworks`, `together-ai`) and the allowed provider directory (`src/core/models/client/`) as test-level constants. Include empty `describe` blocks for: "ResponseItem Import Boundary", "Shared Component Isolation", "Client Containment", "Field Neutrality". Use `fs.readFileSync` and `path.resolve` for file reading. Follow existing Vitest patterns (globals enabled, no explicit imports for describe/it/expect).

**Checkpoint**: Test file scaffold exists with constants defined and empty test groups ready to fill

---

## Phase 2: User Story 1 - Verify ResponseItem Contains No Provider-Specific Concerns (Priority: P1)

**Goal**: Confirm that the ResponseItem type definition in `src/core/protocol/types.ts` contains zero provider-specific types, imports, or logic

**Independent Test**: Run `npm test -- --run src/core/models/__tests__/provider-agnostic.architecture.test.ts` and verify all US1 tests pass

### Tests for User Story 1

- [ ] T003 [US1] Write test "ResponseItem type definition has zero provider SDK imports" in `src/core/models/__tests__/provider-agnostic.architecture.test.ts` under the "ResponseItem Import Boundary" describe block. Read `src/core/protocol/types.ts` with `fs.readFileSync`, extract all `import` and `from` statements, and assert none match the banned provider SDK patterns. Test must fail if any provider SDK import is added to types.ts in the future.
- [ ] T004 [P] [US1] Write test "ResponseItem field names are provider-neutral" in `src/core/models/__tests__/provider-agnostic.architecture.test.ts` under the "Field Neutrality" describe block. Parse the ResponseItem type definition from `src/core/protocol/types.ts`, extract all field/property names, and assert none contain provider name substrings (openai, gemini, groq, anthropic, fireworks, together, google, xai). Allow known acceptable fields: `thoughtSignature` (documented opaque metadata).
- [ ] T005 [P] [US1] Write test "ResponseItem metadata fields are opaque types" in `src/core/models/__tests__/provider-agnostic.architecture.test.ts` under the "Field Neutrality" describe block. Verify that `thoughtSignature`, `reasoning_content`, and `encrypted_content` fields use primitive types (string) and do not reference any provider-specific type aliases or interfaces.

### Implementation for User Story 1

- [ ] T006 [US1] Run the US1 tests. If any test fails, audit `src/core/protocol/types.ts` to identify the violation and fix it by replacing provider-specific references with generic alternatives. Re-run tests until all pass.

**Checkpoint**: All ResponseItem type definition boundary tests pass. types.ts confirmed provider-agnostic.

---

## Phase 3: User Story 2 - Verify Client Classes Own All Provider-Specific Conversion (Priority: P1)

**Goal**: Confirm that all provider-specific conversion logic lives exclusively within `src/core/models/client/` and that shared components contain zero provider-specific concerns

**Independent Test**: Run `npm test -- --run src/core/models/__tests__/provider-agnostic.architecture.test.ts` and verify all US2 tests pass

### Tests for User Story 2

- [ ] T007 [US2] Write test "Provider SDK imports exist only in client/ directory" in `src/core/models/__tests__/provider-agnostic.architecture.test.ts` under the "Client Containment" describe block. Dynamically discover all `.ts` source files under `src/` (excluding `__tests__/`, `node_modules/`, `__test-utils__/`). For each file NOT in `src/core/models/client/`, read its contents and assert it does not import from any banned provider SDK pattern. This ensures provider imports are contained to client classes only.
- [ ] T008 [P] [US2] Write test "Shared components have zero provider-specific branching" in `src/core/models/__tests__/provider-agnostic.architecture.test.ts` under the "Shared Component Isolation" describe block. For each known shared component (`src/core/events/EventMapping.ts`, `src/core/models/PromptHelpers.ts`, `src/core/compact/CompactService.ts`, `src/core/TurnManager.ts`, `src/core/session/state/SessionState.ts`, `src/core/session/state/SnapshotCompressor.ts`, `src/core/TaskRunner.ts`, `src/core/AgentTask.ts`, `src/core/title/TitleGenerator.ts`), read the file and assert it does not contain provider name string literals used in conditional checks (e.g., `=== 'openai'`, `=== 'groq'`, `=== 'google'`, `=== 'xai'`, `=== 'fireworks'`, `=== 'together'`, `=== 'anthropic'`).
- [ ] T009 [P] [US2] Write test "All client subclasses are within client/ directory" in `src/core/models/__tests__/provider-agnostic.architecture.test.ts` under the "Client Containment" describe block. Verify that the 7 known client files (`OpenAIResponsesClient.ts`, `OpenAIChatCompletionClient.ts`, `GoogleCompletionClient.ts`, `GroqClient.ts`, `FireworksClient.ts`, `FireworksChatCompletionClient.ts`, `TogetherChatCompletionClient.ts`) all exist within `src/core/models/client/` and that no other `.ts` files in `src/core/models/client/` directory exist that are not in this expected list (detect unexpected client additions).

### Implementation for User Story 2

- [ ] T010 [US2] Run the US2 tests. If any test fails, audit the failing file(s) to identify provider-specific logic that leaked outside of client classes. Fix by moving provider-specific logic into the appropriate client subclass. Re-run tests until all pass.

**Checkpoint**: All shared component isolation and client containment tests pass. Provider-specific logic confirmed isolated to client/ directory.

---

## Phase 4: User Story 3 - Verify Event Reverse-Mapping Is Provider-Agnostic (Priority: P2)

**Goal**: Confirm that the reverse conversion path (provider response to ResponseItem to UI EventMsg) is provider-agnostic outside of client classes

**Independent Test**: Run `npm test -- --run src/core/models/__tests__/provider-agnostic.architecture.test.ts` and verify all US3 tests pass

### Tests for User Story 3

- [ ] T011 [US3] Write test "EventMapping has zero provider-specific code paths" in `src/core/models/__tests__/provider-agnostic.architecture.test.ts` under the "Shared Component Isolation" describe block. Read `src/core/events/EventMapping.ts` and assert: (a) no provider SDK imports, (b) no provider name string conditionals, (c) no references to provider-specific response formats. This ensures the UI layer never needs to know which provider generated a response.
- [ ] T012 [P] [US3] Write test "ResponseEvent type definition is provider-agnostic" in `src/core/models/__tests__/provider-agnostic.architecture.test.ts` under the "Shared Component Isolation" describe block. Read `src/core/models/types/ResponseEvent.ts` and assert it contains no provider SDK imports and references only generic ResponseItem types.

### Implementation for User Story 3

- [ ] T013 [US3] Run the US3 tests. If any test fails, audit `src/core/events/EventMapping.ts` and `src/core/models/types/ResponseEvent.ts` to identify violations. Fix by extracting provider-specific logic into the appropriate client class's `convertSDKEventToResponseEvent` method. Re-run tests until all pass.

**Checkpoint**: Event mapping and reverse conversion path confirmed provider-agnostic.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and documentation

- [ ] T014 Run the full test suite with `npm test -- --run` to confirm no regressions from any changes made during the audit
- [ ] T015 Run TypeScript type-check with `npm run type-check` to confirm no type errors introduced
- [ ] T016 Update `specs/026-provider-agnostic-audit/research.md` Audit Findings Summary section with final pass/fail status for each file category, noting any violations that were fixed

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **US1 (Phase 2)**: Depends on Setup (T002 must complete before writing tests)
- **US2 (Phase 3)**: Depends on Setup (T002 must complete). Can run in parallel with US1.
- **US3 (Phase 4)**: Depends on Setup (T002 must complete). Can run in parallel with US1 and US2.
- **Polish (Phase 5)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Setup - No dependencies on other stories
- **User Story 2 (P1)**: Can start after Setup - No dependencies on other stories
- **User Story 3 (P2)**: Can start after Setup - No dependencies on other stories

### Within Each User Story

- Tests MUST be written first (they define the audit criteria)
- Run tests to see if they pass or fail (audit result)
- Fix violations only if tests fail
- Story complete when all its tests pass

### Parallel Opportunities

- T001 and T002 are sequential (T002 uses T001's output)
- T004, T005 can run in parallel (different describe blocks, no dependencies)
- T008, T009 can run in parallel (different test concerns)
- US1, US2, and US3 can all start in parallel after Setup completes
- T011, T012 can run in parallel (different files)
- T014, T015 can run in parallel (independent validation commands)

---

## Parallel Example: User Story 2

```bash
# Launch all US2 tests in parallel (different test concerns):
Task: "Write provider SDK containment test in provider-agnostic.architecture.test.ts"
Task: "Write shared component isolation test in provider-agnostic.architecture.test.ts"
Task: "Write client directory verification test in provider-agnostic.architecture.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: User Story 1 (T003-T006)
3. **STOP and VALIDATE**: Run `npm test -- --run src/core/models/__tests__/provider-agnostic.architecture.test.ts`
4. ResponseItem type definition is now audit-verified with guard-rail tests

### Incremental Delivery

1. Complete Setup → Test scaffold ready
2. Add User Story 1 tests → ResponseItem boundary verified (MVP!)
3. Add User Story 2 tests → Shared component isolation verified
4. Add User Story 3 tests → Event mapping isolation verified
5. Polish → Full suite passes, findings documented

---

## Notes

- [P] tasks = different files or test blocks, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- The tests ARE the audit - passing tests = passing audit
- If all tests pass on first run, no fix tasks (T006, T010, T013) are needed
- Research confirms architecture is currently clean, so most tests should pass immediately
- Commit after each phase checkpoint
