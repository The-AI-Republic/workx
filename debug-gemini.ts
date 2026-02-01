/**
 * Debug Script for Gemini Integration Issue
 *
 * Usage:
 *   export GOOGLE_AI_STUDIO_API_KEY=your_key
 *   npx tsx debug-gemini.ts
 *
 * This script tests the Gemini integration in isolation using the native Google SDK.
 */

import { GoogleCompletionClient } from './src/models/client/GoogleCompletionClient';

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

  // Create client
  section('Step 1: Creating GoogleCompletionClient');

  const config = {
    apiKey: apiKey,
    baseUrl: 'https://generativelanguage.googleapis.com',
    provider: {
      name: 'google-ai-studio',
      id: 'google-ai-studio',
    } as any,
    modelFamily: {
      family: 'gemini-3-pro-preview',
    } as any,
  };

  log('blue', 'Configuration:');
  console.log(JSON.stringify(config, null, 2));

  let client: GoogleCompletionClient;
  try {
    client = new GoogleCompletionClient(config);
    log('green', '✅ Client created successfully');
  } catch (error) {
    log('red', '❌ Failed to create client:', error);
    process.exit(1);
    return;
  }

  // Check state
  section('Step 2: Verifying Client State');

  log('blue', 'Checking properties:');
  console.log('  - model:', client.getModel());
  console.log('  - provider:', client.getProvider().name);

  // Test streaming
  section('Step 3: Testing Stream with "hi" message');

  const prompt = {
    input: [{
      type: 'message' as const,
      role: 'user' as const,
      content: 'hi',
    }],
    tools: [],
  };

  log('blue', 'Sending prompt:', JSON.stringify(prompt, null, 2));

  const events: any[] = [];
  let textDeltas: string[] = [];
  let messageItems: any[] = [];

  try {
    log('yellow', 'Starting stream...');

    const responseStream = await client.stream(prompt as any);

    let eventCount = 0;
    // The ResponseStream has an iterator() method
    for await (const event of responseStream.iterator()) {
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
          log('blue', '    Token usage:', JSON.stringify(event.tokenUsage));
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
  } else {
    log('red', '❌ PROBLEM IDENTIFIED: Gemini integration is not behaving as expected with the native SDK.');
  }

  // Summary
  section('SUMMARY');

  console.log('Test parameters:');
  console.log('  - Model: gemini-3-pro-preview');
  console.log('  - Provider: google-ai-studio');
  console.log('  - API: Native Google SDK');
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
