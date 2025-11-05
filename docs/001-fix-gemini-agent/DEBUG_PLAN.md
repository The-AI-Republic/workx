# Debug Plan: Gemini Agent Integration Issue

**Problem**: Despite all tests passing (21/21), the Gemini agent still shows "Task completed in 1 turn(s)" without message response in production.

**Created**: 2025-11-05
**Status**: Active Investigation

---

## Phase 1: Verify Code Path Execution (Priority: CRITICAL)

### Objective
Confirm that our fix is actually being executed at runtime with Gemini provider.

### Step 1.1: Enable Debug Logging
```javascript
// In browser console (extension context):
localStorage.setItem('GEMINI_DEBUG', 'true');

// Reload extension
chrome.runtime.reload();

// Then send "hi" message and check console
```

**Expected Output**:
```
[Gemini] Stream starting - Model: gemini-2.5-pro, Conversation: xxx
[Gemini] Stream chunk received: {...}
[Gemini] Text accumulated: +2 chars, total: 2 chars
[Gemini] Text delta emitted: "Hi" (accumulated 2 chars)
[Gemini] Finish reason: "stop", hasContent=true, hasToolCalls=false
[Gemini] Emitting OutputItemDone: message (X chars)
[Gemini] Emitting Completed
```

**If NO logs appear**: The GeminiLogger is not active
- Check: `GeminiLogger.isEnabled()` returns true
- Check: Logger import is correct in OpenAIResponsesClient.ts

**If logs appear but missing text accumulation**: Wrong code path
- The fix code is not being executed for Gemini

### Step 1.2: Check Provider Configuration
```javascript
// In browser console:
chrome.storage.local.get(['selectedProvider', 'providers'], (result) => {
  console.log('Selected Provider:', result.selectedProvider);
  console.log('Provider Config:', result.providers);
});
```

**Expected**:
```javascript
{
  selectedProvider: "Google AI Studio",
  providers: {
    "Google AI Studio": {
      name: "Google AI Studio",
      base_url: "https://generativelanguage.googleapis.com/v1beta/openai/",
      wire_api: "ChatCompletions",
      requires_openai_auth: true,
      env_key: "GOOGLE_AI_STUDIO_API_KEY"
    }
  }
}
```

**Critical Check**: `wire_api` MUST be `"ChatCompletions"` not `"Responses"`

### Step 1.3: Verify API Endpoint Being Called
Add temporary logging to see which API method is invoked:

```typescript
// In src/models/OpenAIResponsesClient.ts, line ~1070
async streamCompletion(requestData: Prompt): Promise<AsyncGenerator<ResponseEvent>> {
  console.log('[DEBUG] streamCompletion called');
  console.log('[DEBUG] Provider config:', this.provider);
  console.log('[DEBUG] Model family:', this.modelFamily);

  // Check which path is taken
  if (this.provider.wire_api === 'ChatCompletions') {
    console.log('[DEBUG] ✅ Using Chat Completions API (Gemini path)');
    return this.makeChatCompletionsRequest(requestData);
  } else {
    console.log('[DEBUG] ❌ Using Responses API (OpenAI path)');
    return this.makeResponsesRequest(requestData);
  }
}
```

**Expected**: Should see "✅ Using Chat Completions API (Gemini path)"

---

## Phase 2: Inspect Event Conversion (Priority: HIGH)

### Objective
Verify that Chat Completions events are being converted correctly.

### Step 2.1: Add Delta Inspection Logging
```typescript
// In convertChatCompletionEventToResponseEvent, line ~664
private convertChatCompletionEventToResponseEvent(chatEvent: any): ResponseEvent | null {
  console.log('[DEBUG-DELTA] Raw chat event:', JSON.stringify(chatEvent, null, 2));

  const delta = chatEvent.choices?.[0]?.delta;
  const finishReason = chatEvent.choices?.[0]?.finish_reason;

  console.log('[DEBUG-DELTA] Extracted delta:', delta);
  console.log('[DEBUG-DELTA] Finish reason:', finishReason);
  console.log('[DEBUG-DELTA] Current accumulated text:', this.chatCompletionTextContent);

  // ... rest of method
}
```

### Step 2.2: Check Text Accumulation State
```typescript
// After line 669 (text accumulation)
if (delta?.content) {
  this.chatCompletionTextContent += delta.content;

  console.log('[DEBUG-TEXT] Accumulated:', this.chatCompletionTextContent);
  console.log('[DEBUG-TEXT] Length:', this.chatCompletionTextContent.length);

  // ... rest of handler
}
```

