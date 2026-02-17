/**
 * Comprehensive tests for OpenAIChatCompletionClient
 */

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { OpenAIChatCompletionClient, type OpenAIChatCompletionConfig } from '../client/OpenAIChatCompletionClient';
import { ModelClientError } from '../ModelClient';
import type {
  Prompt,
  ResponseEvent,
  ModelFamily,
  ModelProviderInfo,
} from '../types/ResponsesAPI';
import type { ResponseItem } from '../../../protocol/types';

// Mock OpenAI client to avoid browser safety check in tests
vi.mock('openai', () => {
  const mockOpenAI = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  }));

  return {
    default: mockOpenAI,
    OpenAI: mockOpenAI,
  };
});

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OpenAIChatCompletionClient', () => {
  let client: OpenAIChatCompletionClient;
  let config: OpenAIChatCompletionConfig;

  const mockModelFamily: ModelFamily = {
    family: 'gpt-4o',
    base_instructions: 'You are a helpful assistant.',
    supports_reasoning_summaries: true,
    needs_special_apply_patch_instructions: false,
  };

  const mockProvider: ModelProviderInfo = {
    name: 'openai',
    base_url: 'https://api.openai.com/v1',
    wire_api: 'Responses',
    requires_openai_auth: true,
    request_max_retries: 3,
    stream_max_retries: 2,
    stream_idle_timeout_ms: 30000,
  };

  beforeEach(() => {
    config = {
      apiKey: 'test-api-key',
      conversationId: 'conv-123',
      modelFamily: mockModelFamily,
      provider: mockProvider,
    };
    client = new OpenAIChatCompletionClient(config);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Constructor', () => {
    it('should create client with valid config', () => {
      expect(client.getProvider()).toBe('openai');
      expect(client.getModel()).toBe('gpt-4o');
    });

    it('should throw error with empty API key', () => {
      expect(() => new OpenAIChatCompletionClient({ ...config, apiKey: '' })).toThrow(
        'LLM API key is required'
      );
    });

    it('should use default base URL when not provided', () => {
      const clientWithDefaults = new OpenAIChatCompletionClient(config);
      expect(clientWithDefaults.getProvider()).toBe('openai');
    });

    it('should accept custom base URL', () => {
      const customConfig = { ...config, baseUrl: 'https://custom.api.com/v1' };
      const customClient = new OpenAIChatCompletionClient(customConfig);
      expect(customClient.getProvider()).toBe('openai');
    });
  });

  describe('Basic Model Client Methods', () => {
    it('should get and set model correctly', () => {
      expect(client.getModel()).toBe('gpt-4o');
      client.setModel('gpt-4-turbo');
      expect(client.getModel()).toBe('gpt-4-turbo');
    });

    it('should return context window for known models', () => {
      client.setModel('gpt-4o');
      expect(client.getContextWindow()).toBe(128000);

      client.setModel('gpt-4');
      expect(client.getContextWindow()).toBe(8192);

      client.setModel('unknown-model');
      expect(client.getContextWindow()).toBeUndefined();
    });

    it('should get and set reasoning effort', () => {
      expect(client.getReasoningEffort()).toBeUndefined();
      client.setReasoningEffort('high');
      expect(client.getReasoningEffort()).toBe('high');
    });

    it('should get and set reasoning summary', () => {
      expect(client.getReasoningSummary()).toBeUndefined();
      client.setReasoningSummary(true);
      expect(client.getReasoningSummary()).toBe(true);
    });

    it('should count tokens approximately', () => {
      const text = 'Hello world, how are you today?';
      const tokenCount = client.countTokens(text, 'gpt-4o');
      expect(tokenCount).toBeGreaterThan(0);
      expect(typeof tokenCount).toBe('number');
    });

    it('should throw error for direct completion', async () => {
      const request = {
        model: 'gpt-4o',
        messages: [{ role: 'user' as const, content: 'Hello' }],
      };

      await expect(client.complete(request)).rejects.toThrow(
        'Direct completion not supported by Responses API'
      );
    });

    it('should support streaming with Prompt format', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      // Mock fetch to simulate SSE response
      global.fetch = vi.fn().mockResolvedValueOnce({
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

      const stream = await client.stream(prompt);
      expect(stream).toBeDefined();

      // Stream should be a ResponseStream
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Should have at least a Created event
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('Request Payload Construction', () => {
    it('should construct valid Responses API request', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Hello world' }],
          },
        ],
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            parameters: { type: 'object' },
          },
        ],
      };

      // Mock the fetch to capture the request
      mockFetch.mockResolvedValue(new Response('', { status: 500 })); // Will fail but we can inspect the call

      try {
        const generator = client.streamResponses(prompt);
        await generator.next();
      } catch (error) {
        // Expected to fail, we just want to inspect the call
      }

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/responses',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-api-key',
            'OpenAI-Beta': 'responses=experimental',
            'conversation_id': 'conv-123',
            'session_id': 'conv-123',
            'Accept': 'text/event-stream',
          }),
          body: expect.stringContaining('"model":"gpt-4o"'),
        })
      );

      // Parse the body to verify payload structure
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body).toMatchObject({
        model: 'gpt-4o',
        instructions: expect.any(String),
        input: expect.arrayContaining([
          expect.objectContaining({
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Hello world' }],
          }),
        ]),
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({
              name: 'test_tool',
              description: 'A test tool',
            }),
          }),
        ]),
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        stream: true,
        include: [],
        prompt_cache_key: 'conv-123',
      });
    });

    it('should include reasoning when supported', async () => {
      const reasoningClient = new OpenAIChatCompletionClient({
        ...config,
        reasoningEffort: 'high',
        reasoningSummary: true,
      });

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Test' }] }],
        tools: [],
      };

      mockFetch.mockResolvedValue(new Response('', { status: 500 }));

      try {
        const generator = reasoningClient.streamResponses(prompt);
        await generator.next();
      } catch (error) {
        // Expected
      }

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.reasoning).toEqual({
        effort: 'high',
        summary: true,
      });
      expect(body.include).toContain('reasoning.encrypted_content');
    });

    it('should include text controls for GPT-5', async () => {
      const gpt5Client = new OpenAIChatCompletionClient({
        ...config,
        modelFamily: { ...mockModelFamily, family: 'gpt-5' },
        modelVerbosity: 'high',
      });

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Test' }] }],
        tools: [],
        output_schema: { type: 'object', properties: { answer: { type: 'string' } } },
      };

      mockFetch.mockResolvedValue(new Response('', { status: 500 }));

      try {
        const generator = gpt5Client.streamResponses(prompt);
        await generator.next();
      } catch (error) {
        // Expected
      }

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.text).toEqual({
        verbosity: 'high',
        format: {
          type: 'json_schema',
          strict: true,
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
          name: 'pi_output_schema',
        },
      });
    });
  });

  describe('SSE Stream Processing', () => {
    const createMockSSEResponse = (events: string[]) => {
      const sseData = events.join('\n\n') + '\n\n';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'x-pi-primary-used-percent': '25.5',
          'x-pi-primary-window-minutes': '60',
        },
      });
    };

    it('should parse response.created events', async () => {
      const events = [
        'event: response.created',
        'data: {"type":"response.created","response":{}}',
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      expect(results).toContainEqual({ type: 'Created' });
    });

    it('should parse output_item.done events', async () => {
      const events = [
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_123"}}',
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      const outputEvent = results.find(e => e.type === 'OutputItemDone');
      expect(outputEvent).toBeTruthy();
      if (outputEvent && 'item' in outputEvent) {
        expect(outputEvent.item).toMatchObject({
          type: 'message',
          role: 'assistant',
        });
      }

      const completedEvent = results.find(e => e.type === 'Completed');
      expect(completedEvent).toBeTruthy();
      if (completedEvent && 'responseId' in completedEvent) {
        expect(completedEvent.responseId).toBe('resp_123');
      }
    });

    it('should parse text delta events', async () => {
      const events = [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":" world"}',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_123"}}',
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      const deltaEvents = results.filter(e => e.type === 'OutputTextDelta');
      expect(deltaEvents).toHaveLength(2);
      expect(deltaEvents[0]).toEqual({ type: 'OutputTextDelta', delta: 'Hello' });
      expect(deltaEvents[1]).toEqual({ type: 'OutputTextDelta', delta: ' world' });
    });

    it('should parse reasoning events', async () => {
      const events = [
        'event: response.reasoning_text.delta',
        'data: {"type":"response.reasoning_text.delta","delta":"Thinking..."}',
        'event: response.reasoning_summary_text.delta',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"Summary"}',
        'event: response.reasoning_summary_part.added',
        'data: {"type":"response.reasoning_summary_part.added"}',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_123"}}',
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      expect(results).toContainEqual({ type: 'ReasoningContentDelta', delta: 'Thinking...' });
      expect(results).toContainEqual({ type: 'ReasoningSummaryDelta', delta: 'Summary' });
      expect(results).toContainEqual({ type: 'ReasoningSummaryPartAdded' });
    });

    it('should parse web search events', async () => {
      const events = [
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"search_123"}}',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_123"}}',
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      expect(results).toContainEqual({ type: 'WebSearchCallBegin', callId: 'search_123' });
    });

    it('should parse rate limit headers', async () => {
      const events = [
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_123"}}',
      ];

      const response = new Response(
        new ReadableStream({
          start(controller) {
            const sseData = events.join('\n\n') + '\n\n';
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'x-pi-primary-used-percent': '75.5',
            'x-pi-primary-window-minutes': '60',
            'x-pi-primary-reset-after-seconds': '3600',
            'x-pi-secondary-used-percent': '25.0',
            'x-pi-secondary-window-minutes': '1440',
          },
        }
      );

      mockFetch.mockResolvedValue(response);

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      const rateLimitEvent = results.find(e => e.type === 'RateLimits');
      expect(rateLimitEvent).toBeTruthy();
      if (rateLimitEvent && 'snapshot' in rateLimitEvent) {
        expect(rateLimitEvent.snapshot.primary).toEqual({
          used_percent: 75.5,
          window_minutes: 60,
          resets_in_seconds: 3600,
        });
        expect(rateLimitEvent.snapshot.secondary).toEqual({
          used_percent: 25.0,
          window_minutes: 1440,
          resets_in_seconds: null,
        });
      }
    });

    it('should handle malformed SSE events gracefully', async () => {
      const events = [
        'event: response.output_text.delta',
        'data: {"invalid":"json"missing quote}',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_123"}}',
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      // Should continue processing after malformed event
      expect(results).toContainEqual({ type: 'OutputTextDelta', delta: 'Hello' });
      expect(results.some(e => e.type === 'Completed')).toBe(true);
    });

    it('should handle response.failed events', async () => {
      const events = [
        'event: response.failed',
        'data: {"type":"response.failed","response":{"error":{"message":"Rate limit exceeded"}}}',
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);

      await expect(async () => {
        for await (const event of generator) {
          // Should throw on failed event
        }
      }).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('Error Handling', () => {
    it('should handle authentication errors', async () => {
      mockFetch.mockResolvedValue(
        new Response('{"error":{"message":"Invalid API key"}}', {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);

      await expect(async () => {
        for await (const event of generator) {
          // Should throw immediately
        }
      }).rejects.toThrow('Authentication failed - check API key');
    });

    it('should handle rate limiting with retry', async () => {
      // First call returns rate limit, second succeeds
      mockFetch
        .mockResolvedValueOnce(
          new Response('{"error":{"message":"Rate limited"}}', {
            status: 429,
            headers: { 'retry-after': '1' },
          })
        )
        .mockResolvedValueOnce(
          createMockSSEResponse([
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_123"}}',
          ])
        );

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      expect(mockFetch).toHaveBeenCalledTimes(2); // Initial + retry
      expect(results.some(e => e.type === 'Completed')).toBe(true);
    });

    it('should handle server errors with retry', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('Internal server error', { status: 500 }))
        .mockResolvedValueOnce(
          createMockSSEResponse([
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_123"}}',
          ])
        );

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(results.some(e => e.type === 'Completed')).toBe(true);
    });

    it('should fail after max retries', async () => {
      mockFetch.mockResolvedValue(new Response('Server error', { status: 500 }));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);

      await expect(async () => {
        for await (const event of generator) {
          // Should throw after retries
        }
      }).rejects.toThrow();

      expect(mockFetch).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);

      await expect(async () => {
        for await (const event of generator) {
          // Should throw
        }
      }).rejects.toThrow('Network error');
    });

    it('should handle missing response.completed', async () => {
      const events = [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        // Missing response.completed
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);

      await expect(async () => {
        for await (const event of generator) {
          // Should throw when stream closes without completion
        }
      }).rejects.toThrow('Stream closed before response.completed');
    });
  });

  describe('Header Handling', () => {
    it('should include organization header when provided', async () => {
      const clientWithOrg = new OpenAIChatCompletionClient({
        ...config,
        organization: 'org-123',
      });

      mockFetch.mockResolvedValue(new Response('', { status: 500 }));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      try {
        const generator = clientWithOrg.streamResponses(prompt);
        await generator.next();
      } catch (error) {
        // Expected
      }

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'OpenAI-Organization': 'org-123',
          }),
        })
      );
    });

    it('should not include organization header when not provided', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 500 }));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      try {
        const generator = client.streamResponses(prompt);
        await generator.next();
      } catch (error) {
        // Expected
      }

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers).not.toHaveProperty('OpenAI-Organization');
    });
  });

  describe('Token Usage Conversion', () => {
    it('should convert API usage format correctly', async () => {
      const events = [
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_123","usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":10},"output_tokens":25,"output_tokens_details":{"reasoning_tokens":5},"total_tokens":75}}}',
      ];

      mockFetch.mockResolvedValue(createMockSSEResponse(events));

      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        tools: [],
      };

      const generator = client.streamResponses(prompt);
      const results: ResponseEvent[] = [];

      for await (const event of generator) {
        results.push(event);
      }

      const completedEvent = results.find(e => e.type === 'Completed');
      expect(completedEvent).toBeTruthy();
      if (completedEvent && 'tokenUsage' in completedEvent) {
        expect(completedEvent.tokenUsage).toEqual({
          input_tokens: 50,
          cached_input_tokens: 10,
          output_tokens: 25,
          reasoning_output_tokens: 5,
          total_tokens: 75,
        });
      }
    });
  });
});