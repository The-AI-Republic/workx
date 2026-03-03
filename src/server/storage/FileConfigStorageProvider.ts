/**
 * File-based ConfigStorageProvider for server mode.
 * Stores config as a JSON file on disk, mirroring what Tauri's Rust backend
 * does for the desktop app.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

export class FileConfigStorageProvider implements ConfigStorageProvider {
  private readonly filePath: string;
  private data: Record<string, unknown>;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'config-storage.json');
    this.data = this.load();
  }

  private load(): Record<string, unknown> {
    try {
      if (existsSync(this.filePath)) {
        return JSON.parse(readFileSync(this.filePath, 'utf-8'));
      }
    } catch (error) {
      console.warn('[FileConfigStorage] Failed to read config file, starting fresh:', error);
    }
    return {};
  }

  private persist(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (error) {
      console.error('[FileConfigStorage] Failed to write config file:', error);
    }
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

  async getBytesInUse(_key?: string): Promise<number | null> {
    return null;
  }
}
