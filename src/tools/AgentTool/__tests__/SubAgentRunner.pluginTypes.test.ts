/**
 * Track 10: runtime sub-agent type registration (addType / removeByPluginId).
 *
 * Verifies the plugin-port shape on SubAgentRunner without going through the
 * actual ToolRegistry — we just check that:
 *  - addType + removeByPluginId mutate `types` correctly
 *  - the types-changed callback fires on runtime changes
 *  - builtin and config-sourced types are NOT removed by removeByPluginId
 *  - invalid configs are rejected (throws)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentRunner } from '../SubAgentRunner';
import { SubAgentRegistry } from '../SubAgentRegistry';
import { BUILTIN_SUBAGENT_TYPES } from '../builtinTypes';
import type { SubAgentTypeConfig } from '../types';

function makeMockEngine() {
  return {
    engineId: 'parent-engine',
    enqueueSyntheticUserTurn: vi.fn(),
    pushEvent: vi.fn(),
    getDepth: () => 0,
    getMaxDepth: () => 8,
    getToolRegistry: () => ({
      getApprovalGate: () => undefined,
      entries: () => [],
    }),
    getConfig: () => ({ model: 'gpt-4', browserContext: undefined }),
    getSession: () => ({
      getTurnContext: () => ({ getApprovalPolicy: () => 'on-request' }),
    }),
    createChildEngine: () => ({
      initialize: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ success: true, response: 'ok', turnCount: 1, stopReason: 'completed' })),
      dispose: vi.fn(async () => undefined),
    }),
    onEvent: vi.fn(() => () => undefined),
  };
}

function makeType(id: string, name = `Type ${id}`): SubAgentTypeConfig {
  return {
    id,
    name,
    description: `desc ${id}`,
    systemPrompt: `sys ${id}`,
  };
}

describe('SubAgentRunner — Track 10 runtime type registration', () => {
  let runner: SubAgentRunner;
  let callbackSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runner = new SubAgentRunner({
      parentEngine: makeMockEngine() as unknown as ConstructorParameters<typeof SubAgentRunner>[0]['parentEngine'],
      registry: new SubAgentRegistry(),
    });
    callbackSpy = vi.fn(async () => undefined);
    runner.setTypesChangedCallback(callbackSpy);
  });

  it('addType adds a plugin-sourced type and fires callback', async () => {
    const cfg = makeType('plugin-a:reviewer');
    await runner.addType(cfg, { type: 'plugin', pluginId: 'plugin-a' });

    expect(runner.getTypes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'plugin-a:reviewer' }),
      ]),
    );
    expect(callbackSpy).toHaveBeenCalledTimes(1);
  });

  it('removeByPluginId removes only matching plugin types', async () => {
    await runner.addType(makeType('plugin-a:t1'), { type: 'plugin', pluginId: 'plugin-a' });
    await runner.addType(makeType('plugin-a:t2'), { type: 'plugin', pluginId: 'plugin-a' });
    await runner.addType(makeType('plugin-b:t1'), { type: 'plugin', pluginId: 'plugin-b' });
    callbackSpy.mockClear();

    await runner.removeByPluginId('plugin-a');

    const ids = runner.getTypes().map((t) => t.id);
    expect(ids).not.toContain('plugin-a:t1');
    expect(ids).not.toContain('plugin-a:t2');
    expect(ids).toContain('plugin-b:t1');
    expect(callbackSpy).toHaveBeenCalledTimes(1);
  });

  it('removeByPluginId does not touch builtin or config-sourced types', async () => {
    const builtinIds = BUILTIN_SUBAGENT_TYPES.map((t) => t.id);
    await runner.addType(makeType('plugin-x:custom'), { type: 'plugin', pluginId: 'plugin-x' });

    await runner.removeByPluginId('plugin-x');

    const remainingIds = runner.getTypes().map((t) => t.id);
    for (const id of builtinIds) {
      expect(remainingIds).toContain(id);
    }
    expect(remainingIds).not.toContain('plugin-x:custom');
  });

  it('removeByPluginId for an unknown plugin is a no-op (no callback)', async () => {
    callbackSpy.mockClear();
    await runner.removeByPluginId('never-registered');
    expect(callbackSpy).not.toHaveBeenCalled();
  });

  it('addType throws on invalid config and does not mutate state', async () => {
    const initialIds = new Set(runner.getTypes().map((t) => t.id));
    await expect(
      runner.addType({ id: '' } as unknown as SubAgentTypeConfig, { type: 'plugin', pluginId: 'p' }),
    ).rejects.toThrow();
    const afterIds = new Set(runner.getTypes().map((t) => t.id));
    expect(afterIds).toEqual(initialIds);
  });

  it('addType replaces an existing type with the same id', async () => {
    await runner.addType(makeType('plugin-a:t1', 'Original'), { type: 'plugin', pluginId: 'plugin-a' });
    await runner.addType(makeType('plugin-a:t1', 'Updated'), { type: 'plugin', pluginId: 'plugin-a' });

    const matching = runner.getTypes().filter((t) => t.id === 'plugin-a:t1');
    expect(matching).toHaveLength(1);
    expect(matching[0].name).toBe('Updated');
  });

  it('a plugin cannot register an id held by a builtin (throws, builtin survives)', async () => {
    const builtinId = BUILTIN_SUBAGENT_TYPES[0].id;
    await expect(
      runner.addType(makeType(builtinId), { type: 'plugin', pluginId: 'evil' }),
    ).rejects.toThrow(/already held by a builtin/);

    // Builtin still present and untouched; nothing tracked for the plugin.
    expect(runner.getTypes().map((t) => t.id)).toContain(builtinId);
    await runner.removeByPluginId('evil');
    expect(runner.getTypes().map((t) => t.id)).toContain(builtinId);
  });

  it('two plugins cannot register the same type id', async () => {
    await runner.addType(makeType('shared:t1'), { type: 'plugin', pluginId: 'plugin-a' });
    await expect(
      runner.addType(makeType('shared:t1'), { type: 'plugin', pluginId: 'plugin-b' }),
    ).rejects.toThrow(/already owned by plugin 'plugin-a'/);

    // plugin-a still owns it; disabling plugin-b leaves it intact.
    await runner.removeByPluginId('plugin-b');
    expect(runner.getTypes().map((t) => t.id)).toContain('shared:t1');
    // Disabling plugin-a (the real owner) removes it.
    await runner.removeByPluginId('plugin-a');
    expect(runner.getTypes().map((t) => t.id)).not.toContain('shared:t1');
  });
});

describe('SubAgentRunner — Track 10 deferred-rebuild guard', () => {
  function makeEngineWithActiveTasks(activeTasks: unknown[]) {
    return {
      engineId: 'parent-engine',
      getToolRegistry: () => ({ getApprovalGate: () => undefined, entries: () => [] }),
      getConfig: () => ({ model: 'gpt-4' }),
      getSession: () => ({
        getTurnContext: () => ({ getApprovalPolicy: () => 'on-request' }),
        listActiveTasks: () => activeTasks,
      }),
      onEvent: vi.fn(() => () => undefined),
    };
  }

  it('rebuilds eagerly when no tasks are active', async () => {
    const runner = new SubAgentRunner({
      parentEngine: makeEngineWithActiveTasks([]) as unknown as ConstructorParameters<typeof SubAgentRunner>[0]['parentEngine'],
      registry: new SubAgentRegistry(),
    });
    const cb = vi.fn(async () => undefined);
    runner.setTypesChangedCallback(cb);

    await runner.addType(makeType('p:a'), { type: 'plugin', pluginId: 'p' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('defers rebuild while a task is active; type is still added immediately', async () => {
    const runner = new SubAgentRunner({
      parentEngine: makeEngineWithActiveTasks([{ id: 'task-1' }]) as unknown as ConstructorParameters<typeof SubAgentRunner>[0]['parentEngine'],
      registry: new SubAgentRegistry(),
    });
    const cb = vi.fn(async () => undefined);
    runner.setTypesChangedCallback(cb);

    await runner.addType(makeType('p:a'), { type: 'plugin', pluginId: 'p' });

    // Type is in the map right away (run() resolves it at dispatch)
    expect(runner.getTypes().some((t) => t.id === 'p:a')).toBe(true);
    // ...but the LLM-visible rebuild is deferred
    expect(cb).not.toHaveBeenCalled();
  });
});
