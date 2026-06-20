/**
 * Comprehensive unit tests for AnthropicClient
 *
 * Covers:
 * - Construction (Anthropic SDK initialized with the provider base URL)
 * - Request building (system extraction, message/tool-call mapping, tool schema, thinking)
 * - Streaming event conversion (text/thinking deltas, tool_use, completion + usage)
 * - Token usage mapping (input + cache + output)
 * - Non-streaming complete()
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicClient } from '../client/AnthropicClient';
import type { OpenAIResponsesConfig } from '../client/OpenAIResponsesClient';
import type { ModelProviderInfo, Prompt } from '../types/ResponsesAPI';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  ctorArgs: [] as any[],
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mocks.create };
    constructor(opts: any) {
      mocks.ctorArgs.push(opts);
    }
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
    name: 'Anthropic',
    base_url: 'https://api.anthropic.com',
    wire_api: 'Responses',
    requires_openai_auth: false,
  };
}

function defaultModelFamily() {
  return {
    family: 'claude-sonnet-4-6',
    base_instructions: 'You are a helpful assistant.',
    supports_reasoning: true,
    supports_reasoning_summaries: false,
    needs_special_apply_patch_instructions: false,
  };
}

function defaultConfig(overrides: Partial<OpenAIResponsesConfig> = {}): OpenAIResponsesConfig {
  return {
    apiKey: 'sk-ant-test',
    baseUrl: 'https://api.anthropic.com',
    sessionId: 'session-1',
    provider: defaultProvider(),
    modelFamily: defaultModelFamily(),
    modelConfig: { maxOutputTokens: 32000 } as any,
    ...overrides,
  };
}

/** Async generator from an array of raw Anthropic stream events. */
function asyncStreamFrom<T>(chunks: T[]): AsyncGenerator<T> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

async function collectEvents(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function userPrompt(text: string, tools: any[] = []): Prompt {
  return {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    tools,
  };
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.ctorArgs.length = 0;
});

// ===========================================================================
// Construction
// ===========================================================================

describe('AnthropicClient construction', () => {
  it('initializes the Anthropic SDK with the provider base URL', () => {
    new AnthropicClient(defaultConfig());
    expect(mocks.ctorArgs).toHaveLength(1);
    const opts = mocks.ctorArgs[0];
    expect(opts.baseURL).toBe('https://api.anthropic.com');
    expect(opts.apiKey).toBe('sk-ant-test');
    expect(opts.dangerouslyAllowBrowser).toBe(true);
    expect(opts.maxRetries).toBe(0);
  });
});

// ===========================================================================
// Request building (exercised through stream())
// ===========================================================================

describe('AnthropicClient request building', () => {
  it('extracts system, maps the user message, and sets max_tokens', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: undefined }));

    const stream = await client.stream(userPrompt('Hello Claude'));
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.model).toBe('claude-sonnet-4-6');
    expect(payload.max_tokens).toBe(32000);
    expect(payload.stream).toBe(true);
    expect(payload.system).toBe('You are a helpful assistant.');
    expect(payload.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello Claude' }] },
    ]);
  });

  it('maps function tools to Anthropic input_schema format', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: undefined }));

    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather',
        strict: false,
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }];

    const stream = await client.stream(userPrompt('weather?', tools));
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.tools).toEqual([{
      name: 'get_weather',
      description: 'Get the weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }]);
  });

  it('converts function_call / function_call_output history into tool_use / tool_result', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: undefined }));

    const prompt: Prompt = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather in SF?' }] },
        { type: 'function_call', name: 'get_weather', arguments: '{"city":"SF"}', call_id: 'toolu_1' },
        { type: 'function_call_output', call_id: 'toolu_1', output: '{"temp":68}' },
      ],
      tools: [],
    };

    const stream = await client.stream(prompt);
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather in SF?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":68}' }] },
    ]);
  });

  it('wraps custom tool call history input without dropping freeform text', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: undefined }));

    const prompt: Prompt = {
      input: [
        { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch', call_id: 'toolu_custom' },
        { type: 'custom_tool_call_output', call_id: 'toolu_custom', output: 'ok' },
      ],
      tools: [{
        type: 'custom',
        custom: {
          name: 'apply_patch',
          description: 'Apply a patch',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
        },
      } as any],
    };

    const stream = await client.stream(prompt);
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.tools[0].input_schema).toEqual({
      type: 'object',
      properties: { input: { type: 'string', description: 'Tool input' } },
      required: ['input'],
    });
    expect(payload.messages).toEqual([
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_custom',
          name: 'apply_patch',
          input: { input: '*** Begin Patch' },
        }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_custom', content: 'ok' }] },
    ]);
  });

  it('round-trips encrypted reasoning blocks for Anthropic tool-use continuity', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: 'medium' }));

    const prompt: Prompt = {
      input: [
        {
          type: 'reasoning',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'Need weather first.' }],
          encrypted_content: 'sig_123',
          encrypted_content_type: 'signature',
        },
        { type: 'function_call', name: 'get_weather', arguments: '{"city":"SF"}', call_id: 'toolu_1' },
        {
          type: 'reasoning',
          summary: [],
          content: [],
          encrypted_content: 'redacted_123',
          encrypted_content_type: 'redacted_thinking',
        },
      ],
      tools: [],
    };

    const stream = await client.stream(prompt);
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need weather first.', signature: 'sig_123' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
          { type: 'redacted_thinking', data: 'redacted_123' },
        ],
      },
    ]);
  });

  it('merges adjacent same-role items into a single message', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: undefined }));

    const prompt: Prompt = {
      input: [
        { type: 'function_call_output', call_id: 'a', output: 'r1' },
        { type: 'function_call_output', call_id: 'b', output: 'r2' },
      ],
      tools: [],
    };

    const stream = await client.stream(prompt);
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'r1' },
          { type: 'tool_result', tool_use_id: 'b', content: 'r2' },
        ],
      },
    ]);
  });

  it('converts data-URL images into base64 image blocks', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: undefined }));

    const prompt: Prompt = {
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAB' },
        ],
      }],
      tools: [],
    };

    const stream = await client.stream(prompt);
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAB' },
    });
  });

  it('uses adaptive thinking and output_config effort for Sonnet 4.6', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: 'high' }));

    const stream = await client.stream(userPrompt('think hard'));
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(payload.output_config).toEqual({ effort: 'high' });
    expect(payload.temperature).toBeUndefined();
  });

  it('omits thinking and sends effort for always-on adaptive thinking models', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({
      reasoningEffort: 'medium',
      modelFamily: {
        ...defaultModelFamily(),
        family: 'claude-fable-5',
      },
    }));

    const stream = await client.stream(userPrompt('think carefully'));
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.thinking).toBeUndefined();
    expect(payload.output_config).toEqual({ effort: 'medium' });
  });

  it('uses manual thinking budgets for non-adaptive reasoning models', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({
      reasoningEffort: 'high',
      modelFamily: {
        ...defaultModelFamily(),
        family: 'claude-haiku-4-5-20251001',
      },
    }));

    const stream = await client.stream(userPrompt('think hard'));
    await collectEvents(stream);

    const payload = mocks.create.mock.calls[0][0];
    expect(payload.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 24000,
      display: 'summarized',
    });
    expect(payload.output_config).toBeUndefined();
  });

  it('omits thinking when reasoning effort is not set', async () => {
    mocks.create.mockReturnValue(asyncStreamFrom([{ type: 'message_stop' }]));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: undefined }));

    const stream = await client.stream(userPrompt('quick'));
    await collectEvents(stream);

    expect(mocks.create.mock.calls[0][0].thinking).toBeUndefined();
  });
});

