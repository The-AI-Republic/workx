/**
 * Storage Service Handlers
 *
 * Platform-agnostic service handlers for key-value storage.
 * Extracted from extension service-worker STORAGE_GET/SET handlers.
 *
 * @module core/services/storage-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

export interface StorageServiceDeps {
  storageProvider?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  configStorage?: ConfigStorageProvider;
}

export function createStorageServices(deps: StorageServiceDeps): Record<string, ServiceHandler> {
  const { storageProvider, configStorage } = deps;
  const handlers: Record<string, ServiceHandler> = {};

  if (storageProvider) {
    handlers['storage.get'] = async (params) => {
      const { key } = params as { key: string };
      return storageProvider.get(key);
    };

    handlers['storage.set'] = async (params) => {
      const { key, value } = params as { key: string; value: unknown };
      await storageProvider.set(key, value);
      return { success: true };
    };
  }

  if (configStorage) {
    handlers['configStorage.get'] = async (params) => {
      const { key } = params as { key: string };
      return configStorage.get(key);
    };

    handlers['configStorage.set'] = async (params) => {
      const { key, value } = params as { key: string; value: unknown };
      await configStorage.set(key, value);
      return { success: true };
    };

    handlers['configStorage.remove'] = async (params) => {
      const { key } = params as { key: string };
      await configStorage.remove(key);
      return { success: true };
    };

    handlers['configStorage.getMany'] = async (params) => {
      const { keys } = params as { keys: string[] };
      return configStorage.getMany(keys);
    };

    handlers['configStorage.setMany'] = async (params) => {
      const { items } = params as { items: Record<string, unknown> };
      await configStorage.setMany(items);
      return { success: true };
    };

    handlers['configStorage.removeMany'] = async (params) => {
      const { keys } = params as { keys: string[] };
      await configStorage.removeMany(keys);
      return { success: true };
    };

    handlers['configStorage.getAll'] = async () => configStorage.getAll();

    handlers['configStorage.clear'] = async () => {
      await configStorage.clear();
      return { success: true };
    };

    handlers['configStorage.getBytesInUse'] = async (params) => {
      const { key } = params as { key?: string };
      return configStorage.getBytesInUse(key);
    };
  }

  return handlers;
}
