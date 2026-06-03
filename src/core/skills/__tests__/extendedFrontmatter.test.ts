import { describe, it, expect } from 'vitest';
import {
  parseSkillMd,
  normalizeFrontmatter,
  serializeToSkillMd,
  projectMeta,
  validateSkill,
} from '@/core/skills/SkillParser';
import { skillFrontmatterSchema } from '@/core/skills/types';
import type { Skill } from '@/core/skills/types';

const baseFrontmatter = (overrides: Record<string, unknown> = {}): string => {
  const defaults: Record<string, unknown> = {
    name: 'test-skill',
    description: 'A test skill',
  };
  const merged = { ...defaults, ...overrides };
  const lines = Object.entries(merged).map(([k, v]) => {
    if (typeof v === 'string' && (v.includes(':') || v.startsWith('*'))) {
      return `${k}: "${v}"`;
    }
    if (Array.isArray(v)) return `${k}: [${v.map((x) => `"${x}"`).join(', ')}]`;
    if (typeof v === 'object') return `${k}:\n${stringifyNestedObject(v as Record<string, unknown>, '  ')}`;
    return `${k}: ${v}`;
  });
  return ['---', ...lines, '---', '', '# Body', 'Skill body content here.'].join('\n');
};

function stringifyNestedObject(obj: Record<string, unknown>, indent: string): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      out.push(`${indent}${k}:`);
      for (const item of v) {
        if (typeof item === 'object' && item !== null) {
          const entries = Object.entries(item as Record<string, unknown>);
          out.push(`${indent}  - ${entries[0][0]}: ${entries[0][1]}`);
          for (let i = 1; i < entries.length; i++) {
            out.push(`${indent}    ${entries[i][0]}: ${JSON.stringify(entries[i][1])}`);
          }
        } else {
          out.push(`${indent}  - ${item}`);
        }
      }
    } else if (typeof v === 'object' && v !== null) {
      out.push(`${indent}${k}:`);
      out.push(stringifyNestedObject(v as Record<string, unknown>, indent + '  '));
    } else {
      out.push(`${indent}${k}: ${v}`);
    }
  }
  return out.join('\n');
}

describe('skillFrontmatterSchema — Track 03 extensions', () => {
  it('accepts when-to-use', () => {
    const result = skillFrontmatterSchema.safeParse({
      name: 'a',
      description: 'd',
      'when-to-use': 'When triggering deploys',
    });
    expect(result.success).toBe(true);
  });

  it('accepts effort as enum or integer', () => {
    expect(skillFrontmatterSchema.safeParse({ name: 'a', description: 'd', effort: 'high' }).success).toBe(true);
    expect(skillFrontmatterSchema.safeParse({ name: 'a', description: 'd', effort: 5000 }).success).toBe(true);
    expect(skillFrontmatterSchema.safeParse({ name: 'a', description: 'd', effort: 'absurd' }).success).toBe(false);
  });

  it('accepts model as alias or arbitrary string', () => {
    expect(skillFrontmatterSchema.safeParse({ name: 'a', description: 'd', model: 'opus' }).success).toBe(true);
    expect(skillFrontmatterSchema.safeParse({ name: 'a', description: 'd', model: 'claude-opus-4-7' }).success).toBe(true);
  });

  it('accepts domains as string or string[]', () => {
    expect(skillFrontmatterSchema.safeParse({ name: 'a', description: 'd', domains: 'gmail.com' }).success).toBe(true);
    expect(skillFrontmatterSchema.safeParse({ name: 'a', description: 'd', domains: ['a', 'b'] }).success).toBe(true);
  });

  it('accepts boolean-like strings for user-invocable / disable-model-invocation', () => {
    const r1 = skillFrontmatterSchema.safeParse({
      name: 'a',
      description: 'd',
      'user-invocable': 'true',
      'disable-model-invocation': 'false',
    });
    expect(r1.success).toBe(true);
  });

  it("rejects context: 'fork' without agent", () => {
    const r = skillFrontmatterSchema.safeParse({
      name: 'a',
      description: 'd',
      context: 'fork',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/agent/i);
    }
  });

  it("accepts context: 'fork' with agent", () => {
    const r = skillFrontmatterSchema.safeParse({
      name: 'a',
      description: 'd',
      context: 'fork',
      agent: 'general-purpose',
    });
    expect(r.success).toBe(true);
  });

  it("accepts context: 'inline' alone", () => {
    expect(
      skillFrontmatterSchema.safeParse({
        name: 'a',
        description: 'd',
        context: 'inline',
      }).success,
    ).toBe(true);
  });
});

