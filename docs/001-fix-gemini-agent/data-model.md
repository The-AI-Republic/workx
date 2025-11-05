# Data Model: Gemini Streaming Event Processing

## Overview

This document defines the data structures, state machines, and validation rules needed to fix the Gemini streaming event bug. The core issue is that Chat Completions API (used by Gemini) requires client-side text accumulation, while the current implementation only accumulates tool calls.

## Event State Machine

### States

The Chat Completions event processor operates in four distinct states:

1. **Streaming** - Active processing of incoming chunks
   - Initial state when stream starts
   - Remains active while delta chunks arrive
   - Accumulates text and tool calls incrementally

2. **ContentAccumulated** - Text content collected and ready for emission
   - Entered when `finish_reason` is present and text content exists
   - Triggers creation of message item with accumulated text
   - Prepares `OutputItemDone` event

3. **ToolCallsAccumulated** - Function call(s) collected and ready for emission
   - Entered when `finish_reason === 'tool_calls'` and tool calls exist
   - Triggers creation of function_call item
   - Prepares `OutputItemDone` event

4. **TurnComplete** - Completion event queued, stream ending
   - Final state after `OutputItemDone` emitted
   - `Completed` event queued in `pendingEvents`
   - Stream will flush pending events on termination

### State Transitions

```
┌─────────────┐
│   START     │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│              Streaming                          │
│  - Accumulate delta.content → textContent      │
│  - Accumulate delta.tool_calls → toolCallsMap  │
│  - Emit OutputTextDelta for each delta.content │
└──────┬──────────────┬──────────────────────────┘
       │              │
       │ finish_reason present
       │              │
       ├──────────────┴─────────────┐
       │                            │
       │ finish_reason === 'tool_calls'  finish_reason === 'stop' | 'length'
       │ AND toolCalls.size > 0     │    AND textContent.length > 0
       │                            │
       ▼                            ▼
┌──────────────────────┐    ┌──────────────────────┐
│ ToolCallsAccumulated │    │ ContentAccumulated   │
│  - Clear toolCalls   │    │  - Clear textContent │
│  - Clear textContent │    │  - Clear toolCalls   │
│  - Emit OutputItemDone│   │  - Emit OutputItemDone│
│    (function_call)   │    │    (message)         │
│  - Queue Completed   │    │  - Queue Completed   │
└──────┬───────────────┘    └──────┬───────────────┘
       │                            │
       └──────────────┬─────────────┘
                      │
                      ▼
              ┌──────────────┐
              │ TurnComplete │
              │ - Flush queue│
              │ - Emit Completed│
              └──────────────┘
                      │
                      ▼
                   ┌─────┐
                   │ END │
                   └─────┘
```

### Transition Triggers

| From State | To State | Trigger | Action |
|------------|----------|---------|--------|
| START | Streaming | Stream starts | Reset state: `chatCompletionTextContent = ''`, `chatCompletionToolCalls.clear()` |
| Streaming | Streaming | `delta.content` present | Append to `chatCompletionTextContent`, emit `OutputTextDelta` |
| Streaming | Streaming | `delta.tool_calls` present | Accumulate in `chatCompletionToolCalls` map, no event |
| Streaming | ToolCallsAccumulated | `finish_reason === 'tool_calls'` AND `chatCompletionToolCalls.size > 0` | Create function_call item, emit `OutputItemDone`, queue `Completed` |
| Streaming | ContentAccumulated | `finish_reason === 'stop'/'length'` AND `chatCompletionTextContent.length > 0` | Create message item, emit `OutputItemDone`, queue `Completed` |
| Streaming | TurnComplete | `finish_reason` present BUT no accumulated content/tools | Clear state, emit `Completed` directly |
| ToolCallsAccumulated | TurnComplete | `OutputItemDone` emitted | Next iteration flushes `pendingEvents` |
| ContentAccumulated | TurnComplete | `OutputItemDone` emitted | Next iteration flushes `pendingEvents` |
| TurnComplete | END | `pendingEvents` empty | Stream terminates |

### Edge Cases

1. **No Content or Tool Calls**: If `finish_reason` arrives but no text/tools accumulated
   - Transition: Streaming → TurnComplete (direct)
   - Action: Clear state, emit `Completed` immediately
   - Reason: Rare but valid (e.g., model refuses to respond)

