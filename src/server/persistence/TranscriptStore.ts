/**
 * Transcript Store (JSONL)
 *
 * Append-only JSONL transcript storage with buffered writes.
 * One file per session, one JSON object per line.
 *
 * @module server/persistence/TranscriptStore
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BUFFER_BYTES = 64 * 1024; // 64KB

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface TranscriptEntry {
  ts: number;
  type: string;
  data: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// TranscriptStore
// ─────────────────────────────────────────────────────────────────────────

export class TranscriptStore {
  private transcriptsDir: string;
  private buffers: Map<string, string[]> = new Map();
  private bufferSizes: Map<string, number> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.transcriptsDir = path.join(dataDir, 'sessions', 'transcripts');
  }

  /**
   * Initialize the store. Creates directories if needed.
   */
  async initialize(): Promise<void> {
    if (!fs.existsSync(this.transcriptsDir)) {
      fs.mkdirSync(this.transcriptsDir, { recursive: true });
    }

    // Start periodic flush timer
    this.flushTimer = setInterval(() => {
      this.flushAll();
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * Append an entry to a session's transcript.
   */
  append(sessionKey: string, entry: TranscriptEntry): void {
    const line = JSON.stringify(entry) + '\n';

    if (!this.buffers.has(sessionKey)) {
      this.buffers.set(sessionKey, []);
      this.bufferSizes.set(sessionKey, 0);
    }

    this.buffers.get(sessionKey)!.push(line);
    this.bufferSizes.set(
      sessionKey,
      (this.bufferSizes.get(sessionKey) ?? 0) + line.length
    );

    // Flush if buffer exceeds threshold
    if ((this.bufferSizes.get(sessionKey) ?? 0) >= FLUSH_BUFFER_BYTES) {
      this.flush(sessionKey);
    }
  }

  /**
   * Read all entries from a session's transcript.
   */
  read(sessionKey: string): TranscriptEntry[] {
    // Flush pending writes first
    this.flush(sessionKey);

    const filePath = this.getFilePath(sessionKey);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf-8');
    const entries: TranscriptEntry[] = [];

    for (const line of content.split('\n')) {
      if (line.trim()) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }
    }

    return entries;
  }

  /**
   * Delete a session's transcript file.
   */
  delete(sessionKey: string): void {
    // Clear buffer
    this.buffers.delete(sessionKey);
    this.bufferSizes.delete(sessionKey);

    const filePath = this.getFilePath(sessionKey);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * Clear a session's transcript (reset).
   */
  clear(sessionKey: string): void {
    this.buffers.delete(sessionKey);
    this.bufferSizes.delete(sessionKey);

    const filePath = this.getFilePath(sessionKey);
    if (fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
    }
  }

  /**
   * Get the file size of a session's transcript.
   */
  getSize(sessionKey: string): number {
    const filePath = this.getFilePath(sessionKey);
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  }

  /**
   * Flush buffered writes for a specific session.
   */
  flush(sessionKey: string): void {
    const lines = this.buffers.get(sessionKey);
    if (!lines || lines.length === 0) return;

    const filePath = this.getFilePath(sessionKey);
    fs.appendFileSync(filePath, lines.join(''));

    this.buffers.set(sessionKey, []);
    this.bufferSizes.set(sessionKey, 0);
  }

  /**
   * Flush all buffered writes.
   */
  flushAll(): void {
    for (const sessionKey of this.buffers.keys()) {
      try {
        this.flush(sessionKey);
      } catch (err) {
        console.error(`[TranscriptStore] Failed to flush ${sessionKey}:`, err);
      }
    }
  }

  /**
   * Shutdown: flush all and stop timer.
   */
  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAll();
  }

  /**
   * Convert a session key to a file path.
   * Replaces colons with underscores for filesystem compatibility.
   */
  private getFilePath(sessionKey: string): string {
    const safeKey = sessionKey.replace(/:/g, '_');
    return path.join(this.transcriptsDir, `${safeKey}.jsonl`);
  }
}
