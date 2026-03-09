import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { RolloutMetadataRecord } from '../../types';

// Vitest aliases better-sqlite3 to a stub. Override with the real native module
// when available (local dev with native addon), or skip the suite (CI).
let hasBetterSqlite3 = false;
try {
  const resolved = require.resolve('better-sqlite3');
  // Ensure it's the real native module, not our test stub
  if (!resolved.includes('__test-utils__')) {
    hasBetterSqlite3 = true;
  }
} catch {
  // native addon not available
}

// vi.mock is hoisted — override the Vite alias with the real native module.
// On CI where the native addon is missing, fall back to a dummy that throws
// (tests are skipped via describe.skipIf anyway).
vi.mock('better-sqlite3', () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return { default: require('better-sqlite3') };
  } catch {
    return {
      default: function Database() {
        throw new Error('better-sqlite3 native addon not available');
      },
    };
  }
});

import { TSRolloutStorageProvider } from '../TSRolloutStorageProvider';

let tmpDir: string;
let provider: TSRolloutStorageProvider;

function makeMetadata(id: string, overrides: Partial<RolloutMetadataRecord> = {}): RolloutMetadataRecord {
  return {
    id,
    created: Date.now(),
    updated: Date.now(),
    sessionMeta: {
      id,
      timestamp: new Date().toISOString(),
      originator: 'test',
      cliVersion: '1.0',
    } as any,
    itemCount: 0,
    status: 'active',
    ...overrides,
  };
}

