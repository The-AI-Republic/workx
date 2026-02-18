# Quickstart: Pre-Request Context Window Compaction

**Feature**: 025-pre-request-context-compact
**Date**: 2026-02-17

## What This Feature Does

Moves the chat history compaction check from **after** receiving an LLM response to **before** sending the request. This prevents context window overflow errors that could occur when the outgoing request is too large for the model.

## Key Changes

1. **Pre-request token estimation**: Before each LLM request, the system estimates the total token count of the payload (conversation history + new input + instructions + tool definitions).

2. **Pre-request compaction trigger**: If the estimated tokens exceed 85% of the model's context window, compaction runs before the request is sent.

3. **Threshold alignment**: Both `TaskRunner.COMPACTION_THRESHOLD` and `CompactService.triggerThreshold` are unified at 0.85 (85%).

4. **Context window verification**: All model context window values in `default.json` are verified against provider documentation.

## How to Test

### Run existing tests
```bash
npm test
```

### Manual testing flow
1. Start a conversation with any configured model
2. Send multiple long messages to build up context
3. Monitor console debug output for `[Compaction]` messages
4. Verify compaction triggers **before** the LLM request when approaching 85% of context window
5. Verify the LLM request succeeds after compaction

### Key test scenarios
- **Normal turn**: Send a short message when context usage is low → no compaction, request sent normally
- **Pre-request compaction**: Build up context to ~80% then send a large message → compaction triggers before the request
- **Compaction failure fallback**: If compaction fails, the request should still be sent (existing error handling catches any overflow)
- **Post-response safety net**: Even after pre-request compaction, the post-response check still runs as a secondary safety mechanism

## Files Modified

| File | Change |
| ---- | ------ |
| `src/core/compact/constants.ts` | `triggerThreshold`: 0.9 → 0.85 |
| `src/core/compact/utils.ts` | New `estimateRequestTokens()` function |
| `src/core/Session.ts` | New `estimateHistoryTokens()` method |
| `src/core/TaskRunner.ts` | Pre-request compaction check in `runLoop()`, new `shouldCompactBeforeRequest()` method |
| `src/core/models/providers/default.json` | Context window values verified (no corrections needed) |
| `src/core/compact/__tests__/CompactService.test.ts` | Updated threshold mock, new estimation tests |

## Architecture

```
Before (current):    send request → receive response → check tokens → compact (if needed)
After (new):         estimate tokens → compact (if needed) → send request → [safety check still runs]
```
