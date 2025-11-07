# Tasks: Improved DOM Serialization

**Input**: Design documents from `/specs/008-improve-dom-serialization/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: This feature does NOT explicitly request TDD/tests. Test tasks are omitted per task generation rules. Validation will use existing test suite (71/77 tests) + manual verification against success criteria.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root
- All paths are relative to: `/home/rich/dev/airepublic/open_source/s1/browserx/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare development environment and validate existing architecture

- [x] T001 Verify TypeScript 5.9.2 configuration in tsconfig.json
- [x] T002 Verify Vitest 3.2.4 test framework setup in package.json
- [x] T003 [P] Create test fixtures directory at tests/tools/dom/fixtures/ for X.com DOM samples
- [x] T004 [P] Review existing SerializationPipeline architecture in src/tools/dom/serializers/SerializationPipeline.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema changes and core utilities that ALL user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Add testid field to SerializedNode interface in src/tools/dom/types.ts
- [x] T006 Update serializedNodeToHtml() in src/tools/dom/utils.ts to map testid→data-testid attribute

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Reduce Meaningless Nested Containers (Priority: P1) 🎯 MVP

**Goal**: Remove nested meaningless divs (7+ levels → single meaningful container) to achieve 70% depth reduction

**Independent Test**: Load X.com in browser, execute DOM snapshot, verify serialized output has ≤8 nesting levels and preserves semantic containers (form, navigation, main, etc.)

### Implementation for User Story 1

- [x] T007 [US1] Read existing LayoutSimplifier implementation in src/tools/dom/serializers/simplifiers/LayoutSimplifier.ts
- [x] T008 [US1] Add isMeaninglessContainer() method to LayoutSimplifier in src/tools/dom/serializers/simplifiers/LayoutSimplifier.ts
- [x] T009 [US1] Add isSemanticContainer() method to LayoutSimplifier in src/tools/dom/serializers/simplifiers/LayoutSimplifier.ts
- [x] T010 [US1] Implement recursive hoistChildren() method in LayoutSimplifier in src/tools/dom/serializers/simplifiers/LayoutSimplifier.ts
- [x] T011 [US1] Integrate container hoisting logic into LayoutSimplifier.simplify() method in src/tools/dom/serializers/simplifiers/LayoutSimplifier.ts
- [x] T012 [US1] Add X.com nested-divs.html fixture to tests/tools/dom/fixtures/nested-divs.html
- [x] T013 [US1] Run existing test suite with npm test and verify 71/77 tests still pass
- [ ] T014 [US1] Manually validate nesting depth reduction on X.com using quickstart.md SC-002 validation script

**Checkpoint**: At this point, User Story 1 should reduce nesting depth to ≤8 levels independently

---

## Phase 4: User Story 2 - Aggregate Text Content in Clickable Elements (Priority: P1)

**Goal**: Collapse nested text in clickable elements into single strings to eliminate 4+ nested span traversal

**Independent Test**: Load X.com, find clickable links/buttons with nested spans, verify serialized output shows single aggregated text string with no child elements

### Implementation for User Story 2

- [x] T015 [P] [US2] Create ClickableTextAggregator.ts file in src/tools/dom/serializers/simplifiers/ClickableTextAggregator.ts
- [x] T016 [US2] Implement isClickable() detection method in ClickableTextAggregator checking interactionType, role, and tag
- [x] T017 [US2] Implement aggregateText() method with depth-first traversal in ClickableTextAggregator
- [x] T018 [US2] Add visibility filtering logic (skip display:none, visibility:hidden) in aggregateText() method
- [x] T019 [US2] Implement child replacement strategy in ClickableTextAggregator.simplify() method
- [x] T020 [US2] Register ClickableTextAggregator in SerializationPipeline after LayoutSimplifier in src/tools/dom/DomSnapshot.ts
- [x] T021 [US2] Add X.com clickable-nested-text.html fixture to tests/tools/dom/fixtures/clickable-nested-text.html
- [x] T022 [US2] Add icon-only-button.html fixture for edge case testing to tests/tools/dom/fixtures/icon-only-button.html
- [x] T023 [US2] Run existing test suite with npm test and verify 71/77 tests still pass
- [ ] T024 [US2] Manually validate text aggregation on X.com using quickstart.md SC-003 validation script

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Remove All Aria-Labels from Text Nodes (Priority: P2)

**Goal**: Remove all aria-labels from text nodes unconditionally to eliminate redundant information

**Independent Test**: Scan serialized output for text nodes (tag: "#text"), verify NONE have aria_label field present

### Implementation for User Story 3

