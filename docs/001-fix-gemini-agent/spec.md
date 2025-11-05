# Feature Specification: Fix Gemini Agent Integration

**Feature Branch**: `001-fix-gemini-agent`
**Created**: 2025-11-04
**Status**: Draft
**Input**: User description: "Add gemini support in the code with google ai studio as provider. Currently, we followed https://ai.google.dev/gemini-api/docs/openai#javascript to implement the gemini llm support. But the current implementation still has bugs. 1. it doesn't have message response. for example, if we type 'hi', the agent directly response task finish with 'Task completed in 1 turn(s)' 2. it cannot finish the function call either (might cause by the agent run end early) as well. Which means our TurnManger or the agent loop run might incorrectly receive the agent run ending signal."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Basic Conversation Handling (Priority: P1)

Users must be able to have basic text-based conversations with the Gemini-powered agent. When a user sends a simple message like "hi" or "what's the weather?", the agent should respond with appropriate text content before completing the turn.

**Why this priority**: This is the fundamental user interaction pattern. Without working text responses, the agent is completely unusable with Gemini as the provider. This represents the minimum viable functionality.

**Independent Test**: Can be fully tested by sending a simple text message to the agent configured with Gemini provider and verifying that a text response is received before task completion. Delivers immediate value by enabling basic Q&A interactions.

**Acceptance Scenarios**:

1. **Given** the agent is configured to use Google AI Studio (Gemini) as the provider, **When** the user sends a simple greeting like "hi", **Then** the agent should respond with a greeting message and display the response text to the user
2. **Given** the agent has responded to a user message, **When** the turn completes, **Then** the system should show the agent's complete response text, not just "Task completed in 1 turn(s)"
3. **Given** the user asks a knowledge question, **When** the Gemini model streams back the answer, **Then** the user should see the response text appear incrementally as it's streamed
4. **Given** the agent completes a response, **When** the turn summary is displayed, **Then** it should include both the response content and the turn count

---

### User Story 2 - Function/Tool Calling Execution (Priority: P1)

Users must be able to trigger agent actions that require function/tool calls. When the agent determines that a tool is needed to complete the user's request, it should execute the tool call, receive the results, and continue the conversation with those results until the task is complete.

**Why this priority**: Tool calling is essential for the agent to perform actual work beyond simple text generation. Without this, the agent cannot execute browser automation, file operations, or any other core BrowserX capabilities. This is equally critical as basic conversation.

**Independent Test**: Can be tested by asking the agent to perform an action requiring a tool call (e.g., "click the login button") and verifying that: (1) the tool call is made, (2) results are received, (3) the agent processes the results, and (4) the agent provides a final response about the action taken.

**Acceptance Scenarios**:

1. **Given** the user requests an action requiring a tool call, **When** the Gemini model determines a tool is needed, **Then** the agent should invoke the appropriate tool and wait for results
2. **Given** a tool call has been executed and results returned, **When** the agent processes the tool output, **Then** the agent should continue with additional turns if needed rather than immediately terminating
3. **Given** the agent is in the middle of a multi-turn tool calling sequence, **When** each tool completes, **Then** the agent should maintain context and progress toward task completion
4. **Given** the agent has completed all necessary tool calls, **When** the final response is ready, **Then** the agent should provide a summary of what was accomplished before marking the task complete
5. **Given** a tool call is in progress, **When** the response is streaming, **Then** the system should not prematurely signal task completion

---

### User Story 3 - Multi-Turn Conversations with Mixed Interactions (Priority: P2)

Users should be able to engage in complex workflows that mix text responses and tool executions across multiple turns. The agent should maintain conversation continuity and only complete when the user's objective is actually achieved.

**Why this priority**: Real-world agent usage involves back-and-forth interactions combining questions, confirmations, and actions. This ensures the agent can handle realistic user workflows without dropping context or terminating prematurely.

**Independent Test**: Can be tested with a multi-step scenario like "navigate to example.com, find the search button, and click it" which requires multiple tool calls interspersed with reasoning/confirmation messages. Verifies that the agent maintains state across turns.

