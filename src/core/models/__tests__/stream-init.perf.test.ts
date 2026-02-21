/**
 * Performance Test: Stream Initialization
 *
 * Validates that stream initialization meets performance targets:
 * - Time to first event < 200ms
 * - Stream creation overhead is minimal
 *
 * Note: This test measures client-side overhead only.
 * Actual API latency will be higher due to network round-trip.
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenAIResponsesClient } from '@/core/models/client/OpenAIResponsesClient';
import type { ModelFamily, ModelProviderInfo, Prompt } from '@/core/models/types/ResponsesAPI';

describe('Stream Initialization Performance', () => {
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
      conversationId: 'test-conv',
      modelFamily,
      provider,
    });
  };

  // Helper to create a mock fetch that returns SSE stream
  const mockFetchWithSSE = (sseData: string, delay: number = 0) => {
    return vi.fn(async () => {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'text/event-stream',
          'x-pi-primary-used-percent': '50.0',
        }),
        body: stream,
      };
    });
  };

  // Sample prompt
  const createPrompt = (): Prompt => ({
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ],
    tools: [],
  });

  describe('Time to First Event', () => {
    it('should emit first event within 200ms (mock network)', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      // Mock fetch with immediate response
      const sseData = 'data: {"type":"response.created","response":{}}\n\ndata: [DONE]\n\n';
      global.fetch = mockFetchWithSSE(sseData, 0) as any;

      const startTime = performance.now();

      const stream = await client.stream(prompt);
      let firstEventTime: number | null = null;

      for await (const event of stream) {
        if (!firstEventTime) {
          firstEventTime = performance.now();
        }
      }

      expect(firstEventTime).not.toBeNull();
      const timeToFirstEvent = firstEventTime! - startTime;

      console.log(`Time to first event: ${timeToFirstEvent.toFixed(2)}ms`);

      // Client-side overhead should be minimal
      expect(timeToFirstEvent).toBeLessThan(200);
    });

    it('should handle simulated network latency (100ms)', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      // Mock fetch with 100ms network delay
      const sseData = 'data: {"type":"response.created","response":{}}\n\ndata: [DONE]\n\n';
      global.fetch = mockFetchWithSSE(sseData, 100) as any;

      const startTime = performance.now();

      const stream = await client.stream(prompt);
      let firstEventTime: number | null = null;

      for await (const event of stream) {
        if (!firstEventTime) {
          firstEventTime = performance.now();
        }
      }

      const timeToFirstEvent = firstEventTime! - startTime;

      console.log(`Time to first event (with 100ms latency): ${timeToFirstEvent.toFixed(2)}ms`);

      // Should be roughly 100ms + client overhead
      expect(timeToFirstEvent).toBeGreaterThanOrEqual(100);
      expect(timeToFirstEvent).toBeLessThan(300); // 100ms latency + 200ms max overhead
    });
  });

  describe('Stream Creation Overhead', () => {
    it('should create stream with minimal overhead', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      const sseData = 'data: {"type":"response.created","response":{}}\n\ndata: [DONE]\n\n';
      global.fetch = mockFetchWithSSE(sseData, 0) as any;

      const startTime = performance.now();
      const stream = await client.stream(prompt);
      const creationTime = performance.now() - startTime;

      console.log(`Stream creation time: ${creationTime.toFixed(2)}ms`);

      // Stream creation itself should be very fast
      expect(creationTime).toBeLessThan(100);

      // Consume stream to prevent hanging
      for await (const _ of stream) {
        // no-op
      }
    });

    it('should create multiple streams efficiently', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      const sseData = 'data: {"type":"response.created","response":{}}\n\ndata: [DONE]\n\n';
      global.fetch = mockFetchWithSSE(sseData, 0) as any;

      const streamCount = 10;
      const startTime = performance.now();

      for (let i = 0; i < streamCount; i++) {
        const stream = await client.stream(prompt);

        // Consume stream
        for await (const _ of stream) {
          // no-op
        }
      }

      const totalTime = performance.now() - startTime;
      const avgTime = totalTime / streamCount;

      console.log(`Created ${streamCount} streams in ${totalTime.toFixed(2)}ms (${avgTime.toFixed(2)}ms avg)`);

      // Each stream should be created quickly
      expect(avgTime).toBeLessThan(200);
    });
  });

  describe('Event Emission Latency', () => {
    it('should emit events with minimal buffering delay', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      // Multiple events to measure inter-event latency
      const sseData =
        'data: {"type":"response.created","response":{}}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"word1 "}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"word2 "}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"word3 "}\n\n' +
        'data: {"type":"response.completed","response":{"id":"resp_123","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n' +
        'data: [DONE]\n\n';

      global.fetch = mockFetchWithSSE(sseData, 0) as any;

      const stream = await client.stream(prompt);
      const eventTimestamps: number[] = [];

      for await (const event of stream) {
        eventTimestamps.push(performance.now());
      }

      // Calculate inter-event delays
      const interEventDelays = [];
      for (let i = 1; i < eventTimestamps.length; i++) {
        interEventDelays.push(eventTimestamps[i] - eventTimestamps[i - 1]);
      }

      console.log(`Inter-event delays: ${interEventDelays.map((d) => d.toFixed(2)).join(', ')}ms`);

      // Events should be emitted rapidly (not buffered)
      interEventDelays.forEach((delay) => {
        expect(delay).toBeLessThan(50); // Very fast since data is already available
      });
    });
  });

  describe('Real-world Scenarios', () => {
    it('should simulate typical response start (Created + first delta)', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      const sseData =
        'data: {"type":"response.created","response":{}}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n' +
        'data: [DONE]\n\n';

      global.fetch = mockFetchWithSSE(sseData, 50) as any; // 50ms "network" delay

      const startTime = performance.now();
      const stream = await client.stream(prompt);

      let createdTime: number | null = null;
      let firstDeltaTime: number | null = null;

      for await (const event of stream) {
        if (event.type === 'Created' && !createdTime) {
          createdTime = performance.now();
        } else if (event.type === 'OutputTextDelta' && !firstDeltaTime) {
          firstDeltaTime = performance.now();
        }
      }

      const timeToCreated = createdTime! - startTime;
      const timeToFirstDelta = firstDeltaTime! - startTime;

      console.log(`Time to Created event: ${timeToCreated.toFixed(2)}ms`);
      console.log(`Time to first delta: ${timeToFirstDelta.toFixed(2)}ms`);

      // Should emit events quickly after network delay
      expect(timeToCreated).toBeLessThan(250); // 50ms network + overhead
      expect(timeToFirstDelta).toBeLessThan(250);
    });

    it('should measure end-to-end completion time', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      // Full response simulation
      const words = Array.from({ length: 50 }, (_, i) => `word${i} `);
      const deltas = words.map((word) => `data: {"type":"response.output_text.delta","delta":"${word}"}\n\n`);

      const sseData =
        'data: {"type":"response.created","response":{}}\n\n' +
        deltas.join('') +
        'data: {"type":"response.completed","response":{"id":"resp_123","usage":{"input_tokens":10,"output_tokens":50,"total_tokens":60}}}\n\n' +
        'data: [DONE]\n\n';

      global.fetch = mockFetchWithSSE(sseData, 100) as any;

      const startTime = performance.now();
      const stream = await client.stream(prompt);

      let eventCount = 0;
      for await (const _ of stream) {
        eventCount++;
      }

      const totalTime = performance.now() - startTime;

      console.log(`Processed ${eventCount} events in ${totalTime.toFixed(2)}ms`);

      // Should complete quickly (network delay + processing)
      expect(totalTime).toBeLessThan(1000);
      expect(eventCount).toBeGreaterThan(0);
    });
  });

  describe('Resource Efficiency', () => {
    it('should not leak resources across multiple stream creations', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      const sseData = 'data: {"type":"response.created","response":{}}\n\ndata: [DONE]\n\n';
      global.fetch = mockFetchWithSSE(sseData, 0) as any;

      const memBefore = (performance as any).memory?.usedJSHeapSize;

      // Create and consume 100 streams
      for (let i = 0; i < 100; i++) {
        const stream = await client.stream(prompt);
        for await (const _ of stream) {
          // no-op
        }
      }

      const memAfter = (performance as any).memory?.usedJSHeapSize;

      // Memory should not grow significantly
      if (memBefore !== undefined && memAfter !== undefined) {
        const memIncrease = memAfter - memBefore;
        console.log(`Memory increase after 100 streams: ${(memIncrease / 1024 / 1024).toFixed(2)} MB`);

        // Should not accumulate significant memory
        expect(memIncrease).toBeLessThan(5 * 1024 * 1024); // < 5MB
      }
    });
  });

  describe('Concurrent Stream Handling', () => {
    it('should handle concurrent stream creations efficiently', async () => {
      const client = createTestClient();
      const prompt = createPrompt();

      const sseData = 'data: {"type":"response.created","response":{}}\n\ndata: [DONE]\n\n';
      global.fetch = mockFetchWithSSE(sseData, 50) as any;

      const concurrentCount = 5;
      const startTime = performance.now();

      // Create streams concurrently
      const streamPromises = Array.from({ length: concurrentCount }, async () => {
        const stream = await client.stream(prompt);
        for await (const _ of stream) {
          // no-op
        }
      });

      await Promise.all(streamPromises);

      const totalTime = performance.now() - startTime;

      console.log(`Processed ${concurrentCount} concurrent streams in ${totalTime.toFixed(2)}ms`);

      // Concurrent streams should complete in parallel (not sequential)
      // Should take roughly same time as 1 stream (50ms network + overhead)
      expect(totalTime).toBeLessThan(500); // Allow some overhead for concurrency
    });
  });
});