### Step 2.3: Verify Message Item Creation
```typescript
// In finish_reason='stop' handler, line ~785
if (finishReason === 'stop' || finishReason === 'length') {
  console.log('[DEBUG-FINISH] Stop detected');
  console.log('[DEBUG-FINISH] hasContent:', hasContent);
  console.log('[DEBUG-FINISH] Text to emit:', this.chatCompletionTextContent);

  if (hasContent) {
    const messageItem = {
      type: 'message' as const,
      role: 'assistant' as const,
      content: [
        {
          type: 'output_text' as const,
          text: this.chatCompletionTextContent,
        },
      ],
    };

    console.log('[DEBUG-FINISH] ✅ Creating message item:', messageItem);
    console.log('[DEBUG-FINISH] Queueing Completed event');

    this.pendingEvents.push(completedEvent);

    console.log('[DEBUG-FINISH] Returning OutputItemDone');
    return {
      type: 'OutputItemDone',
      item: messageItem,
    };
  }
}
```

---

## Phase 3: Trace Event Flow to TurnManager (Priority: HIGH)

### Objective
Ensure OutputItemDone events reach TurnManager with message items.

### Step 3.1: Check Event Generator Flow
```typescript
// In makeChatCompletionsRequest, line ~1148 (stream loop)
for await (const chunk of stream) {
  console.log('[DEBUG-STREAM] Chunk received:', chunk);

  const responseEvent = this.convertChatCompletionEventToResponseEvent(chunk);
  console.log('[DEBUG-STREAM] Converted to ResponseEvent:', responseEvent);

  if (responseEvent) {
    console.log('[DEBUG-STREAM] ✅ Yielding event:', responseEvent.type);
    yield responseEvent;
  } else {
    console.log('[DEBUG-STREAM] ⚠️ No event to yield (null returned)');
  }
}
```

### Step 3.2: Verify Pending Events are Emitted
```typescript
// After stream loop, line ~1165
if (this.pendingEvents.length > 0) {
  console.log('[DEBUG-PENDING] Emitting', this.pendingEvents.length, 'pending events');
  for (const event of this.pendingEvents) {
    console.log('[DEBUG-PENDING] Yielding:', event.type, event);
    yield event;
  }
  this.pendingEvents = [];
}
```

### Step 3.3: Add TurnManager Inspection
```typescript
// In src/services/TurnManager.ts or wherever turn processing happens
// Add logging when receiving events:

console.log('[DEBUG-TURN] Received event:', event.type);
if (event.type === 'OutputItemDone') {
  console.log('[DEBUG-TURN] OutputItemDone item:', event.item);
  console.log('[DEBUG-TURN] Item type:', event.item?.type);
  if (event.item?.type === 'message') {
    console.log('[DEBUG-TURN] ✅ Message content:', event.item.content);
  }
}
```

---

## Phase 4: Check State Reset Issues (Priority: MEDIUM)

### Objective
Verify state is not being reset prematurely or preserved incorrectly.

### Step 4.1: Track State Lifecycle
```typescript
// In makeChatCompletionsRequest, before state reset (line ~1119)
console.log('[DEBUG-STATE] BEFORE reset:');
console.log('[DEBUG-STATE] - textContent:', this.chatCompletionTextContent);
console.log('[DEBUG-STATE] - toolCalls:', this.chatCompletionToolCalls.size);

// Reset streaming state before starting new request
this.chatCompletionTextContent = '';
this.chatCompletionToolCalls.clear();

console.log('[DEBUG-STATE] AFTER reset:');
console.log('[DEBUG-STATE] - textContent:', this.chatCompletionTextContent);
console.log('[DEBUG-STATE] - toolCalls:', this.chatCompletionToolCalls.size);
```

### Step 4.2: Verify State at Finish
```typescript
// In finish_reason handler, line ~776
const hasContent = this.chatCompletionTextContent.length > 0;
const hasToolCalls = this.chatCompletionToolCalls.size > 0;

console.log('[DEBUG-STATE] At finish:');
console.log('[DEBUG-STATE] - textContent:', this.chatCompletionTextContent);
console.log('[DEBUG-STATE] - textContent.length:', this.chatCompletionTextContent.length);
console.log('[DEBUG-STATE] - hasContent:', hasContent);
console.log('[DEBUG-STATE] - hasToolCalls:', hasToolCalls);
```

