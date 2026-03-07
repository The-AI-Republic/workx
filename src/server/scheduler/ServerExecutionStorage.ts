/**
 * Server Execution Storage (SQLite)
 *
 * SQLite-backed IExecutionStorage implementation for server mode.
 * Stores ExecutionRecord entries tracking each job run.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { IExecutionStorage } from '../../core/models/types/ScheduleContracts';
import type { ExecutionRecord, ExecutionStatus } from '../../core/models/types/ScheduleEvent';

export class ServerExecutionStorage implements IExecutionStorage {
  private db: import('better-sqlite3').Database | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async initialize(): Promise<void> {
    const schedulerDir = path.join(this.dataDir, 'scheduler');
    if (!fs.existsSync(schedulerDir)) {
      fs.mkdirSync(schedulerDir, { recursive: true });
    }

    const dbPath = path.join(schedulerDir, 'executions.db');
    const Database = (await import('better-sqlite3')).default;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_records (
        id TEXT PRIMARY KEY,
        scheduleEventId TEXT NOT NULL,
        instanceTime INTEGER NOT NULL,
        input TEXT NOT NULL DEFAULT '',
        sessionId TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        result TEXT,
        error TEXT,
        startedAt INTEGER,
        completedAt INTEGER
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_exec_event_id ON execution_records(scheduleEventId);
      CREATE INDEX IF NOT EXISTS idx_exec_status ON execution_records(status);
      CREATE INDEX IF NOT EXISTS idx_exec_event_instance ON execution_records(scheduleEventId, instanceTime);
      CREATE INDEX IF NOT EXISTS idx_exec_instance_time ON execution_records(instanceTime);
    `);

    console.log('[ServerExecutionStorage] Initialized at', dbPath);
  }

  private ensureDb(): import('better-sqlite3').Database {
    if (!this.db) throw new Error('ServerExecutionStorage not initialized');
    return this.db;
  }

  // ==========================================================================
  // Execution CRUD
  // ==========================================================================

  async createExecution(record: ExecutionRecord): Promise<void> {
    const db = this.ensureDb();
    db.prepare(`
      INSERT INTO execution_records (id, scheduleEventId, instanceTime, input, sessionId, status, result, error, startedAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.scheduleEventId,
      record.instanceTime,
      record.input,
      record.sessionId,
      record.status,
      record.result ? JSON.stringify(record.result) : null,
      record.error,
      record.startedAt,
      record.completedAt,
    );
  }

  async getExecution(id: string): Promise<ExecutionRecord | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM execution_records WHERE id = ?').get(id) as any;
    return row ? this.rowToRecord(row) : null;
  }

  async updateExecution(id: string, updates: Partial<ExecutionRecord>): Promise<void> {
    const db = this.ensureDb();
    const existing = await this.getExecution(id);
    if (!existing) throw new Error(`Execution record not found: ${id}`);

    const updated = { ...existing, ...updates, id };
    db.prepare(`
      UPDATE execution_records
      SET scheduleEventId = ?, instanceTime = ?, input = ?, sessionId = ?, status = ?,
          result = ?, error = ?, startedAt = ?, completedAt = ?
      WHERE id = ?
    `).run(
      updated.scheduleEventId,
      updated.instanceTime,
      updated.input,
      updated.sessionId,
      updated.status,
      updated.result ? JSON.stringify(updated.result) : null,
      updated.error,
      updated.startedAt,
      updated.completedAt,
      updated.id,
    );
  }

  async deleteExecution(id: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM execution_records WHERE id = ?').run(id);
  }

  // ==========================================================================
  // Execution Queries
  // ==========================================================================

  async getExecutionsByEvent(scheduleEventId: string): Promise<ExecutionRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM execution_records WHERE scheduleEventId = ? ORDER BY instanceTime ASC'
    ).all(scheduleEventId) as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  async getExecutionByInstance(
    scheduleEventId: string,
    instanceTime: number
  ): Promise<ExecutionRecord | null> {
    const db = this.ensureDb();
    const row = db.prepare(
      'SELECT * FROM execution_records WHERE scheduleEventId = ? AND instanceTime = ?'
    ).get(scheduleEventId, instanceTime) as any;
    return row ? this.rowToRecord(row) : null;
  }

  async getExecutionsByStatus(status: ExecutionStatus): Promise<ExecutionRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM execution_records WHERE status = ?'
    ).all(status) as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  async getExecutionsInRange(startTime: number, endTime: number): Promise<ExecutionRecord[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM execution_records WHERE instanceTime >= ? AND instanceTime <= ?'
    ).all(startTime, endTime) as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  async getLatestExecution(scheduleEventId: string): Promise<ExecutionRecord | null> {
    const db = this.ensureDb();
    const row = db.prepare(
      'SELECT * FROM execution_records WHERE scheduleEventId = ? ORDER BY instanceTime DESC LIMIT 1'
    ).get(scheduleEventId) as any;
    return row ? this.rowToRecord(row) : null;
  }

  async getRunningExecutions(): Promise<ExecutionRecord[]> {
    return this.getExecutionsByStatus('running');
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private rowToRecord(row: any): ExecutionRecord {
    let result = null;
    if (row.result) {
      try {
        result = JSON.parse(row.result);
      } catch { /* ignore */ }
    }

    return {
      id: row.id,
      scheduleEventId: row.scheduleEventId,
      instanceTime: row.instanceTime,
      input: row.input ?? '',
      sessionId: row.sessionId ?? null,
      status: row.status,
      result,
      error: row.error ?? null,
      startedAt: row.startedAt ?? null,
      completedAt: row.completedAt ?? null,
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
