import { describe, expect, it, vi } from 'vitest';
import { AppLocalStore, createInstalledRecord } from '../AppLocalStore';
import { makeManifest, MemoryConfigStorage } from './testUtils';

describe('AppLocalStore', () => {
  it('creates and preserves a stable device id', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const first = await store.getDeviceId();
    const second = await store.getDeviceId();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('stores installed apps with manifest and metadata for search indexing', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const manifest = makeManifest();
    const install = createInstalledRecord(manifest);

    await store.upsertInstalledApp(install);
    await store.saveManifest(manifest.appId, manifest);
    await store.saveMetadataMarkdown(manifest.appId, '# Linear\n\nSearch issues and projects.');

    expect(await store.getInstalledApp(manifest.appId)).toMatchObject({
      appId: manifest.appId,
      connectionStatus: 'needs_auth',
    });
    expect(await store.getManifest(manifest.appId)).toMatchObject({ appId: manifest.appId });
    expect(await store.getMetadataMarkdown(manifest.appId)).toContain('Search issues');
    expect(await store.listMetadataEntries()).toHaveLength(1);
  });

  it('tracks sync queue failures with exponential retry metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T12:00:00Z'));
    try {
      const store = new AppLocalStore(new MemoryConfigStorage());
      await store.enqueueSync({ op: 'uninstall', appId: 'com.example.linear' });
      const [queued] = await store.listSyncQueue();

      await store.recordSyncQueueFailure(queued.id, 'network down');
      const [failed] = await store.listSyncQueue();

      expect(failed.attempts).toBe(1);
      expect(failed.lastError).toBe('network down');
      expect(failed.lastAttemptAt).toBe(Date.now());
      expect(failed.nextAttemptAt).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});