---

## Phase 5: API Response Validation (Priority: HIGH)

### Objective
Ensure Gemini API is actually returning data in expected format.

### Step 5.1: Capture Raw Gemini Responses
```typescript
// In makeChatCompletionsRequest, before conversion (line ~1145)
const stream = await this.client.chat.completions.create(payload);

let chunkCount = 0;
for await (const chunk of stream) {
  chunkCount++;
  console.log(`[DEBUG-API] Chunk ${chunkCount}:`, JSON.stringify(chunk, null, 2));

  // Check if chunk has expected structure
  if (chunk.choices && chunk.choices[0]) {
    const choice = chunk.choices[0];
    console.log(`[DEBUG-API] Choice ${chunkCount}:`, {
      delta: choice.delta,
      finish_reason: choice.finish_reason,
      index: choice.index
    });

    if (choice.delta?.content) {
      console.log(`[DEBUG-API] ✅ Text content in chunk ${chunkCount}:`, choice.delta.content);
    }
  } else {
    console.warn(`[DEBUG-API] ⚠️ Chunk ${chunkCount} missing choices array`);
  }

  // ... continue with conversion
}

console.log(`[DEBUG-API] Total chunks received: ${chunkCount}`);
```

### Step 5.2: Verify Gemini API Format Matches Expectations
Create a test request directly to Gemini API:

```javascript
// Run in browser console with API key
const apiKey = 'YOUR_GOOGLE_AI_STUDIO_API_KEY';
const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  console.log('Raw chunk:', chunk);

  // Parse SSE format
  const lines = chunk.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ') && !line.includes('[DONE]')) {
      const data = JSON.parse(line.slice(6));
      console.log('Parsed data:', data);
    }
  }
}
```

---

## Phase 6: Check for Silent Errors (Priority: HIGH)

### Objective
Identify any errors being caught and swallowed.

### Step 6.1: Add Error Boundary Logging
```typescript
// Wrap critical sections with try-catch
try {
  const responseEvent = this.convertChatCompletionEventToResponseEvent(chunk);
  // ...
} catch (error) {
  console.error('[DEBUG-ERROR] Conversion failed:', error);
  console.error('[DEBUG-ERROR] Stack:', error.stack);
  console.error('[DEBUG-ERROR] Chunk that caused error:', chunk);
  throw error; // Re-throw to see full impact
}
```

### Step 6.2: Check for Async/Generator Issues
```typescript
// Verify generator is properly yielding
async *makeChatCompletionsRequest(requestData: Prompt): AsyncGenerator<ResponseEvent> {
  console.log('[DEBUG-GEN] Generator started');

  try {
    // ... existing code

    console.log('[DEBUG-GEN] About to iterate stream');
    for await (const chunk of stream) {
      console.log('[DEBUG-GEN] Processing chunk in generator');
      // ... conversion code
      if (responseEvent) {
        console.log('[DEBUG-GEN] About to yield:', responseEvent.type);
        yield responseEvent;
        console.log('[DEBUG-GEN] Yielded successfully');
      }
    }

    console.log('[DEBUG-GEN] Stream iteration complete');

  } catch (error) {
    console.error('[DEBUG-GEN] Generator error:', error);
    throw error;
  } finally {
    console.log('[DEBUG-GEN] Generator finished');
  }
}
```

---

## Phase 7: Compare Working vs Broken Behavior (Priority: MEDIUM)

### Objective
Contrast OpenAI (working) vs Gemini (broken) event flows.

### Step 7.1: Trace OpenAI Flow
1. Switch to OpenAI provider
2. Send "hi" message
3. Capture all events in console
4. Document event sequence

### Step 7.2: Trace Gemini Flow
1. Switch to Gemini provider
2. Send "hi" message
3. Capture all events in console
4. Document event sequence

### Step 7.3: Compare Sequences
Create side-by-side comparison:

```
OpenAI Events:          Gemini Events:
-----------------       -----------------
1. OutputTextDelta      1. OutputTextDelta (?)
2. OutputTextDelta      2. OutputTextDelta (?)
3. OutputItemDone       3. ??? (missing?)
4. Completed            4. Completed (too early?)
```

Identify the delta: Where does Gemini diverge?

---

## Phase 8: Integration Test with Real API (Priority: HIGH)

### Objective
Run actual API call through the code path.

