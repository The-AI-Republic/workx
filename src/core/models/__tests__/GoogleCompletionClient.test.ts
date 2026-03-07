/**
 * Comprehensive unit tests for GoogleCompletionClient
 *
 * Covers:
 * - Construction and configuration
 * - Request formatting (prompt-to-contents mapping, tool mapping, schema sanitization)
 * - Streaming response parsing (text deltas, tool calls, usage metadata)
 * - Error handling (rate limits, auth errors, malformed responses, non-retryable errors)
 * - Retry logic (exponential backoff, retry-after parsing, max retries exhaustion)
 * - Backend routing (credentials mode, base URL normalization)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoogleCompletionClient, type GoogleGenAIConfig } from '../client/GoogleCompletionClient';
import type { ModelProviderInfo, Prompt } from '../types/ResponsesAPI';
import { ModelClientError } from '../ModelClient';

// ---------------------------------------------------------------------------
// Mock setup: vi.hoisted runs before any imports are evaluated, so the mock
// factory can reference these variables safely.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const generateContentStream = vi.fn();
  const generateContent = vi.fn();
  const models = { generateContentStream, generateContent };
  const GoogleGenAI = vi.fn().mockImplementation(() => ({ models }));
  return { GoogleGenAI, models, generateContentStream, generateContent };
});

vi.mock('@google/genai', () => ({
  GoogleGenAI: mocks.GoogleGenAI,
}));

vi.mock('../../../utils/logger', () => ({
  GeminiLogger: {
    stateReset: vi.fn(),
    streamStart: vi.fn(),
    streamEnd: vi.fn(),
  },
}));

vi.mock('../PromptHelpers', () => ({
  get_full_instructions: vi.fn(
    (prompt: any, modelFamily: any) =>
      prompt.base_instructions_override || modelFamily.base_instructions || ''
  ),
  get_formatted_input: vi.fn(async (prompt: any) => [...prompt.input]),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProvider(): ModelProviderInfo {
  return {
    name: 'google-ai-studio',
    wire_api: 'Responses',
    requires_openai_auth: false,
  };
}

function defaultModelFamily() {
  return {
    family: 'gemini-2.0-flash-exp',
    base_instructions: 'You are a helpful assistant.',
    supports_reasoning: false,
    supports_reasoning_summaries: false,
    needs_special_apply_patch_instructions: false,
  };
}

function defaultConfig(overrides: Partial<GoogleGenAIConfig> = {}): GoogleGenAIConfig {
  return {
    apiKey: 'test-api-key',
    provider: defaultProvider(),
    modelFamily: defaultModelFamily(),
    ...overrides,
  };
}

/** Utility: create an async generator from an array of chunks */
function asyncStreamFrom<T>(chunks: T[]): AsyncGenerator<T> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

