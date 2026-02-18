/**
 * Unit tests for QueueProcessor
 *
 * Tests verify:
 * - PriorityQueue: enqueue, dequeue, peek, size, isEmpty, clear, priority ordering
 * - PriorityQueue: max size enforcement, processing state, getItems
 * - SubmissionQueue: submit with auto-priority, cancelByType
 * - EventQueue: emit with auto-priority, on/off listeners, getEventsByType
 * - EventQueue: listener error handling, multiple listeners, unsubscribe
 * - QueueProcessor: start/stop interval, processTick batch processing, getStats
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PriorityQueue,
  QueuePriority,
  SubmissionQueue,
  EventQueue,
  QueueProcessor,
} from '@/core/QueueProcessor';
import type { Submission, Op, Event } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubmission(opType: Op['type'], overrides: Partial<Submission> = {}): Submission {
  let op: Op;
  switch (opType) {
    case 'Interrupt':
      op = { type: 'Interrupt' };
      break;
    case 'Shutdown':
      op = { type: 'Shutdown' };
      break;
    case 'ExecApproval':
      op = { type: 'ExecApproval', id: 'appr-1', decision: 'approve' };
      break;
    case 'PatchApproval':
      op = { type: 'PatchApproval', id: 'patch-1', decision: 'approve' };
      break;
    case 'UserTurn':
      op = {
        type: 'UserTurn',
        items: [{ type: 'text', text: 'hello' }],
        tabId: 1,
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' },
        model: 'gpt-4',
        summary: { enabled: false },
      };
      break;
    case 'UserInput':
      op = { type: 'UserInput', items: [{ type: 'text', text: 'input' }] };
      break;
    default:
      op = { type: opType } as Op;
      break;
  }

  return {
    id: `sub-${opType}-${Math.random().toString(36).slice(2, 8)}`,
    op,
    ...overrides,
  };
}

function makeEvent(msgType: string, overrides: Partial<Event> = {}): Event {
  let msg: EventMsg;
  switch (msgType) {
    case 'Error':
      msg = { type: 'Error', data: { message: 'test error' } };
      break;
    case 'TurnAborted':
      msg = { type: 'TurnAborted', data: { reason: 'user_interrupt' } };
      break;
    case 'ShutdownComplete':
      msg = { type: 'ShutdownComplete' };
      break;
    case 'ExecApprovalRequest':
      msg = { type: 'ExecApprovalRequest', data: { id: 'req-1', command: 'ls' } };
      break;
    case 'ApplyPatchApprovalRequest':
      msg = { type: 'ApplyPatchApprovalRequest', data: { id: 'patch-1', path: '/tmp', patch: 'diff' } };
      break;
    case 'TaskStarted':
      msg = { type: 'TaskStarted', data: {} };
      break;
    case 'TaskComplete':
      msg = { type: 'TaskComplete', data: {} };
      break;
    case 'AgentMessage':
      msg = { type: 'AgentMessage', data: { message: 'hello' } };
      break;
    default:
      msg = { type: 'BackgroundEvent', data: { message: 'bg' } } as EventMsg;
      break;
  }

  return {
    id: `evt-${msgType}-${Math.random().toString(36).slice(2, 8)}`,
    msg,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PriorityQueue Tests
// ---------------------------------------------------------------------------

describe('PriorityQueue', () => {
  let queue: PriorityQueue<string>;

  beforeEach(() => {
    queue = new PriorityQueue<string>();
  });

  // -----------------------------------------------------------------------
  // Basic operations
  // -----------------------------------------------------------------------
  describe('enqueue()', () => {
    it('should add an item and return true', () => {
      const result = queue.enqueue('item1');
      expect(result).toBe(true);
      expect(queue.size()).toBe(1);
    });

    it('should add multiple items', () => {
      queue.enqueue('a');
      queue.enqueue('b');
      queue.enqueue('c');
      expect(queue.size()).toBe(3);
    });

    it('should default to NORMAL priority', () => {
      queue.enqueue('normal-item');
      // If we add a HIGH priority item after, it should come first
      queue.enqueue('high-item', QueuePriority.HIGH);
      expect(queue.dequeue()).toBe('high-item');
      expect(queue.dequeue()).toBe('normal-item');
    });

    it('should reject items when queue is at max size', () => {
      const smallQueue = new PriorityQueue<string>(2);
      expect(smallQueue.enqueue('a')).toBe(true);
      expect(smallQueue.enqueue('b')).toBe(true);
      expect(smallQueue.enqueue('c')).toBe(false);
      expect(smallQueue.size()).toBe(2);
    });

    it('should use default maxSize of 1000', () => {
      const defaultQueue = new PriorityQueue<number>();
      for (let i = 0; i < 1000; i++) {
        expect(defaultQueue.enqueue(i)).toBe(true);
      }
      expect(defaultQueue.enqueue(1001)).toBe(false);
      expect(defaultQueue.size()).toBe(1000);
    });
  });

  describe('dequeue()', () => {
    it('should return null when queue is empty', () => {
      expect(queue.dequeue()).toBeNull();
    });

    it('should remove and return the first item', () => {
      queue.enqueue('first');
      queue.enqueue('second');
      expect(queue.dequeue()).toBe('first');
      expect(queue.size()).toBe(1);
    });

    it('should return items in priority order (HIGH before NORMAL before LOW)', () => {
      queue.enqueue('low', QueuePriority.LOW);
      queue.enqueue('high', QueuePriority.HIGH);
      queue.enqueue('normal', QueuePriority.NORMAL);

      expect(queue.dequeue()).toBe('high');
      expect(queue.dequeue()).toBe('normal');
      expect(queue.dequeue()).toBe('low');
    });
  });

  describe('peek()', () => {
    it('should return null when queue is empty', () => {
      expect(queue.peek()).toBeNull();
    });

    it('should return the next item without removing it', () => {
      queue.enqueue('peeked');
      expect(queue.peek()).toBe('peeked');
      expect(queue.size()).toBe(1);
    });

    it('should return the highest priority item', () => {
      queue.enqueue('low', QueuePriority.LOW);
      queue.enqueue('high', QueuePriority.HIGH);
      expect(queue.peek()).toBe('high');
    });
  });

  describe('size()', () => {
    it('should return 0 for a new queue', () => {
      expect(queue.size()).toBe(0);
    });

    it('should update after enqueue and dequeue', () => {
      queue.enqueue('a');
      expect(queue.size()).toBe(1);
      queue.enqueue('b');
      expect(queue.size()).toBe(2);
      queue.dequeue();
      expect(queue.size()).toBe(1);
    });
  });

  describe('isEmpty()', () => {
    it('should return true for a new queue', () => {
      expect(queue.isEmpty()).toBe(true);
    });

    it('should return false after adding an item', () => {
      queue.enqueue('item');
      expect(queue.isEmpty()).toBe(false);
    });

    it('should return true after removing all items', () => {
      queue.enqueue('item');
      queue.dequeue();
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('clear()', () => {
    it('should remove all items', () => {
      queue.enqueue('a');
      queue.enqueue('b');
      queue.clear();
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
    });

    it('should be safe to call on empty queue', () => {
      expect(() => queue.clear()).not.toThrow();
      expect(queue.size()).toBe(0);
    });
  });

  describe('setProcessing() / isProcessing()', () => {
    it('should default to false', () => {
      expect(queue.isProcessing()).toBe(false);
    });

    it('should set processing state to true', () => {
      queue.setProcessing(true);
      expect(queue.isProcessing()).toBe(true);
    });

    it('should toggle processing state', () => {
      queue.setProcessing(true);
      expect(queue.isProcessing()).toBe(true);
      queue.setProcessing(false);
      expect(queue.isProcessing()).toBe(false);
    });
  });

  describe('getItems()', () => {
    it('should return empty array for empty queue', () => {
      expect(queue.getItems()).toEqual([]);
    });

    it('should return all items in priority order', () => {
      queue.enqueue('low', QueuePriority.LOW);
      queue.enqueue('high', QueuePriority.HIGH);
      queue.enqueue('normal', QueuePriority.NORMAL);

      const items = queue.getItems();
      expect(items).toEqual(['high', 'normal', 'low']);
    });

    it('should not remove items from the queue', () => {
      queue.enqueue('a');
      queue.enqueue('b');
      queue.getItems();
      expect(queue.size()).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Priority ordering
  // -----------------------------------------------------------------------
  describe('priority ordering', () => {
    it('should maintain FIFO order within same priority', () => {
      queue.enqueue('first', QueuePriority.NORMAL);
      queue.enqueue('second', QueuePriority.NORMAL);
      queue.enqueue('third', QueuePriority.NORMAL);

      expect(queue.dequeue()).toBe('first');
      expect(queue.dequeue()).toBe('second');
      expect(queue.dequeue()).toBe('third');
    });

    it('should interleave priorities correctly', () => {
      queue.enqueue('low1', QueuePriority.LOW);
      queue.enqueue('high1', QueuePriority.HIGH);
      queue.enqueue('normal1', QueuePriority.NORMAL);
      queue.enqueue('high2', QueuePriority.HIGH);
      queue.enqueue('low2', QueuePriority.LOW);

      expect(queue.dequeue()).toBe('high1');
      expect(queue.dequeue()).toBe('high2');
      expect(queue.dequeue()).toBe('normal1');
      expect(queue.dequeue()).toBe('low1');
      expect(queue.dequeue()).toBe('low2');
    });

    it('should place HIGH (0) before NORMAL (1) before LOW (2)', () => {
      expect(QueuePriority.HIGH).toBe(0);
      expect(QueuePriority.NORMAL).toBe(1);
      expect(QueuePriority.LOW).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// SubmissionQueue Tests
// ---------------------------------------------------------------------------

describe('SubmissionQueue', () => {
  let queue: SubmissionQueue;

  beforeEach(() => {
    queue = new SubmissionQueue();
  });

  describe('submit()', () => {
    it('should add a submission to the queue', () => {
      const sub = makeSubmission('UserTurn');
      const result = queue.submit(sub);
      expect(result).toBe(true);
      expect(queue.size()).toBe(1);
    });

    it('should assign HIGH priority to Interrupt operations', () => {
      const interrupt = makeSubmission('Interrupt');
      const userTurn = makeSubmission('UserTurn');

      queue.submit(userTurn);
      queue.submit(interrupt);

      // Interrupt should come first (HIGH priority)
      const first = queue.dequeue();
      expect(first?.op.type).toBe('Interrupt');
    });

    it('should assign HIGH priority to Shutdown operations', () => {
      const shutdown = makeSubmission('Shutdown');
      const userInput = makeSubmission('UserInput');

      queue.submit(userInput);
      queue.submit(shutdown);

      const first = queue.dequeue();
      expect(first?.op.type).toBe('Shutdown');
    });

    it('should assign HIGH priority to ExecApproval operations', () => {
      const approval = makeSubmission('ExecApproval');
      const low = makeSubmission('Compact');

      queue.submit(low);
      queue.submit(approval);

      const first = queue.dequeue();
      expect(first?.op.type).toBe('ExecApproval');
    });

    it('should assign HIGH priority to PatchApproval operations', () => {
      const patch = makeSubmission('PatchApproval');
      const low = makeSubmission('Compact');

      queue.submit(low);
      queue.submit(patch);

      const first = queue.dequeue();
      expect(first?.op.type).toBe('PatchApproval');
    });

    it('should assign NORMAL priority to UserTurn operations', () => {
      const userTurn = makeSubmission('UserTurn');
      const low = makeSubmission('Compact');
      const high = makeSubmission('Interrupt');

      queue.submit(low);
      queue.submit(userTurn);
      queue.submit(high);

      const first = queue.dequeue();
      const second = queue.dequeue();
      const third = queue.dequeue();

      expect(first?.op.type).toBe('Interrupt');
      expect(second?.op.type).toBe('UserTurn');
      expect(third?.op.type).toBe('Compact');
    });

    it('should assign NORMAL priority to UserInput operations', () => {
      const userInput = makeSubmission('UserInput');
      const low = makeSubmission('Compact');

      queue.submit(low);
      queue.submit(userInput);

      const first = queue.dequeue();
      expect(first?.op.type).toBe('UserInput');
    });

    it('should assign LOW priority to unknown/default operation types', () => {
      const compact = makeSubmission('Compact');
      const userTurn = makeSubmission('UserTurn');

      queue.submit(compact);
      queue.submit(userTurn);

      const first = queue.dequeue();
      expect(first?.op.type).toBe('UserTurn');
    });
  });

  describe('cancelByType()', () => {
    it('should remove all submissions of a specific type', () => {
      queue.submit(makeSubmission('UserTurn'));
      queue.submit(makeSubmission('Compact'));
      queue.submit(makeSubmission('UserTurn'));

      const cancelled = queue.cancelByType('UserTurn');

      expect(cancelled).toBe(2);
      expect(queue.size()).toBe(1);
      const remaining = queue.dequeue();
      expect(remaining?.op.type).toBe('Compact');
    });

    it('should return 0 when no matching submissions exist', () => {
      queue.submit(makeSubmission('Compact'));
      const cancelled = queue.cancelByType('Shutdown');
      expect(cancelled).toBe(0);
      expect(queue.size()).toBe(1);
    });

    it('should cancel all submissions when all match the type', () => {
      queue.submit(makeSubmission('UserTurn'));
      queue.submit(makeSubmission('UserTurn'));

      const cancelled = queue.cancelByType('UserTurn');

      expect(cancelled).toBe(2);
      expect(queue.isEmpty()).toBe(true);
    });

    it('should work on an empty queue', () => {
      const cancelled = queue.cancelByType('Interrupt');
      expect(cancelled).toBe(0);
    });

    it('should maintain priority order after cancellation', () => {
      queue.submit(makeSubmission('Interrupt'));
      queue.submit(makeSubmission('UserTurn'));
      queue.submit(makeSubmission('Compact'));

      queue.cancelByType('UserTurn');

      const first = queue.dequeue();
      const second = queue.dequeue();

      expect(first?.op.type).toBe('Interrupt');
      expect(second?.op.type).toBe('Compact');
    });
  });
});

// ---------------------------------------------------------------------------
// EventQueue Tests
// ---------------------------------------------------------------------------

describe('EventQueue', () => {
  let queue: EventQueue;

  beforeEach(() => {
    queue = new EventQueue();
  });

  describe('emit()', () => {
    it('should add an event to the queue', () => {
      const event = makeEvent('TaskStarted');
      const result = queue.emit(event);
      expect(result).toBe(true);
      expect(queue.size()).toBe(1);
    });

    it('should assign HIGH priority to Error events', () => {
      const error = makeEvent('Error');
      const task = makeEvent('TaskStarted');

      queue.emit(task);
      queue.emit(error);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('Error');
    });

    it('should assign HIGH priority to TurnAborted events', () => {
      const aborted = makeEvent('TurnAborted');
      const task = makeEvent('TaskStarted');

      queue.emit(task);
      queue.emit(aborted);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('TurnAborted');
    });

    it('should assign HIGH priority to ShutdownComplete events', () => {
      const shutdown = makeEvent('ShutdownComplete');
      const bg = makeEvent('BackgroundEvent');

      queue.emit(bg);
      queue.emit(shutdown);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('ShutdownComplete');
    });

    it('should assign HIGH priority to ExecApprovalRequest events', () => {
      const approvalReq = makeEvent('ExecApprovalRequest');
      const bg = makeEvent('BackgroundEvent');

      queue.emit(bg);
      queue.emit(approvalReq);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('ExecApprovalRequest');
    });

    it('should assign HIGH priority to ApplyPatchApprovalRequest events', () => {
      const patchReq = makeEvent('ApplyPatchApprovalRequest');
      const bg = makeEvent('BackgroundEvent');

      queue.emit(bg);
      queue.emit(patchReq);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('ApplyPatchApprovalRequest');
    });

    it('should assign NORMAL priority to TaskStarted events', () => {
      const task = makeEvent('TaskStarted');
      const bg = makeEvent('BackgroundEvent');

      queue.emit(bg);
      queue.emit(task);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('TaskStarted');
    });

    it('should assign NORMAL priority to TaskComplete events', () => {
      const complete = makeEvent('TaskComplete');
      const bg = makeEvent('BackgroundEvent');

      queue.emit(bg);
      queue.emit(complete);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('TaskComplete');
    });

    it('should assign NORMAL priority to AgentMessage events', () => {
      const agentMsg = makeEvent('AgentMessage');
      const bg = makeEvent('BackgroundEvent');

      queue.emit(bg);
      queue.emit(agentMsg);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('AgentMessage');
    });

    it('should assign LOW priority to unrecognized event types', () => {
      const bg = makeEvent('BackgroundEvent');
      const task = makeEvent('TaskStarted');

      queue.emit(bg);
      queue.emit(task);

      const first = queue.dequeue();
      expect(first?.msg.type).toBe('TaskStarted');
    });
  });

  describe('on() / listener subscription', () => {
    it('should notify listener when matching event is emitted', () => {
      const listener = vi.fn();
      queue.on('TaskStarted', listener);

      const event = makeEvent('TaskStarted');
      queue.emit(event);

      expect(listener).toHaveBeenCalledWith(event);
    });

    it('should not notify listener for non-matching event types', () => {
      const listener = vi.fn();
      queue.on('TaskStarted', listener);

      queue.emit(makeEvent('Error'));

      expect(listener).not.toHaveBeenCalled();
    });

    it('should support multiple listeners for the same event type', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      queue.on('Error', listener1);
      queue.on('Error', listener2);

      const event = makeEvent('Error');
      queue.emit(event);

      expect(listener1).toHaveBeenCalledWith(event);
      expect(listener2).toHaveBeenCalledWith(event);
    });

    it('should return an unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = queue.on('TaskStarted', listener);

      // First emit should notify
      queue.emit(makeEvent('TaskStarted'));
      expect(listener).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsub();

      // Second emit should not notify
      queue.emit(makeEvent('TaskStarted'));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should handle unsubscribing one listener without affecting others', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      const unsub1 = queue.on('Error', listener1);
      queue.on('Error', listener2);

      unsub1();

      const event = makeEvent('Error');
      queue.emit(event);

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledWith(event);
    });
  });

  describe('listener error handling', () => {
    it('should catch errors thrown by listeners and continue', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const throwingListener = vi.fn(() => {
        throw new Error('listener failure');
      });
      const normalListener = vi.fn();

      queue.on('Error', throwingListener);
      queue.on('Error', normalListener);

      const event = makeEvent('Error');
      queue.emit(event);

      expect(throwingListener).toHaveBeenCalledWith(event);
      expect(normalListener).toHaveBeenCalledWith(event);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error in event listener for Error'),
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });
  });

  describe('getEventsByType()', () => {
    it('should return events matching the type', () => {
      queue.emit(makeEvent('TaskStarted'));
      queue.emit(makeEvent('Error'));
      queue.emit(makeEvent('TaskStarted'));

      const started = queue.getEventsByType('TaskStarted');
      expect(started).toHaveLength(2);
      started.forEach(e => {
        expect(e.msg.type).toBe('TaskStarted');
      });
    });

    it('should return empty array when no events match', () => {
      queue.emit(makeEvent('Error'));
      const results = queue.getEventsByType('TaskComplete');
      expect(results).toEqual([]);
    });

    it('should return empty array on empty queue', () => {
      expect(queue.getEventsByType('Error')).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// QueueProcessor Tests
// ---------------------------------------------------------------------------

describe('QueueProcessor', () => {
  let submissionQueue: SubmissionQueue;
  let eventQueue: EventQueue;
  let processor: QueueProcessor;

  beforeEach(() => {
    vi.useFakeTimers();
    submissionQueue = new SubmissionQueue();
    eventQueue = new EventQueue();
    processor = new QueueProcessor(submissionQueue, eventQueue);
  });

  afterEach(() => {
    processor.stop();
    vi.useRealTimers();
  });

  describe('start()', () => {
    it('should begin processing at the given interval', () => {
      submissionQueue.submit(makeSubmission('UserTurn'));
      processor.start(50);

      expect(submissionQueue.size()).toBe(1);

      vi.advanceTimersByTime(50);

      expect(submissionQueue.size()).toBe(0);
    });

    it('should use default interval of 10ms', () => {
      submissionQueue.submit(makeSubmission('UserTurn'));
      processor.start();

      vi.advanceTimersByTime(10);

      expect(submissionQueue.size()).toBe(0);
    });

    it('should not create multiple intervals if called multiple times', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      processor.start(100);
      processor.start(100);
      processor.start(100);

      // setInterval is called once during start(); subsequent calls are no-ops
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      setIntervalSpy.mockRestore();
    });
  });

  describe('stop()', () => {
    it('should stop processing', () => {
      submissionQueue.submit(makeSubmission('UserTurn'));
      processor.start(10);

      processor.stop();

      vi.advanceTimersByTime(100);

      // Item should still be in queue since processing was stopped
      expect(submissionQueue.size()).toBe(1);
    });

    it('should be safe to call stop when not started', () => {
      expect(() => processor.stop()).not.toThrow();
    });

    it('should be safe to call stop multiple times', () => {
      processor.start(10);
      expect(() => {
        processor.stop();
        processor.stop();
      }).not.toThrow();
    });

    it('should allow restart after stop', () => {
      submissionQueue.submit(makeSubmission('UserTurn'));
      processor.start(10);
      processor.stop();

      // Add another item and restart
      submissionQueue.submit(makeSubmission('Compact'));
      processor.start(10);

      vi.advanceTimersByTime(10);

      // First item was already submitted before first start, second tick dequeues
      // After restart and one tick, at least one item should be dequeued
      expect(submissionQueue.size()).toBeLessThanOrEqual(1);
    });
  });

  describe('processTick()', () => {
    it('should dequeue one submission per tick with default batchSize of 1', () => {
      submissionQueue.submit(makeSubmission('UserTurn'));
      submissionQueue.submit(makeSubmission('Compact'));

      processor.start(10);
      vi.advanceTimersByTime(10);

      expect(submissionQueue.size()).toBe(1);

      vi.advanceTimersByTime(10);
      expect(submissionQueue.size()).toBe(0);
    });

    it('should skip processing if submission queue is already processing', () => {
      submissionQueue.submit(makeSubmission('UserTurn'));
      submissionQueue.setProcessing(true);

      processor.start(10);
      vi.advanceTimersByTime(10);

      // Item should still be there since processing was skipped
      expect(submissionQueue.size()).toBe(1);

      // Unblock and try again
      submissionQueue.setProcessing(false);
      vi.advanceTimersByTime(10);
      expect(submissionQueue.size()).toBe(0);
    });

    it('should do nothing when submission queue is empty', () => {
      processor.start(10);
      vi.advanceTimersByTime(100);

      expect(submissionQueue.size()).toBe(0);
      expect(submissionQueue.isProcessing()).toBe(false);
    });
  });

  describe('batch processing', () => {
    it('should process multiple submissions per tick with batchSize > 1', () => {
      const batchProcessor = new QueueProcessor(submissionQueue, eventQueue, 3);

      submissionQueue.submit(makeSubmission('UserTurn'));
      submissionQueue.submit(makeSubmission('Compact'));
      submissionQueue.submit(makeSubmission('Shutdown'));

      batchProcessor.start(10);
      vi.advanceTimersByTime(10);

      expect(submissionQueue.size()).toBe(0);
      batchProcessor.stop();
    });

    it('should process only available items if fewer than batchSize', () => {
      const batchProcessor = new QueueProcessor(submissionQueue, eventQueue, 5);

      submissionQueue.submit(makeSubmission('UserTurn'));
      submissionQueue.submit(makeSubmission('Compact'));

      batchProcessor.start(10);
      vi.advanceTimersByTime(10);

      expect(submissionQueue.size()).toBe(0);
      batchProcessor.stop();
    });

    it('should process exactly batchSize items when more are available', () => {
      const batchProcessor = new QueueProcessor(submissionQueue, eventQueue, 2);

      submissionQueue.submit(makeSubmission('UserTurn'));
      submissionQueue.submit(makeSubmission('Compact'));
      submissionQueue.submit(makeSubmission('Shutdown'));
      submissionQueue.submit(makeSubmission('Interrupt'));

      batchProcessor.start(10);
      vi.advanceTimersByTime(10);

      expect(submissionQueue.size()).toBe(2);
      batchProcessor.stop();
    });
  });

  describe('getStats()', () => {
    it('should return correct queue sizes', () => {
      submissionQueue.submit(makeSubmission('UserTurn'));
      submissionQueue.submit(makeSubmission('Compact'));
      eventQueue.emit(makeEvent('TaskStarted'));

      const stats = processor.getStats();

      expect(stats.submissionQueueSize).toBe(2);
      expect(stats.eventQueueSize).toBe(1);
      expect(stats.isProcessing).toBe(false);
    });

    it('should reflect processing state', () => {
      submissionQueue.setProcessing(true);

      const stats = processor.getStats();
      expect(stats.isProcessing).toBe(true);
    });

    it('should return zeros for empty queues', () => {
      const stats = processor.getStats();

      expect(stats.submissionQueueSize).toBe(0);
      expect(stats.eventQueueSize).toBe(0);
      expect(stats.isProcessing).toBe(false);
    });

    it('should update after processing', () => {
      submissionQueue.submit(makeSubmission('UserTurn'));

      expect(processor.getStats().submissionQueueSize).toBe(1);

      processor.start(10);
      vi.advanceTimersByTime(10);

      expect(processor.getStats().submissionQueueSize).toBe(0);
    });
  });
});
