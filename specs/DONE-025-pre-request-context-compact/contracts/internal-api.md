# Internal API Contracts: Pre-Request Context Window Compaction

**Feature**: 025-pre-request-context-compact
**Date**: 2026-02-17

## Overview

This feature has no external/REST/GraphQL API changes. All contracts are internal TypeScript function signatures within the `src/core/` module.

## New Function Contracts

### 1. `estimateRequestTokens` (compact/utils.ts)

```typescript
/**
 * Estimate total token count for a set of ResponseItems plus optional
 * instruction text and tool schema overhead.
 *
 * Uses 1 token ≈ 4 characters heuristic (consistent with CompactService.estimateTokens).
 *
 * @param items - Conversation history + new input items
 * @param instructionsLength - Character length of base + user instructions (optional)
 * @param toolCount - Number of tool definitions to account for (optional, ~500 tokens each)
 * @returns Estimated token count (always >= 0)
 */
export function estimateRequestTokens(
  items: ResponseItem[],
  instructionsLength?: number,
  toolCount?: number
): number;
```

**Behavior**:
- Iterates `items`, extracts `.content[].text` for message items
- Sums `Math.ceil(text.length / 4)` for each text segment
- Adds `Math.ceil((instructionsLength ?? 0) / 4)` for instructions
- Adds `(toolCount ?? 0) * 500` for tool schema overhead
- Returns total (minimum 0)

**Performance**: O(n) where n = total content items. No regex, no string splitting.

### 2. `shouldCompactBeforeRequest` (TaskRunner.ts, private method)

```typescript
/**
 * Determine if compaction should be triggered before sending the LLM request.
 *
 * @param turnInput - The full turn input (history + new items) to be sent
 * @returns true if estimated tokens >= 85% of context window
 */
private shouldCompactBeforeRequest(turnInput: ResponseItem[]): boolean;
```

**Behavior**:
- Gets context window via `this.turnContext.getModelContextWindow()`
- If no context window available, returns `false` (skip pre-request check)
- Gets instructions length from `this.turnContext.getBaseInstructions()` and `this.turnContext.getUserInstructions()`
- Calls `estimateRequestTokens(turnInput, instructionsLength, toolCount)`
- Returns `estimatedTokens >= contextWindow * TaskRunner.COMPACTION_THRESHOLD`

### 3. `estimateHistoryTokens` (Session.ts, public method)

```typescript
/**
 * Estimate token count of the current conversation history.
 *
 * @returns Estimated token count of all history items
 */
estimateHistoryTokens(): number;
```

**Behavior**:
- Gets current history via `sessionState.getConversationHistory()`
- Calls `estimateRequestTokens(history.items)`
- Returns estimate

## Modified Function Contracts

### 4. `TaskRunner.runLoop()` — Modified flow

**Before** (simplified):
```typescript
// lines 288-320
const pendingInput = await this.session.getPendingInput();
const turnInput = await this.buildNormalTurnInput(pendingInput);
const turnResult = await this.runTurnWithTimeout(turnInput, signal);
const processResult = await this.processTurnResult(turnResult);
if (processResult.tokenLimitReached && this.options.autoCompact) {
  await this.attemptAutoCompact(turnCount, totalTokenUsage);
}
```

**After** (simplified):
```typescript
const pendingInput = await this.session.getPendingInput();
let turnInput = await this.buildNormalTurnInput(pendingInput);

// [NEW] Pre-request compaction check
if (this.options.autoCompact && this.shouldCompactBeforeRequest(turnInput)) {
  const compacted = await this.attemptAutoCompact(turnCount, totalTokenUsage);
  if (compacted) {
    compactionPerformed = true;
    // Rebuild with compacted history (empty array to avoid double-recording)
    turnInput = await this.buildNormalTurnInput([]);
  }
}

const turnResult = await this.runTurnWithTimeout(turnInput, signal);
const processResult = await this.processTurnResult(turnResult);
// Post-response check retained as safety net (unchanged)
if (processResult.tokenLimitReached && this.options.autoCompact) {
  await this.attemptAutoCompact(turnCount, totalTokenUsage);
}
```

### 5. `DEFAULT_COMPACTION_CONFIG` — Value change

**Before**:
```typescript
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerThreshold: 0.9,
  // ...
};
```

**After**:
```typescript
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerThreshold: 0.85,
  // ...
};
```
