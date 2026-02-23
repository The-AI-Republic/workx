# Implementation Plan: Pre-Request Context Window Compaction

**Branch**: `025-pre-request-context-compact` | **Date**: 2026-02-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/025-pre-request-context-compact/spec.md`

## Summary

Move the chat history compaction check from **after** the LLM response to **before** the LLM request. Currently, `TaskRunner.runLoop()` sends the request, receives the response, and only then checks if token usage exceeds the compaction threshold. This creates a gap where the outgoing request itself could exceed the model's context window. The fix adds a pre-request token estimation step that estimates the full request payload size using a character-based heuristic, triggers compaction if the estimate exceeds 85% of the context window, and then sends the (now-compacted) request. Additionally, align the two threshold constants (TaskRunner: 0.85, CompactService: 0.9) to a unified 0.85, and verify/correct all model context window values in `default.json`.

## Technical Context

**Language/Version**: TypeScript 5.9.2
**Primary Dependencies**: Vitest (testing), zod (validation), uuid
**Storage**: N/A (in-memory conversation history, JSON config file)
**Testing**: Vitest (`npm test`)
**Target Platform**: Electron desktop app (cross-platform)
**Project Type**: Single project
**Performance Goals**: Pre-request token estimation < 50ms per turn
**Constraints**: No external tokenizer libraries; simple char/word heuristic only
**Scale/Scope**: Affects 4 source files + 1 config JSON; ~200 LOC changes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution file contains only template placeholders (no project-specific principles defined). No gates to enforce. Proceeding.

## Project Structure

### Documentation (this feature)

```text
specs/025-pre-request-context-compact/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (internal function contracts)
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── TaskRunner.ts              # MODIFY: Add pre-request compaction check in runLoop()
│   ├── TurnManager.ts             # READ-ONLY: Understand prompt building (no changes)
│   ├── TurnContext.ts             # READ-ONLY: getModelContextWindow() (no changes)
│   ├── Session.ts                 # MODIFY: Add method to estimate current history tokens
│   ├── compact/
│   │   ├── CompactService.ts      # MODIFY: Align triggerThreshold to 0.85
│   │   ├── constants.ts           # MODIFY: Update DEFAULT_COMPACTION_CONFIG.triggerThreshold
│   │   ├── utils.ts               # MODIFY: Add estimateRequestTokens() function
│   │   ├── types.ts               # READ-ONLY (no changes needed)
│   │   ├── HistoryReconstructor.ts # READ-ONLY (no changes needed)
│   │   ├── SummaryGenerator.ts    # READ-ONLY (no changes needed)
│   │   └── __tests__/
│   │       └── CompactService.test.ts # MODIFY: Update threshold mock, add pre-request tests
│   └── models/
│       ├── ModelClient.ts         # READ-ONLY (no changes needed)
│       └── providers/
│           └── default.json       # MODIFY: Verify/correct context window values
└── config/
    └── types.ts                   # READ-ONLY (no changes needed)
