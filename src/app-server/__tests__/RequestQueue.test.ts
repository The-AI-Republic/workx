import { describe, it, expect } from 'vitest';
import { RequestQueue } from '../queue/RequestQueue';
import { ConnectionRpcGate } from '../connection/ConnectionRpcGate';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('RequestQueue', () => {
  it('returns OVERLOADED when the queue is at capacity', async () => {
    const queue = new RequestQueue({ capacity: 1 });
    const block = deferred();

    const first = queue.enqueue({
      connectionId: 'c1',
      requestId: 'r1',
      serialKey: 'none',
      mode: 'read',
      run: () => block.promise,
    });
    expect(first.accepted).toBe(true);

    const second = queue.enqueue({
      connectionId: 'c1',
      requestId: 'r2',
      serialKey: 'none',
      mode: 'read',
      run: async () => {},
    });
    expect(second.accepted).toBe(false);
    expect(second.error?.code).toBe('OVERLOADED');
    expect(second.error?.retryable).toBe(true);

    block.resolve();
    await first.done;
  });

  it('frees capacity after a request completes', async () => {
    const queue = new RequestQueue({ capacity: 1 });
    const r1 = queue.enqueue({ connectionId: 'c', requestId: '1', serialKey: 'none', mode: 'read', run: async () => {} });
    await r1.done;
    const r2 = queue.enqueue({ connectionId: 'c', requestId: '2', serialKey: 'none', mode: 'read', run: async () => {} });
    expect(r2.accepted).toBe(true);
    await r2.done;
  });

  it('serializes writes on the same key in order', async () => {
    const queue = new RequestQueue({ capacity: 10 });
    const order: string[] = [];
    const mk = (id: string) =>
      queue.enqueue({
        connectionId: 'c',
        requestId: id,
        serialKey: 'session:s1',
        mode: 'write',
        run: async () => {
          order.push(`start:${id}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end:${id}`);
        },
      });
    const a = mk('a');
    const b = mk('b');
    await Promise.all([a.done, b.done]);
    // b cannot start until a finished.
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('never overlaps same-key writes, even when later writes arrive mid-flight', async () => {
    // Regression: the per-key lock entry must not be dropped while a same-key
    // request is still queued, or a replacement lock would let a later write
    // run concurrently. Stagger arrivals so some land while earlier writes are
    // in flight and others land just as the queue drains.
    const queue = new RequestQueue({ capacity: 50 });
    let active = 0;
    let maxActive = 0;
    let ran = 0;
    const mk = (id: string) =>
      queue.enqueue({
        connectionId: 'c',
        requestId: id,
        serialKey: 'session:s1',
        mode: 'write',
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 1));
          ran += 1;
          active -= 1;
        },
      });

    const pending: Array<Promise<void> | undefined> = [];
    for (let i = 0; i < 8; i++) {
      pending.push(mk(`w${i}`).done);
      // Yield between some enqueues so arrivals interleave with completions.
      if (i % 2 === 0) await Promise.resolve();
    }
    await Promise.all(pending);

    expect(maxActive).toBe(1); // strict mutual exclusion held throughout
    expect(ran).toBe(8);
  });

  it('runs reads on the same key concurrently', async () => {
    const queue = new RequestQueue({ capacity: 10 });
    let active = 0;
    let maxActive = 0;
    const mk = (id: string) =>
      queue.enqueue({
        connectionId: 'c',
        requestId: id,
        serialKey: 'session:s1',
        mode: 'read',
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        },
      });
    await Promise.all([mk('a').done, mk('b').done]);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('does not run work whose connection gate is closed', async () => {
    const queue = new RequestQueue({ capacity: 10 });
    const gate = new ConnectionRpcGate();
    gate.close();
    let ran = false;
    const res = queue.enqueue({
      connectionId: 'c',
      requestId: '1',
      serialKey: 'session:s1',
      mode: 'write',
      gate,
      run: async () => {
        ran = true;
      },
    });
    await res.done;
    expect(ran).toBe(false);
  });
});
