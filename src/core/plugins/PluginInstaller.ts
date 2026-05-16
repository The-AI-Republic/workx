/**
 * PluginInstaller / PluginUninstaller — Phase 10b orchestration.
 *
 * Install (9 steps, design § Marketplace > Installer):
 *  1 validate scope · 2 root policy guard · 3 resolve dep closure ·
 *  4 re-check every closure member against policy (fail-closed) ·
 *  5 single atomic enabledPlugins write · 6 materialize loop (post-order:
 *  fetch → SHA-verify → provider.writeFiles → installedPlugins.addEntry →
 *  registry.register) · 7 clear caches.
 *
 * Uninstall (design § Marketplace > Uninstall flow): active-task guard →
 * disable → settings → removeEntry → orphan-mark (last scope) → wipe
 * options.
 *
 * All I/O (fetch, policy) injected → testable without real git/network.
 */

import { resolveDependencyClosure } from './dependencyResolver';
import type { MarketplaceRegistry } from './MarketplaceRegistry';
import type { InstalledPluginsStore, InstalledPluginScope } from './installedPlugins';
import type { IPluginProvider } from './PluginProvider';
import type { PluginRegistry } from './PluginRegistry';
import type { PluginId } from './types';

export interface FetchedPlugin {
  files: Array<{ path: string; content: Uint8Array }>;
  version: string;
  gitCommitSha?: string;
}

export interface PluginInstallerDeps {
  marketplaces: MarketplaceRegistry;
  provider: IPluginProvider;
  installed: InstalledPluginsStore;
  registry: PluginRegistry;
  /** Fetch a plugin's files for a resolved catalogue entry (git/tarball). */
  fetchPlugin: (pluginId: PluginId) => Promise<FetchedPlugin>;
  /** Policy gate (Phase 10c). Default: allow all. */
  isBlockedByPolicy?: (id: PluginId) => boolean;
  /** Persist the whole closure to enabledPlugins in ONE write (step 5). */
  setEnabled: (ids: PluginId[], enabled: boolean) => Promise<void>;
  /** Cross-marketplace allowlist for the root marketplace (Phase 10c). */
  allowedCrossMarketplaces?: ReadonlySet<string>;
  /** Currently-enabled plugin ids (for dep-closure skip). */
  getAlreadyEnabled: () => ReadonlySet<PluginId>;
}

export type InstallResult =
  | { ok: true; installed: PluginId[] }
  | { ok: false; error: string };

export class PluginInstaller {
  constructor(private readonly deps: PluginInstallerDeps) {}

