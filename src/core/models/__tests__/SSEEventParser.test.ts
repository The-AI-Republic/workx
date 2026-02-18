import { describe, it, expect, beforeEach } from 'vitest';
import { SSEEventParser } from '../SSEEventParser';

describe('SSEEventParser', () => {
  let parser: SSEEventParser;

  beforeEach(() => {
    parser = new SSEEventParser();
  });

  describe('parse()', () => {
    it('should parse valid JSON SSE data', () => {
      const data = '{"type": "response.output_text.delta", "delta": "Hello"}';
      const result = parser.parse(data);

      expect(result).toEqual({
        type: 'response.output_text.delta',
        delta: 'Hello'
      });
    });

    it('should return null for empty data', () => {
      expect(parser.parse('')).toBeNull();
      expect(parser.parse('   ')).toBeNull();
    });

    it('should return null for malformed JSON', () => {
      const malformedData = '{"type": "response.output_text.delta", "delta": "Hello"';
      const result = parser.parse(malformedData);
      expect(result).toBeNull();
    });

    it('should parse complex SSE event with all fields', () => {
      const data = JSON.stringify({
        type: 'response.output_item.done',
        response: { id: 'test-response' },
        item: { type: 'text', content: 'Test content' },
        delta: 'delta-text'
      });

      const result = parser.parse(data);
      expect(result).toEqual({
        type: 'response.output_item.done',
        response: { id: 'test-response' },
        item: { type: 'text', content: 'Test content' },
        delta: 'delta-text'
      });
    });
  });

  describe('processEvent()', () => {
    it('should process output_item.done event', () => {
      const event = {
        type: 'response.output_item.done',
        item: { type: 'text', content: 'Hello world' }
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'OutputItemDone',
        item: { type: 'text', content: 'Hello world' }
      });
    });

    it('should process output_text.delta event', () => {
      const event = {
        type: 'response.output_text.delta',
        delta: 'Hello'
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'OutputTextDelta',
        delta: 'Hello'
      });
    });

    it('should process reasoning_summary_text.delta event', () => {
      const event = {
        type: 'response.reasoning_summary_text.delta',
        delta: 'Thinking about this...'
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'ReasoningSummaryDelta',
        delta: 'Thinking about this...'
      });
    });

    it('should process reasoning_text.delta event', () => {
      const event = {
        type: 'response.reasoning_text.delta',
        delta: 'The user is asking for...'
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'ReasoningContentDelta',
        delta: 'The user is asking for...'
      });
    });

    it('should process response.created event', () => {
      const event = {
        type: 'response.created',
        response: { id: 'test-response' }
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'Created'
      });
    });

    it('should process response.failed event with retry-after', () => {
      const event = {
        type: 'response.failed',
        response: {
          error: {
            code: 'rate_limit_exceeded',
            message: 'Rate limit reached. Please try again in 1.5s.'
          }
        }
      };

      // Failed events throw error
      expect(() => parser.processEvent(event)).toThrow('Rate limit reached. Please try again in 1.5s.');
    });

    it('should process response.completed event', () => {
      const event = {
        type: 'response.completed',
        response: {
          id: 'test-response',
          usage: { input_tokens: 100, output_tokens: 50 }
        }
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'Completed',
        responseId: 'test-response',
        tokenUsage: { input_tokens: 100, output_tokens: 50 }
      });
    });

    it('should process web_search_call in output_item.added event', () => {
      const event = {
        type: 'response.output_item.added',
        item: {
          type: 'web_search_call',
          id: 'call_abc123'
        }
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'WebSearchCallBegin',
        callId: 'call_abc123'
      });
    });

    it('should process reasoning_summary_part.added event', () => {
      const event = {
        type: 'response.reasoning_summary_part.added'
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'ReasoningSummaryPartAdded'
      });
    });

    it('should ignore explicitly ignored event types', () => {
      const ignoredTypes = [
        'response.content_part.done',
        'response.function_call_arguments.delta',
        'response.custom_tool_call_input.delta',
        'response.custom_tool_call_input.done',
        'response.in_progress',
        'response.output_text.done',
        'response.reasoning_summary_text.done'
      ];

      ignoredTypes.forEach(type => {
        const event = { type };
        const result = parser.processEvent(event);
        expect(result).toHaveLength(0);
      });
    });

    it('should handle unknown event types gracefully', () => {
      const event = {
        type: 'unknown.event.type'
      };

      const result = parser.processEvent(event);
      expect(result).toHaveLength(0);
    });

    it('should skip events with missing required data', () => {
      // Test output_text.delta without delta field
      const eventWithoutDelta = {
        type: 'response.output_text.delta'
      };
      expect(parser.processEvent(eventWithoutDelta)).toHaveLength(0);

      // Test output_item.done without item field
      const eventWithoutItem = {
        type: 'response.output_item.done'
      };
      expect(parser.processEvent(eventWithoutItem)).toHaveLength(0);
    });
  });

  describe('parseRetryAfter()', () => {
    it('should parse retry-after in seconds', () => {
      const error = {
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached for gpt-5 in organization <ORG> on tokens per min (TPM): Limit 30000, Used 6899, Requested 24050. Please try again in 1.898s. Visit https://platform.openai.com/account/rate-limits to learn more.'
      };

      const result = parser.parseRetryAfter(error);
      expect(result).toBe(1898);
    });

    it('should parse retry-after in milliseconds', () => {
      const error = {
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached for gpt-5 in organization org- on tokens per min (TPM): Limit 1, Used 1, Requested 19304. Please try again in 28ms. Visit https://platform.openai.com/account/rate-limits to learn more.'
      };

      const result = parser.parseRetryAfter(error);
      expect(result).toBe(28);
    });

    it('should return undefined for non-rate-limit errors', () => {
      const error = {
        code: 'invalid_request',
        message: 'Invalid request format'
      };

      const result = parser.parseRetryAfter(error);
      expect(result).toBeUndefined();
    });

    it('should return undefined for messages without retry pattern', () => {
      const error = {
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded but no specific timing'
      };

      const result = parser.parseRetryAfter(error);
      expect(result).toBeUndefined();
    });

    it('should handle decimal seconds correctly', () => {
      const error = {
        code: 'rate_limit_exceeded',
        message: 'Please try again in 2.5s'
      };

      const result = parser.parseRetryAfter(error);
      expect(result).toBe(2500);
    });

    it('should handle integer milliseconds correctly', () => {
      const error = {
        code: 'rate_limit_exceeded',
        message: 'Please try again in 500ms'
      };

      const result = parser.parseRetryAfter(error);
      expect(result).toBe(500);
    });
  });

  describe('handleMalformedEvent()', () => {
    it('should return null for malformed data (logs error)', () => {
      const rawData = '{"type": "invalid", "incomplete": ';
      const result = parser.handleMalformedEvent(rawData);

      expect(result).toBeNull();
    });

    it('should return null for very long raw data', () => {
      const longData = 'a'.repeat(300);
      const result = parser.handleMalformedEvent(longData);

      expect(result).toBeNull();
    });
  });

  describe('integration tests with mock SSE data', () => {
    it('should handle a complete SSE stream sequence', () => {
      const sseEvents = [
        '{"type": "response.created", "response": {"id": "resp_123"}}',
        '{"type": "response.output_text.delta", "delta": "Hello"}',
        '{"type": "response.output_text.delta", "delta": " world"}',
        '{"type": "response.output_item.done", "item": {"type": "text", "content": "Hello world"}}',
        '{"type": "response.completed", "response": {"id": "resp_123", "usage": {"total_tokens": 42}}}'
      ];

      const allEvents = [];
      for (const sseData of sseEvents) {
        const parsed = parser.parse(sseData);
        if (parsed) {
          const processed = parser.processEvent(parsed);
          allEvents.push(...processed);
        }
      }

      expect(allEvents).toHaveLength(5);
      expect(allEvents[0].type).toBe('Created');
      expect(allEvents[1].type).toBe('OutputTextDelta');
      expect((allEvents[1] as any).delta).toBe('Hello');
      expect(allEvents[2].type).toBe('OutputTextDelta');
      expect((allEvents[2] as any).delta).toBe(' world');
      expect(allEvents[3].type).toBe('OutputItemDone');
      expect(allEvents[4].type).toBe('Completed');
    });

    it('should handle mixed valid and invalid events', () => {
      const sseEvents = [
        '{"type": "response.created", "response": {"id": "resp_123"}}',
        '{"invalid": "json"', // Malformed JSON
        '{"type": "response.output_text.delta", "delta": "Hello"}',
        '', // Empty line
        '{"type": "unknown.event", "data": "ignored"}' // Unknown type
      ];

      const allEvents = [];
      for (const sseData of sseEvents) {
        const parsed = parser.parse(sseData);
        if (parsed) {
          const processed = parser.processEvent(parsed);
          allEvents.push(...processed);
        } else if (sseData.trim()) {
          // Handle malformed events (returns null, just logs)
          parser.handleMalformedEvent(sseData);
        }
      }

      expect(allEvents).toHaveLength(2);
      expect(allEvents[0].type).toBe('Created');
      expect(allEvents[1].type).toBe('OutputTextDelta');
    });
  });
});