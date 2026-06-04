import { describe, expect, it, vi } from 'vitest';
import { AppInstallService, MAX_PINNED_APPS } from '../AppInstallService';
import { AppLocalStore, createInstalledRecord } from '../AppLocalStore';
import { makeManifest, MemoryConfigStorage } from './testUtils';

function makeMarketplace() {
  return {
    setPriority: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AppInstallService', () => {
  it('pins an installed app when fewer than ten apps are pinned', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const manifest = makeManifest({ appId: 'com.example.linear', slug: 'linear' });
    await store.upsertInstalledApp(createInstalledRecord(manifest));

    const marketplace = makeMarketplace();
    const service = new AppInstallService(marketplace as any, store, { deleteAppSecrets: vi.fn() } as any);

    const updated = await service.setPriority(manifest.appId, 1);

    expect(updated.priority).toBe(1);
    expect(marketplace.setPriority).toHaveBeenCalledWith(manifest.appId, 1);
    await expect(store.getInstalledApp(manifest.appId)).resolves.toMatchObject({ priority: 1 });
  });

  it('blocks pinning the eleventh app', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    for (let index = 0; index < MAX_PINNED_APPS; index++) {
      const manifest = makeManifest({
        appId: `com.example.pinned${index}`,
        slug: `pinned${index}`,
      });
      await store.upsertInstalledApp(createInstalledRecord(manifest, { priority: 1 }));
    }
    const targetManifest = makeManifest({ appId: 'com.example.target', slug: 'target' });
    await store.upsertInstalledApp(createInstalledRecord(targetManifest, { priority: 2 }));

    const marketplace = makeMarketplace();
    const service = new AppInstallService(marketplace as any, store, { deleteAppSecrets: vi.fn() } as any);

    await expect(service.setPriority(targetManifest.appId, 1)).rejects.toThrow('You can pin up to 10 apps.');
    expect(marketplace.setPriority).not.toHaveBeenCalled();
  });
});
