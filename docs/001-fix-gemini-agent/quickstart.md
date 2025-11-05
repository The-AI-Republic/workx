# Quickstart: Testing and Validating the Gemini Fix

## Overview

This guide provides practical instructions for testing and validating the Gemini streaming event bug fix. It covers unit tests, integration tests, manual testing procedures, debug logging, and success criteria.

## Table of Contents

1. [Testing Strategy](#testing-strategy)
2. [Unit Test Cases](#unit-test-cases)
3. [Integration Test Cases](#integration-test-cases)
4. [Manual Testing Procedures](#manual-testing-procedures)
5. [Debug Logging Guide](#debug-logging-guide)
6. [Validation Checklist](#validation-checklist)
7. [Troubleshooting](#troubleshooting)

## Testing Strategy

### Test Pyramid

```
                    ┌─────────────────┐
                    │  Manual Tests   │  (Exploratory, real Gemini API)
                    └─────────────────┘
                  ┌────────────────────┐
                  │ Integration Tests  │  (Agent loop, mocked responses)
                  └────────────────────┘
              ┌──────────────────────────┐
              │     Unit Tests           │  (Event conversion, state management)
              └──────────────────────────┘
```

### Coverage Goals

1. **Unit Tests**: Cover all event conversion paths and state transitions
   - Text delta accumulation
   - Tool call accumulation
   - Message item creation
   - State reset logic

2. **Integration Tests**: Verify agent loop behavior
   - TurnManager receives correct events
   - TaskRunner makes correct decisions
   - Conversation history is populated

3. **Manual Tests**: Real-world validation
   - Test with actual Gemini API
   - Verify UI displays correctly
   - Test edge cases and multi-turn conversations

### Test Environment Setup

**Prerequisites**:
- Node.js environment with project dependencies installed
- Gemini API key (for integration/manual tests)
- Test framework (Jest/Vitest assumed)

**Configuration**:
```bash
# Set Gemini API key for integration tests
export GEMINI_API_KEY="your-api-key-here"

# Enable debug logging (optional)
export BROWSERX_DEBUG=1
```

## Unit Test Cases

### Test 1: Text Delta Accumulation

**File**: `src/models/OpenAIResponsesClient.test.ts`

**Purpose**: Verify text deltas are accumulated correctly

**Test Code**:
```typescript
describe('OpenAIResponsesClient - Text Delta Accumulation', () => {
  let client: OpenAIResponsesClient;

  beforeEach(() => {
    // Initialize client with mock provider/config
    client = new OpenAIResponsesClient(mockProvider, mockConfig);
  });

  it('should accumulate multiple text deltas', async () => {
    // Arrange: Create mock chunks
    const chunks = [
      {
        id: 'chatcmpl_test',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }]
      },
      {
        id: 'chatcmpl_test',
        choices: [{ index: 0, delta: { content: ' there!' }, finish_reason: null }]
      }
    ];

    // Act: Process each chunk
    const events = [];
    for (const chunk of chunks) {
      const event = client.convertChatCompletionEventToResponseEvent(chunk);
      if (event) events.push(event);
    }

    // Assert: Two OutputTextDelta events emitted
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'OutputTextDelta', delta: 'Hello' });
    expect(events[1]).toEqual({ type: 'OutputTextDelta', delta: ' there!' });

    // Assert: Internal state accumulated
    // Note: This requires exposing state for testing or using a spy
    expect(client['chatCompletionTextContent']).toBe('Hello there!');
  });

  it('should emit OutputItemDone with accumulated text on finish', async () => {
    // Arrange: Set up accumulated text
    client['chatCompletionTextContent'] = 'Hello there!';

    const finishChunk = {
      id: 'chatcmpl_test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    };

    // Act: Process finish chunk
    const event = client.convertChatCompletionEventToResponseEvent(finishChunk);

    // Assert: OutputItemDone with message item
    expect(event?.type).toBe('OutputItemDone');
    expect(event).toMatchObject({
      type: 'OutputItemDone',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: 'Hello there!'
        }]
      }
    });

    // Assert: State cleared
    expect(client['chatCompletionTextContent']).toBe('');

    // Assert: Completed event queued
    expect(client['pendingEvents']).toHaveLength(1);
    expect(client['pendingEvents'][0]).toMatchObject({
      type: 'Completed',
      responseId: 'chatcmpl_test'
    });
  });
});
```

**Expected Results**:
- Text deltas accumulate in `chatCompletionTextContent`
- `OutputTextDelta` events emitted for each delta
- `OutputItemDone` created on `finish_reason: 'stop'`
- Message item contains complete accumulated text
- State cleared after emission

### Test 2: Tool Call Accumulation

**Purpose**: Verify tool calls are accumulated incrementally

**Test Code**:
```typescript
describe('OpenAIResponsesClient - Tool Call Accumulation', () => {
  let client: OpenAIResponsesClient;

  beforeEach(() => {
    client = new OpenAIResponsesClient(mockProvider, mockConfig);
  });

  it('should accumulate tool call deltas', async () => {
    // Arrange: Create incremental tool call chunks
    const chunks = [
      {
        id: 'chatcmpl_tool',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_abc',
              type: 'function',
              function: { name: 'web_search', arguments: '' }
            }]
          },
          finish_reason: null
        }]
      },
      {
        id: 'chatcmpl_tool',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"query":' }
            }]
          },
          finish_reason: null
        }]
      },
      {
        id: 'chatcmpl_tool',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: ' "test"}' }
            }]
          },
          finish_reason: null
        }]
      }
    ];

    // Act: Process each chunk
    const events = [];
    for (const chunk of chunks) {
      const event = client.convertChatCompletionEventToResponseEvent(chunk);
      if (event) events.push(event);
    }

    // Assert: No events emitted during accumulation
    expect(events).toHaveLength(0);

    // Assert: Tool call accumulated in map
    const accumulated = client['chatCompletionToolCalls'].get(0);
    expect(accumulated).toMatchObject({
      id: 'call_abc',
      type: 'function',
      function: {
        name: 'web_search',
        arguments: '{"query": "test"}'
      }
    });
  });

  it('should emit OutputItemDone with function_call on finish', async () => {
    // Arrange: Set up accumulated tool call
    client['chatCompletionToolCalls'].set(0, {
      id: 'call_abc',
      type: 'function',
      function: {
        name: 'web_search',
        arguments: '{"query": "test"}'
      }
    });

    const finishChunk = {
      id: 'chatcmpl_tool',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
    };

    // Act: Process finish chunk
    const event = client.convertChatCompletionEventToResponseEvent(finishChunk);

    // Assert: OutputItemDone with function_call item
    expect(event?.type).toBe('OutputItemDone');
    expect(event).toMatchObject({
      type: 'OutputItemDone',
      item: {
        type: 'function_call',
        id: 'call_abc',
        name: 'web_search',
        arguments: '{"query": "test"}'
      }
    });

    // Assert: State cleared
    expect(client['chatCompletionToolCalls'].size).toBe(0);

    // Assert: Completed event queued
    expect(client['pendingEvents']).toHaveLength(1);
  });
});
```

**Expected Results**:
- Tool call deltas accumulate in `chatCompletionToolCalls` map
- No events emitted during accumulation
- `OutputItemDone` created on `finish_reason: 'tool_calls'`
- Function call item has complete arguments
- State cleared after emission

### Test 3: State Reset Between Requests

**Purpose**: Verify state doesn't leak between consecutive streams

**Test Code**:
```typescript
describe('OpenAIResponsesClient - State Reset', () => {
  let client: OpenAIResponsesClient;

  beforeEach(() => {
    client = new OpenAIResponsesClient(mockProvider, mockConfig);
  });

  it('should reset state between streams', async () => {
    // Arrange: Simulate first stream with text
    client['chatCompletionTextContent'] = 'First response';

    // Act: Reset at stream start (simulating processSDKStream logic)
    client['chatCompletionTextContent'] = '';
    client['chatCompletionToolCalls'].clear();
    client['pendingEvents'] = [];

    // Process second stream
    const chunk = {
      id: 'chatcmpl_2',
      choices: [{ delta: { content: 'Second response' }, finish_reason: null }]
    };
    client.convertChatCompletionEventToResponseEvent(chunk);

    // Assert: Only second stream content present
    expect(client['chatCompletionTextContent']).toBe('Second response');

    // Complete second stream
    const finishChunk = {
      id: 'chatcmpl_2',
      choices: [{ delta: {}, finish_reason: 'stop' }]
    };
    const event = client.convertChatCompletionEventToResponseEvent(finishChunk);

    // Assert: Message contains only second stream text
    expect(event).toMatchObject({
      type: 'OutputItemDone',
      item: {
        content: [{
          text: 'Second response'  // NOT 'First responseSecond response'
        }]
      }
    });
  });
});
```

**Expected Results**:
- State cleared at stream start
- Second stream doesn't contain first stream's data
- Message items are independent

### Test 4: Edge Cases

**Purpose**: Verify handling of unusual scenarios

**Test Code**:
```typescript
describe('OpenAIResponsesClient - Edge Cases', () => {
  let client: OpenAIResponsesClient;

  beforeEach(() => {
    client = new OpenAIResponsesClient(mockProvider, mockConfig);
  });

  it('should handle empty finish (no content or tool calls)', async () => {
    // Arrange: finish_reason with no accumulated data
    const finishChunk = {
      id: 'chatcmpl_empty',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }
    };

    // Act: Process finish chunk
    const event = client.convertChatCompletionEventToResponseEvent(finishChunk);

    // Assert: Completed emitted directly (no OutputItemDone)
    expect(event?.type).toBe('Completed');
    expect(event).toMatchObject({
      type: 'Completed',
      responseId: 'chatcmpl_empty'
    });
  });

  it('should handle multiple tool calls (emit first only)', async () => {
    // Arrange: Multiple tool calls accumulated
    client['chatCompletionToolCalls'].set(0, {
      id: 'call_1',
      type: 'function',
      function: { name: 'func1', arguments: '{}' }
    });
    client['chatCompletionToolCalls'].set(1, {
      id: 'call_2',
      type: 'function',
      function: { name: 'func2', arguments: '{}' }
    });

    const finishChunk = {
      id: 'chatcmpl_multi',
      choices: [{ delta: {}, finish_reason: 'tool_calls' }]
    };

    // Act: Process finish chunk
    const event = client.convertChatCompletionEventToResponseEvent(finishChunk);

    // Assert: Only first tool call emitted
    expect(event).toMatchObject({
      type: 'OutputItemDone',
      item: {
        type: 'function_call',
        id: 'call_1',
        name: 'func1'
      }
    });

    // Assert: Warning logged (check with spy)
    // expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Multiple tool calls'));
  });

  it('should discard text when tool calls are emitted', async () => {
    // Arrange: Both text and tool calls accumulated
    client['chatCompletionTextContent'] = 'Some text';
    client['chatCompletionToolCalls'].set(0, {
      id: 'call_1',
      type: 'function',
      function: { name: 'func1', arguments: '{}' }
    });

    const finishChunk = {
      id: 'chatcmpl_mixed',
      choices: [{ delta: {}, finish_reason: 'tool_calls' }]
    };

    // Act: Process finish chunk
    const event = client.convertChatCompletionEventToResponseEvent(finishChunk);

    // Assert: Function call emitted (not text)
    expect(event?.item?.type).toBe('function_call');

    // Assert: Text state cleared (discarded)
    expect(client['chatCompletionTextContent']).toBe('');
  });
});
```

**Expected Results**:
- Empty responses emit `Completed` directly
- Multiple tool calls emit first only, log warning
- Text discarded when tool calls present

## Integration Test Cases

### Test 5: Simple Text Response (End-to-End)

**Purpose**: Verify complete flow from chunks to conversation history

**Test Setup**:
```typescript
describe('Gemini Integration - Text Response', () => {
  let mockGeminiStream: AsyncIterable<ChatCompletionChunk>;
  let turnManager: TurnManager;
  let taskRunner: TaskRunner;

  beforeEach(() => {
    // Mock Gemini API to return predictable stream
    mockGeminiStream = (async function* () {
      yield { id: 'chat_1', choices: [{ delta: { content: 'Hello' }, finish_reason: null }] };
      yield { id: 'chat_1', choices: [{ delta: { content: ' there!' }, finish_reason: null }] };
      yield {
        id: 'chat_1',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      };
    })();

    // Initialize TurnManager and TaskRunner with mocked client
    // ...
  });

  it('should complete simple text response correctly', async () => {
    // Arrange: User message
    const userMessage = { role: 'user', content: 'hi' };

    // Act: Run task
    const result = await taskRunner.run(userMessage);

    // Assert: Task completed
    expect(result.status).toBe('completed');
    expect(result.turns).toBe(1);

    // Assert: Conversation history has assistant message
    const history = conversationManager.getHistory();
    expect(history).toHaveLength(2); // user + assistant
    expect(history[1]).toMatchObject({
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: 'Hello there!'
      }]
    });

    // Assert: UI displayed text (check event emissions)
    // expect(uiEventsSpy).toHaveBeenCalledWith('AgentMessageDelta', { delta: 'Hello' });
    // expect(uiEventsSpy).toHaveBeenCalledWith('AgentMessageDelta', { delta: ' there!' });
  });
});
```

**Expected Results**:
- Task completes after single turn
- Conversation history contains assistant message with complete text
- UI displayed text deltas during streaming
- TaskRunner marks task as complete

### Test 6: Tool Call Execution

**Purpose**: Verify tool call flow works correctly

**Test Setup**:
```typescript
describe('Gemini Integration - Tool Call', () => {
  it('should execute tool call and continue', async () => {
    // Arrange: Mock Gemini to return tool call
    mockGeminiStream = (async function* () {
      yield {
        id: 'chat_2',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_search',
              type: 'function',
              function: { name: 'web_search', arguments: '' }
            }]
          },
          finish_reason: null
        }]
      };
      yield {
        id: 'chat_2',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"query": "test"}' }
            }]
          },
          finish_reason: null
        }]
      };
      yield {
        id: 'chat_2',
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
      };
    })();

    // Mock tool execution
    const mockToolResult = { result: 'Search results...' };

    // Act: Run task
    const result = await taskRunner.run({ role: 'user', content: 'search for test' });

    // Assert: Tool was called
    expect(toolExecutor.execute).toHaveBeenCalledWith('web_search', { query: 'test' });

    // Assert: Tool result in history
    const history = conversationManager.getHistory();
    const functionResponseItem = history.find(item => item.type === 'function_response');
    expect(functionResponseItem).toBeDefined();
    expect(functionResponseItem?.call_id).toBe('call_search');

    // Assert: Task continues (NOT complete after first turn)
    expect(result.turns).toBeGreaterThan(1);
  });
});
```

**Expected Results**:
- Tool call extracted correctly
- Tool executor called with correct arguments
- Function response added to history
- Task continues to next turn

### Test 7: Multi-Turn Conversation

**Purpose**: Verify multiple turns work without state leakage

**Test Setup**:
```typescript
describe('Gemini Integration - Multi-Turn', () => {
  it('should handle multiple turns correctly', async () => {
    // Arrange: Simulate 3-turn conversation
    // Turn 1: User asks question, Gemini responds
    // Turn 2: User asks followup, Gemini responds

    // Act: Run multiple tasks
    await taskRunner.run({ role: 'user', content: 'What is AI?' });
    await taskRunner.run({ role: 'user', content: 'Tell me more' });

    // Assert: Conversation history has all messages
    const history = conversationManager.getHistory();
    expect(history).toHaveLength(4); // 2 user + 2 assistant

    // Assert: Responses are distinct (no leakage)
    expect(history[1].content[0].text).not.toContain(history[3].content[0].text);

    // Assert: Each response is complete
    expect(history[1].content[0].text.length).toBeGreaterThan(0);
    expect(history[3].content[0].text.length).toBeGreaterThan(0);
  });
});
```

**Expected Results**:
- Each turn creates separate message items
- No text leakage between turns
- Conversation history grows correctly

## Manual Testing Procedures

### Procedure 1: Simple Greeting Test

**Objective**: Verify basic text responses work

**Steps**:
1. Launch BrowserX extension
2. Configure Gemini API provider (Google AI Studio)
3. Open agent sidepanel
4. Send message: "hi"
5. Observe response

**Expected Behavior**:
- Gemini responds with greeting (e.g., "Hello! How can I help you?")
- Text appears in UI as it streams
- Message appears in conversation history
- Task shows "completed in 1 turn(s)"
- NO "Task completed in 1 turn(s)" without visible response

**Success Criteria**:
- ✓ Response text visible in UI
- ✓ Response stored in conversation history
- ✓ Task completes gracefully
- ✓ No errors in console

**Debugging**:
If test fails, check:
- Browser console for errors
- Debug logs (see Debug Logging Guide)
- Network tab for API responses

### Procedure 2: Tool Call Test

**Objective**: Verify function calls execute correctly

**Steps**:
1. Configure Gemini with tool definitions (e.g., web_search)
2. Send message: "search for latest news about AI"
3. Observe agent behavior

**Expected Behavior**:
- Gemini decides to call web_search tool
- Function call appears in UI (e.g., "Calling web_search...")
- Tool executes with correct parameters
- Gemini receives tool result
- Gemini responds with summary based on results
- Task completes after multiple turns

**Success Criteria**:
- ✓ Function call detected and executed
- ✓ Arguments are valid JSON
- ✓ Tool result stored in history
- ✓ Gemini uses tool result in followup response
- ✓ Multi-turn flow completes successfully

**Debugging**:
If function call fails:
- Check `OutputItemDone` event has `type: 'function_call'`
- Verify `arguments` field is valid JSON
- Check TaskRunner processes function call correctly

### Procedure 3: Multi-Turn Conversation Test

**Objective**: Verify state doesn't leak between turns

**Steps**:
1. Send first message: "What is TypeScript?"
2. Wait for Gemini response
3. Send followup: "What about JavaScript?"
4. Wait for Gemini response
5. Review conversation history

**Expected Behavior**:
- First response explains TypeScript
- Second response explains JavaScript
- Responses are distinct (no text from first in second)
- Conversation history shows all 4 messages (2 user, 2 assistant)

**Success Criteria**:
- ✓ Each response is complete and distinct
- ✓ No text duplication or leakage
- ✓ Conversation history is coherent
- ✓ Each turn completes independently

**Debugging**:
If responses are mixed:
- Check state reset at stream start
- Verify `chatCompletionTextContent` cleared after emission
- Check response IDs are different

### Procedure 4: Edge Case Test

**Objective**: Test unusual scenarios

**Test Cases**:
1. **Empty Response**:
   - Send: "Say nothing"
   - Expected: Gemini may refuse or return empty response
   - Verify: No crash, graceful handling

2. **Very Long Response**:
   - Send: "Write a long essay about AI"
   - Expected: Text streams in many deltas
   - Verify: All text accumulated correctly

3. **Rapid Messages**:
   - Send multiple messages quickly
   - Expected: Each handled independently
   - Verify: No state corruption

**Success Criteria**:
- ✓ No crashes or errors
- ✓ Graceful handling of edge cases
- ✓ State remains consistent

## Debug Logging Guide

### Enabling Debug Logs

**Method 1: Environment Variable**
```bash
export BROWSERX_DEBUG=1
```

**Method 2: Browser Console**
```javascript
localStorage.setItem('BROWSERX_DEBUG', '1');
// Reload extension
```

**Method 3: Code Modification** (temporary)
```typescript
// In OpenAIResponsesClient.ts, add at top of file:
const DEBUG = true;

// Replace console.log with:
if (DEBUG) console.log('[Gemini Debug]', ...);
```

### Key Log Points

**1. API Routing Decision** (line ~1036)
```typescript
if (this.provider.name === 'Google AI Studio' || this.currentModel.startsWith('gemini-')) {
  console.log('[Gemini Debug] Routing to Chat Completions API (provider:', this.provider.name, ', model:', this.currentModel, ')');
  return this.makeChatCompletionsRequest(payload);
}
```

**What to Look For**:
- Should print for Gemini requests
- Verify `provider.name` or `model` matches Gemini

**2. Text Delta Accumulation** (lines ~664)
```typescript
if (delta?.content) {
  this.chatCompletionTextContent += delta.content;
  console.log('[Gemini Debug] Accumulated text:', this.chatCompletionTextContent.length, 'chars, delta:', delta.content.length, 'chars');

  return {
    type: 'OutputTextDelta',
    delta: delta.content,
  };
}
```

**What to Look For**:
- Multiple log entries as text streams
- `Accumulated text` length grows with each delta
- Example: "Accumulated text: 5 chars, delta: 5 chars" → "Accumulated text: 12 chars, delta: 7 chars"

**3. Message Item Creation** (lines ~436 new)
```typescript
if (this.chatCompletionTextContent.length > 0) {
  const messageText = this.chatCompletionTextContent;
  console.log('[Gemini Debug] Creating message item with', messageText.length, 'chars:', messageText.substring(0, 50) + '...');

  // ... create OutputItemDone
}
```

**What to Look For**:
- Logged on `finish_reason: 'stop'`
- Shows final message text (first 50 chars)
- Example: "Creating message item with 35 chars: Hello there! How can I help you today?"

**4. Tool Call Accumulation** (lines ~685)
```typescript
// In tool call accumulation loop:
console.log('[Gemini Debug] Accumulating tool call index', index, ', current args length:', existing?.function.arguments.length || 0);
```

**What to Look For**:
- Multiple entries as arguments stream
- Arguments length grows with each delta

**5. Event Emission** (lines ~646, 736, 754)
```typescript
// Before returning event:
console.log('[Gemini Debug] Emitting event:', event.type, event);
```

**What to Look For**:
- Sequence: `OutputTextDelta` → `OutputItemDone` → `Completed`
- `OutputItemDone` has complete `item` field

### Expected Log Output

**For Simple Text Response** ("hi" → "Hello there!"):
```
[Gemini Debug] Routing to Chat Completions API (provider: Google AI Studio, model: gemini-1.5-pro)
[Gemini Debug] Accumulated text: 5 chars, delta: 5 chars
[Gemini Debug] Emitting event: OutputTextDelta { type: 'OutputTextDelta', delta: 'Hello' }
[Gemini Debug] Accumulated text: 12 chars, delta: 7 chars
[Gemini Debug] Emitting event: OutputTextDelta { type: 'OutputTextDelta', delta: ' there!' }
[Gemini Debug] Creating message item with 12 chars: Hello there!
[Gemini Debug] Emitting event: OutputItemDone { type: 'OutputItemDone', item: { type: 'message', ... } }
[Gemini Debug] Emitting event: Completed { type: 'Completed', responseId: 'chatcmpl_...', ... }
```

**For Tool Call**:
```
[Gemini Debug] Routing to Chat Completions API (provider: Google AI Studio, model: gemini-1.5-pro)
[Gemini Debug] Accumulating tool call index 0, current args length: 0
[Gemini Debug] Accumulating tool call index 0, current args length: 9
[Gemini Debug] Accumulating tool call index 0, current args length: 18
[Gemini Debug] Creating function_call item: web_search, args: {"query": "test"}
[Gemini Debug] Emitting event: OutputItemDone { type: 'OutputItemDone', item: { type: 'function_call', ... } }
[Gemini Debug] Emitting event: Completed { type: 'Completed', ... }
```

### Interpreting Logs

**Symptom**: No text in conversation history
**Check Logs For**:
- "Creating message item" log → If missing, text not accumulated
- "Emitting event: OutputItemDone" → If missing, message item not created
- "Accumulated text" → If stays at 0, deltas not arriving

**Symptom**: Tool call fails
**Check Logs For**:
- "Accumulating tool call" → Verify arguments growing
- "Creating function_call item" → Check final arguments are valid JSON
- "Emitting event: OutputItemDone" with `item.type: 'function_call'`

**Symptom**: State leakage between turns
**Check Logs For**:
- "Accumulated text" at start of new stream → Should start at 0
- "Creating message item" → Text should match current response only

## Validation Checklist

### Pre-Deployment Checklist

Before merging the fix, verify:

- [ ] **Unit Tests Pass**
  - [ ] Text delta accumulation test
  - [ ] Tool call accumulation test
  - [ ] Message item creation test
  - [ ] State reset test
  - [ ] Edge case tests

- [ ] **Integration Tests Pass**
  - [ ] Simple text response (end-to-end)
  - [ ] Tool call execution
  - [ ] Multi-turn conversation

- [ ] **Manual Tests Pass**
  - [ ] Simple greeting test ("hi")
  - [ ] Tool call test (web search)
  - [ ] Multi-turn conversation test
  - [ ] Edge cases (empty response, long response)

- [ ] **Code Quality**
  - [ ] No compiler errors or warnings
  - [ ] Debug logs can be disabled
  - [ ] Code follows project style guide
  - [ ] Comments explain key decisions

- [ ] **Documentation**
  - [ ] Code comments added to new/modified sections
  - [ ] Research.md updated with solution verification
  - [ ] This quickstart guide validated against implementation

### Success Criteria

The fix is considered successful when:

1. **Core Functionality Restored**:
   - ✓ Simple text responses appear in conversation history
   - ✓ Tool calls execute with correct arguments
   - ✓ Multi-turn conversations work without state leakage

2. **Event Flow Correct**:
   - ✓ TurnManager receives `OutputItemDone` for all responses
   - ✓ TaskRunner sees response items in `processedItems`
   - ✓ Conversation history populated correctly

3. **State Management Correct**:
   - ✓ State resets between streams
   - ✓ Accumulators cleared after emission
   - ✓ No memory leaks or unbounded growth

4. **User Experience Good**:
   - ✓ Text streams smoothly in UI
   - ✓ Task completion messages accurate
   - ✓ No confusing behavior or errors

5. **No Regressions**:
   - ✓ OpenAI (Responses API) still works
   - ✓ xAI (if using Chat Completions) still works
   - ✓ Other providers unaffected

### Post-Deployment Monitoring

After deployment, monitor for:

1. **Error Logs**:
   - Check for warnings about empty text/tool calls
   - Look for state not cleared errors
   - Monitor for JSON parsing errors in tool arguments

2. **User Reports**:
   - Missing responses (indicates bug not fully fixed)
   - Duplicate text (indicates state leakage)
   - Broken tool calls (indicates function_call item issues)

3. **Metrics** (if available):
   - Task completion rate
   - Average turns per task
   - Tool call success rate

## Troubleshooting

### Issue: Text Responses Still Missing

**Symptoms**:
- Task completes without showing response
- Conversation history empty after turn

**Diagnosis**:
1. Check debug logs for "Creating message item" → If missing, accumulation failed
2. Check `chatCompletionTextContent` has data when `finish_reason` arrives
3. Verify `OutputItemDone` emitted with message item

**Fixes**:
- Ensure text accumulation happens in delta handler (lines ~664)
- Verify condition `this.chatCompletionTextContent.length > 0` is true
- Check state isn't prematurely cleared

### Issue: Tool Calls Not Executing

**Symptoms**:
- Function calls appear in logs but don't execute
- TurnManager doesn't process function_call item

**Diagnosis**:
1. Check `OutputItemDone` event has `item.type: 'function_call'`
2. Verify `arguments` field is valid JSON
3. Check TurnManager receives event (add log in TurnManager.ts line ~200)

**Fixes**:
- Ensure `finish_reason === 'tool_calls'` path creates function_call item
- Validate tool call accumulation produces complete arguments
- Check item structure matches ResponseItem type

### Issue: State Leaks Between Turns

**Symptoms**:
- Second response includes text from first response
- Tool calls from previous turn reappear

**Diagnosis**:
1. Check state reset at stream start (should be empty)
2. Verify `chatCompletionTextContent = ''` and `chatCompletionToolCalls.clear()` called
3. Check multiple streams don't share state

**Fixes**:
- Add state reset in `processSDKStream` after line 505
- Add state reset in `makeChatCompletionsRequest` after line 1112
- Ensure reset happens BEFORE first chunk processed

### Issue: Pending Events Not Flushed

**Symptoms**:
- `Completed` event never reaches TurnManager
- Stream ends but task doesn't complete

**Diagnosis**:
1. Check `pendingEvents` array has `Completed` event
2. Verify flush logic runs at stream end (lines 518-521, 552-555)
3. Check for errors during stream iteration

**Fixes**:
- Ensure `Completed` queued after `OutputItemDone` (line 432, 733)
- Verify flush loop executes after stream iteration
- Add defensive flush in case of early stream termination

### Issue: Multiple Tool Calls

**Symptoms**:
- Warning about multiple tool calls
- Only first tool call executes

**Diagnosis**:
1. Check if provider really sends multiple tool calls
2. Verify warning logged (line ~725)
3. Confirm only first tool call emitted

**Expected Behavior**:
- Current architecture supports single tool call per turn
- First tool call should execute correctly
- Warning is informational (not an error)

**Future Enhancement**:
- Modify architecture to support multiple tool calls
- Queue additional OutputItemDone events
- Update TurnManager to handle multiple function calls

## References

### Implementation Files

- **OpenAIResponsesClient.ts**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/models/OpenAIResponsesClient.ts`
  - Lines 639-759: Event conversion method
  - Lines 662-667: Text delta handling (modified)
  - Lines 708-755: Completion handling (modified)

- **TurnManager.ts**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/core/TurnManager.ts`
  - Lines 200-207: OutputItemDone handling
  - Lines 231-237: OutputTextDelta handling

- **TaskRunner.ts**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/src/core/TaskRunner.ts`
  - Lines 542-619: Turn result processing

### Design Documents

- **Research**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/specs/001-fix-gemini-agent/research.md`
  - Root cause analysis
  - Provider comparison
  - Solution strategy

- **Data Model**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/specs/001-fix-gemini-agent/data-model.md`
  - Event state machine
  - Data structures
  - Validation rules

- **Contracts**: `/home/irichard/dev/git_repos/open_source/browserx/s4/browserx/specs/001-fix-gemini-agent/contracts/streaming-events.yaml`
  - Event conversion contracts
  - Input/output schemas
  - Conversion rules

### External References

- **OpenAI Chat Completions API**: https://platform.openai.com/docs/api-reference/chat/streaming
- **OpenAI Responses API**: https://platform.openai.com/docs/api-reference/responses/streaming
- **Gemini API Documentation**: https://ai.google.dev/docs/gemini_api_overview
