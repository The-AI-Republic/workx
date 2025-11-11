/**
 * Debug Script for Gemini Integration Issue
 *
 * Usage:
 *   export GOOGLE_AI_STUDIO_API_KEY=your_key
 *   export GEMINI_DEBUG=true
 *   npx tsx debug-gemini.ts
 *
 * This script tests the Gemini integration in isolation and provides
 * detailed diagnostic output to identify where the issue occurs.
 */

import { OpenAIResponsesClient } from './src/models/OpenAIResponsesClient';

// Color output for better readability
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color: keyof typeof colors, ...args: any[]) {
  console.log(colors[color], ...args, colors.reset);
}

function section(title: string) {
  console.log('\n' + colors.bright + colors.cyan + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60) + colors.reset);
}

async function testGeminiIntegration() {
  section('GEMINI DEBUG TEST - Starting');

  // Check environment
  const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
  if (!apiKey) {
    log('red', '❌ ERROR: GOOGLE_AI_STUDIO_API_KEY environment variable not set');
    log('yellow', 'Please set: export GOOGLE_AI_STUDIO_API_KEY=your_key');
    process.exit(1);
  }

  log('green', '✅ API Key found (length:', apiKey.length + ')');
  log('green', '✅ Debug mode:', process.env.GEMINI_DEBUG === 'true' ? 'ENABLED' : 'DISABLED');

  // Create client
  section('Step 1: Creating OpenAIResponsesClient');

  const config = {
    apiKey: apiKey,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    conversationId: 'debug-test-' + Date.now(),
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
  };

  log('blue', 'Configuration:');
  console.log(JSON.stringify(config, null, 2));

  let client: any;
  try {
    client = new OpenAIResponsesClient(config);
    log('green', '✅ Client created successfully');
  } catch (error) {
    log('red', '❌ Failed to create client:', error);
    process.exit(1);
  }

  // Check private properties
  section('Step 2: Verifying Client State');

  log('blue', 'Checking private properties:');
  console.log('  - chatCompletionTextContent:', client['chatCompletionTextContent']);
  console.log('  - chatCompletionToolCalls size:', client['chatCompletionToolCalls']?.size);
  console.log('  - pendingEvents length:', client['pendingEvents']?.length);

  if (client['chatCompletionTextContent'] === undefined) {
    log('red', '❌ CRITICAL: chatCompletionTextContent property not found!');
    log('yellow', '   This means the fix is not present in the code.');
  } else {
    log('green', '✅ chatCompletionTextContent property exists');
  }

  // Test streaming
  section('Step 3: Testing Stream with "hi" message');

  const requestData = {
    role: 'user' as const,
    content: 'hi',
  };

  log('blue', 'Sending request:', requestData);

  const events: any[] = [];
  let textDeltas: string[] = [];
  let messageItems: any[] = [];

  try {
    log('yellow', 'Starting stream...');

    const stream = client.streamCompletion(requestData);

    let eventCount = 0;
    for await (const event of stream) {
      eventCount++;
      events.push(event);

      // Log each event
      if (event.type === 'OutputTextDelta') {
        textDeltas.push(event.delta);
        log('cyan', `  Event ${eventCount}: OutputTextDelta - "${event.delta}"`);
      } else if (event.type === 'OutputItemDone') {
        log('cyan', `  Event ${eventCount}: OutputItemDone - item type: ${event.item?.type}`);
        if (event.item?.type === 'message') {
          messageItems.push(event.item);
          log('green', '    ✅ Message content:', event.item.content[0]?.text);
        }
      } else if (event.type === 'Completed') {
        log('cyan', `  Event ${eventCount}: Completed`);
        if (event.tokenUsage) {
          log('blue', '    Token usage:', event.tokenUsage);
        }
      } else {
        log('cyan', `  Event ${eventCount}: ${event.type}`);
      }
    }

    log('yellow', 'Stream completed');

  } catch (error) {
    log('red', '❌ Stream failed:', error);
    if (error instanceof Error) {
      log('red', 'Stack trace:', error.stack);
    }
    process.exit(1);
  }

  // Analyze results
  section('Step 4: Analyzing Results');

  log('blue', 'Total events received:', events.length);
  log('blue', 'Event types:', events.map(e => e.type).join(', '));

  console.log('\nEvent breakdown:');
  const eventCounts = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  Object.entries(eventCounts).forEach(([type, count]) => {
    console.log(`  - ${type}: ${count}`);
  });

  // Check for text deltas
  section('Step 5: Text Delta Analysis');

  if (textDeltas.length > 0) {
    log('green', '✅ Text deltas received:', textDeltas.length);
    log('blue', 'Accumulated text:', textDeltas.join(''));
  } else {
    log('red', '❌ No text deltas received');
    log('yellow', '   This suggests Gemini is not returning text content');
  }

  // Check for message items
  section('Step 6: Message Item Analysis');

  if (messageItems.length > 0) {
    log('green', '✅ Message items found:', messageItems.length);
    messageItems.forEach((item, i) => {
      log('blue', `Message ${i + 1}:`, item.content[0]?.text);
    });
  } else {
    log('red', '❌ No message items found');
    log('yellow', '   This is the ROOT CAUSE of the bug!');
  }

  // Check client state after stream
  section('Step 7: Post-Stream State Check');

  log('blue', 'Client state after stream:');
  console.log('  - chatCompletionTextContent:', client['chatCompletionTextContent']);
  console.log('  - chatCompletionToolCalls size:', client['chatCompletionToolCalls']?.size);
  console.log('  - pendingEvents length:', client['pendingEvents']?.length);

  if (client['chatCompletionTextContent']?.length > 0) {
    log('red', '❌ WARNING: Text content not cleared after stream');
    log('yellow', '   Text:', client['chatCompletionTextContent']);
  }

  // Final diagnosis
  section('DIAGNOSIS');

  const hasTextDeltas = textDeltas.length > 0;
  const hasMessageItems = messageItems.length > 0;
  const textContent = textDeltas.join('');

  if (hasTextDeltas && hasMessageItems) {
    log('green', '✅✅✅ SUCCESS: Everything working correctly!');
    log('green', 'Response text:', textContent);
    log('green', 'Message items created:', messageItems.length);
  } else if (hasTextDeltas && !hasMessageItems) {
    log('red', '❌ PROBLEM IDENTIFIED:');
    log('red', '   - Text deltas ARE being received');
    log('red', '   - But message items ARE NOT being created');
    log('yellow', '\nLikely causes:');
    log('yellow', '   1. Text accumulation is happening but message item creation is failing');
    log('yellow', '   2. finish_reason="stop" handler not executing');
    log('yellow', '   3. Message item created but not yielded from generator');
    log('yellow', '\nCheck:');
    log('yellow', '   - convertChatCompletionEventToResponseEvent() finish_reason handler');
    log('yellow', '   - Message item creation logic (lines 774-816)');
    log('yellow', '   - Generator yield statements');
  } else if (!hasTextDeltas && !hasMessageItems) {
    log('red', '❌ PROBLEM IDENTIFIED:');
    log('red', '   - No text deltas received from Gemini API');
    log('yellow', '\nLikely causes:');
    log('yellow', '   1. Gemini API not returning delta.content in chunks');
    log('yellow', '   2. API response format different than expected');
    log('yellow', '   3. Network/authentication issue');
    log('yellow', '\nCheck:');
    log('yellow', '   - Raw API response format');
    log('yellow', '   - convertChatCompletionEventToResponseEvent() chunk parsing');
    log('yellow', '   - Gemini API documentation for response format');
  } else {
    log('yellow', '⚠️  Unexpected state - investigate further');
  }

  // Summary
  section('SUMMARY');

  console.log('Test parameters:');
  console.log('  - Model: gemini-2.5-pro');
  console.log('  - Provider: Google AI Studio');
  console.log('  - API: ChatCompletions');
  console.log('  - Request: "hi"');
  console.log('\nResults:');
  console.log('  - Events received:', events.length);
  console.log('  - Text deltas:', textDeltas.length, hasTextDeltas ? '✅' : '❌');
  console.log('  - Message items:', messageItems.length, hasMessageItems ? '✅' : '❌');
  console.log('  - Accumulated text:', textContent || '(empty)');
  console.log('\nStatus:', hasTextDeltas && hasMessageItems ? '✅ WORKING' : '❌ BROKEN');

  section('END OF TEST');

  process.exit(hasTextDeltas && hasMessageItems ? 0 : 1);
}

// Run test
testGeminiIntegration().catch((error) => {
  section('FATAL ERROR');
  log('red', error);
  console.error(error);
  process.exit(1);
});
