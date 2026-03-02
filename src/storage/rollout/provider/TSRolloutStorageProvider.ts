/**
 * TSRolloutStorageProvider
 *
 * TypeScript/Node.js implementation of RolloutStorageProvider using better-sqlite3.
 * Same schema as the Rust rollout_db.rs used by desktop (TauriRolloutStorageProvider),
 * but executed directly in-process via better-sqlite3.
 *
 * Used by server mode where Tauri IPC is not available.
 */

import type { RolloutStorageProvider, StorageStats } from './RolloutStorageProvider';
import type {
  ConversationId,
  RolloutMetadataRecord,
  RolloutItemRecord,
  ConversationsPage,
  Cursor,
} from '../types';

export class TSRolloutStorageProvider implements RolloutStorageProvider {
  private db: import('better-sqlite3').Database | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async initialize(): Promise<void> {
    const { default: Database } = await import('better-sqlite3');
    const { join } = await import('node:path');
    const { existsSync, mkdirSync } = await import('node:fs');

    const dir = join(this.dataDir, 'rollouts');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(join(dir, 'rollouts.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rollout_metadata (
        id TEXT PRIMARY KEY,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        expires_at INTEGER,
        session_meta TEXT NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_expires ON rollout_metadata(expires_at);
      CREATE INDEX IF NOT EXISTS idx_metadata_updated ON rollout_metadata(updated);

      CREATE TABLE IF NOT EXISTS rollout_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rollout_id TEXT NOT NULL REFERENCES rollout_metadata(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(rollout_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_items_rollout_seq ON rollout_items(rollout_id, sequence);
    `);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private getDb(): import('better-sqlite3').Database {
    if (!this.db) throw new Error('TSRolloutStorageProvider not initialized. Call initialize() first.');
    return this.db;
  }

  // ==========================================================================
  // Metadata
  // ==========================================================================

  async getMetadata(rolloutId: ConversationId): Promise<RolloutMetadataRecord | null> {
    const row = this.getDb().prepare(
      'SELECT id, created, updated, expires_at, session_meta, item_count, status FROM rollout_metadata WHERE id = ?'
    ).get(rolloutId) as RawMetadataRow | undefined;

    return row ? this.toMetadataRecord(row) : null;
  }

  async putMetadata(metadata: RolloutMetadataRecord): Promise<void> {
    this.getDb().prepare(
      `INSERT OR REPLACE INTO rollout_metadata (id, created, updated, expires_at, session_meta, item_count, status)
       VALUES (@id, @created, @updated, @expiresAt, @sessionMeta, @itemCount, @status)`
    ).run({
      id: metadata.id,
      created: metadata.created,
      updated: metadata.updated,
      expiresAt: metadata.expiresAt ?? null,
      sessionMeta: JSON.stringify(metadata.sessionMeta),
      itemCount: metadata.itemCount,
      status: metadata.status,
    });
  }

  async deleteMetadata(rolloutId: ConversationId): Promise<void> {
    this.getDb().prepare('DELETE FROM rollout_metadata WHERE id = ?').run(rolloutId);
  }

  async getAllMetadata(): Promise<RolloutMetadataRecord[]> {
    const rows = this.getDb().prepare(
      'SELECT id, created, updated, expires_at, session_meta, item_count, status FROM rollout_metadata'
    ).all() as RawMetadataRow[];

    return rows.map((r) => this.toMetadataRecord(r));
  }

  // ==========================================================================
  // Items
  // ==========================================================================

  async addItems(
    rolloutId: ConversationId,
    items: Array<{ timestamp: string; sequence: number; type: string; payload: unknown }>
  ): Promise<void> {
    if (items.length === 0) return;

    const db = this.getDb();
    const insertItem = db.prepare(
      `INSERT INTO rollout_items (rollout_id, timestamp, sequence, type, payload)
       VALUES (?, ?, ?, ?, ?)`
    );
    const updateCount = db.prepare(
      `UPDATE rollout_metadata SET item_count = item_count + ?, updated = ? WHERE id = ?`
    );

    const tx = db.transaction(() => {
      for (const item of items) {
        const payload = typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload);
        insertItem.run(rolloutId, item.timestamp, item.sequence, item.type, payload);
      }
      updateCount.run(items.length, Date.now(), rolloutId);
    });

    tx();
  }

  async getItemsByRolloutId(rolloutId: ConversationId): Promise<RolloutItemRecord[]> {
    const rows = this.getDb().prepare(
      'SELECT id, rollout_id, timestamp, sequence, type, payload FROM rollout_items WHERE rollout_id = ? ORDER BY sequence'
    ).all(rolloutId) as RawItemRow[];

    return rows.map((r) => ({
      id: r.id,
      rolloutId: r.rollout_id,
      timestamp: r.timestamp,
      sequence: r.sequence,
      type: r.type,
      payload: this.parseJson(r.payload),
    }));
  }

  async getLastSequenceNumber(rolloutId: ConversationId): Promise<number> {
    const row = this.getDb().prepare(
      'SELECT MAX(sequence) as max_seq FROM rollout_items WHERE rollout_id = ?'
    ).get(rolloutId) as { max_seq: number | null } | undefined;

    return row?.max_seq ?? -1;
  }

  async deleteItemsByRolloutIds(rolloutIds: string[]): Promise<void> {
    if (rolloutIds.length === 0) return;

    const placeholders = rolloutIds.map(() => '?').join(', ');
    this.getDb().prepare(
      `DELETE FROM rollout_items WHERE rollout_id IN (${placeholders})`
    ).run(...rolloutIds);
  }

  // ==========================================================================
  // Listing & Cleanup
  // ==========================================================================

  async listConversations(pageSize: number, cursor?: Cursor): Promise<ConversationsPage> {
    const db = this.getDb();
    let rows: RawMetadataRow[];

    if (cursor) {
      rows = db.prepare(
        `SELECT id, created, updated, expires_at, session_meta, item_count, status
         FROM rollout_metadata
         WHERE session_meta IS NOT NULL AND item_count > 1
           AND (updated < ? OR (updated = ? AND id <= ?))
         ORDER BY updated DESC
         LIMIT ?`
      ).all(cursor.timestamp, cursor.timestamp, cursor.id, pageSize + 1) as RawMetadataRow[];
    } else {
      rows = db.prepare(
        `SELECT id, created, updated, expires_at, session_meta, item_count, status
         FROM rollout_metadata
         WHERE session_meta IS NOT NULL AND item_count > 1
         ORDER BY updated DESC
         LIMIT ?`
      ).all(pageSize + 1) as RawMetadataRow[];
    }

    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);

    const nextCursor = hasMore && pageRows.length > 0
      ? { timestamp: pageRows[pageRows.length - 1].updated, id: pageRows[pageRows.length - 1].id }
      : undefined;

    const items = pageRows.map((r) => ({
      id: r.id,
      rolloutId: r.id,
      head: [],
      tail: [],
      created: r.created,
      updated: r.updated,
      sessionMeta: this.parseJson(r.session_meta),
      itemCount: r.item_count,
    }));

    return {
      items,
      nextCursor,
      numScanned: pageRows.length,
      reachedCap: false,
    };
  }

  async cleanupExpired(): Promise<number> {
    const db = this.getDb();
    const now = Date.now();

    const expired = db.prepare(
      'SELECT id FROM rollout_metadata WHERE expires_at IS NOT NULL AND expires_at < ?'
    ).all(now) as Array<{ id: string }>;

    if (expired.length === 0) return 0;

    const ids = expired.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM rollout_items WHERE rollout_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM rollout_metadata WHERE id IN (${placeholders})`).run(...ids);
    });

    tx();
    return ids.length;
  }

  async getStorageStats(): Promise<StorageStats> {
    const db = this.getDb();

    const rolloutCount = (db.prepare('SELECT COUNT(*) as c FROM rollout_metadata').get() as { c: number }).c;
    const itemCount = (db.prepare('SELECT COUNT(*) as c FROM rollout_items').get() as { c: number }).c;
    const rolloutBytes = (db.prepare('SELECT COALESCE(SUM(LENGTH(session_meta)), 0) as b FROM rollout_metadata').get() as { b: number }).b;
    const itemBytes = (db.prepare('SELECT COALESCE(SUM(LENGTH(payload)), 0) as b FROM rollout_items').get() as { b: number }).b;

    return { rolloutCount, itemCount, rolloutBytes, itemBytes };
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private toMetadataRecord(row: RawMetadataRow): RolloutMetadataRecord {
    return {
      id: row.id,
      created: row.created,
      updated: row.updated,
      expiresAt: row.expires_at ?? undefined,
      sessionMeta: this.parseJson(row.session_meta),
      itemCount: row.item_count,
      status: row.status as 'active' | 'archived' | 'expired',
    };
  }

  private parseJson(value: string | unknown): any {
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  }
}

// SQLite row types (snake_case column names)
interface RawMetadataRow {
  id: string;
  created: number;
  updated: number;
  expires_at: number | null;
  session_meta: string;
  item_count: number;
  status: string;
}

interface RawItemRow {
  id: number;
  rollout_id: string;
  timestamp: string;
  sequence: number;
  type: string;
  payload: string;
}
