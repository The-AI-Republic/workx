/**
 * Server Schedule Storage (SQLite)
 *
 * SQLite-backed IScheduleStorage implementation for server mode.
 * Stores ScheduleEvent and ScheduleEventException records.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { IScheduleStorage } from '../../core/models/types/ScheduleContracts';
import type {
  ScheduleEvent,
  ScheduleEventException,
} from '../../core/models/types/ScheduleEvent';

export class ServerScheduleStorage implements IScheduleStorage {
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

    const dbPath = path.join(schedulerDir, 'schedule_events.db');
    const Database = (await import('better-sqlite3')).default;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Create schedule_events table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_events (
        id TEXT PRIMARY KEY,
        input TEXT NOT NULL,
        scheduledTime INTEGER NOT NULL,
        rrule TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        exdates TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedule_events_enabled ON schedule_events(enabled);
      CREATE INDEX IF NOT EXISTS idx_schedule_events_scheduled_time ON schedule_events(scheduledTime);
    `);

    // Create schedule_exceptions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_exceptions (
        scheduleEventId TEXT NOT NULL,
        instanceTime INTEGER NOT NULL,
        overrideInput TEXT,
        overrideTime INTEGER,
        PRIMARY KEY (scheduleEventId, instanceTime),
        FOREIGN KEY (scheduleEventId) REFERENCES schedule_events(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedule_exceptions_event ON schedule_exceptions(scheduleEventId);
    `);

    console.log('[ServerScheduleStorage] Initialized at', dbPath);
  }

  private ensureDb(): import('better-sqlite3').Database {
    if (!this.db) throw new Error('ServerScheduleStorage not initialized');
    return this.db;
  }

  // ==========================================================================
  // Event CRUD
  // ==========================================================================

  async createEvent(event: ScheduleEvent): Promise<void> {
    const db = this.ensureDb();
    db.prepare(`
      INSERT INTO schedule_events (id, input, scheduledTime, rrule, enabled, exdates, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.input,
      event.scheduledTime,
      event.rrule,
      event.enabled ? 1 : 0,
      JSON.stringify(event.exdates),
      event.createdAt,
      event.updatedAt,
    );
  }

  async getEvent(id: string): Promise<ScheduleEvent | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM schedule_events WHERE id = ?').get(id) as any;
    return row ? this.rowToEvent(row) : null;
  }

  async updateEvent(id: string, updates: Partial<ScheduleEvent>): Promise<void> {
    const db = this.ensureDb();
    const existing = await this.getEvent(id);
    if (!existing) throw new Error(`Schedule event not found: ${id}`);

    const updated = { ...existing, ...updates, id };
    db.prepare(`
      UPDATE schedule_events
      SET input = ?, scheduledTime = ?, rrule = ?, enabled = ?, exdates = ?, createdAt = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      updated.input,
      updated.scheduledTime,
      updated.rrule,
      updated.enabled ? 1 : 0,
      JSON.stringify(updated.exdates),
      updated.createdAt,
      updated.updatedAt,
      updated.id,
    );
  }

  async deleteEvent(id: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM schedule_events WHERE id = ?').run(id);
  }

  // ==========================================================================
  // Event Queries
  // ==========================================================================

  async getAllEvents(): Promise<ScheduleEvent[]> {
    const db = this.ensureDb();
    const rows = db.prepare('SELECT * FROM schedule_events').all() as any[];
    return rows.map(r => this.rowToEvent(r));
  }

  async getEnabledEvents(): Promise<ScheduleEvent[]> {
    const db = this.ensureDb();
    const rows = db.prepare('SELECT * FROM schedule_events WHERE enabled = 1').all() as any[];
    return rows.map(r => this.rowToEvent(r));
  }

  async getEventsInRange(startTime: number, endTime: number): Promise<ScheduleEvent[]> {
    const db = this.ensureDb();
    // For recurring events: include if scheduledTime <= endTime
    // For one-shot: scheduledTime in range
    const rows = db.prepare(`
      SELECT * FROM schedule_events
      WHERE (rrule IS NOT NULL AND scheduledTime <= ?)
         OR (rrule IS NULL AND scheduledTime >= ? AND scheduledTime <= ?)
    `).all(endTime, startTime, endTime) as any[];
    return rows.map(r => this.rowToEvent(r));
  }

  // ==========================================================================
  // Exception CRUD
  // ==========================================================================

  async createException(exception: ScheduleEventException): Promise<void> {
    const db = this.ensureDb();
    db.prepare(`
      INSERT OR REPLACE INTO schedule_exceptions (scheduleEventId, instanceTime, overrideInput, overrideTime)
      VALUES (?, ?, ?, ?)
    `).run(
      exception.scheduleEventId,
      exception.instanceTime,
      exception.overrideInput ?? null,
      exception.overrideTime ?? null,
    );
  }

  async getExceptions(scheduleEventId: string): Promise<ScheduleEventException[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM schedule_exceptions WHERE scheduleEventId = ?'
    ).all(scheduleEventId) as any[];
    return rows.map(r => this.rowToException(r));
  }

  async getException(
    scheduleEventId: string,
    instanceTime: number
  ): Promise<ScheduleEventException | null> {
    const db = this.ensureDb();
    const row = db.prepare(
      'SELECT * FROM schedule_exceptions WHERE scheduleEventId = ? AND instanceTime = ?'
    ).get(scheduleEventId, instanceTime) as any;
    return row ? this.rowToException(row) : null;
  }

  async deleteException(scheduleEventId: string, instanceTime: number): Promise<void> {
    const db = this.ensureDb();
    db.prepare(
      'DELETE FROM schedule_exceptions WHERE scheduleEventId = ? AND instanceTime = ?'
    ).run(scheduleEventId, instanceTime);
  }

  async deleteAllExceptions(scheduleEventId: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare(
      'DELETE FROM schedule_exceptions WHERE scheduleEventId = ?'
    ).run(scheduleEventId);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private rowToEvent(row: any): ScheduleEvent {
    let exdates: number[] = [];
    try {
      exdates = JSON.parse(row.exdates || '[]');
    } catch { /* ignore */ }

    return {
      id: row.id,
      input: row.input,
      scheduledTime: row.scheduledTime,
      rrule: row.rrule ?? null,
      enabled: Boolean(row.enabled),
      exdates,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToException(row: any): ScheduleEventException {
    return {
      scheduleEventId: row.scheduleEventId,
      instanceTime: row.instanceTime,
      overrideInput: row.overrideInput ?? undefined,
      overrideTime: row.overrideTime ?? undefined,
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
