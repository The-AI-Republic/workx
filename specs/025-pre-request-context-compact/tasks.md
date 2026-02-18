# Tasks: Pre-Request Context Window Compaction

**Input**: Design documents from `/specs/025-pre-request-context-compact/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Foundational (Threshold Alignment & Token Estimation Utility)

**Purpose**: Align compaction thresholds and create the shared token estimation utility that US1 and US3 both depend on.

- [ ] T001 Update `triggerThreshold` from `0.9` to `0.85` in `DEFAULT_COMPACTION_CONFIG` in `src/core/compact/constants.ts`
- [ ] T002 [P] Add `estimateRequestTokens(items: ResponseItem[], instructionsLength?: number, toolCount?: number): number` function in `src/core/compact/utils.ts` — iterate over ResponseItem content, sum `Math.ceil(text.length / 4)` for each text segment, add `Math.ceil((instructionsLength ?? 0) / 4)` for instructions, add `(toolCount ?? 0) * 500` for tool schema overhead. Import `ResponseItem` type from `../protocol/types`
- [ ] T003 [P] Update `triggerThreshold` mock value from `0.9` to `0.85` in `src/core/compact/__tests__/CompactService.test.ts` (line 21 in the `vi.mock('../constants', ...)` block)

**Checkpoint**: Threshold is unified at 0.85 across the codebase. `estimateRequestTokens()` utility is available. Existing tests pass with updated mock.

---

## Phase 2: User Story 1 - Prevent Context Overflow Before LLM Request (Priority: P1) MVP

**Goal**: Move the compaction check from post-LLM-response to pre-LLM-request so that outgoing requests never exceed the model's context window.

**Independent Test**: Run a conversation until token usage approaches the context window limit, then verify that compaction occurs **before** the next LLM request is sent (not after the response).

### Implementation for User Story 1

- [ ] T004 [US1] Add private method `shouldCompactBeforeRequest(turnInput: ResponseItem[]): boolean` in `src/core/TaskRunner.ts` — get context window via `this.turnContext.getModelContextWindow()`, return `false` if undefined; get instructions length from `this.turnContext.getBaseInstructions()?.length` and `this.turnContext.getUserInstructions()?.length`; call `estimateRequestTokens(turnInput, instructionsLength, toolCount)` from `../compact/utils`; return `estimatedTokens >= contextWindow * TaskRunner.COMPACTION_THRESHOLD`. Add import for `estimateRequestTokens` at top of file
- [ ] T005 [US1] Modify `runLoop()` in `src/core/TaskRunner.ts` to insert pre-request compaction check between `buildNormalTurnInput()` (line ~289) and `runTurnWithTimeout()` (line ~303): change `const turnInput` to `let turnInput`; after `turnInput = await this.buildNormalTurnInput(pendingInput)`, add: `if (this.options.autoCompact && this.shouldCompactBeforeRequest(turnInput)) { const compacted = await this.attemptAutoCompact(turnCount, totalTokenUsage); if (compacted) { compactionPerformed = true; turnInput = await this.buildNormalTurnInput([]); } }`. Pass empty array on rebuild to avoid double-recording pending input. Keep existing post-response compaction check (lines 315-320) unchanged as safety net
- [ ] T006 [P] [US1] Add public method `estimateHistoryTokens(): number` in `src/core/Session.ts` — call `estimateRequestTokens()` from `./compact/utils` on `this.sessionState.getConversationHistory().items` and return the result. Add import for `estimateRequestTokens`
- [ ] T007 [US1] Add `console.debug('[TaskRunner] Pre-request compaction check', { estimatedTokens, contextWindow, threshold })` logging in `shouldCompactBeforeRequest()` method in `src/core/TaskRunner.ts` when the check triggers compaction (when returning `true`)

**Checkpoint**: Pre-request compaction check is active. The system estimates tokens before each LLM request and compacts if estimated usage >= 85% of context window. Post-response check remains as fallback. User Story 1 is independently testable.

---

## Phase 3: User Story 2 - Accurate Context Window Configuration (Priority: P2)

**Goal**: Verify all configured model context window sizes match their respective provider's official documentation.

**Independent Test**: Compare each model's `contextWindow` value in `default.json` against the provider's published documentation.

### Implementation for User Story 2

- [ ] T008 [US2] Verify and update context window values for all models in `src/core/models/providers/default.json` against official provider documentation: GPT-5.1 (400,000), GPT-5.2 (400,000), Gemini 3 Pro Preview (1,000,000), Gemini 2.5 Pro (1,000,000), Grok 4.1 Fast Reasoning (2,000,000), Kimi K2 Thinking (256,000 — Moonshot, Fireworks, Together), Kimi K2 Thinking Turbo (256,000), Kimi K2.5 (262,100). Also verify `maxOutputTokens` values are accurate (Gemini 2.5 Pro may support up to 65,536 output tokens vs current 8,192). Document verification sources as code comments or in research.md

**Checkpoint**: All model context window values verified correct. Any corrections applied. User Story 2 is independently verifiable.

---

## Phase 4: User Story 3 - Token Estimation Validation (Priority: P3)

**Goal**: Validate that the token estimation function is fast (<10ms) and accurate (within 20% of actual token count).

**Independent Test**: Run the estimation function against text inputs of known token counts and verify accuracy and speed.

### Implementation for User Story 3

- [ ] T009 [P] [US3] Add unit tests for `estimateRequestTokens()` in `src/core/compact/__tests__/utils.test.ts` (new file) — test empty items returns 0; test single user message estimates correctly using `Math.ceil(text.length / 4)`; test multiple messages sums correctly; test with instructionsLength adds `Math.ceil(length / 4)`; test with toolCount adds `count * 500`; test with all parameters combined; test with items containing non-text content (type !== 'input_text'/'output_text') skips them. Mock constants with `vi.mock('../constants', ...)` similar to CompactService.test.ts
- [ ] T010 [US3] Add accuracy validation test in `src/core/compact/__tests__/utils.test.ts` — test that estimation for a 1000-character English text paragraph produces a result within 20% of the expected ~250 tokens (1000/4); test that estimation for a 10,000-character text produces a result within 20% of ~2500 tokens; test performance: verify `estimateRequestTokens` on a 100-item history completes in under 10ms using `performance.now()`

**Checkpoint**: Token estimation function validated for accuracy (within 20%) and performance (<10ms). User Story 3 is independently testable.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across all user stories

- [ ] T011 Run full test suite (`npm test`) and fix any regressions in `src/`
- [ ] T012 Run linter (`npm run lint`) and fix any issues in modified files
- [ ] T013 Run quickstart.md validation — verify the manual testing flow described in `specs/025-pre-request-context-compact/quickstart.md` can be followed

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — can start immediately
- **User Story 1 (Phase 2)**: Depends on T001 (threshold) and T002 (estimateRequestTokens utility)
- **User Story 2 (Phase 3)**: No dependencies on other phases — can run in parallel with US1
- **User Story 3 (Phase 4)**: Depends on T002 (estimateRequestTokens utility exists to test)
- **Polish (Phase 5)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Depends on Foundational Phase (T001, T002). Core behavioral change — MVP.
- **User Story 2 (P2)**: Independent — config data verification. Can run in parallel with US1.
- **User Story 3 (P3)**: Depends on T002 (utility function must exist). Can run in parallel with US1 (different files).

### Within Each User Story

- US1: T004 (method) → T005 (flow change) → T007 (logging). T006 can run in parallel (different file).
- US2: Single task (T008).
- US3: T009 (unit tests) → T010 (accuracy validation).

### Parallel Opportunities

- T001, T002, T003 can all run in parallel (different files)
- T004 and T006 can run in parallel (TaskRunner.ts vs Session.ts)
- T008 (US2) can run in parallel with any US1 task (different file: default.json)
- T009 (US3) can run in parallel with US1 tasks (different file: new test file)

---

## Parallel Example: Foundational Phase

```bash
# Launch all foundational tasks together (all different files):
Task: "T001 - Update triggerThreshold in src/core/compact/constants.ts"
Task: "T002 - Add estimateRequestTokens() in src/core/compact/utils.ts"
Task: "T003 - Update threshold mock in src/core/compact/__tests__/CompactService.test.ts"
```

## Parallel Example: After Foundational

```bash
# Launch US1 + US2 + US3 tasks in parallel (different files):
Task: "T004 [US1] - shouldCompactBeforeRequest() in src/core/TaskRunner.ts"
Task: "T006 [US1] - estimateHistoryTokens() in src/core/Session.ts"
Task: "T008 [US2] - Verify context windows in src/core/models/providers/default.json"
Task: "T009 [US3] - Unit tests in src/core/compact/__tests__/utils.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational (T001-T003)
2. Complete Phase 2: User Story 1 (T004-T007)
3. **STOP and VALIDATE**: Test pre-request compaction independently
4. The system now prevents context overflow before requests

### Incremental Delivery

1. Complete Foundational → Thresholds aligned, utility ready
2. Add User Story 1 → Pre-request compaction active (MVP!)
3. Add User Story 2 → Context window values verified
4. Add User Story 3 → Token estimation validated with tests
5. Polish → Full test suite green, linting clean

### Parallel Team Strategy

With multiple developers:

1. All complete Foundational together (3 parallel tasks)
2. Once Foundational is done:
   - Developer A: User Story 1 (T004-T007)
   - Developer B: User Story 2 (T008) + User Story 3 (T009-T010)
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- The post-response compaction check is intentionally kept unchanged as a safety net (FR-009)
- No new dependencies or external libraries are introduced
