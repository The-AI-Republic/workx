import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../SkillRegistry';
import { SessionSkillView } from '../SessionSkillView';
import { matchesDomain } from '../SkillDomainFilter';
import type { ISkillProvider } from '../SkillProvider';
import type { SkillMeta } from '../types';

function skill(name: string, domains?: string[]): SkillMeta {
  return {
    name,
    description: `${name} description`,
    invocationMode: 'auto',
    trusted: true,
    source: 'user',
    domains,
  };
}

function provider(metas: SkillMeta[]): ISkillProvider {
  return {
    initialize: async () => undefined,
    listMeta: async () => metas,
    load: async () => null,
    loadReference: async () => null,
    save: async () => undefined,
    delete: async () => undefined,
    exists: async () => false,
    exportAsSkillMd: async () => null,
  };
}

describe('SessionSkillView', () => {
  it('projects different prompts for simultaneous session browser contexts', async () => {
    const registry = new SkillRegistry(provider([
      skill('always'),
      skill('gmail', ['mail.google.com']),
      skill('github', ['*.github.com']),
    ]));
    await registry.discover();
    const gmail = new SessionSkillView(registry, async () => 'mail.google.com');
    const github = new SessionSkillView(registry, async () => 'app.github.com');
    expect((await gmail.getVisibleMetas()).map((meta) => meta.name)).toEqual(['always', 'gmail']);
    expect((await github.getVisibleMetas()).map((meta) => meta.name)).toEqual(['always', 'github']);
    expect(await gmail.buildSystemPrompt()).not.toContain('github description');
    expect(await github.buildSystemPrompt()).not.toContain('gmail description');
  });

  it('advertises only unconditional skills without a session browser context', async () => {
    const registry = new SkillRegistry(provider([skill('always'), skill('site', ['example.com'])]));
    await registry.discover();
    expect((await new SessionSkillView(registry, async () => null).getVisibleMetas())
      .map((meta) => meta.name)).toEqual(['always']);
  });

  it('matches exact and one-segment wildcard hosts case-insensitively', () => {
    expect(matchesDomain('MAIL.Google.com', '*.google.com')).toBe(true);
    expect(matchesDomain('deep.mail.google.com', '*.google.com')).toBe(false);
    expect(matchesDomain('google.com', '*.google.com')).toBe(false);
    expect(matchesDomain('google.com', 'GOOGLE.COM')).toBe(true);
  });
});
