import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

/**
 * Path-compatible config provider over the existing desktop `config.json`.
 *
 * Durability rules (this file is the user's real, pre-existing config):
 * - Writes are atomic: serialize to a temp file in the same directory, then
 *   rename over the target, so a crash mid-write cannot truncate config.json.
 * - Every operation re-reads from disk first, so a concurrent runtime instance
 *   is not clobbered by a stale in-memory snapshot.
 */
export class DesktopRuntimeConfigStorageProvider implements ConfigStorageProvider {
  private data: Record<string, unknown>;

  constructor(private readonly filePath: string) {
    this.data = this.read();
  }

  private read(): Record<string, unknown> {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      }
    } catch (error) {
      console.warn('[DesktopRuntimeConfigStorage] Failed to read config file:', error);
    }
    return {};
  }

  /** Re-read from disk so concurrent external writes are not lost on the next write. */
  private refresh(): void {
    this.data = this.read();
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = join(dir, `.${process.pid}.${Date.now()}.config.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    renameSync(tmp, this.filePath);
  }

  async get<T>(key: string): Promise<T | null> {
    this.refresh();
    return (this.data[key] as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.refresh();
    this.data[key] = value;
    this.persist();
  }

  async remove(key: string): Promise<void> {
    this.refresh();
    delete this.data[key];
    this.persist();
  }

  async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
    this.refresh();
    const result: Record<string, T> = {};
    for (const key of keys) {
      if (key in this.data) {
        result[key] = this.data[key] as T;
      }
    }
    return result;
  }

  async setMany<T = unknown>(items: Record<string, T>): Promise<void> {
    this.refresh();
    Object.assign(this.data, items);
    this.persist();
  }

  async removeMany(keys: string[]): Promise<void> {
    this.refresh();
    for (const key of keys) {
      delete this.data[key];
    }
    this.persist();
  }

  async getAll(): Promise<Record<string, unknown>> {
    this.refresh();
    return { ...this.data };
  }

  async clear(): Promise<void> {
    this.data = {};
    this.persist();
  }

  async getBytesInUse(key?: string): Promise<number | null> {
    this.refresh();
    const value = key ? this.data[key] : this.data;
    if (value === undefined) return 0;
    return Buffer.byteLength(JSON.stringify(value), 'utf-8');
  }
}