- [x] T025 [P] [US3] Create AriaLabelCleaner.ts file in src/tools/dom/serializers/simplifiers/AriaLabelCleaner.ts
- [x] T026 [US3] Implement cleanAriaLabels() method checking nodeType === NODE_TYPE_TEXT in AriaLabelCleaner
- [x] T027 [US3] Implement recursive tree traversal in AriaLabelCleaner.simplify() method
- [x] T028 [US3] Add logic to delete accessibility.name field from text nodes in cleanAriaLabels()
- [x] T029 [US3] Register AriaLabelCleaner in SerializationPipeline after ClickableTextAggregator in src/tools/dom/DomSnapshot.ts
- [x] T030 [US3] Add aria-label-text-nodes.html fixture to tests/tools/dom/fixtures/aria-label-text-nodes.html
- [x] T031 [US3] Run existing test suite with npm test and verify 71/77 tests still pass
- [ ] T032 [US3] Manually validate aria-label removal on X.com using quickstart.md SC-004 validation script

**Checkpoint**: At this point, User Stories 1, 2, AND 3 should all work independently

---

## Phase 6: User Story 4 - Simplify Aria-Label Inheritance (Priority: P2)

**Goal**: Ensure aria-labels describe only the element itself, not its children

**Independent Test**: Examine parent-child element pairs, verify parent aria-label does NOT include child aria-label text

### Implementation for User Story 4

- [x] T033 [US4] Review CDP Accessibility tree data structure in existing VirtualNode building logic
- [x] T034 [US4] Verify element's own accessibility.name comes from CDP without aggregation in src/tools/dom/DomSnapshot.ts buildVirtualNode() method
- [x] T035 [US4] Document that AriaLabelCleaner already handles scope limitation via CDP data in code comments
- [x] T036 [US4] Add test fixture with nested aria-labels to tests/tools/dom/fixtures/nested-aria-labels.html
- [x] T037 [US4] Run existing test suite with npm test and verify 71/77 tests still pass
- [ ] T038 [US4] Manually validate aria-label scope on test fixture using quickstart.md validation approach

**Checkpoint**: All P2 user stories (3, 4) are now complete

---

## Phase 7: User Story 5 - Eliminate Text Node Tags (Priority: P3)

**Goal**: Remove `<#text>` wrapper tags from HTML output for cleaner representation

**Independent Test**: Generate HTML from serialized DOM, verify no `<#text>` tags appear in output string

### Implementation for User Story 5

- [x] T039 [US5] Modify serializedNodeToHtml() in src/tools/dom/utils.ts to detect text nodes (tag === '#text')
- [x] T040 [US5] Add early return for text nodes rendering plain text without wrapper tag in serializedNodeToHtml()
- [x] T041 [US5] Update parent element rendering to embed returned text inline in serializedNodeToHtml()
- [ ] T042 [US5] Add test cases to existing utils.test.ts for text node rendering in tests/tools/dom/__tests__/utils.test.ts
- [ ] T043 [US5] Generate HTML from X.com serialized DOM and visually inspect for `<#text>` tags
- [x] T044 [US5] Run existing test suite with npm test and verify 71/77 tests still pass

**Checkpoint**: Text node HTML output is now simplified

---

## Phase 8: User Story 6 - Include data-testid in Serialized Output (Priority: P3)

**Goal**: Preserve data-testid attributes in SerializedNode as testid field for test automation

**Independent Test**: Create HTML element with data-testid="test-button", serialize, verify SerializedNode has testid: "test-button"

### Implementation for User Story 6

- [x] T045 [US6] Add data-testid extraction logic in buildSerializedNode() method in src/tools/dom/DomSnapshot.ts
- [x] T046 [US6] Store extracted value in serializedNode.testid field in buildSerializedNode()
- [x] T047 [US6] Verify serializedNodeToHtml() correctly maps testid back to data-testid attribute (already done in T006)
- [ ] T048 [US6] Add test cases to DomSnapshot.test.ts for testid extraction in tests/tools/dom/__tests__/DomSnapshot.test.ts
- [x] T049 [US6] Create test fixture with data-testid attributes in tests/tools/dom/fixtures/data-testid-elements.html
- [x] T050 [US6] Run existing test suite with npm test and verify 71/77 tests still pass

**Checkpoint**: All user stories (P1, P2, P3) are now complete

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and performance verification

