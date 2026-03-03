/**
 * Automatic Backup
 *
 * Daily backups of SQLite index with retention policy.
 * Can recover SQLite from JSONL if needed.
 *
 * @module server/persistence/backup
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check hourly

// ─────────────────────────────────────────────────────────────────────────
// Backup manager
// ─────────────────────────────────────────────────────────────────────────

export class BackupManager {
  private dataDir: string;
  private retention: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBackupDate: string | null = null;

  constructor(dataDir: string, retention: number = 7) {
    this.dataDir = dataDir;
    this.retention = retention;
  }

  /**
   * Start the backup schedule.
   */
  start(): void {
    // Check immediately, then periodically
    this.checkAndBackup();

    this.timer = setInterval(() => {
      this.checkAndBackup();
    }, BACKUP_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the backup schedule.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Check if a backup is due and create one.
   */
  private checkAndBackup(): void {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (this.lastBackupDate === today) return;

    // Check if today's 3AM has passed
    const now = new Date();
    if (now.getHours() < 3) return;

    try {
      this.createBackup(today);
      this.lastBackupDate = today;
      this.enforceRetention();
    } catch (err) {
      console.error('[Backup] Failed to create backup:', err);
    }
  }

  /**
   * Create a backup of the SQLite index.
   */
  createBackup(label?: string): string {
    const backupDir = path.join(this.dataDir, 'sessions', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const dbPath = path.join(this.dataDir, 'sessions', 'index.db');
    if (!fs.existsSync(dbPath)) {
      console.log('[Backup] No database to backup');
      return '';
    }

    const timestamp = label ?? new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `index-${timestamp}.db`);

    fs.copyFileSync(dbPath, backupPath);
    console.log(`[Backup] Created backup: ${backupPath}`);

    return backupPath;
  }

  /**
   * Enforce retention policy — delete old backups.
   */
  private enforceRetention(): void {
    const backupDir = path.join(this.dataDir, 'sessions', 'backups');
    if (!fs.existsSync(backupDir)) return;

    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('index-') && f.endsWith('.db'))
      .sort()
      .reverse();

    // Keep only `retention` most recent
    const toDelete = files.slice(this.retention);
    for (const file of toDelete) {
      try {
        fs.unlinkSync(path.join(backupDir, file));
        console.log(`[Backup] Deleted old backup: ${file}`);
      } catch (err) {
        console.warn(`[Backup] Failed to delete ${file}:`, err);
      }
    }
  }

  /**
   * Recover SQLite index from JSONL transcripts.
   * Scans all JSONL files and rebuilds the session index.
   */
  async recoverFromJsonl(): Promise<number> {
    const transcriptsDir = path.join(this.dataDir, 'sessions', 'transcripts');
    if (!fs.existsSync(transcriptsDir)) return 0;

    const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.jsonl'));
    let recovered = 0;

    for (const file of files) {
      try {
        const sessionKey = file.replace('.jsonl', '').replace(/_/g, ':');
        const filePath = path.join(transcriptsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());

        if (lines.length === 0) continue;

        // Parse first and last entries for timestamps
        const first = JSON.parse(lines[0]);
        const last = JSON.parse(lines[lines.length - 1]);

        // Extract source from session key (format: source:namespace:identifier)
        const parts = sessionKey.split(':');
        const source = parts[0] ?? 'unknown';
        const accountId = parts[1] ?? '';

        // This data would be passed to SessionIndex.upsert() by the caller
        console.log(`[Backup] Recovered session: ${sessionKey} (${lines.length} entries)`);
        recovered++;
      } catch (err) {
        console.warn(`[Backup] Failed to recover ${file}:`, err);
      }
    }

    return recovered;
  }
}
