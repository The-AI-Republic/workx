/**
 * Track 10: plugins service surface.
 *
 * Exercises createPluginsServices against a real PluginRegistry with a
 * stub provider + stub slot loaders. Verifies the JSON-RPC-ish shapes the
 * /plugin slash command consumes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPluginsServices } from '../plugins-services';
import { PluginRegistry } from '@/core/plugins/PluginRegistry';
import type { PluginRegistryDeps } from '@/core/plugins/PluginRegistry';
import type { LoadedPlugin } from '@/core/plugins/types';

function makePlugin(name: string): LoadedPlugin {
  return {
    id: `${name}@local`,
    manifest: { name, version: '1.0.0', description: `${name} desc`, skills: './skills' },
    path: `/plugins/${name}`,
    source: { type: 'path', path: `/plugins/${name}` },
    scope: 'user',
    state: { status: 'disabled' },
  };
}

function makeRegistry(): { registry: PluginRegistry; enabledStore: Record<string, boolean> } {
  const enabledStore: Record<string, boolean> = {};
  const deps: PluginRegistryDeps = {
    provider: {
      initialize: vi.fn(),
      listMeta: vi.fn(async () => []),
      load: vi.fn(),
      exists: vi.fn(async () => true),
      remove: vi.fn(),
      writeFiles: vi.fn(),
      getRoot: (id) => `/plugins/${id}`,
    },
    skillSlot: { load: vi.fn(async () => []), unload: vi.fn(async () => undefined) } as never,
    getEnabledFromConfig: () => enabledStore,
    persistEnabled: async (id, on) => { enabledStore[id] = on; },
  };
  return { registry: new PluginRegistry(deps), enabledStore };
}

describe('plugins-services', () => {
  let registry: PluginRegistry;
  let svc: ReturnType<typeof createPluginsServices>;

  beforeEach(() => {
    ({ registry } = makeRegistry());
    registry.register(makePlugin('alpha'));
    registry.register(makePlugin('beta'));
    svc = createPluginsServices({ pluginRegistry: registry });
  });

  it('plugins.list returns summary rows', async () => {
    const rows = (await svc['plugins.list']({}, {} as never)) as Array<{ id: string; status: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(['alpha@local', 'beta@local']);
    expect(rows.every((r) => r.status === 'disabled')).toBe(true);
  });

  it('plugins.info returns detail incl. capabilities + source', async () => {
    const info = (await svc['plugins.info']({ id: 'alpha@local' }, {} as never)) as {
      id: string; capabilities: Record<string, boolean>; source: string; loadErrors: string[];
    };
    expect(info.id).toBe('alpha@local');
    expect(info.capabilities.skills).toBe(true);
    expect(info.capabilities.hooks).toBe(false);
    expect(info.source).toBe('path:/plugins/alpha');
    expect(info.loadErrors).toEqual([]);
  });

  it('plugins.info returns error for unknown id', async () => {
    const res = (await svc['plugins.info']({ id: 'nope@local' }, {} as never)) as { error: string };
    expect(res.error).toMatch(/not found/);
  });

  it('plugins.enable enables and reports success', async () => {
    const res = (await svc['plugins.enable']({ id: 'alpha@local' }, {} as never)) as {
      success: boolean; plugin: { status: string } | null;
    };
    expect(res.success).toBe(true);
    expect(res.plugin?.status).toBe('enabled');
    expect(registry.isEnabled('alpha@local')).toBe(true);
  });

  it('plugins.disable disables a previously enabled plugin', async () => {
    await svc['plugins.enable']({ id: 'beta@local' }, {} as never);
    const res = (await svc['plugins.disable']({ id: 'beta@local' }, {} as never)) as { success: boolean };
    expect(res.success).toBe(true);
    expect(registry.isEnabled('beta@local')).toBe(false);
  });

  it('plugins.reload returns enabled/disabled/errors arrays', async () => {
    const res = (await svc['plugins.reload']({}, {} as never)) as {
      success: boolean; enabled: unknown[]; disabled: unknown[]; errors: unknown[];
    };
    expect(res.success).toBe(true);
    expect(Array.isArray(res.enabled)).toBe(true);
    expect(Array.isArray(res.errors)).toBe(true);
  });
});
