import { invoke } from '@tauri-apps/api/core';
import type { ISkillProvider } from '@/core/skills/SkillProvider';
import type { Skill, SkillMeta, InvocationMode } from '@/core/skills/types';
import { parseSkillMd, serializeToSkillMd, normalizeFrontmatter, projectMeta } from '@/core/skills/SkillParser';

interface SkillMetaJson {
  invocationMode: InvocationMode;
  trusted: boolean;
  source: 'user' | 'imported';
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Filesystem-backed skill provider for Tauri desktop.
 * Skills stored at ~/.airepublic-pi/skills/{name}/SKILL.md
 * User settings stored in .skill-meta.json sidecar.
 */
export class FilesystemSkillProvider implements ISkillProvider {
  constructor(private basePath: string = '~/.airepublic-pi/skills') {}

  async initialize(): Promise<void> {
    await invoke('skills_ensure_dir', { path: this.basePath });
  }

  async listMeta(): Promise<SkillMeta[]> {
    const dirs = await invoke<string[]>('skills_list_dirs', { path: this.basePath });
    const metas: SkillMeta[] = [];

    for (const dir of dirs) {
      try {
        const skill = await this.load(dir);
        if (!skill) continue;
        metas.push(projectMeta(skill));
      } catch (err) {
        console.warn(`[FilesystemSkillProvider] Skipping invalid skill directory: ${dir}`, err);
      }
    }

    return metas;
  }

  async load(name: string): Promise<Skill | null> {
    try {
      const skillPath = `${this.basePath}/${name}/SKILL.md`;
      const metaPath = `${this.basePath}/${name}/.skill-meta.json`;

      const content = await invoke<string | null>('skills_read_file', { path: skillPath });
      if (!content) return null;

      const parsed = parseSkillMd(content);

      // Read sidecar metadata
      let meta: Partial<SkillMetaJson> = {};
      try {
        const metaContent = await invoke<string | null>('skills_read_file', { path: metaPath });
        if (metaContent) {
          meta = JSON.parse(metaContent);
        }
      } catch {
        // defaults
      }

      const now = new Date().toISOString();
      const fields = normalizeFrontmatter(parsed.frontmatter);

      return {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        body: parsed.body,
        invocationMode: meta.invocationMode ?? 'manual',
        trusted: meta.trusted ?? true,
        source: meta.source ?? 'user',
        sourceUrl: meta.sourceUrl,
        metadata: fields.metadata,
        allowedTools: fields.allowedTools,
        compatibility: fields.compatibility,
        createdAt: meta.createdAt ?? now,
        updatedAt: meta.updatedAt ?? now,
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
    } catch {
      return null;
    }
  }

  async loadReference(skillName: string, refPath: string): Promise<string | null> {
    try {
      const path = `${this.basePath}/${skillName}/${refPath}`;
      return await invoke<string | null>('skills_read_file', { path });
    } catch {
      return null;
    }
  }

  async save(skill: Skill): Promise<void> {
    const dirPath = `${this.basePath}/${skill.name}`;
    const skillPath = `${dirPath}/SKILL.md`;
    const metaPath = `${dirPath}/.skill-meta.json`;

    // Ensure skill directory exists
    await invoke('skills_ensure_dir', { path: dirPath });

    // Write standard-compliant SKILL.md
    const skillMd = serializeToSkillMd(skill);
    await invoke('skills_write_file', { path: skillPath, content: skillMd });

    // Write sidecar metadata
    const meta: SkillMetaJson = {
      invocationMode: skill.invocationMode,
      trusted: skill.trusted,
      source: skill.source,
      sourceUrl: skill.sourceUrl,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };
    await invoke('skills_write_file', {
      path: metaPath,
      content: JSON.stringify(meta, null, 2),
    });
  }

  async delete(name: string): Promise<void> {
    const dirPath = `${this.basePath}/${name}`;
    await invoke('skills_remove_dir', { path: dirPath });
  }

  async exists(name: string): Promise<boolean> {
    try {
      const skillPath = `${this.basePath}/${name}/SKILL.md`;
      const content = await invoke<string | null>('skills_read_file', { path: skillPath });
      return content !== null;
    } catch {
      return false;
    }
  }

  async exportAsSkillMd(name: string): Promise<string | null> {
    const skill = await this.load(name);
    if (!skill) return null;
    return serializeToSkillMd(skill);
  }
}
