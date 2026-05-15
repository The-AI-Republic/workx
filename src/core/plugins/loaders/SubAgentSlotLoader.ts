/**
 * SubAgentSlotLoader — loads `manifest.agents` as sub-agent type configs.
 *
 * Walks `<plugin>/agents/` for `.md` files. Each file is a sub-agent type
 * definition: YAML frontmatter (name, description, systemPrompt, etc.) +
 * markdown body. The frontmatter is mapped to `SubAgentTypeConfig`.
 *
 * Type ID namespacing: `<pluginName>:<typeName>` per design § Naming and
 * Collision Resolution. Two plugins with the same `reviewer` type id
 * co-exist as `plugin-a:reviewer` and `plugin-b:reviewer`.
 *
 * **Sensitive frontmatter fields are dropped** for plugin agents:
 * `permissionMode`, `hooks`, `mcpServers`. Mirrors claudy `loadPluginAgents.ts:153-168`.
 * Plugin agents are deliberately weaker than user-defined agents — this is
 * a trust boundary, not a missing feature.
 *
 * Reference: design.md § Loader-by-slot Wiring (SubAgentSlotLoader bullet).
 */

import type { SubAgentRunner } from '@/tools/AgentTool/SubAgentRunner';
import type { SubAgentTypeConfig } from '@/tools/AgentTool/types';
import type { LoadedPlugin, PluginError, PluginId } from '../types';
import { substituteContent } from '../userConfigSubstitution';
import type { FileReader, DirLister } from './SkillSlotLoader';

export interface SubAgentSlotLoaderDeps {
  subAgentRunner: SubAgentRunner;
  readFile: FileReader;
  listDirs: DirLister;
}

/**
 * Minimal frontmatter parser — splits the YAML block and the body. We
 * intentionally don't use a full YAML lib here because:
 *  1. Plugin agents are markdown-light; frontmatter is shallow key:value.
 *  2. Keeps the loader self-contained for the v1 ship.
 * If real YAML need arises, swap in `yaml` package.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
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

// Fields that plugin agents are NOT allowed to define — dropped silently
// with a console warning. Mirrors claudy's trust-boundary subset.
const DROPPED_FIELDS = new Set(['permissionMode', 'hooks', 'mcpServers']);

export class SubAgentSlotLoader {
  constructor(private readonly deps: SubAgentSlotLoaderDeps) {}

  async load(
    plugin: LoadedPlugin,
    userConfig: Record<string, unknown>,
  ): Promise<PluginError[]> {
    const errors: PluginError[] = [];
    const pluginName = pluginNameFromId(plugin.id);
    const agentRoots = this.collectAgentRoots(plugin);
    if (agentRoots.length === 0) return errors;

    for (const root of agentRoots) {
      let entries: string[];
      try {
        entries = await this.deps.listDirs(root);
      } catch {
        errors.push({ type: 'path-not-found', pluginId: plugin.id, path: root });
        continue;
      }

      // List both subdirs (containing AGENT.md) and direct .md files
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = joinPath(root, entry);
        const content = await this.deps.readFile(filePath);
        if (content == null) continue;

        try {
          const { frontmatter, body } = parseFrontmatter(content);
          const bareName = frontmatter.name || basenameNoExt(entry);
          const config: SubAgentTypeConfig = {
            id: `${pluginName}:${bareName}`,
            name: frontmatter.name || bareName,
            description: frontmatter.description || `Plugin-defined: ${bareName}`,
            systemPrompt: substituteContent(body, plugin, userConfig),
            maxTurns: parseIntSafe(frontmatter.maxTurns),
            // model intentionally not exposed via frontmatter parsing in v1
          };

          // Drop sensitive fields with a warning (claudy parity)
          for (const f of DROPPED_FIELDS) {
            if (frontmatter[f] !== undefined) {
              console.warn(
                `[SubAgentSlotLoader] plugin ${plugin.id} agent ${bareName}: ` +
                  `frontmatter field "${f}" is not allowed for plugin agents; ignored`,
              );
            }
          }

          await this.deps.subAgentRunner.addType(config, {
            type: 'plugin',
            pluginId: plugin.id,
          });
        } catch (e) {
          errors.push({
            type: 'component-load-failed',
            pluginId: plugin.id,
            slot: 'agents',
            cause: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return errors;
  }

  async unload(pluginId: PluginId): Promise<void> {
    await this.deps.subAgentRunner.removeByPluginId(pluginId);
  }

  private collectAgentRoots(plugin: LoadedPlugin): string[] {
    const raw = plugin.manifest.agents;
    if (raw == null) return [];
    const rels = typeof raw === 'string' ? [raw] : raw;
    return rels.map((rel) => resolveRel(plugin.path, rel));
  }
}

function pluginNameFromId(id: string): string {
  const at = id.indexOf('@');
  return at >= 0 ? id.substring(0, at) : id;
}

function basenameNoExt(name: string): string {
  return name.replace(/\.md$/i, '');
}

function parseIntSafe(s: string | undefined): number | undefined {
  if (s == null) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function resolveRel(root: string, rel: string): string {
  if (rel.startsWith('/')) return rel;
  if (rel.startsWith('./')) return joinPath(root, rel.substring(2));
  return joinPath(root, rel);
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p != null && p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}
