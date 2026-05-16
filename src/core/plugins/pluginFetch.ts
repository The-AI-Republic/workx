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
import { gitClone, gitFetchCheckoutSha } from './git';

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

// `ref` (branch/tag — `git clone --branch` resolves these) is kept distinct
// from `sha` (a raw commit — only reachable via fetch+checkout). Conflating
// them as `ref ?? sha` (the old code) meant a sha-pinned entry tried
// `clone --branch <40-hex>` (which never resolves) AND skipped real SHA
// verification when HEAD couldn't be read — a supply-chain fail-open.
function gitUrlFor(entry: MarketplaceEntry): { url: string; ref?: string; sha?: string } {
  const s = entry.source;
  switch (s.type) {
    case 'github':
      return { url: `https://github.com/${s.repo}.git`, ref: s.ref, sha: s.sha };
    case 'git':
      return { url: s.url, ref: s.ref, sha: s.sha };
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
    const { url, ref, sha: pinnedSha } = gitUrlFor(entry);

    const tmp = await deps.mkTempDir();
    try {
      if (pinnedSha) {
        // Pinned commit: clone default branch, then fetch + detach-checkout
        // the exact sha (fail-closed — gitFetchCheckoutSha throws otherwise).
        await gitClone(deps.run, { url, targetPath: tmp });
        await gitFetchCheckoutSha(deps.run, tmp, pinnedSha);
      } else {
        // Branch/tag (or default) — `--branch` resolves these fine.
        await gitClone(deps.run, { url, targetPath: tmp, ref });
      }
      const resolved = await deps.resolveHeadSha(tmp);
      if (pinnedSha && resolved && resolved !== pinnedSha) {
        throw new Error(
          `post-checkout sha mismatch: expected ${pinnedSha}, got ${resolved}`,
        );
      }
      // When a sha was pinned we fetched+checked-out exactly it, so it is
      // verified by construction even if `rev-parse HEAD` couldn't be read.
      const gitCommitSha = pinnedSha ?? resolved;
      const rels = (await deps.walkFiles(tmp)).filter(
        (r) => !r.startsWith('.git/') && r !== '.git',
      );
      const files: Array<{ path: string; content: Uint8Array }> = [];
      for (const rel of rels) {
        files.push({ path: rel, content: await deps.readBytes(`${tmp}/${rel}`) });
      }
      const version =
        entry.version ??
        (gitCommitSha ? gitCommitSha.slice(0, 7) : new Date().toISOString());
      return { files, version, gitCommitSha };
    } finally {
      await deps.removeDir(tmp).catch(() => undefined);
    }
  };
}
