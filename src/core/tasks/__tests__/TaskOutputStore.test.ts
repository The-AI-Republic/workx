import { describe, it, expect, beforeEach } from 'vitest';
import type { StorageAdapter } from '@/storage/StorageAdapter';
import { TaskOutputStore, type TaskOutputChunk } from '../TaskOutputStore';
import { TASK_OUTPUT_CHUNK_MAX_BYTES } from '../timing';

/**
 * In-memory StorageAdapter stub good enough to test TaskOutputStore.
 * Implements get/put/getAll/queryByIndex/batchDelete/clear.
 */
function makeAdapter(): StorageAdapter {
  const rows = new Map<string, TaskOutputChunk>();
  return {
    async initialize() {},
    async get<T>(_store: string, key: string): Promise<T | null> {
      return (rows.get(key) as unknown as T) ?? null;
    },
    async put<T>(_store: string, value: T): Promise<void> {
      const v = value as unknown as TaskOutputChunk;
      rows.set(v.chunkId, v);
    },
    async delete(_store: string, key: string): Promise<boolean> {
      return rows.delete(key);
    },
    async getAll<T>(_store: string): Promise<T[]> {
      return [...rows.values()] as unknown as T[];
    },
    async queryByIndex<T>(
      _store: string,
      indexName: string,
      query: IDBValidKey | IDBKeyRange,
    ): Promise<T[]> {
      const all = [...rows.values()];
      if (indexName === 'by_task_id') {
        return all.filter(r => r.taskId === query) as unknown as T[];
      }
      if (indexName === 'by_task_seq') {
        // query expected to be IDBKeyRange.bound([taskId, fromSeq], [taskId, +inf], true, false)
        // Our stub is loose — we accept any range-like and rely on caller
        // having set lower/upper bounds correctly.
        // Without browser IDB we cannot easily inspect IDBKeyRange; assume
        // tests pass a range object with `lower` and `upper` arrays of
        // [taskId, seq]. Fall back to comparing as a tuple.
        const range = query as unknown as {
          lower?: [string, number];
          upper?: [string, number];
          lowerOpen?: boolean;
        };
        const taskId = range.lower?.[0];
        const fromSeq = range.lower?.[1] ?? 0;
        return all
          .filter(r => r.taskId === taskId && (range.lowerOpen ? r.seq > fromSeq : r.seq >= fromSeq))
          .sort((a, b) => a.seq - b.seq) as unknown as T[];
      }
      return [];
    },
    async batchDelete(_store: string, keys: string[]): Promise<number> {
      let n = 0;
      for (const k of keys) {
        if (rows.delete(k)) n += 1;
      }
      return n;
    },
    async clear() {
      rows.clear();
    },
    async close() {},
  };
}

// Mock IDBKeyRange.bound for the Node test env.
beforeEach(() => {
  (globalThis as unknown as { IDBKeyRange?: unknown }).IDBKeyRange = {
    bound: (lower: unknown, upper: unknown, lowerOpen?: boolean, _upperOpen?: boolean) => ({
      lower,
      upper,
      lowerOpen: !!lowerOpen,
    }),
  };
});

