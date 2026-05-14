import { describe, it, expect } from 'vitest';
import { CommandLoader } from '@/core/commands/CommandLoader';
import { BuiltinCommandLoader } from '@/core/commands/loaders/BuiltinCommandLoader';
import { SkillCommandLoader } from '@/core/commands/loaders/SkillCommandLoader';
import { precedenceOf, SOURCE_PRECEDENCE } from '@/core/commands/precedence';
import type { Command, LocalCommand, PromptCommand } from '@/core/commands/types';
import type { SkillRegistry } from '@/core/skills/SkillRegistry';
import type { SkillMeta } from '@/core/skills/types';

function makeSkillRegistry(metas: SkillMeta[]): SkillRegistry {
  return {
    getSkillMetas: () => metas,
    invoke: async (name: string) => `body for ${name}`,
  } as unknown as SkillRegistry;
}

function makeBuiltinSource(items: Array<{ name: string; description: string; argumentHint?: string }>) {
  return {
    list: () => items.map((it) => ({ ...it, action: () => undefined })),
  };
}

const meta = (overrides: Partial<SkillMeta>): SkillMeta => ({
  name: overrides.name ?? 'test-skill',
  description: overrides.description ?? 'Test skill',
  invocationMode: overrides.invocationMode ?? 'manual',
  trusted: overrides.trusted ?? true,
  source: overrides.source ?? 'user',
});

describe('precedence', () => {
  it('orders builtin before skill before plugin', () => {
    expect(precedenceOf('builtin')).toBeLessThan(precedenceOf('skill'));
    expect(precedenceOf('skill')).toBeLessThan(precedenceOf('plugin'));
  });

  it('exposes the canonical SOURCE_PRECEDENCE array', () => {
    expect(SOURCE_PRECEDENCE).toEqual(['builtin', 'skill', 'plugin']);
  });
});

