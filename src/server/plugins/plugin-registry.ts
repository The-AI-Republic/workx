/**
 * Plugin Registry
 *
 * Stores and queries registered channel plugins and their accounts.
 *
 * @module server/plugins/plugin-registry
 */

import type {
  ChannelPlugin,
  ChannelAccountSnapshot,
  OpenClawPluginDefinition,
} from './types';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface RegisteredPlugin {
  definition: OpenClawPluginDefinition;
  plugin: ChannelPlugin;
  accounts: Map<string, ChannelAccountSnapshot>;
}

// ─────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────

export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();

  /**
   * Register a channel plugin with its definition.
   */
  register(definition: OpenClawPluginDefinition, plugin: ChannelPlugin): void {
    this.plugins.set(plugin.id, {
      definition,
      plugin,
      accounts: new Map(),
    });
  }

  /**
   * Get a registered plugin by ID.
   */
  get(pluginId: string): RegisteredPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Get all registered plugins.
   */
  getAll(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Update account snapshot for a plugin.
   */
  updateAccountSnapshot(pluginId: string, snapshot: ChannelAccountSnapshot): void {
    const entry = this.plugins.get(pluginId);
    if (entry) {
      entry.accounts.set(snapshot.accountId, snapshot);
    }
  }

  /**
   * Get all account snapshots across all plugins.
   */
  getAllSnapshots(): ChannelAccountSnapshot[] {
    const snapshots: ChannelAccountSnapshot[] = [];
    for (const entry of this.plugins.values()) {
      for (const snapshot of entry.accounts.values()) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  /**
   * Remove a plugin from the registry.
   */
  unregister(pluginId: string): void {
    this.plugins.delete(pluginId);
  }

  /**
   * Get plugin count.
   */
  get size(): number {
    return this.plugins.size;
  }
}
