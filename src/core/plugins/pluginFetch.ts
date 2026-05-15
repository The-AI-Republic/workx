/**
 * pluginFetch — turn a resolved marketplace entry into a `FetchedPlugin`
 * (the file list the installer's materialize loop writes to the cache).
 *
 * Two strategies, both with injected I/O so they're testable:
 *  - git: clone the source into a temp dir, resolve HEAD sha, walk files.
 *  - tarball: fetch a github tarball at a pinned sha, unpack (extension).
 *
 * This module is the seam between PluginInstaller (pure orchestration) and
 * the platform git/network. Reference: design.md § Installer + § SHA
 * verification.
 */

import type { FetchedPlugin } from './PluginInstaller';
import type { MarketplaceEntry } from './MarketplaceSchema';
import type { GitRunner } from './git';
import { gitClone } from './git';

export interface GitFetchDeps {
  run: GitRunner;
  /** Make a unique temp dir; returns its path. */
  mkTempDir: () => Promise<string>;
  /** Recursively list relative file paths under a dir (excludes .git). */
  walkFiles: (root: string) => Promise<string[]>;
  /** Read a file as bytes. */
  readBytes: (path: string) => Promise<Uint8Array>;
  /** Best-effort recursive remove (temp cleanup). */
  removeDir: (path: string) => Promise<void>;
  /** Resolve the checked-out HEAD sha of a clone (git rev-parse HEAD). */
  resolveHeadSha: (cloneDir: string) => Promise<string | undefined>;
}

function gitUrlFor(entry: MarketplaceEntry): { url: string; ref?: string } {
  const s = entry.source;
  switch (s.type) {
    case 'github':
      return { url: `https://github.com/${s.repo}.git`, ref: s.ref ?? s.sha };
    case 'git':
      return { url: s.url, ref: s.ref ?? s.sha };
    default:
      throw new Error(`git fetch unsupported for source type "${s.type}"`);
  }
}

/**
 * Build a `fetchPlugin(pluginId)` for the installer that clones via git.
 * `resolveEntry` maps a pluginId → its marketplace entry (the installer
 * already resolved the closure; this re-looks-up per member).
 */
export function createGitFetchPlugin(
  deps: GitFetchDeps,
  resolveEntry: (pluginId: string) => MarketplaceEntry | null,
): (pluginId: string) => Promise<FetchedPlugin> {
  return async (pluginId: string): Promise<FetchedPlugin> => {
    const entry = resolveEntry(pluginId);
    if (!entry) throw new Error(`no marketplace entry for ${pluginId}`);
    const { url, ref } = gitUrlFor(entry);

    const tmp = await deps.mkTempDir();
    try {
      await gitClone(deps.run, { url, targetPath: tmp, ref });
      const sha = await deps.resolveHeadSha(tmp);
      const rels = (await deps.walkFiles(tmp)).filter(
        (r) => !r.startsWith('.git/') && r !== '.git',
      );
      const files: Array<{ path: string; content: Uint8Array }> = [];
      for (const rel of rels) {
        files.push({ path: rel, content: await deps.readBytes(`${tmp}/${rel}`) });
      }
      const version =
        entry.version ??
        (sha ? sha.slice(0, 7) : new Date().toISOString());
      return { files, version, gitCommitSha: sha };
    } finally {
      await deps.removeDir(tmp).catch(() => undefined);
    }
  };
}
