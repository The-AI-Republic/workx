import type { ISkillProvider } from './SkillProvider';
import type { Skill, SkillMeta, InvocationMode } from './types';
import { substituteVariables, validateSkill, parseSkillMd } from './SkillParser';

/** Built-in command names that skills cannot use */
const RESERVED_COMMAND_NAMES = new Set(['new', 'help', 'settings']);

/**
 * Central coordinator for skill lifecycle.
 * Manages discovery, invocation, and system prompt generation.
 */
export class SkillRegistry {
  private metas: SkillMeta[] = [];
  private provider: ISkillProvider;

  constructor(provider: ISkillProvider) {
    this.provider = provider;
  }

  // ── Discovery ───────────────────────────────────────────────────

  /** Discover all skills and load Level 1 metadata */
  async discover(): Promise<SkillMeta[]> {
    this.metas = await this.provider.listMeta();
    return this.metas;
  }

  /** Get all skill metadata (cached from last discover()) */
  getSkillMetas(): SkillMeta[] {
    return this.metas;
  }

  /** Get auto-invocable skills (mode=auto|hybrid AND trusted) */
  getAutoInvocableSkills(): SkillMeta[] {
    return this.metas.filter(
      (s) => (s.invocationMode === 'auto' || s.invocationMode === 'hybrid') && s.trusted
    );
  }

  /** Re-run discovery */
  async refresh(): Promise<SkillMeta[]> {
    return this.discover();
  }

  // ── Invocation ──────────────────────────────────────────────────

  /**
   * Load full skill content (Level 2) and perform variable substitution.
   * Returns the substituted body or null if skill not found.
   */
  async invoke(name: string, args?: string[]): Promise<string | null> {
    const skill = await this.provider.load(name);
    if (!skill) return null;

    return substituteVariables(skill.body, args ?? []);
  }

  /** Load a referenced file (Level 3) */
  async loadReference(skillName: string, refPath: string): Promise<string | null> {
    return this.provider.loadReference(skillName, refPath);
  }

  // ── System Prompt ───────────────────────────────────────────────

  /**
   * Generate system prompt block for skills.
   * Lists auto-invocable skills and includes a generic instruction for /skill-name invocations.
   */
  buildSkillsSystemPrompt(): string {
    if (this.metas.length === 0) return '';

    const parts: string[] = [];
    parts.push('You have access to user-defined skills. When a skill is relevant to the user\'s request, invoke it using the use_skill tool.');
    parts.push('When the user types a message starting with /skill-name, invoke that skill using the use_skill tool.');

    const autoSkills = this.getAutoInvocableSkills();
    if (autoSkills.length > 0) {
      const lines = autoSkills.map((s) => `- ${s.name}: ${s.description}`);
      parts.push(`\nAvailable skills for proactive use:\n${lines.join('\n')}`);
    }

    return parts.join('\n');
  }

  // ── CRUD ────────────────────────────────────────────────────────

  /**
   * Save a new or updated skill.
   * Throws if name conflicts with a built-in command.
   */
  async save(skill: Skill): Promise<void> {
    if (RESERVED_COMMAND_NAMES.has(skill.name)) {
      throw new Error(
        `Skill name "${skill.name}" conflicts with a built-in command`
      );
    }

    await this.provider.save(skill);

    // Update cached metadata
    const existingIndex = this.metas.findIndex((m) => m.name === skill.name);
    const meta: SkillMeta = {
      name: skill.name,
      description: skill.description,
      invocationMode: skill.invocationMode,
      trusted: skill.trusted,
      source: skill.source,
    };

    if (existingIndex >= 0) {
      this.metas[existingIndex] = meta;
    } else {
      this.metas.push(meta);
    }
  }

  /** Delete a skill */
  async delete(name: string): Promise<void> {
    await this.provider.delete(name);

    // Remove from cached metadata
    this.metas = this.metas.filter((m) => m.name !== name);
  }

  /** Export a skill as standard-compliant SKILL.md */
  async export(name: string): Promise<string | null> {
    return this.provider.exportAsSkillMd(name);
  }

  // ── Invocation Mode ─────────────────────────────────────────────

  /** Update a skill's invocation mode */
  async updateInvocationMode(name: string, mode: InvocationMode): Promise<void> {
    const skill = await this.provider.load(name);
    if (!skill) throw new Error(`Skill "${name}" not found`);

    skill.invocationMode = mode;
    skill.updatedAt = new Date().toISOString();
    await this.provider.save(skill);

    // Update cached metadata
    const meta = this.metas.find((m) => m.name === name);
    if (meta) {
      meta.invocationMode = mode;
    }
  }

  // ── Import / Trust ──────────────────────────────────────────────

  /**
   * Import a skill from pre-fetched SKILL.md content.
   * The caller is responsible for fetching the content (HTTP is a transport concern).
   * Imported skills are flagged as untrusted and default to manual mode.
   */
  async importFromContent(content: string, sourceUrl?: string): Promise<Skill> {
    const parsed = parseSkillMd(content);

    // Validate
    const validation = validateSkill(parsed);
    if (!validation.valid) {
      throw new Error(`Invalid skill: ${validation.errors.join(', ')}`);
    }

    const now = new Date().toISOString();
    const skill: Skill = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      body: parsed.body,
      invocationMode: 'manual',
      trusted: false,
      source: 'imported',
      sourceUrl,
      metadata: parsed.frontmatter.metadata,
      allowedTools: parsed.frontmatter['allowed-tools']
        ? parsed.frontmatter['allowed-tools'].split(/\s+/)
        : undefined,
      compatibility: parsed.frontmatter.compatibility,
      createdAt: now,
      updatedAt: now,
    };

    await this.save(skill);
    return skill;
  }

  /** Mark an imported skill as trusted, enabling auto-invocation if mode is auto/hybrid */
  async trustSkill(name: string): Promise<void> {
    const skill = await this.provider.load(name);
    if (!skill) throw new Error(`Skill "${name}" not found`);

    skill.trusted = true;
    skill.updatedAt = new Date().toISOString();
    await this.provider.save(skill);

    // Update cached metadata
    const meta = this.metas.find((m) => m.name === name);
    if (meta) {
      meta.trusted = true;
    }
  }
}
