import type { ConfigStorageProvider } from '../../storage/ConfigStorageProvider';
import type { AppManifest } from '../types';

export class MemoryConfigStorage implements ConfigStorageProvider {
  private values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return this.values.has(key) ? this.clone(this.values.get(key)) as T : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, this.clone(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
    const result: Record<string, T> = {};
    for (const key of keys) {
      if (this.values.has(key)) {
        result[key] = this.clone(this.values.get(key)) as T;
      }
    }
    return result;
  }

  async setMany<T = unknown>(items: Record<string, T>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, this.clone(value));
    }
  }

  async removeMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.values.delete(key);
    }
  }

  async getAll(): Promise<Record<string, unknown>> {
    return Object.fromEntries(Array.from(this.values.entries()).map(([key, value]) => [key, this.clone(value)]));
  }

  async clear(): Promise<void> {
    this.values.clear();
  }

  async getBytesInUse(): Promise<number | null> {
    return JSON.stringify(Object.fromEntries(this.values)).length;
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }
}

export function makeManifest(overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    schemaVersion: 1,
    appId: 'com.example.linear',
    slug: 'linear',
    name: 'Linear',
    description: 'Search and update product issues.',
    version: '1.0.0',
    capabilities: ['Search issues', 'Create issues', 'Read project status'],
    runtime: {
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://mcp.linear.example/mcp',
      serverName: 'linear',
    },
    auth: {
      type: 'oauth2',
      provider: 'linear',
    },
    ...overrides,
  };
}
