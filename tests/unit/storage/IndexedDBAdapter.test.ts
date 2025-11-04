import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  IndexedDBAdapter,
  DB_NAME,
  DB_VERSION,
  STORE_NAMES,
  INDEX_NAMES,
  IndexedDBError,
  StorageUnavailableError
} from '../../../src/storage/IndexedDBAdapter';
import type { SessionCacheEntry, SessionCacheMetadata, LLMCacheConfig } from '../../../src/types/storage';

describe('IndexedDBAdapter', () => {
  let adapter: IndexedDBAdapter;

  beforeEach(async () => {
    // Reset IndexedDB for each test
    // @ts-ignore - fake-indexeddb global reset
    global.indexedDB = new IDBFactory();
    adapter = new IndexedDBAdapter();
  });

  afterEach(async () => {
    await adapter.close();
    // Clean up all databases
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  });

  describe('Database Initialization', () => {
    it('should initialize database with correct name and version', async () => {
      await adapter.initialize();

      const dbs = await indexedDB.databases();
      const browserxDb = dbs.find(db => db.name === DB_NAME);

      expect(browserxDb).toBeDefined();
      expect(browserxDb?.version).toBe(DB_VERSION);
    });

    it('should create all required object stores', async () => {
      await adapter.initialize();

      // Open connection to verify stores
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open(DB_NAME);
        request.onsuccess = () => resolve(request.result);
      });

      expect(db.objectStoreNames.contains(STORE_NAMES.CACHE_ITEMS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_NAMES.SESSIONS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_NAMES.CONFIG)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_NAMES.ROLLOUT_CACHE)).toBe(true);

      db.close();
    });

    it('should create required indexes on cache_items store', async () => {
      await adapter.initialize();

      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open(DB_NAME);
        request.onsuccess = () => resolve(request.result);
      });

      const transaction = db.transaction(STORE_NAMES.CACHE_ITEMS, 'readonly');
      const store = transaction.objectStore(STORE_NAMES.CACHE_ITEMS);

      expect(store.indexNames.contains(INDEX_NAMES.BY_SESSION)).toBe(true);
      expect(store.indexNames.contains(INDEX_NAMES.BY_SESSION_TIMESTAMP)).toBe(true);
      expect(store.indexNames.contains(INDEX_NAMES.BY_TIMESTAMP)).toBe(true);

      db.close();
    });

    it('should handle multiple initialization calls safely', async () => {
      await Promise.all([
        adapter.initialize(),
        adapter.initialize(),
        adapter.initialize()
      ]);

      const dbs = await indexedDB.databases();
      const browserxDbs = dbs.filter(db => db.name === DB_NAME);

      expect(browserxDbs.length).toBe(1);
    });

    it('should throw StorageUnavailableError when IndexedDB is not available', async () => {
      // @ts-ignore - simulate missing IndexedDB
      const originalIndexedDB = global.indexedDB;
      // @ts-ignore
      global.indexedDB = undefined;

      const adapterWithoutIDB = new IndexedDBAdapter();

      await expect(adapterWithoutIDB.initialize()).rejects.toThrow(StorageUnavailableError);
      await expect(adapterWithoutIDB.initialize()).rejects.toThrow('IndexedDB not supported');

      // Restore
      // @ts-ignore
      global.indexedDB = originalIndexedDB;
    });
  });

  describe('CRUD Operations', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    describe('put() and get()', () => {
      it('should store and retrieve a cache entry', async () => {
        const entry: SessionCacheEntry = {
          storageKey: 'conv_123_task456_turn789',
          data: { test: 'data', numbers: [1, 2, 3] },
          description: 'Test cache entry',
          timestamp: Date.now(),
          dataSize: 100,
          sessionId: 'conv_123',
          taskId: 'task456',
          turnId: 'turn789'
        };

        await adapter.put(STORE_NAMES.CACHE_ITEMS, entry);

        const retrieved = await adapter.get<SessionCacheEntry>(
          STORE_NAMES.CACHE_ITEMS,
          'conv_123_task456_turn789'
        );

        expect(retrieved).toEqual(entry);
      });

      it('should store and retrieve session metadata', async () => {
        const metadata: SessionCacheMetadata = {
          sessionId: 'conv_abc123',
          totalSize: 5000000,
          itemCount: 10,
          quotaUsed: 2.5,
          createdAt: Date.now(),
          lastAccessedAt: Date.now()
        };

        await adapter.put(STORE_NAMES.SESSIONS, metadata);

        const retrieved = await adapter.get<SessionCacheMetadata>(
          STORE_NAMES.SESSIONS,
          'conv_abc123'
        );

        expect(retrieved).toEqual(metadata);
      });

      it('should store and retrieve LLM cache config', async () => {
        const config = {
          key: 'llm_cache_config',
          outdatedCleanupDays: 30,
          sessionEvictionPercentage: 0.5
        };

        await adapter.put(STORE_NAMES.CONFIG, config);

        const retrieved = await adapter.get<typeof config>(
          STORE_NAMES.CONFIG,
          'llm_cache_config'
        );

        expect(retrieved).toEqual(config);
      });

      it('should return null for non-existent keys', async () => {
        const result = await adapter.get(STORE_NAMES.CACHE_ITEMS, 'non_existent_key');

        expect(result).toBeNull();
      });

      it('should update existing entries on put', async () => {
        const entry: SessionCacheEntry = {
          storageKey: 'conv_123_task456_turn789',
          data: { version: 1 },
          description: 'Version 1',
          timestamp: Date.now(),
          dataSize: 50,
          sessionId: 'conv_123',
          taskId: 'task456',
          turnId: 'turn789'
        };

        await adapter.put(STORE_NAMES.CACHE_ITEMS, entry);

        const updated = {
          ...entry,
          data: { version: 2 },
          description: 'Version 2',
          dataSize: 100
        };

        await adapter.put(STORE_NAMES.CACHE_ITEMS, updated);

        const retrieved = await adapter.get<SessionCacheEntry>(
          STORE_NAMES.CACHE_ITEMS,
          'conv_123_task456_turn789'
        );

        expect(retrieved?.data.version).toBe(2);
        expect(retrieved?.description).toBe('Version 2');
      });
    });

    describe('delete()', () => {
      it('should delete an existing entry and return true', async () => {
        const entry: SessionCacheEntry = {
          storageKey: 'conv_123_task456_turn789',
          data: { test: 'data' },
          description: 'To be deleted',
          timestamp: Date.now(),
          dataSize: 50,
          sessionId: 'conv_123',
          taskId: 'task456',
          turnId: 'turn789'
        };

        await adapter.put(STORE_NAMES.CACHE_ITEMS, entry);

        const deleted = await adapter.delete(STORE_NAMES.CACHE_ITEMS, 'conv_123_task456_turn789');

        expect(deleted).toBe(true);

        const retrieved = await adapter.get(STORE_NAMES.CACHE_ITEMS, 'conv_123_task456_turn789');
        expect(retrieved).toBeNull();
      });

      it('should return false for non-existent keys', async () => {
        const deleted = await adapter.delete(STORE_NAMES.CACHE_ITEMS, 'non_existent_key');

        expect(deleted).toBe(false);
      });
    });

    describe('getAll()', () => {
      it('should retrieve all entries from a store', async () => {
        const entries: SessionCacheEntry[] = [
          {
            storageKey: 'conv_123_task1_turn1',
            data: { id: 1 },
            description: 'Entry 1',
            timestamp: Date.now(),
            dataSize: 50,
            sessionId: 'conv_123',
            taskId: 'task1',
            turnId: 'turn1'
          },
          {
            storageKey: 'conv_123_task2_turn2',
            data: { id: 2 },
            description: 'Entry 2',
            timestamp: Date.now(),
            dataSize: 60,
            sessionId: 'conv_123',
            taskId: 'task2',
            turnId: 'turn2'
          },
          {
            storageKey: 'conv_456_task3_turn3',
            data: { id: 3 },
            description: 'Entry 3',
            timestamp: Date.now(),
            dataSize: 70,
            sessionId: 'conv_456',
            taskId: 'task3',
            turnId: 'turn3'
          }
        ];

        for (const entry of entries) {
          await adapter.put(STORE_NAMES.CACHE_ITEMS, entry);
        }

        const allEntries = await adapter.getAll<SessionCacheEntry>(STORE_NAMES.CACHE_ITEMS);

        expect(allEntries).toHaveLength(3);
        expect(allEntries.map(e => e.storageKey)).toContain('conv_123_task1_turn1');
        expect(allEntries.map(e => e.storageKey)).toContain('conv_123_task2_turn2');
        expect(allEntries.map(e => e.storageKey)).toContain('conv_456_task3_turn3');
      });

      it('should return empty array for empty store', async () => {
        const allEntries = await adapter.getAll(STORE_NAMES.CACHE_ITEMS);

        expect(allEntries).toEqual([]);
      });
    });

    describe('queryByIndex()', () => {
      beforeEach(async () => {
        // Setup test data
        const entries: SessionCacheEntry[] = [
          {
            storageKey: 'conv_session1_task1_turn1',
            data: { id: 1 },
            description: 'Session 1 Entry 1',
            timestamp: 1000,
            dataSize: 50,
            sessionId: 'conv_session1',
            taskId: 'task1',
            turnId: 'turn1'
          },
          {
            storageKey: 'conv_session1_task2_turn2',
            data: { id: 2 },
            description: 'Session 1 Entry 2',
            timestamp: 2000,
            dataSize: 60,
            sessionId: 'conv_session1',
            taskId: 'task2',
            turnId: 'turn2'
          },
          {
            storageKey: 'conv_session2_task3_turn3',
            data: { id: 3 },
            description: 'Session 2 Entry 1',
            timestamp: 3000,
            dataSize: 70,
            sessionId: 'conv_session2',
            taskId: 'task3',
            turnId: 'turn3'
          }
        ];

        for (const entry of entries) {
          await adapter.put(STORE_NAMES.CACHE_ITEMS, entry);
        }
      });

      it('should query entries by session ID using by_session index', async () => {
        const results = await adapter.queryByIndex<SessionCacheEntry>(
          STORE_NAMES.CACHE_ITEMS,
          INDEX_NAMES.BY_SESSION,
          'conv_session1'
        );

        expect(results).toHaveLength(2);
        expect(results.every(e => e.sessionId === 'conv_session1')).toBe(true);
      });

      it('should query entries by timestamp using by_timestamp index', async () => {
        const results = await adapter.queryByIndex<SessionCacheEntry>(
          STORE_NAMES.CACHE_ITEMS,
          INDEX_NAMES.BY_TIMESTAMP,
          IDBKeyRange.upperBound(2000)
        );

        expect(results).toHaveLength(2);
        expect(results.every(e => e.timestamp <= 2000)).toBe(true);
      });

      it('should return empty array when no entries match query', async () => {
        const results = await adapter.queryByIndex<SessionCacheEntry>(
          STORE_NAMES.CACHE_ITEMS,
          INDEX_NAMES.BY_SESSION,
          'conv_nonexistent'
        );

        expect(results).toEqual([]);
      });
    });

    describe('batchDelete()', () => {
      it('should delete multiple entries in a single transaction', async () => {
        const entries: SessionCacheEntry[] = [
          {
            storageKey: 'conv_123_task1_turn1',
            data: { id: 1 },
            description: 'Entry 1',
            timestamp: Date.now(),
            dataSize: 50,
            sessionId: 'conv_123',
            taskId: 'task1',
            turnId: 'turn1'
          },
          {
            storageKey: 'conv_123_task2_turn2',
            data: { id: 2 },
            description: 'Entry 2',
            timestamp: Date.now(),
            dataSize: 60,
            sessionId: 'conv_123',
            taskId: 'task2',
            turnId: 'turn2'
          },
          {
            storageKey: 'conv_123_task3_turn3',
            data: { id: 3 },
            description: 'Entry 3',
            timestamp: Date.now(),
            dataSize: 70,
            sessionId: 'conv_123',
            taskId: 'task3',
            turnId: 'turn3'
          }
        ];

        for (const entry of entries) {
          await adapter.put(STORE_NAMES.CACHE_ITEMS, entry);
        }

        const keysToDelete = [
          'conv_123_task1_turn1',
          'conv_123_task2_turn2'
        ];

        const deletedCount = await adapter.batchDelete(STORE_NAMES.CACHE_ITEMS, keysToDelete);

        expect(deletedCount).toBe(2);

        const remaining = await adapter.getAll<SessionCacheEntry>(STORE_NAMES.CACHE_ITEMS);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].storageKey).toBe('conv_123_task3_turn3');
      });

      it('should handle batch delete of non-existent keys', async () => {
        const deletedCount = await adapter.batchDelete(STORE_NAMES.CACHE_ITEMS, [
          'non_existent_1',
          'non_existent_2'
        ]);

        // Note: IndexedDB delete doesn't fail for non-existent keys
        expect(deletedCount).toBe(2);
      });
    });

    describe('clear()', () => {
      it('should clear all entries from a store', async () => {
        const entries: SessionCacheEntry[] = [
          {
            storageKey: 'conv_123_task1_turn1',
            data: { id: 1 },
            description: 'Entry 1',
            timestamp: Date.now(),
            dataSize: 50,
            sessionId: 'conv_123',
            taskId: 'task1',
            turnId: 'turn1'
          },
          {
            storageKey: 'conv_123_task2_turn2',
            data: { id: 2 },
            description: 'Entry 2',
            timestamp: Date.now(),
            dataSize: 60,
            sessionId: 'conv_123',
            taskId: 'task2',
            turnId: 'turn2'
          }
        ];

        for (const entry of entries) {
          await adapter.put(STORE_NAMES.CACHE_ITEMS, entry);
        }

        await adapter.clear(STORE_NAMES.CACHE_ITEMS);

        const allEntries = await adapter.getAll(STORE_NAMES.CACHE_ITEMS);
        expect(allEntries).toEqual([]);
      });

      it('should not affect other stores when clearing one store', async () => {
        const cacheEntry: SessionCacheEntry = {
          storageKey: 'conv_123_task1_turn1',
          data: { id: 1 },
          description: 'Cache Entry',
          timestamp: Date.now(),
          dataSize: 50,
          sessionId: 'conv_123',
          taskId: 'task1',
          turnId: 'turn1'
        };

        const sessionMetadata: SessionCacheMetadata = {
          sessionId: 'conv_123',
          totalSize: 1000,
          itemCount: 5,
          quotaUsed: 10,
          createdAt: Date.now(),
          lastAccessedAt: Date.now()
        };

        await adapter.put(STORE_NAMES.CACHE_ITEMS, cacheEntry);
        await adapter.put(STORE_NAMES.SESSIONS, sessionMetadata);

        await adapter.clear(STORE_NAMES.CACHE_ITEMS);

        const cacheItems = await adapter.getAll(STORE_NAMES.CACHE_ITEMS);
        const sessions = await adapter.getAll(STORE_NAMES.SESSIONS);

        expect(cacheItems).toEqual([]);
        expect(sessions).toHaveLength(1);
      });
    });
  });

  describe('Error Handling', () => {
    it('should throw IndexedDBError on invalid operation', async () => {
      await adapter.initialize();

      // Try to query with invalid store name
      await expect(
        adapter.get('invalid_store', 'some_key')
      ).rejects.toThrow(IndexedDBError);
    });

    it('should throw IndexedDBError on invalid index name', async () => {
      await adapter.initialize();

      await expect(
        adapter.queryByIndex(STORE_NAMES.CACHE_ITEMS, 'invalid_index', 'some_value')
      ).rejects.toThrow(IndexedDBError);
    });
  });

  describe('Connection Management', () => {
    it('should close database connection', async () => {
      await adapter.initialize();
      await adapter.close();

      // After close, operations should re-initialize
      const entry: SessionCacheEntry = {
        storageKey: 'conv_123_task1_turn1',
        data: { test: 'data' },
        description: 'Test entry',
        timestamp: Date.now(),
        dataSize: 50,
        sessionId: 'conv_123',
        taskId: 'task1',
        turnId: 'turn1'
      };

      // This should work as it will re-initialize
      await adapter.put(STORE_NAMES.CACHE_ITEMS, entry);

      const retrieved = await adapter.get<SessionCacheEntry>(
        STORE_NAMES.CACHE_ITEMS,
        'conv_123_task1_turn1'
      );

      expect(retrieved).toEqual(entry);
    });

    it('should handle multiple close calls safely', async () => {
      await adapter.initialize();
      await adapter.close();
      await adapter.close();
      await adapter.close();

      // Should not throw errors
      expect(true).toBe(true);
    });
  });
});
