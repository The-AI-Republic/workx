/**
 * Track 10: FilesystemPluginProvider with a mocked Tauri `invoke` backed by
 * an in-memory filesystem. Verifies the same contract as
 * NodePluginProvider/IndexedDBPluginProvider: listMeta validation,
 * load → disabled LoadedPlugin, atomic writeFiles (staging + rename),
 * remove, and the readFile/listDirs slot-loader resolvers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory fs the mocked `invoke` operates on. Keys are absolute-ish paths.
const fsMap = new Map<string, string>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    const p = args?.path as string;
    switch (cmd) {
      case 'plugins_ensure_dir':
        return undefined;
      case 'plugins_list_entries': {
        const prefix = `${p}/`;
        const names = new Set<string>();
        for (const key of fsMap.keys()) {
          if (!key.startsWith(prefix)) continue;
          names.add(key.slice(prefix.length).split('/')[0]);
        }
        return [...names];
      }
      case 'plugins_read_file':
        return fsMap.has(p) ? fsMap.get(p)! : null;
      case 'plugins_write_file':
        fsMap.set(p, args.content as string);
        return undefined;
      case 'plugins_remove_dir': {
        const prefix = `${p}/`;
        for (const key of [...fsMap.keys()]) {
          if (key === p || key.startsWith(prefix)) fsMap.delete(key);
        }
        return undefined;
      }
      case 'plugins_rename': {
        const from = `${args.from as string}/`;
        const to = `${args.to as string}/`;
        // clear destination
        for (const key of [...fsMap.keys()]) {
          if (key.startsWith(to)) fsMap.delete(key);
        }
        for (const key of [...fsMap.keys()]) {
          if (key.startsWith(from)) {
            fsMap.set(to + key.slice(from.length), fsMap.get(key)!);
            fsMap.delete(key);
          }
        }
        return undefined;
      }
      case 'plugins_path_exists':
        return [...fsMap.keys()].some((k) => k === p || k.startsWith(`${p}/`));
      default:
        throw new Error(`unexpected invoke: ${cmd}`);
    }
  }),
}));

import { FilesystemPluginProvider } from '../FilesystemPluginProvider';

const ROOT = '~/.browserx/plugins';
const MANIFEST = JSON.stringify({ name: 'gh-workflow', version: '0.3.1', description: 'GH', skills: './skills' });

function buf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('FilesystemPluginProvider', () => {
  let provider: FilesystemPluginProvider;

  beforeEach(async () => {
    fsMap.clear();
    provider = new FilesystemPluginProvider(ROOT);
    await provider.initialize();
  });

  it('writeFiles stages then renames; listMeta discovers the plugin', async () => {
    await provider.writeFiles('gh-workflow@local', [
      { path: 'plugin.json', content: buf(MANIFEST) },
      { path: 'skills/pr/SKILL.md', content: buf('body') },
    ]);
    // No leftover staging keys
    expect([...fsMap.keys()].some((k) => k.includes('.staging-'))).toBe(false);
    const metas = await provider.listMeta();
    expect(metas.map((m) => m.name)).toEqual(['gh-workflow']);
  });

  it('listMeta skips invalid manifests', async () => {
    await provider.writeFiles('gh-workflow@local', [
      { path: 'plugin.json', content: buf(MANIFEST) },
    ]);
    // hand-place an invalid plugin dir
    fsMap.set(`${ROOT}/broken/plugin.json`, JSON.stringify({ name: 'broken' }));
    const metas = await provider.listMeta();
    expect(metas.map((m) => m.name)).toEqual(['gh-workflow']);
  });

  it('load returns a disabled LoadedPlugin', async () => {
    await provider.writeFiles('gh-workflow@local', [
      { path: 'plugin.json', content: buf(MANIFEST) },
    ]);
    await provider.listMeta();
    const loaded = await provider.load('gh-workflow@local');
    expect(loaded.id).toBe('gh-workflow@local');
    expect(loaded.state.status).toBe('disabled');
    expect(loaded.manifest.description).toBe('GH');
  });

  it('readFile / listDirs resolve via the mocked Rust commands', async () => {
    await provider.writeFiles('p@local', [
      { path: 'plugin.json', content: buf(JSON.stringify({ name: 'p', version: '1.0.0' })) },
      { path: 'skills/a/SKILL.md', content: buf('A') },
      { path: 'skills/b/SKILL.md', content: buf('B') },
    ]);
    const root = provider.getRoot('p@local');
    expect(await provider.readFile(`${root}/plugin.json`)).toContain('"name":"p"');
    expect((await provider.listDirs(`${root}/skills`)).sort()).toEqual(['a', 'b']);
  });

  it('remove deletes the plugin directory', async () => {
    await provider.writeFiles('doomed@local', [
      { path: 'plugin.json', content: buf(JSON.stringify({ name: 'doomed', version: '1.0.0' })) },
    ]);
    expect(await provider.exists('doomed@local')).toBe(true);
    await provider.remove('doomed@local');
    expect(await provider.exists('doomed@local')).toBe(false);
  });
});
