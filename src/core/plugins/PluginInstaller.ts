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
      // SHA verification: the catalogue entry's pinned sha must match.
      const wantSha = lookup.entry.source && 'sha' in lookup.entry.source
        ? (lookup.entry.source as { sha?: string }).sha
        : undefined;
      if (wantSha && fetched.gitCommitSha && wantSha !== fetched.gitCommitSha) {
        return {
          ok: false,
          error: `SHA mismatch for ${id}: expected ${wantSha}, got ${fetched.gitCommitSha}`,
        };
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
      // last scope removed → remove files + wipe options
      await this.deps.provider.remove(pluginId).catch((e) =>
        console.warn(`[PluginUninstaller] remove files ${pluginId}:`, e),
      );
      await this.deps.deletePluginOptions?.(pluginId).catch((e) =>
        console.warn(`[PluginUninstaller] deleteOptions ${pluginId}:`, e),
      );
    }
    return { ok: true };
  }
}
