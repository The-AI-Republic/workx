import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

export class DesktopRuntimeConfigStorageProvider implements ConfigStorageProvider {
  private data: Record<string, unknown>;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  private load(): Record<string, unknown> {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        return raw.trim() ? JSON.parse(raw) : {};
      }
    } catch (error) {
      console.warn('[DesktopRuntimeConfigStorage] Failed to read config file:', error);
    }
    return {};
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.data[key] as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data[key] = value;
    this.persist();
  }

  async remove(key: string): Promise<void> {
    delete this.data[key];
    this.persist();
  }

  async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
    const result: Record<string, T> = {};
    for (const key of keys) {
      if (key in this.data) {
        result[key] = this.data[key] as T;
      }
    }
    return result;
  }

  async setMany<T = unknown>(items: Record<string, T>): Promise<void> {
    Object.assign(this.data, items);
    this.persist();
  }

  async removeMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      delete this.data[key];
    }
    this.persist();
  }

  async getAll(): Promise<Record<string, unknown>> {
    return { ...this.data };
  }

  async clear(): Promise<void> {
    this.data = {};
    this.persist();
  }

  async getBytesInUse(key?: string): Promise<number | null> {
    const value = key ? this.data[key] : this.data;
    if (value === undefined) return 0;
    return Buffer.byteLength(JSON.stringify(value), 'utf-8');
  }
}
