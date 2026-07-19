import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDBRolloutStorageProvider } from '../IndexedDBRolloutStorageProvider';
import type { RolloutMetadataRecord } from '../../types';

function metadata(id: string): RolloutMetadataRecord {
  return {
    id,
    created: 1,
    updated: 1,
    sessionMeta: {
      id,
      timestamp: new Date(0).toISOString(),
      originator: 'test',
      cliVersion: 'test',
    },
    itemCount: 0,
    status: 'active',
  };
}

describe('IndexedDBRolloutStorageProvider.createRollout', () => {
  let provider: IndexedDBRolloutStorageProvider;
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    provider = new IndexedDBRolloutStorageProvider();
    await provider.initialize();
  });
  afterEach(async () => provider.close());

  it('atomically creates metadata and an initial prefix exactly once', async () => {
    const items = [
      { timestamp: new Date(0).toISOString(), sequence: 0, type: 'response_item', payload: { text: 'first' } },
      { timestamp: new Date(1).toISOString(), sequence: 1, type: 'response_item', payload: { text: 'second' } },
    ];
    await expect(provider.createRollout(metadata('fork'), items)).resolves.toBe(true);
    await expect(provider.createRollout(metadata('fork'), [{
      timestamp: new Date(2).toISOString(), sequence: 2, type: 'response_item', payload: { text: 'duplicate' },
    }])).resolves.toBe(false);
    expect((await provider.getMetadata('fork'))?.itemCount).toBe(2);
    expect((await provider.getItemsByRolloutId('fork')).map((item) => item.payload))
      .toEqual([{ text: 'first' }, { text: 'second' }]);
  });
});
