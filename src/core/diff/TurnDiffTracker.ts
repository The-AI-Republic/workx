/**
 * TurnDiffTracker — accumulates the file changes an agent makes during a single
 * turn so `TaskRunner` can emit one whole-turn `TurnDiff` event (WORKXOS-7,
 * Phase 0). Conceptually the workx equivalent of Codex's `turn_diff_tracker`.
 *
 * The file-access tools (`edit_file`/`write_file`) call `record()` after each
 * successful write with the file's before/after content. Within a turn a file
 * may be written several times; the tracker keeps the FIRST `before` (the
 * turn's baseline for that file) and the LATEST `after`, so `computeDiff()`
 * yields the *net* change for the turn. `TaskRunner` calls `computeDiff()` +
 * `reset()` at each turn boundary.
 *
 * One instance per `Session` (like `FileStateCache`), so sub-agents — which own
 * their own `Session` — track independently and never cross-contaminate.
 */

import { normalizeCacheKey } from '../files/FileStateCache';
import { computeUnifiedDiff } from './unifiedDiff';

interface TrackedFile {
  /** Workspace-relative (or as-supplied) path used for the diff header. */
  displayPath: string;
  /** Content at the first write this turn — the turn baseline for this file. */
  before: string;
  /** Content at the most recent write this turn. */
  after: string;
}

export interface TurnDiffResult {
  /** Concatenated git-style unified diff across all net-changed files. */
  diff: string;
  /** Number of files whose net content actually changed this turn. */
  filesChanged: number;
}

export class TurnDiffTracker {
  // Keyed by normalized absolute path (matches FileStateCache dedup keying) so
  // an edit addressing the file by different path spellings still collapses to
  // one baseline.
  private files = new Map<string, TrackedFile>();

  /**
   * Record a successful write. `absPath` is the absolute path (used only for
   * dedup keying); `displayPath` is what appears in the diff header (prefer a
   * workspace-relative path). First `before` per file wins; latest `after`
   * wins.
   */
  record(absPath: string, displayPath: string, before: string, after: string): void {
    const key = normalizeCacheKey(absPath);
    const existing = this.files.get(key);
    if (existing) {
      existing.after = after; // keep original `before`, advance `after`
    } else {
      this.files.set(key, { displayPath, before, after });
    }
  }

  /** True when no file has been written this turn. */
  isEmpty(): boolean {
    return this.files.size === 0;
  }

  /**
   * Compute the whole-turn unified diff. Files whose net before/after content
   * is identical (e.g. edited then reverted) contribute nothing and are not
   * counted. Does NOT reset — call `reset()` separately at the turn boundary.
   */
  computeDiff(): TurnDiffResult {
    const parts: string[] = [];
    let filesChanged = 0;
    // Stable, path-sorted output so the panel ordering is deterministic.
    const entries = [...this.files.values()].sort((a, b) =>
      a.displayPath < b.displayPath ? -1 : a.displayPath > b.displayPath ? 1 : 0,
    );
    for (const f of entries) {
      const d = computeUnifiedDiff(f.displayPath, f.before, f.after);
      if (d) {
        parts.push(d);
        filesChanged++;
      }
    }
    return { diff: parts.join(''), filesChanged };
  }

  /** Clear all tracked changes. Called at each turn boundary. */
  reset(): void {
    this.files.clear();
  }
}
