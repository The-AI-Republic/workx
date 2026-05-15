/**
 * FileStateCache — the per-session read-before-edit freshness substrate.
 *
 * Ported from claudy's `readFileState` (utils/fileStateCache.ts). This is the
 * ONLY state shared between read_file and edit_file/write_file, and the entire
 * trust mechanism of code-mode editing. See .ai_design/applepi_file_tools.
 *
 * Invariants (design §6):
 *  - R2: keyed by normalized absolute path; one instance per Session.
 *        `offset` SET ⇒ Read entry; `offset` undefined ⇒ Edit/Write entry.
 *  - R3: `mtimeFloorMs` is Math.floor(mtimeMs), floored on store AND compare.
 *  - R6: `content` is RAW disk bytes, LF-normalized, no line numbers.
 *  - `isPartialView` (injected/stripped view) ⇒ fails the edit gate, distinct
 *        from a range read (offset/limit set, isPartialView false) which
 *        passes the gate but never qualifies for the §4.6 jitter fallback.
 */

export interface FileState {
  /** Raw disk bytes at read time, LF-normalized, no line numbers. */
  content: string;
  /** Math.floor(mtimeMs) at read time. Floored on store and compare. */
  mtimeFloorMs: number;
  /** Set by a read (read-vs-edit discriminator); undefined after edit/write. */
  offset?: number;
  limit?: number;
  /** Injected/stripped view: content is raw disk but the model saw a
   *  different view ⇒ treated as "not read" by the edit gate. */
  isPartialView?: boolean;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB (claudy default)

/**
 * Pure lexical absolute-path normalization for cache keys. NOT a filesystem
 * operation (the WebView can't stat); collapses `.`/`..`/dup separators and
 * unifies separators so `/a/../b`, `/a//b`, `\a\b` collide to one key.
 * Mirrors claudy's `path.normalize` keying (the load-bearing part is that
 * every caller passes an absolute path and the cache normalizes it).
 */
export function normalizeCacheKey(absPath: string): string {
  const winDrive = /^([a-zA-Z]:)[\\/]/.exec(absPath);
  const prefix = winDrive ? winDrive[1] : '';
  const rest = winDrive ? absPath.slice(winDrive[1].length) : absPath;
  const out: string[] = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return `${prefix}/${out.join('/')}`;
}

/**
 * Bounded LRU keyed by normalized absolute path. Dual bound: max entries and
 * max total content bytes (claudy parity). Eviction is silent and merely
 * forces a harmless re-read.
 */
export class FileStateCache {
  private map = new Map<string, FileState>(); // insertion order = LRU order
  private bytes = 0;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  get(absPath: string): FileState | undefined {
    const key = normalizeCacheKey(absPath);
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // LRU touch: re-insert to move to most-recent.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(absPath: string): boolean {
    return this.map.has(normalizeCacheKey(absPath));
  }

  set(absPath: string, state: FileState): void {
    const key = normalizeCacheKey(absPath);
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= byteLen(existing.content);
      this.map.delete(key);
    }
    this.map.set(key, state);
    this.bytes += byteLen(state.content);
    this.evict();
  }

  delete(absPath: string): void {
    const key = normalizeCacheKey(absPath);
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= byteLen(existing.content);
      this.map.delete(key);
    }
  }

  get size(): number {
    return this.map.size;
  }

  private evict(): void {
    // Oldest-first (Map preserves insertion order; get() re-inserts on touch).
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const v = this.map.get(oldest)!;
      this.bytes -= byteLen(v.content);
      this.map.delete(oldest);
    }
  }
}

function byteLen(s: string): number {
  // Cheap UTF-8 byte estimate without Buffer (bundle-safe in the WebView).
  return Math.max(1, typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(s).length
    : s.length);
}
