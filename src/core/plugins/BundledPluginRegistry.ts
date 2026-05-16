/**
 * BundledPluginRegistry — module-scoped registry of compile-time bundled
 * plugin definitions.
 *
 * Bundled plugins don't read from disk; they declare their slots inline.
 * IDs are `<name>@bundled` (sentinel marketplace). They show up in the
 * `/plugin list` output alongside user-installed plugins and respect the
 * `enabledPlugins[id]` toggle (default from `defaultEnabled`).
 *
 * Registration pattern: each platform bootstrap calls `initBundledPlugins()`
 * (in `src/desktop/agent/`, `src/extension/agent/`, `src/server/agent/`)
 * which in turn calls `registerBundledPlugin(...)` per bundled def.
 *
 * Initial v1 set: empty. Files just need to exist as scaffolding for
 * future bundled additions.
 *
 * Reference: design.md § Persistence Model > Bundled-plugin registry +
 * § Storage and Config Wiring > Bundled plugin self-registration.
 */

import type { BundledPluginDefinition, LoadedPlugin, PluginId } from './types';

export const BUNDLED_MARKETPLACE_NAME = 'bundled';

const bundled = new Map<PluginId, BundledPluginDefinition>();

export function registerBundledPlugin(def: BundledPluginDefinition): void {
  const id = bundledIdFor(def.name);
  if (bundled.has(id)) {
    console.warn(`[BundledPluginRegistry] duplicate bundled plugin: ${id}`);
  }
  bundled.set(id, def);
}

export function getBundledPlugins(): BundledPluginDefinition[] {
  return Array.from(bundled.values()).filter((def) =>
    def.isAvailable ? def.isAvailable() : true,
  );
}

export function getBundledPluginById(id: PluginId): BundledPluginDefinition | undefined {
  return bundled.get(id);
}

export function bundledIdFor(name: string): PluginId {
  return `${name}@${BUNDLED_MARKETPLACE_NAME}`;
}

/** Project a bundled definition into a `LoadedPlugin` shape. */
export function toLoadedPlugin(def: BundledPluginDefinition): LoadedPlugin {
  return {
    id: bundledIdFor(def.name),
    manifest: def.manifest,
    path: BUNDLED_MARKETPLACE_NAME,
    source: { type: 'bundled' },
    scope: 'managed',
    isBuiltin: true,
    state: { status: 'disabled' },
  };
}

/** Test-only — clear all registered bundled plugins. */
export function _resetBundledPluginRegistryForTests(): void {
  bundled.clear();
}
