import type { MemoryStore, MemoryHistoryStore } from '@/core/memory/MemoryStore';
import type {
  MemoryCategory,
  MemoryConfig,
  MemoryFact,
  MemoryOperation,
  MemoryScope,
  MemorySearchResult,
} from '@/core/memory/types';

type BetterSqlite3Database = import('better-sqlite3').Database;

function rowToFact(row: Record<string, unknown>): MemoryFact {
  return {
    id: row.id as string,
    factText: row.fact_text as string,
    category: row.category as MemoryCategory,
    scope: {
      userId: (row.user_id as string) || undefined,
      agentId: (row.agent_id as string) || undefined,
      sessionId: (row.session_id as string) || undefined,
    },
    contentHash: row.content_hash as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastAccessedAt: row.last_accessed_at as number,
    accessCount: row.access_count as number,
    metadata: row.metadata
      ? (() => { try { return JSON.parse(row.metadata as string); } catch { return undefined; } })()
      : undefined,
  };
}

/**
 * Convert Float32Array to Buffer of raw little-endian f32 bytes
 * as expected by sqlite-vec.
 */
function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Server (Node.js) implementation of MemoryStore.
 * Uses better-sqlite3 with the sqlite-vec loadable extension.
 */
export class NodeMemoryStore implements MemoryStore, MemoryHistoryStore {
  private db: BetterSqlite3Database | null = null;
  private dataDir: string;

  private getDb(): BetterSqlite3Database {
    if (!this.db) {
      throw new Error('NodeMemoryStore: database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  constructor(dataDir?: string) {
    this.dataDir =
      dataDir ??
      (() => {
        const os = require('os');
        const path = require('path');
        return path.join(os.homedir(), '.airepublic-pi');
      })();
  }

  async initialize(config: MemoryConfig): Promise<void> {
    const path = require('path');
    const fs = require('fs');

    const storageDir = path.join(this.dataDir, 'storage');
    fs.mkdirSync(storageDir, { recursive: true });

    const dbPath = path.join(storageDir, 'memory.db');

    const Database = require('better-sqlite3');
    this.db = new Database(dbPath) as BetterSqlite3Database;

    // Enable WAL mode
    this.getDb().pragma('journal_mode = WAL');

    // Load sqlite-vec extension
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(this.db);

    // Verify sqlite-vec loaded
    const versionRow = this.getDb().prepare('SELECT vec_version()').get() as Record<string, string>;
    if (!versionRow) {
      throw new Error('sqlite-vec extension failed to load');
    }

    // Run schema migration
    this.runMigration(config.embeddingDimensions);

    // Check for dimension mismatch
    const schemaDims = await this.getSchemaDimensions();
    if (schemaDims && schemaDims !== config.embeddingDimensions) {
      console.warn(
        `[Memory] Dimension mismatch: schema=${schemaDims}, config=${config.embeddingDimensions}. Migrating...`
      );
      await this.migrateDimensions(config.embeddingDimensions);
    }
  }

  private assertValidDimensions(dimensions: number): void {
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 10000) {
      throw new Error(`Invalid embedding dimensions: ${dimensions}. Must be an integer between 1 and 10000.`);
    }
  }

  private runMigration(dimensions: number): void {
    this.assertValidDimensions(dimensions);
    const db = this.getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        fact_text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        user_id TEXT,
        agent_id TEXT,
        session_id TEXT,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_facts_user ON memory_facts(user_id);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_hash ON memory_facts(content_hash);

      CREATE TABLE IF NOT EXISTS memory_history (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        event TEXT NOT NULL,
        old_content TEXT,
        new_content TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_history_memory ON memory_history(memory_id);

      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Create vec0 virtual table only if it doesn't exist
    const tableExists = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='memory_embeddings'"
      )
      .get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) {
      db.exec(`
        CREATE VIRTUAL TABLE memory_embeddings USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${dimensions}]
        )
      `);
    }

    // Insert initial metadata (idempotent)
    db.prepare(
      "INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('embedding_dimensions', ?)"
    ).run(String(dimensions));

    db.prepare(
      "INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('schema_version', '1')"
    ).run();

    db.prepare(
      "INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('migration_status', 'COMPLETE')"
    ).run();
  }

