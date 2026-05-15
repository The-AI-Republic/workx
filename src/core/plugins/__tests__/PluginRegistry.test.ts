/**
 * Track 10: PluginRegistry lifecycle.
 *
 * Verifies the orchestration contract with stub slot-loaders (no real
 * registries): enable populates all slots, disable unloads all, idempotent
 * toggles, rollback on partial failure, reconcileFromConfig, evicted block.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginRegistry } from '../PluginRegistry';
import type { PluginRegistryDeps } from '../PluginRegistry';
import type { LoadedPlugin } from '../types';

function makePlugin(id: string, slots: Partial<LoadedPlugin['manifest']> = {}): LoadedPlugin {
  return {
    id,
    manifest: {
      name: id.split('@')[0],
      version: '1.0.0',
      skills: './skills',
      hooks: { PreToolUse: [] },
      mcpServers: { foo: {} },
      agents: './agents',
      commands: './commands',
      ...slots,
    },
    path: `/plugins/${id}`,
    source: { type: 'path', path: `/plugins/${id}` },
    scope: 'user',
    state: { status: 'disabled' },
  };
}

function makeDeps(overrides: Partial<PluginRegistryDeps> = {}): {
  deps: PluginRegistryDeps;
  calls: Record<string, string[]>;
  enabledStore: Record<string, boolean>;
} {
  const calls: Record<string, string[]> = {
    skillLoad: [], skillUnload: [],
    hookLoad: [], hookUnload: [],
    mcpLoad: [], mcpUnload: [],
    agentLoad: [], agentUnload: [],
    commandLoad: [], commandUnload: [],
  };
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
    skillSlot: {
      load: vi.fn(async (p) => { calls.skillLoad.push(p.id); return []; }),
      unload: vi.fn(async (id) => { calls.skillUnload.push(id); }),
    } as never,
    hookSlot: {
      load: vi.fn((p) => { calls.hookLoad.push(p.id); return []; }),
      unload: vi.fn((id) => { calls.hookUnload.push(id); }),
      pruneRemovedPlugins: vi.fn(() => 0),
    } as never,
    mcpSlot: {
      load: vi.fn(async (p) => { calls.mcpLoad.push(p.id); return []; }),
      unload: vi.fn(async (id) => { calls.mcpUnload.push(id); }),
    } as never,
    subAgentSlot: {
      load: vi.fn(async (p) => { calls.agentLoad.push(p.id); return []; }),
      unload: vi.fn(async (id) => { calls.agentUnload.push(id); }),
    } as never,
    commandSlot: {
      load: vi.fn(async (p) => { calls.commandLoad.push(p.id); return []; }),
      unload: vi.fn((id) => { calls.commandUnload.push(id); }),
    } as never,
    getEnabledFromConfig: () => enabledStore,
    persistEnabled: vi.fn(async (id, enabled) => { enabledStore[id] = enabled; }),
    ...overrides,
  };
  return { deps, calls, enabledStore };
}

describe('PluginRegistry — enable/disable lifecycle', () => {
  let registry: PluginRegistry;
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
    registry = new PluginRegistry(ctx.deps);
  });

  it('enable loads all five slots and marks state enabled', async () => {
    registry.register(makePlugin('p@local'));
    await registry.enable('p@local');

    expect(ctx.calls.skillLoad).toEqual(['p@local']);
    expect(ctx.calls.hookLoad).toEqual(['p@local']);
    expect(ctx.calls.mcpLoad).toEqual(['p@local']);
    expect(ctx.calls.agentLoad).toEqual(['p@local']);
    expect(ctx.calls.commandLoad).toEqual(['p@local']);

    const p = registry.getPlugin('p@local')!;
    expect(p.state.status).toBe('enabled');
    expect(ctx.enabledStore['p@local']).toBe(true);
  });

  it('disable unloads all five slots and marks state disabled', async () => {
    registry.register(makePlugin('p@local'));
    await registry.enable('p@local');
    await registry.disable('p@local');

    expect(ctx.calls.skillUnload).toEqual(['p@local']);
    expect(ctx.calls.hookUnload).toEqual(['p@local']);
    expect(ctx.calls.mcpUnload).toEqual(['p@local']);
    expect(ctx.calls.agentUnload).toEqual(['p@local']);
    expect(ctx.calls.commandUnload).toEqual(['p@local']);

    expect(registry.getPlugin('p@local')!.state.status).toBe('disabled');
    expect(ctx.enabledStore['p@local']).toBe(false);
  });

  it('enable is idempotent — second call is a no-op', async () => {
    registry.register(makePlugin('p@local'));
    await registry.enable('p@local');
    await registry.enable('p@local');
    expect(ctx.calls.skillLoad).toEqual(['p@local']); // only once
  });

  it('disable on non-enabled plugin is a no-op', async () => {
    registry.register(makePlugin('p@local'));
    await registry.disable('p@local');
    expect(ctx.calls.skillUnload).toEqual([]);
  });

  it('only loads slots that the manifest declares', async () => {
    registry.register(makePlugin('p@local', { hooks: undefined, mcpServers: undefined, agents: undefined, commands: undefined }));
    await registry.enable('p@local');
    expect(ctx.calls.skillLoad).toEqual(['p@local']);
    expect(ctx.calls.hookLoad).toEqual([]);
    expect(ctx.calls.mcpLoad).toEqual([]);
  });

  it('rolls back completed slots in reverse order on partial failure', async () => {
    const failingDeps = makeDeps();
    // mcp slot throws — skills + hooks already completed, should roll back
    failingDeps.deps.mcpSlot = {
      load: vi.fn(async () => { throw new Error('mcp boom'); }),
      unload: vi.fn(async (id: string) => { failingDeps.calls.mcpUnload.push(id); }),
    } as never;
    const reg = new PluginRegistry(failingDeps.deps);
    reg.register(makePlugin('p@local'));

    await expect(reg.enable('p@local')).rejects.toThrow('mcp boom');

    // skills + hooks were unloaded (reverse order: hooks then skills)
    expect(failingDeps.calls.hookUnload).toEqual(['p@local']);
    expect(failingDeps.calls.skillUnload).toEqual(['p@local']);
    // agents/commands never loaded
    expect(failingDeps.calls.agentLoad).toEqual([]);

    const p = reg.getPlugin('p@local')!;
    expect(p.state.status).toBe('error');
    expect(p.loadErrors?.some((e) => e.type === 'generic-error')).toBe(true);
  });

  it('rollback failure is logged but does not mask the original error', async () => {
    const fd = makeDeps();
    fd.deps.mcpSlot = {
      load: vi.fn(async () => { throw new Error('original mcp failure'); }),
      unload: vi.fn(),
    } as never;
    // hook unload throws during rollback
    fd.deps.hookSlot = {
      load: vi.fn(() => []),
      unload: vi.fn(() => { throw new Error('rollback boom'); }),
      pruneRemovedPlugins: vi.fn(() => 0),
    } as never;
    const reg = new PluginRegistry(fd.deps);
    reg.register(makePlugin('p@local'));

    // The ORIGINAL error surfaces, not the rollback error
    await expect(reg.enable('p@local')).rejects.toThrow('original mcp failure');

    const p = reg.getPlugin('p@local')!;
    // both the original and the rollback failure recorded in loadErrors
    const causes = (p.loadErrors ?? []).map((e) =>
      e.type === 'component-load-failed' ? e.cause : e.type === 'generic-error' ? e.message : e.type,
    );
    expect(causes.some((c) => /rollback failed/.test(c))).toBe(true);
  });

  it('concurrent enable + disable on same id is serialized', async () => {
    registry.register(makePlugin('p@local'));
    const enableP = registry.enable('p@local');
    const disableP = registry.disable('p@local');
    await Promise.all([enableP, disableP]);
    // After serialized enable then disable, end state is disabled
    expect(registry.getPlugin('p@local')!.state.status).toBe('disabled');
  });
});

describe('PluginRegistry — bootstrap + reconcile + evicted', () => {
  it('bootstrapEnabledPlugins enables plugins flagged true in config', async () => {
    const ctx = makeDeps();
    ctx.enabledStore['a@local'] = true;
    ctx.enabledStore['b@local'] = false;
    const reg = new PluginRegistry(ctx.deps);
    reg.register(makePlugin('a@local'));
    reg.register(makePlugin('b@local'));

    const result = await reg.bootstrapEnabledPlugins();

    expect(reg.isEnabled('a@local')).toBe(true);
    expect(reg.isEnabled('b@local')).toBe(false);
    expect(result.enabled.map((p) => p.id)).toEqual(['a@local']);
  });

  it('reconcileFromConfig issues enable/disable from config diff', async () => {
    const ctx = makeDeps();
    const reg = new PluginRegistry(ctx.deps);
    reg.register(makePlugin('a@local'));
    await reg.enable('a@local');

    // External actor flips a@local off
    ctx.enabledStore['a@local'] = false;
    await reg.reconcileFromConfig();

    expect(reg.isEnabled('a@local')).toBe(false);
  });

  it('markEvicted blocks subsequent enable', async () => {
    const ctx = makeDeps();
    const reg = new PluginRegistry(ctx.deps);
    reg.register(makePlugin('a@local'));
    reg.markEvicted('a@local');
    await expect(reg.enable('a@local')).rejects.toThrow(/uninstalled/);
  });

  it('reload refuses when checkDestructiveOpAllowed returns a refusal', async () => {
    const ctx = makeDeps({
      checkDestructiveOpAllowed: () => '2 background tasks running',
    });
    const reg = new PluginRegistry(ctx.deps);
    await expect(reg.reload()).rejects.toThrow(/background tasks running/);
  });
});
