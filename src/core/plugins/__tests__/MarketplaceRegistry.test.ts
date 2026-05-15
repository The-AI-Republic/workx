/**
 * Track 10b: MarketplaceRegistry + PluginCache.
 */

import { describe, it, expect, vi } from 'vitest';
import { MarketplaceRegistry } from '../MarketplaceRegistry';
import { PluginCache, BROWSERX_PLUGIN_ORPHAN_TTL_MS } from '../PluginCache';

const CAT = JSON.stringify({
  name: 'official',
  owner: { name: 'browserx' },
  plugins: [
    { name: 'gh', source: { type: 'path', path: '/x/gh' }, version: '1.0.0' },
    { name: 'fmt', source: { type: 'github', repo: 'browserx/fmt', sha: 'a'.repeat(40) } },
  ],
});

describe('MarketplaceRegistry', () => {
  it('add parses + indexes the catalogue; lookup resolves entries', async () => {
    const r = new MarketplaceRegistry({ fetchCatalogue: async () => CAT });
    const res = await r.add('https://example.com/official');
    expect(res).toEqual({ ok: true, name: 'official' });

    expect(r.list()).toEqual([
      expect.objectContaining({ name: 'official', pluginCount: 2 }),
    ]);

    const hit = r.lookup('gh@official');
    expect(hit?.entry.name).toBe('gh');
    expect(r.lookup('nope@official')).toBeNull();
    expect(r.lookup('gh@unknown')).toBeNull();

    expect(r.pluginIds('official').sort()).toEqual(['fmt@official', 'gh@official']);
  });

  it('add reports fetch + parse + schema failures', async () => {
    const fetchFail = new MarketplaceRegistry({
      fetchCatalogue: async () => { throw new Error('net down'); },
    });
    expect(await fetchFail.add('x')).toEqual({ ok: false, error: expect.stringMatching(/fetch failed/) });

    const badJson = new MarketplaceRegistry({ fetchCatalogue: async () => 'nope' });
    expect((await badJson.add('x')).ok).toBe(false);

    const badSchema = new MarketplaceRegistry({ fetchCatalogue: async () => '{"name":"x"}' });
    expect((await badSchema.add('x')).ok).toBe(false);
  });

  it('remove deletes a marketplace', async () => {
    const r = new MarketplaceRegistry({ fetchCatalogue: async () => CAT });
    await r.add('ref');
    expect(r.remove('official')).toBe(true);
    expect(r.list()).toHaveLength(0);
  });
});

describe('PluginCache', () => {
  function memFs() {
    const files = new Map<string, string>();
    const dirs = new Map<string, Set<string>>();
    const addChild = (parent: string, child: string) => {
      if (!dirs.has(parent)) dirs.set(parent, new Set());
      dirs.get(parent)!.add(child);
    };
    return {
      files,
      dirs,
      readText: async (p: string) => (files.has(p) ? files.get(p)! : null),
      writeText: async (p: string, c: string) => {
        files.set(p, c);
        const parent = p.slice(0, p.lastIndexOf('/'));
        addChild(parent, p.slice(parent.length + 1));
      },
      removeDir: async (p: string) => {
        for (const k of [...files.keys()]) if (k.startsWith(p)) files.delete(k);
      },
      removeFile: async (p: string) => { files.delete(p); },
      listEntries: async (p: string) => [...(dirs.get(p) ?? [])],
      pathExists: async (p: string) => files.has(p),
    };
  }

  it('versionDir sanitizes segments', () => {
    const c = new PluginCache('/root', memFs());
    expect(c.versionDir('off/icial', 'gh wf', '1.0/0')).toBe(
      '/root/cache/off-icial/gh-wf/1.0-0',
    );
  });

  it('gcOrphans: marks unmarked, sweeps expired, protects installed', async () => {
    let now = 1_000_000;
    const fs = { ...memFs(), now: () => now };
    const c = new PluginCache('/root', fs);

    // seed two versions under official/gh
    fs.dirs.set('/root/cache/official', new Set(['gh']));
    fs.dirs.set('/root/cache/official/gh', new Set(['v1', 'v2']));
    const v1 = '/root/cache/official/gh/v1';
    const v2 = '/root/cache/official/gh/v2';

    // first sweep: neither installed, no markers → both get marked, none removed
    let removed = await c.gcOrphans(['official'], new Set());
    expect(removed).toEqual([]);
    expect(fs.files.has(`${v1}/.orphaned_at`)).toBe(true);

    // advance past TTL; v2 is "installed" (protected), v1 should be swept
    now += BROWSERX_PLUGIN_ORPHAN_TTL_MS + 1;
    removed = await c.gcOrphans(['official'], new Set([v2]));
    expect(removed).toEqual([v1]);
  });
});
