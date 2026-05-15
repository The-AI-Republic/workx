/**
 * Track 10b: PluginInstaller / PluginUninstaller orchestration + the
 * installed_plugins_v2 store. All I/O injected (in-memory) so the 9-step
 * flows are verified without real git/network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginInstaller, PluginUninstaller } from '../PluginInstaller';
import { MarketplaceRegistry } from '../MarketplaceRegistry';
import { InstalledPluginsStore } from '../installedPlugins';
import { PluginRegistry } from '../PluginRegistry';
import type { PluginRegistryDeps } from '../PluginRegistry';
import type { LoadedPlugin } from '../types';

const CATALOGUE = JSON.stringify({
  name: 'official',
  owner: { name: 'browserx' },
  plugins: [
    { name: 'gh-workflow', source: { type: 'path', path: '/src/gh' }, version: '0.3.1', dependencies: ['common'] },
    { name: 'common', source: { type: 'path', path: '/src/common' }, version: '1.0.0' },
  ],
});

function memStore(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    map: m,
    readText: async (p: string) => (m.has(p) ? m.get(p)! : null),
    writeText: async (p: string, c: string) => { m.set(p, c); },
  };
}

function makeRegistry(): { registry: PluginRegistry; loaded: Map<string, LoadedPlugin> } {
  const loaded = new Map<string, LoadedPlugin>();
  const provider = {
    initialize: vi.fn(),
    listMeta: vi.fn(async () => []),
    load: vi.fn(async (id: string) => loaded.get(id)!),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => undefined),
    writeFiles: vi.fn(async () => undefined),
    getRoot: (id: string) => `/cache/${id}`,
  };
  const deps: PluginRegistryDeps = {
    provider: provider as never,
    skillSlot: { load: vi.fn(async () => []), unload: vi.fn(async () => undefined) } as never,
    getEnabledFromConfig: () => ({}),
    persistEnabled: async () => undefined,
  };
  return { registry: new PluginRegistry(deps), loaded };
}

function loadedPlugin(id: string): LoadedPlugin {
  return {
    id,
    manifest: { name: id.split('@')[0], version: '1.0.0' },
    path: `/cache/${id}`,
    source: { type: 'path', path: `/cache/${id}` },
    scope: 'user',
    state: { status: 'disabled' },
  };
}

describe('InstalledPluginsStore', () => {
  it('addEntry / getEntries / removeEntry (last-scope detection)', async () => {
    const s = memStore();
    const store = new InstalledPluginsStore({ ...s, filePath: '/ip.json' });

    await store.addEntry('a@local', {
      scope: 'user', version: '1', installedAt: 1, lastUpdated: 1, installPath: '/c/a',
    });
    expect(await store.getEntries('a@local')).toHaveLength(1);

    // second scope
    await store.addEntry('a@local', {
      scope: 'project', version: '1', installedAt: 1, lastUpdated: 1, installPath: '/c/a',
    });
    expect(await store.getEntries('a@local')).toHaveLength(2);

    expect(await store.removeEntry('a@local', 'user')).toBe(false); // project remains
    expect(await store.removeEntry('a@local', 'project')).toBe(true); // last scope
    expect(await store.getEntries('a@local')).toHaveLength(0);
  });

  it('corrupt file falls back to empty', async () => {
    const s = memStore({ '/ip.json': 'not json' });
    const store = new InstalledPluginsStore({ ...s, filePath: '/ip.json' });
    expect(await store.read()).toEqual({ version: 2, plugins: {} });
  });
});

describe('PluginInstaller', () => {
  let marketplaces: MarketplaceRegistry;
  let installedStore: InstalledPluginsStore;
  let ctx: ReturnType<typeof makeRegistry>;
  let enabledWrites: Array<{ ids: string[]; enabled: boolean }>;

  beforeEach(async () => {
    marketplaces = new MarketplaceRegistry({ fetchCatalogue: async () => CATALOGUE });
    await marketplaces.add('https://example.com/official');
    const s = memStore();
    installedStore = new InstalledPluginsStore({ ...s, filePath: '/ip.json' });
    ctx = makeRegistry();
    enabledWrites = [];
  });

  function installer(overrides = {}) {
    return new PluginInstaller({
      marketplaces,
      provider: { writeFiles: vi.fn(async () => undefined), getRoot: (id: string) => `/cache/${id}`, load: async (id: string) => { ctx.loaded.set(id, loadedPlugin(id)); return loadedPlugin(id); } } as never,
      installed: installedStore,
      registry: ctx.registry,
      fetchPlugin: async (id) => ({ files: [{ path: 'plugin.json', content: new Uint8Array() }], version: '0.3.1', gitCommitSha: undefined }),
      setEnabled: async (ids, enabled) => { enabledWrites.push({ ids, enabled }); },
      getAlreadyEnabled: () => new Set<string>(),
      ...overrides,
    });
  }

  it('installs a plugin + its dependency in post-order, one settings write', async () => {
    const res = await installer().install('gh-workflow@official');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.installed).toEqual(['common@official', 'gh-workflow@official']);
    // ONE atomic enabledPlugins write for the whole closure
    expect(enabledWrites).toHaveLength(1);
    expect(enabledWrites[0]).toEqual({
      ids: ['common@official', 'gh-workflow@official'],
      enabled: true,
    });
    expect((await installedStore.getEntries('gh-workflow@official'))).toHaveLength(1);
  });

  it('refuses managed scope', async () => {
    const res = await installer().install('gh-workflow@official', 'managed');
    expect(res).toEqual({ ok: false, error: 'cannot install into managed scope' });
  });

  it('root policy guard blocks before any write', async () => {
    const res = await installer({ isBlockedByPolicy: (id: string) => id === 'gh-workflow@official' }).install('gh-workflow@official');
    expect(res.ok).toBe(false);
    expect(enabledWrites).toHaveLength(0);
  });

  it('fail-closed: a blocked dependency aborts the install', async () => {
    const res = await installer({ isBlockedByPolicy: (id: string) => id === 'common@official' }).install('gh-workflow@official');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/common@official blocked/);
    expect(enabledWrites).toHaveLength(0);
  });

  it('SHA mismatch aborts materialization', async () => {
    const cat = JSON.parse(CATALOGUE);
    cat.plugins[1].source = { type: 'github', repo: 'x/common', sha: 'a'.repeat(40) };
    const mk = new MarketplaceRegistry({ fetchCatalogue: async () => JSON.stringify(cat) });
    await mk.add('ref');
    const res = await installer({
      marketplaces: mk,
      fetchPlugin: async () => ({ files: [], version: '1', gitCommitSha: 'b'.repeat(40) }),
    }).install('common@official');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/SHA mismatch/);
  });
});

describe('PluginUninstaller', () => {
  it('B2: last-scope uninstall ORPHAN-MARKS the install path, does NOT hard-delete', async () => {
    const s = memStore();
    const installedStore = new InstalledPluginsStore({ ...s, filePath: '/ip.json' });
    await installedStore.addEntry('gone@local', {
      scope: 'user', version: '1', installedAt: 1, lastUpdated: 1, installPath: '/c/gone',
    });
    const ctx = makeRegistry();
    ctx.registry.register(loadedPlugin('gone@local'));
    const removeFiles = vi.fn(async () => undefined);
    const markOrphaned = vi.fn(async () => undefined);
    const deleteOpts = vi.fn(async () => undefined);
    const enabled: Array<{ ids: string[]; enabled: boolean }> = [];

    const u = new PluginUninstaller({
      provider: { remove: removeFiles } as never,
      installed: installedStore,
      registry: ctx.registry,
      markOrphaned,
      setEnabled: async (ids, e) => { enabled.push({ ids, enabled: e }); },
      deletePluginOptions: deleteOpts,
    });

    const res = await u.uninstall('gone@local', 'user');
    expect(res).toEqual({ ok: true });
    expect(enabled).toEqual([{ ids: ['gone@local'], enabled: false }]);
    expect(await installedStore.getEntries('gone@local')).toHaveLength(0);
    // CORRECTNESS: orphan-mark the captured install path; never hard-delete
    expect(markOrphaned).toHaveBeenCalledWith('/c/gone');
    expect(removeFiles).not.toHaveBeenCalled();
    expect(deleteOpts).toHaveBeenCalledWith('gone@local');
  });

  it('B2: non-last scope does not orphan-mark', async () => {
    const s = memStore();
    const installedStore = new InstalledPluginsStore({ ...s, filePath: '/ip.json' });
    await installedStore.addEntry('multi@local', {
      scope: 'user', version: '1', installedAt: 1, lastUpdated: 1, installPath: '/c/multi',
    });
    await installedStore.addEntry('multi@local', {
      scope: 'project', version: '1', installedAt: 1, lastUpdated: 1, installPath: '/c/multi',
    });
    const ctx = makeRegistry();
    ctx.registry.register(loadedPlugin('multi@local'));
    const markOrphaned = vi.fn(async () => undefined);
    const u = new PluginUninstaller({
      provider: { remove: vi.fn() } as never,
      installed: installedStore,
      registry: ctx.registry,
      markOrphaned,
      setEnabled: async () => undefined,
    });
    await u.uninstall('multi@local', 'user');
    expect(markOrphaned).not.toHaveBeenCalled(); // project scope remains
    expect(await installedStore.getEntries('multi@local')).toHaveLength(1);
  });

  it('active-task guard refuses uninstall', async () => {
    const s = memStore();
    const u = new PluginUninstaller({
      provider: { remove: vi.fn() } as never,
      installed: new InstalledPluginsStore({ ...s, filePath: '/ip.json' }),
      registry: makeRegistry().registry,
      setEnabled: async () => undefined,
      checkActiveTasks: () => '1 background task running',
    });
    const res = await u.uninstall('busy@local');
    expect(res).toEqual({ ok: false, error: '1 background task running' });
  });
});
