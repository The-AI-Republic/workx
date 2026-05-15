/**
 * SkillSlotLoader — loads `manifest.skills` into the SkillRegistry.
 *
 * Phase 10a-2: minimal happy-path implementation.
 *  - The `skills` slot in the manifest is a path string (or array of
 *    paths) relative to the plugin root. v1 only supports filesystem
 *    skills via the platform provider; reading SKILL.md content is
 *    delegated to the provider's `IPluginProvider.getRoot` + a
 *    filesystem read.
 *  - Each skill is namespaced as `<pluginName>:<bareName>` per design
 *    § Naming and Collision Resolution. Plugin skills are invocable
 *    only by qualified name in v1 (prevents accidental shadowing of
 *    user skills).
 *  - Each skill carries `pluginId: '<name>@<marketplace>'` for scoped
 *    removal via `SkillRegistry.removeByPluginId`.
 *
 * Body substitution: skill body content runs through
 * `substituteContent` (plugin vars + content-safe user_config).
 *
 * Reference: design.md § Loader-by-slot Wiring (SkillSlotLoader bullet).
 */

import type { SkillRegistry } from '@/core/skills/SkillRegistry';
import type { Skill } from '@/core/skills/types';
import { parseSkillMd, normalizeFrontmatter, validateSkill } from '@/core/skills/SkillParser';
import type { LoadedPlugin, PluginError, PluginId } from '../types';
import { substituteContent } from '../userConfigSubstitution';
import { safeJoinUnderRoot } from '../pluginPath';

/**
 * Reads a single file from disk. Platform-specific — passed in by the
 * bootstrap. Returns null if the file doesn't exist.
 */
export type FileReader = (path: string) => Promise<string | null>;

/**
 * Lists subdirectories of a path. Used to walk `<plugin>/skills/` for
 * individual skill folders. Platform-specific.
 */
export type DirLister = (path: string) => Promise<string[]>;

export interface SkillSlotLoaderDeps {
  skillRegistry: SkillRegistry;
  readFile: FileReader;
  listDirs: DirLister;
}

export class SkillSlotLoader {
  constructor(private readonly deps: SkillSlotLoaderDeps) {}

  async load(
    plugin: LoadedPlugin,
    userConfig: Record<string, unknown>,
  ): Promise<PluginError[]> {
    const errors: PluginError[] = [];
    const pluginName = pluginNameFromId(plugin.id);
    const skillRoots = this.collectSkillRoots(plugin);
    if (skillRoots.length === 0) return errors;

    for (const root of skillRoots) {
      // Try single-skill mode first: <root>/SKILL.md
      const singleSkillPath = joinPath(root, 'SKILL.md');
      const singleSkillContent = await this.deps.readFile(singleSkillPath);
      if (singleSkillContent != null) {
        const err = await this.saveSkillFromContent({
          plugin,
          userConfig,
          pluginName,
          content: singleSkillContent,
          sourcePath: singleSkillPath,
        });
        if (err) errors.push(err);
        continue;
      }

      // Multi-skill mode: scan <root>/<sub>/SKILL.md
      try {
        const subdirs = await this.deps.listDirs(root);
        for (const sub of subdirs) {
          const skillPath = joinPath(root, sub, 'SKILL.md');
          const content = await this.deps.readFile(skillPath);
          if (content == null) continue;
          const err = await this.saveSkillFromContent({
            plugin,
            userConfig,
            pluginName,
            content,
            sourcePath: skillPath,
          });
          if (err) errors.push(err);
        }
      } catch (e) {
        errors.push({
          type: 'path-not-found',
          pluginId: plugin.id,
          path: root,
        });
      }
    }

    return errors;
  }

  async unload(pluginId: PluginId): Promise<void> {
    await this.deps.skillRegistry.removeByPluginId(pluginId);
  }

  private async saveSkillFromContent(input: {
    plugin: LoadedPlugin;
    userConfig: Record<string, unknown>;
    pluginName: string;
    content: string;
    sourcePath: string;
  }): Promise<PluginError | null> {
    try {
      const parsed = parseSkillMd(input.content);
      const validation = validateSkill(parsed);
      if (!validation.valid) {
        return {
          type: 'manifest-validation-error',
          pluginId: input.plugin.id,
          path: input.sourcePath,
          issues: validation.errors,
        };
      }

      const fields = normalizeFrontmatter(parsed.frontmatter);
      const bareName = parsed.frontmatter.name;
      // Namespaced: <pluginName>:<bareName> (Q-collision resolution)
      const namespacedName = `${input.pluginName}:${bareName}`;
      const now = new Date().toISOString();
      const substitutedBody = substituteContent(parsed.body, input.plugin, input.userConfig);

      const skill: Skill = {
        name: namespacedName,
        description: parsed.frontmatter.description,
        body: substitutedBody,
        invocationMode: 'manual',
        trusted: true, // Plugin-supplied skills inherit plugin trust (Q1: enable = trust)
        source: 'user',
        pluginId: input.plugin.id,
        metadata: fields.metadata,
        allowedTools: fields.allowedTools,
        compatibility: fields.compatibility,
        createdAt: now,
        updatedAt: now,
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

      await this.deps.skillRegistry.save(skill);
      return null;
    } catch (e) {
      return {
        type: 'component-load-failed',
        pluginId: input.plugin.id,
        slot: 'skills',
        cause: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private collectSkillRoots(plugin: LoadedPlugin): string[] {
    const raw = plugin.manifest.skills;
    if (raw == null) return [];
    const rels = typeof raw === 'string' ? [raw] : raw;
    return rels.map((rel) => resolveRel(plugin.path, rel));
  }
}

function pluginNameFromId(id: string): string {
  const at = id.indexOf('@');
  return at >= 0 ? id.substring(0, at) : id;
}

// SECURITY (Track 10): plugin-supplied manifest paths are untrusted.
// `safeJoinUnderRoot` rejects absolute paths and any `..` segment and
// jails the result under the plugin root, preventing arbitrary-file
// reads via e.g. `"skills": "../../../.ssh"`.
function resolveRel(root: string, rel: string): string {
  return safeJoinUnderRoot(root, rel);
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p != null && p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}
