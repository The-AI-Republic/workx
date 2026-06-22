import { describe, it, expect, vi } from 'vitest';
import { TabLeaseStore, LeaseLifecycleQueue, TabLeasedError, type LeaseStorage } from '../TabLeaseStore';

/** In-memory LeaseStorage. */
function memStorage(): LeaseStorage & { dump(): any } {
  const data: Record<string, unknown> = {};
  return {
    async get(key: string) {
      return key in data ? { [key]: data[key] } : undefined;
    },
    async set(key: string, value: unknown) {
      data[key] = value;
    },
    dump: () => data,
  };
}

describe('TabLeaseStore', () => {
  it('claims a tab and reports the owner', async () => {
    const store = new TabLeaseStore(memStorage(), async () => true);
    await store.claim({ tabId: 1, sessionId: 'S1', origin: 'agent' });
    expect(await store.getOwner(1)).toBe('S1');
  });

  it('rejects a claim on a tab leased to another live session', async () => {
    const store = new TabLeaseStore(memStorage(), async () => true);
    await store.claim({ tabId: 1, sessionId: 'S1', origin: 'user' });
    await expect(store.claim({ tabId: 1, sessionId: 'S2', origin: 'user' })).rejects.toBeInstanceOf(
      TabLeasedError
    );
  });

  it('allows the same session to re-claim (e.g. new turn)', async () => {
    const store = new TabLeaseStore(memStorage(), async () => true, () => 123);
    await store.claim({ tabId: 1, sessionId: 'S1', origin: 'user', turnId: 't1' });
    await store.claim({ tabId: 1, sessionId: 'S1', origin: 'user', turnId: 't2' });
    expect(await store.getLease(1)).toMatchObject({ sessionId: 'S1', turnId: 't2', claimedAt: 123 });
  });

  it('takes over a lease whose tab no longer exists', async () => {
    // Owner's tab is reported gone when the new session tries to claim.
    const store = new TabLeaseStore(memStorage(), async () => false);
    await store.claim({ tabId: 1, sessionId: 'S1', origin: 'agent' });
    await store.claim({ tabId: 1, sessionId: 'S2', origin: 'user' }); // stale → takeover
    expect(await store.getOwner(1)).toBe('S2');
  });

  it('releases only the holder’s lease', async () => {
    const store = new TabLeaseStore(memStorage(), async () => true);
    await store.claim({ tabId: 1, sessionId: 'S1', origin: 'agent' });
    await store.release('S2', 1); // not the holder → no-op
    expect(await store.getOwner(1)).toBe('S1');
    await store.release('S1', 1);
    expect(await store.getOwner(1)).toBeNull();
  });

  it('releaseAll drops every lease for a session', async () => {
    const store = new TabLeaseStore(memStorage(), async () => true);
    await store.claim({ tabId: 1, sessionId: 'S1', origin: 'agent' });
    await store.claim({ tabId: 2, sessionId: 'S1', origin: 'user' });
    await store.claim({ tabId: 3, sessionId: 'S2', origin: 'user' });
    await store.releaseAll('S1');
    expect(await store.getOwner(1)).toBeNull();
    expect(await store.getOwner(2)).toBeNull();
    expect(await store.getOwner(3)).toBe('S2');
  });

  it('gcStale drops leases whose tab is gone', async () => {
    const alive = new Set([2]);
    const store = new TabLeaseStore(memStorage(), async (t) => alive.has(t));
    await store.claim({ tabId: 1, sessionId: 'S1', origin: 'agent' });
    await store.claim({ tabId: 2, sessionId: 'S1', origin: 'user' });
    const dropped = await store.gcStale();
    expect(dropped).toBe(1);
    expect(await store.getOwner(1)).toBeNull();
    expect(await store.getOwner(2)).toBe('S1');
  });
});

describe('LeaseLifecycleQueue', () => {
  it('serializes operations per session', async () => {
    const queue = new LeaseLifecycleQueue();
    const order: string[] = [];
    const mk = (label: string, delay: number) => () =>
      new Promise<void>((resolve) => setTimeout(() => { order.push(label); resolve(); }, delay));

    await Promise.all([
      queue.run('S1', mk('a', 30)),
      queue.run('S1', mk('b', 5)),
      queue.run('S1', mk('c', 1)),
    ]);

    expect(order).toEqual(['a', 'b', 'c']); // strict FIFO despite differing delays
  });

  it('a rejected op does not poison the chain', async () => {
    const queue = new LeaseLifecycleQueue();
    await expect(queue.run('S1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(queue.run('S1', async () => 'ok')).resolves.toBe('ok');
  });
});
