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
import { isDesktopRuntimeProfile } from '@/runtime/profile';

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

// ============================================================================
// StorageProvider Singleton
// ============================================================================

let _storageProvider: StorageProvider | null = null;

/**
 * Set the global StorageProvider instance
 */
export function setStorageProvider(provider: StorageProvider): void {
  _storageProvider = provider;
}

/**
 * Get the global StorageProvider instance
 * @throws if not initialized
 */
export function getStorageProvider(): StorageProvider {
  if (!_storageProvider) {
    throw new Error('StorageProvider not initialized. Call initializeStorageProvider() first.');
  }
  return _storageProvider;
}

/**
 * Check if the StorageProvider has been initialized
 */
export function isStorageProviderInitialized(): boolean {
  return _storageProvider !== null;
}


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
  }
  if (__BUILD_MODE__ === 'desktop') {
    throw new Error('Desktop WebView storage is owned by the runtime sidecar. Use runtime services instead.');
  }
  if (__BUILD_MODE__ === 'server') {
    if (isDesktopRuntimeProfile()) {
      const { getDesktopRuntimeHost } = await import('@/desktop-runtime/host');
      const { DesktopRuntimeStorageProvider } = await import(
        '@/desktop-runtime/storage/DesktopRuntimeStorageProvider'
      );
      return new DesktopRuntimeStorageProvider(getDesktopRuntimeHost().storageDbPath);
    }
    const { getDataDir } = await import('@/server/config/server-config');
    const { ServerStorageProvider } = await import(
      '@/server/storage/ServerStorageProvider'
    );
    return new ServerStorageProvider(getDataDir());
  }
  throw new Error(`Unsupported build mode: ${__BUILD_MODE__}`);
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
  }
  if (__BUILD_MODE__ === 'desktop') {
    // Track 43: after the desktop cutover the WebView is no longer allowed to
    // open the OS keychain. Credentials live in the runtime sidecar (the
    // ControlFrameCredentialStore branch under `__BUILD_MODE__ === 'server'`
    // below). UIs that need auth state should call the `auth.*` runtime
    // services; UIs that need a per-key secret should ask the runtime.
    throw new Error(
      'WebView credentials are runtime-owned after Track 43; use auth.* runtime services instead of createCredentialStore() on desktop',
    );
  }
  if (__BUILD_MODE__ === 'server') {
    if (isDesktopRuntimeProfile()) {
      const { getDesktopRuntimeHost } = await import('@/desktop-runtime/host');
      const { ControlFrameCredentialStore } = await import(
        '@/desktop-runtime/credentials/ControlFrameCredentialStore'
      );
      const { getDesktopRuntimeControlBridge } = await import(
        '@/desktop-runtime/protocol/controlBridge'
      );
      const host = getDesktopRuntimeHost();
      return new ControlFrameCredentialStore(
        getDesktopRuntimeControlBridge().keychain,
        host.keychainServicePrefix ?? 'workx',
      );
    }
    const { getDataDir } = await import('@/server/config/server-config');
    const { FileCredentialStore } = await import(
      '@/server/storage/FileCredentialStore'
    );
    return new FileCredentialStore(getDataDir());
  }
  throw new Error(`Unsupported build mode for CredentialStore: ${__BUILD_MODE__}`);
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
  }
  if (__BUILD_MODE__ === 'desktop') {
    const { RuntimeRelayConfigStorageProvider } = await import(
      '@/desktop-runtime/storage/RuntimeRelayConfigStorageProvider'
    );
    return new RuntimeRelayConfigStorageProvider();
  }
  if (__BUILD_MODE__ === 'server') {
    if (isDesktopRuntimeProfile()) {
      const { getDesktopRuntimeHost } = await import('@/desktop-runtime/host');
      const { DesktopRuntimeConfigStorageProvider } = await import(
        '@/desktop-runtime/storage/DesktopRuntimeConfigStorageProvider'
      );
      return new DesktopRuntimeConfigStorageProvider(getDesktopRuntimeHost().configJsonPath);
    }
    const { getDataDir } = await import('@/server/config/server-config');
    const { FileConfigStorageProvider } = await import(
      '@/server/storage/FileConfigStorageProvider'
    );
    return new FileConfigStorageProvider(getDataDir());
  }
  if (__BUILD_MODE__ === 'web') {
    const { WebConfigStorage } = await import(
      '@/webfront/storage/WebConfigStorage'
    );
    return new WebConfigStorage();
  }
  throw new Error(`Unsupported build mode for ConfigStorage: ${__BUILD_MODE__}`);
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

/**
 * Initialize the StorageProvider for the current platform.
 * Should be called early in the app initialization.
 */
export async function initializeStorageProvider(): Promise<void> {
  const provider = await createStorageProvider();
  await provider.initialize();
  setStorageProvider(provider);
}