describe('CommandLoader.dedupeByName', () => {
  it('keeps the higher-precedence command on name collision', () => {
    const builtin: LocalCommand = {
      type: 'local',
      name: 'help',
      description: 'Builtin help',
      loadedFrom: 'builtin',
      action: () => undefined,
    };
    const skill: PromptCommand = {
      type: 'prompt',
      name: 'help',
      description: 'Skill that shadows help',
      loadedFrom: 'skill',
      getPromptForCommand: async () => 'body',
    };
    const result = CommandLoader.dedupeByName([skill, builtin]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(builtin);
  });

  it('preserves both when names differ', () => {
    const a: LocalCommand = {
      type: 'local',
      name: 'new',
      description: 'New conv',
      loadedFrom: 'builtin',
      action: () => undefined,
    };
    const b: PromptCommand = {
      type: 'prompt',
      name: 'review',
      description: 'Review skill',
      loadedFrom: 'skill',
      getPromptForCommand: async () => 'body',
    };
    expect(CommandLoader.dedupeByName([a, b])).toHaveLength(2);
  });

  it('treats names case-insensitively', () => {
    const a: LocalCommand = {
      type: 'local',
      name: 'help',
      description: 'lower',
      loadedFrom: 'builtin',
      action: () => undefined,
    };
    const b: LocalCommand = {
      type: 'local',
      name: 'HELP',
      description: 'upper',
      loadedFrom: 'skill',
      action: () => undefined,
    };
    expect(CommandLoader.dedupeByName([a, b])).toHaveLength(1);
  });

  it('drops commands whose isEnabled() returns false', () => {
    const enabled: LocalCommand = {
      type: 'local',
      name: 'a',
      description: '',
      loadedFrom: 'builtin',
      isEnabled: () => true,
      action: () => undefined,
    };
    const disabled: LocalCommand = {
      type: 'local',
      name: 'b',
      description: '',
      loadedFrom: 'builtin',
      isEnabled: () => false,
      action: () => undefined,
    };
    const result = CommandLoader.dedupeByName([enabled, disabled]);
    expect(result.map((c) => c.name)).toEqual(['a']);
  });
});

describe('CommandLoader.loadAll', () => {
  it('aggregates builtin + skill loaders', () => {
    const builtinLoader = new BuiltinCommandLoader(
      makeBuiltinSource([{ name: 'new', description: 'New' }]),
    );
    const skillLoader = new SkillCommandLoader(
      makeSkillRegistry([meta({ name: 'review' })]),
    );
    const loader = new CommandLoader({ builtin: builtinLoader, skill: skillLoader });
    const all = loader.loadAll();
    expect(all.map((c) => c.name).sort()).toEqual(['new', 'review']);
    expect(all.find((c) => c.name === 'new')!.type).toBe('local');
    expect(all.find((c) => c.name === 'review')!.type).toBe('prompt');
  });

  it('builtin wins over same-named skill (source precedence)', () => {
    const builtinLoader = new BuiltinCommandLoader(
      makeBuiltinSource([{ name: 'help', description: 'Builtin help' }]),
    );
    const skillLoader = new SkillCommandLoader(
      makeSkillRegistry([meta({ name: 'help', description: 'Skill help' })]),
    );
    const loader = new CommandLoader({ builtin: builtinLoader, skill: skillLoader });
    const all = loader.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe('Builtin help');
    expect(all[0].loadedFrom).toBe('builtin');
  });
});

describe('CommandLoader filters', () => {
  const builtin: LocalCommand = {
    type: 'local',
    name: 'help',
    description: '',
    loadedFrom: 'builtin',
    action: () => undefined,
  };
  const promptInvocable: PromptCommand = {
    type: 'prompt',
    name: 'review',
    description: '',
    loadedFrom: 'skill',
    getPromptForCommand: async () => 'body',
  };
  const promptModelOnly: PromptCommand = {
    type: 'prompt',
    name: 'auto',
    description: '',
    loadedFrom: 'skill',
    userInvocable: false,
    getPromptForCommand: async () => 'body',
  };
  const promptHidden: PromptCommand = {
    type: 'prompt',
    name: 'secret',
    description: '',
    loadedFrom: 'skill',
    isHidden: true,
    getPromptForCommand: async () => 'body',
  };
  const promptUserOnly: PromptCommand = {
    type: 'prompt',
    name: 'manual',
    description: '',
    loadedFrom: 'skill',
    disableModelInvocation: true,
    getPromptForCommand: async () => 'body',
  };
  const all: Command[] = [builtin, promptInvocable, promptModelOnly, promptHidden, promptUserOnly];

  it('getModelInvocable returns prompt commands minus hidden / disableModelInvocation', () => {
    const result = CommandLoader.getModelInvocable(all).map((c) => c.name);
    expect(result.sort()).toEqual(['auto', 'review']);
  });

  it('getUserInvocable returns commands minus userInvocable=false / hidden', () => {
    const result = CommandLoader.getUserInvocable(all).map((c) => c.name);
    expect(result.sort()).toEqual(['help', 'manual', 'review']);
  });
});

describe('SkillCommandLoader', () => {
  it('lazy-loads skill body via getPromptForCommand', async () => {
    const reg = makeSkillRegistry([meta({ name: 'deploy' })]);
    const loader = new SkillCommandLoader(reg);
    const cmds = loader.load();
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0] as PromptCommand;
    expect(cmd.type).toBe('prompt');
    const body = await cmd.getPromptForCommand('production');
    expect(body).toBe('body for deploy');
  });

  it('throws if skill body returns null', async () => {
    const reg = {
      getSkillMetas: () => [meta({ name: 'broken' })],
      invoke: async () => null,
    } as unknown as SkillRegistry;
    const loader = new SkillCommandLoader(reg);
    const cmd = loader.load()[0] as PromptCommand;
    await expect(cmd.getPromptForCommand('')).rejects.toThrow(/not found/);
  });
});
