import { describe, it, expect } from 'vitest';

// ResponseEvent types and guards
import {
  ResponseEvent,
  isResponseEvent,
  isCreated,
  isOutputItemDone,
  isCompleted,
  isOutputTextDelta,
  isReasoningSummaryDelta,
  isReasoningContentDelta,
  isReasoningSummaryPartAdded,
  isWebSearchCallBegin,
  isRateLimits,
} from '../types/ResponseEvent';

import type { ResponseItem, ContentItem } from '../../../protocol/types';

// TokenUsage types and functions
import {
  TokenUsage,
  TokenUsageInfo,
  createEmptyTokenUsage,
  createEmptyTokenUsageInfo,
  aggregateTokenUsage,
  addTokenUsage,
  updateTokenUsageInfo,
  isTokenUsage,
  isTokenUsageInfo,
} from '../types/TokenUsage';

// RateLimit types and functions
import {
  RateLimitSnapshot,
  RateLimitWindow,
  createEmptyRateLimitSnapshot,
  createRateLimitWindow,
  createRateLimitSnapshot,
  isRateLimitWindow,
  isRateLimitSnapshot,
  hasValidRateLimitData,
  getMostRestrictiveWindow,
  isApproachingRateLimit,
  formatRateLimitInfo,
} from '../types/RateLimits';

describe('ResponseEvent Types and Guards', () => {
  describe('Type Guards', () => {
    it('should identify valid ResponseEvent objects', () => {
      const validEvents: ResponseEvent[] = [
        { type: 'Created' },
        { type: 'OutputTextDelta', delta: 'hello' },
        { type: 'Completed', responseId: '123' },
        { type: 'WebSearchCallBegin', callId: 'search-1' },
      ];

      validEvents.forEach(event => {
        expect(isResponseEvent(event)).toBe(true);
      });

      expect(isResponseEvent(null)).toBe(false);
      expect(isResponseEvent({})).toBe(false);
      expect(isResponseEvent({ foo: 'bar' })).toBe(false);
    });

    it('should correctly identify specific ResponseEvent variants', () => {
      const createdEvent: ResponseEvent = { type: 'Created' };
      const deltaEvent: ResponseEvent = { type: 'OutputTextDelta', delta: 'test' };
      const completedEvent: ResponseEvent = { type: 'Completed', responseId: '123' };

      expect(isCreated(createdEvent)).toBe(true);
      expect(isCreated(deltaEvent)).toBe(false);

      expect(isOutputTextDelta(deltaEvent)).toBe(true);
      expect(isOutputTextDelta(createdEvent)).toBe(false);

      expect(isCompleted(completedEvent)).toBe(true);
      expect(isCompleted(createdEvent)).toBe(false);
    });

    it('should handle all ResponseEvent variants', () => {
      const responseItem: ResponseItem = {
        id: 'item-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      };

      const rateLimitSnapshot: RateLimitSnapshot = {
        primary: { used_percent: 50.0 },
      };

      const events: ResponseEvent[] = [
        { type: 'Created' },
        { type: 'OutputItemDone', item: responseItem },
        { type: 'Completed', responseId: '123' },
        { type: 'OutputTextDelta', delta: 'hello' },
        { type: 'ReasoningSummaryDelta', delta: 'reasoning' },
        { type: 'ReasoningContentDelta', delta: 'content' },
        { type: 'ReasoningSummaryPartAdded' },
        { type: 'WebSearchCallBegin', callId: 'search-1' },
        { type: 'RateLimits', snapshot: rateLimitSnapshot },
      ];

      events.forEach(event => {
        expect(isResponseEvent(event)).toBe(true);
      });

      expect(isOutputItemDone(events[1])).toBe(true);
      expect(isReasoningSummaryDelta(events[4])).toBe(true);
      expect(isReasoningContentDelta(events[5])).toBe(true);
      expect(isReasoningSummaryPartAdded(events[6])).toBe(true);
      expect(isWebSearchCallBegin(events[7])).toBe(true);
      expect(isRateLimits(events[8])).toBe(true);
    });
  });

  describe('ResponseItem and ContentItem', () => {
    it('should create valid ResponseItem message objects', () => {
      const item: ResponseItem = {
        id: 'test-item',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Test content' }
        ],
      };

      expect(item.id).toBe('test-item');
      expect(item.type).toBe('message');
      expect(item.role).toBe('assistant');
      expect(item.content.length).toBe(1);
      expect(item.content[0].type).toBe('output_text');
    });

    it('should support ContentItem arrays in messages', () => {
      const contentItems: ContentItem[] = [
        { type: 'text', text: 'Hello' },
        { type: 'output_text', text: 'World' },
      ];

      const item: ResponseItem = {
        type: 'message',
        role: 'user',
        content: contentItems,
      };

      expect(Array.isArray(item.content)).toBe(true);
      expect(item.content.length).toBe(2);
    });

    it('should create function call ResponseItem', () => {
      const item: ResponseItem = {
        type: 'function_call',
        name: 'test_function',
        arguments: '{"key":"value"}',
        call_id: 'call_123',
      };

      expect(item.type).toBe('function_call');
      expect(item.name).toBe('test_function');
    });
  });
});

