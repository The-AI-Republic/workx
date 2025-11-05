# Research: Gemini Streaming Event Bug Root Cause

## Executive Summary

The BrowserX extension integrates with Google's Gemini AI through the OpenAI-compatible Chat Completions API. Two critical bugs exist that prevent Gemini from working correctly:

1. **Missing Text Responses**: When users send messages like "hi", the agent completes the turn without displaying the response text, showing only "Task completed in 1 turn(s)".
2. **Incomplete Tool Calls**: Function calls don't complete properly due to premature completion signals.

**Root Cause**: The `convertChatCompletionEventToResponseEvent()` method in OpenAIResponsesClient.ts (lines 639-759) **emits text deltas but never creates a message item containing the accumulated text**. The Responses API (used by OpenAI/xAI) automatically accumulates text and emits `OutputItemDone` with a complete message item. However, the Chat Completions API (used by Gemini) streams text as deltas and requires **manual accumulation** to create the final message item.

When Gemini responds with text:
- Text deltas are correctly emitted as `OutputTextDelta` events (line 662-667)
- TurnManager correctly displays these deltas to the user (lines 231-237)
- BUT when `finish_reason: "stop"` arrives (line 708), the code only emits `Completed` (line 754-755)
- **No `OutputItemDone` event is created** with the accumulated message text
- TaskRunner sees NO response items in the turn result (line 540)
- TaskRunner marks `taskComplete = true` because there are no pending tool calls (line 542)
- The accumulated text exists ONLY in the UI, never in conversation history

This is fundamentally incompatible with the TurnManager/TaskRunner architecture, which expects **all model responses to be represented as response items** that can be stored in conversation history.

## Current Implementation Analysis

### Streaming Event Conversion Flow

The streaming pipeline works as follows:

1. **API Selection** (OpenAIResponsesClient.ts:1034-1038):
   - Gemini is detected by provider name `'Google AI Studio'` or model name starting with `'gemini-'`
   - Routes to `makeChatCompletionsRequest()` instead of Responses API

2. **Chat Completions Streaming** (lines 1112-1212):
   - Converts Responses API format to Chat Completions format
   - Returns OpenAI SDK stream of chat completion chunks
   - Each chunk has structure: `{ id, choices: [{ delta, finish_reason }], usage }`

3. **Event Conversion** (lines 639-759):
   - `convertChatCompletionEventToResponseEvent()` processes each chunk
   - Text deltas: `delta.content` → `OutputTextDelta` event (lines 662-667)
   - Tool calls: accumulated incrementally in `chatCompletionToolCalls` Map (lines 669-705)
   - Completion: `finish_reason` → `Completed` event (lines 708-755)

4. **TurnManager Processing** (TurnManager.ts:183-278):
   - Receives events via `for await (const event of stream)`
   - `OutputTextDelta`: emits to UI as `AgentMessageDelta` (lines 231-237)
   - `OutputItemDone`: processes response item and stores in history (lines 200-207)
   - `Completed`: returns turn result (lines 221-228)

5. **TaskRunner Decision** (TaskRunner.ts:533-620):
   - Examines `processedItems` from turn result
   - If only assistant messages without responses → `taskComplete = true` (line 551)
   - If function calls with responses → `taskComplete = false` (line 559)

### Code Locations

**Text Delta Handling**:
- File: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`
- Lines: 662-667
- What it does: Emits `OutputTextDelta` events when `delta.content` is present
- Missing: Does NOT accumulate text for creating final message item

**Tool Call Accumulation**:
- File: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`
- Lines: 669-705
- What it does: Accumulates tool call chunks in `chatCompletionToolCalls` Map
- State: Instance variable, persists between chunks within a single stream

**Event Emission**:
- File: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`
- Lines: 646-648, 709-755
- What it does: Returns events from pending queue or creates new events
- Issue: Text completion creates `Completed` event but NO `OutputItemDone`

**Completion Signals**:
- File: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`
- Lines: 708-755
- What it does: Handles `finish_reason` to emit completion events
- For tool_calls: Emits `OutputItemDone` + queues `Completed` (lines 716-748)
- For stop/length: Emits `Completed` only (lines 754-755)

### Agent Loop Integration

