/**
 * Node-side filesystem executor (Track 43 runtime port of tauri/src/fs_commands.rs).
 *
 * After the cutover, the file-access tools (read_file/edit_file/write_file)
 * run inside the runtime sidecar — a Node process — so they can hit the
 * filesystem directly through `node:fs/promises` instead of round-tripping
 * through Tauri `invoke`. The security contract from the deleted Rust module
 * is preserved here byte-for-byte:
 *
 *   - R1/R4: edit_file does a single synchronous re-read + match +
 *     substitute + write. No `await` between the freshness check and the
 *     write — no TOCTOU window.
 *   - R5: symlink-safe jail. Resolve the deepest existing ancestor first,
 *     append the not-yet-existing tail, then assert containment. A bypass-
 *     immune blocklist refuses .git/.ssh/.env/etc.
 *   - R3: mtimeMs is floored to integer ms to stay byte-identical to the
 *     WebView's `Math.floor(mtimeMs)`.
 *   - R6: UTF-8 strict (no lossy U+FFFD substitution); UTF-16 refused, not
 *     transcoded; CRLF/BOM detected on read and re-applied on write.
 *
 * Keep the SENSITIVE_DIRS / SENSITIVE_FILES lists in sync with
 * src/tools/file-search/pathPolicy.ts.
 */

import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import type {
  EditOutcome,
  FileMeta,
  ReadOutcome,
  StatOutcome,
  WriteOutcome,
} from '@/tools/file-search/fsExecutor';

const SENSITIVE_DIRS = new Set([
  '.git', '.svn', '.hg', '.vscode', '.idea', '.claude', '.ssh',
]);
const SENSITIVE_FILES = new Set([
  '.env', '.npmrc', '.netrc', '.bashrc', '.bash_profile', '.zshrc', '.zprofile',
  '.profile', '.gitconfig', '.gitmodules', '.mcp.json', '.claude.json',
]);

interface JailedPath {
  abs: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * Resolve `target` under `workspaceRoot` with symlink-safe containment +
 * the sensitive blocklist. Works for not-yet-existing files (canonicalizes
 * the deepest existing ancestor and appends the remaining components).
 */
async function jail(workspaceRoot: string, target: string): Promise<JailedPath> {
  if (!workspaceRoot.trim()) throw new Error('no_workspace');
  const root = await realpathOrNull(workspaceRoot);
  if (!root) throw new Error('no_workspace');

  const raw = target;
  const joined = path.isAbsolute(raw) ? raw : path.join(root, raw);

  // Reject `..` lexically before any resolution (defense in depth).
  if (joined.split(path.sep).some((c) => c === '..')) {
    throw new Error('outside_workspace');
  }

  // Canonicalize the deepest existing ancestor (resolves symlinks), then
  // re-append the non-existing tail. SAFETY: a non-existent tail component
  // cannot itself be a symlink (it doesn't exist), and any *existing*
  // ancestor symlink IS resolved here, so containment cannot be bypassed
  // via a symlinked directory. Each public method below does its read/write
  // in one continuous sync-ish span (no rescheduling between this check and
  // the write — R4), so there is no TOCTOU window.
  let existing = joined;
  const tail: string[] = [];
  while (!(await exists(existing))) {
    const base = path.basename(existing);
    if (!base || base === path.parse(existing).root) {
      throw new Error('outside_workspace');
    }
    tail.push(base);
    existing = path.dirname(existing);
  }
  const realExisting = await realpathOrNull(existing);
  if (!realExisting) throw new Error('outside_workspace');
  let abs = realExisting;
  for (const seg of tail.reverse()) {
    abs = path.join(abs, seg);
  }

  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('outside_workspace');
  }
  const rel = abs.startsWith(root) ? abs.slice(root.length).replace(/^[\\/]+/, '') : abs;

  // Blocklist: any sensitive dir segment, or sensitive basename, or .env*.
  for (const seg of rel.split(/[\\/]/).filter(Boolean)) {
    if (SENSITIVE_DIRS.has(seg)) throw new Error('blocked');
  }
  const base = path.basename(abs);
  if (SENSITIVE_FILES.has(base) || base === '.env' || base.startsWith('.env.')) {
    throw new Error('blocked');
  }
  return { abs };
}

