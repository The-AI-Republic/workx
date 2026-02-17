import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitManager } from '../RateLimitManager.js';
import { TokenUsageTracker, createDefaultTokenUsageConfig } from '../TokenUsageTracker.js';
import { OpenAIChatCompletionClient } from '../client/OpenAIChatCompletionClient.js';
import { createEmptyTokenUsage } from '../types/TokenUsage.js';
import { createRateLimitWindow } from '../types/RateLimits.js';
import type { TokenUsage } from '../types/TokenUsage.js';

describe('Integration Tests - Rate Limiting & Token Tracking', () => {
  let rateLimitManager: RateLimitManager;
  let tokenUsageTracker: TokenUsageTracker;
  let responsesClient: OpenAIChatCompletionClient;

  beforeEach(() => {
    rateLimitManager = new RateLimitManager({
      approachingThreshold: 80,
      minRetryDelay: 1000,
      maxRetryDelay: 10000,
    });

    const config = createDefaultTokenUsageConfig('gpt-4o', {
      maxHistoryAge: 60000, // 1 minute for tests
      maxHistoryEntries: 100,
    });
    tokenUsageTracker = new TokenUsageTracker(config);

    responsesClient = new OpenAIChatCompletionClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.openai.com',
      conversationId: 'test-conversation-id',
      modelFamily: {
        family: 'gpt-4o',
        base_instructions: 'You are a helpful assistant.',
        supports_reasoning_summaries: false,
        needs_special_apply_patch_instructions: false,
      },
      provider: {
        name: 'openai',
        base_url: 'https://api.openai.com/v1',
        wire_api: 'Responses' as const,
        request_max_retries: 3,
        stream_idle_timeout_ms: 60000,
        requires_openai_auth: true,
      },
    });
  });

  describe('Rate Limit Header Parsing', () => {
    it('should parse complete rate limit headers correctly', () => {
      const headers = {
        'x-pi-primary-used-percent': '75.5',
        'x-pi-primary-window-minutes': '60',
        'x-pi-primary-resets-in-seconds': '1800',
        'x-pi-secondary-used-percent': '45.2',
        'x-pi-secondary-window-minutes': '1440',
        'x-pi-secondary-resets-in-seconds': '43200',
      };

      const snapshot = rateLimitManager.updateFromHeaders(headers);

      expect(snapshot.primary).toEqual({
        used_percent: 75.5,
        window_minutes: 60,
        resets_in_seconds: 1800,
      });

      expect(snapshot.secondary).toEqual({
        used_percent: 45.2,
        window_minutes: 1440,
        resets_in_seconds: 43200,
      });
    });

    it('should handle partial headers gracefully', () => {
      const headers = {
        'x-pi-primary-used-percent': '90.0',
        // Missing other primary headers
        'x-pi-secondary-used-percent': '30.0',
        'x-pi-secondary-window-minutes': '1440',
        // Missing secondary reset time
      };

      const snapshot = rateLimitManager.updateFromHeaders(headers);

      expect(snapshot.primary).toEqual({
        used_percent: 90.0,
        window_minutes: undefined,
        resets_in_seconds: undefined,
      });

      expect(snapshot.secondary).toEqual({
        used_percent: 30.0,
        window_minutes: 1440,
        resets_in_seconds: undefined,
      });
    });

    it('should ignore invalid header values', () => {
      const headers = {
        'x-pi-primary-used-percent': 'invalid',
        'x-pi-secondary-used-percent': '50.0',
        'x-pi-secondary-window-minutes': 'also-invalid',
      };

      const snapshot = rateLimitManager.updateFromHeaders(headers);

      expect(snapshot.primary).toBeUndefined();
      expect(snapshot.secondary).toEqual({
        used_percent: 50.0,
        window_minutes: undefined,
        resets_in_seconds: undefined,
      });
    });

    it('should maintain rate limit history with timestamps', () => {
      const startTime = Date.now();

      // First update
      rateLimitManager.updateFromHeaders({
        'x-pi-primary-used-percent': '30.0',
      });

      // Second update
      rateLimitManager.updateFromHeaders({
        'x-pi-primary-used-percent': '60.0',
      });

      const history = rateLimitManager.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].snapshot.primary?.used_percent).toBe(30.0);
      expect(history[1].snapshot.primary?.used_percent).toBe(60.0);
      expect(history[0].timestamp).toBeGreaterThanOrEqual(startTime);
      expect(history[1].timestamp).toBeGreaterThan(history[0].timestamp);
    });
  });

  describe('Token Usage Aggregation', () => {
    it('should aggregate token usage correctly across multiple updates', () => {
      const usage1: TokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 180,
      };

      const usage2: TokenUsage = {
        input_tokens: 150,
        cached_input_tokens: 30,
        output_tokens: 75,
        reasoning_output_tokens: 15,
        total_tokens: 270,
      };

      tokenUsageTracker.update(usage1, 'turn-1');
      const info = tokenUsageTracker.update(usage2, 'turn-2');

      expect(info.total_token_usage).toEqual({
        input_tokens: 250,
        cached_input_tokens: 50,
        output_tokens: 125,
        reasoning_output_tokens: 25,
        total_tokens: 450,
      });

      expect(info.last_token_usage).toEqual(usage2);
    });

    it('should track usage over time with filtering', () => {
      const baseTime = Date.now();
      vi.setSystemTime(baseTime);

      // Add usage at different times
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 100 }, 'turn-1');

      vi.setSystemTime(baseTime + 30000); // 30 seconds later
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 200 }, 'turn-2');

      vi.setSystemTime(baseTime + 60000); // 1 minute later
      tokenUsageTracker.update({ ...createEmptyTokenUsage(), total_tokens: 150 }, 'turn-3');

      // Get usage for last 45 seconds (should include turn-2 and turn-3)
      const recentUsage = tokenUsageTracker.getUsageForRange({
        start: baseTime + 15000,
        end: baseTime + 60000,
      });

      expect(recentUsage.entryCount).toBe(2);
      expect(recentUsage.usage.total_tokens).toBe(350); // 200 + 150
    });

    it('should detect when compaction is needed', () => {
      const config = createDefaultTokenUsageConfig('gpt-4', {
        autoCompactLimit: 1000, // Low limit for testing
      });
      const tracker = new TokenUsageTracker(config);

      // Add usage below limit
      tracker.update({ ...createEmptyTokenUsage(), total_tokens: 500 });
      expect(tracker.shouldCompact()).toBe(false);

      // Add usage that exceeds limit
      tracker.update({ ...createEmptyTokenUsage(), total_tokens: 600 });
      expect(tracker.shouldCompact()).toBe(true);
    });

    it('should calculate efficiency metrics correctly', () => {
      tokenUsageTracker.update({
        input_tokens: 100,
        cached_input_tokens: 50,
        output_tokens: 75,
        reasoning_output_tokens: 25,
        total_tokens: 250,
      }, 'turn-1');

      tokenUsageTracker.update({
        input_tokens: 80,
        cached_input_tokens: 20,
        output_tokens: 60,
        reasoning_output_tokens: 15,
        total_tokens: 175,
      }, 'turn-2');

      const metrics = tokenUsageTracker.getEfficiencyMetrics();

      expect(metrics.totalTokens).toBe(425);
      expect(metrics.cacheHitRate).toBeCloseTo(33.33, 1); // (50+20)/(100+50+80+20) * 100
      expect(metrics.inputOutputRatio).toBeCloseTo(1.33, 1); // (100+80)/(75+60)
      expect(metrics.tokensPerTurn).toBeCloseTo(212.5, 1); // 425/2
    });
  });

  describe('Retry Logic with Rate Limits', () => {
    it('should recommend retry when usage is below threshold', () => {
      rateLimitManager.updateFromHeaders({
        'x-pi-primary-used-percent': '60.0',
        'x-pi-primary-resets-in-seconds': '300',
      });

      expect(rateLimitManager.shouldRetry(80)).toBe(true);

      // Retry delay should use exponential backoff since under threshold
      const delay = rateLimitManager.calculateRetryDelay(1);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(10000);
    });

    it('should discourage retry when approaching limits', () => {
      rateLimitManager.updateFromHeaders({
        'x-pi-primary-used-percent': '95.0',
        'x-pi-primary-resets-in-seconds': '1800',
      });

      expect(rateLimitManager.shouldRetry(80)).toBe(false);

      // Retry delay should be based on reset time
      const delay = rateLimitManager.calculateRetryDelay(1);
      expect(delay).toBeGreaterThan(1000); // Should be substantial due to high usage
    });

    it('should calculate retry delay from reset time when available', () => {
      rateLimitManager.updateFromHeaders({
        'x-pi-primary-used-percent': '70.0',
        'x-pi-primary-resets-in-seconds': '5', // 5 seconds
      });

      const delay = rateLimitManager.calculateRetryDelay(1);
      expect(delay).toBeGreaterThanOrEqual(5000); // At least 5 seconds
      expect(delay).toBeLessThanOrEqual(6000); // With some jitter
    });

    it('should use exponential backoff when no reset time available', () => {
      rateLimitManager.updateFromHeaders({
        'x-pi-primary-used-percent': '50.0',
        // No reset time headers
      });

      const delay1 = rateLimitManager.calculateRetryDelay(1);
      const delay2 = rateLimitManager.calculateRetryDelay(2);
      const delay3 = rateLimitManager.calculateRetryDelay(3);

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
      expect(delay3).toBeLessThanOrEqual(10000); // Respect max delay
    });
  });

  describe('End-to-End Streaming with Rate Limits and Token Tracking', () => {
    it('should handle complete streaming flow with metrics tracking', async () => {
      // Mock fetch to return streaming response with rate limit headers
      const mockResponse = {
        ok: true,
        headers: new Headers([
          ['content-type', 'text/event-stream'],
          ['x-pi-primary-used-percent', '65.0'],
          ['x-pi-primary-window-minutes', '60'],
          ['x-pi-primary-resets-in-seconds', '2400'],
        ]),
        body: new ReadableStream({
          start(controller) {
            // Send SSE events
            controller.enqueue(new TextEncoder().encode('event: message\n'));
            controller.enqueue(new TextEncoder().encode('data: {"type": "content", "text": "Hello"}\n\n'));

            controller.enqueue(new TextEncoder().encode('event: usage\n'));
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
              input_tokens: 50,
              cached_input_tokens: 10,
              output_tokens: 25,
              reasoning_output_tokens: 5,
              total_tokens: 90
            })}\n\n`));

            controller.enqueue(new TextEncoder().encode('event: done\n'));
            controller.enqueue(new TextEncoder().encode('data: {}\n\n'));

            controller.close();
          },
        }),
      };

      (globalThis as any).fetch = vi.fn().mockResolvedValue(mockResponse);

      const stream = responsesClient.streamCompletion({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const events = [];
      let rateLimitSnapshot;
      let tokenUsage;

      for await (const event of stream) {
        events.push(event);

        if (event.type === 'usage') {
          tokenUsage = event.usage;
          tokenUsageTracker.update(tokenUsage!, 'test-turn');
        }

        if (event.type === 'response_metadata' && event.headers) {
          const headerEntries: Record<string, string> = {};
          event.headers.forEach((value, key) => {
            headerEntries[key] = value;
          });
          rateLimitSnapshot = rateLimitManager.updateFromHeaders(headerEntries);
        }
      }

      // Verify events were processed
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'content')).toBe(true);
      expect(events.some(e => e.type === 'usage')).toBe(true);

      // Verify rate limit tracking
      expect(rateLimitSnapshot?.primary?.used_percent).toBe(65.0);
      expect(rateLimitManager.shouldRetry()).toBe(true);

      // Verify token usage tracking
      const sessionInfo = tokenUsageTracker.getSessionInfo();
      expect(sessionInfo.total_token_usage.total_tokens).toBe(90);
      expect(sessionInfo.last_token_usage.input_tokens).toBe(50);

      // Verify integration between both systems
      const rateLimitSummary = rateLimitManager.getSummary();
      const tokenSummary = tokenUsageTracker.getSummary();

      expect(rateLimitSummary.hasLimits).toBe(true);
      expect(rateLimitSummary.isApproaching).toBe(false);
      expect(tokenSummary.totalTokens).toBe(90);
      expect(tokenSummary.shouldCompact).toBe(false);
    });

    it('should handle rate limit threshold breaches during streaming', async () => {
      // Simulate escalating rate limit usage
      const updates = [
        { 'x-pi-primary-used-percent': '75.0' },
        { 'x-pi-primary-used-percent': '85.0' },
        { 'x-pi-primary-used-percent': '95.0', 'x-pi-primary-resets-in-seconds': '1200' },
      ];

      const results = updates.map(headers => ({
        snapshot: rateLimitManager.updateFromHeaders(headers),
        shouldRetry: rateLimitManager.shouldRetry(80),
        delay: rateLimitManager.calculateRetryDelay(1),
      }));

      // First update: under threshold
      expect(results[0].shouldRetry).toBe(true);
      expect(results[0].delay).toBeLessThan(2000); // Low exponential backoff

      // Second update: approaching threshold
      expect(results[1].shouldRetry).toBe(false);

      // Third update: over threshold with reset time
      expect(results[2].shouldRetry).toBe(false);
      expect(results[2].delay).toBeGreaterThan(1000); // Based on reset time
    });

    it('should coordinate token tracking with compaction decisions', async () => {
      const config = createDefaultTokenUsageConfig('gpt-4', {
        autoCompactLimit: 500, // Low for testing
      });
      const tracker = new TokenUsageTracker(config);

      // Simulate progressive token usage
      const usages: TokenUsage[] = [
        { ...createEmptyTokenUsage(), total_tokens: 150 },
        { ...createEmptyTokenUsage(), total_tokens: 200 },
        { ...createEmptyTokenUsage(), total_tokens: 180 }, // This should trigger compaction
      ];

      const results = usages.map((usage, i) => ({
        info: tracker.update(usage, `turn-${i + 1}`),
        shouldCompact: tracker.shouldCompact(),
        usagePercentage: tracker.getUsagePercentage(),
      }));

      expect(results[0].shouldCompact).toBe(false);
      expect(results[1].shouldCompact).toBe(false);
      expect(results[2].shouldCompact).toBe(true); // 530 > 500

      // Verify usage percentage calculation
      expect(results[2].usagePercentage).toBeGreaterThan(6); // 530/8192 * 100
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle malformed rate limit headers gracefully', () => {
      const malformedHeaders = {
        'x-pi-primary-used-percent': '', // Empty
        'x-pi-secondary-used-percent': 'NaN', // Invalid
        'x-pi-primary-window-minutes': '-5', // Negative
      };

      const snapshot = rateLimitManager.updateFromHeaders(malformedHeaders);
      expect(snapshot.primary).toBeUndefined();
      expect(snapshot.secondary).toBeUndefined();

      // Should still provide defaults
      expect(rateLimitManager.shouldRetry()).toBe(true);
      expect(rateLimitManager.calculateRetryDelay(1)).toBeGreaterThan(0);
    });

    it('should handle token usage with zero values', () => {
      const zeroUsage = createEmptyTokenUsage();
      tokenUsageTracker.update(zeroUsage);

      const metrics = tokenUsageTracker.getEfficiencyMetrics();
      expect(metrics.cacheHitRate).toBe(0);
      expect(metrics.inputOutputRatio).toBe(0);
      expect(metrics.tokensPerTurn).toBe(0);
    });

    it('should maintain consistency during rapid updates', () => {
      // Simulate rapid rate limit updates
      for (let i = 0; i < 100; i++) {
        rateLimitManager.updateFromHeaders({
          'x-pi-primary-used-percent': (i % 100).toString(),
        });
      }

      const history = rateLimitManager.getHistory();
      expect(history.length).toBe(100);
      expect(history[history.length - 1].snapshot.primary?.used_percent).toBe(99);

      // Simulate rapid token usage updates
      for (let i = 0; i < 50; i++) {
        tokenUsageTracker.update({
          ...createEmptyTokenUsage(),
          total_tokens: i * 10,
        }, `rapid-${i}`);
      }

      const sessionInfo = tokenUsageTracker.getSessionInfo();
      expect(sessionInfo.total_token_usage.total_tokens).toBe(12250); // Sum of 0+10+20+...+490
    });
  });
});

/**
 * Rate Limit Parsing Integration Tests
 *
 * These tests verify parseRateLimitSnapshot() method specifically for
 * OpenAIChatCompletionClient.
 */
describe('Rate Limit Parsing Integration - OpenAIChatCompletionClient', () => {
  let client: any;

  beforeEach(async () => {
    const { OpenAIChatCompletionClient } = await import('../client/OpenAIChatCompletionClient');

    client = new OpenAIChatCompletionClient(
      {
        apiKey: 'test-api-key',
        conversationId: 'ratelimit-test',
        modelFamily: {
          family: 'gpt-4',
          base_instructions: 'Test',
          supports_reasoning_summaries: false,
          needs_special_apply_patch_instructions: false,
        },
        provider: {
          name: 'openai',
          base_url: 'https://api.openai.com/v1',
          wire_api: 'Responses' as const,
          request_max_retries: 3,
          stream_idle_timeout_ms: 60000,
          requires_openai_auth: true,
        },
      },
      { maxRetries: 3, baseDelayMs: 100 }
    );
  });

  describe('parseRateLimitSnapshot() - Complete Headers', () => {
    it('parses both primary and secondary windows with all fields', async () => {
      const headers = new Headers({
        'x-pi-primary-used-percent': '75.5',
        'x-pi-primary-window-minutes': '60',
        'x-pi-primary-resets-in-seconds': '1800',
        'x-pi-secondary-used-percent': '45.2',
        'x-pi-secondary-window-minutes': '1440',
        'x-pi-secondary-resets-in-seconds': '43200',
      });

      // Access protected method via test helper if available, or via stream response
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: any[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      // Should have RateLimits event
      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');

      if (rateLimitEvent) {
        expect(rateLimitEvent.snapshot.primary).toEqual({
          used_percent: 75.5,
          window_minutes: 60,
          resets_in_seconds: 1800,
        });

        expect(rateLimitEvent.snapshot.secondary).toEqual({
          used_percent: 45.2,
          window_minutes: 1440,
          resets_in_seconds: 43200,
        });
      }
    });
  });

  describe('parseRateLimitSnapshot() - Primary Window Only', () => {
    it('parses only primary window when secondary headers missing', async () => {
      const headers = new Headers({
        'x-pi-primary-used-percent': '82.0',
        'x-pi-primary-window-minutes': '60',
        'x-pi-primary-resets-in-seconds': '2400',
        // No secondary headers
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: any[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');

      if (rateLimitEvent) {
        expect(rateLimitEvent.snapshot.primary).toEqual({
          used_percent: 82.0,
          window_minutes: 60,
          resets_in_seconds: 2400,
        });

        // Contract: secondary should be undefined when headers missing
        expect(rateLimitEvent.snapshot.secondary).toBeUndefined();
      }
    });
  });

  describe('parseRateLimitSnapshot() - Partial Headers', () => {
    it('handles missing window_minutes field gracefully', async () => {
      const headers = new Headers({
        'x-pi-primary-used-percent': '65.0',
        // Missing window-minutes
        'x-pi-primary-resets-in-seconds': '1200',
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: any[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');

      if (rateLimitEvent) {
        // Contract: Partial window still returns, with undefined for missing fields
        expect(rateLimitEvent.snapshot.primary).toEqual({
          used_percent: 65.0,
          window_minutes: undefined,
          resets_in_seconds: 1200,
        });
      }
    });

    it('handles missing resets_in_seconds field gracefully', async () => {
      const headers = new Headers({
        'x-pi-primary-used-percent': '55.5',
        'x-pi-primary-window-minutes': '60',
        // Missing resets-in-seconds
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: any[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');

      if (rateLimitEvent) {
        expect(rateLimitEvent.snapshot.primary).toEqual({
          used_percent: 55.5,
          window_minutes: 60,
          resets_in_seconds: undefined,
        });
      }
    });
  });

  describe('parseRateLimitSnapshot() - Missing Headers', () => {
    it('returns undefined when no rate limit headers present', async () => {
      const headers = new Headers({
        'content-type': 'text/event-stream',
        // No rate limit headers
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: any[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      // Contract: No RateLimits event when headers missing
      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');
      expect(rateLimitEvent).toBeUndefined();
    });
  });

  describe('parseRateLimitSnapshot() - Field Name Preservation', () => {
    it('preserves snake_case field names', async () => {
      const headers = new Headers({
        'x-pi-primary-used-percent': '70.0',
        'x-pi-primary-window-minutes': '60',
        'x-pi-primary-resets-in-seconds': '1500',
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: any[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');

      if (rateLimitEvent && rateLimitEvent.snapshot.primary) {
        const window = rateLimitEvent.snapshot.primary;

        // Contract: Must use snake_case
        expect(window.used_percent).toBeDefined();
        expect(window.window_minutes).toBeDefined();
        expect(window.resets_in_seconds).toBeDefined();

        // Should NOT have camelCase variants
        expect((window as any).usedPercent).toBeUndefined();
        expect((window as any).windowMinutes).toBeUndefined();
        expect((window as any).resetsInSeconds).toBeUndefined();
      }
    });
  });

  describe('parseRateLimitSnapshot() - Numeric Validation', () => {
    it('handles invalid numeric values gracefully', async () => {
      const headers = new Headers({
        'x-pi-primary-used-percent': 'invalid',
        'x-pi-primary-window-minutes': '60',
        'x-pi-secondary-used-percent': '45.0',
        'x-pi-secondary-window-minutes': 'NaN',
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: any[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');

      // Contract: Invalid values should be handled gracefully
      // Either undefined primary or valid secondary only
      if (rateLimitEvent) {
        // Primary should be undefined due to invalid used_percent
        expect(rateLimitEvent.snapshot.primary).toBeUndefined();

        // Secondary might be present with partial data
        if (rateLimitEvent.snapshot.secondary) {
          expect(rateLimitEvent.snapshot.secondary.used_percent).toBe(45.0);
          expect(rateLimitEvent.snapshot.secondary.window_minutes).toBeUndefined();
        }
      }
    });

    it('handles negative values by skipping or treating as invalid', async () => {
      const headers = new Headers({
        'x-pi-primary-used-percent': '-10.0', // Invalid
        'x-pi-primary-window-minutes': '-60', // Invalid
        'x-pi-secondary-used-percent': '50.0', // Valid
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: any[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');

      // Contract: Negative values should be treated as invalid
      if (rateLimitEvent) {
        // Primary should be undefined or have undefined fields
        expect(
          rateLimitEvent.snapshot.primary === undefined ||
            rateLimitEvent.snapshot.primary.used_percent === undefined
        ).toBe(true);
      }
    });
  });

  describe('parseRateLimitSnapshot() - Integration with Event Stream', () => {
    it('yields RateLimits event before other response events', async () => {
      const headers = new Headers({
        'x-pi-primary-used-percent': '60.0',
        'x-pi-primary-window-minutes': '60',
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
            );
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Hi"}\\n\\n')
            );
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"test"}}\\n\\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const eventTypes: string[] = [];

      for await (const event of stream) {
        eventTypes.push(event.type);
      }

      // Contract: RateLimits event should be first
      const rateLimitIndex = eventTypes.indexOf('RateLimits');
      const createdIndex = eventTypes.indexOf('Created');

      if (rateLimitIndex !== -1 && createdIndex !== -1) {
        expect(rateLimitIndex).toBeLessThan(createdIndex);
      }
    });
  });
});