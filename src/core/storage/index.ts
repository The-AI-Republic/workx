/**
 * Storage Module
 *
 * Exports storage-related types and factory functions.
 *
 * @module core/storage
 */

import type { StorageProvider } from './StorageProvider';
import type { CredentialStore } from './CredentialStore';
import type { StorageFactoryOptions } from './types';

export type { StorageProvider } from './StorageProvider';
export type { CredentialStore } from './CredentialStore';
export * from './types';

/**
 * Create the appropriate StorageProvider for the current build mode.
 *
 * @param options - Optional configuration options
 * @returns StorageProvider instance
 *
 * @example
 * ```typescript
 * const storage = await createStorageProvider();
 * await storage.initialize();
 * await storage.set('conversations', 'conv-1', { title: 'Hello' });
 * ```
 */
export async function createStorageProvider(
  options?: StorageFactoryOptions
): Promise<StorageProvider> {
  if (__BUILD_MODE__ === 'extension') {
    const { IndexedDBStorageProvider } = await import(
      '@/extension/storage/IndexedDBStorageProvider'
    );
    return new IndexedDBStorageProvider();
  } else {
    const { SQLiteStorageProvider } = await import(
      '@/desktop/storage/SQLiteStorageProvider'
    );
    return new SQLiteStorageProvider(options);
  }
}

/**
 * Create the appropriate CredentialStore for the current build mode.
 *
 * @returns CredentialStore instance
 *
 * @example
 * ```typescript
 * const credentials = await createCredentialStore();
 * await credentials.set('openai', 'default', 'sk-...');
 * ```
 */
export async function createCredentialStore(): Promise<CredentialStore> {
  if (__BUILD_MODE__ === 'extension') {
    const { ChromeCredentialStore } = await import(
      '@/extension/storage/ChromeCredentialStore'
    );
    return new ChromeCredentialStore();
  } else {
    const { KeytarCredentialStore } = await import(
      '@/desktop/storage/KeytarCredentialStore'
    );
    return new KeytarCredentialStore();
  }
}
