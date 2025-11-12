/**
 * Edge Case Test: Missing Rate Limit Headers
 *
 * Tests that parseRateLimitSnapshot returns undefined for missing headers
 * and handles partial headers correctly
 *
 * **Quickstart Reference**: Edge Case 3
 * **Rust Reference**: browserx-rs/core/src/client.rs Lines 580-619 (parseRateLimitSnapshot)
 * **Functional Requirement**: FR-006 (parseRateLimitSnapshot from headers)
 */

import { describe, it, expect } from 'vitest';
import { OpenAIResponsesClient } from '../../../src/models/client/OpenAIResponsesClient';
import type { ModelFamily, ModelProviderInfo } from '../../../src/models/types';

describe('Edge Case: Missing Rate Limit Headers', () => {
  let client: OpenAIResponsesClient;

  beforeEach(() => {
    client = new OpenAIResponsesClient({
      apiKey: 'test-key',
      modelFamily: {
        family: 'gpt-4',
        supports_reasoning_summaries: false,
        supports_extended_thinking: false,
      } as ModelFamily,
      provider: {
        name: 'openai',
        api_base_url: 'https://api.openai.com/v1',
        wire_api: 'Responses',
        requires_openai_auth: true,
      } as ModelProviderInfo,
    });
  });

  it('should return undefined when no rate limit headers present', () => {
    // Given: Response without rate limit headers
    const headers = new Headers();

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Returns undefined
    expect(snapshot).toBeUndefined();
    // ✅ PASS: Handles missing headers gracefully
  });

  it('should handle partial headers - primary only', () => {
    // Given: Response with only primary rate limit headers
    const headers = new Headers({
      'x-browserx-primary-used-percent': '75.5',
      'x-browserx-primary-remaining-tokens': '12500',
      'x-browserx-primary-reset-at': '1640000000',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Returns snapshot with only primary window
    expect(snapshot).toBeDefined();
    expect(snapshot?.primary).toBeDefined();
    expect(snapshot?.secondary).toBeUndefined();

    // Verify primary values
    expect(snapshot?.primary?.used_percent).toBe(75.5);
    expect(snapshot?.primary?.remaining_tokens).toBe(12500);
    expect(snapshot?.primary?.reset_at).toBe(1640000000);
    // ✅ PASS: Partial data handled correctly
  });

  it('should handle partial headers - secondary only', () => {
    // Given: Response with only secondary rate limit headers
    const headers = new Headers({
      'x-browserx-secondary-used-percent': '45.2',
      'x-browserx-secondary-remaining-tokens': '25000',
      'x-browserx-secondary-reset-at': '1640003600',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Returns snapshot with only secondary window
    expect(snapshot).toBeDefined();
    expect(snapshot?.primary).toBeUndefined();
    expect(snapshot?.secondary).toBeDefined();

    // Verify secondary values
    expect(snapshot?.secondary?.used_percent).toBe(45.2);
    expect(snapshot?.secondary?.remaining_tokens).toBe(25000);
    expect(snapshot?.secondary?.reset_at).toBe(1640003600);
  });

  it('should handle both primary and secondary headers', () => {
    // Given: Response with both rate limit windows
    const headers = new Headers({
      'x-browserx-primary-used-percent': '80.0',
      'x-browserx-primary-remaining-tokens': '10000',
      'x-browserx-primary-reset-at': '1640000000',
      'x-browserx-secondary-used-percent': '50.0',
      'x-browserx-secondary-remaining-tokens': '20000',
      'x-browserx-secondary-reset-at': '1640003600',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Returns snapshot with both windows
    expect(snapshot).toBeDefined();
    expect(snapshot?.primary).toBeDefined();
    expect(snapshot?.secondary).toBeDefined();

    // Verify primary
    expect(snapshot?.primary?.used_percent).toBe(80.0);
    expect(snapshot?.primary?.remaining_tokens).toBe(10000);

    // Verify secondary
    expect(snapshot?.secondary?.used_percent).toBe(50.0);
    expect(snapshot?.secondary?.remaining_tokens).toBe(20000);
  });

  it('should handle invalid header values gracefully', () => {
    // Given: Headers with invalid/non-numeric values
    const headers = new Headers({
      'x-browserx-primary-used-percent': 'invalid',
      'x-browserx-primary-remaining-tokens': 'not-a-number',
      'x-browserx-primary-reset-at': 'abc',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Should handle gracefully (either undefined or with NaN values filtered)
    // Implementation may return undefined or skip invalid fields
    if (snapshot?.primary) {
      // If implementation keeps NaN values, they should be NaN
      // This test verifies it doesn't crash
      expect(typeof snapshot.primary.used_percent).toBe('number');
    }
  });

  it('should handle empty string header values', () => {
    // Given: Headers with empty strings
    const headers = new Headers({
      'x-browserx-primary-used-percent': '',
      'x-browserx-primary-remaining-tokens': '',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Should return undefined or handle gracefully
    // Empty strings should not produce valid snapshot
    expect(snapshot).toBeUndefined();
  });

  it('should handle missing individual fields', () => {
    // Given: Incomplete primary window (missing reset_at)
    const headers = new Headers({
      'x-browserx-primary-used-percent': '75.5',
      'x-browserx-primary-remaining-tokens': '12500',
      // Missing: x-browserx-primary-reset-at
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: May still create snapshot with available fields
    // Implementation specific - test that it doesn't crash
    if (snapshot?.primary) {
      expect(snapshot.primary.used_percent).toBe(75.5);
      expect(snapshot.primary.remaining_tokens).toBe(12500);
    }
  });

  it('should match quickstart edge case 3 example', () => {
    // Quickstart Edge Case 3 verification

    // Part 1: Missing headers
    {
      // Given: Response without rate limit headers
      const headers = new Headers();
      const snapshot = client.parseRateLimitSnapshot(headers);

      // Then: Returns undefined
      expect(snapshot).toBeUndefined();
      // ✅ PASS: Handles missing headers gracefully
    }

    // Part 2: Partial headers
    {
      // Given: Response with partial headers (only primary)
      const headers = new Headers();
      headers.set('x-browserx-primary-used-percent', '75.5');
      headers.set('x-browserx-primary-remaining-tokens', '12500');
      headers.set('x-browserx-primary-reset-at', '1640000000');

      const partialSnapshot = client.parseRateLimitSnapshot(headers);

      // Then: Returns snapshot with only primary window
      expect(partialSnapshot).toBeDefined();
      expect(partialSnapshot?.primary).toBeDefined();
      expect(partialSnapshot?.secondary).toBeUndefined();
      // ✅ PASS: Partial data handled correctly
    }
  });

  it('should preserve precision for floating point percentages', () => {
    // Given: Headers with precise floating point values
    const headers = new Headers({
      'x-browserx-primary-used-percent': '75.555',
      'x-browserx-primary-remaining-tokens': '12345',
      'x-browserx-primary-reset-at': '1640000000',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Should preserve precision
    expect(snapshot?.primary?.used_percent).toBe(75.555);
    expect(snapshot?.primary?.remaining_tokens).toBe(12345);
  });

  it('should handle zero values correctly', () => {
    // Given: Headers with zero values (valid edge case)
    const headers = new Headers({
      'x-browserx-primary-used-percent': '0',
      'x-browserx-primary-remaining-tokens': '0',
      'x-browserx-primary-reset-at': '1640000000',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Should create snapshot with zero values
    expect(snapshot?.primary).toBeDefined();
    expect(snapshot?.primary?.used_percent).toBe(0);
    expect(snapshot?.primary?.remaining_tokens).toBe(0);
  });

  it('should handle 100% used correctly', () => {
    // Given: Headers showing rate limit fully exhausted
    const headers = new Headers({
      'x-browserx-primary-used-percent': '100.0',
      'x-browserx-primary-remaining-tokens': '0',
      'x-browserx-primary-reset-at': '1640000000',
    });

    // When: Parse rate limit snapshot
    const snapshot = client.parseRateLimitSnapshot(headers);

    // Then: Should create snapshot with 100% used
    expect(snapshot?.primary?.used_percent).toBe(100.0);
    expect(snapshot?.primary?.remaining_tokens).toBe(0);
  });
});
