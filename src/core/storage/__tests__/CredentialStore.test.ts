/**
 * CredentialStore singleton management tests
 *
 * Tests for getCredentialStore, setCredentialStore, and isCredentialStoreInitialized.
 * Also tests the ChromeCredentialStore implementation via the chrome.storage.local mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to re-import fresh module state for each test group since
// the singleton is module-level state. Use dynamic imports.

describe('CredentialStore Singleton', () => {
  // Import fresh copy for each test to reset module state
  let getCredentialStore: typeof import('../CredentialStore').getCredentialStore;
  let setCredentialStore: typeof import('../CredentialStore').setCredentialStore;
  let isCredentialStoreInitialized: typeof import('../CredentialStore').isCredentialStoreInitialized;

  beforeEach(async () => {
    // Reset module cache to get fresh singleton state
    vi.resetModules();
    const mod = await import('../CredentialStore');
    getCredentialStore = mod.getCredentialStore;
    setCredentialStore = mod.setCredentialStore;
    isCredentialStoreInitialized = mod.isCredentialStoreInitialized;
  });

  describe('isCredentialStoreInitialized', () => {
    it('should return false when not initialized', () => {
      expect(isCredentialStoreInitialized()).toBe(false);
    });

    it('should return true after setting a store', () => {
      const mockStore = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        listAccounts: vi.fn(),
      };
      setCredentialStore(mockStore);
      expect(isCredentialStoreInitialized()).toBe(true);
    });
  });

  describe('getCredentialStore', () => {
    it('should throw when not initialized', () => {
      expect(() => getCredentialStore()).toThrow(
        'CredentialStore not initialized. Call initializeCredentialStore() first.'
      );
    });

    it('should return the store after initialization', () => {
      const mockStore = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        listAccounts: vi.fn(),
      };
      setCredentialStore(mockStore);
      expect(getCredentialStore()).toBe(mockStore);
    });

    it('should return the same instance on repeated calls', () => {
      const mockStore = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        listAccounts: vi.fn(),
      };
      setCredentialStore(mockStore);
      const first = getCredentialStore();
      const second = getCredentialStore();
      expect(first).toBe(second);
    });
  });

  describe('setCredentialStore', () => {
    it('should set the credential store instance', () => {
      const mockStore = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        listAccounts: vi.fn(),
      };
      setCredentialStore(mockStore);
      expect(getCredentialStore()).toBe(mockStore);
    });

    it('should allow replacing an existing store', () => {
      const store1 = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        listAccounts: vi.fn(),
      };
      const store2 = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        listAccounts: vi.fn(),
      };
      setCredentialStore(store1);
      expect(getCredentialStore()).toBe(store1);

      setCredentialStore(store2);
      expect(getCredentialStore()).toBe(store2);
    });
  });
});

describe('ChromeCredentialStore', () => {
  let ChromeCredentialStore: any;
  let store: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/extension/storage/ChromeCredentialStore');
    ChromeCredentialStore = mod.ChromeCredentialStore;
    store = new ChromeCredentialStore();
  });

  describe('get', () => {
    it('should return null when credential does not exist', async () => {
      const result = await store.get('openai', 'default');
      expect(result).toBeNull();
    });

    it('should return stored credential value', async () => {
      // Pre-populate storage
      await chrome.storage.local.set({ 'browserx-credential:openai:default': 'sk-test123' });
      const result = await store.get('openai', 'default');
      expect(result).toBe('sk-test123');
    });

    it('should use correct key format', async () => {
      await chrome.storage.local.set({ 'browserx-credential:anthropic:user@test.com': 'key-abc' });
      const result = await store.get('anthropic', 'user@test.com');
      expect(result).toBe('key-abc');
    });

    it('should return null for wrong account', async () => {
      await chrome.storage.local.set({ 'browserx-credential:openai:account1': 'key1' });
      const result = await store.get('openai', 'account2');
      expect(result).toBeNull();
    });

    it('should return null for wrong service', async () => {
      await chrome.storage.local.set({ 'browserx-credential:openai:default': 'key1' });
      const result = await store.get('anthropic', 'default');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('should store a credential', async () => {
      await store.set('openai', 'default', 'sk-mykey');
      const data = await chrome.storage.local.get('browserx-credential:openai:default');
      expect(data['browserx-credential:openai:default']).toBe('sk-mykey');
    });

    it('should overwrite an existing credential', async () => {
      await store.set('openai', 'default', 'old-key');
      await store.set('openai', 'default', 'new-key');
      const result = await store.get('openai', 'default');
      expect(result).toBe('new-key');
    });

    it('should store credentials for different services independently', async () => {
      await store.set('openai', 'default', 'openai-key');
      await store.set('anthropic', 'default', 'anthropic-key');

      const openai = await store.get('openai', 'default');
      const anthropic = await store.get('anthropic', 'default');
      expect(openai).toBe('openai-key');
      expect(anthropic).toBe('anthropic-key');
    });

    it('should store credentials for different accounts independently', async () => {
      await store.set('openai', 'account1', 'key1');
      await store.set('openai', 'account2', 'key2');

      const result1 = await store.get('openai', 'account1');
      const result2 = await store.get('openai', 'account2');
      expect(result1).toBe('key1');
      expect(result2).toBe('key2');
    });
  });

  describe('delete', () => {
    it('should remove a stored credential', async () => {
      await store.set('openai', 'default', 'sk-mykey');
      await store.delete('openai', 'default');
      const result = await store.get('openai', 'default');
      expect(result).toBeNull();
    });

    it('should not throw when deleting non-existent credential', async () => {
      await expect(store.delete('nonexistent', 'nope')).resolves.toBeUndefined();
    });

    it('should not affect other credentials', async () => {
      await store.set('openai', 'account1', 'key1');
      await store.set('openai', 'account2', 'key2');
      await store.delete('openai', 'account1');

      const result1 = await store.get('openai', 'account1');
      const result2 = await store.get('openai', 'account2');
      expect(result1).toBeNull();
      expect(result2).toBe('key2');
    });
  });

  describe('listAccounts', () => {
    it('should return empty array when no accounts exist', async () => {
      const accounts = await store.listAccounts('openai');
      expect(accounts).toEqual([]);
    });

    it('should list accounts for a specific service', async () => {
      await store.set('openai', 'default', 'key1');
      await store.set('openai', 'premium', 'key2');
      await store.set('openai', 'backup', 'key3');

      const accounts = await store.listAccounts('openai');
      expect(accounts).toHaveLength(3);
      expect(accounts).toContain('default');
      expect(accounts).toContain('premium');
      expect(accounts).toContain('backup');
    });

    it('should not include accounts from other services', async () => {
      await store.set('openai', 'default', 'key1');
      await store.set('anthropic', 'default', 'key2');
      await store.set('openai', 'premium', 'key3');

      const openaiAccounts = await store.listAccounts('openai');
      expect(openaiAccounts).toHaveLength(2);
      expect(openaiAccounts).toContain('default');
      expect(openaiAccounts).toContain('premium');
      expect(openaiAccounts).not.toContain('anthropic');
    });

    it('should return empty array for service with no credentials', async () => {
      await store.set('openai', 'default', 'key1');
      const accounts = await store.listAccounts('anthropic');
      expect(accounts).toEqual([]);
    });

    it('should reflect deleted accounts', async () => {
      await store.set('openai', 'default', 'key1');
      await store.set('openai', 'premium', 'key2');
      await store.delete('openai', 'default');

      const accounts = await store.listAccounts('openai');
      expect(accounts).toHaveLength(1);
      expect(accounts).toContain('premium');
    });

    it('should not include non-credential storage keys', async () => {
      await chrome.storage.local.set({ 'some-other-key': 'value' });
      await store.set('openai', 'default', 'key1');

      const accounts = await store.listAccounts('openai');
      expect(accounts).toHaveLength(1);
      expect(accounts).toContain('default');
    });
  });

  describe('error handling with chrome.runtime.lastError', () => {
    it('should reject on get when runtime.lastError is set', async () => {
      // We need to simulate lastError being set during the callback.
      // The mock storage area doesn't normally set lastError,
      // so we override chrome.storage.local.get for this test.
      const originalGet = chrome.storage.local.get;
      (chrome.storage.local as any).get = (_keys: any, callback: any) => {
        (chrome as any).runtime.lastError = { message: 'Storage error' };
        callback({});
      };

      await expect(store.get('openai', 'default')).rejects.toThrow('Failed to get credential: Storage error');

      // Restore
      (chrome.storage.local as any).get = originalGet;
    });

    it('should reject on set when runtime.lastError is set', async () => {
      const originalSet = chrome.storage.local.set;
      (chrome.storage.local as any).set = (_items: any, callback: any) => {
        (chrome as any).runtime.lastError = { message: 'Write error' };
        callback();
      };

      await expect(store.set('openai', 'default', 'key')).rejects.toThrow('Failed to set credential: Write error');

      (chrome.storage.local as any).set = originalSet;
    });

    it('should reject on delete when runtime.lastError is set', async () => {
      const originalRemove = chrome.storage.local.remove;
      (chrome.storage.local as any).remove = (_keys: any, callback: any) => {
        (chrome as any).runtime.lastError = { message: 'Delete error' };
        callback();
      };

      await expect(store.delete('openai', 'default')).rejects.toThrow('Failed to delete credential: Delete error');

      (chrome.storage.local as any).remove = originalRemove;
    });

    it('should reject on listAccounts when runtime.lastError is set', async () => {
      const originalGet = chrome.storage.local.get;
      (chrome.storage.local as any).get = (_keys: any, callback: any) => {
        (chrome as any).runtime.lastError = { message: 'List error' };
        callback({});
      };

      await expect(store.listAccounts('openai')).rejects.toThrow('Failed to list accounts: List error');

      (chrome.storage.local as any).get = originalGet;
    });
  });
});
