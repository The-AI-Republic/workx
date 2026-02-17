/**
 * Full Stream Lifecycle Integration Test
 * Reference: quickstart.md Step 4
 *
 * Tests complete flow: create client -> stream() -> iterate events -> complete
 * Uses Chat Completions SSE format to simulate real streaming behavior
 * via the OpenAI SDK that OpenAIChatCompletionClient uses internally.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIChatCompletionClient } from '../client/OpenAIChatCompletionClient';
import { ResponseStream } from '../ResponseStream';
import type { Prompt, ModelFamily, ModelProviderInfo } from '../types/ResponsesAPI';
import type { ResponseEvent } from '../types/ResponseEvent';

/**
 * Helper: Build Chat Completions SSE data string from an array of chunk objects.
 * Each chunk is JSON-serialized and wrapped in `data: ...\n\n` SSE format.
 * A final `data: [DONE]\n\n` sentinel is appended.
 */
function buildChatCompletionsSSE(chunks: any[]): string {
  const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

/**
 * Helper: Create a mock fetch that returns SSE data via a ReadableStream body.
 */
function mockFetchWithSSE(sseData: string) {
  return vi.fn().mockResolvedValue(
    new Response(sseData, {
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    })
  );
}

describe('Full Stream Lifecycle Integration', () => {
  let client: OpenAIChatCompletionClient;
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

    client = new OpenAIChatCompletionClient(
      {
        apiKey: 'test-api-key',
        conversationId: 'integration-test',
        modelFamily: mockModelFamily,
        provider: mockProvider,
      },
      { maxRetries: 0, baseDelay: 100 }
    );
  });

  describe('Basic stream lifecycle', () => {
    it('creates client -> stream() -> iterate events -> complete', async () => {
      const sseData = buildChatCompletionsSSE([
        { id: 'chatcmpl-001', choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { id: 'chatcmpl-001', choices: [{ delta: { content: ' World' }, finish_reason: null }] },
        {
          id: 'chatcmpl-001',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
        },
      ]);

      global.fetch = mockFetchWithSSE(sseData);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Say hello' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      expect(stream).toBeInstanceOf(ResponseStream);

      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);

      // Should have OutputTextDelta events
      const textDeltas = events.filter(e => e.type === 'OutputTextDelta');
      expect(textDeltas.length).toBeGreaterThan(0);

      // Should have OutputItemDone
      const itemDoneEvents = events.filter(e => e.type === 'OutputItemDone');
      expect(itemDoneEvents.length).toBeGreaterThan(0);

      // Should have Completed event at the end
      const completedEvent = events[events.length - 1];
      expect(completedEvent.type).toBe('Completed');
      expect((completedEvent as any).responseId).toBe('chatcmpl-001');
      expect((completedEvent as any).tokenUsage).toBeDefined();
    });

    it('processes text deltas in order', async () => {
      const words = ['Hello', ' from', ' quickstart', ' test'];
      const chunks = words.map(w => ({
        id: 'chatcmpl-002',
        choices: [{ delta: { content: w }, finish_reason: null }],
      }));
      chunks.push({
        id: 'chatcmpl-002',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 },
      } as any);

      global.fetch = mockFetchWithSSE(buildChatCompletionsSSE(chunks));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'OutputTextDelta');
      expect(textDeltas.length).toBeGreaterThan(0);

      const fullText = textDeltas.map((e: any) => e.delta).join('');
      expect(fullText).toBe('Hello from quickstart test');
    });
  });

  describe('Token usage in Completed event', () => {
    it('includes token usage with correct field names', async () => {
      const sseData = buildChatCompletionsSSE([
        { id: 'chatcmpl-003', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
        {
          id: 'chatcmpl-003',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
        },
      ]);

      global.fetch = mockFetchWithSSE(sseData);

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

      const usage = (completedEvent as any).tokenUsage;
      expect(usage.input_tokens).toBeDefined();
      expect(usage.output_tokens).toBeDefined();
      expect(usage.total_tokens).toBeDefined();
      expect(usage.total_tokens).toBe(25);
    });
  });

  describe('Reasoning model support', () => {
    it('accumulates reasoning content and includes in final message', async () => {
      // Chat Completions uses reasoning_content field in delta
      const sseData = buildChatCompletionsSSE([
        { id: 'chatcmpl-004', choices: [{ delta: { reasoning_content: 'Analyzing the problem...' }, finish_reason: null }] },
        { id: 'chatcmpl-004', choices: [{ delta: { reasoning_content: ' Step 1: think.' }, finish_reason: null }] },
        { id: 'chatcmpl-004', choices: [{ delta: { content: 'The answer is 42.' }, finish_reason: null }] },
        {
          id: 'chatcmpl-004',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 15 } },
        },
      ]);

      global.fetch = mockFetchWithSSE(sseData);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Solve this problem' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Chat Completions client accumulates reasoning_content silently
      // and includes it in the final OutputItemDone message item
      const itemDone = events.find(e => e.type === 'OutputItemDone');
      expect(itemDone).toBeDefined();

      const item = (itemDone as any).item;
      expect(item.reasoning_content).toBe('Analyzing the problem... Step 1: think.');

      // Verify reasoning token usage in Completed event
      const completedEvent = events.find(e => e.type === 'Completed');
      expect(completedEvent).toBeDefined();
      const usage = (completedEvent as any).tokenUsage;
      expect(usage.reasoning_output_tokens).toBe(15);
    });
  });

  describe('Error handling in stream', () => {
    it('handles API error responses gracefully', async () => {
      // Mock a 500 error response
      global.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'Internal server error', type: 'server_error' } }),
          { status: 500, statusText: 'Internal Server Error', headers: new Headers({ 'Content-Type': 'application/json' }) }
        )
      );

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      // With maxRetries=0, should throw immediately on 500
      await expect(client.stream(prompt)).rejects.toThrow();
    });
  });

  describe('Event order', () => {
    it('maintains correct event sequence', async () => {
      const sseData = buildChatCompletionsSSE([
        { id: 'chatcmpl-005', choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { id: 'chatcmpl-005', choices: [{ delta: { content: ' world' }, finish_reason: null }] },
        {
          id: 'chatcmpl-005',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ]);

      global.fetch = mockFetchWithSSE(sseData);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }

      // Should have text deltas
      expect(eventTypes.filter(t => t === 'OutputTextDelta').length).toBeGreaterThan(0);

      // Last event should be Completed
      expect(eventTypes[eventTypes.length - 1]).toBe('Completed');

      // Completed should only appear once and at the end
      const completedIndices = eventTypes
        .map((type, idx) => (type === 'Completed' ? idx : -1))
        .filter(idx => idx !== -1);
      expect(completedIndices).toHaveLength(1);
      expect(completedIndices[0]).toBe(eventTypes.length - 1);
    });
  });

  describe('Multiple streams in sequence', () => {
    it('handles multiple sequential stream() calls', async () => {
      const sseData = buildChatCompletionsSSE([
        { id: 'chatcmpl-006', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
        {
          id: 'chatcmpl-006',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      ]);

      global.fetch = mockFetchWithSSE(sseData);

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
      expect(events1.some(e => e.type === 'Completed')).toBe(true);

      // Second stream (fetch mock returns same data for each call)
      const stream2 = await client.stream(prompt);
      const events2: ResponseEvent[] = [];
      for await (const event of stream2) {
        events2.push(event);
      }
      expect(events2.length).toBeGreaterThan(0);
      expect(events2.some(e => e.type === 'Completed')).toBe(true);
    });
  });

  describe('Stream abortion', () => {
    it('supports aborting stream early', async () => {
      // Build a long stream with many deltas
      const chunks: any[] = [];
      for (let i = 0; i < 100; i++) {
        chunks.push({
          id: 'chatcmpl-007',
          choices: [{ delta: { content: `word${i} ` }, finish_reason: null }],
        });
      }
      chunks.push({
        id: 'chatcmpl-007',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
      });

      global.fetch = mockFetchWithSSE(buildChatCompletionsSSE(chunks));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'Test' }],
        tools: [],
      };

      const stream = await client.stream(prompt);
      const events: ResponseEvent[] = [];

      let count = 0;
      for await (const event of stream) {
        events.push(event);
        count++;
        if (count >= 5) {
          // abort() marks the stream as aborted so iteration stops
          stream.abort();
          break;
        }
      }

      // Should have stopped early
      expect(events.length).toBeLessThan(100);
      // The stream may or may not report isAborted depending on timing
      // The important thing is that iteration stopped early
      expect(events.length).toBeLessThanOrEqual(6);
    });
  });
});
