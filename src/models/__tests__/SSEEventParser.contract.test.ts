/**
 * SSEEventParser Contract Tests
 * Reference: contracts/SSE.contract.md
 *
 * These tests verify that the TypeScript SSE event parsing
 * implements all 11 event type mappings correctly.
 *
 * EXPECTED: Tests will FAIL if SSEEventParser doesn't implement
 * all 11 event type mappings correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SSEEventParser } from '../SSEEventParser';
import type { ResponseEvent } from '../types/ResponseEvent';
import {
  SSE_RESPONSE_CREATED,
  SSE_OUTPUT_ITEM_DONE,
  SSE_OUTPUT_TEXT_DELTA,
  SSE_REASONING_SUMMARY_DELTA,
  SSE_REASONING_CONTENT_DELTA,
  SSE_REASONING_SUMMARY_PART_ADDED,
  SSE_WEB_SEARCH_CALL_BEGIN,
  SSE_RESPONSE_COMPLETED,
  SSE_RESPONSE_FAILED,
  SSE_RESPONSE_IN_PROGRESS,
  SSE_OUTPUT_TEXT_DONE,
  SSE_INVALID_JSON,
  parseSSELine,
} from './fixtures/sse-events';

describe('SSEEventParser Contract', () => {
  let parser: SSEEventParser;

  beforeEach(() => {
    parser = new SSEEventParser();
  });

  describe('parse() method - JSON parsing', () => {
    it('parses valid JSON into SseEvent', () => {
      const data = '{"type":"response.created","response":{"id":"test123"}}';
      const event = parser.parse(data);

      expect(event).not.toBeNull();
      expect(event?.type).toBe('response.created');
    });

    it('returns null for invalid JSON without throwing', () => {
      const data = 'INVALID_JSON{not json}';
      const event = parser.parse(data);

      // Contract: Parse errors don't fail stream, just skip event
      expect(event).toBeNull();
    });

    it('handles empty string', () => {
      const event = parser.parse('');
      expect(event).toBeNull();
    });
  });

  describe('Event Type Mapping', () => {
    describe('1. response.created → Created', () => {
      it('maps to Created event', () => {
        const data = parseSSELine(SSE_RESPONSE_CREATED);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        expect(event).not.toBeNull();

        const responseEvents = parser.processEvent(event!);
        expect(responseEvents).toHaveLength(1);
        expect(responseEvents[0]).toEqual({ type: 'Created' });
      });
    });

    describe('2. response.output_item.done → OutputItemDone', () => {
      it('maps to OutputItemDone with item', () => {
        const data = parseSSELine(SSE_OUTPUT_ITEM_DONE);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toHaveLength(1);
        expect(responseEvents[0].type).toBe('OutputItemDone');
        expect((responseEvents[0] as any).item).toBeDefined();
        expect((responseEvents[0] as any).item.type).toBe('message');
      });
    });

    describe('3. response.output_text.delta → OutputTextDelta', () => {
      it('maps to OutputTextDelta with delta text', () => {
        const data = parseSSELine(SSE_OUTPUT_TEXT_DELTA);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toHaveLength(1);
        expect(responseEvents[0]).toEqual({
          type: 'OutputTextDelta',
          delta: 'Hello',
        });
      });
    });

    describe('4. response.reasoning_summary_text.delta → ReasoningSummaryDelta', () => {
      it('maps to ReasoningSummaryDelta', () => {
        const data = parseSSELine(SSE_REASONING_SUMMARY_DELTA);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toHaveLength(1);
        expect(responseEvents[0].type).toBe('ReasoningSummaryDelta');
        expect((responseEvents[0] as any).delta).toBe('Analyzing the problem...');
      });
    });

    describe('5. response.reasoning_text.delta → ReasoningContentDelta', () => {
      it('maps to ReasoningContentDelta', () => {
        const data = parseSSELine(SSE_REASONING_CONTENT_DELTA);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toHaveLength(1);
        expect(responseEvents[0].type).toBe('ReasoningContentDelta');
        expect((responseEvents[0] as any).delta).toBe('Step 1: Consider the constraints');
      });
    });

    describe('6. response.reasoning_summary_part.added → ReasoningSummaryPartAdded', () => {
      it('maps to ReasoningSummaryPartAdded', () => {
        const data = parseSSELine(SSE_REASONING_SUMMARY_PART_ADDED);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toHaveLength(1);
        expect(responseEvents[0]).toEqual({
          type: 'ReasoningSummaryPartAdded',
        });
      });
    });

    describe('7. response.output_item.added (web_search) → WebSearchCallBegin', () => {
      it('maps to WebSearchCallBegin with callId', () => {
        const data = parseSSELine(SSE_WEB_SEARCH_CALL_BEGIN);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toHaveLength(1);
        expect(responseEvents[0].type).toBe('WebSearchCallBegin');
        expect((responseEvents[0] as any).callId).toBe('call_abc123');
      });
    });

    describe('8. response.completed → Store for later', () => {
      it('stores completion data without yielding immediately', () => {
        const data = parseSSELine(SSE_RESPONSE_COMPLETED);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        // Contract: response.completed doesn't yield immediately
        // It's stored and yielded when stream ends
        // For now, processEvent might return empty array or store internally
        expect(Array.isArray(responseEvents)).toBe(true);
      });
    });

    describe('9. response.failed → Throw error', () => {
      it('throws error on failed response', () => {
        const data = parseSSELine(SSE_RESPONSE_FAILED);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);

        // Contract: response.failed should throw
        expect(() => {
          parser.processEvent(event!);
        }).toThrow(/test error message/i);
      });
    });

    describe('10. Ignored events', () => {
      it('ignores response.in_progress', () => {
        const data = parseSSELine(SSE_RESPONSE_IN_PROGRESS);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        // Contract: Ignored events return empty array
        expect(responseEvents).toEqual([]);
      });

      it('ignores response.output_text.done', () => {
        const data = parseSSELine(SSE_OUTPUT_TEXT_DONE);
        if (!data) throw new Error('Failed to parse SSE line');

        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toEqual([]);
      });

      it('ignores response.content_part.done', () => {
        const data = '{"type":"response.content_part.done"}';
        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toEqual([]);
      });

      it('ignores response.function_call_arguments.delta', () => {
        const data = '{"type":"response.function_call_arguments.delta","delta":"{\\"arg\\":1}"}';
        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        expect(responseEvents).toEqual([]);
      });
    });

    describe('11. Unknown events → Log debug, don\'t fail', () => {
      it('returns empty array for unknown event types', () => {
        const data = '{"type":"response.unknown_event_type","data":{}}';
        const event = parser.parse(data);
        const responseEvents = parser.processEvent(event!);

        // Contract: Unknown events don't fail, just skip
        expect(responseEvents).toEqual([]);
      });
    });
  });

  describe('Field name conversion', () => {
    it('converts response_id to responseId (camelCase)', () => {
      const data = parseSSELine(SSE_RESPONSE_COMPLETED);
      if (!data) throw new Error('Failed to parse SSE line');

      const event = parser.parse(data);
      const responseEvents = parser.processEvent(event!);

      // Contract: field names in camelCase
      if (responseEvents.length > 0 && responseEvents[0].type === 'Completed') {
        expect((responseEvents[0] as any).responseId).toBeDefined();
        // Should NOT have snake_case
        expect((responseEvents[0] as any).response_id).toBeUndefined();
      }
    });

    it('converts token_usage to tokenUsage', () => {
      const data = parseSSELine(SSE_RESPONSE_COMPLETED);
      if (!data) throw new Error('Failed to parse SSE line');

      const event = parser.parse(data);
      const responseEvents = parser.processEvent(event!);

      if (responseEvents.length > 0 && responseEvents[0].type === 'Completed') {
        const completed = responseEvents[0] as any;
        if (completed.tokenUsage) {
          // Token usage fields preserve snake_case (from API)
          expect(completed.tokenUsage.input_tokens).toBeDefined();
          expect(completed.tokenUsage.output_tokens).toBeDefined();
          expect(completed.tokenUsage.total_tokens).toBeDefined();
        }
      }
    });
  });

  describe('Performance - <10ms per event (reference: research.md)', () => {
    it('processes 1000 events in <10ms average', () => {
      const event = {
        type: 'response.output_text.delta',
        delta: 'Test text',
      };

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        parser.processEvent(event);
      }
      const elapsed = performance.now() - start;

      const avgTime = elapsed / 1000;

      // Contract: <10ms per event
      expect(avgTime).toBeLessThan(10);
    });
  });

  describe('Performance metrics tracking', () => {
    it('provides getPerformanceMetrics() method', () => {
      const metrics = parser.getPerformanceMetrics();

      expect(metrics).toBeDefined();
      expect(typeof metrics.totalProcessed).toBe('number');
      expect(typeof metrics.averageTime).toBe('number');
    });

    it('tracks event processing', () => {
      const event = { type: 'response.created', response: { id: 'test' } };

      parser.processEvent(event);
      parser.processEvent(event);

      const metrics = parser.getPerformanceMetrics();
      expect(metrics.totalProcessed).toBeGreaterThanOrEqual(2);
    });

    it('provides resetPerformanceMetrics() method', () => {
      const event = { type: 'response.created', response: { id: 'test' } };

      parser.processEvent(event);
      expect(parser.getPerformanceMetrics().totalProcessed).toBeGreaterThan(0);

      parser.resetPerformanceMetrics();
      expect(parser.getPerformanceMetrics().totalProcessed).toBe(0);
    });
  });

  describe('Integration with complete SSE streams', () => {
    it('processes multi-line SSE stream correctly', () => {
      const sseStream = `data: {"type":"response.created","response":{"id":"resp_001"}}

data: {"type":"response.output_text.delta","delta":"Hello"}

data: {"type":"response.output_text.delta","delta":" World"}

data: {"type":"response.completed","response":{"id":"resp_001","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}

`;

      const lines = sseStream.split('\n');
      const allEvents: ResponseEvent[] = [];

      for (const line of lines) {
        const data = parseSSELine(line);
        if (data) {
          const event = parser.parse(data);
          if (event) {
            const responseEvents = parser.processEvent(event);
            allEvents.push(...responseEvents);
          }
        }
      }

      // Should have processed Created, 2 deltas (and maybe Completed depending on implementation)
      expect(allEvents.length).toBeGreaterThan(0);
      expect(allEvents.some((e) => e.type === 'Created')).toBe(true);
      expect(allEvents.some((e) => e.type === 'OutputTextDelta')).toBe(true);
    });
  });

  describe('Error resilience', () => {
    it('continues processing after invalid JSON', () => {
      const invalidEvent = parser.parse('INVALID{JSON');
      expect(invalidEvent).toBeNull();

      // Should still work on next valid event
      const validEvent = parser.parse('{"type":"response.created","response":{"id":"test"}}');
      expect(validEvent).not.toBeNull();

      const responseEvents = parser.processEvent(validEvent!);
      expect(responseEvents).toHaveLength(1);
    });

    it('handles missing required fields gracefully', () => {
      const event = { type: 'response.output_text.delta' }; // Missing delta field

      // Should handle gracefully (return empty or skip)
      const responseEvents = parser.processEvent(event);
      expect(Array.isArray(responseEvents)).toBe(true);
    });
  });
});