describe('normalizeFrontmatter', () => {
  it('maps kebab-case YAML keys to camelCase', () => {
    const fields = normalizeFrontmatter({
      name: 'a',
      description: 'd',
      'when-to-use': 'on Tuesdays',
      'argument-hint': '<env>',
    });
    expect(fields.whenToUse).toBe('on Tuesdays');
    expect(fields.argumentHint).toBe('<env>');
  });

  it('applies defaults for context, userInvocable, disableModelInvocation', () => {
    const fields = normalizeFrontmatter({ name: 'a', description: 'd' });
    expect(fields.context).toBe('inline');
    expect(fields.userInvocable).toBe(true);
    expect(fields.disableModelInvocation).toBe(false);
  });

  it("coerces 'true'/'false' strings to booleans", () => {
    const fields = normalizeFrontmatter({
      name: 'a',
      description: 'd',
      'user-invocable': 'false',
      'disable-model-invocation': 'true',
    });
    expect(fields.userInvocable).toBe(false);
    expect(fields.disableModelInvocation).toBe(true);
  });

  it('normalizes domains: string → string[]', () => {
    const fields = normalizeFrontmatter({ name: 'a', description: 'd', domains: 'gmail.com' });
    expect(fields.domains).toEqual(['gmail.com']);
  });

  it('normalizes domains: string[] → copy', () => {
    const original = ['a', 'b'];
    const fields = normalizeFrontmatter({ name: 'a', description: 'd', domains: original });
    expect(fields.domains).toEqual(['a', 'b']);
    expect(fields.domains).not.toBe(original);
  });

  it('parses allowed-tools comma- and whitespace-separated', () => {
    const fields = normalizeFrontmatter({
      name: 'a',
      description: 'd',
      'allowed-tools': 'Bash, Read Edit',
    });
    expect(fields.allowedTools).toEqual(['Bash', 'Read', 'Edit']);
  });
});

