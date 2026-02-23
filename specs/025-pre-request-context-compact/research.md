# Research: Pre-Request Context Window Compaction

**Feature**: 025-pre-request-context-compact
**Date**: 2026-02-17

## R1: Token Estimation Approach

**Decision**: Use character-based heuristic (`Math.ceil(charCount / 4)`) for pre-request token estimation.

**Rationale**: The codebase already uses three different estimation approaches:
1. `approxTokenCount()` in `compact/utils.ts` — word-based with 1.3 multiplier, includes punctuation weighting
2. `CompactService.estimateTokens()` — `Math.ceil(text.length / 4)`, simple character division
3. `CompactionMetrics.estimateTokens()` in DOM tools — `Math.ceil(charCount / 3.8)`

For pre-request estimation, the char-based approach (#2) is preferred because:
- It's the simplest (no regex, no word splitting)
- It's already used by `CompactService` for post-compaction estimates, ensuring consistency
- It's fast (O(1) per text segment — just `.length` property)
- The 1:4 ratio is a conservative estimate (actual ratio is ~3.5-4 chars/token for English), meaning it slightly over-estimates, which is safer for our use case (trigger compaction slightly early rather than too late)
- No risk of regex performance issues on very large text content

**Alternatives considered**:
- `approxTokenCount()` (word-based): More accurate but slower due to regex splits; overkill since we have a 15% safety margin
- External tokenizer (tiktoken, etc.): Explicitly excluded by spec (FR-003); would add dependency and latency
- `charCount / 3.8`: Slightly less conservative; inconsistent with existing `CompactService.estimateTokens()`

## R2: Optimal Threshold Value

**Decision**: Unified threshold of 0.85 (85%) for both pre-request and post-response compaction checks.

**Rationale**:
- The user explicitly requested 85% in the feature description
- `TaskRunner.COMPACTION_THRESHOLD` is already 0.85
- `DEFAULT_COMPACTION_CONFIG.triggerThreshold` is 0.9 — this needs to be aligned downward
- 85% provides a 15% buffer which accommodates:
  - Token estimation inaccuracy (up to ~20% per SC spec)
  - Tool definition overhead
  - System instruction overhead
  - Model output tokens

**Alternatives considered**:
- Keep dual thresholds (0.85 TaskRunner / 0.9 CompactService): Rejected; confusing and the CompactService's `shouldCompact()` is not currently called from the TaskRunner flow, but aligning prevents future bugs
- 80%: Too aggressive; would waste context space and compact too often
- 90%: Too lenient for a pre-request check; doesn't leave enough room for large inputs

## R3: Pre-Request Check Placement in Turn Loop

**Decision**: Insert the pre-request check in `TaskRunner.runLoop()` between `buildNormalTurnInput()` (line 289) and `runTurnWithTimeout()` (line 303).

**Rationale**: At this insertion point:
- `turnInput` is already built (history + pending input combined)
- The full payload to be sent is known
- `turnContext` is available for context window and instructions
- If compaction is needed, we can call `attemptAutoCompact()` (existing method) and then rebuild `turnInput`

**Alternatives considered**:
- Inside `TurnManager.runTurn()` before `tryRunTurn()`: Rejected; compaction logic belongs in `TaskRunner`, not `TurnManager`. TurnManager is responsible for model communication, not history management
- Inside `TurnManager.tryRunTurn()` before `modelClient.stream()`: Rejected; same separation-of-concerns issue, and the prompt is already built at this point
- Inside `Session.buildTurnInputWithHistory()`: Rejected; Session shouldn't trigger compaction implicitly during input building

## R4: Context Window Values Verification

**Decision**: Verify all model context window values in `default.json` against provider documentation.

**Findings** (based on official provider docs as of early 2026):

| Provider | Model | Current Value | Verified Value | Status |
| -------- | ----- | ------------- | -------------- | ------ |
| OpenAI | GPT-5.1 | 400,000 | 400,000 | Correct |
| OpenAI | GPT-5.2 | 400,000 | 400,000 | Correct |
| Google | Gemini 3 Pro Preview | 1,000,000 | 1,000,000 | Correct |
| Google | Gemini 2.5 Pro | 1,000,000 | 1,000,000 | Correct |
| xAI | Grok 4.1 Fast Reasoning | 2,000,000 | 2,000,000 | Correct |
| Moonshot | Kimi K2 Thinking | 256,000 | 256,000 | Correct |
| Moonshot | Kimi K2 Thinking Turbo | 256,000 | 256,000 | Correct |
| Fireworks | Kimi K2 Thinking | 256,000 | 256,000 | Correct |
| Fireworks | Kimi K2.5 | 262,100 | 262,100 | Correct |
| Together | Kimi K2 Thinking | 256,000 | 256,000 | Correct |

**Result**: All current context window values appear correct based on available documentation. No corrections needed.

**Note**: Some models (Gemini 2.5 Pro) may have max output token limits that are lower than the configured `maxOutputTokens: 8192`. The Gemini 2.5 Pro actually supports up to 65,536 output tokens, but the current config has 8192. This is a separate concern from context window accuracy and could be addressed in a follow-up. The `contextWindow` values (input limits) are accurate.

## R5: Rebuilding Turn Input After Compaction

**Decision**: After pre-request compaction, rebuild `turnInput` by calling `buildNormalTurnInput(pendingInput)` again.

**Rationale**:
- `buildNormalTurnInput()` calls `session.buildTurnInputWithHistory()` which reads the current conversation history from `sessionState`
- After compaction, `sessionState.replaceHistory()` has already replaced the history with the compacted version
- Therefore, calling `buildNormalTurnInput()` again naturally produces a smaller turn input with the compacted history
- The pending input items have already been recorded to conversation history in the first `buildNormalTurnInput()` call, so we need to handle the rebuild carefully to avoid double-recording

**Important implementation detail**: The `buildNormalTurnInput()` method records `pendingInput` via `session.recordConversationItemsDual()` when `pendingInput.length > 0`. On the rebuild after compaction, we should pass an empty array to avoid double-recording the pending input (which is already in the history).

**Alternatives considered**:
- Mutate `turnInput` in place by removing old items: Rejected; fragile and harder to reason about
- Cache the compacted history and manually construct input: Rejected; unnecessary duplication of existing `buildTurnInputWithHistory()` logic