// ===========================================================================
// Streaming event conversion
// ===========================================================================

describe('AnthropicClient streaming', () => {
  it('maps a full text + tool_use stream to ResponseEvents', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, cache_read_input_tokens: 2 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"SF"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } },
      { type: 'message_stop' },
    ];
    mocks.create.mockReturnValue(asyncStreamFrom(events));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: undefined }));

    const stream = await client.stream(userPrompt('weather?'));
    const out = await collectEvents(stream);

    expect(out[0]).toEqual({ type: 'Created' });
    expect(out.filter(e => e.type === 'OutputTextDelta').map(e => e.delta)).toEqual(['Hello', ' world']);

    const itemDones = out.filter(e => e.type === 'OutputItemDone').map(e => e.item);
    expect(itemDones[0]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello world' }],
    });
    expect(itemDones[1]).toEqual({
      type: 'function_call',
      id: 'toolu_1',
      name: 'get_weather',
      arguments: '{"city":"SF"}',
      call_id: 'toolu_1',
    });

    const completed = out.find(e => e.type === 'Completed');
    expect(completed.responseId).toBe('msg_1');
    expect(completed.tokenUsage).toEqual({
      input_tokens: 12,
      cached_input_tokens: 2,
      output_tokens: 25,
      reasoning_output_tokens: 0,
      total_tokens: 37,
    });
  });

  it('maps thinking deltas to ReasoningContentDelta and a reasoning item', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_stream' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    mocks.create.mockReturnValue(asyncStreamFrom(events));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: 'medium' }));

    const stream = await client.stream(userPrompt('hi'));
    const out = await collectEvents(stream);

    expect(out.filter(e => e.type === 'ReasoningContentDelta').map(e => e.delta)).toEqual(['Let me think']);
    const reasoningItem = out.find(e => e.type === 'OutputItemDone')?.item;
    expect(reasoningItem).toEqual({
      type: 'reasoning',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'Let me think' }],
      encrypted_content: 'sig_stream',
      encrypted_content_type: 'signature',
    });
  });

  it('preserves redacted thinking blocks from the stream', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_redacted', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque-data' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    mocks.create.mockReturnValue(asyncStreamFrom(events));
    const client = new AnthropicClient(defaultConfig({ reasoningEffort: 'medium' }));

    const stream = await client.stream(userPrompt('hi'));
    const out = await collectEvents(stream);

    const reasoningItem = out.find(e => e.type === 'OutputItemDone')?.item;
    expect(reasoningItem).toEqual({
      type: 'reasoning',
      summary: [],
      content: [],
      encrypted_content: 'opaque-data',
      encrypted_content_type: 'redacted_thinking',
    });
  });
});

// ===========================================================================
// Non-streaming completion
// ===========================================================================

describe('AnthropicClient.complete', () => {
  it('returns a normalized completion response', async () => {
    mocks.create.mockResolvedValue({
      id: 'msg_3',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hi there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const client = new AnthropicClient(defaultConfig());

    const result = await client.complete({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    expect(result.id).toBe('msg_3');
    expect(result.choices[0].message.content).toBe('Hi there');
    expect(result.choices[0].finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });

    const params = mocks.create.mock.calls[0][0];
    expect(params.system).toBe('Be brief.');
    expect(params.stream).toBe(false);
    expect(params.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });
});