2. **Text AND Tool Calls**: If both accumulated when `finish_reason` arrives
   - Transition: Streaming → ToolCallsAccumulated (tool calls take precedence)
   - Action: Clear BOTH `chatCompletionTextContent` and `chatCompletionToolCalls`
   - Reason: Text accompanying tool calls is discarded (OpenAI behavior)
   - Note: May need refinement if providers emit text + tool calls differently

3. **Multiple Tool Calls**: If `chatCompletionToolCalls.size > 1`
   - Transition: Streaming → ToolCallsAccumulated (first tool call only)
   - Action: Log warning, emit first tool call, discard others
   - Reason: Current architecture supports single tool call per turn

## Enhanced Data Structures

### Text Content Accumulator

**Purpose**: Accumulate streaming text deltas for Chat Completions API (Gemini)

**Location**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts` (after line 123)

**Definition**:
```typescript
/**
 * Text content accumulation for Chat Completions API.
 *
 * Unlike the Responses API which provides complete message items via
 * `response.output_item.done` events, the Chat Completions API streams
 * text as incremental `delta.content` chunks. We must accumulate these
 * client-side to create the final message item.
 *
 * State Management:
 * - Initialized to empty string at stream start
 * - Appended on each `delta.content` chunk
 * - Used to create message item when `finish_reason` arrives
 * - Cleared after OutputItemDone emission OR on state reset
 *
 * Lifecycle:
 * 1. Stream start: Reset to ''
 * 2. Delta chunks: Append delta.content
 * 3. Completion: Create message item, queue Completed, clear
 * 4. Stream end: Should be empty (cleared in step 3)
 */
private chatCompletionTextContent: string = '';
```

**Operations**:
- **Reset**: `this.chatCompletionTextContent = ''` (at stream start, after emission)
- **Accumulate**: `this.chatCompletionTextContent += delta.content` (on each text delta)
- **Read**: `const messageText = this.chatCompletionTextContent` (on completion)
- **Validate**: `this.chatCompletionTextContent.length > 0` (before creating message item)

### Tool Calls Accumulator

**Purpose**: Accumulate streaming tool call deltas for Chat Completions API (existing, needs documentation)

**Location**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts` (lines 116-123)

**Existing Definition**:
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
```

**Enhanced Documentation**:
```typescript
/**
 * Tool call accumulation for Chat Completions API.
 *
 * Tool calls stream as incremental deltas with index-based updates:
 * - First chunk: { index: 0, id: 'call_123', function: { name: 'search' } }
 * - Second chunk: { index: 0, function: { arguments: '{"q' } }
 * - Third chunk: { index: 0, function: { arguments: 'uery": "test"}' } }
 *
 * State Management:
 * - Map key is tool call index (number)
 * - Map value is accumulated tool call object
 * - Each delta updates existing entry or creates new entry
 * - Cleared after OutputItemDone emission OR on state reset
 *
 * Lifecycle:
 * 1. Stream start: Clear map
 * 2. Delta chunks: Update map by index
 * 3. Completion (finish_reason === 'tool_calls'): Emit first tool call, clear map
 * 4. Completion (other finish_reason): Clear map (tools discarded)
 */
private chatCompletionToolCalls: Map<number, {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}> = new Map();
```

**Operations**:
- **Reset**: `this.chatCompletionToolCalls.clear()` (at stream start, after emission)
- **Accumulate**: See "Tool Call Accumulation Logic" below
- **Read**: `const toolCallsArray = Array.from(this.chatCompletionToolCalls.values())` (on completion)
- **Validate**: `this.chatCompletionToolCalls.size > 0` (before creating function_call item)

### Tool Call Accumulation Logic

**Location**: Lines 669-705 in `convertChatCompletionEventToResponseEvent()`

**Process**:
1. Check if `delta.tool_calls` array exists and is non-empty
2. For each tool call delta in array:
   - Extract `index` (required for incremental updates)
   - Get existing accumulated tool call: `existingToolCall = map.get(index)`
   - If new tool call (`!existingToolCall`):
     - Initialize with `id`, `type`, `function.name`, `function.arguments`
   - If updating existing tool call:
     - Preserve `id`, `type` from existing
     - Update `function.name` if present in delta
     - Append `function.arguments` if present in delta
   - Store updated tool call: `map.set(index, updatedToolCall)`
3. Return `null` (no event emitted until completion)

**Example Accumulation**:
```
Chunk 1: delta.tool_calls = [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'search', arguments: '' } }]
  → map.set(0, { id: 'call_abc', type: 'function', function: { name: 'search', arguments: '' } })

