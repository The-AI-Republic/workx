/**
 * PluginAutoupdate + delisting detection (Phase 10c).
 *
 * Autoupdate: one-shot, fire-and-forget. Per autoUpdate marketplace,
 * refresh the catalogue, diff each installed plugin's recorded SHA vs the
 * catalogue's pinned SHA, and on a difference fetch the new version into a
 * fresh cache dir, orphan the old, update installed_plugins_v2. Non-in-
 * place: the user must /plugin reload (or restart) to apply.
 *
 * Delisting: marketplaces with `forceRemoveDeletedPlugins: true` auto-
 * uninstall installed plugins that vanished from the catalogue (user/
 * project/local scopes only; managed left for the admin).
 *
 * All I/O injected → unit-tested without git/network.
 * Reference: design.md § Autoupdate + § Delisting / blocklist.
 */

import type { MarketplaceRegistry } from './MarketplaceRegistry';
import type { InstalledPluginsStore, InstalledPluginScope } from './installedPlugins';
import type { FetchedPlugin } from './PluginInstaller';
import type { IPluginProvider } from './PluginProvider';
import type { PluginId } from './types';

export interface AutoupdateDeps {
  marketplaces: MarketplaceRegistry;
  installed: InstalledPluginsStore;
  provider: IPluginProvider;
  fetchPlugin: (id: PluginId) => Promise<FetchedPlugin>;
  /** Marketplace names with autoUpdate enabled. */
  autoUpdateMarketplaces: () => string[];
  /** Refresh a marketplace catalogue (git pull / re-fetch). */
  refreshMarketplace: (name: string) => Promise<void>;
}

export interface AutoupdateResult {
  updated: PluginId[];
  delisted: PluginId[];
}

export class PluginAutoupdate {
  constructor(private readonly deps: AutoupdateDeps) {}

  async run(): Promise<AutoupdateResult> {
    const updated: PluginId[] = [];
    const mkts = this.deps.autoUpdateMarketplaces();

    for (const name of mkts) {
      await this.deps.refreshMarketplace(name).catch((e) =>
        console.warn(`[PluginAutoupdate] refresh ${name} failed:`, e),
      );
    }

    const file = await this.deps.installed.read();
    for (const [pluginId, bucket] of Object.entries(file.plugins)) {
      const at = pluginId.indexOf('@');
      const mkt = at >= 0 ? pluginId.slice(at + 1) : '';
      if (!mkts.includes(mkt)) continue;

      const lookup = this.deps.marketplaces.lookup(pluginId);
      const catalogueSha =
        lookup?.entry.source && 'sha' in lookup.entry.source
          ? (lookup.entry.source as { sha?: string }).sha
          : undefined;
      if (!catalogueSha) continue;

      for (const entry of bucket.entries) {
        if (entry.gitCommitSha === catalogueSha) continue; // up to date

        let fetched: FetchedPlugin;
        try {
          fetched = await this.deps.fetchPlugin(pluginId);
        } catch (e) {
          console.warn(`[PluginAutoupdate] fetch ${pluginId} failed:`, e);
          continue;
        }
        await this.deps.provider.writeFiles(pluginId, fetched.files);
        await this.deps.installed.addEntry(pluginId, {
          ...entry,
          version: fetched.version,
          gitCommitSha: fetched.gitCommitSha,
          lastUpdated: Date.now(),
          installPath: this.deps.provider.getRoot(pluginId),
        });
        updated.push(pluginId);
      }
    }

    const delisted = await this.detectDelisted(mkts);
    return { updated, delisted };
  }

  /**
   * Auto-uninstall plugins removed from a `forceRemoveDeletedPlugins`
   * marketplace. Skips the managed scope (admin's responsibility).
   */
  async detectDelisted(marketplaceNames: string[]): Promise<PluginId[]> {
    const removed: PluginId[] = [];
    const file = await this.deps.installed.read();
    for (const name of marketplaceNames) {
      const catalogue = this.deps.marketplaces.getCatalogue(name);
      if (!catalogue?.forceRemoveDeletedPlugins) continue;
      const live = new Set(catalogue.plugins.map((p) => `${p.name}@${name}`));
      for (const [pluginId, bucket] of Object.entries(file.plugins)) {
        if (!pluginId.endsWith(`@${name}`)) continue;
        if (live.has(pluginId)) continue;
        for (const entry of bucket.entries) {
          if (entry.scope === 'managed') continue;
          await this.deps.installed
            .removeEntry(pluginId, entry.scope as InstalledPluginScope)
            .catch(() => undefined);
          await this.deps.provider.remove(pluginId).catch(() => undefined);
          removed.push(pluginId);
        }
      }
    }
    return removed;
  }
}
