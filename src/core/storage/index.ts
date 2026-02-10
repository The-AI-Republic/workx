/**
 * Storage Module
 *
 * Exports storage-related types and factory functions.
 *
 * @module core/storage
 */

import type { StorageProvider } from './StorageProvider';
import type { CredentialStore } from './CredentialStore';
import type { ConfigStorageProvider } from './ConfigStorageProvider';
import type { StorageFactoryOptions } from './types';

export type { StorageProvider } from './StorageProvider';
export type { CredentialStore } from './CredentialStore';
export {
  getCredentialStore,
  setCredentialStore,
  isCredentialStoreInitialized
} from './CredentialStore';
export type { ConfigStorageProvider } from './ConfigStorageProvider';
export {
  getConfigStorage,
  setConfigStorage,
  isConfigStorageInitialized
} from './ConfigStorageProvider';
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

/**
 * Create the appropriate ConfigStorageProvider for the current build mode.
 *
 * @returns ConfigStorageProvider instance
 *
 * @example
 * ```typescript
 * const configStorage = await createConfigStorage();
 * await configStorage.set('agent_config', { selectedModelKey: 'openai/gpt-4' });
 * const config = await configStorage.get('agent_config');
 * ```
 */
export async function createConfigStorage(): Promise<ConfigStorageProvider> {
  if (__BUILD_MODE__ === 'extension') {
    const { ChromeConfigStorage } = await import(
      '@/extension/storage/ChromeConfigStorage'
    );
    return new ChromeConfigStorage();
  } else {
    const { TauriConfigStorage } = await import(
      '@/desktop/storage/TauriConfigStorage'
    );
    return new TauriConfigStorage();
  }
}

/**
 * Initialize config storage for the current platform.
 * Should be called early in the app initialization.
 */
export async function initializeConfigStorage(): Promise<void> {
  const { setConfigStorage } = await import('./ConfigStorageProvider');
  const storage = await createConfigStorage();
  setConfigStorage(storage);
}

/**
 * Initialize credential storage for the current platform.
 * Should be called early in the app initialization.
 */
export async function initializeCredentialStore(): Promise<void> {
  const { setCredentialStore } = await import('./CredentialStore');
  const store = await createCredentialStore();
  setCredentialStore(store);
}
