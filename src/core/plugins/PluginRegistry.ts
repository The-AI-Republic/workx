/**
 * PluginRegistry — orchestrator for plugin enable/disable lifecycle.
 *
 * Owns the in-memory `plugins` map, per-plugin serialization (Track 04
 * `tails` pattern), atomic 5-slot enable with rollback (log + don't
 * re-throw rollback failures), and the `reconcileFromConfig` path that
 * reacts to external `enabledPlugins` mutations.
 *
 * Reference: design.md § PluginRegistry Algorithm + § Active-Session
 * Semantics > "/plugin reload precise flow".
 */

import type { HookSlotLoader } from './loaders/HookSlotLoader';
import type { McpSlotLoader } from './loaders/McpSlotLoader';
import type { SkillSlotLoader } from './loaders/SkillSlotLoader';
import type { SubAgentSlotLoader } from './loaders/SubAgentSlotLoader';
import type { CommandSlotLoader } from './loaders/CommandSlotLoader';
import type { IPluginProvider } from './PluginProvider';
import { toPluginError } from './PluginErrors';
import type {
  LoadedPlugin,
  PluginError,
  PluginId,
  PluginLoadResult,
  PluginSlot,
} from './types';

export interface PluginRegistryDeps {
  provider: IPluginProvider;
  /**
   * Slot loaders. Each is optional so a platform can wire only the slots
   * it can support globally. A plugin that declares a slot whose loader
   * is absent gets an informational `component-load-failed` note (the
   * plugin still enables for its supported slots) — design principle:
   * "platform constraints surface as capability gaps, not load failures".
   *
   * Server v1 wires skills + mcp (globally reachable); hooks / agents /
   * commands are per-session and propagated via a follow-up.
   */
  skillSlot?: SkillSlotLoader;
  hookSlot?: HookSlotLoader;
  mcpSlot?: McpSlotLoader;
  subAgentSlot?: SubAgentSlotLoader;
  commandSlot?: CommandSlotLoader;
  /** Returns the persisted `enabledPlugins` map. */
  getEnabledFromConfig: () => Record<PluginId, boolean>;
  /** Persists a single plugin's enable state. */
  persistEnabled: (id: PluginId, enabled: boolean) => Promise<void>;
  /** Returns the user-config map for a plugin (Phase 10c integrates with credential store). */
  getUserConfig?: (id: PluginId) => Promise<Record<string, unknown>>;
  /**
   * Refuse-or-proceed gate consulted before destructive ops (reload,
   * uninstall). Returns null to proceed; returns an error message to refuse.
   * Phase 10a-2 plumbs this from `Session.listActiveTasks()` (see design
   * § Active-Session Semantics Rule 3).
   */
  checkDestructiveOpAllowed?: (op: 'reload' | 'uninstall', pluginId?: PluginId) => string | null;
}

/**
 * Minimal interface a per-session binder must satisfy so `PluginRegistry`
 * can prune it on disable. Implemented by `PluginSessionBinder`. Kept as a
 * structural type to avoid a core→core import cycle.
 */
export interface SessionBinderHandle {
  unloadPlugin(id: PluginId): Promise<void>;
}

export class PluginRegistry {
  private readonly plugins = new Map<PluginId, LoadedPlugin>();
  // Track 04 tails pattern — per-plugin promise chain for enable/disable serialization
  private readonly tails = new Map<PluginId, Promise<void>>();
  // Post-uninstall block — mirrors TaskOutputStore.evicted
  private readonly evicted = new Set<PluginId>();
  // Live per-session binders — for immediate disable propagation (claudy
  // gh-36995: removals must reach already-running sessions immediately).
  private readonly sessionBinders = new Set<SessionBinderHandle>();

  constructor(private readonly deps: PluginRegistryDeps) {}

  /**
   * Register a per-session binder. Called by the platform agentFactory
   * when a session is created. Returns an unregister fn for session teardown.
   */
  registerSessionBinder(binder: SessionBinderHandle): () => void {
    this.sessionBinders.add(binder);
    return () => this.sessionBinders.delete(binder);
  }

