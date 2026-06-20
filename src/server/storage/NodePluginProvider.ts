/**
 * NodePluginProvider — filesystem-backed IPluginProvider for the server
 * (Node.js) runtime.
 *
 * Layout: `<root>/<pluginDir>/plugin.json` per plugin. `<root>` is supplied
 * by the platform bootstrap (server uses `~/.workx/plugins`, i.e.
 * `os.homedir()`). This is also the reference implementation
 * the desktop (Tauri) and extension (IDB) adapters mirror — kept dependency-
 * free (only Node `fs`/`path`) so it's unit-testable without platform plumbing.
 *
 * Reference: design.md § Persistence Model + § Discovery and Platform Adapters.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PluginLoader } from '@/core/plugins/PluginLoader';
import type { IPluginProvider } from '@/core/plugins/PluginProvider';
import type {
  LoadedPlugin,
  PluginId,
  PluginManifest,
} from '@/core/plugins/types';
import { PluginManifestSchema } from '@/core/plugins/PluginManifest';
import { assertSafeRelPath } from '@/core/plugins/pluginPath';

export class NodePluginProvider implements IPluginProvider {
  private readonly root: string;
  private readonly loader: PluginLoader;
  /** pluginId → on-disk directory (resolved during listMeta/load). */
  private readonly idToDir = new Map<PluginId, string>();

  constructor(root: string) {
    this.root = root;
    this.loader = new PluginLoader({
      readFile: (p) => this.readFileOrNull(p),
    });
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async listMeta(): Promise<PluginManifest[]> {
    const out: PluginManifest[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const dir = path.join(this.root, entry);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const manifestPath = path.join(dir, 'plugin.json');
      const raw = await this.readFileOrNull(manifestPath);
      if (raw == null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const result = PluginManifestSchema.safeParse(parsed);
      if (!result.success) continue;
      const manifest = result.data as PluginManifest;
      const pid: PluginId = `${manifest.name}@local`;
      const prior = this.idToDir.get(pid);
      if (prior !== undefined && prior !== dir) {
        console.warn(
          `[NodePluginProvider] duplicate plugin name "${manifest.name}": ` +
            `"${dir}" shadows "${prior}" (id ${pid})`,
        );
      }
      out.push(manifest);
      this.idToDir.set(pid, dir);
    }
    return out;
  }

  async load(id: PluginId): Promise<LoadedPlugin> {
    let dir = this.idToDir.get(id);
    if (!dir) {
      // Lazy resolve — refresh the id→dir map
      await this.listMeta();
      dir = this.idToDir.get(id);
    }
    if (!dir) {
      throw new Error(`plugin not found: ${id}`);
    }
    const result = await this.loader.loadFromDir(dir, {
      source: { type: 'path', path: dir },
      scope: 'user',
      marketplace: 'local',
    });
    if ('error' in result) {
      throw new Error(
        `failed to load ${id}: ${JSON.stringify(result.error)}`,
      );
    }
    return result.plugin;
  }

  async exists(id: PluginId): Promise<boolean> {
    if (this.idToDir.has(id)) return true;
    await this.listMeta();
    return this.idToDir.has(id);
  }

  async remove(id: PluginId): Promise<void> {
    const dir = this.idToDir.get(id);
    if (!dir) return;
    await fs.rm(dir, { recursive: true, force: true });
    this.idToDir.delete(id);
  }

  async writeFiles(
    id: PluginId,
    files: Array<{ path: string; content: Buffer | Uint8Array }>,
  ): Promise<void> {
    // Atomic-ish: write to a staging dir, then rename into place.
    const finalDir = this.idToDir.get(id) ?? path.join(this.root, idToDirName(id));
    const stagingDir = `${finalDir}.staging-${Date.now()}`;
    try {
      for (const file of files) {
        // SECURITY (Track 10): install payloads are untrusted; reject
        // absolute paths and `..` so an entry like
        // `"../../etc/cron.d/x"` cannot escape the staging dir.
        const safeRel = assertSafeRelPath(file.path);
        const target = path.join(stagingDir, safeRel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content);
      }
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(stagingDir, finalDir);
      this.idToDir.set(id, finalDir);
    } catch (e) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }

  getRoot(id: PluginId): string {
    return this.idToDir.get(id) ?? path.join(this.root, idToDirName(id));
  }

  private async readFileOrNull(p: string): Promise<string | null> {
    try {
      return await fs.readFile(p, 'utf-8');
    } catch {
      return null;
    }
  }
}

function idToDirName(id: PluginId): string {
  const at = id.indexOf('@');
  return at >= 0 ? id.substring(0, at) : id;
}
