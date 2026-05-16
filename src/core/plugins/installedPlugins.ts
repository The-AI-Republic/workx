/**
 * installed_plugins_v2 — on-disk record of materialized plugin installs.
 *
 * Distinct from `agentConfig.enabledPlugins` (intent: which plugins the
 * user wants on) — this tracks what's actually materialized on disk, per
 * scope, with the resolved version + git SHA + cache path. Mirrors claudy's
 * V2 shape (design § installed_plugins_v2.json schema).
 *
 * The store is platform-injected (read/write fns) so it works for Node,
 * Tauri, and the IDB-virtualized extension store identically.
 */

import { z } from 'zod';
import type { PluginId } from './types';

export type InstalledPluginScope = 'managed' | 'user' | 'project' | 'local';

export const InstalledPluginEntrySchema = z.object({
  scope: z.enum(['managed', 'user', 'project', 'local']),
  version: z.string(),
  installedAt: z.number(),
  lastUpdated: z.number(),
  installPath: z.string(),
  gitCommitSha: z.string().optional(),
  projectPath: z.string().optional(),
});
export type InstalledPluginEntry = z.infer<typeof InstalledPluginEntrySchema>;

export const InstalledPluginsFileV2Schema = z.object({
  version: z.literal(2),
  plugins: z.record(
    z.string(),
    z.object({ entries: z.array(InstalledPluginEntrySchema) }),
  ),
});
export type InstalledPluginsFileV2 = z.infer<typeof InstalledPluginsFileV2Schema>;

export function emptyInstalledPluginsFile(): InstalledPluginsFileV2 {
  return { version: 2, plugins: {} };
}

/**
 * Injected read/write so the store is platform-agnostic. `writeText`
 * should be atomic (tmp + rename) where the platform supports it.
 */
export interface InstalledPluginsStoreDeps {
  readText: (path: string) => Promise<string | null>;
  writeText: (path: string, content: string) => Promise<void>;
  /** Absolute path of installed_plugins_v2.json for this platform. */
  filePath: string;
}

export class InstalledPluginsStore {
  constructor(private readonly deps: InstalledPluginsStoreDeps) {}

  /** Read + validate. Falls back to empty on missing/corrupt (logs warn). */
  async read(): Promise<InstalledPluginsFileV2> {
    const raw = await this.deps.readText(this.deps.filePath);
    if (raw == null) return emptyInstalledPluginsFile();
    try {
      const parsed = InstalledPluginsFileV2Schema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        console.warn(
          '[InstalledPluginsStore] corrupt installed_plugins_v2; starting empty:',
          parsed.error.message,
        );
        return emptyInstalledPluginsFile();
      }
      return parsed.data;
    } catch (e) {
      console.warn('[InstalledPluginsStore] unparseable installed_plugins_v2:', e);
      return emptyInstalledPluginsFile();
    }
  }

  async write(file: InstalledPluginsFileV2): Promise<void> {
    await this.deps.writeText(this.deps.filePath, JSON.stringify(file, null, 2));
  }

  /** Add/replace an entry for a plugin in a given scope. */
  async addEntry(id: PluginId, entry: InstalledPluginEntry): Promise<void> {
    const file = await this.read();
    const bucket = file.plugins[id] ?? { entries: [] };
    bucket.entries = bucket.entries.filter((e) => e.scope !== entry.scope);
    bucket.entries.push(entry);
    file.plugins[id] = bucket;
    await this.write(file);
  }

  /**
   * Remove a plugin's entry for a scope. Returns true if it was the last
   * scope (caller then orphans the cache + wipes options).
   */
  async removeEntry(id: PluginId, scope: InstalledPluginScope): Promise<boolean> {
    const file = await this.read();
    const bucket = file.plugins[id];
    if (!bucket) return false;
    bucket.entries = bucket.entries.filter((e) => e.scope !== scope);
    if (bucket.entries.length === 0) {
      delete file.plugins[id];
      await this.write(file);
      return true;
    }
    file.plugins[id] = bucket;
    await this.write(file);
    return false;
  }

  async getEntries(id: PluginId): Promise<InstalledPluginEntry[]> {
    const file = await this.read();
    return file.plugins[id]?.entries ?? [];
  }
}
