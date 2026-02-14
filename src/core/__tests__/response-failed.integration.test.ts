/**
 * Edge Case Test: response.failed SSE Event
 *
 * Tests that response.failed events are parsed and thrown correctly
 *
 * **Quickstart Reference**: Edge Case 4
 * **Rust Reference**: browserx-rs/core/src/client.rs Lines 785-808 (response.failed handling)
 * **Functional Requirement**: FR-012 (parse error.message from response.failed)
 */

import { describe, it, expect } from 'vitest';
import { OpenAIResponsesClient } from '@/models/client/OpenAIResponsesClient';
import { ModelClientError } from '@/models/ModelClient';
import type { ModelFamily, ModelProviderInfo } from '@/models/types';

describe('Edge Case: response.failed SSE Event', () => {
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

  it('should throw error when response.failed event received', async () => {
    // Given: SSE stream with response.failed event
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Send response.failed event
        const failedEvent =
          'data: {"type":"response.failed","response":{"error":{"message":"Internal error","code":"internal_error"}}}\n\n';
        controller.enqueue(encoder.encode(failedEvent));
        controller.close();
      },
    });

    // When: Processing SSE
    try {
      const events = [];
      for await (const event of client.processSSE(failedStream)) {
        events.push(event);
      }
      expect.fail('Should have thrown error');
    } catch (error) {
      // Then: Throws with error message
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Internal error');
      // ✅ PASS: response.failed handled correctly (FR-012)
    }
  });

  it('should parse error code from response.failed', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const failedEvent =
          'data: {"type":"response.failed","response":{"error":{"message":"Rate limit exceeded","code":"rate_limit_error"}}}\n\n';
        controller.enqueue(encoder.encode(failedEvent));
        controller.close();
      },
    });

    try {
      for await (const event of client.processSSE(failedStream)) {
        // Should not yield events
      }
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Rate limit exceeded');
    }
  });

  it('should handle response.failed with minimal error info', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Minimal error without code
        const failedEvent =
          'data: {"type":"response.failed","response":{"error":{"message":"Unknown error"}}}\n\n';
        controller.enqueue(encoder.encode(failedEvent));
        controller.close();
      },
    });

    try {
      for await (const event of client.processSSE(failedStream)) {
        // Should not yield events
      }
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Unknown error');
    }
  });

  it('should not yield events after response.failed', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Send a normal event first
        controller.enqueue(
          encoder.encode('data: {"type":"response.created","response":{"id":"resp-1"}}\n\n')
        );

        // Then send failed event
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.failed","response":{"error":{"message":"Processing failed"}}}\n\n'
          )
        );

        // Should not process events after this
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"Should not appear"}\n\n'
          )
        );

        controller.close();
      },
    });

    const events = [];
    try {
      for await (const event of client.processSSE(failedStream)) {
        events.push(event);
      }
      expect.fail('Should have thrown');
    } catch (error) {
      // Should have received Created event before error
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('Created');

      // Error should be about the failure
      expect((error as Error).message).toContain('Processing failed');
    }
  });

  it('should match quickstart edge case 4 example', async () => {
    // Quickstart Edge Case 4 verification

    // Given: SSE stream with response.failed event
    const failedData = `data: {"type":"response.failed","response":{"error":{"message":"Internal error","code":"internal_error"}}}\n\n`;

    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(failedData));
        controller.close();
      },
    });

    // When: Processing SSE
    try {
      for await (const event of client.processSSE(failedStream)) {
        // Should not yield events
      }
      expect.fail('Should have thrown');
    } catch (error) {
      // Then: Throws with error message
      expect((error as Error).message).toContain('Internal error');
      // ✅ PASS: response.failed handled correctly (FR-012)
    }
  });

  it('should handle response.failed with nested error details', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const failedEvent =
          'data: {"type":"response.failed","response":{"error":{"message":"Content filter triggered","code":"content_filter","details":{"reason":"unsafe_content"}}}}\n\n';
        controller.enqueue(encoder.encode(failedEvent));
        controller.close();
      },
    });

    try {
      for await (const event of client.processSSE(failedStream)) {
        // Should not yield events
      }
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Content filter triggered');
    }
  });

  it('should handle malformed response.failed event', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Malformed: missing error message
        const failedEvent = 'data: {"type":"response.failed","response":{}}\n\n';
        controller.enqueue(encoder.encode(failedEvent));
        controller.close();
      },
    });

    try {
      for await (const event of client.processSSE(failedStream)) {
        // Should not yield events
      }
      expect.fail('Should have thrown or handled gracefully');
    } catch (error) {
      // Should throw some error (implementation specific)
      expect(error).toBeDefined();
    }
  });

  it('should handle response.failed immediately without buffering', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Send failed event immediately
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.failed","response":{"error":{"message":"Immediate failure"}}}\n\n'
          )
        );
        controller.close();
      },
    });

    const startTime = Date.now();

    try {
      for await (const event of client.processSSE(failedStream)) {
        // Should not yield events
      }
      expect.fail('Should have thrown');
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should fail quickly (< 100ms), not wait for buffering
      expect(duration).toBeLessThan(100);
      expect((error as Error).message).toContain('Immediate failure');
    }
  });

  it('should preserve error type information when available', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const failedEvent =
          'data: {"type":"response.failed","response":{"error":{"message":"Model overloaded","code":"overloaded_error","type":"server_error"}}}\n\n';
        controller.enqueue(encoder.encode(failedEvent));
        controller.close();
      },
    });

    try {
      for await (const event of client.processSSE(failedStream)) {
        // Should not yield events
      }
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Model overloaded');
    }
  });

  it('should handle response.failed after RateLimits event', async () => {
    const failedStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // This test assumes rate limits are sent first in headers, not as events
        // But we can test that failed still works after other events

        controller.enqueue(
          encoder.encode('data: {"type":"response.created","response":{"id":"resp-1"}}\n\n')
        );

        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.failed","response":{"error":{"message":"Failed after creation"}}}\n\n'
          )
        );

        controller.close();
      },
    });

    const events = [];
    try {
      for await (const event of client.processSSE(failedStream)) {
        events.push(event);
      }
      expect.fail('Should have thrown');
    } catch (error) {
      // Should have received Created before failure
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect((error as Error).message).toContain('Failed after creation');
    }
  });
});