### Step 8.1: Create Minimal Reproduction Script
```typescript
// test-gemini-live.ts
import { OpenAIResponsesClient } from './src/models/OpenAIResponsesClient';

const client = new OpenAIResponsesClient({
  apiKey: process.env.GOOGLE_AI_STUDIO_API_KEY!,
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  conversationId: 'test-debug',
  modelFamily: {
    family: 'gemini-2.5-pro',
    base_instructions: 'You are a helpful assistant.',
    supports_reasoning_summaries: false,
    needs_special_apply_patch_instructions: false,
  },
  provider: {
    name: 'Google AI Studio',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    wire_api: 'ChatCompletions',
    requires_openai_auth: true,
    env_key: 'GOOGLE_AI_STUDIO_API_KEY',
  },
});

async function testGemini() {
  console.log('=== Starting Gemini Debug Test ===');

  const requestData = {
    role: 'user',
    content: 'hi'
  };

  const events = [];

  try {
    const stream = client.streamCompletion(requestData);

    for await (const event of stream) {
      console.log('Event received:', event.type);
      events.push(event);

      if (event.type === 'OutputItemDone') {
        console.log('OutputItemDone item:', JSON.stringify(event.item, null, 2));
      }
    }

    console.log('=== Stream Complete ===');
    console.log('Total events:', events.length);
    console.log('Event types:', events.map(e => e.type));

    const messageItems = events.filter(e =>
      e.type === 'OutputItemDone' && e.item?.type === 'message'
    );
    console.log('Message items found:', messageItems.length);

    if (messageItems.length > 0) {
      console.log('✅ SUCCESS: Message content:', messageItems[0].item.content);
    } else {
      console.log('❌ FAILURE: No message items found');
    }

  } catch (error) {
    console.error('Test failed:', error);
  }
}

testGemini();
```

Run:
```bash
export GOOGLE_AI_STUDIO_API_KEY=your_key
export GEMINI_DEBUG=true
npx tsx test-gemini-live.ts
```

---

## Phase 9: Check Provider Detection Logic (Priority: MEDIUM)

### Objective
Ensure the code correctly identifies when Gemini is active.

### Step 9.1: Verify Provider Matching
```typescript
// Check how provider is determined
console.log('[DEBUG-PROVIDER] Constructor called');
console.log('[DEBUG-PROVIDER] this.provider:', this.provider);
console.log('[DEBUG-PROVIDER] this.provider.wire_api:', this.provider?.wire_api);
console.log('[DEBUG-PROVIDER] this.modelFamily:', this.modelFamily);

// In streamCompletion decision point
const isGemini = this.provider.wire_api === 'ChatCompletions';
console.log('[DEBUG-PROVIDER] isGemini:', isGemini);
```

### Step 9.2: Check for Typos or Case Sensitivity
```typescript
// Defensive check
const wireApi = this.provider.wire_api || '';
console.log('[DEBUG-PROVIDER] Wire API (raw):', JSON.stringify(wireApi));
console.log('[DEBUG-PROVIDER] Wire API (trimmed):', wireApi.trim());
console.log('[DEBUG-PROVIDER] Matches "ChatCompletions":', wireApi === 'ChatCompletions');
console.log('[DEBUG-PROVIDER] Matches (case-insensitive):', wireApi.toLowerCase() === 'chatcompletions');
```

---

## Phase 10: Check Build/Deployment Issues (Priority: LOW)

### Objective
Rule out stale builds or deployment problems.

### Step 10.1: Verify Built Code Includes Fix
```bash
# Check if the fix is in the built code
grep -n "chatCompletionTextContent" dist/models/OpenAIResponsesClient.js

# Should find multiple occurrences
```

### Step 10.2: Force Clean Build
```bash
# Clean and rebuild
rm -rf dist/ build/ node_modules/.cache/
npm run build

# Reload extension
# Test again
```

### Step 10.3: Check Source Maps
```bash
# Ensure source maps are working for debugging
ls -la dist/**/*.map
```

---

## Diagnostic Checklist

Run through this checklist systematically:

