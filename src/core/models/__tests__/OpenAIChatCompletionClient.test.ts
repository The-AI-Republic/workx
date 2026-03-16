/**
 * Comprehensive tests for OpenAIChatCompletionClient
 *
 * Tests focus on constructor, basic methods, and Chat Completions event conversion.
 * The OpenAIChatCompletionClient uses the OpenAI SDK (not raw fetch), so we test
 * the event conversion method directly and verify SDK-based behaviors.
 */

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { OpenAIChatCompletionClient, type OpenAIChatCompletionConfig } from '../client/OpenAIChatCompletionClient';
import { ModelClientError } from '../ModelClient';
import type {
  Prompt,
  ModelFamily,
  ModelProviderInfo,
} from '../types/ResponsesAPI';
import type { ResponseEvent } from '../types/ResponseEvent';

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

describe('OpenAIChatCompletionClient', () => {
  let client: OpenAIChatCompletionClient;
  let config: OpenAIChatCompletionConfig;

  const mockModelFamily: ModelFamily = {
    family: 'gpt-4o',
    base_instructions: 'You are a helpful assistant.',
    supports_reasoning: false,
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
      sessionId: 'conv-123',
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
      // getProvider() returns ModelProviderInfo object
      expect(client.getProvider().name).toBe('openai');
      expect(client.getModel()).toBe('gpt-4o');
    });

    it('should accept null API key (validation deferred to request time)', () => {
      // Constructor allows null apiKey; validation happens at request time
      const nullKeyClient = new OpenAIChatCompletionClient({ ...config, apiKey: null });
      expect(nullKeyClient.getModel()).toBe('gpt-4o');
    });

    it('should use default base URL when not provided', () => {
      const clientWithDefaults = new OpenAIChatCompletionClient(config);
      expect(clientWithDefaults.getProvider().name).toBe('openai');
    });

    it('should accept custom base URL', () => {
      const customConfig = { ...config, baseUrl: 'https://custom.api.com/v1' };
      const customClient = new OpenAIChatCompletionClient(customConfig);
      expect(customClient.getProvider().name).toBe('openai');
    });
  });

  describe('Basic Model Client Methods', () => {
    it('should get and set model correctly', () => {
      expect(client.getModel()).toBe('gpt-4o');
      client.setModel('gpt-4-turbo');
      expect(client.getModel()).toBe('gpt-4-turbo');
    });

    it('should return context window for known models', () => {
      // Uses getModelContextWindow() which has fallback logic
      client.setModel('gpt-4o');
      expect(client.getModelContextWindow()).toBe(128000);

      // gpt-5 gets 200000
      client.setModel('gpt-5');
      expect(client.getModelContextWindow()).toBe(200000);

      // Unknown models get default 128000 fallback
      client.setModel('unknown-model');
      expect(client.getModelContextWindow()).toBe(128000);
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

    it('should validate empty prompt input', async () => {
      const prompt: Prompt = {
        input: [],
        tools: [],
      };

      // stream() validates prompt input and throws
      await expect(client.stream(prompt)).rejects.toThrow('Prompt input is required');
    });
  });

  describe('Chat Completions Event Conversion', () => {
    it('should convert text delta content to OutputTextDelta', () => {
      const chatEvent = {
        choices: [{
          delta: { content: 'Hello' },
          finish_reason: null,
        }],
      };

      const result = (client as any).convertChatCompletionEventToResponseEvent(chatEvent);
      expect(result).toEqual({ type: 'OutputTextDelta', delta: 'Hello' });
    });

    it('should return null for empty choices', () => {
      const chatEvent = { choices: [] };
      const result = (client as any).convertChatCompletionEventToResponseEvent(chatEvent);
      expect(result).toBeNull();
    });

    it('should accumulate tool call deltas', () => {
      const chatEvent = {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_123',
              type: 'function',
              function: { name: 'test_fn', arguments: '{"a":' },
            }],
          },
          finish_reason: null,
        }],
      };

      const result = (client as any).convertChatCompletionEventToResponseEvent(chatEvent);
      // Tool call deltas return null until finish_reason
      expect(result).toBeNull();
      expect((client as any).chatCompletionToolCalls.size).toBe(1);
    });

    it('should emit OutputItemDone on finish_reason=stop with accumulated text', () => {
      // Accumulate text first
      (client as any).chatCompletionTextContent = 'Hello world';

      const chatEvent = {
        id: 'chatcmpl-123',
        choices: [{
          delta: {},
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };

      const result = (client as any).convertChatCompletionEventToResponseEvent(chatEvent);
      expect(result).toBeDefined();
      expect(result.type).toBe('OutputItemDone');
      expect(result.item.type).toBe('message');
      expect(result.item.role).toBe('assistant');
      expect(result.item.content[0].text).toBe('Hello world');

      // Completed event should be pending
      expect((client as any).pendingEvents.length).toBe(1);
      expect((client as any).pendingEvents[0].type).toBe('Completed');
    });

    it('should emit Completed directly when no content accumulated', () => {
      const chatEvent = {
        id: 'chatcmpl-123',
        choices: [{
          delta: {},
          finish_reason: 'stop',
        }],
      };

      const result = (client as any).convertChatCompletionEventToResponseEvent(chatEvent);
      expect(result).toBeDefined();
      expect(result.type).toBe('Completed');
    });

    it('should handle reasoning content deltas silently', () => {
      const chatEvent = {
        choices: [{
          delta: { reasoning_content: 'Thinking about this...' },
          finish_reason: null,
        }],
      };

      const result = (client as any).convertChatCompletionEventToResponseEvent(chatEvent);
      // Reasoning content is accumulated silently (returns null)
      expect(result).toBeNull();
      expect((client as any).chatCompletionReasoningContent).toBe('Thinking about this...');
    });

    it('should include reasoning content in final message item', () => {
      (client as any).chatCompletionReasoningContent = 'I should think about this carefully.';
      (client as any).chatCompletionTextContent = 'The answer is 42.';

      const chatEvent = {
        id: 'chatcmpl-123',
        choices: [{
          delta: {},
          finish_reason: 'stop',
        }],
      };

      const result = (client as any).convertChatCompletionEventToResponseEvent(chatEvent);
      expect(result.type).toBe('OutputItemDone');
      expect(result.item.reasoning_content).toBe('I should think about this carefully.');
      expect(result.item.content[0].text).toBe('The answer is 42.');
    });

    it('should convert chat completion usage to TokenUsage format', () => {
      (client as any).chatCompletionTextContent = 'Hi';

      const chatEvent = {
        id: 'chatcmpl-123',
        choices: [{
          delta: {},
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 50,
          prompt_tokens_details: { cached_tokens: 10 },
          completion_tokens: 25,
          completion_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 75,
        },
      };

      // Trigger OutputItemDone first
      (client as any).convertChatCompletionEventToResponseEvent(chatEvent);

      // Completed is in pending events
      const completedEvent = (client as any).pendingEvents[0];
      expect(completedEvent.type).toBe('Completed');
      expect(completedEvent.tokenUsage).toEqual({
        input_tokens: 50,
        cached_input_tokens: 10,
        output_tokens: 25,
        reasoning_output_tokens: 5,
        total_tokens: 75,
      });
    });
  });

  describe('Cleanup', () => {
    it('should reset all streaming state on cleanup', async () => {
      // Set up some state
      (client as any).chatCompletionTextContent = 'Some text';
      (client as any).chatCompletionReasoningContent = 'Some reasoning';
      (client as any).chatCompletionToolCalls.set(0, { id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } });
      (client as any).pendingEvents.push({ type: 'Completed', responseId: 'test' });

      await client.cleanup();

      expect((client as any).chatCompletionTextContent).toBe('');
      expect((client as any).chatCompletionReasoningContent).toBe('');
      expect((client as any).chatCompletionToolCalls.size).toBe(0);
      expect((client as any).pendingEvents.length).toBe(0);
    });
  });
});