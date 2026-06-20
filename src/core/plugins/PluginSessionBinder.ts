/**
 * PluginSessionBinder — applies plugin hook + sub-agent contributions to a
 * single session's per-session registries.
 *
 * Background: `HookRegistry` and `SubAgentRunner` are created per-session
 * (inside the platform `agentFactory`), but `PluginRegistry` is global.
 * Skills + MCP are globally reachable and handled by the global registry's
 * slot loaders directly; hooks + sub-agent types are not. A binder bridges
 * the gap for one session.
 *
 * Semantics (claudy parity, design § Q9 + § Active-Session Semantics):
 *  - At session creation, the binder applies every currently-enabled
 *    plugin's hook + agent slots to that session.
 *  - When a plugin is DISABLED, `PluginRegistry` prunes every live binder
 *    immediately (removals must be immediate — claudy gh-36995).
 *  - When a plugin is ENABLED mid-flight, existing sessions are NOT
 *    retro-injected (new-plugin hooks wait for a new session or an
 *    explicit `/plugin reload` — claudy's asymmetric design). New sessions
 *    created after the enable pick it up via `applyEnabledPlugins`.
 *
 * Commands are intentionally NOT bound per-session here — `PluginCommandLoader`
 * is a global storage class fed by the global `CommandSlotLoader`.
 */

import type { HookRegistry } from '@/core/hooks/HookRegistry';
import type { SubAgentRunner } from '@/tools/AgentTool/SubAgentRunner';
import { HookSlotLoader } from './loaders/HookSlotLoader';
import { SubAgentSlotLoader } from './loaders/SubAgentSlotLoader';
import type { FileReader, DirLister } from './loaders/SkillSlotLoader';
import type { LoadedPlugin, PluginError, PluginId } from './types';

export interface PluginSessionBinderDeps {
  hookRegistry: HookRegistry;
  subAgentRunner: SubAgentRunner;
  readFile: FileReader;
  listDirs: DirLister;
  /** Resolves user-config for a plugin (default: {}). */
  getUserConfig?: (id: PluginId) => Promise<Record<string, unknown>>;
}

export class PluginSessionBinder {
  private readonly hookSlot: HookSlotLoader;
  private readonly subAgentSlot: SubAgentSlotLoader;
  /** Plugins this binder has applied — so dispose/prune is exact. */
  private readonly applied = new Set<PluginId>();

  constructor(private readonly deps: PluginSessionBinderDeps) {
    this.hookSlot = new HookSlotLoader(deps.hookRegistry);
    this.subAgentSlot = new SubAgentSlotLoader({
      subAgentRunner: deps.subAgentRunner,
      readFile: deps.readFile,
      listDirs: deps.listDirs,
    });
  }

  /**
   * Apply the hook + agent slots of every currently-enabled plugin to
   * this session. Called once at session creation. Per-plugin errors are
   * collected, not thrown — one bad plugin shouldn't sink the session.
   */
  async applyEnabledPlugins(plugins: LoadedPlugin[]): Promise<PluginError[]> {
    const errors: PluginError[] = [];
    for (const plugin of plugins) {
      errors.push(...(await this.applyPlugin(plugin)));
    }
    return errors;
  }

  /**
   * Apply one plugin's hook + agent slots to this session. Idempotent —
   * HookSlotLoader.load does an atomic clear-then-register per plugin, and
   * SubAgentRunner.addType replaces by id.
   */
  async applyPlugin(plugin: LoadedPlugin): Promise<PluginError[]> {
    const errors: PluginError[] = [];
    const userConfig =
      (await this.deps.getUserConfig?.(plugin.id)) ?? {};

    if (plugin.manifest.hooks) {
      errors.push(...this.hookSlot.load(plugin));
    }
    if (plugin.manifest.agents) {
      errors.push(...(await this.subAgentSlot.load(plugin, userConfig)));
    }
    this.applied.add(plugin.id);
    return errors;
  }

  /**
   * Remove one plugin's hook + agent contributions from this session.
   * Called by `PluginRegistry.disable` across every live binder so a
   * disable takes effect immediately, even in already-running sessions.
   */
  async unloadPlugin(id: PluginId): Promise<void> {
    if (!this.applied.has(id)) return;
    this.hookSlot.unload(id);
    await this.subAgentSlot.unload(id);
    this.applied.delete(id);
  }

  /** Tear down — drop every plugin contribution this binder applied. */
  async dispose(): Promise<void> {
    for (const id of [...this.applied]) {
      await this.unloadPlugin(id);
    }
  }
}
