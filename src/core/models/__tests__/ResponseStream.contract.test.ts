/**
 * ResponseStream Contract Tests
 * Reference: contracts/ResponseStream.contract.md
 *
 * These tests verify that the TypeScript ResponseStream implementation
 * implements the channel-based streaming pattern.
 *
 * EXPECTED: Some tests may FAIL initially if ResponseStream needs refactoring
 * to fully match the channel behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResponseStream, ResponseStreamError } from '../ResponseStream';
import type { ResponseEvent } from '../types/ResponseEvent';

describe('ResponseStream Contract', () => {
  describe('Producer-Consumer Pattern', () => {
    it('implements channel behavior: producer sends, consumer receives', async () => {
      const stream = new ResponseStream();

      // Producer (async task)
      setTimeout(() => {
        stream.addEvent({ type: 'Created' });
        stream.addEvent({ type: 'OutputTextDelta', delta: 'Hello' });
        stream.addEvent({ type: 'OutputTextDelta', delta: ' World' });
        stream.complete();
      }, 0);

      // Consumer (async iteration)
      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Contract: Events received in order
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('Created');
      expect(events[1].type).toBe('OutputTextDelta');
      expect(events[2].type).toBe('OutputTextDelta');
    });

    it('supports multiple events added before iteration starts', async () => {
      const stream = new ResponseStream();

      // Add all events first (buffer them)
      stream.addEvent({ type: 'Created' });
      stream.addEvent({ type: 'OutputTextDelta', delta: 'Test' });
      stream.complete();

      // Then iterate (should get all buffered events)
      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
    });
  });

  describe('addEvent()', () => {
    it('adds event to stream', () => {
      const stream = new ResponseStream();

      stream.addEvent({ type: 'Created' });

      expect(stream.getBufferSize()).toBe(1);
    });

    it('throws when stream is completed', () => {
      const stream = new ResponseStream();
      stream.complete();

      expect(() => {
        stream.addEvent({ type: 'Created' });
      }).toThrow(ResponseStreamError);
    });

    it('throws when stream is aborted', () => {
      const stream = new ResponseStream();
      stream.abort();

      expect(() => {
        stream.addEvent({ type: 'Created' });
      }).toThrow(ResponseStreamError);
    });
  });

  describe('addEvents() - batch send', () => {
    it('adds multiple events at once', () => {
      const stream = new ResponseStream();

      stream.addEvents([
        { type: 'Created' },
        { type: 'OutputTextDelta', delta: 'A' },
        { type: 'OutputTextDelta', delta: 'B' },
      ]);

      expect(stream.getBufferSize()).toBe(3);
    });
  });

  describe('complete()', () => {
    it('marks stream as completed', () => {
      const stream = new ResponseStream();
      stream.complete();

      expect(stream.isStreamCompleted()).toBe(true);
    });

    it('allows iteration to finish after completion', async () => {
      const stream = new ResponseStream();

      stream.addEvent({ type: 'Created' });
      stream.complete();

      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
    });
  });

  describe('error()', () => {
    it('causes iteration to throw', async () => {
      const stream = new ResponseStream();
      const testError = new Error('Test error');

      setTimeout(() => stream.error(testError), 0);

      await expect(async () => {
        for await (const event of stream) {
          // Should throw before yielding
        }
      }).rejects.toThrow(ResponseStreamError);
    });

    it('marks stream as completed', () => {
      const stream = new ResponseStream();
      stream.error(new Error('Test'));

      expect(stream.isStreamCompleted()).toBe(true);
    });
  });

  describe('abort() - Cancellation', () => {
    it('cancels stream iteration', async () => {
      const stream = new ResponseStream();

      setTimeout(() => stream.abort(), 10);

      await expect(async () => {
        for await (const event of stream) {
          // Should be aborted
        }
      }).rejects.toThrow(/abort/i);
    });

    it('marks stream as aborted', () => {
      const stream = new ResponseStream();
      stream.abort();

      expect(stream.isAborted()).toBe(true);
    });
  });

  describe('[Symbol.asyncIterator]() - Async iteration', () => {
    it('implements async iterator protocol', () => {
      const stream = new ResponseStream();

      expect(stream[Symbol.asyncIterator]).toBeDefined();
      expect(typeof stream[Symbol.asyncIterator]).toBe('function');
    });

    it('yields events in FIFO order', async () => {
      const stream = new ResponseStream();

      stream.addEvent({ type: 'Created' });
      stream.addEvent({ type: 'OutputTextDelta', delta: 'First' });
      stream.addEvent({ type: 'OutputTextDelta', delta: 'Second' });
      stream.complete();

      const deltas: string[] = [];
      for await (const event of stream) {
        if (event.type === 'OutputTextDelta') {
          deltas.push(event.delta);
        }
      }

      expect(deltas).toEqual(['First', 'Second']);
    });

    it('waits for new events when buffer empty', async () => {
      const stream = new ResponseStream();

      // Add event after a delay
      setTimeout(() => {
        stream.addEvent({ type: 'Created' });
        stream.complete();
      }, 50);

      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
    });
  });

  describe('Backpressure', () => {
    it('throws when buffer full (backpressure enabled)', () => {
      const stream = new ResponseStream(undefined, {
        maxBufferSize: 2,
        enableBackpressure: true,
        eventTimeout: 30000,
      });

      stream.addEvent({ type: 'Created' });
      stream.addEvent({ type: 'OutputTextDelta', delta: 'A' });

      // Buffer full (2 events)
      expect(() => {
        stream.addEvent({ type: 'OutputTextDelta', delta: 'B' });
      }).toThrow(ResponseStreamError);
      expect(() => {
        stream.addEvent({ type: 'OutputTextDelta', delta: 'B' });
      }).toThrow(/backpressure/i);
    });

    it('does not throw when backpressure disabled', () => {
      const stream = new ResponseStream(undefined, {
        maxBufferSize: 2,
        enableBackpressure: false,
        eventTimeout: 30000,
      });

      stream.addEvent({ type: 'Created' });
      stream.addEvent({ type: 'OutputTextDelta', delta: 'A' });

      // Should not throw even when over buffer size
      expect(() => {
        stream.addEvent({ type: 'OutputTextDelta', delta: 'B' });
      }).not.toThrow();
    });
  });

  describe('Timeout handling', () => {
    it('throws timeout error when no events for eventTimeout ms', async () => {
      const stream = new ResponseStream(undefined, {
        eventTimeout: 100, // 100ms timeout
        maxBufferSize: 1000,
        enableBackpressure: true,
      });

      // Don't add any events
      await expect(async () => {
        for await (const event of stream) {
          // Should timeout
        }
      }).rejects.toThrow(/timeout/i);
    }, 200);

    it('resets timeout when new event added', async () => {
      const stream = new ResponseStream(undefined, {
        eventTimeout: 150,
        maxBufferSize: 1000,
        enableBackpressure: true,
      });

      // Add events with delays less than timeout
      setTimeout(() => stream.addEvent({ type: 'Created' }), 50);
      setTimeout(() => stream.addEvent({ type: 'OutputTextDelta', delta: 'Hi' }), 100);
      setTimeout(() => stream.complete(), 120);

      const events: ResponseEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
    }, 300);
  });

  describe('Utility methods', () => {
    it('getBufferSize() returns current buffer size', () => {
      const stream = new ResponseStream();

      expect(stream.getBufferSize()).toBe(0);

      stream.addEvent({ type: 'Created' });
      expect(stream.getBufferSize()).toBe(1);

      stream.addEvent({ type: 'OutputTextDelta', delta: 'Test' });
      expect(stream.getBufferSize()).toBe(2);
    });

    it('isStreamCompleted() returns completion status', () => {
      const stream = new ResponseStream();

      expect(stream.isStreamCompleted()).toBe(false);

      stream.complete();
      expect(stream.isStreamCompleted()).toBe(true);
    });

    it('isAborted() returns abort status', () => {
      const stream = new ResponseStream();

      expect(stream.isAborted()).toBe(false);

      stream.abort();
      expect(stream.isAborted()).toBe(true);
    });
  });

  describe('toArray() - Testing helper', () => {
    it('collects all events into array', async () => {
      const stream = new ResponseStream();

      stream.addEvents([
        { type: 'Created' },
        { type: 'OutputTextDelta', delta: 'Hello' },
        { type: 'Completed', responseId: '123' },
      ]);
      stream.complete();

      const events = await stream.toArray();

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('Created');
      expect(events[2].type).toBe('Completed');
    });
  });

  describe('take() - Limit events', () => {
    it('yields only first N events', async () => {
      const stream = new ResponseStream();

      stream.addEvents([
        { type: 'Created' },
        { type: 'OutputTextDelta', delta: '1' },
        { type: 'OutputTextDelta', delta: '2' },
        { type: 'OutputTextDelta', delta: '3' },
        { type: 'Completed', responseId: '123' },
      ]);
      stream.complete();

      const events: ResponseEvent[] = [];
      for await (const event of stream.take(3)) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
    });
  });

  describe('filter() - Predicate filtering', () => {
    it('yields only events matching predicate', async () => {
      const stream = new ResponseStream();

      stream.addEvents([
        { type: 'Created' },
        { type: 'OutputTextDelta', delta: 'A' },
        { type: 'OutputTextDelta', delta: 'B' },
        { type: 'Completed', responseId: '123' },
      ]);
      stream.complete();

      const textDeltas: ResponseEvent[] = [];
      for await (const event of stream.filter((e) => e.type === 'OutputTextDelta')) {
        textDeltas.push(event);
      }

      expect(textDeltas).toHaveLength(2);
      expect(textDeltas.every((e) => e.type === 'OutputTextDelta')).toBe(true);
    });
  });

  describe('map() - Transform events', () => {
    it('transforms events with mapper function', async () => {
      const stream = new ResponseStream();

      stream.addEvents([
        { type: 'Created' },
        { type: 'OutputTextDelta', delta: 'Hello' },
        { type: 'Completed', responseId: '123' },
      ]);
      stream.complete();

      const types: string[] = [];
      for await (const type of stream.map((e) => e.type)) {
        types.push(type);
      }

      expect(types).toEqual(['Created', 'OutputTextDelta', 'Completed']);
    });
  });

  describe('Static factory methods', () => {
    it('fromEvents() creates stream from array', async () => {
      const events: ResponseEvent[] = [
        { type: 'Created' },
        { type: 'Completed', responseId: '123' },
      ];

      const stream = ResponseStream.fromEvents(events);

      const received: ResponseEvent[] = [];
      for await (const event of stream) {
        received.push(event);
      }

      expect(received).toHaveLength(2);
      expect(received[0].type).toBe('Created');
    });

    it('fromError() creates stream that errors immediately', async () => {
      const testError = new Error('Test error');
      const stream = ResponseStream.fromError(testError);

      await expect(async () => {
        for await (const event of stream) {
          // Should error immediately
        }
      }).rejects.toThrow(ResponseStreamError);
    });
  });

  describe('AbortSignal integration', () => {
    it('respects external AbortSignal', async () => {
      const controller = new AbortController();
      const stream = new ResponseStream(controller.signal);

      setTimeout(() => controller.abort(), 10);

      await expect(async () => {
        for await (const event of stream) {
          // Should be aborted by external signal
        }
      }).rejects.toThrow(/abort/i);
    });

    it('handles pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = new ResponseStream(controller.signal);

      await expect(async () => {
        for await (const event of stream) {
          // Should throw immediately
        }
      }).rejects.toThrow(/abort/i);
    });
  });
});
