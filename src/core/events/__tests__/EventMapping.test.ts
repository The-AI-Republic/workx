/**
 * Tests for EventMapping — ResponseItem to EventMsg conversion
 */

import { describe, it, expect } from 'vitest';
import { mapResponseItemToEventMessages } from '@/core/events/EventMapping';
import type { ResponseItem } from '@/core/protocol/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand: call mapper with showRawAgentReasoning = false */
function map(item: ResponseItem): ReturnType<typeof mapResponseItemToEventMessages> {
  return mapResponseItemToEventMessages(item, false);
}

/** Shorthand: call mapper with showRawAgentReasoning = true */
function mapRaw(item: ResponseItem): ReturnType<typeof mapResponseItemToEventMessages> {
  return mapResponseItemToEventMessages(item, true);
}

// ---------------------------------------------------------------------------
// message type
// ---------------------------------------------------------------------------

describe('mapResponseItemToEventMessages', () => {
  describe('message items', () => {
    it('returns empty array for system role messages', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'system',
        content: [{ type: 'text', text: 'system prompt' }],
      };
      expect(map(item)).toEqual([]);
    });

    it('maps a plain text content item to UserMessage', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'hello world' }],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'UserMessage',
        data: { message: 'hello world', kind: 'plain', images: undefined },
      });
    });

    it('maps input_text content to UserMessage the same as text', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'input text content' }],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('UserMessage');
      expect((result[0] as any).data.message).toBe('input text content');
      expect((result[0] as any).data.kind).toBe('plain');
    });

    it('detects environment_context kind from text prefix', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: '<environment_context>some context</environment_context>' }],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect((result[0] as any).data.kind).toBe('environment_context');
    });

    it('detects environment_context kind even with leading whitespace', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: '   <environment_context>context</environment_context>' }],
      };
      const result = map(item);
      expect((result[0] as any).data.kind).toBe('environment_context');
    });

    it('detects user_instructions kind from text prefix', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: '<user_instructions>do this</user_instructions>' }],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect((result[0] as any).data.kind).toBe('user_instructions');
    });

    it('detects user_instructions kind with leading whitespace', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: '\n  <user_instructions>instructions</user_instructions>' }],
      };
      const result = map(item);
      expect((result[0] as any).data.kind).toBe('user_instructions');
    });

    it('concatenates multiple text parts into a single UserMessage', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect((result[0] as any).data.message).toBe('part one part two');
    });

    it('sets kind based only on the first text content item', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'plain text first' },
          { type: 'text', text: '<environment_context>should not change kind</environment_context>' },
        ],
      };
      const result = map(item);
      expect((result[0] as any).data.kind).toBe('plain');
    });

    it('maps output_text content to AgentMessage', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will help you.' }],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'AgentMessage',
        data: { message: 'I will help you.' },
      });
    });

    it('maps multiple output_text items to multiple AgentMessages', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'First part.' },
          { type: 'output_text', text: 'Second part.' },
        ],
      };
      const result = map(item);
      expect(result).toHaveLength(2);
      expect(result[0]!.type).toBe('AgentMessage');
      expect(result[1]!.type).toBe('AgentMessage');
    });

    it('maps input_image to UserMessage with images array', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect((result[0] as any).data.images).toEqual(['data:image/png;base64,abc']);
      expect((result[0] as any).data.message).toBe('');
    });

    it('maps multiple images into a single UserMessage', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'img1.png' },
          { type: 'input_image', image_url: 'img2.png' },
        ],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect((result[0] as any).data.images).toEqual(['img1.png', 'img2.png']);
    });

    it('combines text and images into a single UserMessage', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'input_image', image_url: 'screenshot.png' },
        ],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect((result[0] as any).data.message).toBe('Look at this');
      expect((result[0] as any).data.images).toEqual(['screenshot.png']);
    });

    it('produces both AgentMessage and UserMessage when content has output_text and text', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Agent reply' },
          { type: 'text', text: 'Additional text' },
        ],
      };
      const result = map(item);
      expect(result).toHaveLength(2);
      expect(result[0]!.type).toBe('AgentMessage');
      expect(result[1]!.type).toBe('UserMessage');
    });

    it('returns empty array for message with empty content array', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [],
      };
      const result = map(item);
      expect(result).toEqual([]);
    });

    it('sets images to undefined when there are no images', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'no images here' }],
      };
      const result = map(item);
      expect((result[0] as any).data.images).toBeUndefined();
    });

    it('sets kind to null when there are only images and no text', () => {
      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'img.png' }],
      };
      const result = map(item);
      expect((result[0] as any).data.kind).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // reasoning type
  // ---------------------------------------------------------------------------

  describe('reasoning items', () => {
    it('maps summary_text items to AgentReasoning events', () => {
      const item: ResponseItem = {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Thinking about the problem...' }],
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'AgentReasoning',
        data: { content: 'Thinking about the problem...' },
      });
    });

    it('maps multiple summary items to multiple AgentReasoning events', () => {
      const item: ResponseItem = {
        type: 'reasoning',
        summary: [
          { type: 'summary_text', text: 'Step 1' },
          { type: 'summary_text', text: 'Step 2' },
        ],
      };
      const result = map(item);
      expect(result).toHaveLength(2);
      expect(result[0]!.type).toBe('AgentReasoning');
      expect(result[1]!.type).toBe('AgentReasoning');
    });

    it('omits raw reasoning content when showRawAgentReasoning is false', () => {
      const item: ResponseItem = {
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'raw thinking' }],
      };
      const result = map(item);
      // No AgentReasoningRawContent events
      expect(result.filter(e => e.type === 'AgentReasoningRawContent')).toHaveLength(0);
    });

    it('includes raw reasoning content when showRawAgentReasoning is true', () => {
      const item: ResponseItem = {
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'raw thinking' }],
      };
      const result = mapRaw(item);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'AgentReasoningRawContent',
        data: { content: 'raw thinking' },
      });
    });

    it('handles content with type "text" as raw reasoning', () => {
      const item: ResponseItem = {
        type: 'reasoning',
        summary: [],
        content: [{ type: 'text', text: 'text-type reasoning' }],
      };
      const result = mapRaw(item);
      expect(result).toHaveLength(1);
      expect((result[0] as any).data.content).toBe('text-type reasoning');
    });

    it('produces both summary and raw content events when showRawAgentReasoning is true', () => {
      const item: ResponseItem = {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Summary' }],
        content: [{ type: 'reasoning_text', text: 'Detailed reasoning' }],
      };
      const result = mapRaw(item);
      expect(result).toHaveLength(2);
      expect(result[0]!.type).toBe('AgentReasoning');
      expect(result[1]!.type).toBe('AgentReasoningRawContent');
    });

    it('returns empty array for reasoning with empty summary and no content', () => {
      const item: ResponseItem = {
        type: 'reasoning',
        summary: [],
      };
      const result = map(item);
      expect(result).toEqual([]);
    });

    it('returns empty array for reasoning with empty summary and content when showRaw is false', () => {
      const item: ResponseItem = {
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'hidden' }],
      };
      const result = map(item);
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // web_search_call type
  // ---------------------------------------------------------------------------

  describe('web_search_call items', () => {
    it('maps search action to WebSearchEnd event', () => {
      const item: ResponseItem = {
        type: 'web_search_call',
        id: 'ws-123',
        action: { type: 'search', query: 'vitest testing' },
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'WebSearchEnd',
        data: { call_id: 'ws-123', query: 'vitest testing' },
      });
    });

    it('uses empty string for call_id when id is undefined', () => {
      const item: ResponseItem = {
        type: 'web_search_call',
        action: { type: 'search', query: 'test query' },
      };
      const result = map(item);
      expect(result).toHaveLength(1);
      expect((result[0] as any).data.call_id).toBe('');
    });

    it('returns empty array for non-search action type', () => {
      const item: ResponseItem = {
        type: 'web_search_call',
        id: 'ws-456',
        action: { type: 'other' },
      };
      const result = map(item);
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Types that return empty arrays
  // ---------------------------------------------------------------------------

  describe('items that return empty arrays', () => {
    it('returns empty array for function_call', () => {
      const item: ResponseItem = {
        type: 'function_call',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
        call_id: 'fc-1',
      };
      expect(map(item)).toEqual([]);
    });

    it('returns empty array for function_call_output', () => {
      const item: ResponseItem = {
        type: 'function_call_output',
        call_id: 'fc-1',
        output: '{"temp":72}',
      };
      expect(map(item)).toEqual([]);
    });

    it('returns empty array for local_shell_call', () => {
      const item: ResponseItem = {
        type: 'local_shell_call',
        status: 'completed',
        action: { type: 'exec', command: ['ls', '-la'] },
      };
      expect(map(item)).toEqual([]);
    });

    it('returns empty array for custom_tool_call', () => {
      const item: ResponseItem = {
        type: 'custom_tool_call',
        call_id: 'ct-1',
        name: 'my_tool',
        input: '{}',
      };
      expect(map(item)).toEqual([]);
    });

    it('returns empty array for custom_tool_call_output', () => {
      const item: ResponseItem = {
        type: 'custom_tool_call_output',
        call_id: 'ct-1',
        output: 'result',
      };
      expect(map(item)).toEqual([]);
    });

    it('returns empty array for other type', () => {
      const item: ResponseItem = { type: 'other' };
      expect(map(item)).toEqual([]);
    });
  });
});
