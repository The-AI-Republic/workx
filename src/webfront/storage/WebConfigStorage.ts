/**
 * Web Config Storage (localStorage-based)
 *
 * ConfigStorageProvider implementation for the web UI.
 * Uses browser localStorage with a key prefix to avoid collisions.
 *
 * @module webfront/storage/WebConfigStorage
 */

import type { ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

const PREFIX = 'workx:';

export class WebConfigStorage implements ConfigStorageProvider {
  async get<T>(key: string): Promise<T | null> {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    localStorage.removeItem(PREFIX + key);
  }

  async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
    const result: Record<string, T> = {};
    for (const key of keys) {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw) result[key] = JSON.parse(raw);
    }
    return result;
  }

  async setMany<T = unknown>(items: Record<string, T>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    }
  }

  async removeMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      localStorage.removeItem(PREFIX + key);
    }
  }

  async getAll(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const fullKey = localStorage.key(i);
      if (fullKey?.startsWith(PREFIX)) {
        const key = fullKey.slice(PREFIX.length);
        const raw = localStorage.getItem(fullKey);
        if (raw) result[key] = JSON.parse(raw);
      }
    }
    return result;
  }

  async clear(): Promise<void> {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  }

  async getBytesInUse(): Promise<number | null> {
    return null;
  }
}
