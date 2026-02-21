/**
 * Edge Case Test: SSE Stream Timeout
 *
 * Tests that idle timeout is detected and stream closes with error
 *
 * **Quickstart Reference**: Edge Case 2
 * **Rust Reference**: pi-rs/core/src/client.rs SSE processing with timeout
 * **Implementation**: ResponseStream.ts Lines 229-270 (waitForEvent timeout)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResponseStream, ResponseStreamError } from '@/core/models/ResponseStream';
import type { ResponseEvent } from '@/core/models/types/ResponseEvent';

describe('Edge Case: SSE Stream Timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should timeout when no events arrive within timeout period', async () => {
    // Create stream with short timeout (100ms for testing)
    const stream = new ResponseStream(undefined, {
      eventTimeout: 100,
      maxBufferSize: 1000,
      enableBackpressure: true,
    });

    // Don't add any events - stream will wait and timeout
    const events: ResponseEvent[] = [];

    try {
      for await (const event of stream) {
        events.push(event);
      }
      expect.fail('Should have thrown timeout error');
    } catch (error) {
      // Verify timeout error
      expect(error).toBeInstanceOf(ResponseStreamError);
      if (error instanceof ResponseStreamError) {
        expect(error.message).toContain('Event timeout');
        expect(error.message).toContain('100ms');
        expect(error.code).toBe('TIMEOUT');
      }
    }

    // No events should have been received
    expect(events).toHaveLength(0);
  });

  it('should not timeout if events arrive before timeout', async () => {
    // Create stream with reasonable timeout
    const stream = new ResponseStream(undefined, {
      eventTimeout: 1000,
      maxBufferSize: 1000,
      enableBackpressure: true,
    });

    // Add events periodically
    setTimeout(() => {
      stream.addEvent({ type: 'Created' } as any);
    }, 50);

    setTimeout(() => {
      stream.addEvent({
        type: 'OutputTextDelta',
        delta: 'Hello',
      } as any);
    }, 100);

    setTimeout(() => {
      stream.complete();
    }, 150);

    // Collect events
    const events: ResponseEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should receive all events without timeout
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('Created');
    expect(events[1].type).toBe('OutputTextDelta');
  });

  it('should handle abort signal to stop waiting', async () => {
    const abortController = new AbortController();
    const stream = new ResponseStream(abortController.signal, {
      eventTimeout: 5000, // Long timeout
      maxBufferSize: 1000,
      enableBackpressure: true,
    });

    // Abort after 50ms
    setTimeout(() => {
      abortController.abort();
    }, 50);

    try {
      for await (const event of stream) {
        // Should not receive events
      }
      expect.fail('Should have thrown abort error');
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseStreamError);
      if (error instanceof ResponseStreamError) {
        expect(error.message).toContain('aborted');
        expect(error.code).toBe('ABORTED');
      }
    }
  });

  it('should timeout during long gaps between events', async () => {
    // Stream with 200ms timeout
    const stream = new ResponseStream(undefined, {
      eventTimeout: 200,
      maxBufferSize: 1000,
      enableBackpressure: true,
    });

    // Add first event quickly
    setTimeout(() => {
      stream.addEvent({ type: 'Created' } as any);
    }, 10);

    // Don't add second event - will timeout waiting
    // (simulates SSE stream that hangs mid-stream)

    const events: ResponseEvent[] = [];

    try {
      for await (const event of stream) {
        events.push(event);
      }
      expect.fail('Should have thrown timeout error');
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseStreamError);
      if (error instanceof ResponseStreamError) {
        expect(error.code).toBe('TIMEOUT');
      }
    }

    // Should have received first event before timeout
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('Created');
  });

  it('should match quickstart edge case 2 example', async () => {
    // Quickstart Edge Case 2: SSE stream that hangs

    // Given: Stream with timeout configured
    const stream = new ResponseStream(undefined, {
      eventTimeout: 100, // 100ms for test
      maxBufferSize: 1000,
      enableBackpressure: true,
    });

    // Simulate: Never send data (simulates timeout)
    // Don't add any events or call complete()

    // When: Processing with timeout
    try {
      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }
      expect.fail('Should have thrown timeout error');
    } catch (error) {
      // Then: Idle timeout detected and stream closed
      expect(error).toBeInstanceOf(ResponseStreamError);
      if (error instanceof ResponseStreamError) {
        expect(error.message).toMatch(/timeout/i);
        expect(error.code).toBe('TIMEOUT');
      }
      // ✅ PASS: Timeout handling works
    }
  });

  it('should provide useful timeout error message', async () => {
    const timeoutMs = 250;
    const stream = new ResponseStream(undefined, {
      eventTimeout: timeoutMs,
      maxBufferSize: 1000,
      enableBackpressure: true,
    });

    try {
      for await (const event of stream) {
        // Should not reach here
      }
      expect.fail('Should have thrown');
    } catch (error) {
      if (error instanceof ResponseStreamError) {
        // Error message should include timeout value
        expect(error.message).toContain(`${timeoutMs}ms`);
        expect(error.message).toContain('Event timeout');
        expect(error.code).toBe('TIMEOUT');
      }
    }
  });

  it('should allow stream completion before timeout', async () => {
    const stream = new ResponseStream(undefined, {
      eventTimeout: 1000,
      maxBufferSize: 1000,
      enableBackpressure: true,
    });

    // Add events and complete quickly
    stream.addEvent({ type: 'Created' } as any);
    stream.addEvent({
      type: 'OutputTextDelta',
      delta: 'Test',
    } as any);
    stream.complete();

    // Should complete successfully without timeout
    const events: ResponseEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
  });

  it('should handle error() before timeout', async () => {
    const stream = new ResponseStream(undefined, {
      eventTimeout: 1000,
      maxBufferSize: 1000,
      enableBackpressure: true,
    });

    // Trigger error before timeout
    setTimeout(() => {
      stream.error(new Error('Stream failed'));
    }, 50);

    try {
      for await (const event of stream) {
        // Should not receive events
      }
      expect.fail('Should have thrown error');
    } catch (error) {
      // Should get stream error, not timeout
      expect(error).toBeInstanceOf(ResponseStreamError);
      if (error instanceof ResponseStreamError) {
        expect(error.code).toBe('STREAM_ERROR');
        expect(error.message).toContain('Stream error');
      }
    }
  });
});
