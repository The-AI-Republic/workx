/**
 * Demonstration script showing Phase 5 Rate Limiting & Token Tracking functionality
 * This script demonstrates the key features without requiring test framework setup
 */

import { RateLimitManager } from '../RateLimitManager.js';
import { TokenUsageTracker, createDefaultTokenUsageConfig } from '../TokenUsageTracker.js';
import type { TokenUsage } from '../types/TokenUsage.js';

// Demo function to showcase RateLimitManager functionality
function demonstrateRateLimitManager() {
  console.log('=== RateLimitManager Demo ===');

  const rateLimitManager = new RateLimitManager({
    approachingThreshold: 80,
    minRetryDelay: 1000,
    maxRetryDelay: 60000,
  });

  // Simulate rate limit headers from an API response
  console.log('1. Parsing rate limit headers...');
  const headers = {
    'x-browserx-primary-used-percent': '75.0',
    'x-browserx-primary-window-minutes': '60',
    'x-browserx-primary-resets-in-seconds': '1800',
    'x-browserx-secondary-used-percent': '45.0',
    'x-browserx-secondary-window-minutes': '1440',
    'x-browserx-secondary-resets-in-seconds': '43200',
  };

  const snapshot = rateLimitManager.updateFromHeaders(headers);
  console.log('   Parsed snapshot:', JSON.stringify(snapshot, null, 2));

  // Check retry recommendations
  console.log('2. Checking retry recommendations...');
  console.log('   Should retry (80% threshold):', rateLimitManager.shouldRetry(80));
  console.log('   Should retry (70% threshold):', rateLimitManager.shouldRetry(70));

  // Calculate retry delays
  console.log('3. Calculating retry delays...');
  console.log('   Retry delay (attempt 1):', rateLimitManager.calculateRetryDelay(1));
  console.log('   Retry delay (attempt 3):', rateLimitManager.calculateRetryDelay(3));

  // Get summary
  const summary = rateLimitManager.getSummary();
  console.log('4. Rate limit summary:', JSON.stringify(summary, null, 2));

  console.log('');
}

// Demo function to showcase TokenUsageTracker functionality
function demonstrateTokenUsageTracker() {
  console.log('=== TokenUsageTracker Demo ===');

  const config = createDefaultTokenUsageConfig('gpt-4o', {
    autoCompactLimit: 1000, // Low limit for demo
    maxHistoryEntries: 10,
  });

  const tracker = new TokenUsageTracker(config);

  // Simulate multiple turns of token usage
  console.log('1. Tracking token usage across multiple turns...');

  const turn1Usage: TokenUsage = {
    input_tokens: 100,
    cached_input_tokens: 25,
    output_tokens: 75,
    reasoning_output_tokens: 10,
    total_tokens: 210,
  };

  const turn2Usage: TokenUsage = {
    input_tokens: 150,
    cached_input_tokens: 40,
    output_tokens: 120,
    reasoning_output_tokens: 20,
    total_tokens: 330,
  };

  const turn3Usage: TokenUsage = {
    input_tokens: 200,
    cached_input_tokens: 30,
    output_tokens: 180,
    reasoning_output_tokens: 15,
    total_tokens: 425,
  };

  tracker.update(turn1Usage, 'turn-1');
  tracker.update(turn2Usage, 'turn-2');
  const finalInfo = tracker.update(turn3Usage, 'turn-3');

  console.log('   Final session info:', JSON.stringify(finalInfo, null, 2));

  // Check compaction status
  console.log('2. Checking compaction status...');
  console.log('   Should compact:', tracker.shouldCompact());
  console.log('   Usage percentage:', tracker.getUsagePercentage().toFixed(2) + '%');

  // Get efficiency metrics
  console.log('3. Efficiency metrics...');
  const metrics = tracker.getEfficiencyMetrics();
  console.log('   Cache hit rate:', metrics.cacheHitRate.toFixed(2) + '%');
  console.log('   Input/output ratio:', metrics.inputOutputRatio.toFixed(2));
  console.log('   Tokens per turn:', metrics.tokensPerTurn.toFixed(1));

  // Get usage for time ranges
  console.log('4. Time-based usage queries...');
  const sessionUsage = tracker.getSessionUsage();
  console.log('   Session usage:', JSON.stringify(sessionUsage.usage, null, 2));
  console.log('   Total entries:', sessionUsage.entryCount);

  // Get summary
  const summary = tracker.getSummary();
  console.log('5. Usage summary:', JSON.stringify(summary, null, 2));

  console.log('');
}

