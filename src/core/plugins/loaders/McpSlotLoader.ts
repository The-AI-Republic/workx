/**
 * McpSlotLoader — loads `manifest.mcpServers` into `MCPManager`.
 *
 * Per-entry semantics:
 *  - Adds each server via `MCPManager.addServer({ ..., pluginId })`. The
 *    `pluginId` tags ownership for scoped removal on plugin disable.
 *  - **Duplicate-key handling**: if `MCPManager` already has a server with
 *    the same `name` (from any source), this loader emits
 *    `mcp-server-suppressed-duplicate` in the plugin's `loadErrors` and
 *    skips that one entry. The rest of the plugin's slots still load —
 *    one bad MCP entry doesn't kill the plugin.
 *
 * Substitution: `${user_config.KEY}` references in env / command / args
 * are resolved via the strict (throw-on-missing) variant — failure to
 * resolve becomes a `component-load-failed` error and the entry is
 * suppressed.
 *
 * Reference: design.md § Loader-by-slot Wiring + § User Config Substitution.
 */

import type { IMCPManager, IMCPServerConfig, IMCPServerConfigCreate } from '@/core/mcp/types';
import type { LoadedPlugin, PluginError, PluginId } from '../types';
import { substituteRuntime } from '../userConfigSubstitution';

export class McpSlotLoader {
  constructor(private readonly mcpManager: IMCPManager) {}

  /**
   * Load every MCP server entry from the manifest. Returns the per-entry
   * errors (suppressed duplicates, validation failures) — does NOT throw.
   */
  async load(
    plugin: LoadedPlugin,
    userConfig: Record<string, unknown>,
  ): Promise<PluginError[]> {
    const errors: PluginError[] = [];
    const entries = this.collectEntries(plugin);
    if (entries.length === 0) return errors;

    // Snapshot existing names (case-insensitive) for duplicate detection
    const existingNames = new Set(
      this.mcpManager.getServers().map((s) => s.name.toLowerCase()),
    );

    for (const [key, rawConfig] of entries) {
      if (existingNames.has(key.toLowerCase())) {
        errors.push({
          type: 'mcp-server-suppressed-duplicate',
          pluginId: plugin.id,
          key,
        });
        continue;
      }

      try {
        const resolved = this.resolveServerConfig(key, rawConfig, plugin, userConfig);
        await this.mcpManager.addServer({ ...resolved, pluginId: plugin.id });
        existingNames.add(key.toLowerCase());
      } catch (e) {
        errors.push({
          type: 'component-load-failed',
          pluginId: plugin.id,
          slot: 'mcpServers',
          cause: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return errors;
  }

  /**
   * Unload a plugin's MCP servers. Each removal disconnects before drop
   * (`MCPManager.removeServer` already does this).
   */
  async unload(pluginId: PluginId): Promise<void> {
    await this.mcpManager.removeByPluginId(pluginId);
  }

  /**
   * Collect per-server entries from the manifest slot. Accepts a single
   * record, an array of records, or path references (Phase 10b — deferred).
   */
  private collectEntries(
    plugin: LoadedPlugin,
  ): Array<[string, Partial<IMCPServerConfig>]> {
    const raw = plugin.manifest.mcpServers;
    if (raw == null) return [];

    const records: Array<Record<string, Partial<IMCPServerConfig>>> = [];
    if (typeof raw === 'string') {
      // Path reference — deferred to Phase 10b
      return [];
    } else if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry === 'string') continue; // path reference
        records.push(entry);
      }
    } else {
      records.push(raw);
    }

    const out: Array<[string, Partial<IMCPServerConfig>]> = [];
    for (const rec of records) {
      for (const [key, value] of Object.entries(rec)) {
        out.push([key, value]);
      }
    }
    return out;
  }

  /**
   * Build an `IMCPServerConfigCreate` from a manifest entry. Applies
   * substitution to string-typed fields (env values, command, args).
   * Plugin-installed servers are gated to user-explicit connect (so
   * `enabled: false` by default).
   */
  private resolveServerConfig(
    name: string,
    config: Partial<IMCPServerConfig>,
    plugin: LoadedPlugin,
    userConfig: Record<string, unknown>,
  ): IMCPServerConfigCreate {
    const sub = (v: string) => substituteRuntime(v, plugin, userConfig);

    return {
      name,
      url: typeof config.url === 'string' ? sub(config.url) : undefined,
      apiKey: typeof config.apiKey === 'string' ? sub(config.apiKey) : undefined,
      // Plugin-installed servers don't auto-connect — user explicitly connects
      // via /plugin info or the MCP UI. Mirrors claudy's plugin trust model.
      enabled: false,
      timeout: config.timeout,
      transport: config.transport,
      platform: config.platform,
      command: typeof config.command === 'string' ? sub(config.command) : undefined,
      args: Array.isArray(config.args) ? config.args.map((a) => (typeof a === 'string' ? sub(a) : a)) : undefined,
      env: config.env ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, sub(String(v))])) : undefined,
      cwd: typeof config.cwd === 'string' ? sub(config.cwd) : undefined,
    };
  }
}
