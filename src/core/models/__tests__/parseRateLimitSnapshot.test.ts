/**
 * Unit Tests: parseRateLimitSnapshot()
 *
 * Tests the rate limit header parsing logic in OpenAIResponsesClient
 * Rust Reference: browserx-rs/core/src/client.rs lines 580-619
 */

import { describe, it, expect } from 'vitest';
import { OpenAIResponsesClient } from '@/models/client/OpenAIResponsesClient';
import type { ModelFamily, ModelProviderInfo } from '@/models/types/ResponsesAPI';

describe('parseRateLimitSnapshot', () => {
  // Helper to create a test client
  const createTestClient = () => {
    const modelFamily: ModelFamily = {
      family: 'gpt-4',
      base_instructions: 'You are a helpful assistant.',
      supports_reasoning_summaries: false,
      needs_special_apply_patch_instructions: false,
    };

    const provider: ModelProviderInfo = {
      name: 'openai',
      base_url: 'https://api.openai.com/v1',
      wire_api: 'Responses',
      request_max_retries: 3,
    };

    return new OpenAIResponsesClient({
      apiKey: 'test-key',
      conversationId: 'test-conv',
      modelFamily,
      provider,
    });
  };

  describe('Primary Window Only', () => {
    it('should parse primary rate limit window from headers', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '75.5');
      headers.set('x-browserx-primary-window-minutes', '60');
      headers.set('x-browserx-primary-resets-in-seconds', '1800');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeDefined();
      expect(snapshot.primary).toBeDefined();
      expect(snapshot.primary.used_percent).toBe(75.5);
      expect(snapshot.primary.window_minutes).toBe(60);
      expect(snapshot.primary.resets_in_seconds).toBe(1800);
      expect(snapshot.secondary).toBeUndefined();
    });

    it('should handle primary window without optional fields', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '50.0');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeDefined();
      expect(snapshot.primary).toBeDefined();
      expect(snapshot.primary.used_percent).toBe(50.0);
      expect(snapshot.primary.window_minutes).toBeUndefined();
      expect(snapshot.primary.resets_in_seconds).toBeUndefined();
    });
  });

  describe('Secondary Window Only', () => {
    it('should parse secondary rate limit window from headers', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-secondary-used-percent', '25.0');
      headers.set('x-browserx-secondary-window-minutes', '1440');
      headers.set('x-browserx-secondary-resets-in-seconds', '86400');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeDefined();
      expect(snapshot.primary).toBeUndefined();
      expect(snapshot.secondary).toBeDefined();
      expect(snapshot.secondary.used_percent).toBe(25.0);
      expect(snapshot.secondary.window_minutes).toBe(1440);
      expect(snapshot.secondary.resets_in_seconds).toBe(86400);
    });
  });

  describe('Both Windows', () => {
    it('should parse both primary and secondary rate limit windows', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '75.5');
      headers.set('x-browserx-primary-window-minutes', '60');
      headers.set('x-browserx-primary-resets-in-seconds', '1800');
      headers.set('x-browserx-secondary-used-percent', '25.0');
      headers.set('x-browserx-secondary-window-minutes', '1440');
      headers.set('x-browserx-secondary-resets-in-seconds', '86400');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeDefined();
      expect(snapshot.primary).toBeDefined();
      expect(snapshot.primary.used_percent).toBe(75.5);
      expect(snapshot.primary.window_minutes).toBe(60);
      expect(snapshot.primary.resets_in_seconds).toBe(1800);
      expect(snapshot.secondary).toBeDefined();
      expect(snapshot.secondary.used_percent).toBe(25.0);
      expect(snapshot.secondary.window_minutes).toBe(1440);
      expect(snapshot.secondary.resets_in_seconds).toBe(86400);
    });
  });

  describe('Missing Headers', () => {
    it('should return undefined when no rate limit headers present', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('content-type', 'text/event-stream');
      headers.set('x-request-id', 'req_123');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeUndefined();
    });

    it('should return undefined when headers is undefined', () => {
      const client = createTestClient();

      const snapshot = (client as any).parseRateLimitSnapshot(undefined);

      expect(snapshot).toBeUndefined();
    });

    it('should return undefined when headers is empty', () => {
      const client = createTestClient();
      const headers = new Headers();

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeUndefined();
    });
  });

  describe('Invalid Header Values', () => {
    it('should handle invalid numeric values gracefully', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', 'invalid');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      // Should return undefined or handle gracefully (implementation-specific)
      // The exact behavior depends on implementation
      expect(snapshot).toBeUndefined();
    });

    it('should handle negative values', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '-10');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      // Implementation should validate or ignore negative values
      expect(snapshot).toBeUndefined();
    });

    it('should handle values exceeding 100%', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '150.0');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      // Implementation may accept >100% (e.g., burst usage) or reject
      // This test documents expected behavior
      if (snapshot) {
        expect(snapshot.primary.used_percent).toBe(150.0);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero percent used', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '0.0');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeDefined();
      expect(snapshot.primary.used_percent).toBe(0.0);
    });

    it('should handle 100 percent used', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '100.0');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeDefined();
      expect(snapshot.primary.used_percent).toBe(100.0);
    });

    it('should handle zero seconds until reset', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '95.0');
      headers.set('x-browserx-primary-resets-in-seconds', '0');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeDefined();
      expect(snapshot.primary.resets_in_seconds).toBe(0);
    });

    it('should handle fractional percentages', () => {
      const client = createTestClient();
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '33.333');

      const snapshot = (client as any).parseRateLimitSnapshot(headers);

      expect(snapshot).toBeDefined();
      expect(snapshot.primary.used_percent).toBeCloseTo(33.333, 3);
    });
  });
});
