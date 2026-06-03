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

/**
 * Exact sensitive dotfile basenames that must never be written. All are
 * dotfiles by design (design.md §"bypass-immune safety": VCS/IDE/.claude
 * dirs + shell-rc / config DOTFILES). A bare `settings.json` is intentionally
 * NOT here — it's a common, legitimate project filename; the genuinely
 * sensitive cases (`.vscode/settings.json`, `.claude/settings.json`) are
 * already hard-denied via SENSITIVE_DIRS.
 */
export const SENSITIVE_FILES = [
  '.env', '.npmrc', '.netrc', '.bashrc', '.bash_profile', '.zshrc',
  '.zprofile', '.profile', '.gitconfig', '.gitmodules', '.mcp.json',
  '.claude.json',
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

  const root = normalizeSegments(workspaceRoot).path;
  const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(target);
  const joined = isAbs ? target : `${workspaceRoot}/${target}`;
  const norm = normalizeSegments(joined);

  // A `..` that pops above the path root is an explicit traversal escape —
  // reject it directly instead of relying on the containment string-compare
  // below to happen to catch the flattened result (defense in depth).
  if (norm.escaped) return { ok: false, reason: 'outside_workspace' };
  const abs = norm.path;

  if (abs !== root && !abs.startsWith(root.endsWith('/') ? root : root + '/')) {
    return { ok: false, reason: 'outside_workspace' };
  }
  if (isSensitivePath(abs.slice(root.length))) return { ok: false, reason: 'blocked' };
  return { ok: true, abs };
}

/**
 * Pure lexical normalization: collapse `.`/`..`/duplicate separators to a
 * forward-slash absolute path. Does NOT touch the filesystem. `escaped` is
 * true when a `..` was applied with no parent segment to consume (i.e. the
 * path tried to traverse above its own root) — the caller treats that as a
 * containment violation rather than silently flattening it away.
 */
function normalizeSegments(p: string): { path: string; escaped: boolean } {
  const winDrive = /^([a-zA-Z]:)[\\/]/.exec(p);
  const prefix = winDrive ? winDrive[1] : '';
  const rest = winDrive ? p.slice(winDrive[1].length) : p;
  const out: string[] = [];
  let escaped = false;
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) { escaped = true; continue; }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return { path: `${prefix}/${out.join('/')}`, escaped };
}