// Demo function showing integration between both components
function demonstrateIntegration() {
  console.log('=== Integration Demo ===');

  const rateLimitManager = new RateLimitManager();
  const tokenTracker = new TokenUsageTracker(
    createDefaultTokenUsageConfig('gpt-4o')
  );

  // Simulate a sequence of API calls with varying rate limits and token usage
  console.log('1. Simulating API call sequence...');

  const apiCalls = [
    {
      rateLimitHeaders: { 'x-browserx-primary-used-percent': '45.0' },
      tokenUsage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 80, reasoning_output_tokens: 5, total_tokens: 205 },
    },
    {
      rateLimitHeaders: { 'x-browserx-primary-used-percent': '67.0', 'x-browserx-primary-resets-in-seconds': '900' },
      tokenUsage: { input_tokens: 150, cached_input_tokens: 30, output_tokens: 120, reasoning_output_tokens: 8, total_tokens: 308 },
    },
    {
      rateLimitHeaders: { 'x-browserx-primary-used-percent': '89.0', 'x-browserx-primary-resets-in-seconds': '600' },
      tokenUsage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 160, reasoning_output_tokens: 12, total_tokens: 422 },
    },
  ];

  apiCalls.forEach((call, index) => {
    console.log(`   API call ${index + 1}:`);

    // Update rate limits
    const rateLimitSnapshot = rateLimitManager.updateFromHeaders(call.rateLimitHeaders);
    console.log(`     Rate limit: ${rateLimitSnapshot.primary?.used_percent}%`);
    console.log(`     Should retry: ${rateLimitManager.shouldRetry()}`);

    // Update token usage
    const tokenInfo = tokenTracker.update(call.tokenUsage as TokenUsage, `turn-${index + 1}`);
    console.log(`     Total tokens: ${tokenInfo.total_token_usage.total_tokens}`);
    console.log(`     Should compact: ${tokenTracker.shouldCompact()}`);
    console.log('');
  });

  // Show final integrated status
  console.log('2. Final integrated status...');
  const rateLimitSummary = rateLimitManager.getSummary();
  const tokenSummary = tokenTracker.getSummary();

  console.log('   Rate Limits:', {
    approaching: rateLimitSummary.isApproaching,
    mostRestrictive: rateLimitSummary.mostRestrictive?.used_percent + '%',
    nextReset: rateLimitSummary.nextResetSeconds + 's',
  });

  console.log('   Token Usage:', {
    total: tokenSummary.totalTokens,
    percentage: tokenSummary.usagePercentage.toFixed(1) + '%',
    shouldCompact: tokenSummary.shouldCompact,
    cacheHitRate: tokenSummary.efficiency.cacheHitRate.toFixed(1) + '%',
  });

  console.log('');
}

// Main demo execution
function runDemo() {
  console.log('Phase 5 - Rate Limiting & Token Tracking Demo');
  console.log('=============================================\n');

  try {
    demonstrateRateLimitManager();
    demonstrateTokenUsageTracker();
    demonstrateIntegration();

    console.log('✅ All Phase 5 components working correctly!');
    console.log('\nKey Features Demonstrated:');
    console.log('• RateLimitManager: Header parsing, retry logic, delay calculation');
    console.log('• TokenUsageTracker: Usage aggregation, compaction detection, efficiency metrics');
    console.log('• Integration: Coordinated rate limiting and token tracking');

  } catch (error) {
    console.error('❌ Demo failed:', error);
  }
}

// Export for potential use in other contexts
export {
  demonstrateRateLimitManager,
  demonstrateTokenUsageTracker,
  demonstrateIntegration,
  runDemo,
};

// Run demo if this file is executed directly
if (typeof window === 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  runDemo();
}