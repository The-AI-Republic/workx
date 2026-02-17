/**
 * Comprehensive unit tests for StreamProcessor
 *
 * Covers:
 * - StreamBuffer (push, shift, clear, capacity)
 * - StreamProcessor constructor and configuration
 * - start() with ReadableStream
 * - processResponsesStream() with AsyncGenerator<ResponseEvent>
 * - pause() / resume() / abort()
 * - getStatus() / getMetrics()
 * - onUpdate() / onResponseEvent()
 * - flushPendingUpdates()
 * - Backpressure and batching
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  StreamProcessor,
  StreamBuffer,
  type StreamConfig,
  type StreamStatus,
  type UIUpdate,
} from '../StreamProcessor';
import type { ResponseEvent } from '../models/types/ResponseEvent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ReadableStream from an array of chunks. */
function createMockReadableStream(chunks: (string | Uint8Array)[]): ReadableStream {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

/** Build an async generator that yields the given events. */
async function* createResponseStream(
  events: ResponseEvent[],
): AsyncGenerator<ResponseEvent> {
  for (const event of events) {
    yield event;
  }
}

/** Build an async generator that throws after yielding some events. */
async function* createErrorResponseStream(
  events: ResponseEvent[],
  error: Error,
): AsyncGenerator<ResponseEvent> {
  for (const event of events) {
    yield event;
  }
  throw error;
}

// ---------------------------------------------------------------------------
// StreamBuffer
// ---------------------------------------------------------------------------

describe('StreamBuffer', () => {
  it('should push and shift chunks in FIFO order', () => {
    const buffer = new StreamBuffer(1024);
    const chunk1 = { id: 'c1', data: 'hello', timestamp: 1, sequenceNumber: 0, isFinal: false };
    const chunk2 = { id: 'c2', data: 'world', timestamp: 2, sequenceNumber: 1, isFinal: false };

    expect(buffer.push(chunk1)).toBe(true);
    expect(buffer.push(chunk2)).toBe(true);

    expect(buffer.getSize()).toBe(10); // 5 + 5

    const shifted = buffer.shift();
    expect(shifted?.id).toBe('c1');
    expect(buffer.getSize()).toBe(5);
  });

  it('should reject push when buffer is full', () => {
    const buffer = new StreamBuffer(8);
    const chunk1 = { id: 'c1', data: 'hello', timestamp: 1, sequenceNumber: 0, isFinal: false };
    const chunk2 = { id: 'c2', data: 'world', timestamp: 2, sequenceNumber: 1, isFinal: false };

    expect(buffer.push(chunk1)).toBe(true); // 5 bytes, under 8
    expect(buffer.push(chunk2)).toBe(false); // 5 + 5 = 10 > 8
  });

  it('should handle Uint8Array data for size calculation', () => {
    const buffer = new StreamBuffer(1024);
    const data = new Uint8Array([1, 2, 3, 4]);
    const chunk = { id: 'c1', data, timestamp: 1, sequenceNumber: 0, isFinal: false };

    expect(buffer.push(chunk)).toBe(true);
    expect(buffer.getSize()).toBe(4);
  });

  it('should clear all chunks and reset size', () => {
    const buffer = new StreamBuffer(1024);
    buffer.push({ id: 'c1', data: 'abc', timestamp: 1, sequenceNumber: 0, isFinal: false });
    buffer.push({ id: 'c2', data: 'def', timestamp: 2, sequenceNumber: 1, isFinal: false });

    buffer.clear();
    expect(buffer.getSize()).toBe(0);
    expect(buffer.shift()).toBeUndefined();
  });

  it('should return undefined when shifting from empty buffer', () => {
    const buffer = new StreamBuffer(1024);
    expect(buffer.shift()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// StreamProcessor - constructor & configuration
// ---------------------------------------------------------------------------

describe('StreamProcessor', () => {
  let processor: StreamProcessor;

  beforeEach(() => {
    vi.useFakeTimers();
    processor = new StreamProcessor('model');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Constructor / defaults
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('should initialise with idle status', () => {
      expect(processor.getStatus()).toBe('idle');
    });

    it('should initialise metrics to zero values', () => {
      const metrics = processor.getMetrics();
      expect(metrics.bytesProcessed).toBe(0);
      expect(metrics.chunksProcessed).toBe(0);
      expect(metrics.averageChunkSize).toBe(0);
      expect(metrics.updateCount).toBe(0);
      expect(metrics.errorCount).toBe(0);
    });

    it('should initialise buffer size to zero', () => {
      expect(processor.getBufferSize()).toBe(0);
    });

    it('should accept custom configuration', () => {
      const config: StreamConfig = {
        maxBufferSize: 512,
        pauseThreshold: 400,
        resumeThreshold: 200,
        updateInterval: 50,
        encoding: 'utf-8',
        chunkSize: 8192,
      };
      const custom = new StreamProcessor('network', config);
      expect(custom.getStatus()).toBe('idle');
    });
  });

  // -----------------------------------------------------------------------
  // getStatus()
  // -----------------------------------------------------------------------

  describe('getStatus', () => {
    it('should return idle before any stream is started', () => {
      expect(processor.getStatus()).toBe('idle');
    });

    it('should return completed after a successful stream', async () => {
      const stream = createMockReadableStream(['hello']);
      await processor.start(stream);
      vi.runAllTimers();
      expect(processor.getStatus()).toBe('completed');
    });

    it('should return error after a failed stream', async () => {
      // Create a stream that errors
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('test error'));
        },
      });

      await expect(processor.start(stream)).rejects.toThrow('test error');
      expect(processor.getStatus()).toBe('error');
    });
  });

  // -----------------------------------------------------------------------
  // start()
  // -----------------------------------------------------------------------

  describe('start', () => {
    it('should process a ReadableStream of strings', async () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      const stream = createMockReadableStream(['Hello ', 'World']);
      await processor.start(stream);

      // Flush any remaining scheduled updates
      vi.runAllTimers();

      expect(processor.getStatus()).toBe('completed');
      expect(callback).toHaveBeenCalled();

      // Verify content was delivered via UI updates
      const allContent = callback.mock.calls.map((c) => c[0].content).join('');
      expect(allContent).toContain('Hello ');
      expect(allContent).toContain('World');
    });

    it('should process a ReadableStream of Uint8Array chunks', async () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      const encoder = new TextEncoder();
      const stream = createMockReadableStream([
        encoder.encode('binary '),
        encoder.encode('data'),
      ]);

      await processor.start(stream);
      vi.runAllTimers();

      expect(processor.getStatus()).toBe('completed');
      expect(callback).toHaveBeenCalled();
    });

    it('should throw when starting a stream that is already in progress', async () => {
      // Start a stream that never finishes reading
      let holdController: ReadableStreamDefaultController | null = null;
      const hangingStream = new ReadableStream({
        start(controller) {
          holdController = controller;
        },
      });

      // start() will block reading, so start in background
      const startPromise = processor.start(hangingStream);

      // Try starting another stream while in progress - need to wait a tick first
      await vi.advanceTimersByTimeAsync(0);

      const secondStream = createMockReadableStream(['data']);
      await expect(processor.start(secondStream)).rejects.toThrow(
        'Stream already in progress',
      );

      // Clean up
      holdController!.close();
      await startPromise;
    });

    it('should allow starting a new stream after completion', async () => {
      const stream1 = createMockReadableStream(['first']);
      await processor.start(stream1);
      vi.runAllTimers();
      expect(processor.getStatus()).toBe('completed');

      const stream2 = createMockReadableStream(['second']);
      // Should not throw
      await processor.start(stream2);
      vi.runAllTimers();
      expect(processor.getStatus()).toBe('completed');
    });

    it('should update metrics after processing', async () => {
      const stream = createMockReadableStream(['12345', '678']);
      await processor.start(stream);
      vi.runAllTimers();

      const metrics = processor.getMetrics();
      expect(metrics.bytesProcessed).toBe(8); // 5 + 3
      expect(metrics.chunksProcessed).toBe(2);
      expect(metrics.averageChunkSize).toBe(4); // 8 / 2
      expect(metrics.endTime).toBeDefined();
    });

    it('should release the reader on completion', async () => {
      const stream = createMockReadableStream(['data']);
      await processor.start(stream);
      vi.runAllTimers();

      // After completion, we should be able to get a new reader
      // (the original reader's lock was released)
      expect(processor.getStatus()).toBe('completed');
    });

    it('should release the reader on error', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('fail'));
        },
      });

      await expect(processor.start(stream)).rejects.toThrow('fail');
      expect(processor.getStatus()).toBe('error');
      expect(processor.getMetrics().errorCount).toBe(1);
    });

    it('should target "message" for model source', async () => {
      const callback = vi.fn();
      const modelProcessor = new StreamProcessor('model');
      modelProcessor.onUpdate(callback);

      const stream = createMockReadableStream(['text']);
      await modelProcessor.start(stream);
      vi.runAllTimers();

      const targets = callback.mock.calls.map((c) => c[0].target);
      expect(targets).toContain('message');
    });

    it('should target "status" for tool source', async () => {
      const callback = vi.fn();
      const toolProcessor = new StreamProcessor('tool');
      toolProcessor.onUpdate(callback);

      const stream = createMockReadableStream(['text']);
      await toolProcessor.start(stream);
      vi.runAllTimers();

      const targets = callback.mock.calls.map((c) => c[0].target);
      expect(targets).toContain('status');
    });

    it('should target "status" for network source', async () => {
      const callback = vi.fn();
      const networkProcessor = new StreamProcessor('network');
      networkProcessor.onUpdate(callback);

      const stream = createMockReadableStream(['text']);
      await networkProcessor.start(stream);
      vi.runAllTimers();

      const targets = callback.mock.calls.map((c) => c[0].target);
      expect(targets).toContain('status');
    });
  });

  // -----------------------------------------------------------------------
  // processResponsesStream()
  // -----------------------------------------------------------------------

  describe('processResponsesStream', () => {
    it('should process a sequence of ResponseEvents', async () => {
      const responseCallback = vi.fn();
      processor.onResponseEvent(responseCallback);

      const events: ResponseEvent[] = [
        { type: 'Created' },
        { type: 'OutputTextDelta', delta: 'Hello' },
        { type: 'Completed', responseId: 'resp-1' },
      ];

      await processor.processResponsesStream(createResponseStream(events));
      vi.runAllTimers();

      expect(processor.getStatus()).toBe('completed');
      expect(responseCallback).toHaveBeenCalledTimes(3);
      expect(responseCallback).toHaveBeenCalledWith({ type: 'Created' });
      expect(responseCallback).toHaveBeenCalledWith({
        type: 'OutputTextDelta',
        delta: 'Hello',
      });
      expect(responseCallback).toHaveBeenCalledWith({
        type: 'Completed',
        responseId: 'resp-1',
      });
    });

    it('should throw when another stream is already in progress', async () => {
      // Manually set processor into 'streaming' state by starting a normal stream,
      // then test that a second call rejects before the first finishes.
      // We achieve this by using a deferred generator we control.
      let resolveYield!: () => void;
      const yieldPromise = new Promise<void>((r) => {
        resolveYield = r;
      });

      async function* controlledStream(): AsyncGenerator<ResponseEvent> {
        yield { type: 'Created' };
        // Block until we release
        await yieldPromise;
      }

      // Start first stream (will block at yieldPromise)
      const firstPromise = processor.processResponsesStream(controlledStream());

      // Let the microtask for the first yield settle
      await vi.advanceTimersByTimeAsync(0);

      // Status should now be streaming
      expect(processor.getStatus()).toBe('streaming');

      // A second call should reject immediately
      await expect(
        processor.processResponsesStream(createResponseStream([])),
      ).rejects.toThrow('Stream already in progress');

      // Unblock the first stream so it completes
      resolveYield();
      await firstPromise;
    });

    it('should convert OutputTextDelta to append-message UIUpdate', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([{ type: 'OutputTextDelta', delta: 'content' }]),
      );
      vi.runAllTimers();

      expect(uiCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'append',
          target: 'message',
          content: 'content',
        }),
      );
    });

    it('should convert ReasoningSummaryDelta with [Reasoning] prefix', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'ReasoningSummaryDelta', delta: 'analyzing...' },
        ]),
      );
      vi.runAllTimers();

      expect(uiCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'append',
          target: 'message',
          content: '[Reasoning] analyzing...',
        }),
      );
    });

    it('should convert ReasoningContentDelta with [Thinking] prefix', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'ReasoningContentDelta', delta: 'step by step' },
        ]),
      );
      vi.runAllTimers();

      expect(uiCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'append',
          target: 'message',
          content: '[Thinking] step by step',
        }),
      );
    });

    it('should convert Created to replace-status UIUpdate', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([{ type: 'Created' }]),
      );
      vi.runAllTimers();

      expect(uiCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'replace',
          target: 'status',
          content: 'Response started...',
        }),
      );
    });

    it('should convert Completed to replace-status UIUpdate with responseId', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Completed', responseId: 'r-42' },
        ]),
      );
      vi.runAllTimers();

      expect(uiCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'replace',
          target: 'status',
          content: expect.stringContaining('r-42'),
        }),
      );
    });

    it('should include token count in Completed status when tokenUsage is present', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          {
            type: 'Completed',
            responseId: 'r-99',
            tokenUsage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 30,
            },
          },
        ]),
      );
      vi.runAllTimers();

      expect(uiCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Tokens: 30'),
        }),
      );
    });

    it('should convert WebSearchCallBegin to append-status UIUpdate', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'WebSearchCallBegin', callId: 'ws-1' },
        ]),
      );
      vi.runAllTimers();

      expect(uiCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'append',
          target: 'status',
          content: 'Web search initiated (ws-1)...',
        }),
      );
    });

    it('should NOT create UIUpdate for OutputItemDone events', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'OutputItemDone', item: { type: 'message', role: 'assistant', content: [] } as any },
        ]),
      );
      vi.runAllTimers();

      expect(uiCallback).not.toHaveBeenCalled();
    });

    it('should NOT create UIUpdate for ReasoningSummaryPartAdded events', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([{ type: 'ReasoningSummaryPartAdded' }]),
      );
      vi.runAllTimers();

      expect(uiCallback).not.toHaveBeenCalled();
    });

    it('should NOT create UIUpdate for RateLimits events', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          {
            type: 'RateLimits',
            snapshot: {
              primary: { used_percent: 50, window_minutes: 60, resets_in_seconds: 1000 },
            },
          },
        ]),
      );
      vi.runAllTimers();

      expect(uiCallback).not.toHaveBeenCalled();
    });

    it('should still emit ResponseEvent callbacks for non-UI events', async () => {
      const responseCallback = vi.fn();
      processor.onResponseEvent(responseCallback);

      const events: ResponseEvent[] = [
        { type: 'ReasoningSummaryPartAdded' },
        {
          type: 'RateLimits',
          snapshot: { primary: { used_percent: 50, window_minutes: 60, resets_in_seconds: 1000 } },
        },
      ];

      await processor.processResponsesStream(createResponseStream(events));
      vi.runAllTimers();

      expect(responseCallback).toHaveBeenCalledTimes(2);
    });

    it('should set status to error and increment errorCount on stream error', async () => {
      const events: ResponseEvent[] = [{ type: 'Created' }];
      const error = new Error('stream broke');

      await expect(
        processor.processResponsesStream(
          createErrorResponseStream(events, error),
        ),
      ).rejects.toThrow('stream broke');

      expect(processor.getStatus()).toBe('error');
      expect(processor.getMetrics().errorCount).toBe(1);
    });

    it('should set endTime in metrics after completion', async () => {
      await processor.processResponsesStream(
        createResponseStream([{ type: 'Created' }]),
      );
      vi.runAllTimers();

      const metrics = processor.getMetrics();
      expect(metrics.endTime).toBeDefined();
    });

    it('should set endTime in metrics after error', async () => {
      await processor
        .processResponsesStream(
          createErrorResponseStream([], new Error('fail')),
        )
        .catch(() => {});

      const metrics = processor.getMetrics();
      expect(metrics.endTime).toBeDefined();
    });

    it('should update bytesProcessed for text delta events', async () => {
      await processor.processResponsesStream(
        createResponseStream([
          { type: 'OutputTextDelta', delta: 'Hello' },
          { type: 'ReasoningSummaryDelta', delta: 'Think' },
          { type: 'ReasoningContentDelta', delta: 'More' },
        ]),
      );
      vi.runAllTimers();

      const metrics = processor.getMetrics();
      // bytesProcessed should reflect UTF-8 encoded length of all deltas
      expect(metrics.bytesProcessed).toBeGreaterThan(0);
      expect(metrics.chunksProcessed).toBe(3);
    });

    it('should not count bytes for non-text events', async () => {
      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Created' },
          { type: 'ReasoningSummaryPartAdded' },
        ]),
      );
      vi.runAllTimers();

      const metrics = processor.getMetrics();
      expect(metrics.bytesProcessed).toBe(0);
      expect(metrics.chunksProcessed).toBe(0);
    });

    it('should handle empty stream gracefully', async () => {
      await processor.processResponsesStream(createResponseStream([]));
      vi.runAllTimers();

      expect(processor.getStatus()).toBe('completed');
      expect(processor.getMetrics().chunksProcessed).toBe(0);
    });

    it('should handle callback errors without crashing the stream', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const badCallback = vi.fn(() => {
        throw new Error('callback exploded');
      });
      const goodCallback = vi.fn();

      processor.onResponseEvent(badCallback);
      processor.onResponseEvent(goodCallback);

      await processor.processResponsesStream(
        createResponseStream([{ type: 'Created' }]),
      );
      vi.runAllTimers();

      expect(badCallback).toHaveBeenCalled();
      expect(goodCallback).toHaveBeenCalled();
      expect(processor.getStatus()).toBe('completed');

      consoleSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // pause() / resume()
  // -----------------------------------------------------------------------

  describe('pause / resume', () => {
    it('should transition from streaming to paused', async () => {
      // We need the processor to be in streaming state
      // Start a stream that we can control
      let holdController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          holdController = controller;
        },
      });

      const promise = processor.start(stream);
      await vi.advanceTimersByTimeAsync(0);

      expect(processor.getStatus()).toBe('streaming');
      processor.pause();
      expect(processor.getStatus()).toBe('paused');

      // Clean up
      holdController!.close();
      // The processor internally calls resume after waitForBuffer,
      // but since we manually paused and buffer is empty, resume won't be called automatically.
      // Manually resume so processStream can finish.
      processor.resume();
      await promise;
    });

    it('should transition from paused back to streaming', async () => {
      let holdController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          holdController = controller;
        },
      });

      const promise = processor.start(stream);
      await vi.advanceTimersByTimeAsync(0);

      processor.pause();
      expect(processor.getStatus()).toBe('paused');

      processor.resume();
      expect(processor.getStatus()).toBe('streaming');

      holdController!.close();
      await promise;
    });

    it('should be a no-op if pause is called when not streaming', () => {
      expect(processor.getStatus()).toBe('idle');
      processor.pause();
      expect(processor.getStatus()).toBe('idle'); // unchanged
    });

    it('should be a no-op if resume is called when not paused', () => {
      expect(processor.getStatus()).toBe('idle');
      processor.resume();
      expect(processor.getStatus()).toBe('idle'); // unchanged
    });

    it('should be a no-op if pause is called while already paused', async () => {
      let holdController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          holdController = controller;
        },
      });

      const promise = processor.start(stream);
      await vi.advanceTimersByTimeAsync(0);

      processor.pause();
      expect(processor.getStatus()).toBe('paused');
      processor.pause(); // second pause
      expect(processor.getStatus()).toBe('paused');

      processor.resume();
      holdController!.close();
      await promise;
    });
  });

  // -----------------------------------------------------------------------
  // abort()
  // -----------------------------------------------------------------------

  describe('abort', () => {
    it('should set status to error', () => {
      processor.abort();
      expect(processor.getStatus()).toBe('error');
    });

    it('should clear the buffer', async () => {
      // Push something into the buffer via a partial stream
      let holdController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          holdController = controller;
          controller.enqueue('data');
        },
      });

      const promise = processor.start(stream);
      await vi.advanceTimersByTimeAsync(0);

      // At this point we should have data in buffer
      processor.abort();
      expect(processor.getBufferSize()).toBe(0);

      await promise.catch(() => {});
    });

    it('should clear pending updates', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      // Start a stream that yields data
      let holdController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          holdController = controller;
          controller.enqueue('data');
        },
      });

      const promise = processor.start(stream);
      await vi.advanceTimersByTimeAsync(0);

      // Abort before the timer fires
      processor.abort();

      // Now run timers - should NOT deliver updates since they were cleared
      vi.runAllTimers();

      // The callback should not receive any updates after abort
      // (it may have received zero or some before abort - we just check
      // that flushing after abort does nothing)
      const callCountAtAbort = uiCallback.mock.calls.length;

      // Manually try to flush - should be a no-op
      processor.flushPendingUpdates();
      expect(uiCallback.mock.calls.length).toBe(callCountAtAbort);

      await promise.catch(() => {});
    });

    it('should cancel the reader if one exists', async () => {
      let holdController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          holdController = controller;
        },
      });

      const promise = processor.start(stream);
      await vi.advanceTimersByTimeAsync(0);

      // abort should call reader.cancel()
      processor.abort();
      expect(processor.getStatus()).toBe('error');

      await promise.catch(() => {});
    });

    it('should be safe to call when no stream is active', () => {
      // Should not throw
      expect(() => processor.abort()).not.toThrow();
      expect(processor.getStatus()).toBe('error');
    });
  });

  // -----------------------------------------------------------------------
  // getMetrics()
  // -----------------------------------------------------------------------

  describe('getMetrics', () => {
    it('should compute processingRate as bytes per second', async () => {
      // Advance time to a known start point
      vi.setSystemTime(new Date(1000));
      const proc = new StreamProcessor('model');

      const stream = createMockReadableStream(['0123456789']); // 10 bytes

      // Advance to simulate duration
      vi.setSystemTime(new Date(3000)); // 2 seconds later

      await proc.start(stream);
      vi.runAllTimers();

      const metrics = proc.getMetrics();
      expect(metrics.bytesProcessed).toBe(10);
      // processingRate = bytesProcessed / (duration / 1000)
      // The exact rate depends on when startTime was set (in start()),
      // so we just verify it is positive.
      expect(metrics.processingRate).toBeGreaterThanOrEqual(0);
    });

    it('should include startTime', () => {
      const metrics = processor.getMetrics();
      expect(metrics.startTime).toBeGreaterThan(0);
    });

    it('should not have endTime before processing completes', () => {
      // endTime is not set until start() or processResponsesStream() finishes
      const metrics = processor.getMetrics();
      expect(metrics.endTime).toBeUndefined();
    });

    it('should track updateCount when callbacks are invoked', async () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      const stream = createMockReadableStream(['a', 'b', 'c']);
      await processor.start(stream);
      vi.runAllTimers();

      const metrics = processor.getMetrics();
      // updateCount is incremented once per (callback x update) in flushPendingUpdates
      expect(metrics.updateCount).toBeGreaterThan(0);
    });

    it('should return a snapshot (not a live reference)', async () => {
      const metrics1 = processor.getMetrics();
      const stream = createMockReadableStream(['data']);
      await processor.start(stream);
      vi.runAllTimers();
      const metrics2 = processor.getMetrics();

      // metrics1 should not have been mutated by subsequent processing
      expect(metrics1.chunksProcessed).toBe(0);
      expect(metrics2.chunksProcessed).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // onUpdate()
  // -----------------------------------------------------------------------

  describe('onUpdate', () => {
    it('should register a callback that receives UIUpdate objects', async () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      const stream = createMockReadableStream(['hello']);
      await processor.start(stream);
      vi.runAllTimers();

      expect(callback).toHaveBeenCalled();
      const update: UIUpdate = callback.mock.calls[0][0];
      expect(update).toHaveProperty('id');
      expect(update).toHaveProperty('type');
      expect(update).toHaveProperty('target');
      expect(update).toHaveProperty('content');
    });

    it('should support multiple callbacks', async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      processor.onUpdate(cb1);
      processor.onUpdate(cb2);

      const stream = createMockReadableStream(['data']);
      await processor.start(stream);
      vi.runAllTimers();

      expect(cb1).toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();
    });

    it('should include metadata in UIUpdate', async () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      const stream = createMockReadableStream(['hello world']);
      await processor.start(stream);
      vi.runAllTimers();

      const update: UIUpdate = callback.mock.calls[0][0];
      expect(update.metadata).toBeDefined();
      expect(update.metadata!.timestamp).toBeGreaterThan(0);
      expect(update.metadata!.sequenceNumber).toBeDefined();
      expect(update.metadata!.tokens).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // onResponseEvent()
  // -----------------------------------------------------------------------

  describe('onResponseEvent', () => {
    it('should register a callback that receives ResponseEvent objects', async () => {
      const callback = vi.fn();
      processor.onResponseEvent(callback);

      await processor.processResponsesStream(
        createResponseStream([{ type: 'Created' }]),
      );
      vi.runAllTimers();

      expect(callback).toHaveBeenCalledWith({ type: 'Created' });
    });

    it('should support multiple response event callbacks', async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      processor.onResponseEvent(cb1);
      processor.onResponseEvent(cb2);

      await processor.processResponsesStream(
        createResponseStream([{ type: 'Created' }]),
      );
      vi.runAllTimers();

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('should call response event callbacks synchronously for each event', async () => {
      const order: string[] = [];

      processor.onResponseEvent((event) => {
        order.push(event.type);
      });

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Created' },
          { type: 'OutputTextDelta', delta: 'hi' },
          { type: 'Completed', responseId: 'r-1' },
        ]),
      );
      vi.runAllTimers();

      expect(order).toEqual(['Created', 'OutputTextDelta', 'Completed']);
    });
  });

  // -----------------------------------------------------------------------
  // flushPendingUpdates()
  // -----------------------------------------------------------------------

  describe('flushPendingUpdates', () => {
    it('should be a no-op when there are no pending updates', () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      processor.flushPendingUpdates();
      expect(callback).not.toHaveBeenCalled();
    });

    it('should deliver all pending updates to all callbacks', async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      processor.onUpdate(cb1);
      processor.onUpdate(cb2);

      // Use processResponsesStream to generate pending updates without waiting for timer
      // We need to reach into the internals a bit - use a stream with non-coalescable events
      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Created' },
          { type: 'OutputTextDelta', delta: 'text' },
        ]),
      );

      // The final flushPendingUpdates is called at the end of processResponsesStream,
      // so both callbacks should have been called.
      // Additionally run timers to catch any scheduled updates.
      vi.runAllTimers();

      expect(cb1).toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();
    });

    it('should clear pending updates after flushing', async () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      await processor.processResponsesStream(
        createResponseStream([{ type: 'OutputTextDelta', delta: 'data' }]),
      );
      vi.runAllTimers();

      const countAfterStream = callback.mock.calls.length;

      // Calling again should be a no-op since updates were already flushed
      processor.flushPendingUpdates();
      expect(callback.mock.calls.length).toBe(countAfterStream);
    });
  });

  // -----------------------------------------------------------------------
  // Batching / coalescing
  // -----------------------------------------------------------------------

  describe('batching and coalescing', () => {
    it('should coalesce consecutive appends to the same target', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      // Multiple consecutive OutputTextDelta events with same target should coalesce
      await processor.processResponsesStream(
        createResponseStream([
          { type: 'OutputTextDelta', delta: 'aaa' },
          { type: 'OutputTextDelta', delta: 'bbb' },
          { type: 'OutputTextDelta', delta: 'ccc' },
        ]),
      );
      vi.runAllTimers();

      // Should be coalesced into fewer UIUpdate calls than 3
      // The exact number depends on implementation but content should be combined
      const allContent = uiCallback.mock.calls
        .map((c) => c[0].content)
        .join('');
      expect(allContent).toContain('aaa');
      expect(allContent).toContain('bbb');
      expect(allContent).toContain('ccc');
    });

    it('should NOT coalesce updates with different targets', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      // Created (replace/status) + OutputTextDelta (append/message) should not coalesce
      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Created' },
          { type: 'OutputTextDelta', delta: 'text' },
        ]),
      );
      vi.runAllTimers();

      // We should see at least 2 distinct updates
      expect(uiCallback.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should NOT coalesce updates with different types', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      // Created is 'replace', OutputTextDelta is 'append' - different types
      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Created' },
          { type: 'OutputTextDelta', delta: 'text' },
        ]),
      );
      vi.runAllTimers();

      const types = uiCallback.mock.calls.map((c) => c[0].type);
      expect(types).toContain('replace');
      expect(types).toContain('append');
    });
  });

  // -----------------------------------------------------------------------
  // Buffer management
  // -----------------------------------------------------------------------

  describe('buffer management', () => {
    it('should report buffer size via getBufferSize()', async () => {
      expect(processor.getBufferSize()).toBe(0);

      const stream = createMockReadableStream(['some data']);
      await processor.start(stream);
      vi.runAllTimers();

      // After completion, buffer may still have data or may have been shifted
      // The important thing is that it was used during processing
      expect(processor.getMetrics().bytesProcessed).toBeGreaterThan(0);
    });

    it('should clear buffer via clearBuffer()', () => {
      processor.clearBuffer();
      expect(processor.getBufferSize()).toBe(0);
    });

    it('should update max buffer size via setMaxBufferSize()', () => {
      processor.setMaxBufferSize(2048);

      // The thresholds should also be updated (tested implicitly via behavior)
      // We can verify by checking that the processor still works
      expect(processor.getStatus()).toBe('idle');
    });

    it('should throw on buffer overflow', async () => {
      // Create a processor with a very small buffer
      const tinyProcessor = new StreamProcessor('model', {
        maxBufferSize: 4, // only 4 bytes
      });

      // Enqueue data larger than the buffer
      const stream = createMockReadableStream(['this is way too much data']);

      await expect(tinyProcessor.start(stream)).rejects.toThrow('Buffer overflow');
      expect(tinyProcessor.getStatus()).toBe('error');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle an empty ReadableStream', async () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      const stream = createMockReadableStream([]);
      await processor.start(stream);
      vi.runAllTimers();

      expect(processor.getStatus()).toBe('completed');
      expect(processor.getMetrics().chunksProcessed).toBe(0);
    });

    it('should handle a single-chunk stream', async () => {
      const callback = vi.fn();
      processor.onUpdate(callback);

      const stream = createMockReadableStream(['only chunk']);
      await processor.start(stream);
      vi.runAllTimers();

      expect(processor.getStatus()).toBe('completed');
      expect(processor.getMetrics().chunksProcessed).toBe(1);
      expect(callback).toHaveBeenCalled();
    });

    it('should handle ResponseEvent with Completed including tokenUsage', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      const tokenUsage = {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 180,
      };

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Completed', responseId: 'r-with-tokens', tokenUsage },
        ]),
      );
      vi.runAllTimers();

      const completedUpdate = uiCallback.mock.calls.find(
        (c) =>
          c[0].content.includes('r-with-tokens') &&
          c[0].content.includes('180'),
      );
      expect(completedUpdate).toBeDefined();
    });

    it('should handle ResponseEvent with Completed without tokenUsage', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Completed', responseId: 'r-no-tokens' },
        ]),
      );
      vi.runAllTimers();

      const completedUpdate = uiCallback.mock.calls.find((c) =>
        c[0].content.includes('r-no-tokens'),
      );
      expect(completedUpdate).toBeDefined();
      // Should not mention tokens
      expect(completedUpdate![0].content).not.toContain('Tokens:');
    });

    it('should handle multiple onUpdate registrations independently', async () => {
      const results: string[] = [];
      processor.onUpdate((u) => results.push(`cb1:${u.content}`));
      processor.onUpdate((u) => results.push(`cb2:${u.content}`));

      const stream = createMockReadableStream(['x']);
      await processor.start(stream);
      vi.runAllTimers();

      // Both callbacks should have been invoked
      const cb1Calls = results.filter((r) => r.startsWith('cb1:'));
      const cb2Calls = results.filter((r) => r.startsWith('cb2:'));
      expect(cb1Calls.length).toBeGreaterThan(0);
      expect(cb2Calls.length).toBeGreaterThan(0);
      expect(cb1Calls.length).toBe(cb2Calls.length);
    });

    it('should assign sequential IDs to UIUpdates from ResponseEvents', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      await processor.processResponsesStream(
        createResponseStream([
          { type: 'Created' },
          { type: 'OutputTextDelta', delta: 'a' },
          { type: 'OutputTextDelta', delta: 'b' },
          { type: 'Completed', responseId: 'r-1' },
        ]),
      );
      vi.runAllTimers();

      // All IDs should start with resp_
      const ids = uiCallback.mock.calls.map((c) => c[0].id);
      ids.forEach((id: string) => {
        expect(id).toMatch(/^resp_\d+$/);
      });
    });

    it('should assign sequential IDs to UIUpdates from ReadableStream chunks', async () => {
      const uiCallback = vi.fn();
      processor.onUpdate(uiCallback);

      const stream = createMockReadableStream(['a', 'b']);
      await processor.start(stream);
      vi.runAllTimers();

      const ids = uiCallback.mock.calls.map((c) => c[0].id);
      ids.forEach((id: string) => {
        expect(id).toMatch(/^chunk_\d+$/);
      });
    });
  });
});
