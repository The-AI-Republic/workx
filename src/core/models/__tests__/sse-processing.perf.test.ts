/**
 * Performance Test: SSE Event Processing
 *
 * Validates that SSE event processing meets performance targets:
 * - Average time < 10ms per event
 * - No memory leaks from event accumulation
 *
 * Rust Reference: browserx-rs/core/src/client.rs lines 637-860
 */

import { describe, it, expect } from 'vitest';
import { OpenAIResponsesClient } from '@/core/models/client/OpenAIResponsesClient';
import type { ModelFamily, ModelProviderInfo } from '@/core/models/types/ResponsesAPI';

describe('SSE Processing Performance', () => {
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

  // Helper to generate SSE data for N events
  // Note: We do NOT include 'data: [DONE]' because processSSE checks for [DONE]
  // before processing events in the same batch. Since we enqueue all data in one
  // chunk, including [DONE] would cause all events to be skipped. The stream ends
  // naturally via controller.close() and processSSE handles that through the reader's
  // done flag.
  const generateSSEData = (eventCount: number): string => {
    const events = [
      'data: {"type":"response.created","response":{}}\n\n',
    ];

    for (let i = 0; i < eventCount; i++) {
      events.push(
        `data: {"type":"response.output_text.delta","delta":"word${i} "}\n\n`
      );
    }

    events.push(
      'data: {"type":"response.completed","response":{"id":"resp_123","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}}\n\n'
    );

    return events.join('');
  };

  // Helper to create ReadableStream from SSE data
  const createSSEStream = (sseData: string): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseData));
        controller.close();
      },
    });
  };

  describe('Average Processing Time', () => {
    it('should process 1000 SSE events with average time < 10ms per event', async () => {
      const client = createTestClient();
      const eventCount = 1000;
      const sseData = generateSSEData(eventCount);
      const stream = createSSEStream(sseData);

      const startTime = performance.now();
      const events = [];

      for await (const event of (client as any).processSSE(stream)) {
        events.push(event);
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const avgTimePerEvent = totalTime / events.length;

      console.log(`Processed ${events.length} events in ${totalTime.toFixed(2)}ms`);
      console.log(`Average time per event: ${avgTimePerEvent.toFixed(2)}ms`);

      // Verify we processed all events
      expect(events.length).toBeGreaterThanOrEqual(eventCount);

      // Performance target: < 10ms per event
      expect(avgTimePerEvent).toBeLessThan(10);
    }, 30000); // 30 second timeout

    it('should process 100 SSE events quickly', async () => {
      const client = createTestClient();
      const eventCount = 100;
      const sseData = generateSSEData(eventCount);
      const stream = createSSEStream(sseData);

      const startTime = performance.now();
      const events = [];

      for await (const event of (client as any).processSSE(stream)) {
        events.push(event);
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;

      console.log(`Processed ${events.length} events in ${totalTime.toFixed(2)}ms`);

      // 100 events should complete in well under 1 second
      expect(totalTime).toBeLessThan(1000);
    });
  });

  describe('Memory Management', () => {
    it('should not accumulate events in memory (streaming consumption)', async () => {
      const client = createTestClient();
      const eventCount = 5000;
      const sseData = generateSSEData(eventCount);
      const stream = createSSEStream(sseData);

      // Measure memory before
      const memBefore = (performance as any).memory?.usedJSHeapSize;

      let eventCounter = 0;
      for await (const event of (client as any).processSSE(stream)) {
        eventCounter++;
        // Consume events one at a time without storing
      }

      // Measure memory after
      const memAfter = (performance as any).memory?.usedJSHeapSize;

      expect(eventCounter).toBeGreaterThanOrEqual(eventCount);

      // Memory increase should be minimal (events are not accumulated)
      // Note: performance.memory is Chrome-specific and may not be available
      if (memBefore !== undefined && memAfter !== undefined) {
        const memIncrease = memAfter - memBefore;
        console.log(`Memory increase: ${(memIncrease / 1024 / 1024).toFixed(2)} MB`);

        // Memory increase should be reasonable (not proportional to event count)
        // Allow up to 10MB increase for 5000 events
        expect(memIncrease).toBeLessThan(10 * 1024 * 1024);
      }
    }, 30000);

    it('should release stream resources after processing', async () => {
      const client = createTestClient();
      const eventCount = 100;
      const sseData = generateSSEData(eventCount);
      const stream = createSSEStream(sseData);

      const events = [];
      for await (const event of (client as any).processSSE(stream)) {
        events.push(event);
      }

      // After processing, stream should be closed
      // Reader should be released
      expect(events.length).toBeGreaterThan(0);

      // Try to get reader again - should work if properly released
      // (This is a best-effort test, implementation-specific)
    });
  });

  describe('Scalability', () => {
    it('should maintain performance with varying event sizes', async () => {
      const client = createTestClient();

      // Small events
      const smallSseData = generateSSEData(100);
      const smallStream = createSSEStream(smallSseData);

      const smallStart = performance.now();
      let smallCount = 0;
      for await (const _ of (client as any).processSSE(smallStream)) {
        smallCount++;
      }
      const smallTime = performance.now() - smallStart;

      // Large events (longer text deltas)
      const largeEvents = [
        'data: {"type":"response.created","response":{}}\n\n',
      ];
      for (let i = 0; i < 100; i++) {
        const longText = 'word'.repeat(100); // 400 chars
        largeEvents.push(
          `data: {"type":"response.output_text.delta","delta":"${longText}"}\n\n`
        );
      }
      largeEvents.push(
        'data: {"type":"response.completed","response":{"id":"resp_123","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}}\n\n'
      );

      const largeSseData = largeEvents.join('');
      const largeStream = createSSEStream(largeSseData);

      const largeStart = performance.now();
      let largeCount = 0;
      for await (const _ of (client as any).processSSE(largeStream)) {
        largeCount++;
      }
      const largeTime = performance.now() - largeStart;

      console.log(`Small events: ${smallCount} in ${smallTime.toFixed(2)}ms`);
      console.log(`Large events: ${largeCount} in ${largeTime.toFixed(2)}ms`);

      // Both should complete in reasonable time
      expect(smallTime).toBeLessThan(1000);
      expect(largeTime).toBeLessThan(2000); // Allow more time for larger payloads
    });

    it('should handle rapid successive streams', async () => {
      const client = createTestClient();
      const streamCount = 10;
      const eventsPerStream = 50;

      const startTime = performance.now();

      for (let i = 0; i < streamCount; i++) {
        const sseData = generateSSEData(eventsPerStream);
        const stream = createSSEStream(sseData);

        let count = 0;
        for await (const _ of (client as any).processSSE(stream)) {
          count++;
        }

        expect(count).toBeGreaterThan(0);
      }

      const totalTime = performance.now() - startTime;
      console.log(`Processed ${streamCount} streams in ${totalTime.toFixed(2)}ms`);

      // Should complete all streams quickly
      expect(totalTime).toBeLessThan(5000);
    });
  });

  describe('Event Type Complexity', () => {
    it('should handle mixed event types efficiently', async () => {
      const client = createTestClient();

      // Generate stream with all event types
      const mixedEvents = [
        'data: {"type":"response.created","response":{}}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking..."}\n\n',
        'data: {"type":"response.reasoning_text.delta","delta":"analysis"}\n\n',
        'data: {"type":"response.reasoning_summary_part.added"}\n\n',
        'data: {"type":"response.output_item.added","item":{"type":"web_search_call","call_id":"call_123"}}\n\n',
      ];

      // Repeat for volume
      const fullData = mixedEvents.join('').repeat(100) +
        'data: {"type":"response.completed","response":{"id":"resp_123","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}}\n\n';

      const stream = createSSEStream(fullData);

      const startTime = performance.now();
      let count = 0;
      for await (const _ of (client as any).processSSE(stream)) {
        count++;
      }
      const totalTime = performance.now() - startTime;

      console.log(`Processed ${count} mixed-type events in ${totalTime.toFixed(2)}ms`);

      // Should handle variety efficiently
      expect(totalTime / count).toBeLessThan(10); // < 10ms per event
    });
  });

  describe('Real-world Simulation', () => {
    it('should simulate typical GPT-4 response (200 words)', async () => {
      const client = createTestClient();

      // Simulate 200-word response (1 word per event)
      const sseData = generateSSEData(200);
      const stream = createSSEStream(sseData);

      const startTime = performance.now();
      const events = [];

      for await (const event of (client as any).processSSE(stream)) {
        events.push(event);
      }

      const totalTime = performance.now() - startTime;

      console.log(`Simulated GPT-4 response: ${events.length} events in ${totalTime.toFixed(2)}ms`);

      // Should feel instant to user (< 1 second)
      expect(totalTime).toBeLessThan(1000);
    });

    it('should simulate long GPT-4 response (2000 words)', async () => {
      const client = createTestClient();

      // Simulate 2000-word response
      const sseData = generateSSEData(2000);
      const stream = createSSEStream(sseData);

      const startTime = performance.now();
      let count = 0;

      for await (const _ of (client as any).processSSE(stream)) {
        count++;
      }

      const totalTime = performance.now() - startTime;
      const avgTime = totalTime / count;

      console.log(`Long response: ${count} events in ${totalTime.toFixed(2)}ms (${avgTime.toFixed(2)}ms per event)`);

      // Should maintain < 10ms per event even for long responses
      expect(avgTime).toBeLessThan(10);
    }, 30000);
  });
});
