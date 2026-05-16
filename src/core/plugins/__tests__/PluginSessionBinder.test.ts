/**
 * Track 10: PluginSessionBinder + PluginRegistry binder-tracking.
 *
 * Verifies the per-session propagation contract:
 *  - binder applies enabled plugins' hook + agent slots at session creation
 *  - PluginRegistry.disable prunes every live binder immediately
 *  - PluginRegistry.enable does NOT retro-inject existing binders
 *    (claudy asymmetry — new-plugin hooks wait for new session / reload)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginSessionBinder } from '../PluginSessionBinder';
import { PluginRegistry } from '../PluginRegistry';
import type { PluginRegistryDeps } from '../PluginRegistry';
import type { LoadedPlugin } from '../types';
import { HookRegistry } from '@/core/hooks/HookRegistry';

function makePlugin(name: string, withHooks = true, withAgents = false): LoadedPlugin {
  return {
    id: `${name}@local`,
    manifest: {
      name,
      version: '1.0.0',
      ...(withHooks
        ? { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } as never }
        : {}),
      ...(withAgents ? { agents: './agents' } : {}),
    },
    path: `/plugins/${name}`,
    source: { type: 'path', path: `/plugins/${name}` },
    scope: 'user',
    state: { status: 'enabled', enabledAt: Date.now(), activeSlots: ['hooks'] },
  };
}

function makeRunner() {
  return {
    addType: vi.fn(async () => undefined),
    removeByPluginId: vi.fn(async () => undefined),
  };
}

describe('PluginSessionBinder', () => {
  let hookRegistry: HookRegistry;
  let runner: ReturnType<typeof makeRunner>;
  let binder: PluginSessionBinder;

  beforeEach(() => {
    hookRegistry = new HookRegistry();
    runner = makeRunner();
    binder = new PluginSessionBinder({
      hookRegistry,
      subAgentRunner: runner as never,
      readFile: async () => null,
      listDirs: async () => [],
    });
  });

  it('applyEnabledPlugins registers hooks into the session HookRegistry', async () => {
    await binder.applyEnabledPlugins([makePlugin('alpha')]);
    expect(hookRegistry.hasHooksFor('PreToolUse')).toBe(true);
    const hooks = hookRegistry.getMatchingHooks('PreToolUse', 'Bash');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].source).toEqual({ type: 'plugin', pluginId: 'alpha@local' });
  });

  it('unloadPlugin removes that plugin hooks from the session', async () => {
    await binder.applyEnabledPlugins([makePlugin('alpha'), makePlugin('beta')]);
    expect(hookRegistry.getMatchingHooks('PreToolUse', 'Bash')).toHaveLength(2);

    await binder.unloadPlugin('alpha@local');
    const remaining = hookRegistry.getMatchingHooks('PreToolUse', 'Bash');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source).toEqual({ type: 'plugin', pluginId: 'beta@local' });
  });

  it('unloadPlugin for an unapplied id is a no-op', async () => {
    await binder.unloadPlugin('never@local');
    expect(hookRegistry.hasHooksFor('PreToolUse')).toBe(false);
  });

  it('dispose drops every applied plugin contribution', async () => {
    await binder.applyEnabledPlugins([makePlugin('alpha'), makePlugin('beta')]);
    await binder.dispose();
    expect(hookRegistry.hasHooksFor('PreToolUse')).toBe(false);
  });

  it('agent slot delegates to subAgentRunner.removeByPluginId on unload', async () => {
    const withAgent = makePlugin('gamma', false, true);
    await binder.applyPlugin(withAgent);
    await binder.unloadPlugin('gamma@local');
    expect(runner.removeByPluginId).toHaveBeenCalledWith('gamma@local');
  });
});

describe('PluginRegistry — session-binder propagation', () => {
  function makeRegistry() {
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
    return new PluginRegistry(deps);
  }

  it('disable prunes every live binder immediately', async () => {
    const registry = makeRegistry();
    registry.register(makePlugin('alpha'));
    await registry.enable('alpha@local');

    const b1 = { unloadPlugin: vi.fn(async () => undefined) };
    const b2 = { unloadPlugin: vi.fn(async () => undefined) };
    registry.registerSessionBinder(b1);
    registry.registerSessionBinder(b2);

    await registry.disable('alpha@local');

    expect(b1.unloadPlugin).toHaveBeenCalledWith('alpha@local');
    expect(b2.unloadPlugin).toHaveBeenCalledWith('alpha@local');
  });

  it('enable does NOT retro-inject existing binders (claudy asymmetry)', async () => {
    const registry = makeRegistry();
    registry.register(makePlugin('beta'));

    const binder = { unloadPlugin: vi.fn(async () => undefined) };
    registry.registerSessionBinder(binder);

    await registry.enable('beta@local');

    // enable touches global slots only; existing binders are untouched
    // (new-plugin hooks wait for a new session or /plugin reload)
    expect(binder.unloadPlugin).not.toHaveBeenCalled();
  });

  it('registerSessionBinder returns an unregister fn', async () => {
    const registry = makeRegistry();
    registry.register(makePlugin('gamma'));
    await registry.enable('gamma@local');

    const binder = { unloadPlugin: vi.fn(async () => undefined) };
    const unregister = registry.registerSessionBinder(binder);
    unregister();

    await registry.disable('gamma@local');
    expect(binder.unloadPlugin).not.toHaveBeenCalled();
  });
});
