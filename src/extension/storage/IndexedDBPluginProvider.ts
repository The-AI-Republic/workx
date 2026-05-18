/**
 * IndexedDBPluginProvider — virtualized plugin store for the Chrome
 * extension (no real filesystem available).
 *
 * Each plugin is stored as ONE StorageProvider record:
 *   { id, manifest, files: Record<posixRelPath, utf8> }
 * A single `storageProvider.set` is the atomic write (IDB txn semantics) —
 * either the whole plugin lands or none of it does.
 *
 * Slot loaders are path-based and platform-agnostic, so the provider
 * exposes virtual-path `readFile` / `listDirs` resolvers. Virtual root:
 *   idb://plugins/<id>
 *   idb://plugins/<id>/plugin.json
 *   idb://plugins/<id>/skills/foo/SKILL.md
 *
 * An in-memory record cache avoids re-fetching the blob on every per-file
 * loader call.
 *
 * Reference: design.md § Persistence Model + § Storage and Config Wiring
 * (writeFiles atomicity: IDB single-record transaction).
 */

import type { StorageProvider } from '@/core/storage/StorageProvider';
import type { IPluginProvider } from '@/core/plugins/PluginProvider';
import { PluginLoader } from '@/core/plugins/PluginLoader';
import { PluginManifestSchema } from '@/core/plugins/PluginManifest';
import type {
  LoadedPlugin,
  PluginId,
  PluginManifest,
} from '@/core/plugins/types';

const COLLECTION = 'plugins';
const VIRTUAL_PREFIX = 'idb://plugins/';

interface StoredPlugin {
  id: PluginId;
  manifest: PluginManifest;
  /** POSIX relative paths → UTF-8 contents. Includes `plugin.json`. */
  files: Record<string, string>;
}

export class IndexedDBPluginProvider implements IPluginProvider {
  private readonly loader: PluginLoader;
  private readonly cache = new Map<PluginId, StoredPlugin>();

  constructor(private readonly storageProvider: StorageProvider) {
    this.loader = new PluginLoader({
      readFile: (p) => this.readFile(p),
    });
  }

  async initialize(): Promise<void> {
    // StorageProvider owns IDB init.
  }

  async listMeta(): Promise<PluginManifest[]> {
    const rows = await this.storageProvider.list<StoredPlugin>(COLLECTION);
    const out: PluginManifest[] = [];
    for (const row of rows) {
      this.cache.set(row.id, row);
      // Prefer the stored manifest, but re-validate against plugin.json
      // so a hand-edited record can't smuggle an invalid manifest.
      const raw = row.files['plugin.json'];
      if (raw == null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const result = PluginManifestSchema.safeParse(parsed);
      if (!result.success) continue;
      out.push(result.data as PluginManifest);
    }
    return out;
  }

  async load(id: PluginId): Promise<LoadedPlugin> {
    await this.ensureCached(id);
    const root = this.virtualRoot(id);
    const result = await this.loader.loadFromDir(root, {
      source: { type: 'path', path: root },
      scope: 'user',
      marketplace: 'local',
    });
    if ('error' in result) {
      throw new Error(`failed to load ${id}: ${JSON.stringify(result.error)}`);
    }
    return result.plugin;
  }

  async exists(id: PluginId): Promise<boolean> {
    if (this.cache.has(id)) return true;
    const row = await this.storageProvider.get<StoredPlugin>(COLLECTION, id);
    if (row) this.cache.set(id, row);
    return row !== null;
  }

  async remove(id: PluginId): Promise<void> {
    await this.storageProvider.delete(COLLECTION, id);
    this.cache.delete(id);
  }

  async writeFiles(
    id: PluginId,
    files: Array<{ path: string; content: Buffer | Uint8Array }>,
  ): Promise<void> {
    const fileMap: Record<string, string> = {};
    for (const f of files) {
      fileMap[normalizeRel(f.path)] = decodeUtf8(f.content);
    }
    // Parse the manifest from the incoming files (must be present).
    const rawManifest = fileMap['plugin.json'];
    if (rawManifest == null) {
      throw new Error(`writeFiles(${id}): missing plugin.json`);
    }
    const parsed = PluginManifestSchema.safeParse(JSON.parse(rawManifest));
    if (!parsed.success) {
      throw new Error(
        `writeFiles(${id}): invalid plugin.json: ${parsed.error.message}`,
      );
    }
    const record: StoredPlugin = {
      id,
      manifest: parsed.data as PluginManifest,
      files: fileMap,
    };
    // Single set = atomic (IDB transaction). All-or-nothing.
    await this.storageProvider.set(COLLECTION, id, record);
    this.cache.set(id, record);
  }

  getRoot(id: PluginId): string {
    return this.virtualRoot(id);
  }

  // ── Virtual-path resolvers (used by slot loaders + PluginLoader) ──

  /** Read a virtual file. Returns null if absent. */
  readFile = async (virtualPath: string): Promise<string | null> => {
    const parsed = this.parseVirtual(virtualPath);
    if (!parsed) return null;
    const row = await this.ensureCached(parsed.id);
    if (!row) return null;
    return row.files[parsed.rel] ?? null;
  };

  /** List immediate child segment names under a virtual dir. */
  listDirs = async (virtualPath: string): Promise<string[]> => {
    const parsed = this.parseVirtual(virtualPath);
    if (!parsed) return [];
    const row = await this.ensureCached(parsed.id);
    if (!row) return [];
    const prefix = parsed.rel ? `${parsed.rel}/` : '';
    const children = new Set<string>();
    for (const key of Object.keys(row.files)) {
      if (prefix && !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (seg) children.add(seg);
    }
    return [...children];
  };

  // ── Internals ─────────────────────────────────────────────────────

  private virtualRoot(id: PluginId): string {
    return `${VIRTUAL_PREFIX}${id}`;
  }

  private parseVirtual(virtualPath: string): { id: PluginId; rel: string } | null {
    if (!virtualPath.startsWith(VIRTUAL_PREFIX)) return null;
    const rest = virtualPath.slice(VIRTUAL_PREFIX.length);
    // id may contain '@'; rel starts after the first '/'
    const slash = rest.indexOf('/');
    if (slash < 0) return { id: rest, rel: '' };
    return { id: rest.slice(0, slash), rel: rest.slice(slash + 1) };
  }

  private async ensureCached(id: PluginId): Promise<StoredPlugin | null> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const row = await this.storageProvider.get<StoredPlugin>(COLLECTION, id);
    if (row) this.cache.set(id, row);
    return row;
  }
}

function normalizeRel(p: string): string {
  return p.replace(/^\.?\//, '').replace(/\\/g, '/');
}

function decodeUtf8(content: Buffer | Uint8Array): string {
  if (typeof Buffer !== 'undefined' && content instanceof Buffer) {
    return content.toString('utf-8');
  }
  return new TextDecoder('utf-8').decode(content);
}
