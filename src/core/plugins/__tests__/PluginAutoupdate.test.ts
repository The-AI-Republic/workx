/**
 * Track 10c: PluginAutoupdate — SHA-diff update + delisting detection.
 */

import { describe, it, expect, vi } from 'vitest';
import { PluginAutoupdate } from '../PluginAutoupdate';
import { MarketplaceRegistry } from '../MarketplaceRegistry';
import { InstalledPluginsStore } from '../installedPlugins';

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    readText: async (p: string) => (m.has(p) ? m.get(p)! : null),
    writeText: async (p: string, c: string) => { m.set(p, c); },
  };
}

const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);

function catalogue(sha: string, force = false) {
  return JSON.stringify({
    name: 'official',
    owner: { name: 'browserx' },
    forceRemoveDeletedPlugins: force,
    plugins: [{ name: 'gh', source: { type: 'github', repo: 'browserx/gh', sha } }],
  });
}

describe('PluginAutoupdate', () => {
  it('updates a plugin when catalogue SHA differs', async () => {
    const mk = new MarketplaceRegistry({ fetchCatalogue: async () => catalogue(SHA_NEW) });
    await mk.add('ref');
    const store = new InstalledPluginsStore({ ...memStore(), filePath: '/ip.json' });
    await store.addEntry('gh@official', {
      scope: 'user', version: '1', installedAt: 1, lastUpdated: 1,
      installPath: '/c/gh', gitCommitSha: SHA_OLD,
    });
    const writeFiles = vi.fn(async () => undefined);

    const au = new PluginAutoupdate({
      marketplaces: mk,
      installed: store,
      provider: { writeFiles, getRoot: () => '/c/gh' } as never,
      fetchPlugin: async () => ({ files: [], version: '2', gitCommitSha: SHA_NEW }),
      autoUpdateMarketplaces: () => ['official'],
      refreshMarketplace: async () => undefined,
    });

    const res = await au.run();
    expect(res.updated).toEqual(['gh@official']);
    expect(writeFiles).toHaveBeenCalled();
    const entries = await store.getEntries('gh@official');
    expect(entries[0].gitCommitSha).toBe(SHA_NEW);
    expect(entries[0].version).toBe('2');
  });

  it('no update when SHA matches', async () => {
    const mk = new MarketplaceRegistry({ fetchCatalogue: async () => catalogue(SHA_OLD) });
    await mk.add('ref');
    const store = new InstalledPluginsStore({ ...memStore(), filePath: '/ip.json' });
    await store.addEntry('gh@official', {
      scope: 'user', version: '1', installedAt: 1, lastUpdated: 1,
      installPath: '/c/gh', gitCommitSha: SHA_OLD,
    });
    const au = new PluginAutoupdate({
      marketplaces: mk,
      installed: store,
      provider: { writeFiles: vi.fn(), getRoot: () => '/c/gh' } as never,
      fetchPlugin: vi.fn(),
      autoUpdateMarketplaces: () => ['official'],
      refreshMarketplace: async () => undefined,
    });
    const res = await au.run();
    expect(res.updated).toEqual([]);
  });

  it('delisting: forceRemoveDeletedPlugins auto-uninstalls vanished plugins', async () => {
    // catalogue no longer lists 'old@official'
    const mk = new MarketplaceRegistry({ fetchCatalogue: async () => catalogue(SHA_OLD, true) });
    await mk.add('ref');
    const store = new InstalledPluginsStore({ ...memStore(), filePath: '/ip.json' });
    await store.addEntry('old@official', {
      scope: 'user', version: '1', installedAt: 1, lastUpdated: 1, installPath: '/c/old',
    });
    await store.addEntry('mgd@official', {
      scope: 'managed', version: '1', installedAt: 1, lastUpdated: 1, installPath: '/c/mgd',
    });
    const remove = vi.fn(async () => undefined);

    const au = new PluginAutoupdate({
      marketplaces: mk,
      installed: store,
      provider: { writeFiles: vi.fn(), getRoot: () => '/c', remove } as never,
      fetchPlugin: vi.fn(),
      autoUpdateMarketplaces: () => ['official'],
      refreshMarketplace: async () => undefined,
    });

    const res = await au.run();
    expect(res.delisted).toEqual(['old@official']);
    expect(remove).toHaveBeenCalledWith('old@official');
    // managed scope is left for the admin
    expect(await store.getEntries('mgd@official')).toHaveLength(1);
  });
});