Chunk 2: delta.tool_calls = [{ index: 0, function: { arguments: '{"query":' } }]
  → existing = map.get(0)
  → map.set(0, { id: 'call_abc', type: 'function', function: { name: 'search', arguments: '{"query":' } })

Chunk 3: delta.tool_calls = [{ index: 0, function: { arguments: ' "hello"}' } }]
  → existing = map.get(0)
  → map.set(0, { id: 'call_abc', type: 'function', function: { name: 'search', arguments: '{"query": "hello"}' } })

Chunk 4: finish_reason = 'tool_calls'
  → toolCallsArray = [{ id: 'call_abc', type: 'function', function: { name: 'search', arguments: '{"query": "hello"}' } }]
  → Emit OutputItemDone with function_call item
  → Clear map
```

### Gemini Stream Context

**Purpose**: Track validation state and metadata for debugging

**Location**: Could be added to `OpenAIResponsesClient` as additional instance variables

**Proposed Structure**:
```typescript
/**
 * Context tracking for Chat Completions streaming.
 * Used for validation and debugging.
 */
private interface ChatCompletionStreamContext {
  // Stream identification
  responseId: string;           // chatEvent.id from first chunk

  // Content tracking
  textDeltaCount: number;       // Number of delta.content chunks received
  toolCallDeltaCount: number;   // Number of delta.tool_calls chunks received

  // State flags
  hasReceivedContent: boolean;  // At least one delta.content received
  hasReceivedToolCalls: boolean; // At least one delta.tool_calls received
  hasReceivedFinish: boolean;   // finish_reason received

  // Validation
  finishReason: string | null;  // The finish_reason value
  streamEnded: boolean;         // Stream iteration completed
}
```

**Alternative**: Use existing state for validation
- `chatCompletionTextContent.length > 0` → hasReceivedContent
- `chatCompletionToolCalls.size > 0` → hasReceivedToolCalls
- No need for separate context object (simpler)

**Recommendation**: **Don't add** separate context object. Use existing accumulators for validation. Only add if debugging becomes complex.

## Validation Rules

### Pre-Completion Checks

**When**: Before emitting `OutputItemDone` or `Completed` events

**Rule 1: Content OR Tool Calls Required** (for normal completion)
```typescript
// Location: In finish_reason handling (lines 708-755)

if (finishReason === 'tool_calls') {
  // Validate: Must have accumulated tool calls
  if (this.chatCompletionToolCalls.size === 0) {
    console.warn('[OpenAIResponsesClient] finish_reason is tool_calls but no tool calls accumulated');
    // Fallback: Emit Completed without OutputItemDone
    return completedEvent;
  }
  // Proceed with tool call emission...
}

if (finishReason === 'stop' || finishReason === 'length') {
  // Validate: Should have accumulated text
  if (this.chatCompletionTextContent.length === 0) {
    console.warn('[OpenAIResponsesClient] finish_reason is', finishReason, 'but no text content accumulated');
    // Fallback: Emit Completed without OutputItemDone (valid but rare)
    return completedEvent;
  }
  // Proceed with message emission...
}
```

**Rule 2: State Reset After Emission**
```typescript
// After emitting OutputItemDone (both paths):

// Clear accumulated state for next request
this.chatCompletionTextContent = '';
this.chatCompletionToolCalls.clear();

// Queue Completed for next iteration
this.pendingEvents.push(completedEvent);
```

**Rule 3: No Mixed Content**
```typescript
// If both text and tool calls exist when finish_reason arrives:

if (finishReason === 'tool_calls') {
  // Clear BOTH accumulators (text is discarded)
  this.chatCompletionTextContent = '';
  this.chatCompletionToolCalls.clear();

  // Emit tool calls only
}
```

### Tool Call Validation Rules

**When**: Before emitting `OutputItemDone` with function_call item

**Rule 1: Function Name Required**
```typescript
const toolCall = toolCallsArray[0];

