/**
 * CommandSlotLoader — loads `manifest.commands` into PluginCommandLoader.
 *
 * Walks `<plugin>/commands/` for `.md` files OR consumes inline command
 * metadata from `manifest.commands` when it's an object. Each command is
 * stamped:
 *   - `loadedFrom: 'plugin'` → SOURCE_PRECEDENCE puts builtin/skill ahead
 *   - name namespaced as `<pluginName>:<bareName>` (between-plugins
 *     collision resolution per design § Naming and Collision Resolution)
 *
 * Body substitution: command body content runs through `substituteContent`
 * (plugin vars + content-safe user_config).
 *
 * Reference: design.md § Loader-by-slot Wiring (CommandSlotLoader bullet).
 */

import type { PluginCommandLoader } from '@/core/commands/loaders/PluginCommandLoader';
import type { PromptCommand } from '@/core/commands/types';
import type { LoadedPlugin, PluginError, PluginId, CommandMetadata } from '../types';
import { substituteContent } from '../userConfigSubstitution';
import type { FileReader, DirLister } from './SkillSlotLoader';
import { safeJoinUnderRoot } from '../pluginPath';

export interface CommandSlotLoaderDeps {
  pluginCommandLoader: PluginCommandLoader;
  readFile: FileReader;
  listDirs: DirLister;
}

export class CommandSlotLoader {
  constructor(private readonly deps: CommandSlotLoaderDeps) {}

  async load(
    plugin: LoadedPlugin,
    userConfig: Record<string, unknown>,
  ): Promise<PluginError[]> {
    const errors: PluginError[] = [];
    const pluginName = pluginNameFromId(plugin.id);
    const commands: PromptCommand[] = [];

    const raw = plugin.manifest.commands;
    if (raw == null) {
      this.deps.pluginCommandLoader.add(plugin.id, commands);
      return errors;
    }

    // Inline object map: name → CommandMetadata
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [bareName, meta] of Object.entries(raw)) {
        const result = await this.buildFromMetadata(
          plugin,
          userConfig,
          pluginName,
          bareName,
          meta,
        );
        if ('error' in result) errors.push(result.error);
        else commands.push(result.command);
      }
      this.deps.pluginCommandLoader.add(plugin.id, commands);
      return errors;
    }

    // Path / array-of-paths form: walk dirs for .md files
    const rels = typeof raw === 'string' ? [raw] : raw;
    const roots = rels.map((rel) => resolveRel(plugin.path, rel));

    for (const root of roots) {
      let entries: string[];
      try {
        entries = await this.deps.listDirs(root);
      } catch {
        errors.push({ type: 'path-not-found', pluginId: plugin.id, path: root });
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = joinPath(root, entry);
        const content = await this.deps.readFile(filePath);
        if (content == null) continue;
        const bareName = basenameNoExt(entry);
        const { frontmatter, body } = parseFrontmatter(content);
        const cmd = this.buildPromptCommand(
          plugin,
          userConfig,
          pluginName,
          bareName,
          frontmatter.description || `Plugin-defined: ${bareName}`,
          body,
          frontmatter,
        );
        commands.push(cmd);
      }
    }

    this.deps.pluginCommandLoader.add(plugin.id, commands);
    return errors;
  }

  unload(pluginId: PluginId): void {
    this.deps.pluginCommandLoader.removeByPluginId(pluginId);
  }

  private async buildFromMetadata(
    plugin: LoadedPlugin,
    userConfig: Record<string, unknown>,
    pluginName: string,
    bareName: string,
    meta: CommandMetadata,
  ): Promise<{ command: PromptCommand } | { error: PluginError }> {
    let body: string;
    if (meta.content != null) {
      body = meta.content;
    } else if (meta.source != null) {
      const sourcePath = resolveRel(plugin.path, meta.source);
      const content = await this.deps.readFile(sourcePath);
      if (content == null) {
        return {
          error: { type: 'path-not-found', pluginId: plugin.id, path: sourcePath },
        };
      }
      // Strip frontmatter if present; metadata supersedes
      const { body: parsedBody } = parseFrontmatter(content);
      body = parsedBody;
    } else {
      return {
        error: {
          type: 'manifest-validation-error',
          pluginId: plugin.id,
          path: plugin.path,
          issues: [`commands.${bareName}: must provide exactly one of source or content`],
        },
      };
    }

    return {
      command: this.buildPromptCommand(
        plugin,
        userConfig,
        pluginName,
        bareName,
        meta.description || `Plugin-defined: ${bareName}`,
        body,
        meta,
      ),
    };
  }

  private buildPromptCommand(
    plugin: LoadedPlugin,
    userConfig: Record<string, unknown>,
    pluginName: string,
    bareName: string,
    description: string,
    body: string,
    meta: Partial<CommandMetadata & { argumentHint?: string; whenToUse?: string }>,
  ): PromptCommand {
    const namespaced = `${pluginName}:${bareName}`;
    const substitutedBody = substituteContent(body, plugin, userConfig);
    return {
      type: 'prompt',
      name: namespaced,
      description,
      loadedFrom: 'plugin',
      argumentHint: meta.argumentHint,
      whenToUse: meta.whenToUse,
      userInvocable: true,
      disableModelInvocation: false,
      context: 'inline',
      async getPromptForCommand(args: string): Promise<string> {
        if (!args) return substitutedBody;
        const argList = args.split(/\s+/).filter(Boolean);
        // Single-pass, function-form replacement: the replacement value is
        // returned literally, so `$`-sequences in untrusted `args`
        // (`$&`, `$\``, `$'`, `$$`) are NOT reinterpreted as replacement
        // patterns (same hazard documented in userConfigSubstitution.ts
        // ~L40-43), and an injected `$1` from args is not re-expanded by a
        // second pass.
        return substitutedBody.replace(/\$@|\$(\d+)/g, (_m, n?: string) =>
          n === undefined ? args : (argList[parseInt(n, 10) - 1] ?? ''),
        );
      },
    };
  }
}

function pluginNameFromId(id: string): string {
  const at = id.indexOf('@');
  return at >= 0 ? id.substring(0, at) : id;
}

function basenameNoExt(name: string): string {
  return name.replace(/\.md$/i, '');
}

// SECURITY (Track 10): jail untrusted manifest command paths under root.
function resolveRel(root: string, rel: string): string {
  return safeJoinUnderRoot(root, rel);
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p != null && p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.substring(0, idx).trim();
    const value = line.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
    fm[key] = value;
  }
  return { frontmatter: fm, body: match[2] };
}
