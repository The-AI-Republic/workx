# Research: Chat History Compaction

**Feature**: 011-chat-history-compact
**Date**: 2025-11-22

## Research Tasks

### 1. Codex Compaction Patterns

**Source**: `/home/rich/dev/study/codex/codex-rs/core/src/compact.rs`

**Decision**: Adopt Codex's LLM-based summarization approach with summary prefix identification.

**Rationale**: Codex is a production coding agent that handles long conversations effectively. Their approach:
1. Uses an LLM call with a dedicated summarization prompt to generate a handoff summary
2. Preserves recent user messages (up to 20k tokens) to maintain task context
3. Uses a recognizable prefix to identify summary messages and prevent re-summarization
4. Handles context overflow by trimming oldest items and retrying
5. Provides user notifications and warnings about accuracy degradation

**Alternatives Considered**:
- **Simple truncation (keep last N messages)**: Rejected - loses important early context and decisions
- **Token-based truncation without summary**: Rejected - no semantic preservation of progress/decisions
- **External summarization service**: Rejected - adds dependency; same model maintains consistency

### 2. Summary Prompt Design

**Decision**: Use Codex's "Context Checkpoint Compaction" prompt structure.

**Prompt Template** (from `codex-rs/core/templates/compact/prompt.md`):
```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

**Rationale**: This prompt is specifically designed for LLM-to-LLM handoff, focusing on actionable context rather than narrative summary.

**Alternatives Considered**:
- **Generic summarization prompt**: Rejected - doesn't focus on continuation context
- **Bullet-point-only format**: Rejected - loses nuance in complex decisions

### 3. Summary Prefix Pattern

**Decision**: Use a recognizable prefix to identify summary messages.

**Prefix Template** (from `codex-rs/core/templates/compact/summary_prefix.md`):
```
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```

**Rationale**:
- Clearly signals to the LLM that this is a handoff, not a user message
- Instructs the LLM to build on prior work, not restart
- Can be detected programmatically with `message.startsWith(prefix)`
- Prevents re-summarizing summary messages in future compactions

**Alternatives Considered**:
- **JSON wrapper**: Rejected - complicates parsing, less natural for LLM
- **XML tags**: Rejected - same issues as JSON
- **No prefix**: Rejected - can't distinguish summary from user messages

### 4. User Message Preservation Strategy

**Decision**: Preserve recent user messages up to 20,000 tokens, prioritizing most recent.

**Algorithm** (from Codex `build_compacted_history_with_limit`):
```typescript
function selectUserMessages(messages: string[], maxTokens: number): string[] {
  const selected: string[] = [];
  let remaining = maxTokens;

  // Iterate in reverse (most recent first)
  for (const message of messages.reverse()) {
    if (remaining === 0) break;

    const tokens = approxTokenCount(message);
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
    } else {
      // Truncate long message with marker
      selected.push(truncateText(message, remaining) + "\n[...tokens truncated]");
      break;
    }
  }

  return selected.reverse(); // Restore chronological order
}
```

**Rationale**:
- 20k tokens is ~15-20% of typical model context windows (128k), leaving room for summary and system prompt
- Most recent messages contain current task focus
- Truncation marker prevents confusion about incomplete messages

**Alternatives Considered**:
- **Keep all user messages**: Rejected - defeats purpose of compaction
- **Keep only last 5 messages**: Rejected - arbitrary count doesn't account for message length
- **Keep first + last messages**: Rejected - middle context often important

### 5. Token Counting Approach

**Decision**: Use existing heuristic for threshold detection; rely on API response for actual counts.

**Existing Implementation** (from `OpenAIResponsesClient.ts`):
```typescript
countTokens(text: string, model: string): number {
  const multiplier = 1.3;  // Average token multiplier
  const words = text.split(/\s+/).length;
  const punctuation = (text.match(/[.!?;:,]/g) || []).length;
  return Math.ceil((words + punctuation * 0.5) * multiplier);
}
```

**Rationale**:
- Heuristic is sufficient for threshold detection (90% trigger)
- Exact counts from API response update `TokenUsageInfo` after each turn
- Adding tiktoken dependency would increase bundle size for minimal benefit

**Alternatives Considered**:
- **tiktoken library**: Rejected - adds dependency, bundle size concerns for extension
- **Server-side token counting**: Rejected - adds latency, requires backend

### 6. Retry and Error Handling

**Decision**: Exponential backoff with max retries; trim history on context overflow.

**Strategy** (from Codex):
1. **Transient errors (network, rate limit)**: Exponential backoff up to max retries (default: 3)
2. **Context window exceeded**: Remove oldest history item, retry (repeat until fits or only 1 item left)
3. **Fatal errors**: Report to user, preserve current history

**Backoff Formula**:
```typescript
function backoff(retryCount: number): number {
  return Math.pow(2, retryCount) * 100; // 100ms, 200ms, 400ms, 800ms...
}
```

**Rationale**: Codex's approach handles all error cases gracefully without losing user work.

**Alternatives Considered**:
- **Fixed delay retries**: Rejected - doesn't adapt to rate limiting
- **Fail fast on overflow**: Rejected - loses opportunity to trim and succeed

### 7. History Reconstruction Order

**Decision**: Reconstruct as `[initial_context, ...preserved_user_messages, summary_message]`

**Rationale** (from Codex `build_compacted_history`):
1. **Initial context first**: System instructions must be at the start for proper LLM behavior
2. **User messages next**: Provides task context before the summary
3. **Summary last**: Acts as the "current state" for the LLM to continue from

**Structure**:
```typescript
interface CompactedHistory {
  initialContext: ResponseItem[];   // System prompt, initial instructions
  userMessages: ResponseItem[];     // Preserved recent user messages
  summaryMessage: ResponseItem;     // LLM-generated summary with prefix
}
```

**Alternatives Considered**:
- **Summary first, then user messages**: Rejected - LLM may fixate on summary, ignore user context
- **Interleaved summary sections**: Rejected - complicates parsing, no clear benefit

### 8. Compaction Count Tracking

**Decision**: Track compaction count in session to enable multi-compaction warnings.

**Rationale**: FR-008 requires warning users when multiple compactions occur. Codex warns:
> "Heads up: Long conversations and multiple compactions can cause the model to be less accurate. Start a new conversation when possible to keep conversations small and targeted."

**Implementation**:
```typescript
interface SessionState {
  // ... existing fields
  compactionCount: number;  // Incremented on each successful compaction
}
```

### 9. Integration Points with Existing Code

**Decision**: Integrate at TaskRunner level for automatic trigger; add UI button for manual trigger.

**Key Integration Points**:

| Component | Integration | Type |
|-----------|-------------|------|
| `TaskRunner.ts` | Check threshold before turn, trigger compaction | Automatic |
| `Session.ts` | `replaceHistory()` for swapping compacted history | Data |
| `SessionState.ts` | Track `compactionCount`, `lastCompactionTime` | State |
| `OpenAIResponsesClient.ts` | Reuse for summary generation | API |
| `App.svelte` | Manual "Compact" button, notifications | UI |

**Rationale**: Follows existing architecture patterns; minimal changes to stable components.

## Summary of Decisions

| Topic | Decision | Key Reason |
|-------|----------|------------|
| Compaction approach | LLM-based summarization | Semantic preservation |
| Summary prompt | Context checkpoint format | LLM-to-LLM handoff |
| Summary prefix | Recognizable text prefix | Prevents re-summarization |
| User message budget | 20,000 tokens | ~15-20% of context window |
| Token counting | Heuristic + API response | Avoid new dependencies |
| Error handling | Exponential backoff + trim | Graceful degradation |
| History order | initial → user → summary | Proper LLM context |
| Integration | TaskRunner + Session | Existing architecture |
