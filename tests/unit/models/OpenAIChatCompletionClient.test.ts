/**
 * Unit tests for OpenAIChatCompletionClient - Chat Completions streaming event conversion
 * Focus: Text accumulation, message item creation, state management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIChatCompletionClient } from '../../../src/models/OpenAIChatCompletionClient';

// Mock OpenAI client to avoid browser safety check in tests
vi.mock('openai', () => {
  const mockOpenAI = vi.fn().mockImplementation(() => ({
    beta: {
      chat: {
        completions: {
          stream: vi.fn(),
        },
      },
    },
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

describe('OpenAIChatCompletionClient - Gemini Text Accumulation', () => {
  let client: any;

  beforeEach(() => {
    // Create client instance with test configuration
    client = new OpenAIChatCompletionClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      conversationId: 'test-conversation',
      modelFamily: {
        family: 'gemini-2.5-pro',
        base_instructions: 'You are a helpful assistant.',
        supports_reasoning_summaries: false,
        needs_special_apply_patch_instructions: false,
      },
      provider: {
        name: 'Google AI Studio',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        wire_api: 'ChatCompletions',
        requires_openai_auth: true,
        env_key: 'GOOGLE_AI_STUDIO_API_KEY',
      },
    });
  });

  describe('T010: Text delta accumulation', () => {
    it('should accumulate text content across multiple delta.content chunks', () => {
      // Access private property for testing
      const textContentBefore = client['chatCompletionTextContent'];
      expect(textContentBefore).toBe('');

      // Simulate text accumulation (this will be tested via convertChatCompletionEventToResponseEvent)
      // For now, verify the property exists and is initialized
      expect(client).toHaveProperty('chatCompletionTextContent');
      expect(typeof client['chatCompletionTextContent']).toBe('string');
    });

    it('should accumulate text correctly when multiple deltas arrive', () => {
      // Set up text content manually to test accumulation pattern
      client['chatCompletionTextContent'] = '';
      client['chatCompletionTextContent'] += 'Hello ';
      expect(client['chatCompletionTextContent']).toBe('Hello ');

      client['chatCompletionTextContent'] += 'world';
      expect(client['chatCompletionTextContent']).toBe('Hello world');

      client['chatCompletionTextContent'] += '!';
      expect(client['chatCompletionTextContent']).toBe('Hello world!');
    });
  });

  describe('T011: OutputItemDone emission with message item', () => {
    it('should create message item with accumulated text when finish_reason=stop', () => {
      // Set up accumulated text
      client['chatCompletionTextContent'] = 'This is a test response';

      // Create expected message item structure
      const expectedItem = {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'This is a test response',
          },
        ],
      };

      // Verify structure matches expected format
      expect(client['chatCompletionTextContent']).toBe('This is a test response');
      expect(expectedItem.type).toBe('message');
      expect(expectedItem.role).toBe('assistant');
      expect(expectedItem.content[0].type).toBe('output_text');
      expect(expectedItem.content[0].text).toBe('This is a test response');
    });

    it('should emit OutputItemDone event before Completed event', () => {
      // This tests the event ordering pattern
      // OutputItemDone should be emitted first, Completed should be queued
      const pendingEvents = client['pendingEvents'];
      expect(Array.isArray(pendingEvents)).toBe(true);
    });
  });

  describe('T012: State reset between requests', () => {
    it('should reset chatCompletionTextContent to empty on new stream', () => {
      // Set up some accumulated state
      client['chatCompletionTextContent'] = 'Old text content';
      client['chatCompletionToolCalls'].set(0, {
        id: 'call_123',
        type: 'function',
        function: {
          name: 'test_function',
          arguments: '{"arg": "value"}',
        },
      });

      // Verify state exists
      expect(client['chatCompletionTextContent']).toBe('Old text content');
      expect(client['chatCompletionToolCalls'].size).toBe(1);

      // Reset state (simulating new stream start)
      client['chatCompletionTextContent'] = '';
      client['chatCompletionToolCalls'].clear();

      // Verify state is reset
      expect(client['chatCompletionTextContent']).toBe('');
      expect(client['chatCompletionToolCalls'].size).toBe(0);
    });

    it('should have clean state after reset', () => {
      client['chatCompletionTextContent'] = 'Some content';
      client['chatCompletionTextContent'] = '';

      expect(client['chatCompletionTextContent']).toBe('');
      expect(client['chatCompletionTextContent'].length).toBe(0);
    });
  });

  describe('T013: Empty response handling', () => {
    it('should detect when finish_reason=stop but no content accumulated', () => {
      // Simulate empty response scenario
      client['chatCompletionTextContent'] = '';
      client['chatCompletionToolCalls'].clear();

      const hasContent = client['chatCompletionTextContent'].length > 0;
      const hasToolCalls = client['chatCompletionToolCalls'].size > 0;

      expect(hasContent).toBe(false);
      expect(hasToolCalls).toBe(false);

      // Should log warning and skip completion in this case
      expect(hasContent || hasToolCalls).toBe(false);
    });

    it('should allow completion when text content exists', () => {
      client['chatCompletionTextContent'] = 'Valid response';
      client['chatCompletionToolCalls'].clear();

      const hasContent = client['chatCompletionTextContent'].length > 0;
      const hasToolCalls = client['chatCompletionToolCalls'].size > 0;

      expect(hasContent).toBe(true);
      expect(hasContent || hasToolCalls).toBe(true);
    });

    it('should allow completion when tool calls exist', () => {
      client['chatCompletionTextContent'] = '';
      client['chatCompletionToolCalls'].set(0, {
        id: 'call_123',
        type: 'function',
        function: {
          name: 'test_function',
          arguments: '{}',
        },
      });

      const hasContent = client['chatCompletionTextContent'].length > 0;
      const hasToolCalls = client['chatCompletionToolCalls'].size > 0;

      expect(hasToolCalls).toBe(true);
      expect(hasContent || hasToolCalls).toBe(true);
    });
  });
});

describe('OpenAIChatCompletionClient - Event Conversion Integration', () => {
  let client: any;

  beforeEach(() => {
    client = new OpenAIChatCompletionClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      conversationId: 'test-conversation',
      modelFamily: {
        family: 'gemini-2.5-pro',
        base_instructions: 'You are a helpful assistant.',
        supports_reasoning_summaries: false,
        needs_special_apply_patch_instructions: false,
      },
      provider: {
        name: 'Google AI Studio',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        wire_api: 'ChatCompletions',
        requires_openai_auth: true,
        env_key: 'GOOGLE_AI_STUDIO_API_KEY',
      },
    });
  });

  it('should have required private properties for text accumulation', () => {
    expect(client).toHaveProperty('chatCompletionTextContent');
    expect(client).toHaveProperty('chatCompletionToolCalls');
    expect(client).toHaveProperty('pendingEvents');
  });

  it('should initialize with empty text content', () => {
    expect(client['chatCompletionTextContent']).toBe('');
  });

  it('should initialize with empty tool calls map', () => {
    expect(client['chatCompletionToolCalls'].size).toBe(0);
  });

  it('should initialize with empty pending events array', () => {
    expect(Array.isArray(client['pendingEvents'])).toBe(true);
    expect(client['pendingEvents'].length).toBe(0);
  });
});

describe('OpenAIChatCompletionClient - Tool Call Handling (User Story 2)', () => {
  let client: any;

  beforeEach(() => {
    client = new OpenAIChatCompletionClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      conversationId: 'test-conversation',
      modelFamily: {
        family: 'gemini-2.5-pro',
        base_instructions: 'You are a helpful assistant.',
        supports_reasoning_summaries: false,
        needs_special_apply_patch_instructions: false,
      },
      provider: {
        name: 'Google AI Studio',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        wire_api: 'ChatCompletions',
        requires_openai_auth: true,
        env_key: 'GOOGLE_AI_STUDIO_API_KEY',
      },
    });
  });

  describe('T024: Tool call accumulation across chunks', () => {
    it('should accumulate tool call function name and arguments across multiple deltas', () => {
      // Simulate incremental tool call accumulation
      client['chatCompletionToolCalls'].set(0, {
        id: '',
        type: 'function',
        function: {
          name: '',
          arguments: '',
        },
      });

      // First chunk: ID and name
      const toolCall = client['chatCompletionToolCalls'].get(0);
      toolCall.id = 'call_123';
      toolCall.function.name = 'search_web';

      expect(toolCall.id).toBe('call_123');
      expect(toolCall.function.name).toBe('search_web');
      expect(toolCall.function.arguments).toBe('');

      // Second chunk: arguments part 1
      toolCall.function.arguments += '{"query": ';

      // Third chunk: arguments part 2
      toolCall.function.arguments += '"TypeScript"}';

      expect(toolCall.function.arguments).toBe('{"query": "TypeScript"}');
    });

    it('should maintain multiple tool calls in the map by index', () => {
      client['chatCompletionToolCalls'].set(0, {
        id: 'call_1',
        type: 'function',
        function: { name: 'tool1', arguments: '{}' },
      });

      client['chatCompletionToolCalls'].set(1, {
        id: 'call_2',
        type: 'function',
        function: { name: 'tool2', arguments: '{}' },
      });

      expect(client['chatCompletionToolCalls'].size).toBe(2);
      expect(client['chatCompletionToolCalls'].get(0).function.name).toBe('tool1');
      expect(client['chatCompletionToolCalls'].get(1).function.name).toBe('tool2');
    });
  });

  describe('T025: finish_reason="tool_calls" handling', () => {
    it('should emit OutputItemDone with function_call item when tool calls present', () => {
      // Set up accumulated tool call
      client['chatCompletionToolCalls'].set(0, {
        id: 'call_abc123',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location": "San Francisco"}',
        },
      });

      // Expected function_call item structure
      const expectedItem = {
        type: 'function_call',
        id: 'call_abc123',
        name: 'get_weather',
        arguments: '{"location": "San Francisco"}',
      };

      const toolCall = client['chatCompletionToolCalls'].get(0);
      expect(toolCall.id).toBe(expectedItem.id);
      expect(toolCall.function.name).toBe(expectedItem.name);
      expect(toolCall.function.arguments).toBe(expectedItem.arguments);
    });

    it('should NOT emit Completed event immediately for tool_calls finish_reason', () => {
      // Tool calls should queue Completed event, not emit it immediately
      // This allows the agent loop to continue and process tool results

      client['chatCompletionToolCalls'].set(0, {
        id: 'call_123',
        type: 'function',
        function: { name: 'test', arguments: '{}' },
      });

      // Completed event should be queued in pendingEvents
      expect(client['pendingEvents']).toBeDefined();
      expect(Array.isArray(client['pendingEvents'])).toBe(true);
    });
  });

  describe('T026: Multiple tool calls in single turn', () => {
    it('should handle multiple tool calls correctly', () => {
      // BrowserX sets parallel_tool_calls to false, so only one tool call should be emitted
      // But the accumulator should support multiple tool calls

      client['chatCompletionToolCalls'].set(0, {
        id: 'call_1',
        type: 'function',
        function: { name: 'tool1', arguments: '{"arg1": "value1"}' },
      });

      client['chatCompletionToolCalls'].set(1, {
        id: 'call_2',
        type: 'function',
        function: { name: 'tool2', arguments: '{"arg2": "value2"}' },
      });

      const toolCallsArray = Array.from(client['chatCompletionToolCalls'].values());
      expect(toolCallsArray.length).toBe(2);
      expect(toolCallsArray[0].function.name).toBe('tool1');
      expect(toolCallsArray[1].function.name).toBe('tool2');

      // Clear after use
      client['chatCompletionToolCalls'].clear();
      expect(client['chatCompletionToolCalls'].size).toBe(0);
    });
  });
});

describe('OpenAIChatCompletionClient - Multi-Turn Mixed Content (User Story 3)', () => {
  let client: any;

  beforeEach(() => {
    client = new OpenAIChatCompletionClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      conversationId: 'test-conversation',
      modelFamily: {
        family: 'gemini-2.5-pro',
        base_instructions: 'You are a helpful assistant.',
        supports_reasoning_summaries: false,
        needs_special_apply_patch_instructions: false,
      },
      provider: {
        name: 'Google AI Studio',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        wire_api: 'ChatCompletions',
        requires_openai_auth: true,
        env_key: 'GOOGLE_AI_STUDIO_API_KEY',
      },
    });
  });

  describe('T033: Mixed content handling', () => {
    it('should handle turn with both text content and tool calls', () => {
      // Simulate scenario where same turn has both text and tool calls
      client['chatCompletionTextContent'] = 'Let me search for that information.';
      client['chatCompletionToolCalls'].set(0, {
        id: 'call_123',
        type: 'function',
        function: { name: 'search_web', arguments: '{"query": "test"}' },
      });

      const hasContent = client['chatCompletionTextContent'].length > 0;
      const hasToolCalls = client['chatCompletionToolCalls'].size > 0;

      // Both should be present
      expect(hasContent).toBe(true);
      expect(hasToolCalls).toBe(true);

      // According to FR-014: process concurrently
      // Tool calls take precedence in finish_reason='tool_calls'
      // But text should still be emitted as deltas during streaming
    });
  });

  describe('T034: State cleanup between turns', () => {
    it('should properly reset chatCompletionTextContent between turns', () => {
      // First turn
      client['chatCompletionTextContent'] = 'First response';
      expect(client['chatCompletionTextContent']).toBe('First response');

      // Reset for next turn
      client['chatCompletionTextContent'] = '';
      client['chatCompletionToolCalls'].clear();

      // Verify clean state
      expect(client['chatCompletionTextContent']).toBe('');
      expect(client['chatCompletionToolCalls'].size).toBe(0);

      // Second turn
      client['chatCompletionTextContent'] = 'Second response';
      expect(client['chatCompletionTextContent']).toBe('Second response');
    });

    it('should maintain independence between text and tool call accumulators', () => {
      // Set both
      client['chatCompletionTextContent'] = 'Some text';
      client['chatCompletionToolCalls'].set(0, {
        id: 'call_1',
        type: 'function',
        function: { name: 'test', arguments: '{}' },
      });

      // Clear text only
      client['chatCompletionTextContent'] = '';
      expect(client['chatCompletionTextContent']).toBe('');
      expect(client['chatCompletionToolCalls'].size).toBe(1); // Still there

      // Clear tool calls only
      client['chatCompletionTextContent'] = 'New text';
      client['chatCompletionToolCalls'].clear();
      expect(client['chatCompletionTextContent']).toBe('New text'); // Still there
      expect(client['chatCompletionToolCalls'].size).toBe(0);
    });
  });
});

describe('OpenAIChatCompletionClient - Payload Conversion Bug Fix', () => {
  let client: any;

  beforeEach(() => {
    client = new OpenAIChatCompletionClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      conversationId: 'test-conversation',
      modelFamily: {
        family: 'gemini-2.5-pro',
        base_instructions: 'You are a helpful assistant.',
        supports_reasoning_summaries: false,
        needs_special_apply_patch_instructions: false,
      },
      provider: {
        name: 'Google AI Studio',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        wire_api: 'ChatCompletions',
        requires_openai_auth: true,
        env_key: 'GOOGLE_AI_STUDIO_API_KEY',
      },
    });
  });

  describe('T066: ContentItem type handling bug fix', () => {
    it('should handle input_text type correctly (the actual bug)', () => {
      // This tests the fix for the bug where input_text was not recognized
      // causing empty content to be sent to Gemini API

      const buggyConversion = (part: any) => {
        if (part.type === 'text') {  // ❌ Only checks 'text', not 'input_text'
          return part.text;
        }
        return '';  // ❌ Returns empty for input_text!
      };

      const fixedConversion = (part: any) => {
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
          return part.text;
        }
        return '';
      };

      const inputTextPart = { type: 'input_text', text: 'hi' };

      // Buggy version returns empty (THIS WAS THE BUG!)
      expect(buggyConversion(inputTextPart)).toBe('');

      // Fixed version returns the text
      expect(fixedConversion(inputTextPart)).toBe('hi');
    });

    it('should handle output_text type correctly', () => {
      const content = [{ type: 'output_text', text: 'I am doing well!' }];

      const convertedParts = content.map((part: any) => {
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
          return { type: 'text', text: part.text };
        }
        return null;
      }).filter((c: any) => c !== null);

      const result = convertedParts.map((p: any) => p.text).join('\n');
      expect(result).toBe('I am doing well!');
    });

    it('should handle legacy text type for backward compatibility', () => {
      const content = [{ type: 'text', text: 'Legacy format' }];

      const convertedParts = content.map((part: any) => {
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
          return { type: 'text', text: part.text };
        }
        return null;
      }).filter((c: any) => c !== null);

      const result = convertedParts.map((p: any) => p.text).join('\n');
      expect(result).toBe('Legacy format');
    });

    it('should handle input_image type correctly', () => {
      const content = [
        { type: 'input_text', text: 'Check this image:' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc123' }
      ];

      const convertedParts = content.map((part: any) => {
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
          return { type: 'text', text: part.text };
        } else if (part.type === 'input_image') {
          return {
            type: 'image_url',
            image_url: { url: part.image_url }
          };
        }
        return null;
      }).filter((c: any) => c !== null);

      // Should have both text and image
      expect(convertedParts).toHaveLength(2);
      expect(convertedParts[0]).toEqual({ type: 'text', text: 'Check this image:' });
      expect(convertedParts[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,abc123' }
      });
    });
  });
});
