/**
 * MarketplaceRegistry — tracks added marketplaces and resolves plugin
 * catalogue entries.
 *
 * Catalogue fetch (git clone / tarball) is platform-injected via
 * `fetchCatalogue` so the registry stays platform-agnostic and testable.
 *
 * Reference: design.md § Marketplace (Phase 10b).
 */

import { MarketplaceSchema } from './MarketplaceSchema';
import type { Marketplace, MarketplaceEntry } from './MarketplaceSchema';
import type { PluginId } from './types';

export interface MarketplaceRegistryDeps {
  /**
   * Fetch + parse a marketplace's `marketplace.json` given its source URL
   * or local path. Platform-specific (git clone on desktop/server, GitHub
   * tarball on extension). Returns raw JSON text.
   */
  fetchCatalogue: (sourceRef: string) => Promise<string>;
}

interface AddedMarketplace {
  name: string;
  sourceRef: string;
  catalogue: Marketplace;
  fetchedAt: number;
}

export class MarketplaceRegistry {
  private readonly marketplaces = new Map<string, AddedMarketplace>();

  constructor(private readonly deps: MarketplaceRegistryDeps) {}

  /** Add (or refresh) a marketplace from its source ref. */
  async add(sourceRef: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    let raw: string;
    try {
      raw = await this.deps.fetchCatalogue(sourceRef);
    } catch (e) {
      return { ok: false, error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `marketplace.json parse error: ${e instanceof Error ? e.message : String(e)}` };
    }
    const result = MarketplaceSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: `marketplace.json invalid: ${result.error.message}` };
    }
    const catalogue = result.data;
    this.marketplaces.set(catalogue.name, {
      name: catalogue.name,
      sourceRef,
      catalogue,
      fetchedAt: Date.now(),
    });
    return { ok: true, name: catalogue.name };
  }

  remove(name: string): boolean {
    return this.marketplaces.delete(name);
  }

  list(): Array<{ name: string; sourceRef: string; pluginCount: number; fetchedAt: number }> {
    return [...this.marketplaces.values()].map((m) => ({
      name: m.name,
      sourceRef: m.sourceRef,
      pluginCount: m.catalogue.plugins.length,
      fetchedAt: m.fetchedAt,
    }));
  }

  getCatalogue(name: string): Marketplace | undefined {
    return this.marketplaces.get(name)?.catalogue;
  }

  /**
   * Resolve a `<name>@<marketplace>` plugin id to its catalogue entry.
   * Returns null if the marketplace isn't added or the plugin isn't listed.
   */
  lookup(pluginId: PluginId): { entry: MarketplaceEntry; marketplace: string } | null {
    const at = pluginId.indexOf('@');
    if (at < 0) return null;
    const name = pluginId.slice(0, at);
    const mkt = pluginId.slice(at + 1);
    const added = this.marketplaces.get(mkt);
    if (!added) return null;
    const entry = added.catalogue.plugins.find((p) => p.name === name);
    if (!entry) return null;
    return { entry, marketplace: mkt };
  }

  /** All `<name>@<marketplace>` ids currently in a marketplace catalogue. */
  pluginIds(marketplace: string): PluginId[] {
    const added = this.marketplaces.get(marketplace);
    if (!added) return [];
    return added.catalogue.plugins.map((p) => `${p.name}@${marketplace}`);
  }
}
