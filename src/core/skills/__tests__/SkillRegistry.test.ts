import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../SkillRegistry';
import type { ISkillProvider } from '../SkillProvider';
import type { SkillMeta } from '../types';

function makeMeta(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: 'test-skill',
    description: 'Test skill',
    invocationMode: 'auto',
    trusted: true,
    source: 'user',
    ...overrides,
  };
}

function makeProvider(metas: SkillMeta[]): ISkillProvider {
  return {
    initialize: async () => {},
    listMeta: async () => metas,
    load: async () => null,
    loadReference: async () => null,
    save: async () => {},
    delete: async () => {},
    exists: async () => false,
    exportAsSkillMd: async () => null,
  };
}

describe('SkillRegistry.buildSkillsSystemPrompt', () => {
  it('returns an empty prompt when no skills have been discovered', () => {
    const registry = new SkillRegistry(makeProvider([]));

    expect(registry.buildSkillsSystemPrompt()).toBe('');
  });

  it('includes anti-guessing guidance when skills are available', async () => {
    const registry = new SkillRegistry(makeProvider([makeMeta()]));
    await registry.discover();

    const prompt = registry.buildSkillsSystemPrompt();

    expect(prompt).toContain('Do not guess skill names');
    expect(prompt).toContain('If no listed skill fits, proceed with normal tools');
  });

  it('lists trusted auto-invocable skills for proactive use', async () => {
    const registry = new SkillRegistry(makeProvider([
      makeMeta({ name: 'auto-skill', description: 'Runs automatically', invocationMode: 'auto', trusted: true }),
      makeMeta({ name: 'manual-skill', description: 'Manual only', invocationMode: 'manual', trusted: true }),
      makeMeta({ name: 'untrusted-skill', description: 'Untrusted', invocationMode: 'auto', trusted: false }),
    ]));
    await registry.discover();

    const prompt = registry.buildSkillsSystemPrompt();

    expect(prompt).toContain('Available skills for proactive use');
    expect(prompt).toContain('- auto-skill: Runs automatically');
    expect(prompt).not.toContain('manual-skill');
    expect(prompt).not.toContain('untrusted-skill');
  });
});