- [ ] **P1.1** - GeminiLogger shows logs when GEMINI_DEBUG=true
- [ ] **P1.2** - Provider configured with wire_api: "ChatCompletions"
- [ ] **P1.3** - streamCompletion() calls makeChatCompletionsRequest()
- [ ] **P2.1** - convertChatCompletionEventToResponseEvent() receives chunks with delta.content
- [ ] **P2.2** - chatCompletionTextContent accumulates text (length > 0)
- [ ] **P2.3** - Message item created when finish_reason='stop'
- [ ] **P3.1** - OutputItemDone event yielded from generator
- [ ] **P3.2** - Pending events (Completed) are emitted after OutputItemDone
- [ ] **P3.3** - TurnManager receives OutputItemDone with message item
- [ ] **P4.1** - State reset at stream start (chatCompletionTextContent = '')
- [ ] **P4.2** - State preserved during streaming (not reset mid-stream)
- [ ] **P5.1** - Gemini API returns chunks with choices[0].delta.content
- [ ] **P5.2** - Gemini API returns finish_reason='stop' at end
- [ ] **P6.1** - No errors in console during streaming
- [ ] **P6.2** - Generator yields without throwing
- [ ] **P10.1** - Built code contains the fix (not stale)

---

## Expected vs Actual Event Sequence

### Expected (Correct) Sequence:
```
1. Request sent to Gemini
2. Stream starts → GeminiLogger.streamStart()
3. Chunk 1: delta.content="H" → OutputTextDelta("H") + accumulate
4. Chunk 2: delta.content="i" → OutputTextDelta("i") + accumulate
5. Chunk 3: delta.content="!" → OutputTextDelta("!") + accumulate
6. Chunk N: finish_reason="stop" → Create message item → OutputItemDone(message)
7. Emit pending Completed event
8. GeminiLogger.streamEnd()
9. TurnManager processes message → Shows "Hi!" to user
10. Shows "Task completed in 1 turn(s)"
```

### Current (Broken) Sequence (Hypothesis):
```
1. Request sent to Gemini
2. Stream starts (maybe no log?)
3. Chunks arrive (maybe no delta.content?)
4. finish_reason="stop" (but no text accumulated?)
5. Completed event emitted immediately (no OutputItemDone)
6. TurnManager sees no message items
7. Shows "Task completed in 1 turn(s)" (no text)
```

---

## Next Steps

1. **Start with Phase 1** - Enable GEMINI_DEBUG and verify logging
2. **If no logs** → The fix isn't running (check Phase 9 - provider detection)
3. **If logs but no text** → Check Phase 2 (event conversion)
4. **If text accumulated but not shown** → Check Phase 3 (event flow)
5. **If all logs correct but still broken** → Check Phase 8 (integration test)

---

## Tools & Commands

### Enable Debug Mode
```javascript
// Browser console:
localStorage.setItem('GEMINI_DEBUG', 'true');
chrome.runtime.reload();
```

### Monitor Event Flow
```javascript
// Add global listener (in extension context):
window.addEventListener('beforeunload', () => {
  console.log('Extension reloading...');
});

// Capture all console logs
const originalLog = console.log;
console.log = function(...args) {
  originalLog.apply(console, ['[CAPTURED]', ...args]);
};
```

### Export Logs
```javascript
// Copy console logs
copy(console.logs); // If using console.save extension
// Or manually copy from DevTools
```

---

## Success Criteria

Debug is complete when we can answer:

1. ✅ **Is the fix code path being executed?**
2. ✅ **Is text being accumulated in chatCompletionTextContent?**
3. ✅ **Is the message item being created?**
4. ✅ **Is OutputItemDone being yielded?**
5. ✅ **Is TurnManager receiving the message item?**

If ALL are YES but still broken → Problem is in TurnManager, not OpenAIResponsesClient
If ANY is NO → Problem is in OpenAIResponsesClient at that specific point

---

## Report Template

After running diagnostics, fill this out:

```
=== GEMINI DEBUG REPORT ===
Date: YYYY-MM-DD
Tester:

PHASE 1: Code Path Execution
- [ ] GEMINI_DEBUG logs visible: YES / NO
- [ ] Provider wire_api: ___________
- [ ] Using ChatCompletions API: YES / NO
- Notes:

PHASE 2: Event Conversion
- [ ] Chunks received with delta.content: YES / NO
- [ ] Text accumulated (length > 0): YES / NO
- [ ] Message item created: YES / NO
- Notes:

PHASE 3: Event Flow
- [ ] OutputItemDone yielded: YES / NO
- [ ] Completed event in pending: YES / NO
- [ ] TurnManager received message: YES / NO
- Notes:

PHASE 5: API Response
- [ ] Gemini returns expected format: YES / NO
- Total chunks received: ___
- Example chunk:
- Notes:

ROOT CAUSE IDENTIFIED:
[Describe the actual problem found]

FIX REQUIRED:
[Describe what needs to change]
```
