/**
 * Persistent storage for `<memoryRoot>/sessions/<sessionId>/summary.md`.
 *
 * Uses the platform-agnostic FileSystem interface from src/core/memory/types
 * so the same code works on desktop (Tauri) and server (Node) builds. The
 * `MemoryFileSystem` factory already resolves `memoryRoot` to the right
 * place per build mode — we just append `sessions/<sid>/summary.md`.
 */

import type { FileSystem } from '../memory/types';
import { dirnameSummaryPath, joinSummaryPath } from './filePath';
import { SESSION_SUMMARY_TEMPLATE } from './template';

const SESSIONS_SUBDIR = 'sessions';
const SUMMARY_FILENAME = 'summary.md';

export function getSessionSummaryPath(
  memoryRoot: string,
  sessionId: string,
): string {
  return joinSummaryPath(memoryRoot, SESSIONS_SUBDIR, sessionId, SUMMARY_FILENAME);
}

/**
 * File-system facade for a single session's summary file.
 *
 * Construct once per Session (the SessionSummaryHook owns the instance).
 */
export class SessionSummaryFileStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly memoryRoot: string,
  ) {}

  pathFor(sessionId: string): string {
    return getSessionSummaryPath(this.memoryRoot, sessionId);
  }

  /**
   * Ensure the file exists and has at least the canonical template. Returns
   * the absolute path either way.
   *
   * Idempotent: calling twice on the same session is a no-op the second time.
   */
  async ensureScaffold(sessionId: string): Promise<string> {
    const file = this.pathFor(sessionId);
    await this.fs.ensureDir(dirnameSummaryPath(file));
    if (!(await this.fs.exists(file))) {
      await this.fs.writeFile(file, SESSION_SUMMARY_TEMPLATE);
    }
    return file;
  }

  /**
   * Read current content. Returns the empty string if the file is missing
   * (so callers don't have to branch on existence).
   */
  async read(sessionId: string): Promise<string> {
    const file = this.pathFor(sessionId);
    if (!(await this.fs.exists(file))) return '';
    try {
      return await this.fs.readFile(file);
    } catch {
      return '';
    }
  }
}

/**
 * Returns true when the file content is just the canonical template (or
 * close enough — we normalize trailing whitespace before comparing). Used
 * to short-circuit "skip the summary, it's empty" code paths.
 *
 * Mirrors claudy's isSessionMemoryEmpty().
 */
export function isSessionSummaryEmpty(content: string): boolean {
  if (!content) return true;
  return content.trim() === SESSION_SUMMARY_TEMPLATE.trim();
}
