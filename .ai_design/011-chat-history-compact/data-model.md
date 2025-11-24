# Data Model: Chat History Compaction

**Feature**: 011-chat-history-compact
**Date**: 2025-11-22

## Entities

### 1. CompactionConfig

Configuration for compaction behavior.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| triggerThreshold | number | Yes | 0.9 | Percentage of context window that triggers auto-compaction (0.0-1.0) |
| userMessageBudget | number | Yes | 20000 | Maximum tokens for preserved user messages |
| maxRetries | number | Yes | 3 | Maximum retry attempts for transient errors |
| baseBackoffMs | number | Yes | 100 | Base delay for exponential backoff (milliseconds) |

**Validation Rules**:
- `triggerThreshold` must be between 0.5 and 0.99
- `userMessageBudget` must be positive and less than model context window
- `maxRetries` must be between 1 and 10
- `baseBackoffMs` must be between 50 and 1000

### 2. CompactionResult

Result of a compaction operation.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| success | boolean | Yes | Whether compaction completed successfully |
| tokensBefore | number | Yes | Total tokens before compaction |
| tokensAfter | number | Yes | Total tokens after compaction |
| itemsTrimmed | number | Yes | Number of history items trimmed during overflow handling |
| summaryText | string | Conditional | Generated summary (only if success=true) |
| error | string | Conditional | Error message (only if success=false) |
| retriesUsed | number | Yes | Number of retries before success/failure |
| triggerReason | 'auto' \| 'manual' | Yes | What triggered the compaction |

### 3. CompactedHistory

The reconstructed conversation history after compaction.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| initialContext | ResponseItem[] | Yes | System instructions and initial context messages |
| preservedUserMessages | ResponseItem[] | Yes | Recent user messages within token budget |
| summaryMessage | ResponseItem | Yes | LLM-generated summary with prefix |

**Relationships**:
- Contains `ResponseItem` objects from existing `protocol/types.ts`
- `summaryMessage.content` starts with `SUMMARY_PREFIX` constant

### 4. CompactionState (extends SessionState)

Additional session state fields for compaction tracking.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| compactionCount | number | Yes | 0 | Number of successful compactions this session |
| lastCompactionTime | number | No | undefined | Unix timestamp of last compaction |
| lastCompactionTokensSaved | number | No | undefined | Tokens saved in last compaction |

**State Transitions**:
```
Initial State: compactionCount = 0, lastCompactionTime = undefined

On successful compaction:
  compactionCount++
  lastCompactionTime = Date.now()
  lastCompactionTokensSaved = tokensBefore - tokensAfter

On session reset:
  compactionCount = 0
  lastCompactionTime = undefined
  lastCompactionTokensSaved = undefined
```

## Existing Types (Reference)

### ResponseItem (from protocol/types.ts)

Used for messages in conversation history. Key variants:

```typescript
type ResponseItem =
  | {
      type: 'message';
      id?: string;
      role: 'user' | 'assistant' | 'system';
      content: ContentItem[];
    }
  | { type: 'function_call'; /* ... */ }
  | { type: 'function_call_output'; /* ... */ }
  // ... other variants
```

### ContentItem (from protocol/types.ts)

Content within a message:

```typescript
type ContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }
```

### TokenUsageInfo (from models/types/TokenUsage.ts)

Token tracking used for threshold detection:

```typescript
interface TokenUsageInfo {
  total_token_usage: TokenUsage;
  last_token_usage: TokenUsage;
  model_context_window?: number;
  auto_compact_token_limit?: number;
}
```

## Constants

### Prompts

```typescript
// Summarization prompt sent to LLM
const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

// Prefix prepended to summary when added to history
const SUMMARY_PREFIX = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;

// Placeholder when no meaningful summary possible
const NO_SUMMARY_PLACEHOLDER = '(no summary available)';
```

### Defaults

```typescript
const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerThreshold: 0.9,      // 90% of context window
  userMessageBudget: 20000,   // tokens
  maxRetries: 3,
  baseBackoffMs: 100,
};
```

## Entity Relationships Diagram

```
┌─────────────────────┐
│   SessionState      │
├─────────────────────┤
│ + history           │──────┐
│ + compactionCount   │      │
│ + lastCompactionTime│      │
└─────────────────────┘      │
         │                    │
         │ triggers           │ contains
         ▼                    ▼
┌─────────────────────┐   ┌─────────────────┐
│  CompactionConfig   │   │  ResponseItem[] │
├─────────────────────┤   └─────────────────┘
│ + triggerThreshold  │           │
│ + userMessageBudget │           │ transformed into
│ + maxRetries        │           ▼
│ + baseBackoffMs     │   ┌─────────────────────┐
└─────────────────────┘   │  CompactedHistory   │
         │                ├─────────────────────┤
         │ configures     │ + initialContext    │
         ▼                │ + preservedUserMsgs │
┌─────────────────────┐   │ + summaryMessage    │
│  CompactionResult   │   └─────────────────────┘
├─────────────────────┤
│ + success           │
│ + tokensBefore      │
│ + tokensAfter       │
│ + itemsTrimmed      │
│ + summaryText       │
│ + triggerReason     │
└─────────────────────┘
```
