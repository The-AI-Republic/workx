import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  skillFrontmatterSchema,
  skillSchema,
} from './types';
import type {
  ParsedSkill,
  Skill,
  SkillFrontmatter,
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

  const yaml = stringifyYaml(frontmatter).trim();
  return `---\n${yaml}\n---\n\n${skill.body}\n`;
}