  async install(
    pluginId: PluginId,
    scope: InstalledPluginScope = 'user',
  ): Promise<InstallResult> {
    // 1. scope
    if (scope === 'managed') {
      return { ok: false, error: 'cannot install into managed scope' };
    }
    // 2. root policy guard
    const blocked = this.deps.isBlockedByPolicy ?? (() => false);
    if (blocked(pluginId)) {
      return { ok: false, error: `plugin ${pluginId} blocked by org policy` };
    }
    // 3. resolve dep closure
    const resolution = await resolveDependencyClosure(
      pluginId,
      async (id) => {
        const found = this.deps.marketplaces.lookup(id);
        return found ? { dependencies: found.entry.dependencies } : null;
      },
      this.deps.getAlreadyEnabled(),
      this.deps.allowedCrossMarketplaces ?? new Set<string>(),
    );
    if (!resolution.ok) {
      return { ok: false, error: `dependency resolution failed: ${resolution.error}` };
    }
    const closure = resolution.closure;

    // 4. re-check every closure member (fail-closed)
    for (const id of closure) {
      if (blocked(id)) {
        return { ok: false, error: `dependency ${id} blocked by org policy` };
      }
    }

    // 5. single atomic enabledPlugins write
    await this.deps.setEnabled(closure, true);

    // 6. materialize loop (post-order: deps before dependents)
    for (const id of closure) {
      const lookup = this.deps.marketplaces.lookup(id);
      if (!lookup) {
        return { ok: false, error: `no marketplace entry for ${id}` };
      }
      let fetched: FetchedPlugin;
      try {
        fetched = await this.deps.fetchPlugin(id);
      } catch (e) {
        // Partial materialize is NOT rolled back — next load's
        // verify-and-demote handles it; user can re-run install.
        return {
          ok: false,
          error: `fetch ${id} failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      // SHA verification (fail-closed): if the catalogue pins a sha, the
      // fetch MUST report a commit sha and it MUST match. Skipping the
      // check when `fetched.gitCommitSha` is absent would silently install
      // unverified content despite a pin — a supply-chain fail-open.
      const src = lookup.entry.source as { sha?: string } | undefined;
      const wantSha = src && 'sha' in src ? src.sha : undefined;
      if (wantSha) {
        if (!fetched.gitCommitSha) {
          return {
            ok: false,
            error: `${id} pins sha ${wantSha} but the fetch could not confirm a commit sha — refusing to install unverified content`,
          };
        }
        if (wantSha !== fetched.gitCommitSha) {
          return {
            ok: false,
            error: `SHA mismatch for ${id}: expected ${wantSha}, got ${fetched.gitCommitSha}`,
          };
        }
      }
      await this.deps.provider.writeFiles(id, fetched.files);
      await this.deps.installed.addEntry(id, {
        scope,
        version: fetched.version,
        installedAt: Date.now(),
        lastUpdated: Date.now(),
        installPath: this.deps.provider.getRoot(id),
        gitCommitSha: fetched.gitCommitSha,
      });
      try {
        this.deps.registry.register(await this.deps.provider.load(id));
      } catch (e) {
        console.warn(`[PluginInstaller] register ${id} failed:`, e);
      }
    }

    return { ok: true, installed: closure };
  }
}

export interface PluginUninstallerDeps {
  provider: IPluginProvider;
  installed: InstalledPluginsStore;
  registry: PluginRegistry;
  setEnabled: (ids: PluginId[], enabled: boolean) => Promise<void>;
  /**
   * SECURITY/CORRECTNESS (review B2): on last-scope removal we MUST NOT
   * synchronously delete the plugin dir — a running session may still be
   * reading it. Instead orphan-mark it; the 7-day GC sweep removes it
   * later. Wired to `PluginCache.markOrphaned(installPath)` by the
   * bootstrap. If absent, cleanup is deferred to the next GC pass
   * (which will mark+grace any cache dir not in installed_plugins_v2).
   */
  markOrphaned?: (installPath: string) => Promise<void>;
  /** Wipe per-plugin options + secrets (Phase 10c). Optional. */
  deletePluginOptions?: (id: PluginId) => Promise<void>;
  /** Refuse if a background task uses this plugin's sub-agent types. */
  checkActiveTasks?: (pluginId: PluginId) => string | null;
}

export type UninstallResult = { ok: true } | { ok: false; error: string };

export class PluginUninstaller {
  constructor(private readonly deps: PluginUninstallerDeps) {}

  async uninstall(
    pluginId: PluginId,
    scope: InstalledPluginScope = 'user',
  ): Promise<UninstallResult> {
    // Active-task guard (design § Active-Session Rule 3 extended to uninstall)
    const refusal = this.deps.checkActiveTasks?.(pluginId);
    if (refusal) return { ok: false, error: refusal };

    // Capture the install path for this scope BEFORE removeEntry deletes
    // the bucket (needed to orphan-mark on last-scope removal).
    const entries = await this.deps.installed.getEntries(pluginId);
    const installPath = entries.find((e) => e.scope === scope)?.installPath;

    // disable (idempotent — no-op if not enabled)
    await this.deps.registry.disable(pluginId).catch((e) =>
      console.warn(`[PluginUninstaller] disable ${pluginId}:`, e),
    );
    // settings
    await this.deps.setEnabled([pluginId], false);
    // installed_plugins_v2 — returns true if that was the last scope
    const lastScope = await this.deps.installed.removeEntry(pluginId, scope);
    // evict from the live registry
    this.deps.registry.markEvicted(pluginId);

    if (lastScope) {
      // CORRECTNESS (review B2): orphan-mark, do NOT hard-delete — a
      // running session may still be reading plugin files. The 7-day GC
      // sweep removes the dir later.
      if (this.deps.markOrphaned && installPath) {
        await this.deps.markOrphaned(installPath).catch((e) =>
          console.warn(`[PluginUninstaller] orphan-mark ${pluginId}:`, e),
        );
      } else {
        console.log(
          `[PluginUninstaller] ${pluginId} files left for the orphan GC ` +
            `(no markOrphaned wired; next GC pass will mark + 7-day grace).`,
        );
      }
      await this.deps.deletePluginOptions?.(pluginId).catch((e) =>
        console.warn(`[PluginUninstaller] deleteOptions ${pluginId}:`, e),
      );
    }
    return { ok: true };
  }
}
