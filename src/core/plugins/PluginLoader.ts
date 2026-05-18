/**
 * PluginLoader — reads `plugin.json`, validates with Zod, produces a
 * `LoadedPlugin` in `state: { status: 'disabled' }`.
 *
 * Owns parsing + manifest validation only. Slot dispatch (skills, hooks,
 * MCP, agents, commands) happens later in `PluginRegistry.enable`.
 *
 * Reference: design.md § Loader-by-slot Wiring > PluginLoader.ts.
 */

import { PluginManifestSchema } from './PluginManifest';
import type {
  LoadedPlugin,
  PluginError,
  PluginId,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types';

export interface PluginLoaderDeps {
  /** Read file contents as UTF-8 text. Returns null if the file doesn't exist. */
  readFile: (path: string) => Promise<string | null>;
}

export class PluginLoader {
  constructor(private readonly deps: PluginLoaderDeps) {}

  /**
   * Load a plugin from a directory. The directory MUST contain `plugin.json`
   * (we don't auto-detect skill/agent/command dirs without a manifest in
   * Phase 10a-2 — claudy's auto-detection is a Phase 10b polish).
   */
  async loadFromDir(
    dir: string,
    opts: { source?: PluginSource; scope?: PluginScope; marketplace?: string } = {},
  ): Promise<{ plugin: LoadedPlugin } | { error: PluginError }> {
    const manifestPath = joinPath(dir, 'plugin.json');
    const raw = await this.deps.readFile(manifestPath);
    if (raw == null) {
      return {
        error: {
          type: 'path-not-found',
          pluginId: dirNameAsId(dir, opts.marketplace),
          path: manifestPath,
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        error: {
          type: 'manifest-parse-error',
          path: manifestPath,
          cause: e instanceof Error ? e.message : String(e),
        },
      };
    }

    const result = PluginManifestSchema.safeParse(parsed);
    if (!result.success) {
      return {
        error: {
          type: 'manifest-validation-error',
          path: manifestPath,
          issues: result.error.errors.map((issue) => {
            const where = issue.path.join('.');
            return where ? `${where}: ${issue.message}` : issue.message;
          }),
        },
      };
    }

    const manifest = result.data as PluginManifest;
    const marketplace = opts.marketplace ?? 'local';
    const id: PluginId = `${manifest.name}@${marketplace}`;

    const plugin: LoadedPlugin = {
      id,
      manifest,
      path: dir,
      source: opts.source ?? { type: 'path', path: dir },
      scope: opts.scope ?? 'user',
      state: { status: 'disabled' },
    };

    return { plugin };
  }
}

function dirNameAsId(dir: string, marketplace?: string): PluginId {
  const name = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? 'unknown';
  return `${name}@${marketplace ?? 'local'}`;
}

function joinPath(a: string, b: string): string {
  if (a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}