describe('TokenUsage Types and Functions', () => {
  describe('Factory Functions', () => {
    it('should create empty TokenUsage', () => {
      const empty = createEmptyTokenUsage();

      expect(empty.input_tokens).toBe(0);
      expect(empty.cached_input_tokens).toBe(0);
      expect(empty.output_tokens).toBe(0);
      expect(empty.reasoning_output_tokens).toBe(0);
      expect(empty.total_tokens).toBe(0);
    });

    it('should create empty TokenUsageInfo', () => {
      const empty = createEmptyTokenUsageInfo();

      expect(isTokenUsage(empty.total_token_usage)).toBe(true);
      expect(isTokenUsage(empty.last_token_usage)).toBe(true);
      expect(empty.model_context_window).toBeUndefined();
      expect(empty.auto_compact_token_limit).toBeUndefined();
    });

    it('should create TokenUsageInfo with parameters', () => {
      const info = createEmptyTokenUsageInfo(128000, 100000);

      expect(info.model_context_window).toBe(128000);
      expect(info.auto_compact_token_limit).toBe(100000);
    });
  });

  describe('Aggregation Functions', () => {
    it('should aggregate multiple TokenUsage objects', () => {
      const usages: TokenUsage[] = [
        {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 50,
          reasoning_output_tokens: 10,
          total_tokens: 150,
        },
        {
          input_tokens: 200,
          cached_input_tokens: 30,
          output_tokens: 75,
          reasoning_output_tokens: 15,
          total_tokens: 275,
        },
      ];

      const aggregated = aggregateTokenUsage(usages);

      expect(aggregated.input_tokens).toBe(300);
      expect(aggregated.cached_input_tokens).toBe(50);
      expect(aggregated.output_tokens).toBe(125);
      expect(aggregated.reasoning_output_tokens).toBe(25);
      expect(aggregated.total_tokens).toBe(425);
    });

    it('should add two TokenUsage objects', () => {
      const usage1: TokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 150,
      };

      const usage2: TokenUsage = {
        input_tokens: 50,
        cached_input_tokens: 10,
        output_tokens: 25,
        reasoning_output_tokens: 5,
        total_tokens: 75,
      };

      const sum = addTokenUsage(usage1, usage2);

      expect(sum.input_tokens).toBe(150);
      expect(sum.cached_input_tokens).toBe(30);
      expect(sum.output_tokens).toBe(75);
      expect(sum.reasoning_output_tokens).toBe(15);
      expect(sum.total_tokens).toBe(225);
    });

    it('should update TokenUsageInfo with new usage', () => {
      const initialUsage: TokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 150,
      };

      const info = createEmptyTokenUsageInfo();
      info.total_token_usage = initialUsage;

      const newUsage: TokenUsage = {
        input_tokens: 50,
        cached_input_tokens: 10,
        output_tokens: 25,
        reasoning_output_tokens: 5,
        total_tokens: 75,
      };

      const updated = updateTokenUsageInfo(info, newUsage);

      expect(updated.last_token_usage).toEqual(newUsage);
      expect(updated.total_token_usage.total_tokens).toBe(225);
    });
  });

  describe('Type Guards', () => {
    it('should validate TokenUsage objects', () => {
      const validUsage: TokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 150,
      };

      expect(isTokenUsage(validUsage)).toBe(true);
      expect(isTokenUsage({})).toBe(false);
      expect(isTokenUsage(null)).toBe(false);
      expect(isTokenUsage({ input_tokens: 'invalid' })).toBe(false);
    });

    it('should validate TokenUsageInfo objects', () => {
      const validInfo: TokenUsageInfo = {
        total_token_usage: createEmptyTokenUsage(),
        last_token_usage: createEmptyTokenUsage(),
        model_context_window: 128000,
      };

      expect(isTokenUsageInfo(validInfo)).toBe(true);
      expect(isTokenUsageInfo({})).toBe(false);
      expect(isTokenUsageInfo({ total_token_usage: {} })).toBe(false);
    });
  });
});

