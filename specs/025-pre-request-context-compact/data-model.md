# Data Model: Pre-Request Context Window Compaction

**Feature**: 025-pre-request-context-compact
**Date**: 2026-02-17

## Overview

This feature modifies the **timing** of compaction triggering, not the data model. No new entities, database tables, or persistent storage changes are needed. The changes involve configuration values and in-memory token estimation.

## Entities

### Existing Entities (unchanged)

#### ResponseItem
- **Description**: Core conversation history item (user message, assistant message, tool call, etc.)
- **Key fields**: `type`, `role`, `content[]`
- **Used for**: Token estimation iterates over `content[].text` to sum character lengths
- **No changes**: Structure remains identical

#### CompactionConfig
- **Description**: Configuration for the compaction service
- **Key fields**:
  - `triggerThreshold: number` — **CHANGED from 0.9 to 0.85**
  - `userMessageBudget: number` — unchanged (20,000)
  - `maxRetries: number` — unchanged (3)
  - `baseBackoffMs: number` — unchanged (100)
- **Location**: `src/core/compact/constants.ts` → `DEFAULT_COMPACTION_CONFIG`

#### IModelConfig
- **Description**: Model configuration including context window
- **Key fields**:
  - `contextWindow: number` — verified against provider docs, no corrections needed
  - `maxOutputTokens: number` — no changes
  - `modelKey: string` — model identifier
- **Location**: `src/config/types.ts` (type), `src/core/models/providers/default.json` (data)

#### CompactionResult
- **Description**: Result of a compaction operation
- **Key fields**: `success`, `tokensBefore`, `tokensAfter`, `itemsTrimmed`, `newHistory`, `error`
- **No changes**: Returned by both pre-request and post-response compaction

### New Functions (not entities, but key data transformations)

#### estimateRequestTokens
- **Input**: `items: ResponseItem[]`, `instructionsLength?: number`, `toolCount?: number`
- **Output**: `number` (estimated token count)
- **Logic**: Sum `Math.ceil(text.length / 4)` for all text content in items, add instruction tokens, add tool overhead
- **Location**: `src/core/compact/utils.ts`

## State Transitions

### Compaction Trigger Flow (modified)

```
┌───────────────────┐
│   Turn Start      │
│   (runLoop)       │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  Build Turn Input │
│  (history + input)│
└────────┬──────────┘
         │
         ▼
┌───────────────────────────┐
│  [NEW] Estimate Tokens    │
│  estimateRequestTokens()  │
│  >= 85% context window?   │
├─── YES ───┐  ┌─── NO ────┤
│            ▼  ▼           │
│  ┌──────────────────┐     │
│  │ Auto-Compact     │     │
│  │ (existing flow)  │     │
│  └────────┬─────────┘     │
│           │               │
│  ┌────────▼─────────┐     │
│  │ Rebuild Input     │     │
│  │ (compacted hist)  │     │
│  └────────┬─────────┘     │
│           │               │
└───────────┼───────────────┘
            │
            ▼
┌───────────────────┐
│  Send LLM Request │
│  (stream)         │
└────────┬──────────┘
         │
         ▼
┌───────────────────────────┐
│  Process Response         │
│  (existing post-response  │
│   check kept as fallback) │
└───────────────────────────┘
```

## Configuration Changes

| Constant | Location | Old Value | New Value |
| -------- | -------- | --------- | --------- |
| `DEFAULT_COMPACTION_CONFIG.triggerThreshold` | `compact/constants.ts` | 0.9 | 0.85 |
| `TaskRunner.COMPACTION_THRESHOLD` | `TaskRunner.ts` | 0.85 | 0.85 (unchanged) |

## Data Validation Rules

- `contextWindow` must be a positive integer > 0 (existing validation in `CompactService.shouldCompact()`)
- Token estimate must be >= 0 (enforced by `Math.ceil` on non-negative length)
- If `contextWindow` is undefined/missing, skip pre-request check (graceful fallback)
