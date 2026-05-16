/**
 * HookSlotLoader — loads `manifest.hooks` into the agent's HookRegistry.
 *
 * Implements the Q9 atomic clear-then-register pattern (claudy
 * `loadPluginHooks.ts:138-148`, gh-29767 fix). The unregister and register
 * calls happen in one synchronous block; there's never a window where the
 * plugin's prior hooks are gone but its new ones aren't installed.
 *
 * Also exposes `pruneRemovedPlugins` — the removal-only sibling claudy
 * added to fix gh-36995. Used by reload paths so disabled-plugin hooks
 * stop firing immediately without waiting for the full reload signal.
 *
 * Reference: design.md § Q9 + § Loader-by-slot Wiring.
 */

import type { HookRegistry } from '@/core/hooks/HookRegistry';
import type { HooksConfig } from '@/core/hooks/types';
import type { LoadedPlugin, PluginError, PluginId } from '../types';

export class HookSlotLoader {
  constructor(private readonly hookRegistry: HookRegistry) {}

  /**
   * Atomic full swap for a single plugin. Synchronous block: unregister
   * the plugin's existing hooks, then register the new ones from the
   * manifest. No `await` between the two calls.
   *
   * Returns load errors (if any) for inclusion in `LoadedPlugin.loadErrors`;
   * does NOT throw — partial slot success is preferable to refusing the
   * whole plugin.
   */
  load(plugin: LoadedPlugin): PluginError[] {
    const errors: PluginError[] = [];
    const hooksConfig = this.collectHooksConfig(plugin);
    if (!hooksConfig) return errors;

    try {
      // Atomic clear-then-register — see class JSDoc.
      this.hookRegistry.unregisterBySource({ type: 'plugin', pluginId: plugin.id });
      this.hookRegistry.registerFromConfig(hooksConfig, {
        type: 'plugin',
        pluginId: plugin.id,
      });
    } catch (e) {
      errors.push({
        type: 'component-load-failed',
        pluginId: plugin.id,
        slot: 'hooks',
        cause: e instanceof Error ? e.message : String(e),
      });
    }
    return errors;
  }

  /**
   * Unload a plugin's hooks. Idempotent — safe to call when the plugin
   * has no hooks registered.
   */
  unload(pluginId: PluginId): void {
    this.hookRegistry.unregisterBySource({ type: 'plugin', pluginId });
  }

  /**
   * Removal-only sibling — drops every hook whose `source.pluginId` is
   * not in the set of currently-enabled plugin IDs. Adds nothing.
   *
   * Called from reload paths so newly-disabled-plugin hooks stop firing
   * immediately. Newly-ENABLED plugin hooks wait for the explicit reload
   * signal (correctness vs predictability asymmetry; claudy gh-36995).
   */
  pruneRemovedPlugins(enabledPluginIds: ReadonlySet<PluginId>): number {
    // Snapshot to avoid mutating while iterating
    const allHooks = this.hookRegistry.getAllHooks();
    let count = 0;
    for (const hooks of allHooks.values()) {
      for (const hook of hooks) {
        if (
          typeof hook.source === 'object' &&
          hook.source.type === 'plugin' &&
          !enabledPluginIds.has(hook.source.pluginId)
        ) {
          if (this.hookRegistry.unregister(hook.id)) count++;
        }
      }
    }
    return count;
  }

  /**
   * Resolve `manifest.hooks` into a single `HooksConfig` object. The
   * manifest slot accepts a single inline object, a single path string,
   * or an array of either — this normalizes to one merged config.
   *
   * Phase 10a-2: only inline objects are supported. Path-references
   * (loading from a `.hooks.json` file) is a Phase 10b enhancement that
   * requires platform-specific file reads via the provider.
   */
  private collectHooksConfig(plugin: LoadedPlugin): HooksConfig | null {
    const raw = plugin.manifest.hooks;
    if (raw == null) return null;
    if (typeof raw === 'string') {
      // Path reference — deferred to Phase 10b
      return null;
    }
    if (Array.isArray(raw)) {
      const merged: HooksConfig = {};
      for (const entry of raw) {
        if (typeof entry === 'string') continue; // path reference, deferred
        mergeHooksConfig(merged, entry);
      }
      return Object.keys(merged).length > 0 ? merged : null;
    }
    return raw;
  }
}

function mergeHooksConfig(dst: HooksConfig, src: HooksConfig): void {
  for (const [event, entries] of Object.entries(src)) {
    const existing = (dst as Record<string, unknown[]>)[event];
    if (Array.isArray(existing)) {
      existing.push(...entries);
    } else {
      (dst as Record<string, unknown[]>)[event] = [...entries];
    }
  }
}