**TurnManager Event Processing**:
- File: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/core/TurnManager.ts`
- Lines: 165-278 (tryRunTurn method)
- Flow:
  1. Calls `modelClient.stream()` to get ResponseEvent stream (line 173)
  2. Iterates through events in `for await` loop (line 183)
  3. `OutputTextDelta`: Emits UI event `AgentMessageDelta` (lines 231-237)
  4. `OutputItemDone`: Calls `handleResponseItem()` and stores result (lines 200-207)
  5. `Completed`: Returns `TurnRunResult` with `processedItems` and `tokenUsage` (lines 221-228)
  6. Stream closed without `Completed`: Throws error (line 269)

**Expected Events for Complete Turn**:
- TurnManager expects the following sequence for a text response:
  1. `Created` (optional)
  2. `OutputTextDelta` events (streaming text)
  3. `OutputItemDone` with complete message item containing accumulated text
  4. `Completed` with token usage
- For Gemini, event #3 is **missing entirely**

**TaskRunner Completion Logic**:
- File: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/core/TaskRunner.ts`
- Lines: 542-619 (processTurnResult method)
- Decision tree:
  - `taskComplete = true` initially (line 542)
  - Iterates through `processedItems` (line 546)
  - Assistant message WITHOUT response → keeps `taskComplete = true` (lines 551-552)
  - Function call WITH response → sets `taskComplete = false` (lines 556-561)
- **For Gemini text responses**: `processedItems` is EMPTY → `taskComplete = true` → task ends

**What triggers taskComplete = true**:
- Line 542: Initial value
- Line 551: Assistant message item (which requires OutputItemDone event)
- **Bug**: Gemini never sends OutputItemDone for text, so no assistant message item exists
- Result: Empty `processedItems` → task completes immediately

## Bug Analysis

### Bug 1: Missing Text Responses

**Symptom**: User sends "hi", sees "Task completed in 1 turn(s)" without response text

