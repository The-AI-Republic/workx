/**
 * ServerStorageProvider Unit Tests
 *
 * Mocks better-sqlite3 to verify all StorageProvider methods
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
const mockTransaction = vi.fn();

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
  // better-sqlite3's transaction() returns a wrapped function that executes within a transaction
  transaction: mockTransaction.mockImplementation((fn: Function) => {
    const wrapper = (...args: any[]) => fn(...args);
    return wrapper;
  }),
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

import { ServerStorageProvider } from '../ServerStorageProvider';

describe('ServerStorageProvider', () => {
  let provider: ServerStorageProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepare.mockReturnValue(mockStatement);
    mockTransaction.mockImplementation((fn: Function) => {
      const wrapper = (...args: any[]) => fn(...args);
      return wrapper;
    });
    provider = new ServerStorageProvider('/data');
  });

  describe('initialize', () => {
    it('should create database with WAL mode', async () => {
      await provider.initialize();
      expect(mockPragma).toHaveBeenCalledWith('journal_mode = WAL');
      expect(mockPragma).toHaveBeenCalledWith('foreign_keys = ON');
    });

    it('should be idempotent', async () => {
      await provider.initialize();
      await provider.initialize();
      expect(mockPragma).toHaveBeenCalledTimes(2);
    });
  });

  describe('collection validation', () => {
    it('should reject invalid collection names', async () => {
      await provider.initialize();
      await expect(provider.get('evil_table', 'k1')).rejects.toThrow('Invalid collection: evil_table');
    });

    it('should reject SQL injection attempts', async () => {
      await provider.initialize();
      await expect(provider.get('"; DROP TABLE--', 'k1')).rejects.toThrow('Invalid collection');
    });

    it('should accept Rust-side provider collections', async () => {
      await provider.initialize();
      mockGet.mockReturnValueOnce(undefined);
      await expect(provider.get('conversations', 'k1')).resolves.toBeNull();
    });

    it('should accept adapter store names', async () => {
      await provider.initialize();
      mockGet.mockReturnValueOnce(undefined);
      await expect(provider.get('cache_items', 'k1')).resolves.toBeNull();
    });
  });

  describe('get', () => {
    it('should return parsed value', async () => {
      await provider.initialize();
      mockGet.mockReturnValueOnce({ value: '{"title":"Hello"}' });

      const result = await provider.get<{ title: string }>('conversations', 'conv-1');
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT value FROM "conversations"'));
      expect(result).toEqual({ title: 'Hello' });
    });

    it('should return null for missing key', async () => {
      await provider.initialize();
      mockGet.mockReturnValueOnce(undefined);

      const result = await provider.get('conversations', 'missing');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('should insert with timestamps', async () => {
      await provider.initialize();
      mockRun.mockReturnValueOnce({ changes: 1 });

      await provider.set('conversations', 'conv-1', { title: 'Hello' });
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "conversations"'));
      expect(mockRun).toHaveBeenCalledWith(
        'conv-1',
        '{"title":"Hello"}',
        expect.any(Number),
        expect.any(Number)
      );
    });
  });

  describe('delete', () => {
    it('should delete by key', async () => {
      await provider.initialize();
      mockRun.mockReturnValueOnce({ changes: 1 });

      await provider.delete('conversations', 'conv-1');
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "conversations"'));
    });
  });

  describe('getMany', () => {
    it('should return map of results', async () => {
      await provider.initialize();
      mockAll.mockReturnValueOnce([
        { key: 'k1', value: '{"id":"1"}' },
        { key: 'k2', value: '{"id":"2"}' },
      ]);

      const result = await provider.getMany<{ id: string }>('conversations', ['k1', 'k2']);
      expect(result.get('k1')).toEqual({ id: '1' });
      expect(result.get('k2')).toEqual({ id: '2' });
    });

    it('should return empty map for empty keys', async () => {
      await provider.initialize();
      const result = await provider.getMany('conversations', []);
      expect(result.size).toBe(0);
    });

    it('should chunk large key lists to avoid SQLite parameter limit', async () => {
      await provider.initialize();
      // Create 1000 keys — should be split into 2 chunks (900 + 100)
      const keys = Array.from({ length: 1000 }, (_, i) => `k${i}`);
      mockAll.mockReturnValueOnce([{ key: 'k0', value: '{"id":"0"}' }]);
      mockAll.mockReturnValueOnce([{ key: 'k900', value: '{"id":"900"}' }]);

      const result = await provider.getMany<{ id: string }>('conversations', keys);
      // prepare should have been called twice for the SELECT (once per chunk)
      const selectCalls = mockPrepare.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('WHERE key IN')
      );
      expect(selectCalls.length).toBe(2);
      expect(result.get('k0')).toEqual({ id: '0' });
      expect(result.get('k900')).toEqual({ id: '900' });
    });
  });

  describe('setMany', () => {
    it('should insert all entries in a transaction', async () => {
      await provider.initialize();
      mockRun.mockReturnValue({ changes: 1 });

      const entries = new Map<string, { id: string }>();
      entries.set('k1', { id: '1' });
      entries.set('k2', { id: '2' });

      await provider.setMany('conversations', entries);
      expect(mockTransaction).toHaveBeenCalled();
    });
  });

  describe('deleteMany', () => {
    it('should delete by key list', async () => {
      await provider.initialize();
      mockRun.mockReturnValueOnce({ changes: 2 });

      await provider.deleteMany('conversations', ['k1', 'k2']);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE key IN (?, ?)')
      );
    });

    it('should noop for empty keys', async () => {
      await provider.initialize();
      await provider.deleteMany('conversations', []);
      // Should not call prepare for delete
    });

    it('should chunk large key lists to avoid SQLite parameter limit', async () => {
      await provider.initialize();
      const keys = Array.from({ length: 1000 }, (_, i) => `k${i}`);
      mockRun.mockReturnValue({ changes: 0 });

      await provider.deleteMany('conversations', keys);
      const deleteCalls = mockPrepare.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE') && c[0].includes('WHERE key IN')
      );
      expect(deleteCalls.length).toBe(2);
    });
  });

  describe('list', () => {
    it('should return all items without options', async () => {
      await provider.initialize();
      mockAll.mockReturnValueOnce([
        { key: 'k1', value: '{"id":"1"}' },
      ]);

      const result = await provider.list('conversations');
      expect(result).toEqual([{ id: '1' }]);
    });

    it('should apply prefix filter', async () => {
      await provider.initialize();
      mockAll.mockReturnValueOnce([]);

      await provider.list('conversations', { prefix: 'conv_' });
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('WHERE key LIKE ?'));
    });

    it('should apply limit and offset', async () => {
      await provider.initialize();
      mockAll.mockReturnValueOnce([]);

      await provider.list('conversations', { limit: 10, offset: 5 });
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('LIMIT ?'));
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('OFFSET ?'));
    });
  });

  describe('query', () => {
    it('should use json_extract for where conditions', async () => {
      await provider.initialize();
      mockAll.mockReturnValueOnce([]);

      await provider.query('messages', {
        where: { conversationId: 'conv-1' },
      });
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("json_extract(value, '$.' || ?) = ?")
      );
    });
  });

  describe('count', () => {
    it('should return count', async () => {
      await provider.initialize();
      mockGet.mockReturnValueOnce({ cnt: 42 });

      const result = await provider.count('conversations');
      expect(result).toBe(42);
    });

    it('should apply filter to count', async () => {
      await provider.initialize();
      mockGet.mockReturnValueOnce({ cnt: 5 });

      const result = await provider.count('messages', {
        where: { conversationId: 'conv-1' },
      });
      expect(result).toBe(5);
    });
  });

  describe('transaction', () => {
    it('should execute within savepoint', async () => {
      await provider.initialize();
      mockGet.mockReturnValue({ value: '{"id":"1"}' });

      const result = await provider.transaction(async (tx) => {
        await tx.set('conversations', 'k1', { id: '1' });
        const item = await tx.get('conversations', 'k1');
        return item;
      });

      // SAVEPOINT should have been created and released
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('SAVEPOINT'));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('RELEASE'));
    });

    it('should rollback on error', async () => {
      await provider.initialize();

      await expect(
        provider.transaction(async () => {
          throw new Error('test error');
        })
      ).rejects.toThrow('test error');

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK TO'));
    });
  });

  describe('clear', () => {
    it('should delete all rows', async () => {
      await provider.initialize();
      mockRun.mockReturnValueOnce({ changes: 10 });

      await provider.clear('conversations');
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "conversations"'));
    });
  });

  describe('vacuum', () => {
    it('should execute VACUUM', async () => {
      await provider.initialize();
      await provider.vacuum();
      expect(mockExec).toHaveBeenCalledWith('VACUUM');
    });
  });

  describe('close', () => {
    it('should close database', async () => {
      await provider.initialize();
      await provider.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
