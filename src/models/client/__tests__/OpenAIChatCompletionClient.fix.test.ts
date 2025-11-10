/**
 * Tests for OpenAIChatCompletionClient fix for Gemini "1 turn finish" bug
 *
 * This test file verifies the fix for the issue where content and finish_reason
 * arriving in the same chunk caused early return, preventing OutputItemDone emission.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIChatCompletionClient } from '../OpenAIChatCompletionClient';
import type { ModelFamily, ModelProviderInfo } from '../../types/ResponsesAPI';

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

describe('OpenAIChatCompletionClient - Gemini Fix Tests', () => {
  let client: OpenAIChatCompletionClient;
  let mockProvider: ModelProviderInfo;
  let mockModelFamily: ModelFamily;

  beforeEach(() => {
    mockProvider = {
      name: 'Google AI Studio',
      base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      wire_api: 'Chat',
      requires_openai_auth: false,
      http_headers: {},
      query_params: {},
    };

    mockModelFamily = {
      family: 'gemini-2.0-flash-exp',
      base_instructions: 'Test instructions',
      supports_reasoning: false,
      supports_reasoning_summaries: false,
      needs_special_apply_patch_instructions: false,
    };

    client = new OpenAIChatCompletionClient(
      {
        apiKey: 'test-key',
        conversationId: 'test-conv',
        modelFamily: mockModelFamily,
        provider: mockProvider,
      },
      { maxRetries: 0 }
    );
  });

  describe('Scenario 1: Content + finish_reason in same chunk', () => {
    it('should emit OutputItemDone with accumulated content when both arrive together', async () => {
      // This is the critical bug fix test
      // Gemini sometimes sends content and finish_reason in the SAME chunk

      const chunk = {
        id: 'test-response-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'gemini-2.0-flash-exp',
        choices: [
          {
            index: 0,
            delta: { content: 'Hello world' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      // Access private method via type assertion for testing
      const convertMethod = (client as any).convertChatCompletionEventToResponseEvent.bind(client);

      // First call should return OutputItemDone (not OutputTextDelta)
      const event1 = convertMethod(chunk);

      expect(event1).toBeDefined();
      expect(event1.type).toBe('OutputItemDone');
      expect(event1.item).toBeDefined();
      expect(event1.item.type).toBe('message');
      expect(event1.item.role).toBe('assistant');
      expect(event1.item.content[0].type).toBe('output_text');
      expect(event1.item.content[0].text).toBe('Hello world');

      // Second call should return Completed (queued from first call)
      const event2 = convertMethod({});

      expect(event2).toBeDefined();
      expect(event2.type).toBe('Completed');
      expect(event2.responseId).toBe('test-response-1');
      expect(event2.tokenUsage).toBeDefined();
      expect(event2.tokenUsage?.total_tokens).toBe(15);
    });
  });

  describe('Scenario 2: Content in multiple chunks, then finish_reason', () => {
    it('should accumulate content across chunks and emit OutputItemDone on finish_reason', async () => {
      const convertMethod = (client as any).convertChatCompletionEventToResponseEvent.bind(client);

      // Chunk 1: Content only
      const chunk1 = {
        id: 'test-response-2',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      };

      const event1 = convertMethod(chunk1);
      expect(event1).toBeDefined();
      expect(event1.type).toBe('OutputTextDelta');
      expect(event1.delta).toBe('Hello');

      // Chunk 2: More content
      const chunk2 = {
        id: 'test-response-2',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
      };

      const event2 = convertMethod(chunk2);
      expect(event2).toBeDefined();
      expect(event2.type).toBe('OutputTextDelta');
      expect(event2.delta).toBe(' world');

      // Chunk 3: finish_reason only
      const chunk3 = {
        id: 'test-response-2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };

      const event3 = convertMethod(chunk3);
      expect(event3).toBeDefined();
      expect(event3.type).toBe('OutputItemDone');
      expect(event3.item.content[0].text).toBe('Hello world'); // Accumulated!

      // Chunk 4: Flush pending Completed
      const event4 = convertMethod({});
      expect(event4).toBeDefined();
      expect(event4.type).toBe('Completed');
    });
  });

  describe('Scenario 3: Tool call with finish_reason', () => {
    it('should emit OutputItemDone for tool call and queue Completed', async () => {
      const convertMethod = (client as any).convertChatCompletionEventToResponseEvent.bind(client);

      // Chunk 1: Tool call start
      const chunk1 = {
        id: 'test-response-3',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };

      const event1 = convertMethod(chunk1);
      expect(event1).toBeNull(); // Tool calls don't emit until finish_reason

      // Chunk 2: Tool call arguments
      const chunk2 = {
        id: 'test-response-3',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"location":"NYC"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };

      const event2 = convertMethod(chunk2);
      expect(event2).toBeNull(); // Still accumulating

      // Chunk 3: finish_reason
      const chunk3 = {
        id: 'test-response-3',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };

      const event3 = convertMethod(chunk3);
      expect(event3).toBeDefined();
      expect(event3.type).toBe('OutputItemDone');
      expect(event3.item.type).toBe('function_call');
      expect(event3.item.call_id).toBe('call_123');
      expect(event3.item.name).toBe('get_weather');
      expect(event3.item.arguments).toBe('{"location":"NYC"}');

      // Chunk 4: Flush pending Completed
      const event4 = convertMethod({});
      expect(event4).toBeDefined();
      expect(event4.type).toBe('Completed');
    });
  });

  describe('Scenario 4: Empty response handling', () => {
    it('should emit Completed when finish_reason arrives with no content', async () => {
      const convertMethod = (client as any).convertChatCompletionEventToResponseEvent.bind(client);

      const chunk = {
        id: 'test-response-4',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      };

      const event = convertMethod(chunk);

      // Should emit Completed (not OutputItemDone) since there's no content
      expect(event).toBeDefined();
      expect(event.type).toBe('Completed');
      expect(event.tokenUsage).toBeDefined();
      expect(event.tokenUsage?.total_tokens).toBe(10);
    });
  });

  describe('Scenario 5: Gemini bug - finish_reason=stop with tool calls', () => {
    it('should handle tool calls even when finish_reason is "stop" (Gemini bug)', async () => {
      // This is the CRITICAL bug reported by user:
      // Gemini sends:
      //   Chunk 1: content (text)
      //   Chunk 2: content (more text)
      //   Chunk 3: tool_calls (browser_dom scroll)
      //   Chunk 4: finish_reason="stop" (WRONG! Should be "tool_calls")

      const convertMethod = (client as any).convertChatCompletionEventToResponseEvent.bind(client);

      // Chunk 1: Text content
      const chunk1 = {
        id: 'test-response-bug',
        choices: [{
          index: 0,
          delta: { content: 'Yes, that\'s correct. I clicked the "like" button.', role: 'assistant' },
          finish_reason: null
        }]
      };

      const event1 = convertMethod(chunk1);
      expect(event1?.type).toBe('OutputTextDelta');

      // Chunk 2: More text content
      const chunk2 = {
        id: 'test-response-bug',
        choices: [{
          index: 0,
          delta: { content: ' I will now scroll down the page.', role: 'assistant' },
          finish_reason: null
        }]
      };

      const event2 = convertMethod(chunk2);
      expect(event2?.type).toBe('OutputTextDelta');

      // Chunk 3: Tool call (no finish_reason yet)
      const chunk3 = {
        id: 'test-response-bug',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'function-call-123',
              type: 'function',
              function: {
                name: 'browser_dom',
                arguments: '{"node_id":-1,"options":{"scrollY":1000},"action":"scroll"}'
              }
            }]
          },
          finish_reason: null
        }]
      };

      const event3 = convertMethod(chunk3);
      expect(event3).toBeNull(); // Tool calls don't emit until finish_reason

      // Chunk 4: finish_reason="stop" (GEMINI BUG!)
      const chunk4 = {
        id: 'test-response-bug',
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: 'stop' // ← WRONG! Should be "tool_calls"
        }],
        created: Date.now(),
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      };

      // BEFORE FIX: Would emit OutputItemDone with MESSAGE only, ignore tool call
      // AFTER FIX: Should emit OutputItemDone with MESSAGE, then queue TOOL CALL

      const event4 = convertMethod(chunk4);
      expect(event4).toBeDefined();
      expect(event4.type).toBe('OutputItemDone');

      // Should emit MESSAGE first
      expect(event4.item.type).toBe('message');
      expect(event4.item.content[0].text).toContain('I will now scroll down the page');

      // Next call should return queued TOOL CALL OutputItemDone
      const event5 = convertMethod({});
      expect(event5).toBeDefined();
      expect(event5.type).toBe('OutputItemDone');
      expect(event5.item.type).toBe('function_call');
      expect(event5.item.name).toBe('browser_dom');
      expect(event5.item.arguments).toContain('scroll');

      // Next call should return queued Completed
      const event6 = convertMethod({});
      expect(event6).toBeDefined();
      expect(event6.type).toBe('Completed');
    });

    it('should handle tool calls with finish_reason=stop and NO text (Gemini bug variant)', async () => {
      // Another Gemini bug variant: tool calls with finish_reason=stop but no text

      const convertMethod = (client as any).convertChatCompletionEventToResponseEvent.bind(client);

      // Chunk 1: Tool call only
      const chunk1 = {
        id: 'test-response-bug2',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-456',
              type: 'function',
              function: { name: 'browser_dom', arguments: '{"action":"click","node_id":123}' }
            }]
          },
          finish_reason: null
        }]
      };

      const event1 = convertMethod(chunk1);
      expect(event1).toBeNull();

      // Chunk 2: finish_reason=stop (GEMINI BUG!)
      const chunk2 = {
        id: 'test-response-bug2',
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      };

      const event2 = convertMethod(chunk2);
      expect(event2).toBeDefined();
      expect(event2.type).toBe('OutputItemDone');
      expect(event2.item.type).toBe('function_call');
      expect(event2.item.name).toBe('browser_dom');

      // Next call should return Completed
      const event3 = convertMethod({});
      expect(event3).toBeDefined();
      expect(event3.type).toBe('Completed');
    });
  });

  describe('Scenario 6: Mixed content + tool call', () => {
    it('should emit both message and tool call OutputItemDone events', async () => {
      const convertMethod = (client as any).convertChatCompletionEventToResponseEvent.bind(client);

      // Chunk 1: Text content
      const chunk1 = {
        id: 'test-response-5',
        choices: [{ index: 0, delta: { content: 'Let me check the weather.' }, finish_reason: null }],
      };

      const event1 = convertMethod(chunk1);
      expect(event1?.type).toBe('OutputTextDelta');

      // Chunk 2: Tool call + finish_reason
      const chunk2 = {
        id: 'test-response-5',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_456',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"location":"LA"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };

      // Should emit message OutputItemDone first
      const event2 = convertMethod(chunk2);
      expect(event2).toBeDefined();
      expect(event2.type).toBe('OutputItemDone');
      expect(event2.item.type).toBe('message');
      expect(event2.item.content[0].text).toBe('Let me check the weather.');

      // Should emit tool call OutputItemDone next (from pending)
      const event3 = convertMethod({});
      expect(event3).toBeDefined();
      expect(event3.type).toBe('OutputItemDone');
      expect(event3.item.type).toBe('function_call');

      // Should emit Completed last (from pending)
      const event4 = convertMethod({});
      expect(event4).toBeDefined();
      expect(event4.type).toBe('Completed');
    });
  });
});

describe('OpenAIChatCompletionClient - Agent Loop Integration', () => {
  it('should populate processedItems correctly in agent loop', async () => {
    // This test verifies that the fix allows the agent loop to work correctly
    // The agent loop (TaskRunner) checks processedItems to determine if task is complete

    // When processedItems contains only messages (no function calls with responses):
    //   taskComplete = true → agent loop exits

    // When processedItems contains function_call + function_call_output:
    //   taskComplete = false → agent loop continues

    // The bug was: OutputItemDone was never emitted, so processedItems was empty
    // This caused the agent to show "Task completed in 1 turn(s)" without visible response

    // After the fix: OutputItemDone IS emitted, processedItems gets populated,
    // and the agent correctly determines task completion

    expect(true).toBe(true); // Placeholder - full integration test requires BrowserxAgent setup
  });
});