function denyMsg(reason: string): string {
  switch (reason) {
    case 'no_workspace':
      return 'No workspace selected; code-mode file tools are disabled.';
    case 'outside_workspace':
      return 'Path is outside the workspace and cannot be accessed.';
    case 'blocked':
      return 'Path is on the protected blocklist (.git/.ssh/.env/.claude/etc.) and cannot be accessed.';
    default:
      return reason;
  }
}

interface Decoded {
  contentLf: string;
  endings: 'LF' | 'CRLF';
  bom: boolean;
}

/**
 * Decode raw bytes to an LF-normalized UTF-8 string. Returns null for
 * UTF-16 OR any non-UTF-8 (binary) input — refused rather than corrupted.
 * Using strict UTF-8 decoding (`fatal: true`): a lossy decode would replace
 * invalid bytes with U+FFFD and a subsequent edit would write that garbage
 * back, silently corrupting the file (R6 fail-safe).
 */
function decode(bytes: Buffer): Decoded | null {
  if (bytes.length >= 2 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF))) {
    return null; // UTF-16 — unsupported in v1
  }
  let body: Buffer = bytes;
  let bom = false;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    body = bytes.subarray(3);
    bom = true;
  }
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const endings: 'LF' | 'CRLF' = s.includes('\r\n') ? 'CRLF' : 'LF';
    return { contentLf: s.replace(/\r\n/g, '\n'), endings, bom };
  } catch {
    return null;
  }
}

/** Re-apply endings + BOM to LF content for writing (UTF-8 only in v1). */
function encode(contentLf: string, endings: 'LF' | 'CRLF', bom: boolean): Buffer {
  const body = endings === 'CRLF' ? contentLf.replace(/\n/g, '\r\n') : contentLf;
  const bodyBuf = Buffer.from(body, 'utf-8');
  return bom
    ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), bodyBuf])
    : bodyBuf;
}

function mtimeMs(stat: Stats): number {
  // Floor to integer ms so the value is byte-identical to JS
  // `Math.floor(mtimeMs)` — the freshness comparison must be exact.
  return Math.floor(stat.mtimeMs);
}

async function ensureParent(abs: string): Promise<void> {
  const parent = path.dirname(abs);
  if (parent && parent !== abs) {
    await fs.mkdir(parent, { recursive: true });
  }
}

// ── public API (mirrors fsExecutor) ─────────────────────────────────────────

