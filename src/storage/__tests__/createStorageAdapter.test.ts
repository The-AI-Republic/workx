/**
 * createStorageAdapter Factory Unit Tests
 *
 * Verifies correct adapter type returned for each build mode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all adapter modules
vi.mock('../IndexedDBAdapter', () => ({
  IndexedDBAdapter: vi.fn().mockImplementation(() => ({
    _type: 'IndexedDBAdapter',
    initialize: vi.fn(),
  })),
}));

vi.mock('@/desktop/storage/TauriSQLiteAdapter', () => ({
  TauriSQLiteAdapter: vi.fn().mockImplementation(() => ({
    _type: 'TauriSQLiteAdapter',
    initialize: vi.fn(),
  })),
}));

vi.mock('@/server/config/server-config', () => ({
  getDataDir: vi.fn(() => '/tmp/test-data'),
}));

vi.mock('@/server/storage/NodeSQLiteAdapter', () => ({
  NodeSQLiteAdapter: vi.fn().mockImplementation(() => ({
    _type: 'NodeSQLiteAdapter',
    initialize: vi.fn(),
  })),
}));

describe('createStorageAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should return IndexedDBAdapter for extension mode', async () => {
    // __BUILD_MODE__ is set to 'extension' in test environment (vitest.config.mjs)
    const { createStorageAdapter } = await import('../createStorageAdapter');
    const adapter = await createStorageAdapter();
    expect((adapter as any)._type).toBe('IndexedDBAdapter');
  });
});