describe('parseSkillMd round-trips extended fields', () => {
  it('parses model + effort + context + agent + domains', () => {
    const md = baseFrontmatter({
      model: 'opus',
      effort: 'high',
      context: 'fork',
      agent: 'general-purpose',
      domains: ['gmail.com', '*.google.com'],
    });
    const parsed = parseSkillMd(md);
    const fields = normalizeFrontmatter(parsed.frontmatter);
    expect(fields.model).toBe('opus');
    expect(fields.effort).toBe('high');
    expect(fields.context).toBe('fork');
    expect(fields.agent).toBe('general-purpose');
    expect(fields.domains).toEqual(['gmail.com', '*.google.com']);
  });

  it('validates fork agent values against injected known sub-agent types', () => {
    const parsed = parseSkillMd(baseFrontmatter({
      context: 'fork',
      agent: 'missing-agent',
    }));
    const result = validateSkill(parsed, undefined, { knownAgents: ['researcher', 'worker'] });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Unknown sub-agent type "missing-agent"/);
  });

  it('accepts fork agent values present in the injected known sub-agent types', () => {
    const parsed = parseSkillMd(baseFrontmatter({
      context: 'fork',
      agent: 'worker',
    }));
    const result = validateSkill(parsed, undefined, { knownAgents: ['researcher', 'worker'] });
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe('serializeToSkillMd writes extended fields', () => {
  const skill: Skill = {
    name: 'deploy',
    description: 'Deploy to env',
    body: 'Body content',
    invocationMode: 'manual',
    trusted: true,
    source: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    whenToUse: 'When ready to ship',
    argumentHint: '<env> [version]',
    model: 'opus',
    effort: 'high',
    context: 'fork',
    agent: 'general-purpose',
    domains: ['mail.google.com'],
    allowedTools: ['Bash', 'Read'],
    userInvocable: false,
    disableModelInvocation: true,
    version: '1.0.0',
  };

  it('emits all extended fields when present', () => {
    const md = serializeToSkillMd(skill);
    expect(md).toMatch(/when-to-use:/);
    expect(md).toMatch(/argument-hint:/);
    expect(md).toMatch(/model: opus/);
    expect(md).toMatch(/effort: high/);
    expect(md).toMatch(/context: fork/);
    expect(md).toMatch(/agent: general-purpose/);
    expect(md).toMatch(/domains:/);
    expect(md).toMatch(/user-invocable: false/);
    expect(md).toMatch(/disable-model-invocation: true/);
    expect(md).toMatch(/version: 1\.0\.0/);
  });

  it('emits domains as string when single, array when multiple', () => {
    const single = serializeToSkillMd({ ...skill, domains: ['gmail.com'] });
    expect(single).toMatch(/domains: gmail\.com\b/);
    const multi = serializeToSkillMd({ ...skill, domains: ['a', 'b'] });
    expect(multi).toMatch(/domains:[\s\S]*- a[\s\S]*- b/);
  });

  it('omits inline context (default) from output', () => {
    const md = serializeToSkillMd({
      ...skill,
      context: 'inline',
      agent: undefined,
      domains: undefined,
      userInvocable: undefined,
      disableModelInvocation: undefined,
    });
    expect(md).not.toMatch(/context:/);
  });

  it('round-trips: parse → normalize → serialize → parse', () => {
    const md1 = serializeToSkillMd(skill);
    const parsed = parseSkillMd(md1);
    const fields = normalizeFrontmatter(parsed.frontmatter);
    expect(fields.model).toBe('opus');
    expect(fields.effort).toBe('high');
    expect(fields.context).toBe('fork');
    expect(fields.agent).toBe('general-purpose');
    expect(fields.domains).toEqual(['mail.google.com']);
    expect(fields.userInvocable).toBe(false);
    expect(fields.disableModelInvocation).toBe(true);
  });
});

describe('projectMeta', () => {
  it('includes core + Track 03 SkillMeta fields', () => {
    const skill: Skill = {
      name: 'a',
      description: 'd',
      body: 'b',
      invocationMode: 'auto',
      trusted: false,
      source: 'imported',
      createdAt: 'now',
      updatedAt: 'now',
      whenToUse: 'now',
      argumentHint: '<x>',
      context: 'fork',
      agent: 'general-purpose',
      domains: ['gmail.com'],
      userInvocable: false,
      disableModelInvocation: true,
    };
    const meta = projectMeta(skill);
    expect(meta).toEqual({
      name: 'a',
      description: 'd',
      invocationMode: 'auto',
      trusted: false,
      source: 'imported',
      whenToUse: 'now',
      argumentHint: '<x>',
      context: 'fork',
      agent: 'general-purpose',
      domains: ['gmail.com'],
      userInvocable: false,
      disableModelInvocation: true,
    });
  });

  it('omits undefined extended fields', () => {
    const skill: Skill = {
      name: 'a',
      description: 'd',
      body: 'b',
      invocationMode: 'manual',
      trusted: true,
      source: 'user',
      createdAt: 'now',
      updatedAt: 'now',
    };
    const meta = projectMeta(skill);
    expect(meta.whenToUse).toBeUndefined();
    expect(meta.domains).toBeUndefined();
    expect(meta.context).toBeUndefined();
  });
});
