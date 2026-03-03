/**
 * Server Scheduler Storage
 *
 * SQLite-backed ISchedulerStorage implementation for server mode.
 * Uses better-sqlite3 with WAL mode for concurrent read performance.
 *
 * Follows SessionIndex.ts patterns (prepared statements, WAL, directory creation).
 *
 * @module server/scheduler/ServerSchedulerStorage
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type {
  ISchedulerStorage,
  SchedulerTaskCounts,
} from '../../core/models/types/SchedulerContracts';
import type {
  SchedulerTaskRecord,
  SchedulerState,
} from '../../core/models/types/Scheduler';
import {
  createDefaultSchedulerState,
  createDraftTaskRecord,
  createScheduledTaskRecord,
} from '../../core/models/types/Scheduler';

// ─────────────────────────────────────────────────────────────────────────
// ServerSchedulerStorage
// ─────────────────────────────────────────────────────────────────────────

export class ServerSchedulerStorage implements ISchedulerStorage {
  private db: import('better-sqlite3').Database | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Initialize the SQLite database and create tables if needed.
   */
  async initialize(): Promise<void> {
    const schedulerDir = path.join(this.dataDir, 'scheduler');
    if (!fs.existsSync(schedulerDir)) {
      fs.mkdirSync(schedulerDir, { recursive: true });
    }

    const dbPath = path.join(schedulerDir, 'scheduler.db');

    // Dynamic import for better-sqlite3 (Node.js native module)
    const Database = (await import('better-sqlite3')).default;
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Create tasks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_tasks (
        id TEXT PRIMARY KEY,
        input TEXT NOT NULL,
        scheduledTime INTEGER,
        createdAt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        sessionId TEXT,
        completedAt INTEGER,
        error TEXT,
        result TEXT
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_status ON scheduler_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_scheduled_time ON scheduler_tasks(scheduledTime);
      CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_status_time ON scheduler_tasks(status, scheduledTime);
      CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_created_at ON scheduler_tasks(createdAt);
    `);

    // Create state table (single row)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        isPaused INTEGER NOT NULL DEFAULT 0,
        currentTaskId TEXT,
        lastProcessedTime INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Insert default state if not exists
    this.db.prepare(`
      INSERT OR IGNORE INTO scheduler_state (id, isPaused, currentTaskId, lastProcessedTime)
      VALUES (1, 0, NULL, 0)
    `).run();

    console.log('[ServerSchedulerStorage] Initialized at', dbPath);
  }

  private ensureDb(): import('better-sqlite3').Database {
    if (!this.db) {
      throw new Error('ServerSchedulerStorage not initialized');
    }
    return this.db;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Task CRUD
  // ─────────────────────────────────────────────────────────────────────

  async createTask(input: string, scheduledTime?: number): Promise<SchedulerTaskRecord> {
    const db = this.ensureDb();
    const id = uuidv4();
    const task = scheduledTime
      ? createScheduledTaskRecord(id, input, scheduledTime)
      : createDraftTaskRecord(id, input);

    db.prepare(`
      INSERT INTO scheduler_tasks (id, input, scheduledTime, createdAt, status, sessionId, completedAt, error, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.input,
      task.scheduledTime,
      task.createdAt,
      task.status,
      task.sessionId,
      task.completedAt,
      task.error,
      task.result ? JSON.stringify(task.result) : null,
    );

    return task;
  }

  async getTask(id: string): Promise<SchedulerTaskRecord | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM scheduler_tasks WHERE id = ?').get(id) as any;
    return row ? this.rowToTask(row) : null;
  }

  async updateTask(id: string, updates: Partial<SchedulerTaskRecord>): Promise<void> {
    const db = this.ensureDb();
    const existing = await this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const updated = { ...existing, ...updates, id };

    db.prepare(`
      UPDATE scheduler_tasks
      SET input = ?, scheduledTime = ?, createdAt = ?, status = ?,
          sessionId = ?, completedAt = ?, error = ?, result = ?
      WHERE id = ?
    `).run(
      updated.input,
      updated.scheduledTime,
      updated.createdAt,
      updated.status,
      updated.sessionId,
      updated.completedAt,
      updated.error,
      updated.result ? JSON.stringify(updated.result) : null,
      updated.id,
    );
  }

  async deleteTask(id: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM scheduler_tasks WHERE id = ?').run(id);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────

  async getDraftTasks(): Promise<SchedulerTaskRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM scheduler_tasks WHERE status = ? ORDER BY createdAt ASC'
    ).all('draft') as any[];
    return rows.map(r => this.rowToTask(r));
  }

  async getScheduledTasks(): Promise<SchedulerTaskRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM scheduler_tasks WHERE status = ? ORDER BY scheduledTime ASC'
    ).all('scheduled') as any[];
    return rows.map(r => this.rowToTask(r));
  }

  async getMissedTasks(): Promise<SchedulerTaskRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM scheduler_tasks WHERE status = ? ORDER BY scheduledTime ASC'
    ).all('missed') as any[];
    return rows.map(r => this.rowToTask(r));
  }

  async getSchedulerTaskQueueTasks(): Promise<SchedulerTaskRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM scheduler_tasks WHERE status = ? ORDER BY createdAt ASC'
    ).all('waiting') as any[];
    return rows.map(r => this.rowToTask(r));
  }

  async getArchivedTasks(limit: number, offset: number): Promise<SchedulerTaskRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      `SELECT * FROM scheduler_tasks
       WHERE status IN ('completed', 'failed')
       ORDER BY completedAt DESC
       LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];
    return rows.map(r => this.rowToTask(r));
  }

  async getNextTaskInSchedulerTaskQueue(): Promise<SchedulerTaskRecord | null> {
    const db = this.ensureDb();
    const row = db.prepare(
      'SELECT * FROM scheduler_tasks WHERE status = ? ORDER BY createdAt ASC LIMIT 1'
    ).get('waiting') as any;
    return row ? this.rowToTask(row) : null;
  }

  async getOverdueScheduledTasks(): Promise<SchedulerTaskRecord[]> {
    const db = this.ensureDb();
    const now = Date.now();
    const rows = db.prepare(
      'SELECT * FROM scheduler_tasks WHERE status = ? AND scheduledTime IS NOT NULL AND scheduledTime < ?'
    ).all('scheduled', now) as any[];
    return rows.map(r => this.rowToTask(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Scheduler State
  // ─────────────────────────────────────────────────────────────────────

  async getSchedulerState(): Promise<SchedulerState> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM scheduler_state WHERE id = 1').get() as any;
    if (!row) {
      return createDefaultSchedulerState();
    }
    return {
      isPaused: Boolean(row.isPaused),
      currentTaskId: row.currentTaskId ?? null,
      lastProcessedTime: row.lastProcessedTime ?? 0,
    };
  }

  async setSchedulerState(state: Partial<SchedulerState>): Promise<void> {
    const db = this.ensureDb();
    const current = await this.getSchedulerState();
    const updated = { ...current, ...state };

    db.prepare(`
      UPDATE scheduler_state
      SET isPaused = ?, currentTaskId = ?, lastProcessedTime = ?
      WHERE id = 1
    `).run(
      updated.isPaused ? 1 : 0,
      updated.currentTaskId,
      updated.lastProcessedTime,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // Task Counts
  // ─────────────────────────────────────────────────────────────────────

  async getTaskCounts(): Promise<SchedulerTaskCounts> {
    const db = this.ensureDb();
    const rows = db.prepare(
      `SELECT status, COUNT(*) as count FROM scheduler_tasks
       WHERE status IN ('draft', 'scheduled', 'missed', 'waiting', 'running')
       GROUP BY status`
    ).all() as { status: string; count: number }[];

    const counts: SchedulerTaskCounts = {
      draftCount: 0,
      scheduledCount: 0,
      missedCount: 0,
      waitingCount: 0,
      runningCount: 0,
    };

    for (const row of rows) {
      switch (row.status) {
        case 'draft': counts.draftCount = row.count; break;
        case 'scheduled': counts.scheduledCount = row.count; break;
        case 'missed': counts.missedCount = row.count; break;
        case 'waiting': counts.waitingCount = row.count; break;
        case 'running': counts.runningCount = row.count; break;
      }
    }

    return counts;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Convert a SQLite row to a SchedulerTaskRecord.
   */
  private rowToTask(row: any): SchedulerTaskRecord {
    return {
      id: row.id,
      input: row.input,
      scheduledTime: row.scheduledTime ?? null,
      createdAt: row.createdAt,
      status: row.status,
      sessionId: row.sessionId ?? null,
      completedAt: row.completedAt ?? null,
      error: row.error ?? null,
      result: row.result ? JSON.parse(row.result) : null,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[ServerSchedulerStorage] Database closed');
    }
  }
}
