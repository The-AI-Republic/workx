import type { ISkillProvider } from './SkillProvider';
import type { Skill, SkillMeta, InvocationMode, ICommandRegistry } from './types';
import { substituteVariables, validateSkill, parseSkillMd } from './SkillParser';

/**
 * Central coordinator for skill lifecycle.
 * Manages discovery, invocation, CommandRegistry integration, and system prompt generation.
 */
export class SkillRegistry {
  private metas: SkillMeta[] = [];
  private provider: ISkillProvider;
  private commandRegistry?: ICommandRegistry;

  constructor(provider: ISkillProvider, commandRegistry?: ICommandRegistry) {
    this.provider = provider;
    this.commandRegistry = commandRegistry;
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

  // ── Command Registration ────────────────────────────────────────

  /**
   * Register skills as commands in CommandRegistry.
   * - manual/hybrid mode → registered (appears in / dropdown)
   * - auto mode → NOT registered (hidden from dropdown)
   * - Skips skills whose name conflicts with existing commands
   */
  registerCommands(): void {
    if (!this.commandRegistry) return;

    for (const meta of this.metas) {
      if (meta.invocationMode === 'auto') continue;

      // Skip if name conflicts with existing command (e.g., built-in)
      if (this.commandRegistry.has(meta.name)) continue;

      const name = meta.name;
      this.commandRegistry.register({
        name,
        description: meta.description,
        argumentHint: '$ARGUMENTS',
        action: async (args?: string) => {
          await this.invoke(name, args ? args.split(/\s+/) : []);
        },
      });
    }
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
   * Generate system prompt block for auto-invocable skills.
   * Only includes skills in auto/hybrid mode that are trusted.
   */
  buildSkillsSystemPrompt(): string {
    const autoSkills = this.getAutoInvocableSkills();
    if (autoSkills.length === 0) return '';

    const lines = autoSkills.map((s) => `- ${s.name}: ${s.description}`);
    return `Available skills:\n${lines.join('\n')}`;
  }

  // ── CRUD ────────────────────────────────────────────────────────

  /**
   * Save a new or updated skill.
   * Throws if name conflicts with a built-in command.
   */
  async save(skill: Skill): Promise<void> {
    // Check for reserved names
    if (this.commandRegistry && this.commandRegistry.has(skill.name)) {
      // Check if it's a skill command we registered (allow updates) vs built-in
      const existingMeta = this.metas.find((m) => m.name === skill.name);
      if (!existingMeta) {
        throw new Error(
          `Skill name "${skill.name}" conflicts with an existing built-in command`
        );
      }
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

      // Register new command if manual/hybrid mode
      if (this.commandRegistry && skill.invocationMode !== 'auto') {
        if (!this.commandRegistry.has(skill.name)) {
          const name = skill.name;
          this.commandRegistry.register({
            name,
            description: skill.description,
            argumentHint: '$ARGUMENTS',
            action: async (args?: string) => {
              await this.invoke(name, args ? args.split(/\s+/) : []);
            },
          });
        }
      }
    }
  }

  /** Delete a skill and unregister from CommandRegistry */
  async delete(name: string): Promise<void> {
    await this.provider.delete(name);

    // Remove from cached metadata
    this.metas = this.metas.filter((m) => m.name !== name);

    // Unregister from CommandRegistry
    if (this.commandRegistry) {
      this.commandRegistry.unregister(name);
    }
  }

  /** Export a skill as standard-compliant SKILL.md */
  async export(name: string): Promise<string | null> {
    return this.provider.exportAsSkillMd(name);
  }

  // ── Invocation Mode ─────────────────────────────────────────────

  /** Update a skill's invocation mode and re-sync CommandRegistry + system prompt */
  async updateInvocationMode(name: string, mode: InvocationMode): Promise<void> {
    const skill = await this.provider.load(name);
    if (!skill) throw new Error(`Skill "${name}" not found`);

    const oldMode = skill.invocationMode;
    skill.invocationMode = mode;
    skill.updatedAt = new Date().toISOString();
    await this.provider.save(skill);

    // Update cached metadata
    const meta = this.metas.find((m) => m.name === name);
    if (meta) {
      meta.invocationMode = mode;
    }

    // Re-sync CommandRegistry
    if (this.commandRegistry) {
      if (oldMode !== 'auto' && mode === 'auto') {
        // Was in dropdown, now hidden → unregister
        this.commandRegistry.unregister(name);
      } else if (oldMode === 'auto' && mode !== 'auto') {
        // Was hidden, now in dropdown → register
        if (!this.commandRegistry.has(name)) {
          this.commandRegistry.register({
            name,
            description: skill.description,
            argumentHint: '$ARGUMENTS',
            action: async (args?: string) => {
              await this.invoke(name, args ? args.split(/\s+/) : []);
            },
          });
        }
      }
    }
  }

  // ── Import / Trust ──────────────────────────────────────────────

  /** Import a skill from URL, flagged as untrusted, defaults to manual mode */
  async importFromUrl(url: string): Promise<Skill> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch skill from ${url}: ${response.statusText}`);
    }

    const content = await response.text();
    const parsed = parseSkillMd(content);

    // Validate
    const validation = validateSkill(parsed, this.commandRegistry);
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
      sourceUrl: url,
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
