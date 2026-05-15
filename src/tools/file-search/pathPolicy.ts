/**
 * Shared workspace path policy for the code-mode file/search tools.
 *
 * AUTHORITY MODEL (design §4.8 layer 1, invariant R5):
 *   - The AUTHORITATIVE jail (symlink-resolved containment + bypass-immune
 *     blocklist) lives in the Rust fs commands. The WebView (JS) cannot
 *     resolve symlinks or stat the filesystem, so it CANNOT be the security
 *     boundary.
 *   - This module is an ADVISORY, lexical pre-check only: it gives a fast,
 *     clear rejection for obvious violations before the IPC round-trip, and
 *     exports the canonical blocklist so the Rust side can be kept in sync.
 *
 * Keep `SENSITIVE_BLOCKLIST` byte-identical to the Rust constant.
 */

/** Directory names that must never be written, anywhere in the path. */
export const SENSITIVE_DIRS = [
  '.git', '.svn', '.hg', '.vscode', '.idea', '.claude', '.ssh',
] as const;

/** Exact dotfile / config basenames that must never be written. */
export const SENSITIVE_FILES = [
  '.env', '.npmrc', '.netrc', '.bashrc', '.bash_profile', '.zshrc',
  '.zprofile', '.profile', '.gitconfig', '.gitmodules', '.mcp.json',
  '.claude.json', 'settings.json',
] as const;

/** True if any path segment is a sensitive dir, or the basename is sensitive
 *  (covers `.env`, `.env.local`, `.env.*`). Lexical only. */
export function isSensitivePath(relOrAbs: string): boolean {
  const segs = relOrAbs.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => (SENSITIVE_DIRS as readonly string[]).includes(s))) return true;
  const base = segs[segs.length - 1] ?? '';
  if ((SENSITIVE_FILES as readonly string[]).includes(base)) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  return false;
}

export type PathPolicyResult =
  | { ok: true; /** lexically-normalized absolute path (NOT symlink-resolved) */ abs: string }
  | { ok: false; reason: 'no_workspace' | 'outside_workspace' | 'blocked' };

/**
 * Lexical advisory check. Returns the normalized absolute path on success.
 * The Rust command MUST re-verify with symlink resolution before any I/O —
 * this is a UX fast-path, not the security boundary.
 *
 * @param workspaceRoot absolute path, or undefined (no workspace selected)
 * @param target        tool-supplied path (absolute or relative to workspace)
 */
export function lexicalPathCheck(
  workspaceRoot: string | undefined,
  target: string,
): PathPolicyResult {
  if (!workspaceRoot || !workspaceRoot.trim()) return { ok: false, reason: 'no_workspace' };

  const root = normalizeSegments(workspaceRoot);
  const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(target);
  const joined = isAbs ? target : `${workspaceRoot}/${target}`;
  const abs = normalizeSegments(joined);

  if (abs !== root && !abs.startsWith(root.endsWith('/') ? root : root + '/')) {
    return { ok: false, reason: 'outside_workspace' };
  }
  if (isSensitivePath(abs.slice(root.length))) return { ok: false, reason: 'blocked' };
  return { ok: true, abs };
}

/** Pure lexical normalization: collapse `.`/`..`/duplicate separators to a
 *  forward-slash absolute path. Does NOT touch the filesystem. */
function normalizeSegments(p: string): string {
  const winDrive = /^([a-zA-Z]:)[\\/]/.exec(p);
  const prefix = winDrive ? winDrive[1] : '';
  const out: string[] = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return `${prefix}/${out.join('/')}`;
}
