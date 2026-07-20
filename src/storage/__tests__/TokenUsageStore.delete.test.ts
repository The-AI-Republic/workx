import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../StorageAdapter';
import { TokenUsageStore } from '../TokenUsageStore';
import type { TokenUsageRecord } from '../types';

function record(id: string, sessionId: string): TokenUsageRecord {
  return {
    id,
    sessionId,
    taskId: `task-${id}`,
    model: 'test-model',
    timestamp: '2026-07-17T00:00:00.000Z',
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
    total_tokens: 2,
    turn_count: 1,
  };
}

function adapter(): StorageAdapter {
  const rows = new Map<string, TokenUsageRecord>();
  return {
    async initialize() {},
    async get<T>(_store: string, key: string): Promise<T | null> {
      return (rows.get(key) as T | undefined) ?? null;
    },
    async put<T>(_store: string, value: T): Promise<void> {
      const row = value as TokenUsageRecord;
      rows.set(row.id, row);
    },
    async delete(_store: string, key: string): Promise<boolean> { return rows.delete(key); },
    async getAll<T>(): Promise<T[]> { return [...rows.values()] as T[]; },
    async queryByIndex<T>(
      _store: string,
      indexName: string,
      query: IDBValidKey | IDBKeyRange,
    ): Promise<T[]> {
      if (indexName !== 'by_session') return [];
      return [...rows.values()].filter((row) => row.sessionId === query) as T[];
    },
    async batchDelete(_store: string, keys: string[]): Promise<number> {
      let deleted = 0;
      for (const key of keys) deleted += Number(rows.delete(String(key)));
      return deleted;
    },
    async clear(): Promise<void> { rows.clear(); },
    async close(): Promise<void> {},
  };
}

describe('TokenUsageStore.deleteSession', () => {
  it('hard-purges the target session while retaining unrelated usage', async () => {
    const store = new TokenUsageStore(adapter());
    await store.save(record('a-1', 'session-a'));
    await store.save(record('a-2', 'session-a'));
    await store.save(record('b-1', 'session-b'));
    await store.deleteSession('session-a');
    expect(await store.getBySession('session-a')).toEqual([]);
    expect((await store.getBySession('session-b')).map((row) => row.id)).toEqual(['b-1']);
  });
});