**Root Cause**:
- **File**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`
- **Lines**: 708-755 (finish_reason handling in convertChatCompletionEventToResponseEvent)
- **Issue**: When `finish_reason === "stop"`, the code only emits a `Completed` event. It does NOT emit an `OutputItemDone` event with a message item containing the accumulated text.

**Code Snippet** (lines 754-755):
```typescript
// Emit completion event for "stop", "length", etc.
return completedEvent;
```

**Why It Happens**:

1. Gemini streams response as Chat Completions chunks:
```json
{ "choices": [{ "delta": { "content": "Hello" } }] }
{ "choices": [{ "delta": { "content": " there!" } }] }
{ "choices": [{ "finish_reason": "stop" }] }
```

2. First two chunks emit `OutputTextDelta` events (lines 662-667):
   - These display text in the UI via TurnManager (lines 231-237)
   - BUT no accumulation happens for conversation history

3. Third chunk has `finish_reason: "stop"` (line 708):
   - Creates `Completed` event (lines 709-713)
   - Checks if `finish_reason === 'tool_calls'` (line 716) → FALSE
   - Clears tool calls state (line 752)
   - Returns `completedEvent` (line 755)
   - **MISSING**: No `OutputItemDone` event with accumulated text

4. TurnManager receives events:
   - `OutputTextDelta` → UI shows text ✓
   - `Completed` → Returns turn result
   - **Missing**: `OutputItemDone` with message item

5. TaskRunner processes turn result:
   - `processedItems` is EMPTY (no OutputItemDone was received)
   - Line 542: `taskComplete = true` (initial state)
   - No items to iterate (line 546)
   - Returns `taskComplete = true` (line 616)
   - Task ends immediately

**Evidence**:

Compare with tool call handling (lines 716-748):
```typescript
if (finishReason === 'tool_calls') {
  const toolCallsArray = Array.from(this.chatCompletionToolCalls.values());
  this.chatCompletionToolCalls.clear();

  if (toolCallsArray.length > 0) {
    const toolCall = toolCallsArray[0];

    // Queue the Completed event for next call
    this.pendingEvents.push(completedEvent);

    // Return the OutputItemDone event immediately
    return {
      type: 'OutputItemDone',
      item: {
        type: 'function_call',
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    };
  }
}
```

This pattern **correctly emits OutputItemDone**, but it's ONLY done for tool calls, NOT for text responses.

### Bug 2: Incomplete Tool Calls

**Symptom**: Function calls don't execute or complete properly

**Root Cause**:
- **File**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`
- **Lines**: 716-748 (tool_calls finish_reason handling)
- **Issue**: The code emits `OutputItemDone` for tool calls, but it's interleaved incorrectly with the `Completed` event via the pending queue mechanism.

**Code Snippet** (lines 732-744):
```typescript
// Queue the Completed event for next call
this.pendingEvents.push(completedEvent);

// Return the OutputItemDone event immediately
return {
  type: 'OutputItemDone',
  item: {
    type: 'function_call',
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  },
};
```

**Why It Happens**:

1. Tool call chunks arrive incrementally:
```json
{ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_123", "function": { "name": "search" } }] } }] }
{ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"q" } }] } }] }
{ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "uery\":" } }] } }] }
{ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": " \"test\"}" } }] } }] }
{ "choices": [{ "finish_reason": "tool_calls" }] }
```

2. Each delta chunk (lines 670-705):
   - Accumulates in `chatCompletionToolCalls` Map
   - Returns `null` (line 704) → no event emitted yet

3. finish_reason chunk (line 716):
   - Creates `OutputItemDone` with accumulated tool call
   - Queues `Completed` in `pendingEvents` (line 733)
   - Returns `OutputItemDone` immediately (lines 736-744)

4. Next chunk (line 646-648):
   - Checks `pendingEvents.length > 0`
   - Returns queued `Completed` event

5. **Problem**: The event order might be correct, BUT:
   - If there's any issue with the pending queue (e.g., stream ends before queue is flushed)
   - Or if the Completed event arrives before tool execution finishes
   - The turn completes prematurely

**Evidence**:

The pending queue mechanism (lines 646-648) relies on subsequent chunks to flush:
```typescript
// Check if we have pending events from previous chunk
if (this.pendingEvents.length > 0) {
  return this.pendingEvents.shift()!;
}
```

But when `finish_reason: "tool_calls"` is in the LAST chunk, there are no more chunks to trigger the pending event flush. The fallback is in the stream processing loops (lines 518-521, 552-555), but this happens AFTER the stream iteration completes.

**Alternative Theory**: The bug might be less severe than Bug 1. Tool calls DO get emitted via OutputItemDone, but the issue might be:
- Text responses accompanying tool calls are lost (same as Bug 1)
- Or the Completed event timing causes premature termination

## Provider Comparison

### OpenAI Streaming Behavior

**API**: Responses API (`/v1/responses`)

**Event Sequence** (from SDK):
```typescript
{ type: 'response.created' }
{ type: 'response.output.text.delta', delta: 'Hello' }
{ type: 'response.output.text.delta', delta: ' there!' }
{ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello there!' }] } }
{ type: 'response.completed', response: { id: 'resp_123', usage: {...} } }
```

**Key Characteristics**:
- Server automatically accumulates text deltas
- `response.output_item.done` contains the COMPLETE message with all accumulated text
- TurnManager receives `OutputItemDone` with full message item
- Conversation history gets complete message item

**Code Path**:
- Lines 567-627: `convertSDKEventToResponseEvent()` for Responses API events
- Line 586-589: `response.output_item.done` → `OutputItemDone` with `item`
- Line 592-596: `response.output.text.delta` → `OutputTextDelta` with `delta`

### Gemini Streaming Behavior

**API**: Chat Completions API (`/v1/chat/completions`)

**Event Sequence** (from SDK):
```typescript
{ id: 'chatcmpl_123', choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }
{ id: 'chatcmpl_123', choices: [{ delta: { content: ' there!' }, finish_reason: null }] }
{ id: 'chatcmpl_123', choices: [{ delta: {}, finish_reason: 'stop' }], usage: {...} }
```

**Key Characteristics**:
- Server does NOT accumulate text
- Client must accumulate `delta.content` chunks
- `finish_reason: 'stop'` signals end, but NO message item is provided
- Current code emits `OutputTextDelta` but never creates message item

**Code Path**:
- Lines 639-759: `convertChatCompletionEventToResponseEvent()` for Chat Completions
- Lines 662-667: `delta.content` → `OutputTextDelta` event (text shown in UI)
- Lines 708-755: `finish_reason` → `Completed` event (NO message item created)

### Key Differences

| Aspect | OpenAI (Responses API) | Gemini (Chat Completions) | Impact |
|--------|------------------------|---------------------------|--------|
| Text Accumulation | Server-side (automatic) | Client-side (manual required) | Gemini text is LOST from history |
| Message Item | Emitted via `output_item.done` | NOT emitted at all | TurnManager expects item |
| Event for Text | `OutputTextDelta` + `OutputItemDone` | `OutputTextDelta` only | TaskRunner sees empty turn |
| Tool Call Handling | `output_item.done` with function_call | Incremental deltas + manual accumulation | Works correctly (has accumulation) |
| Completion Signal | `response.completed` | `finish_reason` in chunk | Both work, but Gemini misses message |

**Critical Difference**: The Responses API's `response.output_item.done` event provides the COMPLETE response item including all accumulated text. The Chat Completions API provides NO such event - the client must create the message item manually.

## Solution Strategy

### Fix 1: Text Accumulation and Message Creation

**Proposed Change**: Add text accumulation for Chat Completions streaming, mirroring the tool call accumulation pattern.

**Location**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`

**Rationale**:
- Tool calls already use accumulation pattern (lines 116-123, 669-705)
- Same pattern should apply to text content
- Must emit `OutputItemDone` with complete message item before `Completed`

**Implementation**:

1. Add text accumulation state (after line 123):
```typescript
// Chat Completions streaming state (for Gemini and other providers)
// Tool calls arrive incrementally, so we need to accumulate them
private chatCompletionToolCalls: Map<number, {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}> = new Map();

// Text content accumulation for Chat Completions
// Unlike Responses API, Chat Completions requires client-side accumulation
private chatCompletionTextContent: string = '';
```

2. Accumulate text deltas (modify lines 662-667):
```typescript
// Handle text content deltas
if (delta?.content) {
  // Accumulate text for message item creation
  this.chatCompletionTextContent += delta.content;

  return {
    type: 'OutputTextDelta',
    delta: delta.content,
  };
}
```

3. Emit message item on completion (modify lines 708-755):
```typescript
// Handle completion with finish_reason
if (finishReason) {
  const completedEvent: ResponseEvent = {
    type: 'Completed',
    responseId: chatEvent.id || '',
    tokenUsage: chatEvent.usage ? this.convertChatCompletionUsageToTokenUsage(chatEvent.usage) : undefined,
  };

  // If tool_calls finish reason, emit OutputItemDone first, then Completed
  if (finishReason === 'tool_calls') {
    const toolCallsArray = Array.from(this.chatCompletionToolCalls.values());

    // Clear accumulated tool calls for next request
    this.chatCompletionToolCalls.clear();

    // ALSO clear text content (tool calls might have accompanying text)
    this.chatCompletionTextContent = '';

    if (toolCallsArray.length > 0) {
      const toolCall = toolCallsArray[0];

      if (toolCallsArray.length > 1) {
        console.warn('[OpenAIResponsesClient] Multiple tool calls detected, but only emitting first one:', toolCallsArray);
      }

      // Queue the Completed event for next call
      this.pendingEvents.push(completedEvent);

      // Return the OutputItemDone event immediately
      return {
        type: 'OutputItemDone',
        item: {
          type: 'function_call',
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      };
    }

    // If no tool calls accumulated, just emit completion
    return completedEvent;
  }

  // For "stop", "length", etc. - emit message item if text was accumulated
  if (this.chatCompletionTextContent.length > 0) {
    const messageText = this.chatCompletionTextContent;

    // Clear text content for next request
    this.chatCompletionTextContent = '';

    // Clear tool calls state for next request
    this.chatCompletionToolCalls.clear();

    // Queue the Completed event for next call
    this.pendingEvents.push(completedEvent);

    // Return OutputItemDone with accumulated message
    return {
      type: 'OutputItemDone',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: messageText,
        }],
      },
    };
  }

  // Clear state for next request (edge case: no text or tool calls)
  this.chatCompletionToolCalls.clear();
  this.chatCompletionTextContent = '';

  // Emit completion event
  return completedEvent;
}
```

### Fix 2: Stream End Flush

**Proposed Change**: Ensure pending events are always flushed at stream end

**Location**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`

