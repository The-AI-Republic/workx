import type { ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';
import { getInitializedUIClient } from '@/core/messaging';

/**
 * Desktop WebView config provider backed by the runtime sidecar.
 *
 * The UI still uses the shared ConfigStorageProvider API, but persistence is
 * owned by the Node runtime so the WebView no longer calls Tauri storage
 * commands directly.
 */
export class RuntimeRelayConfigStorageProvider implements ConfigStorageProvider {
  private async request<T>(service: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = await getInitializedUIClient();
    return client.serviceRequest<T>(service, params);
  }

  async get<T>(key: string): Promise<T | null> {
    return this.request<T | null>('configStorage.get', { key });
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.request('configStorage.set', { key, value });
  }

  async remove(key: string): Promise<void> {
    await this.request('configStorage.remove', { key });
  }

  async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
    return this.request<Record<string, T>>('configStorage.getMany', { keys });
  }

  async setMany<T = unknown>(items: Record<string, T>): Promise<void> {
    await this.request('configStorage.setMany', { items });
  }

  async removeMany(keys: string[]): Promise<void> {
    await this.request('configStorage.removeMany', { keys });
  }

  async getAll(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('configStorage.getAll');
  }

  async clear(): Promise<void> {
    await this.request('configStorage.clear');
  }

  async getBytesInUse(key?: string): Promise<number | null> {
    return this.request<number | null>('configStorage.getBytesInUse', { key });
  }
}
