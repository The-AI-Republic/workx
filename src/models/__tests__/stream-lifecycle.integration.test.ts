/**
 * Full Stream Lifecycle Integration Test
 * Reference: quickstart.md Step 4
 *
 * Tests complete flow: create client → stream() → iterate events → complete
 * Uses SSE fixtures to simulate real streaming behavior
 *
 * EXPECTED: Will FAIL until T014+ implementation is complete
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIResponsesClient } from '../OpenAIResponsesClient';
import { ResponseStream } from '../ResponseStream';
import type { Prompt, ModelFamily, ModelProviderInfo } from '../types/ResponsesAPI';
import type { ResponseEvent } from '../types/ResponseEvent';
import {
  SSE_COMPLETE_STREAM,
  SSE_TEXT_DELTA_STREAM,
  SSE_REASONING_STREAM,
  SSE_WEB_SEARCH_STREAM,
  SSE_FAILED_STREAM,
} from './fixtures/sse-events';

describe('Full Stream Lifecycle Integration', () => {
  let client: OpenAIResponsesClient;
  let mockModelFamily: ModelFamily;
  let mockProvider: ModelProviderInfo;

  beforeEach(() => {
    mockModelFamily = {
      family: 'gpt-4',
      base_instructions: 'You are a helpful assistant.',
      supports_reasoning_summaries: false,
      needs_special_apply_patch_instructions: false,
    };

    mockProvider = {
      name: 'openai',
      base_url: 'https://api.openai.com/v1',
      wire_api: 'Responses' as const,
      request_max_retries: 3,
      stream_idle_timeout_ms: 60000,
      requires_openai_auth: true,
    };

    client = new OpenAIResponsesClient(
      {
        apiKey: 'test-api-key',
        conversationId: 'integration-test',
        modelFamily: mockModelFamily,
        provider: mockProvider,
      },
      { maxRetries: 3, baseDelayMs: 100 }
    );
  });

  describe('Basic stream lifecycle matching Rust behavior', () => {
    it('creates client → stream() → iterate events → complete', async () => {
      // Mock fetch to return SSE_COMPLETE_STREAM
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SSE_COMPLETE_STREAM));
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'user',
            content: 'Say hello',
          },
        ],
        tools: [],
      };

      // Create stream
      const stream = await client.stream(prompt);

      // Verify it's a ResponseStream
      expect(stream).toBeInstanceOf(ResponseStream);

      // Collect all events
      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify event sequence matches Rust test fixtures
      expect(events.length).toBeGreaterThan(0);

      // Should have Created event
      const createdEvent = events.find((e) => e.type === 'Created');
      expect(createdEvent).toBeDefined();

      // Should have OutputItemDone events
      const itemDoneEvents = events.filter((e) => e.type === 'OutputItemDone');
      expect(itemDoneEvents.length).toBeGreaterThan(0);

      // Should have Completed event at the end
      const completedEvent = events[events.length - 1];
      expect(completedEvent.type).toBe('Completed');
      expect((completedEvent as any).responseId).toBe('resp_001');
      expect((completedEvent as any).tokenUsage).toBeDefined();
    });

    it('processes text deltas in order', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SSE_TEXT_DELTA_STREAM));
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: ResponseEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      // Filter text deltas
      const textDeltas = events.filter((e) => e.type === 'OutputTextDelta');

      // Should have multiple deltas
      expect(textDeltas.length).toBeGreaterThan(0);

      // Concatenate deltas to get full text
      const fullText = textDeltas.map((e: any) => e.delta).join('');
      expect(fullText).toBe('Hello from quickstart test');
    });
  });

  describe('Token usage in Completed event', () => {
    it('includes token usage with correct field names', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SSE_COMPLETE_STREAM));
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      let completedEvent: ResponseEvent | null = null;

      for await (const event of stream) {
        if (event.type === 'Completed') {
          completedEvent = event;
        }
      }

      expect(completedEvent).not.toBeNull();
      expect((completedEvent as any).tokenUsage).toBeDefined();

      // Verify field names match Rust struct (snake_case preserved)
      const usage = (completedEvent as any).tokenUsage;
      expect(usage.input_tokens).toBeDefined();
      expect(usage.output_tokens).toBeDefined();
      expect(usage.total_tokens).toBeDefined();
      expect(usage.total_tokens).toBe(25);
    });
  });

  describe('Reasoning model support (o1/o3)', () => {
    it('processes reasoning summary and content deltas', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SSE_REASONING_STREAM));
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Solve this problem' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: ResponseEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      // Should have reasoning events
      expect(events.some((e) => e.type === 'ReasoningSummaryPartAdded')).toBe(true);
      expect(events.some((e) => e.type === 'ReasoningSummaryDelta')).toBe(true);
      expect(events.some((e) => e.type === 'ReasoningContentDelta')).toBe(true);

      // Verify reasoning token usage
      const completedEvent = events.find((e) => e.type === 'Completed');
      expect(completedEvent).toBeDefined();
      const usage = (completedEvent as any).tokenUsage;
      expect(usage.reasoning_output_tokens).toBe(15);
    });
  });

  describe('Web search tool call support', () => {
    it('detects and reports web search calls', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SSE_WEB_SEARCH_STREAM));
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Search for something' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: ResponseEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      // Should have WebSearchCallBegin event
      const searchEvent = events.find((e) => e.type === 'WebSearchCallBegin');
      expect(searchEvent).toBeDefined();
      expect((searchEvent as any).callId).toBe('call_search_123');
    });
  });

  describe('Error handling in stream', () => {
    it('throws error when response fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SSE_FAILED_STREAM));
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);

      // Iteration should throw when it encounters response.failed
      await expect(async () => {
        for await (const event of stream) {
          // Should error before completion
        }
      }).rejects.toThrow(/internal server error/i);
    });
  });

  describe('Rate limit headers integration', () => {
    it('yields RateLimits event from headers', async () => {
      const rateLimitHeaders = new Headers({
        'x-browserx-primary-used-percent': '75.5',
        'x-browserx-primary-window-minutes': '60',
        'x-browserx-primary-reset-after-seconds': '1800',
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: rateLimitHeaders,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\n\n')
            );
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"test"}}\n\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: ResponseEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      // Should have RateLimits event if headers present
      const rateLimitEvent = events.find((e) => e.type === 'RateLimits');
      if (rateLimitEvent) {
        const snapshot = (rateLimitEvent as any).snapshot;
        expect(snapshot.primary).toBeDefined();
        expect(snapshot.primary.used_percent).toBe(75.5);
      }
    });
  });

  describe('Event order matches Rust implementation', () => {
    it('maintains correct event sequence', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(SSE_COMPLETE_STREAM));
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const eventTypes: string[] = [];

      for await (const event of stream) {
        eventTypes.push(event.type);
      }

      // First event should be Created (or RateLimits if headers present)
      expect(['Created', 'RateLimits']).toContain(eventTypes[0]);

      // Last event should be Completed
      expect(eventTypes[eventTypes.length - 1]).toBe('Completed');

      // Completed should only appear once and at the end
      const completedIndices = eventTypes
        .map((type, idx) => (type === 'Completed' ? idx : -1))
        .filter((idx) => idx !== -1);
      expect(completedIndices).toHaveLength(1);
      expect(completedIndices[0]).toBe(eventTypes.length - 1);
    });
  });

  describe('Multiple streams in sequence', () => {
    it('handles multiple sequential stream() calls', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\n\n')
            );
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"test"}}\n\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      // First stream
      const stream1 = await client.stream(prompt);
      const events1: ResponseEvent[] = [];
      for await (const event of stream1) {
        events1.push(event);
      }
      expect(events1.length).toBeGreaterThan(0);

      // Second stream
      const stream2 = await client.stream(prompt);
      const events2: ResponseEvent[] = [];
      for await (const event of stream2) {
        events2.push(event);
      }
      expect(events2.length).toBeGreaterThan(0);

      // Both should work independently
      expect(events1.some((e) => e.type === 'Completed')).toBe(true);
      expect(events2.some((e) => e.type === 'Completed')).toBe(true);
    });
  });

  describe('Stream abortion', () => {
    it('supports aborting stream early', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            // Long stream that will be aborted
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\n\n')
            );
            for (let i = 0; i < 100; i++) {
              controller.enqueue(
                new TextEncoder().encode(`data: {"type":"response.output_text.delta","delta":"${i}"}\n\n`)
              );
            }
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"test"}}\n\n')
            );
            controller.close();
          },
        }),
      } as Response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: ResponseEvent[] = [];

      // Iterate but break early
      let count = 0;
      for await (const event of stream) {
        events.push(event);
        count++;
        if (count >= 5) {
          stream.abort();
          break;
        }
      }

      // Should have stopped early
      expect(events.length).toBeLessThan(100);
      expect(stream.isAborted()).toBe(true);
    });
  });
});