  async insert(fact: MemoryFact, embedding: Float32Array): Promise<void> {
    const db = this.getDb();
    const now = Date.now();

    const insertFn = db.transaction(() => {
      db.prepare(
        `INSERT INTO memory_facts (id, fact_text, category, user_id, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(
        fact.id,
        fact.factText,
        fact.category,
        fact.scope.userId ?? null,
        fact.scope.agentId ?? null,
        fact.scope.sessionId ?? null,
        fact.contentHash,
        now,
        now,
        now,
        fact.metadata ? JSON.stringify(fact.metadata) : null
      );

      db.prepare(
        'INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)'
      ).run(fact.id, float32ToBuffer(embedding));
    });

    insertFn();
  }

  async update(
    id: string,
    fact: Partial<MemoryFact>,
    embedding: Float32Array
  ): Promise<void> {
    const db = this.getDb();
    const now = Date.now();

    const updateFn = db.transaction(() => {
      // Build SET clause dynamically to avoid overwriting existing values with empty defaults
      const setClauses: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];

      if (fact.factText !== undefined) { setClauses.push('fact_text = ?'); params.push(fact.factText); }
      if (fact.category !== undefined) { setClauses.push('category = ?'); params.push(fact.category); }
      if (fact.contentHash !== undefined) { setClauses.push('content_hash = ?'); params.push(fact.contentHash); }
      if (fact.metadata !== undefined) { setClauses.push('metadata = ?'); params.push(JSON.stringify(fact.metadata)); }

      params.push(id);
      db.prepare(
        `UPDATE memory_facts SET ${setClauses.join(', ')} WHERE id = ?`
      ).run(...params);

      // sqlite-vec: delete old, insert new
      db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
      db.prepare(
        'INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)'
      ).run(id, float32ToBuffer(embedding));
    });

    updateFn();
  }

  async delete(id: string): Promise<void> {
    const db = this.getDb();

    const deleteFn = db.transaction(() => {
      db.prepare('DELETE FROM memory_facts WHERE id = ?').run(id);
      db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
    });

    deleteFn();
  }

  async search(
    embedding: Float32Array,
    limit: number,
    _scope?: MemoryScope
  ): Promise<MemorySearchResult[]> {
    const db = this.getDb();
    const embeddingBuf = float32ToBuffer(embedding);

    // M6: Single-user system — no userId filtering needed
    const rows = db
      .prepare(
        `SELECT
          mf.id, mf.fact_text, mf.category,
          mf.user_id, mf.agent_id, mf.session_id,
          mf.content_hash, mf.created_at, mf.updated_at,
          mf.last_accessed_at, mf.access_count, mf.metadata,
          me.distance
        FROM memory_embeddings me
        INNER JOIN memory_facts mf ON mf.id = me.memory_id
        WHERE me.embedding MATCH ?
          AND k = ?
        ORDER BY me.distance`
      )
      .all(embeddingBuf, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      fact: rowToFact(row),
      distance: row.distance as number,
    }));
  }

  async getByCategories(
    categories: MemoryCategory[],
    scope?: MemoryScope
  ): Promise<MemoryFact[]> {
    if (categories.length === 0) return [];

    const db = this.getDb();
    const placeholders = categories.map(() => '?').join(', ');
    let query = `SELECT id, fact_text, category, user_id, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata
                 FROM memory_facts WHERE category IN (${placeholders})`;

    const params: unknown[] = [...categories];

    if (scope?.userId) {
      query += ' AND user_id = ?';
      params.push(scope.userId);
    }

    const rows = db.prepare(query).all(...params) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToFact);
  }

  async getById(id: string): Promise<MemoryFact | null> {
    const db = this.getDb();
    const row = db
      .prepare(
        'SELECT id, fact_text, category, user_id, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata FROM memory_facts WHERE id = ?'
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToFact(row) : null;
  }

  async getAll(scope?: MemoryScope, limit?: number, offset?: number): Promise<MemoryFact[]> {
    const db = this.getDb();
    let query =
      'SELECT id, fact_text, category, user_id, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata FROM memory_facts';

    const params: unknown[] = [];

    if (scope?.userId) {
      query += ' WHERE user_id = ?';
      params.push(scope.userId);
    }

    query += ' ORDER BY updated_at DESC';

    if (limit || offset) {
      query += ' LIMIT ?';
      params.push(limit || 1000000);
    }
    if (offset) {
      query += ' OFFSET ?';
      params.push(offset);
    }

    const rows = db.prepare(query).all(...params) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToFact);
  }

  async updateAccessStats(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const db = this.getDb();
    const now = Date.now();

    const updateFn = db.transaction(() => {
      const stmt = db.prepare(
        'UPDATE memory_facts SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?'
      );
      for (const id of ids) {
        stmt.run(now, id);
      }
    });

    updateFn();
  }

  async count(scope?: MemoryScope): Promise<number> {
    const db = this.getDb();

    if (scope?.userId) {
      const row = db
        .prepare('SELECT COUNT(*) as cnt FROM memory_facts WHERE user_id = ?')
        .get(scope.userId) as { cnt: number };
      return row.cnt;
    }

    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM memory_facts')
      .get() as { cnt: number };
    return row.cnt;
  }

  async getSchemaDimensions(): Promise<number | null> {
    const db = this.getDb();
    const row = db
      .prepare("SELECT value FROM memory_meta WHERE key = 'embedding_dimensions'")
      .get() as { value: string } | undefined;

    if (!row) return null;
    return parseInt(row.value, 10) || null;
  }

  async migrateDimensions(newDimensions: number): Promise<void> {
    this.assertValidDimensions(newDimensions);
    const db = this.getDb();

    // Set migration status to PENDING
    db.prepare(
      "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('migration_status', 'PENDING')"
    ).run();

    // Drop and recreate vec0 table
    db.exec('DROP TABLE IF EXISTS memory_embeddings');
    db.exec(`
      CREATE VIRTUAL TABLE memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${newDimensions}]
      )
    `);

    // Update dimensions metadata
    db.prepare(
      "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('embedding_dimensions', ?)"
    ).run(String(newDimensions));
  }

  async setMigrationStatus(status: 'COMPLETE' | 'PENDING'): Promise<void> {
    const db = this.getDb();
    db.prepare(
      "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('migration_status', ?)"
    ).run(status);
  }

  async getMigrationStatus(): Promise<'COMPLETE' | 'PENDING'> {
    const db = this.getDb();
    const row = db
      .prepare("SELECT value FROM memory_meta WHERE key = 'migration_status'")
      .get() as { value: string } | undefined;

    return (row?.value as 'COMPLETE' | 'PENDING') || 'COMPLETE';
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // MemoryHistoryStore implementation

  async logOperation(op: MemoryOperation): Promise<void> {
    const db = this.getDb();
    db.prepare(
      'INSERT INTO memory_history (id, memory_id, event, old_content, new_content, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(op.id, op.memoryId, op.event, op.oldContent, op.newContent, op.timestamp);
  }

  async getHistory(memoryId: string): Promise<MemoryOperation[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        'SELECT id, memory_id, event, old_content, new_content, timestamp FROM memory_history WHERE memory_id = ? ORDER BY timestamp DESC'
      )
      .all(memoryId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      memoryId: row.memory_id as string,
      event: row.event as MemoryOperation['event'],
      oldContent: (row.old_content as string) ?? null,
      newContent: (row.new_content as string) ?? null,
      timestamp: row.timestamp as number,
    }));
  }

  async getAllHistory(
    limit?: number,
    offset?: number
  ): Promise<MemoryOperation[]> {
    const db = this.getDb();
    let query =
      'SELECT id, memory_id, event, old_content, new_content, timestamp FROM memory_history ORDER BY timestamp DESC';

    const params: unknown[] = [];
    // M7: OFFSET requires LIMIT in SQLite — add default large limit if needed
    if (limit || offset) {
      query += ' LIMIT ?';
      params.push(limit || 1000000);
    }
    if (offset) {
      query += ' OFFSET ?';
      params.push(offset);
    }

    const rows = db.prepare(query).all(...params) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: row.id as string,
      memoryId: row.memory_id as string,
      event: row.event as MemoryOperation['event'],
      oldContent: (row.old_content as string) ?? null,
      newContent: (row.new_content as string) ?? null,
      timestamp: row.timestamp as number,
    }));
  }
}
