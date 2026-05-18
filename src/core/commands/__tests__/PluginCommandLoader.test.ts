/**
 * Track 10: PluginCommandLoader storage shape.
 *
 * Verifies the plugin-port basics:
 *  - add/removeByPluginId scoped behavior
 *  - load() returns the flat union
 *  - cross-source precedence still works through CommandLoader (builtin > skill > plugin)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PluginCommandLoader } from '../loaders/PluginCommandLoader';
import { CommandLoader } from '../CommandLoader';
import type { Command, PromptCommand } from '../types';

function fakePromptCommand(name: string, loadedFrom: 'builtin' | 'skill' | 'plugin' = 'plugin'): PromptCommand {
  return {
    type: 'prompt',
    name,
    description: `desc ${name}`,
    loadedFrom,
    userInvocable: true,
    disableModelInvocation: false,
    context: 'inline',
    async getPromptForCommand() {
      return `body ${name}`;
    },
  };
}

describe('PluginCommandLoader', () => {
  let loader: PluginCommandLoader;

  beforeEach(() => {
    loader = new PluginCommandLoader();
  });

  it('add stores commands under a pluginId', () => {
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd1'), fakePromptCommand('plugin-a:cmd2')]);
    const all = loader.load();
    expect(all.map((c) => c.name).sort()).toEqual(['plugin-a:cmd1', 'plugin-a:cmd2']);
  });

  it('add is idempotent — second call with same pluginId replaces the entries', () => {
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd1')]);
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd2')]);
    const names = loader.load().map((c) => c.name);
    expect(names).toEqual(['plugin-a:cmd2']);
  });

  it('removeByPluginId removes only the matching plugin', () => {
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd1')]);
    loader.add('plugin-b', [fakePromptCommand('plugin-b:cmd1')]);
    loader.removeByPluginId('plugin-a');
    expect(loader.load().map((c) => c.name)).toEqual(['plugin-b:cmd1']);
  });

  it('removeByPluginId is no-op for unknown id', () => {
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd1')]);
    loader.removeByPluginId('not-a-real-plugin');
    expect(loader.load()).toHaveLength(1);
  });

  it('hasAny / getPluginIds reflect current state', () => {
    expect(loader.hasAny()).toBe(false);
    loader.add('plugin-a', []);
    loader.add('plugin-b', []);
    expect(loader.hasAny()).toBe(true);
    expect(loader.getPluginIds().sort()).toEqual(['plugin-a', 'plugin-b']);
  });
});

describe('CommandLoader + PluginCommandLoader integration', () => {
  it('cross-source precedence: builtin shadows skill shadows plugin for same bare name', () => {
    // All three contribute a command named "help"
    const builtin = {
      load: () => [fakePromptCommand('help', 'builtin')],
    };
    const skill = {
      load: () => [fakePromptCommand('help', 'skill')],
    };
    const plugin = new PluginCommandLoader();
    plugin.add('plugin-a', [fakePromptCommand('help', 'plugin')]);

    const loader = new CommandLoader({
      builtin: builtin as unknown as ConstructorParameters<typeof CommandLoader>[0]['builtin'],
      skill: skill as unknown as ConstructorParameters<typeof CommandLoader>[0]['skill'],
      plugin,
    });

    const all = loader.loadAll();
    const help = all.find((c) => c.name === 'help');
    expect(help).toBeDefined();
    expect(help?.loadedFrom).toBe('builtin');
  });

  it('plugin commands are visible when their names do not collide with builtin/skill', () => {
    const plugin = new PluginCommandLoader();
    plugin.add('plugin-a', [
      fakePromptCommand('plugin-a:unique-1', 'plugin'),
      fakePromptCommand('plugin-a:unique-2', 'plugin'),
    ]);

    const loader = new CommandLoader({ plugin });
    const names = loader.loadAll().map((c) => c.name).sort();
    expect(names).toEqual(['plugin-a:unique-1', 'plugin-a:unique-2']);
  });
});