**Acceptance Scenarios**:

1. **Given** the user provides a multi-step request, **When** the agent completes step 1, **Then** it should automatically proceed to step 2 without requiring user prompting
2. **Given** the agent is executing a complex task, **When** partial results are available, **Then** the agent should provide status updates to the user before continuing
3. **Given** the agent encounters an ambiguous situation during execution, **When** clarification is needed, **Then** the agent should ask the user a question and wait for their response
4. **Given** all steps of a complex task are complete, **When** the agent provides the final summary, **Then** the turn should complete with full context of what was accomplished

---

### Edge Cases

- What happens when the Gemini API returns an empty response or only metadata without content?
- How does the system handle cases where the agent streams tool call deltas incrementally (function name in one chunk, arguments in subsequent chunks)?
- What happens if the Gemini API completes the stream with a `finish_reason` of "stop" before accumulating complete tool call arguments?
- How does the system differentiate between "no response yet" and "intentionally empty response"?
- What happens when a streaming response is interrupted or the connection drops mid-stream?
- How does the agent handle rapid successive tool calls in a single turn versus tool calls spread across multiple turns?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST correctly identify and extract text content from Gemini streaming responses before signaling turn completion
- **FR-002**: System MUST accumulate incremental tool call information (function name and arguments) across multiple streaming chunks before emitting a complete tool call event
- **FR-003**: System MUST only signal task completion when the agent produces a text message without pending tool calls, not when tool calls are in progress
- **FR-004**: System MUST emit text delta events during streaming so users see incremental response updates in real-time
- **FR-005**: System MUST properly convert Gemini's Chat Completions API response format to the internal ResponseEvent format used by TurnManager
- **FR-006**: System MUST detect when a Gemini response contains accumulated tool calls and emit them when the stream completes with finish_reason
- **FR-007**: System MUST differentiate between turn completion events (end of one agent response) and task completion events (end of entire user request)
- **FR-008**: System MUST handle cases where Gemini returns both text content and tool calls in the same response turn
- **FR-009**: Agent loop MUST continue executing turns when tool calls are present, waiting for tool execution results before proceeding
- **FR-010**: System MUST preserve message context and tool execution history across multiple turns in a single task
- **FR-011**: System MUST correctly identify the completion state by checking for assistant messages with no tool calls AND presence of actual content
- **FR-012**: System MUST emit proper completion events that include the final assistant message content, not just metadata about turn counts
- **FR-013**: System MUST provide comprehensive trace-level diagnostic logging for all Gemini streaming events, state transitions, and tool call accumulation to aid in debugging and validation
- **FR-014**: When a Gemini response contains both text content and tool calls in the same turn, system MUST process them concurrently by streaming text to the user while simultaneously preparing tool calls for execution

### Key Entities

- **Streaming Response Event**: Represents incremental updates from the model during streaming, including text deltas, tool call deltas, and completion signals. Contains type discriminators (OutputTextDelta, OutputItemDone, Completed) and associated payload data.
- **Tool Call Accumulator**: Temporary storage for incrementally building complete tool call objects as fragments arrive across multiple streaming chunks. Tracks tool call ID, function name, and argument string accumulation indexed by tool call position.
- **Turn Result**: The outcome of a single agent turn containing processed response items (messages and function calls), token usage statistics, and indicators for whether the turn produced actionable content or requires continuation.
- **Task Completion State**: Boolean indicator managed by the agent loop determining whether the user's request has been fully satisfied. Transitions from false (continue loop) to true (exit loop) based on response content analysis.
- **Response Item**: Structured representation of a complete model output unit, either a message (with role and content) or a function call (with name, arguments, and ID). Generated after streaming completes and all deltas have been accumulated.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users receive visible text responses within 2 seconds when sending simple messages to the Gemini-powered agent
- **SC-002**: 100% of basic text-only conversations result in displayed agent responses before task completion (no premature "Task completed" without visible output)
- **SC-003**: Tool calls execute to completion with results properly fed back to the agent in 95% of cases
- **SC-004**: Multi-turn conversations requiring 3+ tool calls complete successfully without premature termination in 90% of test scenarios
- **SC-005**: Users can observe streaming text appearing incrementally during agent responses (visible progressive rendering)
- **SC-006**: Complex tasks combining text responses and tool executions complete with accurate final summaries in 85% of cases
- **SC-007**: Average task completion time for equivalent requests using Gemini matches or improves upon other provider baselines (within 10% variance)

