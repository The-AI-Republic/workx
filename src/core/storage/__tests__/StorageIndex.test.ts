/**
 * Storage index module tests
 *
 * Tests for the factory functions in src/core/storage/index.ts:
 * - createStorageProvider
 * - createCredentialStore
 * - createConfigStorage
 * - initializeConfigStorage
 * - initializeCredentialStore
 * - re-exported singleton functions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dynamic imports used by the factory functions
const mockIndexedDBStorageProvider = vi.fn();
const mockChromeCredentialStore = vi.fn();
const mockChromeConfigStorage = vi.fn();
const mockRuntimeRelayConfigStorageProvider = vi.fn();

vi.mock('@/extension/storage/IndexedDBStorageProvider', () => ({
  IndexedDBStorageProvider: mockIndexedDBStorageProvider,
}));

vi.mock('@/extension/storage/ChromeCredentialStore', () => ({
  ChromeCredentialStore: mockChromeCredentialStore,
}));

// Track 43: KeytarCredentialStore is no longer a desktop dependency — the
// WebView is forbidden from opening the OS keychain. The desktop branch of
// `createCredentialStore` throws instead of constructing one.

vi.mock('@/extension/storage/ChromeConfigStorage', () => ({
  ChromeConfigStorage: mockChromeConfigStorage,
}));

vi.mock('@/desktop-runtime/storage/RuntimeRelayConfigStorageProvider', () => ({
  RuntimeRelayConfigStorageProvider: mockRuntimeRelayConfigStorageProvider,
}));

describe('Storage Index Module', () => {
  beforeEach(() => {
    vi.resetModules();
    mockIndexedDBStorageProvider.mockClear();
    mockChromeCredentialStore.mockClear();
    mockChromeConfigStorage.mockClear();
    mockRuntimeRelayConfigStorageProvider.mockClear();
  });

  describe('createStorageProvider', () => {
    it('should create IndexedDBStorageProvider in extension mode', async () => {
      const mockInstance = { initialize: vi.fn() };
      mockIndexedDBStorageProvider.mockImplementation(() => mockInstance);

      const { createStorageProvider } = await import('../index');
      const provider = await createStorageProvider();

      expect(mockIndexedDBStorageProvider).toHaveBeenCalled();
      expect(provider).toBe(mockInstance);
    });

    it('should accept optional options parameter', async () => {
      const mockInstance = { initialize: vi.fn() };
      mockIndexedDBStorageProvider.mockImplementation(() => mockInstance);

      const { createStorageProvider } = await import('../index');
      const provider = await createStorageProvider({ walMode: true });

      expect(provider).toBe(mockInstance);
    });
  });

  describe('createCredentialStore', () => {
    it('should create ChromeCredentialStore in extension mode', async () => {
      const mockInstance = { get: vi.fn(), set: vi.fn() };
      mockChromeCredentialStore.mockImplementation(() => mockInstance);

      const { createCredentialStore } = await import('../index');
      const store = await createCredentialStore();

      expect(mockChromeCredentialStore).toHaveBeenCalled();
      expect(store).toBe(mockInstance);
    });
  });

  describe('createConfigStorage', () => {
    it('should create ChromeConfigStorage in extension mode', async () => {
      const mockInstance = { get: vi.fn(), set: vi.fn() };
      mockChromeConfigStorage.mockImplementation(() => mockInstance);

      const { createConfigStorage } = await import('../index');
      const storage = await createConfigStorage();

      expect(mockChromeConfigStorage).toHaveBeenCalled();
      expect(storage).toBe(mockInstance);
    });
  });

  describe('initializeCredentialStore', () => {
    it('should create and set the global credential store', async () => {
      const mockInstance = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), listAccounts: vi.fn() };
      mockChromeCredentialStore.mockImplementation(() => mockInstance);

      const { initializeCredentialStore } = await import('../index');
      await initializeCredentialStore();

      // Verify it was created
      expect(mockChromeCredentialStore).toHaveBeenCalled();

      // Verify it was set as the global singleton
      const { getCredentialStore } = await import('../CredentialStore');
      expect(getCredentialStore()).toBe(mockInstance);
    });
  });

  describe('initializeConfigStorage', () => {
    it('should create and set the global config storage', async () => {
      const mockInstance = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
      mockChromeConfigStorage.mockImplementation(() => mockInstance);

      const { initializeConfigStorage } = await import('../index');
      await initializeConfigStorage();

      expect(mockChromeConfigStorage).toHaveBeenCalled();

      const { getConfigStorage } = await import('../ConfigStorageProvider');
      expect(getConfigStorage()).toBe(mockInstance);
    });
  });

  describe('re-exported singleton functions', () => {
    it('should re-export getCredentialStore', async () => {
      const indexModule = await import('../index');
      expect(typeof indexModule.getCredentialStore).toBe('function');
    });

    it('should re-export setCredentialStore', async () => {
      const indexModule = await import('../index');
      expect(typeof indexModule.setCredentialStore).toBe('function');
    });

    it('should re-export isCredentialStoreInitialized', async () => {
      const indexModule = await import('../index');
      expect(typeof indexModule.isCredentialStoreInitialized).toBe('function');
    });

    it('should re-export getConfigStorage', async () => {
      const indexModule = await import('../index');
      expect(typeof indexModule.getConfigStorage).toBe('function');
    });

    it('should re-export setConfigStorage', async () => {
      const indexModule = await import('../index');
      expect(typeof indexModule.setConfigStorage).toBe('function');
    });

    it('should re-export isConfigStorageInitialized', async () => {
      const indexModule = await import('../index');
      expect(typeof indexModule.isConfigStorageInitialized).toBe('function');
    });
  });

  describe('re-exported singleton behavior', () => {
    it('getCredentialStore should throw when not initialized', async () => {
      const { getCredentialStore } = await import('../index');
      expect(() => getCredentialStore()).toThrow('CredentialStore not initialized');
    });

    it('isCredentialStoreInitialized should return false initially', async () => {
      const { isCredentialStoreInitialized } = await import('../index');
      expect(isCredentialStoreInitialized()).toBe(false);
    });

    it('setCredentialStore then getCredentialStore should work', async () => {
      const { setCredentialStore, getCredentialStore, isCredentialStoreInitialized } = await import('../index');
      const mockStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), listAccounts: vi.fn() };

      setCredentialStore(mockStore);
      expect(isCredentialStoreInitialized()).toBe(true);
      expect(getCredentialStore()).toBe(mockStore);
    });

    it('getConfigStorage should throw when not initialized', async () => {
      const { getConfigStorage } = await import('../index');
      expect(() => getConfigStorage()).toThrow('ConfigStorage not initialized');
    });

    it('isConfigStorageInitialized should return false initially', async () => {
      const { isConfigStorageInitialized } = await import('../index');
      expect(isConfigStorageInitialized()).toBe(false);
    });

    it('setConfigStorage then getConfigStorage should work', async () => {
      const { setConfigStorage, getConfigStorage, isConfigStorageInitialized } = await import('../index');
      const mockStorage = {
        get: vi.fn(), set: vi.fn(), remove: vi.fn(), getMany: vi.fn(),
        setMany: vi.fn(), removeMany: vi.fn(), getAll: vi.fn(), clear: vi.fn(),
        getBytesInUse: vi.fn(),
      };

      setConfigStorage(mockStorage);
      expect(isConfigStorageInitialized()).toBe(true);
      expect(getConfigStorage()).toBe(mockStorage);
    });
  });
});
