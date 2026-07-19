/**
 * TSRolloutStorageProvider
 *
 * TypeScript/Node.js implementation of RolloutStorageProvider using better-sqlite3.
 *
 * Used by server mode and by the desktop runtime sidecar.
 */

import type { RolloutStorageProvider, StorageStats } from './RolloutStorageProvider';
import type {
  ConversationId,
  RolloutMetadataRecord,
  RolloutItemRecord,
  ConversationsPage,
  Cursor,
  RolloutRecoveryMetadata,
  RolloutItemRange,
} from '../types';
import { applyRecoveryMutations, emptyRecoveryMetadata } from './RolloutRecovery';

export class TSRolloutStorageProvider implements RolloutStorageProvider {
  private db: import('better-sqlite3').Database | null = null;
  private dataDir: string | null;
  private dbPath: string | null;

  constructor(dataDirOrOptions: string | { dataDir?: string; dbPath?: string }) {
    if (typeof dataDirOrOptions === 'string') {
      this.dataDir = dataDirOrOptions;
      this.dbPath = null;
    } else {
      this.dataDir = dataDirOrOptions.dataDir ?? null;
      this.dbPath = dataDirOrOptions.dbPath ?? null;
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async initialize(): Promise<void> {
    const { default: Database } = await import('better-sqlite3');
    const { join } = await import('node:path');
    const { existsSync, mkdirSync } = await import('node:fs');

    const dir = this.dbPath
      ? this.dbPath.replace(/[\\/][^\\/]*$/, '') || '.'
      : join(this.dataDir ?? '', 'rollouts');
    const dbPath = this.dbPath ?? join(dir, 'rollouts.db');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
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

  async createRollout(
    metadata: RolloutMetadataRecord,
    items: Array<{ timestamp: string; sequence: number; type: string; payload: unknown }>,
  ): Promise<boolean> {
    const db = this.getDb();
    const exists = db.prepare('SELECT 1 FROM rollout_metadata WHERE id = ?');
    const insertMetadata = db.prepare(
      `INSERT INTO rollout_metadata (id, created, updated, expires_at, session_meta, item_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertItem = db.prepare(
      `INSERT INTO rollout_items (rollout_id, timestamp, sequence, type, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const transaction = db.transaction(() => {
      if (exists.get(metadata.id)) return false;
      insertMetadata.run(
        metadata.id,
        metadata.created,
        metadata.updated,
        metadata.expiresAt ?? null,
        JSON.stringify(metadata.sessionMeta),
        items.length,
        metadata.status,
      );
      for (const item of items) {
        insertItem.run(
          metadata.id,
          item.timestamp,
          item.sequence,
          item.type,
          typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload),
        );
      }
      return true;
    });
    return transaction();
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

  async getRecoveryMetadata(rolloutId: ConversationId): Promise<RolloutRecoveryMetadata> {
    const metadata = await this.getMetadata(rolloutId);
    return structuredClone(metadata?.sessionMeta.runtimeRecovery ?? emptyRecoveryMetadata());
  }

  async listOpenTurnRecovery(): Promise<Array<{
    sessionId: ConversationId;
    recovery: RolloutRecoveryMetadata;
  }>> {
    const rows = this.getDb().prepare(
      'SELECT id, session_meta FROM rollout_metadata WHERE session_meta IS NOT NULL',
    ).all() as Array<{ id: string; session_meta: string }>;
    return rows.flatMap((row) => {
      const sessionMeta = this.parseJson(row.session_meta) as RolloutMetadataRecord['sessionMeta'];
      return sessionMeta.runtimeRecovery?.openTurns.length
        ? [{ sessionId: row.id, recovery: structuredClone(sessionMeta.runtimeRecovery) }]
        : [];
    });
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
    const getMetadata = db.prepare(
      'SELECT session_meta FROM rollout_metadata WHERE id = ?'
    );
    const updateCount = db.prepare(
      `UPDATE rollout_metadata
       SET item_count = item_count + ?, updated = ?, session_meta = ?
       WHERE id = ?`
    );

    const tx = db.transaction(() => {
      for (const item of items) {
        const payload = typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload);
        insertItem.run(rolloutId, item.timestamp, item.sequence, item.type, payload);
      }
      const row = getMetadata.get(rolloutId) as { session_meta: string } | undefined;
      if (row) {
        const sessionMeta = applyRecoveryMutations(this.parseJson(row.session_meta), items);
        updateCount.run(items.length, Date.now(), JSON.stringify(sessionMeta), rolloutId);
      }
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

  async getItemsByRolloutIdRange(
    rolloutId: ConversationId,
    range: RolloutItemRange,
  ): Promise<RolloutItemRecord[]> {
    const limit = normalizeRangeLimit(range.limit);
    const clauses = ['rollout_id = ?'];
    const params: Array<string | number> = [rolloutId];
    if (range.afterSequence !== undefined) {
      clauses.push('sequence > ?');
      params.push(range.afterSequence);
    }
    if (range.beforeSequence !== undefined) {
      clauses.push('sequence < ?');
      params.push(range.beforeSequence);
    }
    params.push(limit);
    const rows = this.getDb().prepare(
      `SELECT id, rollout_id, timestamp, sequence, type, payload
       FROM rollout_items
       WHERE ${clauses.join(' AND ')}
       ORDER BY sequence ${range.direction === 'desc' ? 'DESC' : 'ASC'}
       LIMIT ?`,
    ).all(...params) as RawItemRow[];
    return rows.map((row) => ({
      id: row.id,
      rolloutId: row.rollout_id,
      timestamp: row.timestamp,
      sequence: row.sequence,
      type: row.type,
      payload: this.parseJson(row.payload),
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

function normalizeRangeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('range limit must be an integer from 1 to 1000');
  }
  return limit;
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
