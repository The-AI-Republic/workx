import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  skillFrontmatterSchema,
  skillSchema,
} from './types';
import type {
  ParsedSkill,
  Skill,
  SkillFrontmatter,
  SkillMeta,
  ICommandRegistry,
} from './types';

/**
 * Parse a SKILL.md file into structured data.
 * Expects YAML frontmatter between --- delimiters, followed by markdown body.
 */
export function parseSkillMd(content: string): ParsedSkill {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)');
  }

  const secondDelimiter = trimmed.indexOf('---', 3);
  if (secondDelimiter === -1) {
    throw new Error('SKILL.md frontmatter is missing closing ---');
  }

  const yamlContent = trimmed.slice(3, secondDelimiter).trim();
  const body = trimmed.slice(secondDelimiter + 3).trim();

  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = parseYaml(yamlContent) as SkillFrontmatter;
  } catch (err) {
    throw new Error(
      `Invalid YAML in SKILL.md frontmatter: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error('SKILL.md frontmatter must be a YAML object');
  }

  return { frontmatter, body };
}

/**
 * Validate a parsed skill against the Zod schemas.
 * Optionally checks for name conflicts with built-in commands.
 */
export function validateSkill(
  parsed: ParsedSkill,
  commandRegistry?: ICommandRegistry
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate frontmatter
  const frontmatterResult = skillFrontmatterSchema.safeParse(parsed.frontmatter);
  if (!frontmatterResult.success) {
    for (const issue of frontmatterResult.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  // Validate body size
  if (!parsed.body || parsed.body.length === 0) {
    errors.push('body: Skill body must not be empty');
  } else if (parsed.body.length > 51200) {
    errors.push('body: Skill body exceeds 50KB limit');
  }

  // Check for reserved command names
  if (commandRegistry && parsed.frontmatter.name) {
    if (commandRegistry.has(parsed.frontmatter.name)) {
      errors.push(
        `name: "${parsed.frontmatter.name}" conflicts with an existing built-in command`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a full Skill object against the schema.
 */
export function validateFullSkill(skill: Skill): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const result = skillSchema.safeParse(skill);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Perform variable substitution on skill body.
 * Replaces $ARGUMENTS with all args joined, $1/$2/etc. with positional args.
 */
export function substituteVariables(body: string, args: string[]): string {
  let result = body;

  // Replace $ARGUMENTS with all args joined by space
  result = result.replace(/\$ARGUMENTS/g, args.join(' '));

  // Replace positional $1, $2, ... $9
  for (let i = 0; i < Math.min(args.length, 9); i++) {
    result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), args[i]);
  }

  return result;
}

/**
 * Normalize parsed frontmatter (kebab-case YAML keys + flexible value shapes)
 * into the camelCase fields used by `Skill` and `SkillMeta`.
 *
 * Defaults applied:
 *  - context: 'inline'
 *  - userInvocable: true
 *  - disableModelInvocation: false
 *
 * Coercions:
 *  - 'true'/'false' string → boolean
 *  - domains: string → [string]
 */
export interface NormalizedSkillFields {
  whenToUse?: string;
  argumentHint?: string;
  model?: Skill['model'];
  effort?: Skill['effort'];
  context: 'inline' | 'fork';
  agent?: string;
  hooks?: Skill['hooks'];
  domains?: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  version?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
  compatibility?: string;
}

function coerceBool(v: unknown, defaultValue: boolean): boolean {
  if (v === undefined || v === null) return defaultValue;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return defaultValue;
}

export function normalizeFrontmatter(fm: SkillFrontmatter): NormalizedSkillFields {
  const domains = fm.domains === undefined
    ? undefined
    : Array.isArray(fm.domains)
      ? [...fm.domains]
      : [fm.domains];

  return {
    whenToUse: fm['when-to-use'],
    argumentHint: fm['argument-hint'],
    model: fm.model,
    effort: fm.effort,
    context: fm.context ?? 'inline',
    agent: fm.agent,
    hooks: fm.hooks,
    domains,
    userInvocable: coerceBool(fm['user-invocable'], true),
    disableModelInvocation: coerceBool(fm['disable-model-invocation'], false),
    version: fm.version,
    allowedTools: fm['allowed-tools']
      ? fm['allowed-tools'].split(/[,\s]+/).filter(Boolean)
      : undefined,
    metadata: fm.metadata,
    compatibility: fm.compatibility,
  };
}

/**
 * Project a full Skill record into the lightweight SkillMeta shape that
 * `ISkillProvider.listMeta()` returns. Centralized so FilesystemSkillProvider
 * and IndexedDBSkillProvider stay in sync as new fields are added.
 */
export function projectMeta(skill: Skill): SkillMeta {
  return {
    name: skill.name,
    description: skill.description,
    invocationMode: skill.invocationMode,
    trusted: skill.trusted,
    source: skill.source,
    whenToUse: skill.whenToUse,
    argumentHint: skill.argumentHint,
    context: skill.context,
    agent: skill.agent,
    domains: skill.domains,
    userInvocable: skill.userInvocable,
    disableModelInvocation: skill.disableModelInvocation,
    pluginId: skill.pluginId,
  };
}

/**
 * Serialize a Skill back to standard-compliant SKILL.md format.
 * Does NOT include invocationMode, trusted, source, or other non-standard fields.
 */
export function serializeToSkillMd(skill: Skill): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };

  if (skill.metadata && Object.keys(skill.metadata).length > 0) {
    frontmatter.metadata = skill.metadata;
  }

  if (skill.allowedTools && skill.allowedTools.length > 0) {
    frontmatter['allowed-tools'] = skill.allowedTools.join(' ');
  }

  if (skill.compatibility) {
    frontmatter.compatibility = skill.compatibility;
  }

  // ── Track 03 extended fields ──
  if (skill.whenToUse) frontmatter['when-to-use'] = skill.whenToUse;
  if (skill.argumentHint) frontmatter['argument-hint'] = skill.argumentHint;
  if (skill.model) frontmatter.model = skill.model;
  if (skill.effort !== undefined) frontmatter.effort = skill.effort;
  if (skill.context && skill.context !== 'inline') frontmatter.context = skill.context;
  if (skill.agent) frontmatter.agent = skill.agent;
  if (skill.hooks && Object.keys(skill.hooks).length > 0) frontmatter.hooks = skill.hooks;
  if (skill.domains && skill.domains.length > 0) {
    frontmatter.domains = skill.domains.length === 1 ? skill.domains[0] : skill.domains;
  }
  if (skill.userInvocable === false) frontmatter['user-invocable'] = false;
  if (skill.disableModelInvocation === true) frontmatter['disable-model-invocation'] = true;
  if (skill.version) frontmatter.version = skill.version;

  const yaml = stringifyYaml(frontmatter).trim();
  return `---\n${yaml}\n---\n\n${skill.body}\n`;
}
