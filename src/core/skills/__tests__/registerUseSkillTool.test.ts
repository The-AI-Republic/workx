import { describe, expect, it, vi } from 'vitest';
import { HookRegistry } from '@/core/hooks/HookRegistry';
import { ToolRegistry } from '@/tools/ToolRegistry';
import type { ISkillProvider } from '../SkillProvider';
import { SkillRegistry } from '../SkillRegistry';
import { registerUseSkillTool } from '../registerUseSkillTool';
import type { Skill, SkillMeta } from '../types';

function createSkill(name: string, domains?: string[]): Skill {
  return {
    name,
    description: `${name} description`,
    body: `${name} body`,
    invocationMode: 'auto',
    trusted: true,
    source: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    domains,
  };
}

function createProvider(skills: Skill[]): ISkillProvider {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    initialize: async () => undefined,
    listMeta: async () => skills.map((skill): SkillMeta => ({
      name: skill.name,
      description: skill.description,
      invocationMode: skill.invocationMode,
      trusted: skill.trusted,
      source: skill.source,
      domains: skill.domains,
    })),
    load: async (name) => byName.get(name) ?? null,
    loadReference: async () => null,
    save: async () => undefined,
    delete: async () => undefined,
    exists: async (name) => byName.has(name),
    exportAsSkillMd: async () => null,
  };
}

async function setup(skills: Skill[], getCurrentDomain = vi.fn<() => Promise<string | null>>()) {
  const skillRegistry = new SkillRegistry(createProvider(skills));
  await skillRegistry.discover();
  const toolRegistry = new ToolRegistry();
  await registerUseSkillTool({
    toolRegistry,
    hookRegistry: new HookRegistry(),
    skillRegistry,
    getCurrentDomain,
  });
  return { toolRegistry, getCurrentDomain };
}

async function invoke(toolRegistry: ToolRegistry, name: string) {
  return toolRegistry.execute({
    toolName: 'use_skill',
    parameters: { name },
    sessionId: 'session-1',
    turnId: 'turn-1',
  });
}

describe('registerUseSkillTool domain boundary', () => {
  it('does not read browser context for an unconditional skill', async () => {
    const { toolRegistry, getCurrentDomain } = await setup([createSkill('always')]);

    const response = await invoke(toolRegistry, 'always');

    expect(response.success).toBe(true);
    expect(response.data).toBe('always body');
    expect(getCurrentDomain).not.toHaveBeenCalled();
  });

  it('reads browser context once after a domain-scoped skill tool call', async () => {
    const getCurrentDomain = vi.fn(async () => 'mail.google.com');
    const { toolRegistry } = await setup(
      [createSkill('gmail', ['mail.google.com'])],
      getCurrentDomain,
    );

    const response = await invoke(toolRegistry, 'gmail');

    expect(response.success).toBe(true);
    expect(response.data).toBe('gmail body');
    expect(getCurrentDomain).toHaveBeenCalledTimes(1);
  });

  it('rejects a domain-scoped skill when the active page does not match', async () => {
    const getCurrentDomain = vi.fn(async () => 'github.com');
    const { toolRegistry } = await setup(
      [createSkill('gmail', ['mail.google.com'])],
      getCurrentDomain,
    );

    const response = await invoke(toolRegistry, 'gmail');

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      error: expect.stringContaining('not available on github.com'),
    });
    expect(getCurrentDomain).toHaveBeenCalledTimes(1);
  });
});