**Rationale**: The pending queue is already flushed in `processSDKStream()` (lines 518-521) and `processSDKStreamToResponseStream()` (lines 552-555). This fix ensures it works correctly.

**Implementation**: The existing flush logic is already correct:

```typescript
// Flush any pending events after stream ends
// (e.g., Completed event queued after OutputItemDone for tool calls)
while (this.pendingEvents.length > 0) {
  const pendingEvent = this.pendingEvents.shift()!;
  yield pendingEvent;
}
```

No change needed - Fix 1 makes this work correctly by always queuing Completed after OutputItemDone.

### Fix 3: State Reset Between Requests

**Proposed Change**: Ensure text and tool call accumulators are reset at start of each stream

**Location**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`

**Rationale**: Prevent state leakage between consecutive requests

**Implementation**: Add reset in stream start methods (after line 173 and 540):

```typescript
// In attemptStreamResponses (add after line 386):
const sdkStream = await this.makeResponsesApiRequest(payload);

// Reset Chat Completions state for new request
this.chatCompletionToolCalls.clear();
this.chatCompletionTextContent = '';

// In processSDKStream (add after line 505):
try {
  // Reset state at stream start
  this.chatCompletionToolCalls.clear();
  this.chatCompletionTextContent = '';

  for await (const chunk of sdkStream) {
```

### Logging Enhancement

**Approach**: Add trace-level logging gated by environment variable to help debug streaming issues

**Locations**: Add at key decision points

**Log Points**:

1. Chat Completions routing (after line 1036):
```typescript
if (this.provider.name === 'Google AI Studio' || this.currentModel.startsWith('gemini-')) {
  console.log('[Gemini Debug] Routing to Chat Completions API (provider:', this.provider.name, ', model:', this.currentModel, ')');
  return this.makeChatCompletionsRequest(payload);
}
```

2. Text delta accumulation (in modified lines 662-667):
```typescript
if (delta?.content) {
  this.chatCompletionTextContent += delta.content;
  console.log('[Gemini Debug] Accumulated text:', this.chatCompletionTextContent.length, 'chars');

  return {
    type: 'OutputTextDelta',
    delta: delta.content,
  };
}
```

3. Message item creation (in modified lines 754-755):
```typescript
if (this.chatCompletionTextContent.length > 0) {
  const messageText = this.chatCompletionTextContent;
  console.log('[Gemini Debug] Creating message item with', messageText.length, 'chars');

  // ... emit OutputItemDone
}
```

## Validation Approach

### Test Case 1: Simple Text Response

**Scenario**: User sends "hi", Gemini responds "Hello! How can I help you?"

**Expected Behavior**:
1. TurnManager receives `OutputTextDelta` events (text shown in UI)
2. TurnManager receives `OutputItemDone` with complete message item
3. TurnManager receives `Completed` event
4. TaskRunner processes message item → `taskComplete = true`
5. Message stored in conversation history
6. UI shows complete response AND task completion

**Validation**:
- Check TurnManager logs for OutputItemDone event
- Check TaskRunner `processedItems` has 1 message item
- Check conversation history has assistant message
- Verify task completes after displaying full text

### Test Case 2: Tool Call

**Scenario**: User asks to search web, Gemini calls `web_search` function

**Expected Behavior**:
1. TurnManager receives accumulated tool call chunks
2. TurnManager receives `OutputItemDone` with function_call item
3. TurnManager receives `Completed` event
4. TaskRunner executes tool → `taskComplete = false`
5. Tool result stored, next turn initiated

**Validation**:
- Check OutputItemDone has complete function_call item
- Check function arguments are complete JSON
- Verify tool executes with correct parameters
- Verify turn continues after tool execution

### Test Case 3: Multiple Turns

**Scenario**: User asks question → Gemini responds → User asks followup → Gemini responds

**Expected Behavior**:
- Each turn creates message items in history
- State resets between turns (no text leakage)
- Conversation history grows correctly

**Validation**:
- Check history has alternating user/assistant messages
- Verify second response doesn't include text from first response
- Check state variables are cleared between streams

## References

### Critical Code Sections

**OpenAIResponsesClient.ts**:
- Lines 639-759: `convertChatCompletionEventToResponseEvent()` - Main bug location
- Lines 662-667: Text delta handling - Emits event but doesn't accumulate
- Lines 669-705: Tool call accumulation - Correct pattern to follow
- Lines 708-755: Completion handling - Missing message item creation
- Lines 716-748: Tool call completion - Correct pattern for OutputItemDone
- Lines 1034-1038: Gemini routing - Detects and routes to Chat Completions
- Lines 1112-1212: `makeChatCompletionsRequest()` - Gemini API call

**TurnManager.ts**:
- Lines 165-278: `tryRunTurn()` - Processes ResponseEvent stream
- Lines 183-266: Event loop - Handles each event type
- Lines 200-207: OutputItemDone handling - Processes and stores items
- Lines 231-237: OutputTextDelta handling - Emits UI event
- Lines 221-228: Completed handling - Returns turn result

**TaskRunner.ts**:
- Lines 533-620: `processTurnResult()` - Determines task completion
- Line 542: Initial `taskComplete = true` - Default completion state
- Lines 551-552: Assistant message detection - Keeps task complete
- Lines 556-561: Function call detection - Sets task incomplete

**ResponseEvent Type**:
- File: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/types/ResponseEvent.ts`
- Line 17: `OutputItemDone` - Requires ResponseItem with complete content
- Line 19: `OutputTextDelta` - Streaming text chunk (UI only)

**ResponseItem Type**:
- File: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/protocol/types.ts`
- Lines 182-233: ResponseItem union - All possible response types
- Lines 184-188: Message item - Requires role + content array
- Lines 52-67: ContentItem - Includes `output_text` with text field
