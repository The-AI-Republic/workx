import { STORE_KEY_PATHS, type StorageAdapter } from '../../../storage/StorageAdapter';

export class MemoryStorageAdapter implements StorageAdapter {
  readonly stores = new Map<string, Map<string, unknown>>();
  async initialize(): Promise<void> {}
  async get<T>(storeName: string, key: string): Promise<T | null> {
    return structuredClone(this.stores.get(storeName)?.get(key) as T | undefined) ?? null;
  }
  async put<T>(storeName: string, value: T): Promise<void> {
    const field = STORE_KEY_PATHS[storeName];
    const key = (value as Record<string, unknown>)[field];
    if (typeof key !== 'string') throw new Error(`Missing ${field} for ${storeName}`);
    const store = this.stores.get(storeName) ?? new Map<string, unknown>();
    store.set(key, structuredClone(value));
    this.stores.set(storeName, store);
  }
  async delete(storeName: string, key: string): Promise<boolean> {
    return this.stores.get(storeName)?.delete(key) ?? false;
  }
  async getAll<T>(storeName: string): Promise<T[]> {
    return [...(this.stores.get(storeName)?.values() ?? [])].map((value) => structuredClone(value as T));
  }
  async queryByIndex<T>(): Promise<T[]> { return []; }
  async batchDelete(storeName: string, keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) if (await this.delete(storeName, key)) count += 1;
    return count;
  }
  async clear(storeName: string): Promise<void> { this.stores.get(storeName)?.clear(); }
  async close(): Promise<void> {}
}