describe('TaskOutputStore', () => {
  it('appends a single small chunk and reads it back via getDelta', async () => {
    const store = new TaskOutputStore(makeAdapter());
    const written = await store.appendChunk('a1', 'message', 'hello');
    expect(written.seq).toBe(1);
    expect(written.taskId).toBe('a1');
    expect(written.kind).toBe('message');
    const delta = await store.getDelta('a1');
    expect(delta).toHaveLength(1);
    expect(delta[0]!.data).toBe('hello');
  });

  it('assigns monotonically increasing seq per task', async () => {
    const store = new TaskOutputStore(makeAdapter());
    const a = await store.appendChunk('a1', 'event', '{}');
    const b = await store.appendChunk('a1', 'event', '{}');
    const c = await store.appendChunk('a1', 'event', '{}');
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });

  it('isolates seq per task', async () => {
    const store = new TaskOutputStore(makeAdapter());
    const a = await store.appendChunk('aA', 'event', '{}');
    const b = await store.appendChunk('aB', 'event', '{}');
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });

  it('splits payloads larger than TASK_OUTPUT_CHUNK_MAX_BYTES', async () => {
    const store = new TaskOutputStore(makeAdapter());
    const big = 'x'.repeat(TASK_OUTPUT_CHUNK_MAX_BYTES + 100);
    await store.appendChunk('a1', 'message', big);
    const delta = await store.getDelta('a1');
    expect(delta.length).toBeGreaterThanOrEqual(2);
    const total = delta.reduce((acc, c) => acc + c.data.length, 0);
    expect(total).toBe(big.length);
  });

  it('getDelta(fromSeq) returns only newer chunks', async () => {
    const store = new TaskOutputStore(makeAdapter());
    for (let i = 0; i < 5; i++) {
      await store.appendChunk('a1', 'event', `e${i}`);
    }
    const after2 = await store.getDelta('a1', 2);
    expect(after2.map(c => c.seq)).toEqual([3, 4, 5]);
  });

  it('cleanupTask removes all rows for a task', async () => {
    const store = new TaskOutputStore(makeAdapter());
    await store.appendChunk('a1', 'event', 'x');
    await store.appendChunk('a1', 'event', 'y');
    await store.appendChunk('a2', 'event', 'z');
    await store.cleanupTask('a1');
    expect(await store.getDelta('a1')).toHaveLength(0);
    expect(await store.getDelta('a2')).toHaveLength(1);
  });

  it('flush is a no-op when queue is empty', async () => {
    const store = new TaskOutputStore(makeAdapter());
    await expect(store.flush('a1')).resolves.toBeUndefined();
  });

  it('records lastReadAt on getDelta calls', async () => {
    const store = new TaskOutputStore(makeAdapter());
    await store.appendChunk('a1', 'event', '{}');
    const before = Date.now();
    await store.getDelta('a1');
    const seen = store.getLastReadAt('a1');
    expect(seen).toBeDefined();
    expect(seen!).toBeGreaterThanOrEqual(before);
  });

  it('reports the latest written seq for notification offsets', async () => {
    const store = new TaskOutputStore(makeAdapter());
    expect(await store.getLastSeq('a1')).toBe(0);
    await store.appendChunk('a1', 'event', '{}');
    await store.appendChunk('a1', 'message', 'done');
    expect(await store.getLastSeq('a1')).toBe(2);
  });

  // ─── B1 fix: cleanupTask drains pending writes ──────────────────────

  it('cleanupTask rejects pending in-memory writes and blocks future appends', async () => {
    const store = new TaskOutputStore(makeAdapter());
    // Kick off cleanupTask immediately after appending so the append's
    // drain races with cleanup.
    const appendP = store.appendChunk('a1', 'event', 'x');
    const cleanupP = store.cleanupTask('a1');
    // Either the append wins the race (succeeds, then cleanup deletes) or
    // cleanup wins (append rejects with eviction). Both are correct.
    let appendResolved = false;
    try {
      await appendP;
      appendResolved = true;
    } catch (err) {
      expect((err as Error).message).toMatch(/evicted/);
    }
    await cleanupP;
    // After cleanup, storage MUST be empty regardless of who won the race.
    const remaining = await store.getDelta('a1');
    expect(remaining).toHaveLength(0);
    // Subsequent appends must be rejected — the task id is evicted.
    await expect(store.appendChunk('a1', 'event', 'y')).rejects.toThrow(/evicted/);
    expect(typeof appendResolved).toBe('boolean'); // keep var used
  });

  it('flush waits for in-flight drain via promise (no busy-wait)', async () => {
    const store = new TaskOutputStore(makeAdapter());
    // Start several appends without awaiting.
    const writes = [
      store.appendChunk('a1', 'event', 'one'),
      store.appendChunk('a1', 'event', 'two'),
      store.appendChunk('a1', 'event', 'three'),
    ];
    await store.flush('a1');
    // After flush, all writes must have settled.
    const settled = await Promise.allSettled(writes);
    for (const r of settled) expect(r.status).toBe('fulfilled');
    expect(await store.getDelta('a1')).toHaveLength(3);
  });

  it('resetEvictedFlag re-enables appends after a cleanup', async () => {
    const store = new TaskOutputStore(makeAdapter());
    await store.appendChunk('a1', 'event', 'x');
    await store.cleanupTask('a1');
    await expect(store.appendChunk('a1', 'event', 'y')).rejects.toThrow(/evicted/);
    store.resetEvictedFlag('a1');
    const after = await store.appendChunk('a1', 'event', 'z');
    expect(after.seq).toBe(1); // lastSeq was cleaned up
  });
});
