/**
 * Plugins Service Handlers (Track 10)
 *
 * Platform-agnostic service surface for the `/plugin` slash command.
 * Backed by a `PluginRegistry`. Registered via `registerAllServices`
 * when a platform bootstrap provides `plugins` deps.
 *
 * Service paths:
 *   - plugins.list           → summary rows for `/plugin list`
 *   - plugins.info   { id }  → detail for `/plugin info <id>`
 *   - plugins.enable { id }  → enable + summary
 *   - plugins.disable{ id }  → disable + summary
 *   - plugins.reload         → reload + summary
 *
 * @module core/services/plugins-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { PluginRegistry } from '@/core/plugins/PluginRegistry';
import type { LoadedPlugin } from '@/core/plugins/types';
import { getPluginErrorMessage } from '@/core/plugins/PluginErrors';

export interface PluginsServiceDeps {
  pluginRegistry: PluginRegistry;
  /** Phase 10b — present when the runtime can fetch from marketplaces. */
  marketplaces?: import('@/core/plugins/MarketplaceRegistry').MarketplaceRegistry;
  installer?: import('@/core/plugins/PluginInstaller').PluginInstaller;
  uninstaller?: import('@/core/plugins/PluginInstaller').PluginUninstaller;
  /**
   * Phase 10c policy gate. When present, a policy-blocked plugin cannot be
   * runtime-enabled via `/plugin enable` (parity with the boot-time and
   * installer guards — without this, the block is bypassable at runtime).
   */
  isBlockedByPolicy?: (id: string) => boolean | Promise<boolean>;
}

/** Lightweight row for the `/plugin list` table. */
export interface PluginListRow {
  id: string;
  name: string;
  version: string;
  scope: string;
  status: string;
  errorVariant?: string;
}

/** Detail payload for `/plugin info <id>`. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  scope: string;
  status: string;
  source: string;
  capabilities: {
    skills: boolean;
    hooks: boolean;
    mcpServers: boolean;
    agents: boolean;
    commands: boolean;
  };
  loadErrors: string[];
}

function toRow(p: LoadedPlugin): PluginListRow {
  return {
    id: p.id,
    name: p.manifest.name,
    version: p.manifest.version,
    scope: p.scope,
    status: p.state.status,
    errorVariant:
      p.state.status === 'error' ? p.state.lastError.type : undefined,
  };
}

function describeSource(p: LoadedPlugin): string {
  const s = p.source;
  switch (s.type) {
    case 'github':
      return `github:${s.repo}${s.sha ? ` at ${s.sha.slice(0, 7)}` : ''}`;
    case 'git':
      return `git:${s.url}${s.sha ? ` at ${s.sha.slice(0, 7)}` : ''}`;
    case 'url':
      return `url:${s.url}`;
    case 'npm':
      return `npm:${s.package}`;
    case 'path':
      return `path:${s.path}`;
    case 'bundled':
      return 'bundled';
  }
}

function toInfo(p: LoadedPlugin): PluginInfo {
  return {
    id: p.id,
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description,
    scope: p.scope,
    status:
      p.state.status === 'error'
        ? `error (${p.state.lastError.type})`
        : p.state.status,
    source: describeSource(p),
    capabilities: {
      skills: p.manifest.skills != null,
      hooks: p.manifest.hooks != null,
      mcpServers: p.manifest.mcpServers != null,
      agents: p.manifest.agents != null,
      commands: p.manifest.commands != null,
    },
    loadErrors: (p.loadErrors ?? []).map(getPluginErrorMessage),
  };
}

export function createPluginsServices(
  deps: PluginsServiceDeps,
): Record<string, ServiceHandler> {
  const { pluginRegistry } = deps;

  return {
    'plugins.list': async () => {
      return pluginRegistry.getPlugins().map(toRow);
    },

    'plugins.info': async (params) => {
      const { id } = params as { id: string };
      const p = pluginRegistry.getPlugin(id);
      if (!p) {
        return { error: `plugin not found: ${id}` };
      }
      return toInfo(p);
    },

    'plugins.enable': async (params) => {
      const { id } = params as { id: string };
      try {
        if (deps.isBlockedByPolicy && (await deps.isBlockedByPolicy(id))) {
          return { success: false, error: `plugin ${id} is blocked by org policy` };
        }
        await pluginRegistry.enable(id);
        const p = pluginRegistry.getPlugin(id);
        return { success: true, plugin: p ? toRow(p) : null };
      } catch (e) {
        const p = pluginRegistry.getPlugin(id);
        return {
          success: false,
          error: e instanceof Error ? e.message : String(e),
          loadErrors: (p?.loadErrors ?? []).map(getPluginErrorMessage),
        };
      }
    },

    'plugins.disable': async (params) => {
      const { id } = params as { id: string };
      try {
        await pluginRegistry.disable(id);
        const p = pluginRegistry.getPlugin(id);
        return { success: true, plugin: p ? toRow(p) : null };
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },

    'plugins.reload': async () => {
      try {
        const result = await pluginRegistry.reload();
        return {
          success: true,
          enabled: result.enabled.map(toRow),
          disabled: result.disabled.map(toRow),
          errors: result.errors.map(getPluginErrorMessage),
        };
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },

    // ── Phase 10b: marketplace + install/uninstall ──────────────────

    'plugins.marketplace.add': async (params) => {
      if (!deps.marketplaces) {
        return { success: false, error: 'marketplaces not available on this runtime' };
      }
      const { url } = params as { url: string };
      const res = await deps.marketplaces.add(url);
      return res.ok
        ? { success: true, name: res.name }
        : { success: false, error: res.error };
    },

    'plugins.marketplace.list': async () => {
      return deps.marketplaces ? deps.marketplaces.list() : [];
    },

    'plugins.marketplace.remove': async (params) => {
      if (!deps.marketplaces) {
        return { success: false, error: 'marketplaces not available on this runtime' };
      }
      const { name } = params as { name: string };
      return { success: deps.marketplaces.remove(name) };
    },

    'plugins.install': async (params) => {
      if (!deps.installer) {
        return { success: false, error: 'plugin install not available on this runtime' };
      }
      const { id, scope } = params as { id: string; scope?: string };
      const res = await deps.installer.install(
        id,
        (scope as 'user' | 'project' | 'local') ?? 'user',
      );
      return res.ok
        ? { success: true, installed: res.installed }
        : { success: false, error: res.error };
    },

    'plugins.uninstall': async (params) => {
      if (!deps.uninstaller) {
        return { success: false, error: 'plugin uninstall not available on this runtime' };
      }
      const { id, scope } = params as { id: string; scope?: string };
      const res = await deps.uninstaller.uninstall(
        id,
        (scope as 'user' | 'project' | 'local') ?? 'user',
      );
      return res.ok ? { success: true } : { success: false, error: res.error };
    },
  };
}
