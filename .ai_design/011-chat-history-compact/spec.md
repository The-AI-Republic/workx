# Feature Specification: Chat History Compaction

**Feature Branch**: `011-chat-history-compact`
**Created**: 2025-11-22
**Status**: Draft
**Input**: User description: "Implement chat history compact for browserx. Currently running the agent in non-conversation compact way, causing the context window to always exceed the limit."

## Clarifications

### Session 2025-11-22

- Q: Should users have manual control to trigger compaction, or automatic only? → A: Both automatic (at 90% threshold) and manual trigger
- Q: What observability is needed for compaction events? → A: Console logging only (debug-level logs)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic Context Compaction (Priority: P1)

As a user having a long conversation with the browser agent, I want the system to automatically compact the chat history when approaching the context window limit, so that my conversation can continue without interruption or errors.

**Why this priority**: This is the core functionality - without automatic compaction, long conversations fail when exceeding context limits. This directly solves the stated problem of context window overflow.

**Independent Test**: Can be fully tested by starting a conversation, performing many agent actions until token usage approaches the model's context limit, and verifying the conversation continues seamlessly after compaction occurs.

**Acceptance Scenarios**:

1. **Given** a conversation with 90% of context window used, **When** the user sends a new message, **Then** the system automatically triggers compaction before the API call, reducing token usage while preserving essential context.

2. **Given** compaction is triggered, **When** the LLM generates a summary, **Then** the summary captures: current progress, key decisions made, important context/constraints, and clear next steps.

3. **Given** compaction completes, **When** the conversation continues, **Then** the user experiences no interruption and the agent maintains awareness of prior context through the summary.

---

### User Story 2 - Preserved User Messages After Compaction (Priority: P2)

As a user, I want my recent messages preserved after compaction so that the agent remembers my specific requests and preferences from recent interactions.

**Why this priority**: User messages contain the actual task requirements. Losing them would cause the agent to lose track of what the user wants. Second priority because it depends on the compaction mechanism existing first.

**Independent Test**: Can be tested by having a conversation, triggering compaction, then asking the agent to recall a specific user request from the preserved messages.

**Acceptance Scenarios**:

1. **Given** compaction is performed, **When** the new history is constructed, **Then** recent user messages are preserved (up to a token budget) in addition to the summary.

2. **Given** user messages exceed the preservation budget, **When** selecting which to keep, **Then** the most recent messages are prioritized (older messages may be truncated or omitted).

3. **Given** a user message is very long, **When** it would exceed remaining budget, **Then** it is truncated with a marker indicating truncation occurred.

---

### User Story 3 - Compaction Transparency (Priority: P3)

As a user, I want to be informed when compaction occurs so that I understand why the conversation context may have changed.

**Why this priority**: Important for user trust and understanding, but not essential for the core functionality to work.

**Independent Test**: Can be tested by triggering compaction and verifying the user receives a notification explaining what happened.

**Acceptance Scenarios**:

1. **Given** compaction completes successfully, **When** the new history is active, **Then** the user receives a notification that context was compacted.

2. **Given** compaction is triggered, **When** older items had to be trimmed to fit the compaction prompt, **Then** the user is informed how many items were trimmed.

3. **Given** multiple compactions occur in a session, **When** the user receives the notification, **Then** they are warned that multiple compactions may reduce accuracy.

---

### Edge Cases

- What happens when compaction itself exceeds context window? System trims oldest history items and retries (with notification).
- How does system handle compaction failure (API error)? Retry with exponential backoff up to max retries; if still fails, report error to user.
- What if conversation has no meaningful content to summarize? Return a placeholder summary "(no summary available)" and preserve user messages.
- How are tool call results handled during compaction? Tool calls and their outputs are included in the history being summarized but not individually preserved.
- What happens to DOM snapshots during compaction? They are excluded from the summary (already handled by existing snapshot compression).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST trigger compaction automatically when total token usage reaches a configurable threshold (default: 90% of model context window).

- **FR-002**: System MUST provide a manual compaction trigger allowing users to compact the conversation at any time, regardless of current token usage.

- **FR-003**: System MUST use an LLM call to generate a structured summary of the conversation that includes: current progress, key decisions, important context/constraints, and remaining next steps.

- **FR-004**: System MUST preserve recent user messages after compaction, subject to a token budget (default: 20,000 tokens for user messages).

- **FR-005**: System MUST reconstruct the conversation history after compaction with: initial context (system instructions), preserved user messages, and the generated summary.

- **FR-006**: System MUST handle compaction prompt overflow by trimming oldest history items and retrying.

- **FR-007**: System MUST display a notification to users when compaction occurs, including how many items were trimmed (if any).

- **FR-008**: System MUST warn users when multiple compactions have occurred that conversation accuracy may be reduced.

- **FR-009**: System MUST invalidate any cached state after compaction to force fresh context on next turn.

- **FR-010**: System MUST support retrying compaction with exponential backoff on transient errors.

- **FR-011**: System MUST preserve the summary prefix format so that summary messages can be identified and filtered in future compactions (prevents summarizing summaries).

- **FR-012**: System MUST log compaction events to the console at debug level, including: trigger reason (auto/manual), token usage before/after, items trimmed count, and success/failure status.

### Key Entities

- **ConversationSummary**: The LLM-generated summary text prefixed with a recognizable marker for identification.
- **CompactedHistory**: The reconstructed history array containing: initial context items, preserved user messages, and the summary message.
- **CompactionConfig**: Configuration for thresholds (trigger percentage, user message budget, max retries).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can have conversations that exceed the model context window without experiencing errors or interruptions.

- **SC-002**: After compaction, the agent maintains sufficient context to continue tasks meaningfully (can reference prior decisions and progress).

- **SC-003**: Compaction reduces context usage by at least 50% while preserving essential information.

- **SC-004**: Users receive clear notification when compaction occurs within 2 seconds of completion.

- **SC-005**: Compaction completes successfully in at least 95% of attempts (with retry logic).

## Assumptions

- The existing token counting heuristic (word count * 1.3) is sufficient for threshold detection; exact counts come from API responses.
- The same LLM model used for conversation will be used for generating the summary.
- The existing history replacement mechanisms can be used for swapping in compacted history.
- The summarization prompt approach ("Context Checkpoint Compaction") is appropriate for browser automation context.
- The summary prefix pattern effectively communicates handoff context to the resumed conversation.
