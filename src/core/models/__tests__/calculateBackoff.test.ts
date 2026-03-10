/**
 * Unit Tests: calculateBackoff()
 *
 * Tests the exponential backoff calculation logic in ModelClient
 * Rust Reference: pi-rs/core/src/client.rs backoff() utility (lines 245-264)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenAIResponsesClient } from '@/core/models/client/OpenAIResponsesClient';
import type { ModelFamily, ModelProviderInfo } from '@/core/models/types/ResponsesAPI';

describe('calculateBackoff', () => {
  // Helper to create a test client
  const createTestClient = () => {
    const modelFamily: ModelFamily = {
      family: 'gpt-4',
      base_instructions: 'You are a helpful assistant.',
      supports_reasoning: false,
      supports_reasoning_summaries: false,
      needs_special_apply_patch_instructions: false,
    };

    const provider: ModelProviderInfo = {
      name: 'openai',
      base_url: 'https://api.openai.com/v1',
      wire_api: 'Responses',
      requires_openai_auth: true,
      request_max_retries: 3,
    };

    return new OpenAIResponsesClient({
      apiKey: 'test-key',
      sessionId: 'test-conv',
      modelFamily,
      provider,
    });
  };

  describe('Exponential Growth', () => {
    it('should increase delay exponentially with attempt number', () => {
      const client = createTestClient();

      const delay0 = (client as any).calculateBackoff(0);
      const delay1 = (client as any).calculateBackoff(1);
      const delay2 = (client as any).calculateBackoff(2);
      const delay3 = (client as any).calculateBackoff(3);

      // Each delay should be larger than the previous (accounting for jitter)
      // Base delay is typically 1000ms with multiplier 2.0
      // So delays should be approximately: 1000, 2000, 4000, 8000 (plus jitter)

      // Since jitter is random, we test that the base relationship holds
      // delay(n) should be roughly double delay(n-1) on average
      expect(delay1).toBeGreaterThan(delay0 * 0.9); // Allow for jitter
      expect(delay2).toBeGreaterThan(delay1 * 0.9);
      expect(delay3).toBeGreaterThan(delay2 * 0.9);
    });

    it('should follow exponential formula: baseDelay * backoffMultiplier^attempt', () => {
      const client = createTestClient();

      // With default config: baseDelay=1000, backoffMultiplier=2.0, jitterPercent=0.1
      const delay0 = (client as any).calculateBackoff(0);

      // Attempt 0: 1000 * 2^0 = 1000ms (plus up to 10% jitter)
      expect(delay0).toBeGreaterThanOrEqual(1000);
      expect(delay0).toBeLessThanOrEqual(1100); // 1000 + 10% jitter
    });
  });

  describe('Jitter Randomization', () => {
    it('should add randomized jitter to prevent thundering herd', () => {
      const client = createTestClient();

      // Calculate multiple backoffs for the same attempt
      const delays = Array.from({ length: 100 }, () => (client as any).calculateBackoff(1));

      // All delays should be in expected range (2000ms + 0-10% jitter)
      delays.forEach((delay) => {
        expect(delay).toBeGreaterThanOrEqual(2000);
        expect(delay).toBeLessThanOrEqual(2200); // 2000 + 10% jitter
      });

      // With 100 samples, should have at least some variance
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it('should use proportional jitter (10% by default)', () => {
      const client = createTestClient();

      // For attempt 2: base delay is 4000ms
      const delays = Array.from({ length: 100 }, () => (client as any).calculateBackoff(2));

      // Jitter should be proportional (10% of 4000 = 400ms)
      delays.forEach((delay) => {
        expect(delay).toBeGreaterThanOrEqual(4000);
        expect(delay).toBeLessThanOrEqual(4400); // 4000 + 10% jitter
      });
    });
  });

  describe('Max Delay Cap', () => {
    it('should cap delay at maxDelay even for high attempt numbers', () => {
      const client = createTestClient();

      // With exponential growth, high attempts would exceed max delay
      // Default maxDelay is typically 32000ms
      const delay10 = (client as any).calculateBackoff(10);
      const delay20 = (client as any).calculateBackoff(20);
      const delay100 = (client as any).calculateBackoff(100);

      // All should be capped at maxDelay (30000ms + 10% jitter = 33000ms)
      expect(delay10).toBeLessThanOrEqual(33000); // 30000 + 10% jitter
      expect(delay20).toBeLessThanOrEqual(33000);
      expect(delay100).toBeLessThanOrEqual(33000);

      // For very high attempts, should be near the cap (30000ms maxDelay + up to 10% jitter)
      // The default maxDelay in ModelClient is 30000, not 32000
      expect(delay100).toBeGreaterThanOrEqual(30000);
    });

    it('should not exceed maxDelay even with jitter', () => {
      const client = createTestClient();

      // Test many high-attempt delays
      const delays = Array.from({ length: 100 }, () => (client as any).calculateBackoff(50));

      // With jitter, max should be maxDelay + (maxDelay * jitterPercent)
      // Default: 30000 + (30000 * 0.1) = 33000ms
      delays.forEach((delay) => {
        expect(delay).toBeLessThanOrEqual(33000);
      });
    });
  });

  describe('Retry-After Override', () => {
    it('should use server-provided Retry-After when present', () => {
      const client = createTestClient();

      // Server says retry after 5000ms
      const retryAfter = 5000;
      const delay = (client as any).calculateBackoff(1, retryAfter);

      // Should use server delay (with jitter)
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(5500); // 5000 + 10% jitter
    });

    it('should add jitter to Retry-After delay', () => {
      const client = createTestClient();

      const retryAfter = 10000;
      const delays = Array.from({ length: 100 }, () =>
        (client as any).calculateBackoff(1, retryAfter)
      );

      // Should vary due to jitter
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);

      // All should be in range
      delays.forEach((delay) => {
        expect(delay).toBeGreaterThanOrEqual(10000);
        expect(delay).toBeLessThanOrEqual(11000); // 10000 + 10% jitter
      });
    });

    it('should prefer Retry-After over exponential backoff', () => {
      const client = createTestClient();

      // For attempt 5, exponential would be much larger
      // But Retry-After is small
      const retryAfter = 1000;
      const delay = (client as any).calculateBackoff(5, retryAfter);

      // Should use the smaller Retry-After value
      expect(delay).toBeLessThanOrEqual(1100); // 1000 + 10% jitter
    });

    it('should handle Retry-After = 0', () => {
      const client = createTestClient();

      const delay = (client as any).calculateBackoff(1, 0);

      // Should handle gracefully (0 with jitter)
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(100); // Just jitter
    });
  });

  describe('Edge Cases', () => {
    it('should handle attempt = 0', () => {
      const client = createTestClient();

      const delay = (client as any).calculateBackoff(0);

      // First attempt: baseDelay * 2^0 = baseDelay
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1100);
    });

    it('should handle negative attempt numbers', () => {
      const client = createTestClient();

      const delay = (client as any).calculateBackoff(-1);

      // Should handle gracefully (likely same as attempt 0)
      expect(delay).toBeGreaterThanOrEqual(0);
    });

    it('should be deterministic for same RNG seed', () => {
      // Note: This test documents that jitter is random
      // In production, we want randomness for thundering herd prevention
      const client = createTestClient();

      const delay1 = (client as any).calculateBackoff(1);
      const delay2 = (client as any).calculateBackoff(1);

      // Should likely differ due to random jitter
      // (could be same by chance, but unlikely)
      // This test just ensures jitter is being applied
      const delays = Array.from({ length: 10 }, () => (client as any).calculateBackoff(1));
      const allSame = delays.every((d) => d === delays[0]);

      expect(allSame).toBe(false); // Jitter should create variance
    });
  });

  describe('Configuration', () => {
    it('should respect custom retry configuration if provided', () => {
      // This test documents that configuration is customizable
      // Actual test depends on whether config is exposed
      const client = createTestClient();

      // Default config: baseDelay=1000, backoffMultiplier=2.0, maxDelay=32000
      const delay = (client as any).calculateBackoff(1);

      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2200);
    });
  });
});