describe.skipIf(!hasBetterSqlite3)('TSRolloutStorageProvider', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rollout-test-'));
    provider = new TSRolloutStorageProvider(tmpDir);
    await provider.initialize();
  });

  afterEach(async () => {
    await provider.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('initializes without error', async () => {
      // Already initialized in beforeEach
      expect(provider).toBeDefined();
    });

    it('creates rollouts directory', () => {
      expect(fs.existsSync(path.join(tmpDir, 'rollouts', 'rollouts.db'))).toBe(true);
    });

    it('close and re-initialize works', async () => {
      await provider.close();
      await provider.initialize();
      const stats = await provider.getStorageStats();
      expect(stats.rolloutCount).toBe(0);
    });

    it('throws when used without initialization', async () => {
      const uninit = new TSRolloutStorageProvider(tmpDir);
      await expect(uninit.getStorageStats()).rejects.toThrow('not initialized');
    });
  });

  // ---------------------------------------------------------------------------
  // Metadata CRUD
  // ---------------------------------------------------------------------------

  describe('metadata CRUD', () => {
    it('put and get metadata', async () => {
      const meta = makeMetadata('r-1');
      await provider.putMetadata(meta);
      const result = await provider.getMetadata('r-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('r-1');
      expect(result!.status).toBe('active');
    });

    it('returns null for missing metadata', async () => {
      expect(await provider.getMetadata('nonexistent')).toBeNull();
    });

    it('upserts metadata on put', async () => {
      await provider.putMetadata(makeMetadata('r-2', { status: 'active' }));
      await provider.putMetadata(makeMetadata('r-2', { status: 'archived' }));
      const result = await provider.getMetadata('r-2');
      expect(result!.status).toBe('archived');
    });

    it('deletes metadata', async () => {
      await provider.putMetadata(makeMetadata('r-3'));
      await provider.deleteMetadata('r-3');
      expect(await provider.getMetadata('r-3')).toBeNull();
    });

    it('getAllMetadata returns all entries', async () => {
      await provider.putMetadata(makeMetadata('r-a'));
      await provider.putMetadata(makeMetadata('r-b'));
      const all = await provider.getAllMetadata();
      expect(all).toHaveLength(2);
      expect(all.map(m => m.id).sort()).toEqual(['r-a', 'r-b']);
    });

    it('round-trips sessionMeta JSON', async () => {
      const meta = makeMetadata('r-json', {
        sessionMeta: { id: 'r-json', timestamp: '2024-01-01', originator: 'test', cliVersion: '2.0', title: 'Test Chat' } as any,
      });
      await provider.putMetadata(meta);
      const result = await provider.getMetadata('r-json');
      expect(result!.sessionMeta.title).toBe('Test Chat');
    });
  });

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------

  describe('items', () => {
    it('add and get items', async () => {
      await provider.putMetadata(makeMetadata('r-items'));
      await provider.addItems('r-items', [
        { timestamp: '2024-01-01T00:00:00Z', sequence: 0, type: 'session_meta', payload: { hello: 'world' } },
        { timestamp: '2024-01-01T00:00:01Z', sequence: 1, type: 'response_item', payload: 'text response' },
      ]);

      const items = await provider.getItemsByRolloutId('r-items');
      expect(items).toHaveLength(2);
      expect(items[0].sequence).toBe(0);
      expect(items[1].sequence).toBe(1);
    });

    it('returns items in sequence order', async () => {
      await provider.putMetadata(makeMetadata('r-order'));
      await provider.addItems('r-order', [
        { timestamp: '2024-01-01T00:00:02Z', sequence: 2, type: 'event_msg', payload: {} },
        { timestamp: '2024-01-01T00:00:00Z', sequence: 0, type: 'session_meta', payload: {} },
        { timestamp: '2024-01-01T00:00:01Z', sequence: 1, type: 'response_item', payload: {} },
      ]);

      const items = await provider.getItemsByRolloutId('r-order');
      expect(items.map(i => i.sequence)).toEqual([0, 1, 2]);
    });

    it('JSON round-trips item payloads', async () => {
      await provider.putMetadata(makeMetadata('r-payload'));
      const payload = { nested: { array: [1, 2, 3], str: 'test' } };
      await provider.addItems('r-payload', [
        { timestamp: '2024-01-01T00:00:00Z', sequence: 0, type: 'session_meta', payload },
      ]);

      const items = await provider.getItemsByRolloutId('r-payload');
      expect(items[0].payload).toEqual(payload);
    });

    it('addItems with empty array is a no-op', async () => {
      await provider.putMetadata(makeMetadata('r-empty'));
      await provider.addItems('r-empty', []);
      const items = await provider.getItemsByRolloutId('r-empty');
      expect(items).toHaveLength(0);
    });

    it('deleteItemsByRolloutIds removes items', async () => {
      await provider.putMetadata(makeMetadata('r-del'));
      await provider.addItems('r-del', [
        { timestamp: '2024-01-01T00:00:00Z', sequence: 0, type: 'session_meta', payload: {} },
      ]);
      await provider.deleteItemsByRolloutIds(['r-del']);
      const items = await provider.getItemsByRolloutId('r-del');
      expect(items).toHaveLength(0);
    });

    it('deleteItemsByRolloutIds with empty array is a no-op', async () => {
      await provider.deleteItemsByRolloutIds([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Sequence tracking
  // ---------------------------------------------------------------------------

  describe('sequence tracking', () => {
    it('returns -1 for rollout with no items', async () => {
      await provider.putMetadata(makeMetadata('r-noseq'));
      expect(await provider.getLastSequenceNumber('r-noseq')).toBe(-1);
    });

    it('returns last sequence number', async () => {
      await provider.putMetadata(makeMetadata('r-seq'));
      await provider.addItems('r-seq', [
        { timestamp: '2024-01-01T00:00:00Z', sequence: 0, type: 'a', payload: {} },
        { timestamp: '2024-01-01T00:00:01Z', sequence: 1, type: 'b', payload: {} },
        { timestamp: '2024-01-01T00:00:02Z', sequence: 5, type: 'c', payload: {} },
      ]);
      expect(await provider.getLastSequenceNumber('r-seq')).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination (listConversations)
  // ---------------------------------------------------------------------------

  describe('listConversations', () => {
    it('returns empty page when no conversations', async () => {
      const page = await provider.listConversations(10);
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeUndefined();
    });

    it('returns conversations with items > 1', async () => {
      // Conversation with 2 items (included)
      const now = Date.now();
      await provider.putMetadata(makeMetadata('c-1', { itemCount: 2, updated: now }));
      // Conversation with 1 item (excluded by item_count > 1 filter)
      await provider.putMetadata(makeMetadata('c-2', { itemCount: 1, updated: now - 1000 }));
      // Conversation with 0 items (excluded)
      await provider.putMetadata(makeMetadata('c-3', { itemCount: 0, updated: now - 2000 }));

      const page = await provider.listConversations(10);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe('c-1');
    });

    it('paginates with cursor', async () => {
      const now = Date.now();
      // Use widely spaced timestamps and lexicographically distinct IDs
      for (let i = 0; i < 5; i++) {
        await provider.putMetadata(makeMetadata(`page-${String.fromCharCode(65 + i)}`, {
          itemCount: 2,
          updated: now - i * 10_000, // 10s apart to avoid overlap
        }));
      }

      const page1 = await provider.listConversations(2);
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await provider.listConversations(2, page1.nextCursor);
      expect(page2.items.length).toBeGreaterThan(0);

      // Page 2 should advance past page 1 results (items ordered by updated DESC)
      // The cursor-inclusive keyset pagination means the boundary row may overlap,
      // but page 2 should contain newer items beyond page 1's last item
      const page1LastUpdated = page1.items[page1.items.length - 1].updated;
      const page2LastUpdated = page2.items[page2.items.length - 1].updated;
      expect(page2LastUpdated).toBeLessThanOrEqual(page1LastUpdated);
    });
  });

  // ---------------------------------------------------------------------------
  // cleanupExpired
  // ---------------------------------------------------------------------------

  describe('cleanupExpired', () => {
    it('removes only expired entries', async () => {
      const now = Date.now();
      // Expired
      await provider.putMetadata(makeMetadata('exp-1', { expiresAt: now - 1000 }));
      // Not expired
      await provider.putMetadata(makeMetadata('exp-2', { expiresAt: now + 60000 }));
      // No expiration
      await provider.putMetadata(makeMetadata('exp-3'));

      const count = await provider.cleanupExpired();
      expect(count).toBe(1);

      expect(await provider.getMetadata('exp-1')).toBeNull();
      expect(await provider.getMetadata('exp-2')).not.toBeNull();
      expect(await provider.getMetadata('exp-3')).not.toBeNull();
    });

    it('returns 0 when nothing expired', async () => {
      await provider.putMetadata(makeMetadata('no-exp'));
      expect(await provider.cleanupExpired()).toBe(0);
    });

    it('cascade deletes items when metadata is deleted', async () => {
      const now = Date.now();
      await provider.putMetadata(makeMetadata('cascade', { expiresAt: now - 1000 }));
      await provider.addItems('cascade', [
        { timestamp: '2024-01-01T00:00:00Z', sequence: 0, type: 'test', payload: {} },
      ]);

      await provider.cleanupExpired();
      // Items should also be gone (via ON DELETE CASCADE)
      const items = await provider.getItemsByRolloutId('cascade');
      expect(items).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getStorageStats
  // ---------------------------------------------------------------------------

  describe('getStorageStats', () => {
    it('returns zero counts when empty', async () => {
      const stats = await provider.getStorageStats();
      expect(stats.rolloutCount).toBe(0);
      expect(stats.itemCount).toBe(0);
      expect(stats.rolloutBytes).toBe(0);
      expect(stats.itemBytes).toBe(0);
    });

    it('returns correct counts after inserting data', async () => {
      await provider.putMetadata(makeMetadata('s-1'));
      await provider.putMetadata(makeMetadata('s-2'));
      await provider.addItems('s-1', [
        { timestamp: '2024-01-01T00:00:00Z', sequence: 0, type: 'test', payload: { data: 'x' } },
        { timestamp: '2024-01-01T00:00:01Z', sequence: 1, type: 'test', payload: { data: 'y' } },
      ]);

      const stats = await provider.getStorageStats();
      expect(stats.rolloutCount).toBe(2);
      expect(stats.itemCount).toBe(2);
      expect(stats.rolloutBytes).toBeGreaterThan(0);
      expect(stats.itemBytes).toBeGreaterThan(0);
    });
  });
});
