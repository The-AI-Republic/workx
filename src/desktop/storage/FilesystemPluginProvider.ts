/**
 * FilesystemPluginProvider — disk-backed IPluginProvider for the desktop
 * (Tauri) runtime.
 *
 * The webview has no direct filesystem access; all disk I/O goes through
 * Rust `plugins_*` Tauri commands (tauri/src/plugins_commands.rs). Mirrors
 * `FilesystemSkillProvider`'s `invoke()` pattern and `NodePluginProvider`'s
 * semantics so the three providers behave identically.
 *
 * Layout: <root>/<pluginDir>/plugin.json per plugin. Root defaults to
 * `~/.browserx/plugins`. Slot loaders are path-based; this provider's
 * readFile/listDirs invoke the Rust commands so the loaders stay
 * platform-agnostic.
 *
 * Reference: design.md § Discovery and Platform Adapters + § Storage and
 * Config Wiring (writeFiles atomicity: staging-dir + rename).
 */

import { invoke } from '@tauri-apps/api/core';
import { PluginLoader } from '@/core/plugins/PluginLoader';
import type { IPluginProvider } from '@/core/plugins/PluginProvider';
import { PluginManifestSchema } from '@/core/plugins/PluginManifest';
import type {
  LoadedPlugin,
  PluginId,
  PluginManifest,
} from '@/core/plugins/types';

export class FilesystemPluginProvider implements IPluginProvider {
  private readonly root: string;
  private readonly loader: PluginLoader;
  /** pluginId → on-disk directory (resolved during listMeta/load). */
  private readonly idToDir = new Map<PluginId, string>();

  /** @param root e.g. `~/.browserx/plugins` (Rust expands the leading `~`). */
  constructor(root: string) {
    this.root = root;
    this.loader = new PluginLoader({
      readFile: (p) => this.readFile(p),
    });
  }

  async initialize(): Promise<void> {
    await invoke('plugins_ensure_dir', { path: this.root });
  }

  async listMeta(): Promise<PluginManifest[]> {
    const entries = await invoke<string[]>('plugins_list_entries', {
      path: this.root,
    });
    const out: PluginManifest[] = [];
    for (const entry of entries) {
      const dir = join(this.root, entry);
      const manifestPath = join(dir, 'plugin.json');
      const raw = await this.readFile(manifestPath);
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
      out.push(manifest);
      this.idToDir.set(`${manifest.name}@local`, dir);
    }
    return out;
  }

  async load(id: PluginId): Promise<LoadedPlugin> {
    let dir = this.idToDir.get(id);
    if (!dir) {
      await this.listMeta();
      dir = this.idToDir.get(id);
    }
    if (!dir) throw new Error(`plugin not found: ${id}`);
    const result = await this.loader.loadFromDir(dir, {
      source: { type: 'path', path: dir },
      scope: 'user',
      marketplace: 'local',
    });
    if ('error' in result) {
      throw new Error(`failed to load ${id}: ${JSON.stringify(result.error)}`);
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
    await invoke('plugins_remove_dir', { path: dir });
    this.idToDir.delete(id);
  }

  async writeFiles(
    id: PluginId,
    files: Array<{ path: string; content: Buffer | Uint8Array }>,
  ): Promise<void> {
    // Atomic: write to a staging dir, then rename into place (the Rust
    // `plugins_rename` clears any existing destination first).
    const finalDir = this.idToDir.get(id) ?? join(this.root, idToDirName(id));
    const stagingDir = `${finalDir}.staging-${Date.now()}`;
    try {
      for (const file of files) {
        const target = join(stagingDir, normalizeRel(file.path));
        await invoke('plugins_write_file', {
          path: target,
          content: decodeUtf8(file.content),
        });
      }
      await invoke('plugins_rename', { from: stagingDir, to: finalDir });
      this.idToDir.set(id, finalDir);
    } catch (e) {
      await invoke('plugins_remove_dir', { path: stagingDir }).catch(
        () => undefined,
      );
      throw e;
    }
  }

  getRoot(id: PluginId): string {
    return this.idToDir.get(id) ?? join(this.root, idToDirName(id));
  }

  /** Read a file via Rust. Returns null if absent. */
  readFile = async (path: string): Promise<string | null> => {
    return invoke<string | null>('plugins_read_file', { path });
  };

  /** List immediate entry names (files + dirs) via Rust; [] if missing. */
  listDirs = async (path: string): Promise<string[]> => {
    return invoke<string[]>('plugins_list_entries', { path });
  };
}

function idToDirName(id: PluginId): string {
  const at = id.indexOf('@');
  return at >= 0 ? id.substring(0, at) : id;
}

function normalizeRel(p: string): string {
  return p.replace(/^\.?\//, '').replace(/\\/g, '/');
}

function join(...parts: string[]): string {
  return parts
    .filter((p) => p != null && p.length > 0)
    .join('/')
    .replace(/([^:])\/{2,}/g, '$1/');
}

function decodeUtf8(content: Buffer | Uint8Array): string {
  if (typeof Buffer !== 'undefined' && content instanceof Buffer) {
    return content.toString('utf-8');
  }
  return new TextDecoder('utf-8').decode(content);
}
