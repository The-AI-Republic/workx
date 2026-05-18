import { describe, expect, it, beforeEach } from 'vitest';
import { PluginCommandLoader } from '../PluginCommandLoader';
import type { PluginPromptCommand } from '../PluginCommandLoader';

function fakePromptCommand(name: string): PluginPromptCommand {
  return {
    type: 'prompt',
    name,
    description: `${name} description`,
    loadedFrom: 'plugin',
    getPromptForCommand: async () => `${name} prompt`,
  };
}

describe('PluginCommandLoader', () => {
  let loader: PluginCommandLoader;

  beforeEach(() => {
    loader = new PluginCommandLoader();
  });

  it('stores commands by plugin id', () => {
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd1'), fakePromptCommand('plugin-a:cmd2')]);
    expect(loader.load().map((c) => c.name)).toEqual(['plugin-a:cmd1', 'plugin-a:cmd2']);
  });

  it('replaces commands for the same plugin id', () => {
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd1')]);
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd2')]);
    expect(loader.load().map((c) => c.name)).toEqual(['plugin-a:cmd2']);
  });

  it('removes commands by plugin id only', () => {
    loader.add('plugin-a', [fakePromptCommand('plugin-a:cmd1')]);
    loader.add('plugin-b', [fakePromptCommand('plugin-b:cmd1')]);
    loader.removeByPluginId('plugin-a');
    expect(loader.load().map((c) => c.name)).toEqual(['plugin-b:cmd1']);
  });
});