  /** Read-only snapshot of all known plugins. */
  getPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** Get a single plugin by id. */
  getPlugin(id: PluginId): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  /** Register a discovered plugin (called by bootstrap after `provider.listMeta`). */
  register(plugin: LoadedPlugin): void {
    this.plugins.set(plugin.id, plugin);
  }

  /** True if a plugin is currently in `state.status === 'enabled'`. */
  isEnabled(id: PluginId): boolean {
    return this.plugins.get(id)?.state.status === 'enabled';
  }

  /**
   * Enable a plugin — atomic 5-slot load with reverse-order rollback on
   * partial failure. Rollback errors are logged to `plugin.loadErrors`
   * but never re-thrown — the original error is what surfaces.
   */
  async enable(id: PluginId): Promise<void> {
    if (this.evicted.has(id)) {
      throw new Error(`plugin ${id} has been uninstalled — re-install to re-enable`);
    }
    return this.serialize(id, async () => {
      const plugin = this.plugins.get(id);
      if (!plugin) throw new Error(`plugin not found: ${id}`);
      if (plugin.state.status === 'enabled') return;

      plugin.state = { status: 'enabling', startedAt: Date.now() };
      const userConfig = (await this.deps.getUserConfig?.(id)) ?? {};

      const completed: PluginSlot[] = [];
      try {
        // Phase 10a-2 ordering: skills → hooks → mcp → agents → commands.
        // No formal dependencies between slots; ordering is deterministic
        // for debugging. Errors per slot accumulate in plugin.loadErrors;
        // a thrown error from a slot triggers rollback. A declared slot
        // whose loader is absent on this platform records an informational
        // capability-gap note but does NOT fail the enable.
        if (plugin.manifest.skills) {
          if (this.deps.skillSlot) {
            appendErrors(plugin, await this.deps.skillSlot.load(plugin, userConfig));
            completed.push('skills');
          } else {
            appendErrors(plugin, [unsupportedSlot(id, 'skills')]);
          }
        }
        if (plugin.manifest.hooks) {
          if (this.deps.hookSlot) {
            appendErrors(plugin, this.deps.hookSlot.load(plugin));
            completed.push('hooks');
          } else {
            appendErrors(plugin, [unsupportedSlot(id, 'hooks')]);
          }
        }
        if (plugin.manifest.mcpServers) {
          if (this.deps.mcpSlot) {
            appendErrors(plugin, await this.deps.mcpSlot.load(plugin, userConfig));
            completed.push('mcpServers');
          } else {
            appendErrors(plugin, [unsupportedSlot(id, 'mcpServers')]);
          }
        }
        if (plugin.manifest.agents) {
          if (this.deps.subAgentSlot) {
            appendErrors(plugin, await this.deps.subAgentSlot.load(plugin, userConfig));
            completed.push('agents');
          } else {
            appendErrors(plugin, [unsupportedSlot(id, 'agents')]);
          }
        }
        if (plugin.manifest.commands) {
          if (this.deps.commandSlot) {
            appendErrors(plugin, await this.deps.commandSlot.load(plugin, userConfig));
            completed.push('commands');
          } else {
            appendErrors(plugin, [unsupportedSlot(id, 'commands')]);
          }
        }

        plugin.state = {
          status: 'enabled',
          enabledAt: Date.now(),
          activeSlots: completed,
        };
        await this.deps.persistEnabled(id, true);
      } catch (e) {
        // Rollback in reverse order. Per design § PluginRegistry Algorithm:
        // log rollback failures, don't re-throw — original error surfaces.
        for (const slot of [...completed].reverse()) {
          try {
            await this.unloadSlot(plugin, slot);
          } catch (rollbackErr) {
            console.error(
              `[PluginRegistry] rollback ${id}/${slot} failed:`,
              rollbackErr,
            );
            appendErrors(plugin, [
              {
                type: 'component-load-failed',
                pluginId: id,
                slot,
                cause: `rollback failed: ${
                  rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
                }`,
              },
            ]);
          }
        }
        const pluginError = toPluginError(e, id);
        plugin.state = { status: 'error', lastError: pluginError, failedAt: Date.now() };
        appendErrors(plugin, [pluginError]);
        throw e;
      }
    });
  }

