/**
 * PluginCommandLoader (Track 10)
 *
 * Holds plugin-contributed Command objects indexed by `pluginId`. Sits
 * alongside `BuiltinCommandLoader` and `SkillCommandLoader`; consumed by
 * `CommandLoader.loadAll()`.
 *
 * Phase 10a-1 ships the storage shape; Phase 10a-2's `CommandSlotLoader`
 * is what actually feeds it during plugin enable.
 *
 * Lifecycle:
 *   - `add(pluginId, commands)` — called by `CommandSlotLoader` when a plugin
 *     contributes commands during enable. Replaces any prior entries for
 *     that pluginId.
 *   - `removeByPluginId(pluginId)` — called by `PluginRegistry.disable(id)`.
 *   - `load()` — returns the flat union of all current plugin commands; the
 *     outer `CommandLoader` handles dedup + source-precedence ordering.
 *
 * All entries should already carry `loadedFrom: 'plugin'` and the
 * `<pluginName>:<bareName>` namespacing (set by `CommandSlotLoader`); this
 * loader is intentionally storage-only.
 */

import type { Command } from '../types';

export class PluginCommandLoader {
  private readonly byPluginId = new Map<string, Command[]>();

  /**
   * Replace the command set contributed by a plugin. Idempotent — calling
   * twice with the same pluginId overwrites the previous entries.
   */
  add(pluginId: string, commands: Command[]): void {
    this.byPluginId.set(pluginId, [...commands]);
  }

  /**
   * Scoped removal — drops every command owned by the given plugin.
   * No-op for unknown pluginIds.
   */
  removeByPluginId(pluginId: string): void {
    this.byPluginId.delete(pluginId);
  }

  /**
   * Returns the flat union of all plugin-contributed commands. Order is
   * insertion order across pluginIds; `CommandLoader.dedupeByName` handles
   * cross-source precedence (`builtin > skill > plugin`).
   */
  load(): Command[] {
    const out: Command[] = [];
    for (const list of this.byPluginId.values()) {
      out.push(...list);
    }
    return out;
  }

  /** Returns true if any plugin has contributed commands. */
  hasAny(): boolean {
    return this.byPluginId.size > 0;
  }

  /** Returns the set of plugin IDs that have contributed commands. */
  getPluginIds(): string[] {
    return Array.from(this.byPluginId.keys());
  }
}