- [x] T051 [P] Run full test suite with npm test and verify all 71/77 tests still pass
- [x] T052 [P] Run TypeScript type check with npm run type-check and verify no errors
- [ ] T053 Run npm run lint and fix any linting errors (BLOCKED: Pre-existing ESLint 9.x config issue)
- [ ] T054 Validate SC-001 (30% token reduction) on X.com using quickstart.md benchmark
- [ ] T055 Validate SC-002 (≤8 nesting levels) on X.com using quickstart.md depth measurement
- [ ] T056 Validate SC-003 (100% clickable text aggregation) using quickstart.md scan script
- [ ] T057 Validate SC-004 (100% text aria-label removal) using quickstart.md grep script
- [ ] T058 Validate SC-005 (<10% performance overhead) using quickstart.md benchmark
- [ ] T059 Validate SC-007 (manual quality check) on 5 sites: X.com, GitHub, Gmail, Wikipedia, Amazon
- [ ] T060 [P] Update debug console.log statements in src/tools/dom/DomSnapshot.ts (comment or remove)
- [ ] T061 [P] Review and update code comments for new simplifiers
- [x] T062 Build extension with npm run build and verify no errors

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-8)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P1 → P2 → P2 → P3 → P3)
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational (Phase 2) - Registers AFTER LayoutSimplifier but can be developed in parallel
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) - Registers AFTER ClickableTextAggregator but can be developed in parallel
- **User Story 4 (P2)**: Can start after Foundational (Phase 2) - Relies on CDP data, no code dependencies
- **User Story 5 (P3)**: Can start after Foundational (Phase 2) - Only modifies utils.ts, independent
- **User Story 6 (P3)**: Can start after Foundational (Phase 2) - Uses foundation from T005/T006, independent

### Within Each User Story

- Implementation before validation
- Fixtures before manual testing
- Feature complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- T005 and T006 in Foundational can run sequentially (T006 depends on T005)
- Once Foundational phase completes, all 6 user stories can start in parallel (if team capacity allows)
- Within User Story 2: T015, T021, T022 can run in parallel (creating files)
- Within User Story 3: T025, T030 can run in parallel (creating files)
- Within Polish: T051, T052, T060, T061 can run in parallel

---

## Parallel Example: User Story 1

```bash
# User Story 1 tasks are mostly sequential due to single file modification:
Task T007: Read LayoutSimplifier (prerequisite)
Task T008-T011: Modify LayoutSimplifier sequentially
Task T012: Create fixture (parallel opportunity)
Task T013-T014: Validation (sequential)
```

---

## Parallel Example: User Story 2

```bash
# Launch file creation tasks together:
Task T015: "Create ClickableTextAggregator.ts"
Task T021: "Create clickable-nested-text.html fixture"
Task T022: "Create icon-only-button.html fixture"

# Then sequential implementation in ClickableTextAggregator.ts:
Task T016-T019: Implementation methods
Task T020: Register in pipeline
Task T023-T024: Validation
```

---

## Implementation Strategy

### MVP First (User Stories 1 & 2 Only - Both P1)

1. Complete Phase 1: Setup (T001-T004)
2. Complete Phase 2: Foundational (T005-T006) - CRITICAL blocker
3. Complete Phase 3: User Story 1 (T007-T014)
4. Complete Phase 4: User Story 2 (T015-T024)
5. **STOP and VALIDATE**: Test both P1 stories independently on X.com
6. Measure token reduction (should see ~20-25% at this point)
7. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational (T001-T006) → Foundation ready
2. Add User Story 1 (T007-T014) → Test independently → ~15% token reduction
3. Add User Story 2 (T015-T024) → Test independently → ~25% token reduction
4. Add User Story 3 (T025-T032) → Test independently → ~28% token reduction
5. Add User Story 4 (T033-T038) → Test independently → ~29% token reduction
6. Add User Story 5 (T039-T044) → Test independently → ~30% token reduction
7. Add User Story 6 (T045-T050) → Test independently → ~30% token reduction (additive)
8. Polish (T051-T062) → Final validation and cleanup

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (T001-T006)
2. Once Foundational is done:
   - Developer A: User Story 1 (T007-T014)
   - Developer B: User Story 2 (T015-T024)
   - Developer C: User Story 3 (T025-T032)
   - Developer D: User Story 5 (T039-T044) - independent utils.ts changes
   - Developer E: User Story 6 (T045-T050) - independent DomSnapshot.ts changes
3. User Story 4 (T033-T038) requires minimal code changes, can be handled by any developer
4. Stories complete and integrate independently without conflicts

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- No explicit test writing tasks - using existing test suite + manual validation
- Commit after each logical task group (per user story recommended)
- Stop at any checkpoint to validate story independently
- User Stories 1 & 2 (both P1) deliver the majority of value (~25% token reduction)
- User Stories 3-6 are incremental optimizations adding another ~5-8% reduction
- Avoid: same file conflicts between parallel stories (LayoutSimplifier is only US1, ClickableTextAggregator is only US2, etc.)
