/**
 * Edge Case Test: Missing Rate Limit Headers
 *
 * Tests that parseRateLimitSnapshot returns undefined for missing headers
 * and handles partial headers correctly
 *
 * **Quickstart Reference**: Edge Case 3
 * **Rust Reference**: pi-rs/core/src/client.rs Lines 580-619 (parseRateLimitSnapshot)
 * **Functional Requirement**: FR-006 (parseRateLimitSnapshot from headers)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIResponsesClient } from '@/core/models/client/OpenAIResponsesClient';
import type { ModelFamily, ModelProviderInfo } from '@/core/models/types';

// Create a test subclass to expose the protected parseRateLimitSnapshot method
class TestableOpenAIResponsesClient extends OpenAIResponsesClient {
  testParseRateLimitSnapshot(headers?: Headers) {
    return this.parseRateLimitSnapshot(headers);
  }
}

function createModelFamily(): ModelFamily {
  return {
    family: 'gpt-4',
    base_instructions: '',
    supports_reasoning: false,
    supports_reasoning_summaries: false,
    needs_special_apply_patch_instructions: false,
  };
}

function createProvider(): ModelProviderInfo {
  return {
    name: 'openai',
    wire_api: 'Responses',
    requires_openai_auth: true,
  };
}

describe('Edge Case: Missing Rate Limit Headers', () => {
  let client: TestableOpenAIResponsesClient;

  beforeEach(() => {
    client = new TestableOpenAIResponsesClient({
      apiKey: 'test-key',
      sessionId: 'test-conv-1',
      modelFamily: createModelFamily(),
      provider: createProvider(),
    });
  });

  it('should return undefined when no rate limit headers present', () => {
    // Given: Response without rate limit headers
    const headers = new Headers();

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Returns undefined
    expect(snapshot).toBeUndefined();
  });

  it('should handle partial headers - primary only', () => {
    // Given: Response with only primary rate limit headers
    const headers = new Headers({
      'x-pi-primary-used-percent': '75.5',
      'x-pi-primary-window-minutes': '60',
      'x-pi-primary-resets-in-seconds': '1200',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Returns snapshot with only primary window
    expect(snapshot).toBeDefined();
    expect(snapshot?.primary).toBeDefined();
    expect(snapshot?.secondary).toBeUndefined();

    // Verify primary values
    expect(snapshot?.primary?.used_percent).toBe(75.5);
    expect(snapshot?.primary?.window_minutes).toBe(60);
    expect(snapshot?.primary?.resets_in_seconds).toBe(1200);
  });

  it('should handle partial headers - secondary only', () => {
    // Given: Response with only secondary rate limit headers
    const headers = new Headers({
      'x-pi-secondary-used-percent': '45.2',
      'x-pi-secondary-window-minutes': '120',
      'x-pi-secondary-resets-in-seconds': '3600',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Returns snapshot with only secondary window
    expect(snapshot).toBeDefined();
    expect(snapshot?.primary).toBeUndefined();
    expect(snapshot?.secondary).toBeDefined();

    // Verify secondary values
    expect(snapshot?.secondary?.used_percent).toBe(45.2);
    expect(snapshot?.secondary?.window_minutes).toBe(120);
    expect(snapshot?.secondary?.resets_in_seconds).toBe(3600);
  });

  it('should handle both primary and secondary headers', () => {
    // Given: Response with both rate limit windows
    const headers = new Headers({
      'x-pi-primary-used-percent': '80.0',
      'x-pi-primary-window-minutes': '60',
      'x-pi-primary-resets-in-seconds': '600',
      'x-pi-secondary-used-percent': '50.0',
      'x-pi-secondary-window-minutes': '120',
      'x-pi-secondary-resets-in-seconds': '3600',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Returns snapshot with both windows
    expect(snapshot).toBeDefined();
    expect(snapshot?.primary).toBeDefined();
    expect(snapshot?.secondary).toBeDefined();

    // Verify primary
    expect(snapshot?.primary?.used_percent).toBe(80.0);
    expect(snapshot?.primary?.window_minutes).toBe(60);

    // Verify secondary
    expect(snapshot?.secondary?.used_percent).toBe(50.0);
    expect(snapshot?.secondary?.window_minutes).toBe(120);
  });

  it('should handle invalid header values gracefully', () => {
    // Given: Headers with invalid/non-numeric values
    const headers = new Headers({
      'x-pi-primary-used-percent': 'invalid',
      'x-pi-primary-window-minutes': 'not-a-number',
      'x-pi-primary-resets-in-seconds': 'abc',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: parseHeaderFloat returns null for non-finite, so used_percent is null,
    // meaning parseRateLimitWindow returns undefined for primary.
    // With no primary or secondary, snapshot is undefined.
    expect(snapshot).toBeUndefined();
  });

  it('should handle empty string header values', () => {
    // Given: Headers with empty strings
    const headers = new Headers({
      'x-pi-primary-used-percent': '',
      'x-pi-primary-window-minutes': '',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Should return undefined (empty strings are treated as missing)
    // Note: Headers constructor may drop empty string values, so get() returns null
    expect(snapshot).toBeUndefined();
  });

  it('should handle missing individual fields', () => {
    // Given: Incomplete primary window (missing window-minutes and resets-in-seconds)
    const headers = new Headers({
      'x-pi-primary-used-percent': '75.5',
      // Missing: x-pi-primary-window-minutes
      // Missing: x-pi-primary-resets-in-seconds
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Should still create snapshot with available fields
    // used_percent is required; window_minutes and resets_in_seconds are optional
    expect(snapshot).toBeDefined();
    expect(snapshot?.primary).toBeDefined();
    expect(snapshot?.primary?.used_percent).toBe(75.5);
    expect(snapshot?.primary?.window_minutes).toBeUndefined();
    expect(snapshot?.primary?.resets_in_seconds).toBeUndefined();
  });

  it('should match quickstart edge case 3 example', () => {
    // Part 1: Missing headers
    {
      // Given: Response without rate limit headers
      const headers = new Headers();
      const snapshot = client.testParseRateLimitSnapshot(headers);

      // Then: Returns undefined
      expect(snapshot).toBeUndefined();
    }

    // Part 2: Partial headers
    {
      // Given: Response with partial headers (only primary)
      const headers = new Headers();
      headers.set('x-pi-primary-used-percent', '75.5');
      headers.set('x-pi-primary-window-minutes', '60');
      headers.set('x-pi-primary-resets-in-seconds', '1200');

      const partialSnapshot = client.testParseRateLimitSnapshot(headers);

      // Then: Returns snapshot with only primary window
      expect(partialSnapshot).toBeDefined();
      expect(partialSnapshot?.primary).toBeDefined();
      expect(partialSnapshot?.secondary).toBeUndefined();
    }
  });

  it('should preserve precision for floating point percentages', () => {
    // Given: Headers with precise floating point values
    const headers = new Headers({
      'x-pi-primary-used-percent': '75.555',
      'x-pi-primary-window-minutes': '60',
      'x-pi-primary-resets-in-seconds': '1200',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Should preserve precision
    expect(snapshot?.primary?.used_percent).toBe(75.555);
    expect(snapshot?.primary?.window_minutes).toBe(60);
  });

  it('should handle zero values correctly', () => {
    // Given: Headers with zero values (valid edge case)
    const headers = new Headers({
      'x-pi-primary-used-percent': '0',
      'x-pi-primary-window-minutes': '60',
      'x-pi-primary-resets-in-seconds': '0',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Should create snapshot with zero values
    expect(snapshot?.primary).toBeDefined();
    expect(snapshot?.primary?.used_percent).toBe(0);
    expect(snapshot?.primary?.resets_in_seconds).toBe(0);
  });

  it('should handle 100% used correctly', () => {
    // Given: Headers showing rate limit fully exhausted
    const headers = new Headers({
      'x-pi-primary-used-percent': '100.0',
      'x-pi-primary-window-minutes': '60',
      'x-pi-primary-resets-in-seconds': '300',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.testParseRateLimitSnapshot(headers);

    // Then: Should create snapshot with 100% used
    expect(snapshot?.primary?.used_percent).toBe(100.0);
    expect(snapshot?.primary?.resets_in_seconds).toBe(300);
  });

  it('should return undefined when headers parameter is undefined', () => {
    const snapshot = client.testParseRateLimitSnapshot(undefined);
    expect(snapshot).toBeUndefined();
  });
});
