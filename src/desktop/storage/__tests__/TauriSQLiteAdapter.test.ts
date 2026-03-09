/**
 * TauriSQLiteAdapter Unit Tests
 *
 * Mocks Tauri invoke() to verify all StorageAdapter methods
 * route correctly through Tauri commands.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TauriSQLiteAdapter } from '../TauriSQLiteAdapter';

// Mock @tauri-apps/api/core
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('TauriSQLiteAdapter', () => {
  let adapter: TauriSQLiteAdapter;

  beforeEach(() => {
    adapter = new TauriSQLiteAdapter();
    mockInvoke.mockReset();
  });

  describe('initialize', () => {
    it('should call storage_init once', async () => {
      mockInvoke.mockResolvedValueOnce({ dbPath: '/test/storage.db' });
      await adapter.initialize();
      expect(mockInvoke).toHaveBeenCalledWith('storage_init');
    });

    it('should be idempotent', async () => {
      mockInvoke.mockResolvedValue({ dbPath: '/test/storage.db' });
      await adapter.initialize();
      await adapter.initialize();
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('should handle "already initialized" error gracefully', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Storage already initialized'));
      await adapter.initialize(); // Should not throw
    });

    it('should re-throw genuine initialization errors', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Cannot open database'));
      await expect(adapter.initialize()).rejects.toThrow('Cannot open database');
    });

    it('should not set initialized on genuine error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('disk full'));
      await expect(adapter.initialize()).rejects.toThrow('disk full');
      // After failure, initialize() should try again
      mockInvoke.mockResolvedValueOnce({ dbPath: '/test/storage.db' });
      await adapter.initialize();
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });
  });

  describe('get', () => {
    it('should call storage_get with correct params', async () => {
      mockInvoke.mockResolvedValueOnce('{"key":"value"}');
      const result = await adapter.get<{ key: string }>('cache_items', 'test-key');
      expect(mockInvoke).toHaveBeenCalledWith('storage_get', {
        collection: 'cache_items',
        key: 'test-key',
      });
      expect(result).toEqual({ key: 'value' });
    });

    it('should return null when storage_get returns null', async () => {
      mockInvoke.mockResolvedValueOnce(null);
      const result = await adapter.get('cache_items', 'missing');
      expect(result).toBeNull();
    });
  });

  describe('put', () => {
    it('should call storage_set with keyPath extraction for cache_items', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await adapter.put('cache_items', { storageKey: 'sk-1', data: 'hello' });
      expect(mockInvoke).toHaveBeenCalledWith('storage_set', {
        collection: 'cache_items',
        key: 'sk-1',
        value: JSON.stringify({ storageKey: 'sk-1', data: 'hello' }),
      });
    });

    it('should extract key from scheduler_jobs using "id" keyPath', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await adapter.put('scheduler_jobs', { id: 'task-1', status: 'pending' });
      expect(mockInvoke).toHaveBeenCalledWith('storage_set', {
        collection: 'scheduler_jobs',
        key: 'task-1',
        value: JSON.stringify({ id: 'task-1', status: 'pending' }),
      });
    });

    it('should throw for unknown store', async () => {
      await expect(adapter.put('unknown_store', { id: '1' })).rejects.toThrow(
        'Unknown store: unknown_store'
      );
    });

    it('should throw for missing keyPath value', async () => {
      await expect(adapter.put('cache_items', { noKey: 'val' })).rejects.toThrow(
        'Value missing keyPath field'
      );
    });
  });

  describe('delete', () => {
    it('should return true when item exists', async () => {
      mockInvoke.mockResolvedValueOnce('{"key":"exists"}'); // storage_get
      mockInvoke.mockResolvedValueOnce(undefined); // storage_delete
      const result = await adapter.delete('cache_items', 'test-key');
      expect(result).toBe(true);
    });

    it('should return false when item does not exist', async () => {
      mockInvoke.mockResolvedValueOnce(null);
      const result = await adapter.delete('cache_items', 'missing');
      expect(result).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should call storage_list and parse all rows', async () => {
      mockInvoke.mockResolvedValueOnce([
        { key: 'k1', value: '{"id":"1"}', created_at: 1000, updated_at: 1000 },
        { key: 'k2', value: '{"id":"2"}', created_at: 2000, updated_at: 2000 },
      ]);
      const result = await adapter.getAll<{ id: string }>('scheduler_jobs');
      expect(mockInvoke).toHaveBeenCalledWith('storage_list', {
        collection: 'scheduler_jobs',
      });
      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });
  });

  describe('queryByIndex', () => {
    it('should map index name to field using INDEX_FIELD_MAP', async () => {
      mockInvoke.mockResolvedValueOnce([
        { key: 'k1', value: '{"status":"pending"}', created_at: 1, updated_at: 1 },
      ]);
      const result = await adapter.queryByIndex('scheduler_jobs', 'by_status', 'pending');
      expect(mockInvoke).toHaveBeenCalledWith('storage_query', {
        collection: 'scheduler_jobs',
        where: JSON.stringify({ status: 'pending' }),
      });
      expect(result).toEqual([{ status: 'pending' }]);
    });

    it('should throw for unknown index', async () => {
      await expect(
        adapter.queryByIndex('cache_items', 'nonexistent_index', 'val')
      ).rejects.toThrow('Unknown index: nonexistent_index');
    });
  });

  describe('batchDelete', () => {
    it('should return the actual deleted count from Rust', async () => {
      mockInvoke.mockResolvedValueOnce(2); // Rust returns actual count
      const result = await adapter.batchDelete('cache_items', ['k1', 'k2', 'k3']);
      expect(mockInvoke).toHaveBeenCalledWith('storage_delete_many', {
        collection: 'cache_items',
        keys: ['k1', 'k2', 'k3'],
      });
      expect(result).toBe(2); // Only 2 of 3 existed
    });

    it('should accumulate counts across chunks', async () => {
      // Create enough keys to trigger chunking (> 900)
      const keys = Array.from({ length: 1000 }, (_, i) => `k${i}`);
      mockInvoke.mockResolvedValueOnce(900); // first chunk
      mockInvoke.mockResolvedValueOnce(50);  // second chunk (only 50 of 100 existed)

      const result = await adapter.batchDelete('cache_items', keys);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(result).toBe(950);
    });

    it('should return 0 for empty keys array', async () => {
      const result = await adapter.batchDelete('cache_items', []);
      expect(result).toBe(0);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should call storage_clear', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      await adapter.clear('cache_items');
      expect(mockInvoke).toHaveBeenCalledWith('storage_clear', {
        collection: 'cache_items',
      });
    });
  });

  describe('close', () => {
    it('should reset initialized state', async () => {
      mockInvoke.mockResolvedValue({ dbPath: '/test/storage.db' });
      await adapter.initialize();
      await adapter.close();
      // After close, initialize should call storage_init again
      await adapter.initialize();
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });
  });
});
