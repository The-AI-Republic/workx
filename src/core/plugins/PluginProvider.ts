/**
 * IPluginProvider — platform-shaped plugin discovery + storage.
 *
 * One implementation per platform, mirroring the `ISkillProvider` pattern:
 *  - `FilesystemPluginProvider` (desktop, Tauri)
 *  - `IndexedDBPluginProvider` (extension, Chrome)
 *  - `NodePluginProvider` (server, Node.js)
 *
 * The provider is the on-disk (or virtual on-disk) layer. Enabled-state
 * lives in `agentConfig.enabledPlugins`, NOT in the provider — the
 * provider only knows about which plugins exist.
 *
 * Reference: design.md § Persistence Model + § Storage and Config Wiring.
 */

import type { LoadedPlugin, PluginId, PluginManifest } from './types';

export interface IPluginProvider {
  /** One-time initialization (e.g. create the plugins root dir on disk). */
  initialize(): Promise<void>;

  /**
   * Light-weight enumeration — returns just the manifests of every plugin
   * the provider can see, without resolving slot paths or constructing
   * `LoadedPlugin` records. Mirrors `ISkillProvider.listMeta()`.
   */
  listMeta(): Promise<PluginManifest[]>;

  /**
   * Full load — returns a `LoadedPlugin` with `state: { status: 'disabled' }`,
   * resolved slot paths, and the source descriptor. The registry sets the
   * state to `'enabled'` after slot loaders succeed.
   */
  load(id: PluginId): Promise<LoadedPlugin>;

  /** True if a plugin with this id exists in the provider's discovery roots. */
  exists(id: PluginId): Promise<boolean>;

  /**
   * Remove the plugin's on-disk files. Called by the uninstaller. The
   * caller is responsible for calling `PluginRegistry.disable` first.
   */
  remove(id: PluginId): Promise<void>;

  /**
   * Atomic install — either every file lands or none does. Used by the
   * Phase 10b installer.
   *
   * Implementation contract per platform:
   *  - Desktop/Server (filesystem): write to staging dir, fsync, rename.
   *  - Extension (IDB): wrap all puts in a single transaction; rollback
   *    is automatic on uncaught error.
   */
  writeFiles(
    id: PluginId,
    files: Array<{ path: string; content: Buffer | Uint8Array }>,
  ): Promise<void>;

  /**
   * On-disk root for this plugin, or the sentinel `'bundled'` for
   * bundled-plugin defs. Used by `${CLAUDE_PLUGIN_ROOT}` substitution.
   */
  getRoot(id: PluginId): string;
}