  /**
   * Disable a plugin — reverse-order slot unload. Per-slot errors are
   * logged and don't halt the loop.
   */
  async disable(id: PluginId): Promise<void> {
    return this.serialize(id, async () => {
      const plugin = this.plugins.get(id);
      if (!plugin) return;
      if (plugin.state.status !== 'enabled') return;

      plugin.state = { status: 'disabling', startedAt: Date.now() };

      const slots: PluginSlot[] = ['commands', 'agents', 'mcpServers', 'hooks', 'skills'];
      for (const slot of slots) {
        try {
          await this.unloadSlot(plugin, slot);
        } catch (e) {
          console.warn(`[PluginRegistry] disable ${id}/${slot}:`, e);
        }
      }

      // Propagate the removal to every live per-session binder immediately.
      // claudy gh-36995: disabled-plugin hooks/agents must stop firing in
      // already-running sessions right away (asymmetric with enable, which
      // only affects new sessions).
      for (const binder of this.sessionBinders) {
        await binder.unloadPlugin(id).catch((e) =>
          console.warn(`[PluginRegistry] binder unload ${id}:`, e),
        );
      }

      plugin.state = { status: 'disabled' };
      await this.deps.persistEnabled(id, false);
    });
  }

  /**
   * Bootstrap-time enable: read `enabledPlugins` from settings and
   * sequentially enable each (deterministic by lex sort for debuggability).
   */
  async bootstrapEnabledPlugins(): Promise<PluginLoadResult> {
    const cfg = this.deps.getEnabledFromConfig();
    const toEnable = Object.keys(cfg)
      .filter((id) => cfg[id] === true && this.plugins.has(id))
      .sort();

    const errors: PluginError[] = [];
    for (const id of toEnable) {
      try {
        await this.enable(id);
      } catch (e) {
        console.warn(`[PluginRegistry.bootstrap] enable ${id} failed:`, e);
        errors.push(toPluginError(e, id));
      }
    }
    return this.buildResult(errors);
  }

  /**
   * Reload — drain locks, disable all enabled, re-scan via the provider,
   * re-enable previously enabled. Refuses with a descriptive error if
   * any background task is using a plugin sub-agent type.
   */
  async reload(): Promise<PluginLoadResult> {
    if (this.deps.checkDestructiveOpAllowed) {
      const refusal = this.deps.checkDestructiveOpAllowed('reload');
      if (refusal) throw new Error(refusal);
    }

    await Promise.all(Array.from(this.tails.values()).map((p) => p.catch(() => undefined)));

    const previouslyEnabled = Array.from(this.plugins.values())
      .filter((p) => p.state.status === 'enabled')
      .map((p) => p.id);

    for (const id of previouslyEnabled) {
      try {
        await this.disable(id);
      } catch (e) {
        console.warn(`[PluginRegistry.reload] disable ${id} failed:`, e);
      }
    }

    // Re-scan via provider. Preserve plugins the provider can't re-supply
    // (bundled / admin-managed) — clearing unconditionally would silently
    // drop them on every reload, since only provider-discovered plugins
    // get re-registered below.
    const nonProvider = Array.from(this.plugins.values()).filter(
      (p) => p.source.type === 'bundled' || p.scope === 'managed',
    );
    this.plugins.clear();
    for (const p of nonProvider) this.plugins.set(p.id, p);
    const manifests = await this.deps.provider.listMeta();
    for (const manifest of manifests) {
      try {
        // Filesystem providers key ids as `<name>@local` in v1. Marketplace-
        // aware id reconstruction is a Phase 10b concern (see design § 10b).
        const loaded = await this.deps.provider.load(`${manifest.name}@local`);
        this.register(loaded);
      } catch (e) {
        console.warn(`[PluginRegistry.reload] load ${manifest.name} failed:`, e);
      }
    }

    const errors: PluginError[] = [];
    for (const id of previouslyEnabled) {
      if (!this.plugins.has(id)) continue;
      try {
        await this.enable(id);
      } catch (e) {
        errors.push(toPluginError(e, id));
      }
    }

    // Asymmetric prune: hooks whose pluginId is no longer in the registry
    // should be removed even if their plugin disappeared mid-flight.
    this.deps.hookSlot?.pruneRemovedPlugins(new Set(this.plugins.keys()));

    return this.buildResult(errors);
  }