describe('RateLimit Types and Functions', () => {
  describe('Factory Functions', () => {
    it('should create empty RateLimitSnapshot', () => {
      const empty = createEmptyRateLimitSnapshot();

      expect(empty.primary).toBeUndefined();
      expect(empty.secondary).toBeUndefined();
    });

    it('should create RateLimitWindow with values', () => {
      const window = createRateLimitWindow(75.5, 15, 300);

      expect(window.used_percent).toBe(75.5);
      expect(window.window_minutes).toBe(15);
      expect(window.resets_in_seconds).toBe(300);
    });

    it('should create RateLimitSnapshot with windows', () => {
      const primary = createRateLimitWindow(80.0);
      const secondary = createRateLimitWindow(60.0);
      const snapshot = createRateLimitSnapshot(primary, secondary);

      expect(snapshot.primary).toEqual(primary);
      expect(snapshot.secondary).toEqual(secondary);
    });
  });

  describe('Type Guards', () => {
    it('should validate RateLimitWindow objects', () => {
      const validWindow: RateLimitWindow = {
        used_percent: 75.0,
        window_minutes: 15,
        resets_in_seconds: 300,
      };

      expect(isRateLimitWindow(validWindow)).toBe(true);
      expect(isRateLimitWindow({})).toBe(false);
      expect(isRateLimitWindow(null)).toBe(false);
      expect(isRateLimitWindow({ used_percent: 'invalid' })).toBe(false);
    });

    it('should validate RateLimitSnapshot objects', () => {
      const validWindow: RateLimitWindow = { used_percent: 50.0 };
      const validSnapshot: RateLimitSnapshot = { primary: validWindow };

      expect(isRateLimitSnapshot(validSnapshot)).toBe(true);
      expect(isRateLimitSnapshot({})).toBe(false);
      expect(isRateLimitSnapshot({ primary: {} })).toBe(false);
    });
  });

  describe('Utility Functions', () => {
    it('should validate rate limit data', () => {
      const withPrimary: RateLimitSnapshot = {
        primary: { used_percent: 50.0 }
      };
      const empty: RateLimitSnapshot = {};

      expect(hasValidRateLimitData(withPrimary)).toBe(true);
      expect(hasValidRateLimitData(empty)).toBe(false);
    });

    it('should get most restrictive window', () => {
      const primary: RateLimitWindow = { used_percent: 80.0 };
      const secondary: RateLimitWindow = { used_percent: 60.0 };
      const snapshot: RateLimitSnapshot = { primary, secondary };

      const mostRestrictive = getMostRestrictiveWindow(snapshot);

      expect(mostRestrictive).toEqual(primary);
    });

    it('should detect approaching rate limit', () => {
      const highUsage: RateLimitSnapshot = {
        primary: { used_percent: 85.0 },
      };

      const lowUsage: RateLimitSnapshot = {
        primary: { used_percent: 40.0 },
      };

      expect(isApproachingRateLimit(highUsage)).toBe(true);
      expect(isApproachingRateLimit(lowUsage)).toBe(false);
      expect(isApproachingRateLimit(highUsage, 90)).toBe(false);
    });

    it('should format rate limit info', () => {
      const window: RateLimitWindow = {
        used_percent: 75.5,
        window_minutes: 15,
        resets_in_seconds: 300,
      };

      const formatted = formatRateLimitInfo(window);

      expect(formatted).toContain('75.5% used');
      expect(formatted).toContain('15min window');
      expect(formatted).toContain('resets in 300s');
    });
  });
});

describe('Type Compilation and Integration', () => {
  it('should compile TypeScript types correctly', () => {
    // This test ensures all types compile and can be used together
    const tokenUsage: TokenUsage = createEmptyTokenUsage();
    const rateLimitSnapshot: RateLimitSnapshot = createEmptyRateLimitSnapshot();

    const responseEvent: ResponseEvent = {
      type: 'Completed',
      responseId: 'test-123',
      tokenUsage,
    };

    const rateLimitEvent: ResponseEvent = {
      type: 'RateLimits',
      snapshot: rateLimitSnapshot,
    };

    expect(isResponseEvent(responseEvent)).toBe(true);
    expect(isResponseEvent(rateLimitEvent)).toBe(true);
    expect(isCompleted(responseEvent)).toBe(true);
    expect(isRateLimits(rateLimitEvent)).toBe(true);
  });

  it('should work with complex nested structures', () => {
    const responseItem: ResponseItem = {
      id: 'item-1',
      type: 'function_call',
      name: 'test_function',
      arguments: '{"key":"value"}',
      call_id: 'call_123',
    };

    const event: ResponseEvent = {
      type: 'OutputItemDone',
      item: responseItem,
    };

    expect(isOutputItemDone(event)).toBe(true);
    if (isOutputItemDone(event)) {
      expect(event.item.id).toBe('item-1');
      expect(Array.isArray(event.item.content)).toBe(true);
    }
  });
});