```

**Structure Decision**: Single project structure. All changes are within `src/core/` (compaction logic) and `src/core/models/providers/` (config data). No new directories or files beyond test updates.

## Design Decisions

### D1: Where to insert the pre-request check

**Decision**: Insert the pre-request compaction check in `TaskRunner.runLoop()`, between `buildNormalTurnInput()` and `runTurnWithTimeout()`.

**Rationale**: At this point, we have the full turn input (history + pending input) built and can estimate its token count. The `TurnManager` and `ModelClient` should remain unaware of compaction logic — it stays in `TaskRunner` where it already lives.

**Current flow** (lines 288-303 of TaskRunner.ts):
```
pendingInput = session.getPendingInput()
turnInput = buildNormalTurnInput(pendingInput)   ← history + new input ready
turnResult = runTurnWithTimeout(turnInput)        ← request sent HERE
processResult = processTurnResult(turnResult)     ← token check happens HERE (too late)
```

**New flow**:
```
pendingInput = session.getPendingInput()
turnInput = buildNormalTurnInput(pendingInput)     ← history + new input ready
[NEW] estimatedTokens = estimateRequestTokens(turnInput, instructions)
[NEW] if estimatedTokens >= contextWindow * 0.85:
[NEW]   attemptAutoCompact()
[NEW]   turnInput = buildNormalTurnInput(pendingInput)  ← rebuild with compacted history
turnResult = runTurnWithTimeout(turnInput)          ← request sent with safe payload
processResult = processTurnResult(turnResult)       ← post-response check kept as safety net
```

### D2: Token estimation approach

**Decision**: Use `Math.ceil(text.length / 4)` (1 token per 4 characters) applied to the serialized content of all ResponseItems in the turn input, plus a flat overhead for tool definitions and instructions.

**Rationale**: Two estimation approaches exist in the codebase:
- `approxTokenCount()` in `compact/utils.ts`: word-based with 1.3 multiplier
- `CompactService.estimateTokens()`: `Math.ceil(text.length / 4)` (char-based)
- `CompactionMetrics.estimateTokens()` in DOM tools: `Math.ceil(charCount / 3.8)`

The char-based approach (`length / 4`) is simplest and already used by CompactService for post-compaction estimates. It's consistent and avoids regex overhead. We'll use it for the pre-request estimate too, wrapped in a new utility function.

### D3: Handling instructions and tool definitions in estimate

**Decision**: Estimate instructions text length directly. For tool definitions, apply a flat overhead of ~500 tokens per tool (tools are JSON schemas; exact counting is unnecessary given the 85% threshold provides a 15% buffer).

**Rationale**: The 85% threshold provides a 15% safety margin. Over-estimating slightly is preferable to under-estimating, and tool definitions don't change turn-to-turn, so a rough per-tool estimate is sufficient.

### D4: Post-response check retention

**Decision**: Keep the existing post-response compaction check (`processTurnResult()` lines 627-633) as a secondary safety net. No changes to its logic.

**Rationale**: The pre-request check uses an estimate that may undercount. The post-response check uses actual token counts from the LLM. Together they provide defense-in-depth.

### D5: Threshold alignment

**Decision**: Change `DEFAULT_COMPACTION_CONFIG.triggerThreshold` from 0.9 to 0.85, aligning it with `TaskRunner.COMPACTION_THRESHOLD`. Extract to a single shared constant.

**Rationale**: Having two different thresholds (0.85 in TaskRunner, 0.9 in CompactService) is confusing and could lead to inconsistent behavior. The spec calls for 85%.

## Files to Modify (ordered by dependency)

### 1. `src/core/compact/constants.ts`
- Change `triggerThreshold` from `0.9` to `0.85` in `DEFAULT_COMPACTION_CONFIG`

### 2. `src/core/compact/utils.ts`
- Add `estimateRequestTokens(items: ResponseItem[], instructionsLength?: number, toolCount?: number): number`
- Iterates over ResponseItem content, sums `Math.ceil(text.length / 4)` for each text content
- Adds `Math.ceil(instructionsLength / 4)` for instructions
- Adds `toolCount * 500` as tool schema overhead

### 3. `src/core/Session.ts`
- Add `estimateHistoryTokens(): number` method that calls `estimateRequestTokens()` on current history

### 4. `src/core/TaskRunner.ts`
- In `runLoop()`: Insert pre-request compaction check between `buildNormalTurnInput()` and `runTurnWithTimeout()`
- New private method: `shouldCompactBeforeRequest(turnInput: ResponseItem[]): boolean`
  - Gets context window from `turnContext.getModelContextWindow()`
  - Estimates tokens of turnInput + instructions + tools
  - Returns `estimatedTokens >= contextWindow * COMPACTION_THRESHOLD`
- If pre-request compaction triggered, call `attemptAutoCompact()`, then rebuild `turnInput` via `buildNormalTurnInput(pendingInput)` with the now-compacted history

### 5. `src/core/models/providers/default.json`
- Verify and correct context window values for all models against official provider documentation
- Current values to verify:
  - GPT-5.1: 400,000 (verify against OpenAI docs)
  - GPT-5.2: 400,000 (verify against OpenAI docs)
  - Gemini 3 Pro Preview: 1,000,000 (verify against Google docs)
  - Gemini 2.5 Pro: 1,000,000 (verify against Google docs)
  - Grok 4.1: 2,000,000 (verify against xAI docs)
  - Kimi K2 Thinking: 256,000 (verify against Moonshot docs)
  - Kimi K2.5: 262,100 (verify against Fireworks/Moonshot docs)

### 6. `src/core/compact/__tests__/CompactService.test.ts`
- Update `triggerThreshold` mock from `0.9` to `0.85`
- Add tests for `estimateRequestTokens()` utility function
- Add tests for pre-request compaction flow in TaskRunner (or new test file)

## Complexity Tracking

No constitution violations to justify. This is a straightforward refactoring of existing logic (moving the compaction trigger point earlier in the turn loop) with minimal new code.
