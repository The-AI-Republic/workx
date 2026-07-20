import { describe, expect, it, vi } from 'vitest';
import { SessionDeletionCoordinator } from '../SessionDeletionCoordinator';
import { createThreadIndexEntry, ThreadIndexStore } from '../ThreadIndexStore';
import { MemoryStorageAdapter } from './MemoryStorageAdapter';

describe('SessionDeletionCoordinator', () => {
  it('dedupes concurrent purges, deletes the index row last, and invokes every resource cleanup', async () => {
    const index = new ThreadIndexStore(new MemoryStorageAdapter(), () => 100);
    await index.createIfMissing(createThreadIndexEntry({ sessionId: 'delete-me' }));
    await index.softDelete('delete-me', 0);
    const order: string[] = [];
    const coordinator = new SessionDeletionCoordinator({
      index,
      ensureNotLive: async () => { order.push('not-live'); },
      deleteRollout: async () => { order.push('rollout'); },
      clearSessionCache: async () => { order.push('cache'); },
      deleteLegacySession: async () => { order.push('legacy'); },
      deleteTokenUsage: async () => { order.push('tokens'); },
      deleteTaskOutput: async () => { order.push('tasks'); },
      deleteToolResults: async () => { order.push('tools'); },
      onPurged: async () => { order.push(`purged:${await index.get('delete-me', true) === null}`); },
    });
    const first = coordinator.purge('delete-me');
    const second = coordinator.purge('delete-me');
    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(order).toEqual([
      'not-live', 'rollout', 'cache', 'legacy', 'tokens', 'tasks', 'tools', 'purged:true',
    ]);
  });

  it('retains a failed tombstone and retries successfully without allowing Undo', async () => {
    const index = new ThreadIndexStore(new MemoryStorageAdapter(), () => 100);
    await index.createIfMissing(createThreadIndexEntry({ sessionId: 'retry' }));
    await index.softDelete('retry', 0);
    const remove = vi.fn()
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValue(undefined);
    const coordinator = new SessionDeletionCoordinator({
      index,
      ensureNotLive: async () => undefined,
      deleteRollout: remove,
    });
    await expect(coordinator.purge('retry')).rejects.toThrow('disk busy');
    expect(await index.require('retry', true)).toMatchObject({ purgeState: 'failed' });
    expect(await index.undelete('retry')).toBeNull();
    await expect(coordinator.purge('retry')).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