if (!toolCall.function?.name) {
  console.error('[OpenAIResponsesClient] Tool call missing function name:', toolCall);
  // Fallback: Skip OutputItemDone, emit Completed only
  return completedEvent;
}
```

**Rule 2: Valid JSON Arguments**
```typescript
// Validate that arguments is parseable JSON
try {
  JSON.parse(toolCall.function.arguments);
} catch (error) {
  console.error('[OpenAIResponsesClient] Tool call has invalid JSON arguments:', toolCall.function.arguments, error);
  // Fallback: Skip OutputItemDone, emit Completed only
  return completedEvent;
}
```

**Rule 3: Multiple Tool Calls**
```typescript
if (toolCallsArray.length > 1) {
  console.warn(
    '[OpenAIResponsesClient] Multiple tool calls detected, only emitting first one:',
    toolCallsArray
  );
  // Proceed with first tool call (current architecture limitation)
}
```

### Message Item Validation Rules

**When**: Before emitting `OutputItemDone` with message item

**Rule 1: Non-Empty Text Content**
```typescript
if (this.chatCompletionTextContent.length === 0) {
  console.warn('[OpenAIResponsesClient] Attempting to create message item with empty text');
  // Don't emit OutputItemDone
  return completedEvent;
}
```

**Rule 2: Message Structure**
```typescript
// Ensure message item conforms to ResponseItem type
const messageItem: ResponseItem = {
  type: 'message',
  role: 'assistant',
  content: [{
    type: 'output_text',
    text: messageText,
  }],
};

// Validate content array is non-empty
if (messageItem.content.length === 0) {
  console.error('[OpenAIResponsesClient] Message item has empty content array');
  return completedEvent;
}
```

**Rule 3: Role Validation**
```typescript
// For Chat Completions, role is always 'assistant'
// (user/system messages are in the request, not response)

const messageItem: ResponseItem = {
  type: 'message',
  role: 'assistant',  // Fixed value for streaming responses
  content: [{
    type: 'output_text',
    text: messageText,
  }],
};
```

### Stream State Validation

**When**: At stream start and end

**Rule 1: State Reset at Stream Start**
```typescript
// Location: In processSDKStream (after line 505) and makeChatCompletionsRequest (after line 1112)

// Reset accumulated state for new stream
this.chatCompletionTextContent = '';
this.chatCompletionToolCalls.clear();
this.pendingEvents = [];  // Also reset pending queue

// Defensive check
if (this.chatCompletionTextContent.length > 0 || this.chatCompletionToolCalls.size > 0) {
  console.error('[OpenAIResponsesClient] State not clean at stream start!');
}
```

**Rule 2: State Clean at Stream End**
```typescript
// Location: After stream iteration completes (lines 518-521, 552-555)

// After flushing pending events:
while (this.pendingEvents.length > 0) {
  yield this.pendingEvents.shift()!;
}

// Defensive check: State should be clean
if (this.chatCompletionTextContent.length > 0) {
  console.warn('[OpenAIResponsesClient] Text content not cleared at stream end:', this.chatCompletionTextContent);
  this.chatCompletionTextContent = '';
}

if (this.chatCompletionToolCalls.size > 0) {
  console.warn('[OpenAIResponsesClient] Tool calls not cleared at stream end');
  this.chatCompletionToolCalls.clear();
}
```

**Rule 3: Pending Queue Emptied**
```typescript
// After stream ends, pending queue must be empty
if (this.pendingEvents.length > 0) {
  console.error('[OpenAIResponsesClient] Pending events not flushed:', this.pendingEvents);
  // Defensive flush
  while (this.pendingEvents.length > 0) {
    yield this.pendingEvents.shift()!;
  }
}
```

## Data Flow Examples

### Example 1: Simple Text Response

**Input Chunks**:
```json
{ "id": "chatcmpl_123", "choices": [{ "delta": { "content": "Hello" } }] }
{ "id": "chatcmpl_123", "choices": [{ "delta": { "content": " there!" } }] }
{ "id": "chatcmpl_123", "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": {...} }
```

**State Transitions**:
```
START → Streaming (reset state)

Chunk 1:
  chatCompletionTextContent = '' + 'Hello' = 'Hello'
  Emit: OutputTextDelta { delta: 'Hello' }
  State: Streaming

Chunk 2:
  chatCompletionTextContent = 'Hello' + ' there!' = 'Hello there!'
  Emit: OutputTextDelta { delta: ' there!' }
  State: Streaming

