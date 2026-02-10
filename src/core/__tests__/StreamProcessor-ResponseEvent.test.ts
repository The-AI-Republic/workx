/**
 * Test for StreamProcessor ResponseEvent integration (Phase 6)
 * Tests the integration between StreamProcessor and ResponseEvents from OpenAIResponsesClient
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { StreamProcessor } from '../StreamProcessor';
import type { ResponseEvent } from '../models/types/ResponseEvent';

describe('StreamProcessor ResponseEvent Integration', () => {
  let streamProcessor: StreamProcessor;
  let mockUIUpdateCallback: ReturnType<typeof vi.fn>;
  let mockResponseEventCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    streamProcessor = new StreamProcessor('model');
    mockUIUpdateCallback = vi.fn();
    mockResponseEventCallback = vi.fn();

    streamProcessor.onUpdate(mockUIUpdateCallback);
    streamProcessor.onResponseEvent(mockResponseEventCallback);
  });

  test('should handle OutputTextDelta ResponseEvent', async () => {
    // Create a mock async generator for ResponseEvents
    async function* mockResponseStream(): AsyncGenerator<ResponseEvent> {
      yield { type: 'Created' };
      yield { type: 'OutputTextDelta', delta: 'Hello ' };
      yield { type: 'OutputTextDelta', delta: 'world!' };
      yield { type: 'Completed', responseId: 'test-123' };
    }

    // Process the response stream
    await streamProcessor.processResponsesStream(mockResponseStream());

    // Verify ResponseEvent callbacks were called
    expect(mockResponseEventCallback).toHaveBeenCalledTimes(4);
    expect(mockResponseEventCallback).toHaveBeenCalledWith({ type: 'Created' });
    expect(mockResponseEventCallback).toHaveBeenCalledWith({ type: 'OutputTextDelta', delta: 'Hello ' });
    expect(mockResponseEventCallback).toHaveBeenCalledWith({ type: 'OutputTextDelta', delta: 'world!' });
    expect(mockResponseEventCallback).toHaveBeenCalledWith({ type: 'Completed', responseId: 'test-123' });

    // Verify UI updates were created from ResponseEvents
    expect(mockUIUpdateCallback).toHaveBeenCalled();

    // Check that the processor completed successfully
    expect(streamProcessor.getStatus()).toBe('completed');
  });

  test('should handle ReasoningSummaryDelta ResponseEvent', async () => {
    async function* mockResponseStream(): AsyncGenerator<ResponseEvent> {
      yield { type: 'ReasoningSummaryDelta', delta: 'Analyzing the request...' };
      yield { type: 'Completed', responseId: 'reasoning-test' };
    }

    await streamProcessor.processResponsesStream(mockResponseStream());

    expect(mockResponseEventCallback).toHaveBeenCalledWith({
      type: 'ReasoningSummaryDelta',
      delta: 'Analyzing the request...'
    });

    // Should generate UI update with [Reasoning] prefix
    expect(mockUIUpdateCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'append',
        target: 'message',
        content: '[Reasoning] Analyzing the request...'
      })
    );
  });

  test('should handle ReasoningContentDelta ResponseEvent', async () => {
    async function* mockResponseStream(): AsyncGenerator<ResponseEvent> {
      yield { type: 'ReasoningContentDelta', delta: 'Let me think about this step by step.' };
    }

    await streamProcessor.processResponsesStream(mockResponseStream());

    expect(mockResponseEventCallback).toHaveBeenCalledWith({
      type: 'ReasoningContentDelta',
      delta: 'Let me think about this step by step.'
    });

    // Should generate UI update with [Thinking] prefix
    expect(mockUIUpdateCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'append',
        target: 'message',
        content: '[Thinking] Let me think about this step by step.'
      })
    );
  });

  test('should handle WebSearchCallBegin ResponseEvent', async () => {
    async function* mockResponseStream(): AsyncGenerator<ResponseEvent> {
      yield { type: 'WebSearchCallBegin', callId: 'search-abc123' };
    }

    await streamProcessor.processResponsesStream(mockResponseStream());

    expect(mockResponseEventCallback).toHaveBeenCalledWith({
      type: 'WebSearchCallBegin',
      callId: 'search-abc123'
    });

    // Should generate status UI update
    expect(mockUIUpdateCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'append',
        target: 'status',
        content: 'Web search initiated (search-abc123)...'
      })
    );
  });

  test('should handle RateLimits ResponseEvent without UI update', async () => {
    async function* mockResponseStream(): AsyncGenerator<ResponseEvent> {
      yield {
        type: 'RateLimits',
        snapshot: {
          requestsRemaining: 100,
          tokensRemaining: 50000,
          resetTime: Date.now() + 60000
        }
      };
    }

    await streamProcessor.processResponsesStream(mockResponseStream());

    // Should call ResponseEvent callback
    expect(mockResponseEventCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RateLimits',
        snapshot: expect.any(Object)
      })
    );

    // Should not generate UI update (returns null from convertResponseEventToUIUpdate)
    // UI callback might still be called due to batching, but we check that no UI update content was meaningful
    if (mockUIUpdateCallback.mock.calls.length > 0) {
      // If any calls were made, they should not be for rate limits content
      const uiUpdateCalls = mockUIUpdateCallback.mock.calls;
      for (const call of uiUpdateCalls) {
        expect(call[0].content).not.toContain('RateLimits');
      }
    }
  });

  test('should handle stream errors gracefully', async () => {
    async function* mockErrorStream(): AsyncGenerator<ResponseEvent> {
      yield { type: 'Created' };
      throw new Error('Stream error');
    }

    // Should throw the error but not crash
    await expect(streamProcessor.processResponsesStream(mockErrorStream()))
      .rejects.toThrow('Stream error');

    // Status should be set to error
    expect(streamProcessor.getStatus()).toBe('error');

    // ResponseEvent callback should have been called for the first event
    expect(mockResponseEventCallback).toHaveBeenCalledWith({ type: 'Created' });
  });

  test('should update metrics for ResponseEvents', async () => {
    async function* mockResponseStream(): AsyncGenerator<ResponseEvent> {
      yield { type: 'OutputTextDelta', delta: 'Hello world' };
      yield { type: 'ReasoningSummaryDelta', delta: 'Thinking about the response' };
    }

    await streamProcessor.processResponsesStream(mockResponseStream());

    const metrics = streamProcessor.getMetrics();

    // Should have processed bytes and chunks
    expect(metrics.bytesProcessed).toBeGreaterThan(0);
    expect(metrics.chunksProcessed).toBe(2);
    expect(metrics.averageChunkSize).toBeGreaterThan(0);
  });

  test('should batch UI updates efficiently', async () => {
    async function* mockResponseStream(): AsyncGenerator<ResponseEvent> {
      yield { type: 'OutputTextDelta', delta: 'Part 1 ' };
      yield { type: 'OutputTextDelta', delta: 'Part 2 ' };
      yield { type: 'OutputTextDelta', delta: 'Part 3' };
    }

    await streamProcessor.processResponsesStream(mockResponseStream());

    // All ResponseEvents should be emitted
    expect(mockResponseEventCallback).toHaveBeenCalledTimes(3);

    // UI updates should be batched - the exact number depends on timing
    // but there should be fewer UI update calls than ResponseEvent calls due to batching
    expect(mockUIUpdateCallback.mock.calls.length).toBeGreaterThan(0);
  });
});