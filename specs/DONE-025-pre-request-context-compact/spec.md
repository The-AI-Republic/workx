# Feature Specification: Pre-Request Context Window Compaction

**Feature Branch**: `025-pre-request-context-compact`
**Created**: 2026-02-17
**Status**: Draft
**Input**: User description: "Move chat history compaction check from post-LLM-response to pre-LLM-request, add token estimation, increase threshold to 85%, and verify LLM context window data accuracy"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prevent Context Overflow Before LLM Request (Priority: P1)

As a user engaged in a long conversation with the AI assistant, I want the system to check whether the conversation history will exceed the LLM's context window **before** sending the next request, so that requests never fail due to context overflow.

Currently, compaction only happens **after** receiving an LLM response, which means the outgoing request itself could exceed the context window and cause an error. By moving the check to before the request is sent, the system estimates the total token count (existing history + new input) and compacts if necessary, ensuring every request fits within the model's limits.

**Why this priority**: This is the core behavioral change that eliminates the risk of context overflow errors. Without this, long conversations can fail unpredictably when the next request pushes past the context window.

**Independent Test**: Can be fully tested by running a conversation until token usage approaches the context window limit, then verifying that compaction occurs **before** the next LLM request is sent (not after the response is received).

**Acceptance Scenarios**:

1. **Given** a conversation where accumulated tokens are at 80% of the context window and the next user input would push total tokens past 85%, **When** the system prepares to send the next turn, **Then** compaction is triggered before the LLM request is sent, and the request succeeds without overflow.
2. **Given** a conversation where accumulated tokens are at 50% of the context window, **When** the system prepares to send the next turn, **Then** no compaction occurs and the request is sent normally.
3. **Given** a conversation where the user sends a very large input message, **When** the system estimates that history + new input exceeds 85% of the context window, **Then** compaction runs before the request, reducing the history size so the total fits within limits.

---

### User Story 2 - Accurate Context Window Configuration (Priority: P2)

As a system administrator, I want the context window sizes configured for each LLM model to accurately reflect the real limits published by each provider, so that compaction thresholds are calculated against correct values and the system uses available context space efficiently.

**Why this priority**: Incorrect context window values can cause either premature compaction (wasting context space and losing conversation detail) or late compaction (risking overflow errors). Accurate values are foundational for the compaction logic to work correctly.

**Independent Test**: Can be tested by comparing each model's configured context window value against the provider's official documentation and verifying they match.

**Acceptance Scenarios**:

1. **Given** the model configuration file, **When** the context window value for any model is compared to the provider's official documentation, **Then** the configured value matches the documented limit.
2. **Given** a model with an incorrect context window value in the current configuration, **When** the update is applied, **Then** the corrected value is used for all compaction threshold calculations.

---

### User Story 3 - Simple Token Estimation for Pre-Request Check (Priority: P3)

As a user, I want the system to quickly estimate token counts using a simple character-based heuristic (without external tokenizer libraries), so that the pre-request compaction check is fast and does not add noticeable latency to each turn.

**Why this priority**: Token estimation is a supporting mechanism for the P1 story. It must be simple and fast since it runs on every turn. The existing `approxTokenCount` utility already uses a word-based heuristic; this story ensures the estimation approach for the new pre-request check is lightweight and covers the full request payload (history + new input + system instructions).

**Independent Test**: Can be tested by providing text inputs of known token counts (verified with a proper tokenizer) and checking that the estimation is within an acceptable margin of error (e.g., within 20% of actual token count).

**Acceptance Scenarios**:

1. **Given** a conversation history and new user input, **When** the system estimates the total token count for the upcoming request, **Then** the estimation completes in under 10 milliseconds.
2. **Given** text content of various lengths, **When** the estimation function is applied, **Then** the result is within 20% of the actual token count for that content.

---

### Edge Cases

- What happens when a single user message is so large that even after compaction, the request still exceeds the context window? The system should proceed with the compacted history and let the LLM provider return a standard error rather than silently dropping content.
- What happens when the compaction LLM call itself fails (e.g., rate limit, network error) during the pre-request phase? The system should attempt the original request anyway, relying on existing error handling for context overflow.
- What happens when the model client does not report a context window value? The system should skip the pre-request compaction check and fall back to the existing post-response behavior.
- What happens when token estimation is significantly inaccurate (underestimates by more than 20%)? The system should still have the existing post-response compaction as a safety net; the pre-request check is additive, not a replacement of all safeguards.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST perform a context window usage check **before** sending each LLM request, estimating the total token count of the conversation history plus the new input.
- **FR-002**: System MUST trigger chat history compaction when the estimated total tokens meet or exceed 85% of the model's context window size, **prior to** sending the request.
- **FR-003**: System MUST use a simple, lightweight token estimation approach based on character/word count heuristics, without requiring external tokenizer libraries.
- **FR-004**: System MUST set the compaction trigger threshold to 85% of the active model's context window size.
- **FR-005**: System MUST use verified, accurate context window sizes for all configured LLM models, reflecting each provider's official specifications.
- **FR-006**: System MUST include the full request payload in the estimation (conversation history, system instructions, new user input, and tool definitions if applicable).
- **FR-007**: System MUST proceed with the LLM request after compaction completes successfully, using the compacted history.
- **FR-008**: System MUST still proceed with the LLM request even if pre-request compaction fails, allowing the provider's own error handling to catch any overflow.
- **FR-009**: System MUST maintain the existing post-response compaction check as a secondary safety mechanism.

### Key Entities

- **Token Estimate**: An approximate count of tokens for a given text or request payload, derived from character/word count heuristics. Used to decide whether compaction is needed before sending a request.
- **Context Window Configuration**: The maximum token capacity for each LLM model, stored as part of the model's configuration. Must match the provider's official published limit.
- **Compaction Threshold**: A percentage of the context window (85%) that triggers compaction when the estimated token usage reaches or exceeds it.

## Assumptions

- The existing `approxTokenCount` utility (word-based heuristic with 1.3 multiplier) or a similar simple approach is sufficient for the pre-request estimation. Exact token counting is not required; the goal is a conservative estimate that errs on the side of triggering compaction slightly early rather than too late.
- The existing compaction pipeline (`CompactService`, `SummaryGenerator`, `HistoryReconstructor`) remains unchanged; only the **timing** of when compaction is triggered changes.
- Both the `TaskRunner.COMPACTION_THRESHOLD` (currently 0.85) and the `DEFAULT_COMPACTION_CONFIG.triggerThreshold` (currently 0.9) should be aligned to 0.85 to avoid inconsistency.
- The post-response compaction check can be retained as a secondary safety net or removed if deemed redundant after the pre-request check is in place. The decision should favor keeping it as a fallback.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero context overflow errors occur when the pre-request compaction check is active, across conversations of any length.
- **SC-002**: Compaction is triggered before the LLM request in 100% of cases where the estimated token count exceeds 85% of the context window.
- **SC-003**: The pre-request token estimation adds less than 50 milliseconds of latency per turn.
- **SC-004**: All configured model context window sizes match their respective provider's official documentation, with 0 discrepancies.
- **SC-005**: Existing conversation quality is maintained — compaction produces coherent summaries and preserves essential context, with no regression in user-perceived conversation continuity.
