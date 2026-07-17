import { describe, expect, it } from 'vitest';
import {
  createThreadIndexEntry,
  normalizeSearchTitle,
  ThreadIndexError,
  ThreadIndexStore,
} from '../ThreadIndexStore';
import { MemoryStorageAdapter } from './MemoryStorageAdapter';

describe('ThreadIndexStore', () => {
  it('normalizes titles, preserves manual title precedence, and serializes mutations', async () => {
    let now = 100;
    const store = new ThreadIndexStore(new MemoryStorageAdapter(), () => ++now);
    await store.createIfMissing(createThreadIndexEntry({ sessionId: 'one', title: '  HéLLo  ', now: 1 }));
    expect((await store.require('one')).searchTitle).toBe(normalizeSearchTitle('HéLLo'));

    const [renamed, generated] = await Promise.all([
      store.rename('one', 'Manual title'),
      store.commitGeneratedTitle('one', 'Generated title'),
    ]);
    expect(renamed.titleSource).toBe('user');
    expect(generated).toBe(false);
    expect(await store.require('one')).toMatchObject({ title: 'Manual title', titleSource: 'user' });
    expect(await store.commitGeneratedTitle('one', 'Late generated title')).toBe(false);
  });

  it('provides stable pinned-first pagination with request-bound cursors', async () => {
    const store = new ThreadIndexStore(new MemoryStorageAdapter());
    for (let index = 0; index < 225; index += 1) {
      await store.upsert({
        ...createThreadIndexEntry({ sessionId: `s-${String(index).padStart(3, '0')}`, title: `Project ${index}`, now: index }),
        lastActiveAt: index,
        pinned: index === 12 || index === 24,
      });
    }
    const visited: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ query: 'project', limit: 37, cursor });
      visited.push(...page.entries.map((entry) => entry.sessionId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(visited).toHaveLength(225);
    expect(new Set(visited).size).toBe(225);
    expect(visited.slice(0, 2)).toEqual(['s-024', 's-012']);

    const first = await store.list({ limit: 1 });
    await expect(store.list({ limit: 1, query: 'different', cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(store.list({ limit: 101 })).rejects.toBeInstanceOf(ThreadIndexError);
  });

  it('pages a 10,000-row fixture deterministically with no duplicates and bounded pages', async () => {
    const store = new ThreadIndexStore(new MemoryStorageAdapter());
    await Promise.all(Array.from({ length: 10_000 }, (_, index) => store.upsert({
      ...createThreadIndexEntry({
        sessionId: `thread-${index.toString().padStart(5, '0')}`,
        title: index % 3 === 0 ? `Searchable ${index}` : `Conversation ${index}`,
        now: index,
      }),
      pinned: index % 997 === 0,
    })));

    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await store.list({ limit: 100, cursor });
      expect(page.entries.length).toBeLessThanOrEqual(100);
      for (const entry of page.entries) {
        expect(seen.has(entry.sessionId)).toBe(false);
        seen.add(entry.sessionId);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBe(10_000);

    const search = await store.list({ query: 'SEARCHABLE', limit: 100 });
    expect(search.entries).toHaveLength(100);
    expect(search.entries.every((entry) => entry.searchTitle.includes('searchable'))).toBe(true);
  }, 15_000);

  it('makes Undo and purge claim mutually exclusive', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new ThreadIndexStore(adapter, () => 1_000);
    await store.createIfMissing(createThreadIndexEntry({ sessionId: 'undo' }));
    const tombstone = await store.softDelete('undo', 500);
    expect(tombstone).toMatchObject({ deletedAt: 1_000, purgeAfter: 1_500 });
    expect((await store.undelete('undo'))?.deletedAt).toBeNull();

    await store.softDelete('undo', 500);
    expect((await store.beginPurge('undo'))?.purgeState).toBe('pending');
    expect(await store.undelete('undo')).toBeNull();
  });

  it('backfills rollout and legacy metadata repeatedly with deterministic merge rules', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new ThreadIndexStore(adapter, () => 999);
    await store.backfill({
      rollouts: [{ id: 'merged', created: 20, updated: 80, sessionMeta: { title: 'Imported' } }],
      persistedSessions: [
        { sessionId: 'merged', createdAt: 10, lastActivityAt: 90 },
        { sessionId: 'legacy-only', createdAt: 30, lastActivityAt: 40 },
      ],
      defaultMode: 'code',
    });
    expect(await store.require('merged')).toMatchObject({
      title: 'Imported',
      titleSource: 'user',
      createdAt: 10,
      lastActiveAt: 90,
      agentMode: 'code',
    });
    await store.backfill({ rollouts: [{ id: 'should-not-appear' }] });
    expect(await store.get('should-not-appear')).toMatchObject({
      sessionId: 'should-not-appear',
      title: '',
    });
  });
});
