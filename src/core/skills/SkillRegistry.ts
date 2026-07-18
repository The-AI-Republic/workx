import type { ISkillProvider } from './SkillProvider';
import type { Skill, SkillMeta, InvocationMode } from './types';
import { substituteVariables, validateSkill, parseSkillMd, normalizeFrontmatter, projectMeta } from './SkillParser';
import type { SkillValidationContext } from './SkillParser';

/** Built-in command names that skills cannot use */
const RESERVED_COMMAND_NAMES = new Set([
  'new',
  'help',
  'settings',
  'plugin',
  'doctor',
]);

/**
 * Central coordinator for skill lifecycle.
 * Manages discovery, invocation, and system prompt generation.
 */
export class SkillRegistry {
  private metas: SkillMeta[] = [];
  private provider: ISkillProvider;
  private getValidationContext?: () => SkillValidationContext | undefined;

  constructor(
    provider: ISkillProvider,
    getValidationContext?: () => SkillValidationContext | undefined,
  ) {
    this.provider = provider;
    this.getValidationContext = getValidationContext;
  }

  setValidationContextProvider(
    getValidationContext: (() => SkillValidationContext | undefined) | undefined,
  ): void {
    this.getValidationContext = getValidationContext;
  }

  // ── Discovery ───────────────────────────────────────────────────

  /** Discover all skills and load Level 1 metadata */
  async discover(): Promise<SkillMeta[]> {
    this.metas = await this.provider.listMeta();
    return this.metas;
  }

  /**
   * Get all skill metadata (cached from last discover()).
   *
   * Prompt visibility is projected per live session by SessionSkillView;
   * the shared catalog always returns the complete set.
   */
  getSkillMetas(): SkillMeta[] {
    return this.metas;
  }

  /**
   * Returns all metas regardless of domain filter — for callers that need to
   * reason about the full skill catalog (CRUD ops, /help typeahead).
   */
  getAllSkillMetas(): SkillMeta[] {
    return this.metas;
  }

  /** Get auto-invocable skills (mode=auto|hybrid AND trusted), filtered by domain when applicable. */
  getAutoInvocableSkills(): SkillMeta[] {
    return this.getSkillMetas().filter(
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

  /**
   * Load the full Skill record (Level 2) — body + extended fields.
   * Use this when you need `context`, `agent`, `hooks`, `allowedTools`, etc.
   * For substituted body only, use `invoke()`.
   */
  async loadFull(name: string): Promise<Skill | null> {
    return this.provider.load(name);
  }

  // ── System Prompt ───────────────────────────────────────────────

  /**
   * Generate system prompt block for skills.
   * Lists auto-invocable skills and includes a generic instruction for /skill-name invocations.
   */
  buildSkillsSystemPrompt(visibleMetas?: readonly SkillMeta[]): string {
    if (this.metas.length === 0) return '';

    const parts: string[] = [];
    parts.push('You have access to user-defined skills. When a skill is relevant to the user\'s request, invoke it using the use_skill tool.');
    parts.push('When the user types a message starting with /skill-name, invoke that skill using the use_skill tool.');
    parts.push('Only invoke skills that are listed as available or explicitly loaded. Do not guess skill names. If no listed skill fits, proceed with normal tools.');

    const autoSkills = (visibleMetas ?? this.getSkillMetas()).filter(
      (skill) => (skill.invocationMode === 'auto' || skill.invocationMode === 'hybrid') && skill.trusted,
    );
    if (autoSkills.length > 0) {
      const lines = autoSkills.map((s) => {
        const restrictedDomains = s.domains?.filter(
          (domain) => domain !== '*' && domain !== '**',
        ) ?? [];
        const domainHint = restrictedDomains.length > 0
          ? ` (browser domains: ${restrictedDomains.join(', ')})`
          : '';
        return `- ${s.name}: ${s.description}${domainHint}`;
      });
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
    const knownAgents = this.getValidationContext?.()?.knownAgents;
    if (skill.agent && knownAgents && !knownAgents.includes(skill.agent)) {
      const suffix = knownAgents.length > 0
        ? ` Known agents: ${knownAgents.join(', ')}.`
        : ' No sub-agent types are registered.';
      throw new Error(`Invalid skill: agent: Unknown sub-agent type "${skill.agent}".${suffix}`);
    }

    await this.provider.save(skill);

    // Update cached metadata
    const existingIndex = this.metas.findIndex((m) => m.name === skill.name);
    const meta: SkillMeta = projectMeta(skill);

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

  /**
   * Track 10: scoped removal — delete every skill owned by a given plugin.
   *
   * Called by `PluginRegistry.disable(pluginId)` to atomically unload one
   * plugin's skills without touching user-created or other-plugin skills.
   *
   * Per-skill errors are logged but don't halt the loop; final state is
   * "no metas with this pluginId remain". If a provider.delete throws,
   * the corresponding meta is still removed from cache — disable semantics
   * win over storage consistency (next reload will reconcile).
   */
  async removeByPluginId(pluginId: string): Promise<void> {
    const targets = this.metas.filter((m) => m.pluginId === pluginId);
    for (const target of targets) {
      try {
        await this.provider.delete(target.name);
      } catch (e) {
        // Surface but don't halt — see PluginRegistry rollback-failure policy
        console.warn(`[SkillRegistry.removeByPluginId] ${target.name}:`, e);
      }
    }
    this.metas = this.metas.filter((m) => m.pluginId !== pluginId);
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
    const validation = validateSkill(parsed, undefined, this.getValidationContext?.());
    if (!validation.valid) {
      throw new Error(`Invalid skill: ${validation.errors.join(', ')}`);
    }

    const now = new Date().toISOString();
    const fields = normalizeFrontmatter(parsed.frontmatter);
    const skill: Skill = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      body: parsed.body,
      invocationMode: 'manual',
      trusted: false,
      source: 'imported',
      sourceUrl,
      metadata: fields.metadata,
      allowedTools: fields.allowedTools,
      compatibility: fields.compatibility,
      createdAt: now,
      updatedAt: now,
      // Track 03 normalized fields
      whenToUse: fields.whenToUse,
      argumentHint: fields.argumentHint,
      model: fields.model,
      effort: fields.effort,
      context: fields.context,
      agent: fields.agent,
      hooks: fields.hooks,
      domains: fields.domains,
      userInvocable: fields.userInvocable,
      disableModelInvocation: fields.disableModelInvocation,
      version: fields.version,
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
