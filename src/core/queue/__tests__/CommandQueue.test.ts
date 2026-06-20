// File: src/core/queue/__tests__/CommandQueue.test.ts
//
// Track 08 — CommandQueue unit tests

import { describe, expect, it, vi } from 'vitest';
import { CommandQueue } from '../CommandQueue';

describe('CommandQueue', () => {
  describe('enqueue + dequeue', () => {
    it('returns the same payload', () => {
      const q = new CommandQueue<string>();
      q.enqueue('hello');
      const cmd = q.dequeue();
      expect(cmd?.payload).toBe('hello');
    });

    it('returns the uuid from enqueue and matches the dequeued command', () => {
      const q = new CommandQueue<string>();
      const uuid = q.enqueue('hello');
      const cmd = q.dequeue();
      expect(cmd?.uuid).toBe(uuid);
    });

    it('returns undefined from dequeue when empty', () => {
      const q = new CommandQueue<string>();
      expect(q.dequeue()).toBeUndefined();
    });

    it('stamps enqueuedAt on each command', () => {
      const q = new CommandQueue<string>();
      const before = Date.now();
      q.enqueue('hello');
      const cmd = q.dequeue();
      expect(cmd?.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(cmd?.enqueuedAt).toBeLessThanOrEqual(Date.now());
    });

    it('produces unique uuids across multiple enqueues', () => {
      const q = new CommandQueue<string>();
      const uuids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        uuids.add(q.enqueue(`item-${i}`));
      }
      expect(uuids.size).toBe(50);
    });
  });

  describe('priority ordering', () => {
    it("'now' dequeues before 'next'", () => {
      const q = new CommandQueue<string>();
      q.enqueue('a', { priority: 'next' });
      q.enqueue('b', { priority: 'now' });
      expect(q.dequeue()?.payload).toBe('b');
      expect(q.dequeue()?.payload).toBe('a');
    });

    it("'next' dequeues before 'later'", () => {
      const q = new CommandQueue<string>();
      q.enqueue('a', { priority: 'later' });
      q.enqueue('b', { priority: 'next' });
      expect(q.dequeue()?.payload).toBe('b');
      expect(q.dequeue()?.payload).toBe('a');
    });

    it("'now' dequeues before 'later'", () => {
      const q = new CommandQueue<string>();
      q.enqueue('a', { priority: 'later' });
      q.enqueue('b', { priority: 'now' });
      expect(q.dequeue()?.payload).toBe('b');
      expect(q.dequeue()?.payload).toBe('a');
    });

    it('preserves FIFO within the same priority tier', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a', { priority: 'next' });
      q.enqueue('b', { priority: 'next' });
      q.enqueue('c', { priority: 'next' });
      expect(q.dequeue()?.payload).toBe('a');
      expect(q.dequeue()?.payload).toBe('b');
      expect(q.dequeue()?.payload).toBe('c');
    });

    it('handles interleaved priorities correctly', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a-next-1', { priority: 'next' });
      q.enqueue('b-later-1', { priority: 'later' });
      q.enqueue('c-next-2', { priority: 'next' });
      q.enqueue('d-now-1', { priority: 'now' });
      q.enqueue('e-later-2', { priority: 'later' });
      q.enqueue('f-now-2', { priority: 'now' });

      // Expected order: now-1, now-2, next-1, next-2, later-1, later-2
      expect(q.dequeue()?.payload).toBe('d-now-1');
      expect(q.dequeue()?.payload).toBe('f-now-2');
      expect(q.dequeue()?.payload).toBe('a-next-1');
      expect(q.dequeue()?.payload).toBe('c-next-2');
      expect(q.dequeue()?.payload).toBe('b-later-1');
      expect(q.dequeue()?.payload).toBe('e-later-2');
    });

    it("defaults to 'next' when priority is omitted", () => {
      const q = new CommandQueue<string>();
      q.enqueue('a');
      const cmd = q.dequeue();
      expect(cmd?.priority).toBe('next');
    });
  });

  describe('peek', () => {
    it('returns undefined when empty', () => {
      const q = new CommandQueue<string>();
      expect(q.peek()).toBeUndefined();
    });

    it('does not mutate the queue', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a');
      q.enqueue('b');
      const len = q.length;
      q.peek();
      q.peek();
      expect(q.length).toBe(len);
    });

    it('returns the highest-priority command', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a', { priority: 'later' });
      q.enqueue('b', { priority: 'now' });
      q.enqueue('c', { priority: 'next' });
      expect(q.peek()?.payload).toBe('b');
    });

    it('returns the same item the next dequeue will return', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a', { priority: 'next' });
      q.enqueue('b', { priority: 'now' });
      const peeked = q.peek();
      const dequeued = q.dequeue();
      expect(peeked?.uuid).toBe(dequeued?.uuid);
    });
  });

  describe('clear', () => {
    it('empties the queue', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a');
      q.enqueue('b');
      q.clear();
      expect(q.length).toBe(0);
      expect(q.dequeue()).toBeUndefined();
    });

    it('is a no-op when already empty', () => {
      const q = new CommandQueue<string>();
      expect(() => q.clear()).not.toThrow();
      expect(q.length).toBe(0);
    });
  });

  describe('length', () => {
    it('tracks mutations', () => {
      const q = new CommandQueue<string>();
      expect(q.length).toBe(0);
      q.enqueue('a');
      expect(q.length).toBe(1);
      q.enqueue('b');
      expect(q.length).toBe(2);
      q.dequeue();
      expect(q.length).toBe(1);
      q.clear();
      expect(q.length).toBe(0);
    });
  });

  describe('subscribe', () => {
    it('fires on enqueue with a snapshot containing the new item', () => {
      const q = new CommandQueue<string>();
      const listener = vi.fn();
      q.subscribe(listener);
      q.enqueue('a');
      expect(listener).toHaveBeenCalledTimes(1);
      const snapshot = listener.mock.calls[0]![0] as ReadonlyArray<{ payload: string }>;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]!.payload).toBe('a');
    });

    it('fires on dequeue with a snapshot lacking the removed item', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a');
      const listener = vi.fn();
      q.subscribe(listener);
      q.dequeue();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]![0]).toHaveLength(0);
    });

    it('fires on clear with an empty snapshot', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a');
      q.enqueue('b');
      const listener = vi.fn();
      q.subscribe(listener);
      q.clear();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]![0]).toHaveLength(0);
    });

    it('does not fire on clear when already empty', () => {
      const q = new CommandQueue<string>();
      const listener = vi.fn();
      q.subscribe(listener);
      q.clear();
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not fire on peek', () => {
      const q = new CommandQueue<string>();
      q.enqueue('a');
      const listener = vi.fn();
      q.subscribe(listener);
      q.peek();
      expect(listener).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function that stops notifications', () => {
      const q = new CommandQueue<string>();
      const listener = vi.fn();
      const unsub = q.subscribe(listener);
      q.enqueue('a');
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
      q.enqueue('b');
      expect(listener).toHaveBeenCalledTimes(1); // not called again after unsubscribe
    });

    it('supports multiple subscribers', () => {
      const q = new CommandQueue<string>();
      const l1 = vi.fn();
      const l2 = vi.fn();
      q.subscribe(l1);
      q.subscribe(l2);
      q.enqueue('a');
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    });
  });

  describe('snapshot', () => {
    it('is frozen', () => {
      const q = new CommandQueue<string>();
      let snapshot: ReadonlyArray<unknown> | undefined;
      q.subscribe((s) => {
        snapshot = s;
      });
      q.enqueue('a');
      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('cannot be mutated through the snapshot reference', () => {
      const q = new CommandQueue<string>();
      let snapshot: ReadonlyArray<unknown> | undefined;
      q.subscribe((s) => {
        snapshot = s;
      });
      q.enqueue('a');
      // In strict mode this throws; in non-strict it silently no-ops. Either is fine:
      // the snapshot remains length 1.
      try {
        (snapshot as unknown[]).push('rogue');
      } catch {
        // ignore — strict mode TypeError is expected
      }
      expect(snapshot).toHaveLength(1);
    });
  });
});
