/**
 * Storage Service Handlers
 *
 * Platform-agnostic service handlers for key-value storage.
 * Extracted from extension service-worker STORAGE_GET/SET handlers.
 *
 * @module core/services/storage-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface StorageServiceDeps {
  storageProvider: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
}

export function createStorageServices(deps: StorageServiceDeps): Record<string, ServiceHandler> {
  const { storageProvider } = deps;

  return {
    'storage.get': async (params) => {
      const { key } = params as { key: string };
      return storageProvider.get(key);
    },

    'storage.set': async (params) => {
      const { key, value } = params as { key: string; value: unknown };
      await storageProvider.set(key, value);
      return { success: true };
    },
  };
}