Chunk 3:
  finish_reason = 'stop'
  chatCompletionTextContent.length = 12 > 0 ✓
  Create message item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello there!' }] }
  Emit: OutputItemDone { item: messageItem }
  Queue: Completed { responseId: 'chatcmpl_123', usage: {...} }
  Clear: chatCompletionTextContent = '', chatCompletionToolCalls.clear()
  State: ContentAccumulated → TurnComplete

Next iteration:
  pendingEvents.shift() → Completed
  Emit: Completed { responseId: 'chatcmpl_123', usage: {...} }
  State: TurnComplete

Stream ends:
  Flush pending events (empty)
  State: END
```

**Events Emitted** (in order):
1. `OutputTextDelta { delta: 'Hello' }`
2. `OutputTextDelta { delta: ' there!' }`
3. `OutputItemDone { item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello there!' }] } }`
4. `Completed { responseId: 'chatcmpl_123', usage: {...} }`

### Example 2: Tool Call

**Input Chunks**:
```json
{ "id": "chatcmpl_456", "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_abc", "type": "function", "function": { "name": "search", "arguments": "" } }] } }] }
{ "id": "chatcmpl_456", "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"query\":" } }] } }] }
{ "id": "chatcmpl_456", "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": " \"test\"}" } }] } }] }
{ "id": "chatcmpl_456", "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": {...} }
```

**State Transitions**:
```
START → Streaming (reset state)

Chunk 1:
  chatCompletionToolCalls.set(0, { id: 'call_abc', type: 'function', function: { name: 'search', arguments: '' } })
  Emit: null (no event)
  State: Streaming

Chunk 2:
  chatCompletionToolCalls.get(0).function.arguments += '{"query":'
  Emit: null
  State: Streaming

Chunk 3:
  chatCompletionToolCalls.get(0).function.arguments += ' "test"}'
  Final: { id: 'call_abc', type: 'function', function: { name: 'search', arguments: '{"query": "test"}' } }
  Emit: null
  State: Streaming

Chunk 4:
  finish_reason = 'tool_calls'
  chatCompletionToolCalls.size = 1 > 0 ✓
  toolCallsArray = [{ id: 'call_abc', type: 'function', function: { name: 'search', arguments: '{"query": "test"}' } }]
  Create function_call item: { type: 'function_call', id: 'call_abc', name: 'search', arguments: '{"query": "test"}' }
  Emit: OutputItemDone { item: functionCallItem }
  Queue: Completed { responseId: 'chatcmpl_456', usage: {...} }
  Clear: chatCompletionToolCalls.clear(), chatCompletionTextContent = ''
  State: ToolCallsAccumulated → TurnComplete

Next iteration:
  pendingEvents.shift() → Completed
  Emit: Completed { responseId: 'chatcmpl_456', usage: {...} }
  State: TurnComplete

Stream ends:
  Flush pending events (empty)
  State: END
```

**Events Emitted** (in order):
1. `OutputItemDone { item: { type: 'function_call', id: 'call_abc', name: 'search', arguments: '{"query": "test"}' } }`
2. `Completed { responseId: 'chatcmpl_456', usage: {...} }`

## References

### Type Definitions

**ResponseEvent**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/types/ResponseEvent.ts`
- Line 17: `OutputItemDone` - Contains ResponseItem
- Line 19: `OutputTextDelta` - Contains text delta string
- Line 21: `Completed` - Contains responseId and token usage

**ResponseItem**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/protocol/types.ts`
- Lines 182-233: ResponseItem union type
- Lines 184-188: Message item structure
- Lines 189-193: Function call item structure

**ContentItem**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/protocol/types.ts`
- Lines 52-67: ContentItem union type
- Lines 54-57: Output text content type

### Implementation Files

**OpenAIResponsesClient.ts**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`
- Lines 116-123: Existing tool call accumulator
- Lines 639-759: Event conversion method (main fix location)
- Lines 662-667: Text delta handling (needs accumulation)
- Lines 669-705: Tool call accumulation logic (correct pattern)
- Lines 708-755: Completion handling (needs message item creation)

**TurnManager.ts**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/core/TurnManager.ts`
- Lines 200-207: OutputItemDone handling
- Lines 231-237: OutputTextDelta handling
- Lines 221-228: Completed handling

**TaskRunner.ts**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/core/TaskRunner.ts`
- Lines 542-619: Turn result processing (determines task completion)
