/**
 * Track 10: IndexedDBPluginProvider against an in-memory StorageProvider.
 *
 * Verifies the virtualized multi-file plugin store: atomic writeFiles,
 * listMeta validation, virtual-path readFile/listDirs resolution, and a
 * discover → register → enable lifecycle through PluginRegistry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IndexedDBPluginProvider } from '../IndexedDBPluginProvider';
import { PluginRegistry } from '@/core/plugins/PluginRegistry';
import type { PluginRegistryDeps } from '@/core/plugins/PluginRegistry';
import type { StorageProvider } from '@/core/storage/StorageProvider';

/** Minimal in-memory StorageProvider — only the methods the provider uses. */
function makeMemoryStorage(): StorageProvider {
  const store = new Map<string, Map<string, unknown>>();
  const col = (c: string) => {
    if (!store.has(c)) store.set(c, new Map());
    return store.get(c)!;
  };
  return {
    initialize: async () => undefined,
    close: async () => undefined,
    get: async <T>(c: string, k: string) => (col(c).get(k) ?? null) as T | null,
    set: async <T>(c: string, k: string, v: T) => { col(c).set(k, v); },
    delete: async (c: string, k: string) => { col(c).delete(k); },
    list: async <T>(c: string) => [...col(c).values()] as T[],
    getMany: async () => new Map(),
    setMany: async () => undefined,
    deleteMany: async () => undefined,
    query: async () => [],
    count: async () => 0,
    transaction: async (fn: never) => (fn as never),
    clear: async (c: string) => { col(c).clear(); },
    vacuum: async () => undefined,
  } as unknown as StorageProvider;
}

const MANIFEST = JSON.stringify({
  name: 'gh-workflow',
  version: '0.3.1',
  description: 'GitHub helpers',
  skills: './skills',
});

function buf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('IndexedDBPluginProvider', () => {
  let storage: StorageProvider;
  let provider: IndexedDBPluginProvider;

  beforeEach(async () => {
    storage = makeMemoryStorage();
    provider = new IndexedDBPluginProvider(storage);
    await provider.initialize();
  });

  it('writeFiles stores a plugin atomically and listMeta finds it', async () => {
    await provider.writeFiles('gh-workflow@local', [
      { path: 'plugin.json', content: buf(MANIFEST) },
      { path: 'skills/pr/SKILL.md', content: buf('---\nname: pr\ndescription: d\n---\nbody') },
    ]);
    const metas = await provider.listMeta();
    expect(metas.map((m) => m.name)).toEqual(['gh-workflow']);
    expect(metas[0].description).toBe('GitHub helpers');
  });

  it('writeFiles rejects a record with no plugin.json', async () => {
    await expect(
      provider.writeFiles('x@local', [{ path: 'readme.md', content: buf('hi') }]),
    ).rejects.toThrow(/missing plugin.json/);
  });

  it('writeFiles rejects an invalid manifest', async () => {
    await expect(
      provider.writeFiles('bad@local', [
        { path: 'plugin.json', content: buf(JSON.stringify({ name: 'bad' })) }, // no version
      ]),
    ).rejects.toThrow(/invalid plugin.json/);
  });

  it('readFile resolves virtual paths against the stored files map', async () => {
    await provider.writeFiles('gh-workflow@local', [
      { path: 'plugin.json', content: buf(MANIFEST) },
      { path: 'skills/pr/SKILL.md', content: buf('SKILL BODY') },
    ]);
    const root = provider.getRoot('gh-workflow@local');
    expect(await provider.readFile(`${root}/plugin.json`)).toBe(MANIFEST);
    expect(await provider.readFile(`${root}/skills/pr/SKILL.md`)).toBe('SKILL BODY');
    expect(await provider.readFile(`${root}/nope.txt`)).toBeNull();
  });

  it('listDirs returns immediate child segments', async () => {
    await provider.writeFiles('p@local', [
      { path: 'plugin.json', content: buf(JSON.stringify({ name: 'p', version: '1.0.0' })) },
      { path: 'skills/a/SKILL.md', content: buf('a') },
      { path: 'skills/b/SKILL.md', content: buf('b') },
    ]);
    const root = provider.getRoot('p@local');
    expect((await provider.listDirs(root)).sort()).toEqual(['plugin.json', 'skills']);
    expect((await provider.listDirs(`${root}/skills`)).sort()).toEqual(['a', 'b']);
  });

  it('load returns a LoadedPlugin in disabled state', async () => {
    await provider.writeFiles('gh-workflow@local', [
      { path: 'plugin.json', content: buf(MANIFEST) },
    ]);
    const loaded = await provider.load('gh-workflow@local');
    expect(loaded.id).toBe('gh-workflow@local');
    expect(loaded.state.status).toBe('disabled');
    expect(loaded.manifest.name).toBe('gh-workflow');
  });

  it('remove deletes the record', async () => {
    await provider.writeFiles('doomed@local', [
      { path: 'plugin.json', content: buf(JSON.stringify({ name: 'doomed', version: '1.0.0' })) },
    ]);
    expect(await provider.exists('doomed@local')).toBe(true);
    await provider.remove('doomed@local');
    expect(await provider.exists('doomed@local')).toBe(false);
  });

  it('end-to-end: discover → register → enable through PluginRegistry', async () => {
    await provider.writeFiles('test-plugin@local', [
      { path: 'plugin.json', content: buf(JSON.stringify({ name: 'test-plugin', version: '1.0.0', skills: './skills' })) },
    ]);

    const enabledStore: Record<string, boolean> = {};
    const deps: PluginRegistryDeps = {
      provider,
      skillSlot: { load: vi.fn(async () => []), unload: vi.fn(async () => undefined) } as never,
      getEnabledFromConfig: () => enabledStore,
      persistEnabled: async (id, on) => { enabledStore[id] = on; },
    };
    const registry = new PluginRegistry(deps);

    for (const m of await provider.listMeta()) {
      registry.register(await provider.load(`${m.name}@local`));
    }
    expect(registry.getPlugins().map((p) => p.id)).toEqual(['test-plugin@local']);

    await registry.enable('test-plugin@local');
    expect(registry.isEnabled('test-plugin@local')).toBe(true);
    expect(enabledStore['test-plugin@local']).toBe(true);
    expect(deps.skillSlot!.load).toHaveBeenCalledTimes(1);
  });
});