## Assumptions *(mandatory)*

- The existing OpenAI compatibility layer for Gemini (Chat Completions API via `https://generativelanguage.googleapis.com/v1beta/openai/`) is the correct integration approach per Google's official documentation
- The codebase already has a working streaming event processing pipeline that successfully handles other providers (OpenAI, Anthropic)
- The bug is specific to how Gemini's streaming responses are parsed and converted to internal events, not a fundamental architecture issue
- The TurnManager and TaskRunner components are functioning correctly for other providers and don't require refactoring
- Tool definitions and function calling schemas are correctly formatted for OpenAI-compatible APIs
- The agent loop termination logic correctly interprets completion signals when properly formatted events are provided
- API authentication for Google AI Studio is correctly configured with valid API keys
- Network connectivity and API availability are not contributing factors to the reported issues
- The Gemini model (`gemini-2.5-pro` or similar) supports the OpenAI Chat Completions format including tool/function calling
- The issue manifests consistently and reproducibly with Gemini provider, not intermittently
- Google's OpenAI compatibility API consistently returns properly formatted responses that conform to OpenAI standards without requiring validation
- The trace-level diagnostic logging can be properly gated (via environment variable or configuration) to avoid performance impact in production

## Dependencies *(mandatory)*

- **Google AI Studio API Access**: Requires valid API key and endpoint access to `https://generativelanguage.googleapis.com/v1beta/openai/`
- **OpenAI SDK**: The implementation uses the OpenAI JavaScript/TypeScript SDK configured with Gemini's base URL
- **Existing Provider Infrastructure**: Depends on ModelClientFactory, OpenAIResponsesClient, TurnManager, and TaskRunner components
- **Streaming Event Pipeline**: Requires the event conversion system (convertChatCompletionEventToResponseEvent) to correctly transform Gemini responses
- **Tool/Function Registry**: Depends on existing tool definitions and execution infrastructure being compatible with OpenAI function calling format

## Constraints *(mandatory)*

- Must maintain backward compatibility with existing providers (OpenAI, Anthropic, etc.)
- Must not modify the core agent loop logic (TurnManager/TaskRunner) in ways that would affect other providers
- Must use the official Google-documented OpenAI compatibility layer rather than native Gemini SDK
- Must work within the existing streaming architecture and event type system
- Changes should be isolated to Gemini-specific handling code paths where possible
- Must preserve existing logging, error handling, and observability mechanisms
- Must respect the existing turn limit (MAX_TURNS) and context window management
- API costs should remain comparable to current provider costs (no dramatic increase in token usage due to implementation inefficiencies)

## Out of Scope *(mandatory)*

- Migration from OpenAI compatibility layer to native Gemini SDK
- Adding support for Gemini-specific features not available in OpenAI API (e.g., thinking_config, cached_content via extra_body)
- Optimizing token usage or implementing cost reduction strategies specific to Gemini
- Implementing retry logic or error handling beyond what exists for other providers
- Adding UI changes or user-facing configuration options for Gemini-specific settings
- Performance optimization or caching improvements specific to Gemini
- Support for Gemini models beyond those compatible with OpenAI Chat Completions API
- Implementing batch processing or file upload/download features for Gemini
- Adding telemetry or analytics specific to Gemini provider usage
- Testing or validation of Gemini's reasoning/thinking modes beyond basic functionality
- Implementing response format validation or schema checking for Gemini API responses (assumes API compliance)