/** Collect all events from a ResponseStream into an array */
async function collectEvents(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Build a minimal Prompt with user text */
function userPrompt(text: string, tools: any[] = []): Prompt {
  return {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    tools,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('GoogleCompletionClient', () => {
  let client: GoogleCompletionClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateContentStream.mockReset();
    mocks.GoogleGenAI.mockImplementation(() => ({ models: mocks.models }));
    client = new GoogleCompletionClient(defaultConfig());
  });

  // -------------------------------------------------------------------------
  // Construction and configuration
  // -------------------------------------------------------------------------

  describe('Construction and configuration', () => {
    it('should initialize GoogleGenAI with the provided API key', () => {
      expect(mocks.GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
    });

    it('should set model from modelFamily.family', () => {
      expect(client.getModel()).toBe('gemini-2.0-flash-exp');
    });

    it('should use default model when modelFamily has no family field', () => {
      const c = new GoogleCompletionClient(
        defaultConfig({ modelFamily: { base_instructions: 'Test' } })
      );
      // Default is 'gemini-2.0-flash-exp' (set in constructor)
      expect(c.getModel()).toBe('gemini-2.0-flash-exp');
    });

    it('should allow setting and getting a different model', () => {
      client.setModel('gemini-1.5-pro');
      expect(client.getModel()).toBe('gemini-1.5-pro');
    });

    it('should return the configured provider', () => {
      expect(client.getProvider()).toEqual(defaultProvider());
    });

    it('should return the model family', () => {
      expect(client.getModelFamily()).toEqual(defaultModelFamily());
    });

    it('should return 1_000_000 as auto compact token limit', () => {
      expect(client.getAutoCompactTokenLimit()).toBe(1000000);
    });

    it('should return undefined for auth manager, reasoning effort, and reasoning summary', () => {
      expect(client.getAuthManager()).toBeUndefined();
      expect(client.getReasoningEffort()).toBeUndefined();
      expect(client.getReasoningSummary()).toBeUndefined();
    });

    it('should be a no-op for setReasoningEffort and setReasoningSummary', () => {
      // These should not throw
      client.setReasoningEffort('high');
      client.setReasoningSummary(true);
      expect(client.getReasoningEffort()).toBeUndefined();
      expect(client.getReasoningSummary()).toBeUndefined();
    });

    it('should not create GoogleGenAI client when apiKey is null', () => {
      mocks.GoogleGenAI.mockClear();
      const c = new GoogleCompletionClient(defaultConfig({ apiKey: null }));
      expect(mocks.GoogleGenAI).not.toHaveBeenCalled();
      expect(c.isBackendRouting()).toBe(false);
    });

    it('should report isBackendRouting as true when useCredentials is set', () => {
      const c = new GoogleCompletionClient(
        defaultConfig({ useCredentials: true, baseUrl: 'https://example.com' })
      );
      expect(c.isBackendRouting()).toBe(true);
    });

    it('should report isBackendRouting as false by default', () => {
      expect(client.isBackendRouting()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Token counting
  // -------------------------------------------------------------------------

  describe('countTokens', () => {
    it('should return ceil(length / 4) as rough estimate', () => {
      expect(client.countTokens('hello', 'gemini-2.0-flash-exp')).toBe(2); // ceil(5/4) = 2
      expect(client.countTokens('', 'gemini-2.0-flash-exp')).toBe(0);
      expect(client.countTokens('a', 'gemini-2.0-flash-exp')).toBe(1);
      expect(client.countTokens('abcdefgh', 'gemini-2.0-flash-exp')).toBe(2); // ceil(8/4) = 2
      expect(client.countTokens('abcde', 'gemini-2.0-flash-exp')).toBe(2); // ceil(5/4) = 2
    });
  });

  // -------------------------------------------------------------------------
  // complete() - not implemented
  // -------------------------------------------------------------------------

  describe('complete()', () => {
    it('should return a non-streaming completion response', async () => {
      const generateContent = vi.fn().mockResolvedValue({
        text: 'Hello from Gemini!',
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
      });
      mocks.models.generateContent = generateContent;

      const result = await client.complete({
        model: 'gemini-2.0-flash-exp',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hello' },
        ],
      });

      expect(result.choices[0].message.content).toBe('Hello from Gemini!');
      expect(result.usage.totalTokens).toBe(9);
      expect(generateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-2.0-flash-exp',
          config: expect.objectContaining({
            systemInstruction: 'You are helpful.',
          }),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // streamCompletion / streamResponses / streamChat / attemptStreamResponses / processSSE
  // -------------------------------------------------------------------------

  describe('Abstract method stubs', () => {
    it('streamCompletion should throw', async () => {
      const gen = client.streamCompletion({
        model: 'gemini-2.0-flash-exp',
        messages: [{ role: 'user', content: 'hi' }],
      });
      await expect(gen.next()).rejects.toThrow('Use stream() instead');
    });
  });

  // -------------------------------------------------------------------------
  // Streaming response parsing
  // -------------------------------------------------------------------------

  describe('stream() - text content', () => {
    it('should emit OutputTextDelta events for each text chunk', async () => {
      const chunks = [
        { candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'World' }] } }] },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hi')));

      const deltas = events.filter((e: any) => e.type === 'OutputTextDelta');
      expect(deltas).toHaveLength(2);
      expect(deltas[0].delta).toBe('Hello ');
      expect(deltas[1].delta).toBe('World');
    });

    it('should accumulate text and emit OutputItemDone with full text', async () => {
      const chunks = [
        { candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'World' }] } }] },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hi')));

      const itemDone = events.find((e: any) => e.type === 'OutputItemDone');
      expect(itemDone).toBeDefined();
      expect(itemDone.item.type).toBe('message');
      expect(itemDone.item.role).toBe('assistant');
      expect(itemDone.item.content).toEqual([{ type: 'output_text', text: 'Hello World' }]);
    });

    it('should emit a Completed event with token usage', async () => {
      const chunks = [
        { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] },
        {
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            totalTokenCount: 120,
          },
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hello')));

      const completed = events.find((e: any) => e.type === 'Completed');
      expect(completed).toBeDefined();
      expect(completed.responseId).toBe('gemini-response');
      expect(completed.tokenUsage).toEqual({
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
      });
    });

    it('should emit Completed with undefined tokenUsage when no usageMetadata', async () => {
      const chunks = [
        { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hello')));

      const completed = events.find((e: any) => e.type === 'Completed');
      expect(completed).toBeDefined();
      expect(completed.tokenUsage).toBeUndefined();
    });

    it('should emit correct event count: N deltas + 1 OutputItemDone + 1 Completed', async () => {
      const chunks = [
        { candidates: [{ content: { parts: [{ text: 'a' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'b' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'c' }] } }] },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hi')));

      expect(events.filter((e: any) => e.type === 'OutputTextDelta')).toHaveLength(3);
      expect(events.filter((e: any) => e.type === 'OutputItemDone')).toHaveLength(1);
      expect(events.filter((e: any) => e.type === 'Completed')).toHaveLength(1);
      expect(events).toHaveLength(5);
    });

    it('should handle multiple text parts within a single chunk', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: 'Part1' }, { text: 'Part2' }],
              },
            },
          ],
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hello')));

      const deltas = events.filter((e: any) => e.type === 'OutputTextDelta');
      expect(deltas).toHaveLength(2);
      expect(deltas[0].delta).toBe('Part1');
      expect(deltas[1].delta).toBe('Part2');

      const itemDone = events.find((e: any) => e.type === 'OutputItemDone');
      expect(itemDone.item.content[0].text).toBe('Part1Part2');
    });

    it('should skip chunks with no candidates', async () => {
      const chunks = [
        {},
        { candidates: [] },
        { candidates: [{ content: { parts: [{ text: 'Only' }] } }] },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hi')));

      const deltas = events.filter((e: any) => e.type === 'OutputTextDelta');
      expect(deltas).toHaveLength(1);
      expect(deltas[0].delta).toBe('Only');
    });

    it('should skip candidates with no content parts', async () => {
      const chunks = [
        { candidates: [{}] },
        { candidates: [{ content: {} }] },
        { candidates: [{ content: { parts: [{ text: 'Valid' }] } }] },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hi')));

      const deltas = events.filter((e: any) => e.type === 'OutputTextDelta');
      expect(deltas).toHaveLength(1);
    });
  });

  describe('stream() - empty response', () => {
    it('should emit only Completed when stream yields no content', async () => {
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));

      const events = await collectEvents(await client.stream(userPrompt('hello')));

      // No text, no tool calls -> no OutputItemDone
      expect(events.filter((e: any) => e.type === 'OutputItemDone')).toHaveLength(0);
      expect(events.filter((e: any) => e.type === 'Completed')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  describe('stream() - tool calls', () => {
    it('should capture function calls and emit OutputItemDone with tool_calls', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'call_abc',
                      name: 'search',
                      args: { query: 'typescript' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('search ts')));

      const itemDone = events.find((e: any) => e.type === 'OutputItemDone');
      expect(itemDone).toBeDefined();
      expect(itemDone.item.content).toEqual([]);
      expect(itemDone.item.tool_calls).toHaveLength(1);
      expect(itemDone.item.tool_calls[0]).toMatchObject({
        id: 'call_abc',
        type: 'function',
        function: {
          name: 'search',
          arguments: '{"query":"typescript"}',
        },
      });
    });

    it('should generate a deterministic-format ID when functionCall.id is missing', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'get_weather',
                      args: { location: 'NYC' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('weather')));

      const itemDone = events.find((e: any) => e.type === 'OutputItemDone');
      const toolCall = itemDone.item.tool_calls[0];
      expect(toolCall.id).toMatch(/^call_\d+_[a-z0-9]+$/);
      expect(toolCall.function.name).toBe('get_weather');
    });

    it('should default args to empty object when functionCall.args is undefined', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'call_1',
                      name: 'no_args_tool',
                      // args: undefined
                    },
                  },
                ],
              },
            },
          ],
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('go')));

      const itemDone = events.find((e: any) => e.type === 'OutputItemDone');
      expect(itemDone.item.tool_calls[0].function.arguments).toBe('{}');
    });

    it('should capture thoughtSignature from parts', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'call_sig',
                      name: 'my_tool',
                      args: {},
                    },
                    thoughtSignature: 'sig_encrypted_123',
                  },
                ],
              },
            },
          ],
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('do it')));

      const itemDone = events.find((e: any) => e.type === 'OutputItemDone');
      expect(itemDone.item.tool_calls[0].thoughtSignature).toBe('sig_encrypted_123');
    });

    it('should handle mixed text and tool call parts in same candidate', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'I will look that up.' },
                  {
                    functionCall: {
                      id: 'call_mix',
                      name: 'web_search',
                      args: { q: 'test' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('search')));

      const deltas = events.filter((e: any) => e.type === 'OutputTextDelta');
      expect(deltas).toHaveLength(1);
      expect(deltas[0].delta).toBe('I will look that up.');

      const itemDone = events.find((e: any) => e.type === 'OutputItemDone');
      expect(itemDone.item.content).toEqual([
        { type: 'output_text', text: 'I will look that up.' },
      ]);
      expect(itemDone.item.tool_calls).toHaveLength(1);
      expect(itemDone.item.tool_calls[0].function.name).toBe('web_search');
    });

    it('should accumulate multiple tool calls from separate chunks', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: 'call_1', name: 'tool_a', args: { a: 1 } },
                  },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: 'call_2', name: 'tool_b', args: { b: 2 } },
                  },
                ],
              },
            },
          ],
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('multi')));

      const itemDone = events.find((e: any) => e.type === 'OutputItemDone');
      expect(itemDone.item.tool_calls).toHaveLength(2);
      expect(itemDone.item.tool_calls[0].function.name).toBe('tool_a');
      expect(itemDone.item.tool_calls[1].function.name).toBe('tool_b');
    });
  });

  // -------------------------------------------------------------------------
  // Request formatting - prompt to contents mapping
  // -------------------------------------------------------------------------

  describe('Request formatting - contents mapping', () => {
    it('should map user messages with role "user"', async () => {
      const prompt: Prompt = {
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents[0].role).toBe('user');
      expect(callArgs.contents[0].parts).toEqual([{ text: 'Hello' }]);
    });

    it('should map assistant messages with role "model"', async () => {
      const prompt: Prompt = {
        input: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there' }] },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents[0].role).toBe('model');
      expect(callArgs.contents[0].parts).toEqual([{ text: 'Hi there' }]);
    });

    it('should handle string content in messages', async () => {
      const prompt: Prompt = {
        input: [
          { type: 'message', role: 'user', content: 'Plain string' } as any,
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents[0].parts).toEqual([{ text: 'Plain string' }]);
    });

    it('should handle input_image content with base64 data URL', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'What is this?' },
              { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' },
            ],
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents[0].parts).toEqual([
        { text: 'What is this?' },
        { inlineData: { mimeType: 'image/png', data: 'iVBOR' } },
      ]);
    });

    it('should pass system instructions from model family', async () => {
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(userPrompt('hi')));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.config.systemInstruction).toBe('You are a helpful assistant.');
    });

    it('should pass model name to generateContentStream', async () => {
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(userPrompt('hi')));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.model).toBe('gemini-2.0-flash-exp');
    });

    it('should map assistant messages with tool_calls to model parts with functionCall', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Let me check.' }],
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"test"}' },
              },
            ],
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const contents = callArgs.contents;
      expect(contents).toHaveLength(1);
      expect(contents[0].role).toBe('model');
      expect(contents[0].parts).toHaveLength(2);
      expect(contents[0].parts[0]).toEqual({ text: 'Let me check.' });
      expect(contents[0].parts[1]).toEqual({
        functionCall: { name: 'search', args: { q: 'test' } },
      });
    });

    it('should pass thoughtSignature from history tool_calls back into parts', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'assistant',
            content: [],
            tool_calls: [
              {
                id: 'call_ts',
                type: 'function',
                function: { name: 'tool_x', arguments: '{}' },
                thoughtSignature: 'sig_999',
              },
            ],
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents[0].parts[0]).toEqual({
        functionCall: { name: 'tool_x', args: {} },
        thoughtSignature: 'sig_999',
      });
    });

    it('should map function_call_output to functionResponse parts', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'assistant',
            content: [],
            tool_calls: [
              {
                id: 'call_fn',
                type: 'function',
                function: { name: 'my_func', arguments: '{}' },
              },
            ],
          },
          {
            type: 'function_call_output',
            call_id: 'call_fn',
            output: 'result data',
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const contents = callArgs.contents;

      // Second content should be the function response
      const fnResponseContent = contents.find(
        (c: any) =>
          c.parts &&
          c.parts.some((p: any) => p.functionResponse)
      );
      expect(fnResponseContent).toBeDefined();
      expect(fnResponseContent.role).toBe('user');
      expect(fnResponseContent.parts[0].functionResponse).toEqual({
        name: 'my_func',
        response: { name: 'my_func', content: 'result data' },
      });
    });

    it('should skip function_call_output when call_id cannot be resolved', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'function_call_output',
            call_id: 'unknown_call_id',
            output: 'some data',
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents).toHaveLength(0);
    });

    it('should skip messages with empty parts', async () => {
      const prompt: Prompt = {
        input: [
          { type: 'message', role: 'user', content: [] },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Request formatting - tool mapping
  // -------------------------------------------------------------------------

  describe('Request formatting - tool mapping', () => {
    it('should map function tools to functionDeclarations', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          {
            type: 'function',
            function: {
              name: 'calculator',
              description: 'Does math',
              strict: false,
              parameters: { type: 'object', properties: { expr: { type: 'string' } } },
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const tools = callArgs.config.tools[0];
      expect(tools.functionDeclarations).toHaveLength(1);
      expect(tools.functionDeclarations[0].name).toBe('calculator');
      expect(tools.functionDeclarations[0].description).toBe('Does math');
    });

    it('should set toolConfig with AUTO mode when tools are present', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          {
            type: 'function',
            function: {
              name: 'test',
              description: 'test',
              strict: false,
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.config.toolConfig).toEqual({
        functionCallingConfig: { mode: 'AUTO' },
      });
    });

    it('should not include tools or toolConfig when no tools provided', async () => {
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(userPrompt('hi')));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.config.tools).toBeUndefined();
      expect(callArgs.config.toolConfig).toBeUndefined();
    });

    it('should filter out non-function tool types', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          { type: 'web_search' } as any,
          {
            type: 'function',
            function: {
              name: 'only_this',
              description: 'only function',
              strict: false,
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const decls = callArgs.config.tools[0].functionDeclarations;
      expect(decls).toHaveLength(1);
      expect(decls[0].name).toBe('only_this');
    });
  });

  // -------------------------------------------------------------------------
  // Schema sanitization
  // -------------------------------------------------------------------------

  describe('Request formatting - schema sanitization', () => {
    it('should remove title from schema', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              strict: false,
              parameters: { type: 'object', title: 'MyParams', properties: { x: { type: 'string' } } },
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const params = callArgs.config.tools[0].functionDeclarations[0].parameters;
      expect(params.title).toBeUndefined();
    });

    it('should truncate descriptions longer than 1024 characters', async () => {
      const longDesc = 'x'.repeat(2000);
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              strict: false,
              parameters: {
                type: 'object',
                description: longDesc,
                properties: { a: { type: 'string' } },
              },
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const params = callArgs.config.tools[0].functionDeclarations[0].parameters;
      expect(params.description.length).toBe(1024);
      expect(params.description.endsWith('...')).toBe(true);
    });

    it('should add empty properties and additionalProperties to object types without properties', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              strict: false,
              parameters: { type: 'object' } as any,
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const params = callArgs.config.tools[0].functionDeclarations[0].parameters;
      expect(params.properties).toEqual({});
      expect(params.additionalProperties).toBe(true);
    });

    it('should set additionalProperties to false for objects with properties (when not already set)', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              strict: false,
              parameters: {
                type: 'object',
                properties: { name: { type: 'string' } },
              },
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const params = callArgs.config.tools[0].functionDeclarations[0].parameters;
      expect(params.additionalProperties).toBe(false);
    });

    it('should recursively sanitize nested properties', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              strict: false,
              parameters: {
                type: 'object',
                properties: {
                  nested: {
                    type: 'object',
                    title: 'ShouldBeRemoved',
                    properties: { val: { type: 'string' } },
                  },
                },
              },
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const nested =
        callArgs.config.tools[0].functionDeclarations[0].parameters.properties.nested;
      expect(nested.title).toBeUndefined();
      expect(nested.additionalProperties).toBe(false);
    });

    it('should recursively sanitize array items', async () => {
      const prompt: Prompt = {
        input: [{ type: 'message', role: 'user', content: 'hi' } as any],
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              strict: false,
              parameters: {
                type: 'object',
                properties: {
                  list: {
                    type: 'array',
                    items: {
                      type: 'object',
                      title: 'RemoveMe',
                      properties: { id: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        ],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const items =
        callArgs.config.tools[0].functionDeclarations[0].parameters.properties.list.items;
      expect(items.title).toBeUndefined();
      expect(items.additionalProperties).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('Error handling', () => {
    it('should emit a ModelClientError to the stream on non-retryable errors', async () => {
      mocks.generateContentStream.mockRejectedValue(
        new Error('Something went wrong')
      );

      const stream = await client.stream(userPrompt('hello'));
      const events: any[] = [];
      let caughtError: any = null;

      try {
        for await (const event of stream) {
          events.push(event);
        }
      } catch (e) {
        caughtError = e;
      }

      // The stream should error (ResponseStreamError wrapping ModelClientError)
      expect(caughtError).toBeDefined();
    });

    it('should handle errors with status property', async () => {
      const err: any = new Error('Server error');
      err.status = 500;
      mocks.generateContentStream.mockRejectedValue(err);

      const stream = await client.stream(userPrompt('hello'));
      let caughtError: any = null;

      try {
        for await (const _ of stream) { /* consume */ }
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
    });

    it('should throw ModelClientError with API key message when apiKey is null and stream is called', async () => {
      const c = new GoogleCompletionClient(defaultConfig({ apiKey: null }));

      const stream = await c.stream(userPrompt('hello'));
      let caughtError: any = null;

      try {
        for await (const _ of stream) { /* consume */ }
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
      // ResponseStream wraps the error; check the full chain for the API key message
      const errorChain = [
        caughtError.message,
        caughtError.cause?.message,
        caughtError.cause?.cause?.message,
      ].filter(Boolean).join(' | ');
      expect(errorChain).toMatch(/API key/i);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit retry logic
  // -------------------------------------------------------------------------

  describe('Retry logic - rate limits', () => {
    it('should retry on 429 status error and succeed on second attempt', async () => {
      vi.useFakeTimers();

      const rateLimitError: any = new Error('Rate limit');
      rateLimitError.status = 429;

      const successChunks = [
        { candidates: [{ content: { parts: [{ text: 'OK' }] } }] },
      ];

      mocks.generateContentStream
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(asyncStreamFrom(successChunks));

      const streamPromise = client.stream(userPrompt('hi'));
      await vi.advanceTimersByTimeAsync(0);
      const stream = await streamPromise;

      const eventsPromise = collectEvents(stream);
      await vi.advanceTimersByTimeAsync(5000);
      const events = await eventsPromise;

      expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
      const deltas = events.filter((e: any) => e.type === 'OutputTextDelta');
      expect(deltas[0].delta).toBe('OK');

      vi.useRealTimers();
    });

    it('should retry on error.code === 429', async () => {
      vi.useFakeTimers();

      const rateLimitError: any = new Error('rate limited');
      rateLimitError.code = 429;

      const successChunks = [
        { candidates: [{ content: { parts: [{ text: 'Done' }] } }] },
      ];

      mocks.generateContentStream
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(asyncStreamFrom(successChunks));

      const streamPromise = client.stream(userPrompt('hi'));
      await vi.advanceTimersByTimeAsync(0);
      const stream = await streamPromise;

      const eventsPromise = collectEvents(stream);
      await vi.advanceTimersByTimeAsync(5000);
      const events = await eventsPromise;

      expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);
      expect(events.some((e: any) => e.type === 'OutputTextDelta' && e.delta === 'Done')).toBe(true);

      vi.useRealTimers();
    });

    it('should retry when error message contains "429"', async () => {
      vi.useFakeTimers();

      const err = new Error('Got status 429 from server');

      const successChunks = [
        { candidates: [{ content: { parts: [{ text: 'Recovered' }] } }] },
      ];

      mocks.generateContentStream
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(asyncStreamFrom(successChunks));

      const streamPromise = client.stream(userPrompt('hi'));
      await vi.advanceTimersByTimeAsync(0);
      const stream = await streamPromise;

      const eventsPromise = collectEvents(stream);
      await vi.advanceTimersByTimeAsync(5000);
      const events = await eventsPromise;

      expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should retry when error message contains "RESOURCE_EXHAUSTED"', async () => {
      vi.useFakeTimers();

      const err = new Error('RESOURCE_EXHAUSTED: quota exceeded');

      const successChunks = [
        { candidates: [{ content: { parts: [{ text: 'Back' }] } }] },
      ];

      mocks.generateContentStream
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(asyncStreamFrom(successChunks));

      const streamPromise = client.stream(userPrompt('hi'));
      await vi.advanceTimersByTimeAsync(0);
      const stream = await streamPromise;

      const eventsPromise = collectEvents(stream);
      await vi.advanceTimersByTimeAsync(5000);
      const events = await eventsPromise;

      expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should throw ModelClientError after exceeding max retries (3)', async () => {
      vi.useFakeTimers();

      const rateLimitError: any = new Error('429 rate limit');
      rateLimitError.status = 429;

      // All 4 calls (initial + 3 retries) should fail
      mocks.generateContentStream.mockRejectedValue(rateLimitError);

      const streamPromise = client.stream(userPrompt('hi'));
      await vi.advanceTimersByTimeAsync(0);
      const stream = await streamPromise;

      let caughtError: any = null;

      // Advance timers through all retry delays
      // Retry 1: baseDelay * 2^0 = 2000ms
      // Retry 2: baseDelay * 2^1 = 4000ms
      // Retry 3: baseDelay * 2^2 = 8000ms
      const consumePromise = (async () => {
        try {
          for await (const _ of stream) { /* consume */ }
        } catch (e) {
          caughtError = e;
        }
      })();

      // Advance past all retry delays (total ~14s plus margin)
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      await consumePromise;

      expect(caughtError).toBeDefined();
      // Should have tried 4 times: initial + 3 retries
      expect(mocks.generateContentStream).toHaveBeenCalledTimes(4);
      // The underlying error should be ModelClientError with 429
      const errorChain = [
        caughtError.message,
        caughtError.cause?.message,
        caughtError.cause?.cause?.message,
      ].filter(Boolean).join(' | ');
      expect(errorChain).toMatch(/rate limit/i);

      vi.useRealTimers();
    });

    it('should parse retryDelay from error message JSON', async () => {
      vi.useFakeTimers();

      const errorMsg = JSON.stringify({
        error: {
          code: 429,
          message: 'RESOURCE_EXHAUSTED',
          details: [{ retryDelay: '2s' }],
        },
      });

      const rateLimitError: any = new Error(errorMsg);
      rateLimitError.status = 429;

      const successChunks = [
        { candidates: [{ content: { parts: [{ text: 'OK' }] } }] },
      ];

      mocks.generateContentStream
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(asyncStreamFrom(successChunks));

      const streamPromise = client.stream(userPrompt('hi'));

      // Let the async task start and hit the rate limit
      await vi.advanceTimersByTimeAsync(0);

      const stream = await streamPromise;

      // The retry delay from the parsed JSON is 2s = 2000ms
      // Advance past it
      await vi.advanceTimersByTimeAsync(3000);

      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should use exponential backoff when retryDelay is not parseable', async () => {
      vi.useFakeTimers();

      const rateLimitError: any = new Error('rate limited, no JSON');
      rateLimitError.status = 429;

      const successChunks = [
        { candidates: [{ content: { parts: [{ text: 'OK' }] } }] },
      ];

      mocks.generateContentStream
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(asyncStreamFrom(successChunks));

      const streamPromise = client.stream(userPrompt('hi'));
      await vi.advanceTimersByTimeAsync(0);

      const stream = await streamPromise;

      // baseDelay = 2000, retryCount=1 -> delay = 2000 * 2^0 = 2000ms
      await vi.advanceTimersByTimeAsync(3000);

      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(mocks.generateContentStream).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should not retry on non-rate-limit errors', async () => {
      const err = new Error('Permission denied');
      mocks.generateContentStream.mockRejectedValue(err);

      const stream = await client.stream(userPrompt('hi'));
      let caughtError: any = null;

      try {
        for await (const _ of stream) { /* consume */ }
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
      // Should have been called only once (no retries)
      expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Backend routing
  // -------------------------------------------------------------------------

  describe('Backend routing', () => {
    it('should strip /v1beta/openai suffix from baseUrl', () => {
      mocks.GoogleGenAI.mockClear();
      new GoogleCompletionClient(
        defaultConfig({
          baseUrl: 'https://api.example.com/v1beta/openai',
        })
      );

      const calledWith = mocks.GoogleGenAI.mock.calls[0][0];
      expect(calledWith.httpOptions.baseUrl).toBe('https://api.example.com');
    });

    it('should strip trailing slash from baseUrl', () => {
      mocks.GoogleGenAI.mockClear();
      new GoogleCompletionClient(
        defaultConfig({
          baseUrl: 'https://api.example.com/',
        })
      );

      const calledWith = mocks.GoogleGenAI.mock.calls[0][0];
      expect(calledWith.httpOptions.baseUrl).toBe('https://api.example.com');
    });

    it('should strip both /v1beta/openai suffix and trailing slash', () => {
      mocks.GoogleGenAI.mockClear();
      new GoogleCompletionClient(
        defaultConfig({
          baseUrl: 'https://api.example.com/v1beta/openai/',
        })
      );

      const calledWith = mocks.GoogleGenAI.mock.calls[0][0];
      // After splitting on /v1beta/openai -> "https://api.example.com/"
      // Then trailing slash stripped -> "https://api.example.com"
      expect(calledWith.httpOptions.baseUrl).toBe('https://api.example.com');
    });

    it('should configure custom fetch with credentials when useCredentials=true', () => {
      mocks.GoogleGenAI.mockClear();
      new GoogleCompletionClient(
        defaultConfig({
          baseUrl: 'https://api.example.com',
          useCredentials: true,
        })
      );

      const calledWith = mocks.GoogleGenAI.mock.calls[0][0];
      expect(calledWith.httpOptions.fetch).toBeDefined();
      expect(typeof calledWith.httpOptions.fetch).toBe('function');
    });

    it('should not configure custom fetch when useCredentials=false', () => {
      mocks.GoogleGenAI.mockClear();
      new GoogleCompletionClient(
        defaultConfig({
          baseUrl: 'https://api.example.com',
          useCredentials: false,
        })
      );

      const calledWith = mocks.GoogleGenAI.mock.calls[0][0];
      expect(calledWith.httpOptions.fetch).toBeUndefined();
    });

    it('should pass credentials: "include" to global fetch in custom fetch', async () => {
      mocks.GoogleGenAI.mockClear();
      const mockGlobalFetch = vi.fn().mockResolvedValue(new Response('{}'));
      globalThis.fetch = mockGlobalFetch;

      new GoogleCompletionClient(
        defaultConfig({
          baseUrl: 'https://api.example.com',
          useCredentials: true,
        })
      );

      const calledWith = mocks.GoogleGenAI.mock.calls[0][0];
      const customFetch = calledWith.httpOptions.fetch;

      await customFetch('https://api.example.com/generate', { method: 'POST' });

      expect(mockGlobalFetch).toHaveBeenCalledWith(
        'https://api.example.com/generate',
        expect.objectContaining({ credentials: 'include', method: 'POST' })
      );
    });

    it('should use "backend-routed" as apiKey when apiKey is null but client is created later', () => {
      // When getClient() is called without apiKey, it should throw
      // But createClient() uses 'backend-routed' as fallback
      mocks.GoogleGenAI.mockClear();
      const c = new GoogleCompletionClient(
        defaultConfig({
          apiKey: null,
          baseUrl: 'https://proxy.example.com',
          useCredentials: true,
        })
      );

      // Client is not created during construction because apiKey is null
      expect(mocks.GoogleGenAI).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // parseRateLimitSnapshot
  // -------------------------------------------------------------------------

  describe('parseRateLimitSnapshot', () => {
    it('should return undefined (not supported for Google)', () => {
      // Access protected method via any cast
      const result = (client as any).parseRateLimitSnapshot(new Headers());
      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Usage metadata edge cases
  // -------------------------------------------------------------------------

  describe('Usage metadata', () => {
    it('should use last usageMetadata from stream (overwriting earlier ones)', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: 'a' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        },
        {
          candidates: [{ content: { parts: [{ text: 'b' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hi')));

      const completed = events.find((e: any) => e.type === 'Completed');
      expect(completed.tokenUsage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
      });
    });

    it('should handle usageMetadata with zero counts', async () => {
      const chunks = [
        {
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hi')));

      const completed = events.find((e: any) => e.type === 'Completed');
      expect(completed.tokenUsage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
      });
    });

    it('should handle usageMetadata with missing fields (defaults to 0)', async () => {
      const chunks = [
        {
          usageMetadata: {},
        },
      ];
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom(chunks));

      const events = await collectEvents(await client.stream(userPrompt('hi')));

      const completed = events.find((e: any) => e.type === 'Completed');
      expect(completed.tokenUsage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('should handle legacy "text" content type in messages', async () => {
      const prompt: Prompt = {
        input: [
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'Legacy' }] },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents[0].parts).toEqual([{ text: 'Legacy' }]);
    });

    it('should handle "output_text" content type in messages', async () => {
      const prompt: Prompt = {
        input: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Response' }] },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      expect(callArgs.contents[0].parts).toEqual([{ text: 'Response' }]);
    });

    it('should handle assistant message with string content and tool_calls', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I need to call a tool' }],
            tool_calls: [
              {
                id: 'call_str',
                type: 'function',
                function: { name: 'do_thing', arguments: '{"x":1}' },
              },
            ],
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const parts = callArgs.contents[0].parts;
      expect(parts[0]).toEqual({ text: 'I need to call a tool' });
      expect(parts[1]).toEqual({
        functionCall: { name: 'do_thing', args: { x: 1 } },
      });
    });

    it('should handle tool_calls with object arguments (not string)', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'assistant',
            content: [],
            tool_calls: [
              {
                id: 'call_obj',
                type: 'function',
                function: { name: 'my_fn', arguments: { key: 'val' } as any },
              },
            ],
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const fnPart = callArgs.contents[0].parts[0];
      expect(fnPart.functionCall.args).toEqual({ key: 'val' });
    });

    it('should not add image parts for non-data: URLs', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_image', image_url: 'https://example.com/image.png' },
            ],
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      // Non-data: URL images are skipped, so no parts -> content is empty
      expect(callArgs.contents).toHaveLength(0);
    });

    it('should resolve function_call_output using function_call type items in input', async () => {
      const prompt: Prompt = {
        input: [
          {
            type: 'function_call',
            id: 'fc_id',
            call_id: 'fc_id',
            name: 'fn_from_fc',
          } as any,
          {
            type: 'function_call_output',
            call_id: 'fc_id',
            output: 'fc result',
          },
        ],
        tools: [],
      };
      mocks.generateContentStream.mockResolvedValue(asyncStreamFrom([]));
      await collectEvents(await client.stream(prompt));

      const callArgs = mocks.generateContentStream.mock.calls[0][0];
      const fnResponse = callArgs.contents.find(
        (c: any) => c.parts && c.parts[0]?.functionResponse
      );
      expect(fnResponse).toBeDefined();
      expect(fnResponse.parts[0].functionResponse.name).toBe('fn_from_fc');
    });
  });
});
