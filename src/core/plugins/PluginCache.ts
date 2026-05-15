/**
 * PluginCache — versioned on-disk cache layout + orphan GC.
 *
 * Layout: `<root>/cache/<marketplace>/<plugin>/<version>/` with each path
 * segment sanitized. Updates are non-in-place: a new version dir is
 * written, the old marked `.orphaned_at` (epoch ms text) and swept after
 * a 7-day grace (matches claudy `cacheUtils.ts`).
 *
 * Filesystem ops are injected so this is platform-agnostic + testable.
 *
 * Reference: design.md § Versioned cache layout + § Marketplace uninstall.
 */

export const BROWSERX_PLUGIN_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PluginCacheFsDeps {
  readText: (path: string) => Promise<string | null>;
  writeText: (path: string, content: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
  listEntries: (path: string) => Promise<string[]>;
  pathExists: (path: string) => Promise<boolean>;
  now?: () => number;
}

function sanitize(seg: string): string {
  return seg.replace(/[^a-zA-Z0-9\-_.@]/g, '-');
}

export class PluginCache {
  private readonly now: () => number;

  constructor(
    private readonly root: string,
    private readonly fs: PluginCacheFsDeps,
  ) {
    this.now = fs.now ?? (() => Date.now());
  }

  /** Versioned dir for a plugin@version under a marketplace. */
  versionDir(marketplace: string, plugin: string, version: string): string {
    return [
      this.root,
      'cache',
      sanitize(marketplace),
      sanitize(plugin),
      sanitize(version),
    ].join('/');
  }

  private orphanMarkerPath(versionDir: string): string {
    return `${versionDir}/.orphaned_at`;
  }

  /** Tag a version dir as orphaned (delayed GC). Best-effort. */
  async markOrphaned(versionDir: string): Promise<void> {
    try {
      await this.fs.writeText(this.orphanMarkerPath(versionDir), String(this.now()));
    } catch (e) {
      console.warn('[PluginCache] markOrphaned failed:', e);
    }
  }

  /** If a previously-orphaned version is back in use, clear its marker. */
  async clearOrphanMarker(versionDir: string): Promise<void> {
    const marker = this.orphanMarkerPath(versionDir);
    if (await this.fs.pathExists(marker)) {
      // Overwrite with nothing is not "delete"; use removeDir on the marker
      // path is wrong. We rely on writeText being able to no-op-clear via
      // an empty sentinel the GC ignores: simplest correct approach is to
      // treat a marker file containing '' as cleared.
      await this.fs.writeText(marker, '');
    }
  }

  /**
   * Sweep orphaned version dirs older than the TTL. Returns removed paths.
   * `installedVersionDirs` are protected (never swept even if marked).
   */
  async gcOrphans(
    marketplaces: string[],
    installedVersionDirs: ReadonlySet<string>,
  ): Promise<string[]> {
    const removed: string[] = [];
    const cacheRoot = `${this.root}/cache`;
    for (const mkt of marketplaces) {
      const mktDir = `${cacheRoot}/${sanitize(mkt)}`;
      const plugins = await this.fs.listEntries(mktDir);
      for (const plugin of plugins) {
        const pluginDir = `${mktDir}/${plugin}`;
        const versions = await this.fs.listEntries(pluginDir);
        for (const version of versions) {
          const vdir = `${pluginDir}/${version}`;
          if (installedVersionDirs.has(vdir)) continue;
          const markerRaw = await this.fs.readText(this.orphanMarkerPath(vdir));
          if (markerRaw == null) {
            // Not installed + no marker → start the grace clock.
            await this.markOrphaned(vdir);
            continue;
          }
          if (markerRaw === '') continue; // cleared marker — back in use
          const ts = Number(markerRaw);
          if (Number.isFinite(ts) && this.now() - ts > BROWSERX_PLUGIN_ORPHAN_TTL_MS) {
            await this.fs.removeDir(vdir);
            removed.push(vdir);
          }
        }
      }
    }
    return removed;
  }
}
