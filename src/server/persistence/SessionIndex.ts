/**
 * Session Index (SQLite)
 *
 * SQLite-based session metadata index for fast queries.
 * This is the "fast lookup" tier — full transcripts live in JSONL files.
 *
 * @module server/persistence/SessionIndex
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface SessionRecord {
  key: string;
  label: string;
  source: string;
  accountId: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  model: string;
  thinkingLevel: string;
  status: 'active' | 'archived';
}

export interface SessionFilters {
  source?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// SessionIndex
// ─────────────────────────────────────────────────────────────────────────

export class SessionIndex {
  private db: import('better-sqlite3').Database | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Initialize the SQLite database and create tables if needed.
   */
  async initialize(): Promise<void> {
    const sessionsDir = path.join(this.dataDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const dbPath = path.join(sessionsDir, 'index.db');

    // Dynamic import for better-sqlite3 (Node.js native module)
    const Database = (await import('better-sqlite3')).default;
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Create table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        accountId TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL,
        lastActivity INTEGER NOT NULL,
        messageCount INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        thinkingLevel TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_lastActivity ON sessions(lastActivity);
    `);
  }

  /**
   * Upsert a session record.
   */
  upsert(record: SessionRecord): void {
    if (!this.db) throw new Error('SessionIndex not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO sessions (key, label, source, accountId, createdAt, lastActivity, messageCount, model, thinkingLevel, status)
      VALUES (@key, @label, @source, @accountId, @createdAt, @lastActivity, @messageCount, @model, @thinkingLevel, @status)
      ON CONFLICT(key) DO UPDATE SET
        label = @label,
        lastActivity = @lastActivity,
        messageCount = @messageCount,
        model = @model,
        thinkingLevel = @thinkingLevel,
        status = @status
    `);

    stmt.run(record);
  }

  /**
   * Get a session by key.
   */
  get(key: string): SessionRecord | null {
    if (!this.db) throw new Error('SessionIndex not initialized');

    const stmt = this.db.prepare('SELECT * FROM sessions WHERE key = ?');
    return (stmt.get(key) as SessionRecord) ?? null;
  }

  /**
   * List sessions with optional filters.
   */
  list(filters?: SessionFilters): SessionRecord[] {
    if (!this.db) throw new Error('SessionIndex not initialized');

    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.source) {
      sql += ' AND source = ?';
      params.push(filters.source);
    }
    if (filters?.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }

    sql += ' ORDER BY lastActivity DESC';

    if (filters?.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }
    if (filters?.offset) {
      sql += ' OFFSET ?';
      params.push(filters.offset);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as SessionRecord[];
  }

  /**
   * Update session metadata.
   */
  patch(key: string, patch: Partial<SessionRecord>): void {
    if (!this.db) throw new Error('SessionIndex not initialized');

    const existing = this.get(key);
    if (!existing) return;

    this.upsert({ ...existing, ...patch, key });
  }

  /**
   * Increment message count and update lastActivity.
   */
  touch(key: string): void {
    if (!this.db) throw new Error('SessionIndex not initialized');

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET messageCount = messageCount + 1, lastActivity = ?
      WHERE key = ?
    `);
    stmt.run(Date.now(), key);
  }

  /**
   * Delete a session from the index.
   */
  delete(key: string): void {
    if (!this.db) throw new Error('SessionIndex not initialized');

    const stmt = this.db.prepare('DELETE FROM sessions WHERE key = ?');
    stmt.run(key);
  }

  /**
   * Get total session count.
   */
  count(): number {
    if (!this.db) throw new Error('SessionIndex not initialized');

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM sessions');
    return (stmt.get() as { count: number }).count;
  }

  /**
   * Close the database.
   */
  close(): void {
    this.db?.close();
    this.db = null;
  }
}