  /**
   * Diff `enabledPlugins` from settings vs current `plugins.state` and
   * issue enable/disable calls. Used by the `agentConfig` change-event
   * subscriber so external mutations propagate.
   */
  async reconcileFromConfig(): Promise<void> {
    const cfg = this.deps.getEnabledFromConfig();
    for (const [id, want] of Object.entries(cfg)) {
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      const isOn = plugin.state.status === 'enabled';
      if (want === true && !isOn) {
        await this.enable(id).catch((e) =>
          console.warn(`[PluginRegistry.reconcile] enable ${id}:`, e),
        );
      } else if (want === false && isOn) {
        await this.disable(id).catch((e) =>
          console.warn(`[PluginRegistry.reconcile] disable ${id}:`, e),
        );
      }
    }
  }

  /**
   * Mark a plugin uninstalled — Phase 10b uninstaller calls this after
   * disabling and removing files. Blocks re-enable until process restart.
   */
  markEvicted(id: PluginId): void {
    this.evicted.add(id);
    this.plugins.delete(id);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async unloadSlot(plugin: LoadedPlugin, slot: PluginSlot): Promise<void> {
    switch (slot) {
      case 'skills':
        await this.deps.skillSlot?.unload(plugin.id);
        break;
      case 'hooks':
        this.deps.hookSlot?.unload(plugin.id);
        break;
      case 'mcpServers':
        await this.deps.mcpSlot?.unload(plugin.id);
        break;
      case 'agents':
        await this.deps.subAgentSlot?.unload(plugin.id);
        break;
      case 'commands':
        this.deps.commandSlot?.unload(plugin.id);
        break;
    }
  }

  /**
   * Per-plugin promise chain — Track 04 TaskOutputStore.tails pattern.
   * `.then(fn, fn)` ensures a prior failure doesn't poison the chain.
   */
  private async serialize(id: PluginId, fn: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const tail = prev.then(fn, fn);
    this.tails.set(
      id,
      tail.then(
        () => undefined,
        () => undefined,
      ),
    );
    return tail;
  }

  private buildResult(externalErrors: PluginError[] = []): PluginLoadResult {
    const enabled: LoadedPlugin[] = [];
    const disabled: LoadedPlugin[] = [];
    const errors: PluginError[] = [...externalErrors];
    for (const p of this.plugins.values()) {
      if (p.state.status === 'enabled') enabled.push(p);
      else disabled.push(p);
      if (p.loadErrors) errors.push(...p.loadErrors);
    }
    return { enabled, disabled, errors };
  }
}

function appendErrors(plugin: LoadedPlugin, errors: PluginError[]): void {
  if (errors.length === 0) return;
  plugin.loadErrors = plugin.loadErrors ?? [];
  plugin.loadErrors.push(...errors);
}

/**
 * Informational capability-gap note for a declared slot whose loader is
 * not wired on this platform. Surfaced via `/plugin info` so the user
 * understands why (e.g.) a plugin's hooks aren't firing on the server.
 * Does NOT fail the enable — other slots still load.
 */
function unsupportedSlot(id: PluginId, slot: PluginSlot): PluginError {
  return {
    type: 'component-load-failed',
    pluginId: id,
    slot,
    cause: `slot "${slot}" is not supported on this platform (capability gap, not a failure)`,
  };
}
