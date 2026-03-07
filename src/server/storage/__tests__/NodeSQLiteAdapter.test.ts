/**
 * NodeSQLiteAdapter Unit Tests
 *
 * Mocks better-sqlite3 to verify all StorageAdapter methods
 * generate correct SQL and handle responses properly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Create mock database methods
const mockPrepare = vi.fn();
const mockExec = vi.fn();
const mockPragma = vi.fn();
const mockClose = vi.fn();
const mockGet = vi.fn();
const mockAll = vi.fn();
const mockRun = vi.fn();

const mockStatement = {
  get: mockGet,
  all: mockAll,
  run: mockRun,
};

const mockDb = {
  prepare: mockPrepare.mockReturnValue(mockStatement),
  exec: mockExec,
  pragma: mockPragma,
  close: mockClose,
};

// Mock better-sqlite3
vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => mockDb),
}));

// Mock node:path
vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/'),
}));

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

import { NodeSQLiteAdapter } from '../NodeSQLiteAdapter';

describe('NodeSQLiteAdapter', () => {
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepare.mockReturnValue(mockStatement);
    adapter = new NodeSQLiteAdapter('/data');
  });

  describe('initialize', () => {
    it('should create database with WAL mode', async () => {
      await adapter.initialize();
      expect(mockPragma).toHaveBeenCalledWith('journal_mode = WAL');
      expect(mockPragma).toHaveBeenCalledWith('foreign_keys = ON');
    });

    it('should create tables and indexes for all adapter stores', async () => {
      await adapter.initialize();
      // 6 table creations + 9 index creations (3 for cache_items, 4 for scheduler_jobs, 2 for agent_sessions)
      expect(mockExec).toHaveBeenCalledTimes(15);
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('"cache_items"'));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('"scheduler_jobs"'));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('"agent_sessions"'));
    });

    it('should be idempotent', async () => {
      await adapter.initialize();
      await adapter.initialize();
      // Second call should not re-initialize
      expect(mockPragma).toHaveBeenCalledTimes(2); // Only from first init
    });
  });

  describe('store name validation', () => {
    it('should reject invalid store names in get()', async () => {
      await adapter.initialize();
      await expect(adapter.get('evil_table', 'k1')).rejects.toThrow('Invalid store name: evil_table');
    });

    it('should reject invalid store names in put()', async () => {
      await adapter.initialize();
      await expect(adapter.put('DROP TABLE foo', { id: '1' })).rejects.toThrow('Invalid store name');
    });

    it('should reject invalid store names in delete()', async () => {
      await adapter.initialize();
      await expect(adapter.delete('"; DROP TABLE--', 'k1')).rejects.toThrow('Invalid store name');
    });

    it('should reject invalid store names in getAll()', async () => {
      await adapter.initialize();
      await expect(adapter.getAll('not_a_store')).rejects.toThrow('Invalid store name');
    });

    it('should reject invalid store names in queryByIndex()', async () => {
      await adapter.initialize();
      await expect(adapter.queryByIndex('evil', 'by_status', 'val')).rejects.toThrow('Invalid store name');
    });

    it('should reject invalid store names in batchDelete()', async () => {
      await adapter.initialize();
      await expect(adapter.batchDelete('evil', ['k1'])).rejects.toThrow('Invalid store name');
    });

    it('should reject invalid store names in clear()', async () => {
      await adapter.initialize();
      await expect(adapter.clear('evil')).rejects.toThrow('Invalid store name');
    });

    it('should accept valid store names', async () => {
      await adapter.initialize();
      mockGet.mockReturnValueOnce(undefined);
      await expect(adapter.get('cache_items', 'k1')).resolves.toBeNull();
    });
  });

  describe('get', () => {
    it('should return parsed value when found', async () => {
      await adapter.initialize();
      mockGet.mockReturnValueOnce({ value: '{"storageKey":"k1","data":"test"}' });

      const result = await adapter.get<{ storageKey: string }>('cache_items', 'k1');
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT value FROM "cache_items"'));
      expect(mockGet).toHaveBeenCalledWith('k1');
      expect(result).toEqual({ storageKey: 'k1', data: 'test' });
    });

    it('should return null when not found', async () => {
      await adapter.initialize();
      mockGet.mockReturnValueOnce(undefined);

      const result = await adapter.get('cache_items', 'missing');
      expect(result).toBeNull();
    });
  });

  describe('put', () => {
    it('should extract key from storageKey for cache_items', async () => {
      await adapter.initialize();
      mockRun.mockReturnValueOnce({ changes: 1 });

      await adapter.put('cache_items', { storageKey: 'sk-1', data: 'hello' });
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "cache_items"'));
      expect(mockRun).toHaveBeenCalledWith(
        'sk-1',
        JSON.stringify({ storageKey: 'sk-1', data: 'hello' }),
        expect.any(Number),
        expect.any(Number)
      );
    });

    it('should extract key from id for scheduler_jobs', async () => {
      await adapter.initialize();
      mockRun.mockReturnValueOnce({ changes: 1 });

      await adapter.put('scheduler_jobs', { id: 'task-1', status: 'running' });
      expect(mockRun).toHaveBeenCalledWith(
        'task-1',
        expect.any(String),
        expect.any(Number),
        expect.any(Number)
      );
    });

    it('should throw for unknown store', async () => {
      await adapter.initialize();
      await expect(adapter.put('unknown', { id: '1' })).rejects.toThrow('Invalid store name: unknown');
    });

    it('should throw for missing keyPath field', async () => {
      await adapter.initialize();
      await expect(adapter.put('cache_items', { noKey: 'val' })).rejects.toThrow(
        'Value missing keyPath field'
      );
    });
  });

  describe('delete', () => {
    it('should return true when row was deleted', async () => {
      await adapter.initialize();
      mockRun.mockReturnValueOnce({ changes: 1 });

      const result = await adapter.delete('cache_items', 'k1');
      expect(result).toBe(true);
    });

    it('should return false when no row was deleted', async () => {
      await adapter.initialize();
      mockRun.mockReturnValueOnce({ changes: 0 });

      const result = await adapter.delete('cache_items', 'missing');
      expect(result).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should return all parsed values', async () => {
      await adapter.initialize();
      mockAll.mockReturnValueOnce([
        { value: '{"id":"1"}' },
        { value: '{"id":"2"}' },
      ]);

      const result = await adapter.getAll<{ id: string }>('scheduler_jobs');
      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    });
  });

  describe('queryByIndex', () => {
    it('should use json_extract for field queries', async () => {
      await adapter.initialize();
      mockAll.mockReturnValueOnce([
        { value: '{"status":"pending","id":"t1"}' },
      ]);

      const result = await adapter.queryByIndex('scheduler_jobs', 'by_status', 'pending');
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("json_extract(value, '$.status')")
      );
      expect(mockAll).toHaveBeenCalledWith('pending');
      expect(result).toEqual([{ status: 'pending', id: 't1' }]);
    });

    it('should throw for unknown index', async () => {
      await adapter.initialize();
      await expect(
        adapter.queryByIndex('cache_items', 'nonexistent', 'val')
      ).rejects.toThrow('Unknown index: nonexistent');
    });
  });

  describe('batchDelete', () => {
    it('should delete multiple keys', async () => {
      await adapter.initialize();
      mockRun.mockReturnValueOnce({ changes: 3 });

      const result = await adapter.batchDelete('cache_items', ['k1', 'k2', 'k3']);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE key IN (?, ?, ?)')
      );
      expect(result).toBe(3);
    });

    it('should return 0 for empty keys', async () => {
      await adapter.initialize();
      const result = await adapter.batchDelete('cache_items', []);
      expect(result).toBe(0);
    });
  });

  describe('clear', () => {
    it('should delete all rows', async () => {
      await adapter.initialize();
      mockRun.mockReturnValueOnce({ changes: 5 });

      await adapter.clear('cache_items');
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "cache_items"'));
    });
  });

  describe('close', () => {
    it('should close the database', async () => {
      await adapter.initialize();
      await adapter.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