export async function stat(workspaceRoot: string, target: string): Promise<StatOutcome> {
  let j: JailedPath;
  try {
    j = await jail(workspaceRoot, target);
  } catch (e) {
    throw new Error(denyMsg(e instanceof Error ? e.message : String(e)));
  }
  try {
    const s = await fs.stat(j.abs);
    return { exists: true, mtimeMs: mtimeMs(s), size: s.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

export async function readFile(workspaceRoot: string, target: string): Promise<ReadOutcome> {
  let j: JailedPath;
  try {
    j = await jail(workspaceRoot, target);
  } catch (e) {
    throw new Error(denyMsg(e instanceof Error ? e.message : String(e)));
  }
  const s = await fs.stat(j.abs).catch((e) => {
    throw new Error(`not_found: ${e.message}`);
  });
  const bytes = await fs.readFile(j.abs);
  const dec = decode(bytes);
  if (!dec) throw new Error('unsupported_encoding: UTF-16 files are not supported in v1');
  const meta: FileMeta = {
    mtimeMs: mtimeMs(s),
    size: s.size,
    endings: dec.endings,
    encoding: 'utf8',
    bom: dec.bom,
  };
  return { contentLf: dec.contentLf, ...meta };
}

export async function applyEdit(args: {
  workspaceRoot: string;
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
  expectedMtimeMs: number;
  expectedContentLf: string;
}): Promise<EditOutcome> {
  let j: JailedPath;
  try {
    j = await jail(args.workspaceRoot, args.path);
  } catch (e) {
    return {
      ok: 'false',
      reason: 'denied',
      message: denyMsg(e instanceof Error ? e.message : String(e)),
    };
  }
  const existsAt = await exists(j.abs);

  // Empty old_string ⇒ create-new (gate N/A: cannot have read a missing file).
  if (args.oldString === '') {
    if (existsAt) {
      const s = await fs.stat(j.abs);
      if (s.size > 0) {
        return {
          ok: 'false',
          reason: 'exists',
          message: 'File already exists and is non-empty; empty old_string only creates new files.',
        };
      }
    }
    const endings: 'LF' | 'CRLF' = args.newString.includes('\r\n') ? 'CRLF' : 'LF';
    const contentLf = args.newString.replace(/\r\n/g, '\n');
    await ensureParent(j.abs);
    await fs.writeFile(j.abs, encode(contentLf, endings, false));
    const s = await fs.stat(j.abs);
    return {
      ok: 'true',
      newContentLf: contentLf,
      mtimeMs: mtimeMs(s),
      size: s.size,
      endings,
      encoding: 'utf8',
      bom: false,
    };
  }

  // No-op edit: identical strings would prompt + write for nothing (M3).
  if (args.oldString === args.newString) {
    return {
      ok: 'false',
      reason: 'no_op',
      message: 'old_string and new_string are identical; nothing to change.',
    };
  }

  if (!existsAt) {
    return {
      ok: 'false',
      reason: 'not_found',
      message: 'File does not exist. Use write_file to create it, or fix the path.',
    };
  }

  const s = await fs.stat(j.abs);
  const bytes = await fs.readFile(j.abs);
  const dec = decode(bytes);
  if (!dec) {
    return {
      ok: 'false',
      reason: 'unsupported_encoding',
      message: 'UTF-16 files are not supported in v1.',
    };
  }
  const fresh = dec.contentLf;

  // Freshness: if mtime advanced, only proceed when the whole fresh file is
  // byte-identical to the cached content (full-read jitter fallback). A
  // range read's cached content is a slice ⇒ never equal ⇒ correctly stale.
  if (mtimeMs(s) !== args.expectedMtimeMs && fresh !== args.expectedContentLf) {
    return {
      ok: 'false',
      reason: 'stale',
      message: 'File changed on disk since you read it. Re-read it, then redo the edit against the new content.',
    };
  }

  const matches = countOccurrences(fresh, args.oldString);
  if (matches === 0) {
    return {
      ok: 'false',
      reason: 'no_match',
      message: 'old_string was not found in the current file content. Re-read the file and base the edit on its actual current text.',
    };
  }
  if (matches > 1 && !args.replaceAll) {
    return {
      ok: 'false',
      reason: 'not_unique',
      message: `old_string matched ${matches} times. Add surrounding context to make it unique, or pass replace_all: true.`,
    };
  }

  const updated = args.replaceAll
    ? fresh.split(args.oldString).join(args.newString)
    : fresh.replace(args.oldString, args.newString);

  await fs.writeFile(j.abs, encode(updated, dec.endings, dec.bom));
  const s2 = await fs.stat(j.abs);
  return {
    ok: 'true',
    newContentLf: updated,
    mtimeMs: mtimeMs(s2),
    size: s2.size,
    endings: dec.endings,
    encoding: 'utf8',
    bom: dec.bom,
  };
}

export async function writeIfUnchanged(args: {
  workspaceRoot: string;
  path: string;
  content: string;
  expectedMtimeMs: number | null;
  endings: 'LF' | 'CRLF';
  bom: boolean;
}): Promise<WriteOutcome> {
  let j: JailedPath;
  try {
    j = await jail(args.workspaceRoot, args.path);
  } catch (e) {
    return {
      written: 'false',
      reason: 'denied',
      message: denyMsg(e instanceof Error ? e.message : String(e)),
    };
  }
  const existsAt = await exists(j.abs);
  if (args.expectedMtimeMs === null) {
    if (existsAt) {
      return {
        written: 'false',
        reason: 'exists',
        message: 'File already exists; create-only write refused.',
      };
    }
  } else {
    if (!existsAt) {
      return {
        written: 'false',
        reason: 'not_found',
        message: 'File does not exist; cannot overwrite. Read it or create it first.',
      };
    }
    const s = await fs.stat(j.abs);
    if (mtimeMs(s) !== args.expectedMtimeMs) {
      return {
        written: 'false',
        reason: 'stale',
        message: 'File changed on disk since you read it. Re-read it before overwriting.',
      };
    }
  }
  const contentLf = args.content.replace(/\r\n/g, '\n');
  await ensureParent(j.abs);
  await fs.writeFile(j.abs, encode(contentLf, args.endings, args.bom));
  const s2 = await fs.stat(j.abs);
  return {
    written: 'true',
    mtimeMs: mtimeMs(s2),
    size: s2.size,
    endings: args.endings,
    encoding: 'utf8',
    bom: args.bom,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
