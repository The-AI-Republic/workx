/**
 * Track 10: NodePluginProvider + PluginRegistry end-to-end against a real
 * temp directory. This is the E2E-1 gate (local plugin happy path) from
 * design.md § End-to-End Integration Scenarios, scoped to what the
 * provider + registry own (slot loaders are stubbed — their own units
 * cover the registry contributions).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodePluginProvider } from '../NodePluginProvider';
import { PluginRegistry } from '@/core/plugins/PluginRegistry';
import type { PluginRegistryDeps } from '@/core/plugins/PluginRegistry';

async function writeFixturePlugin(root: string, name: string, manifest: object) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
  return dir;
}

function stubSlots(): Pick<
  PluginRegistryDeps,
  'skillSlot' | 'hookSlot' | 'mcpSlot' | 'subAgentSlot' | 'commandSlot'
> {
  return {
    skillSlot: { load: vi.fn(async () => []), unload: vi.fn(async () => undefined) } as never,
    hookSlot: {
      load: vi.fn(() => []),
      unload: vi.fn(),
      pruneRemovedPlugins: vi.fn(() => 0),
    } as never,
    mcpSlot: { load: vi.fn(async () => []), unload: vi.fn(async () => undefined) } as never,
    subAgentSlot: { load: vi.fn(async () => []), unload: vi.fn(async () => undefined) } as never,
    commandSlot: { load: vi.fn(async () => []), unload: vi.fn() } as never,
  };
}

describe('NodePluginProvider + PluginRegistry (E2E-1)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workx-plugins-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('initialize creates the plugins root', async () => {
    const root = path.join(tmpRoot, 'plugins');
    const provider = new NodePluginProvider(root);
    await provider.initialize();
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);
  });

  it('listMeta discovers a valid plugin and skips invalid ones', async () => {
    const root = path.join(tmpRoot, 'plugins');
    await fs.mkdir(root, { recursive: true });
    await writeFixturePlugin(root, 'good', {
      name: 'good-plugin',
      version: '1.0.0',
      skills: './skills',
    });
    // Invalid: missing required `version`
    await writeFixturePlugin(root, 'bad', { name: 'bad-plugin' });
    // Not a plugin dir (no plugin.json)
    await fs.mkdir(path.join(root, 'empty'), { recursive: true });

    const provider = new NodePluginProvider(root);
    const metas = await provider.listMeta();
    expect(metas.map((m) => m.name)).toEqual(['good-plugin']);
  });

  it('load returns a LoadedPlugin in disabled state with resolved path', async () => {
    const root = path.join(tmpRoot, 'plugins');
    await fs.mkdir(root, { recursive: true });
    const dir = await writeFixturePlugin(root, 'gh', {
      name: 'gh-workflow',
      version: '0.3.1',
      description: 'GitHub helpers',
      skills: './skills',
    });

    const provider = new NodePluginProvider(root);
    await provider.listMeta();
    const loaded = await provider.load('gh-workflow@local');

    expect(loaded.id).toBe('gh-workflow@local');
    expect(loaded.path).toBe(dir);
    expect(loaded.state.status).toBe('disabled');
    expect(loaded.manifest.description).toBe('GitHub helpers');
  });

  it('end-to-end: discover → register → enable → disable lifecycle', async () => {
    const root = path.join(tmpRoot, 'plugins');
    await fs.mkdir(root, { recursive: true });
    await writeFixturePlugin(root, 'test-plugin', {
      name: 'test-plugin',
      version: '1.0.0',
      skills: './skills',
      commands: './commands',
    });

    const provider = new NodePluginProvider(root);
    await provider.initialize();

    const enabledStore: Record<string, boolean> = {};
    const deps: PluginRegistryDeps = {
      provider,
      ...stubSlots(),
      getEnabledFromConfig: () => enabledStore,
      persistEnabled: async (id, on) => {
        enabledStore[id] = on;
      },
    };
    const registry = new PluginRegistry(deps);

    // Discover + register
    const metas = await provider.listMeta();
    for (const m of metas) {
      registry.register(await provider.load(`${m.name}@local`));
    }
    expect(registry.getPlugins().map((p) => p.id)).toEqual(['test-plugin@local']);

    // Enable
    await registry.enable('test-plugin@local');
    expect(registry.isEnabled('test-plugin@local')).toBe(true);
    expect(enabledStore['test-plugin@local']).toBe(true);
    expect(deps.skillSlot!.load).toHaveBeenCalledTimes(1);
    expect(deps.commandSlot!.load).toHaveBeenCalledTimes(1);

    // Disable
    await registry.disable('test-plugin@local');
    expect(registry.isEnabled('test-plugin@local')).toBe(false);
    expect(enabledStore['test-plugin@local']).toBe(false);
  });

  it('remove deletes the plugin directory', async () => {
    const root = path.join(tmpRoot, 'plugins');
    await fs.mkdir(root, { recursive: true });
    const dir = await writeFixturePlugin(root, 'doomed', {
      name: 'doomed',
      version: '1.0.0',
    });

    const provider = new NodePluginProvider(root);
    await provider.listMeta();
    expect(await provider.exists('doomed@local')).toBe(true);
    await provider.remove('doomed@local');

    const stat = await fs.stat(dir).catch(() => null);
    expect(stat).toBeNull();
  });

  it('writeFiles atomically installs a plugin (staging + rename)', async () => {
    const root = path.join(tmpRoot, 'plugins');
    const provider = new NodePluginProvider(root);
    await provider.initialize();

    await provider.writeFiles('newbie@local', [
      {
        path: 'plugin.json',
        content: Buffer.from(JSON.stringify({ name: 'newbie', version: '1.0.0' })),
      },
      { path: 'skills/x/SKILL.md', content: Buffer.from('---\nname: x\ndescription: y\n---\nbody') },
    ]);

    const metas = await provider.listMeta();
    expect(metas.map((m) => m.name)).toContain('newbie');
    // No leftover staging dirs
    const entries = await fs.readdir(root);
    expect(entries.some((e) => e.includes('.staging-'))).toBe(false);
  });

  it('SECURITY: writeFiles rejects a path-traversal entry (no escape)', async () => {
    const root = path.join(tmpRoot, 'plugins');
    const provider = new NodePluginProvider(root);
    await provider.initialize();

    const sentinel = path.join(tmpRoot, 'PWNED');
    await expect(
      provider.writeFiles('evil@local', [
        { path: 'plugin.json', content: Buffer.from('{"name":"evil","version":"1.0.0"}') },
        { path: '../../PWNED', content: Buffer.from('owned') },
      ]),
    ).rejects.toThrow(/traversal/);

    // The escape target must NOT have been written.
    const escaped = await fs.stat(sentinel).then(() => true).catch(() => false);
    expect(escaped).toBe(false);
  });
});
