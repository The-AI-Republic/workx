/**
 * Plugin path safety (Track 10 security fix).
 *
 * Plugin manifests and install archives carry untrusted, attacker-
 * influenced relative paths (`manifest.skills`, `commands.<n>.source`,
 * file entries in an install payload). Without jailing, a plugin that
 * looks benign in `/plugin list` can:
 *   - read arbitrary files into skill bodies / sub-agent prompts
 *     (`"skills": "/etc"` or `"../../../../.ssh"`), or
 *   - write outside its install dir (`path: "../../etc/cron.d/x"`).
 *
 * Every plugin-supplied relative path MUST pass through `safeJoinUnderRoot`
 * (or at minimum `assertSafeRelPath`) before it reaches the filesystem or
 * a Tauri fs command. Absolute paths and any `..` segment are rejected
 * outright; the joined result is additionally prefix-checked against the
 * normalized root (defense in depth).
 */

export class PluginPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginPathError';
  }
}

/** Normalize separators and collapse `.`/empty segments. Does NOT resolve `..`. */
function splitSegments(p: string): string[] {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
}

/**
 * Reject a plugin-supplied relative path that is absolute, drive-rooted,
 * a `~` home ref, or contains any `..` segment. Returns the cleaned
 * relative path (no leading `./`, forward slashes).
 */
export function assertSafeRelPath(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new PluginPathError('plugin path must be a non-empty string');
  }
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/')) {
    throw new PluginPathError(`absolute plugin path not allowed: ${rel}`);
  }
  if (/^[A-Za-z]:/.test(norm)) {
    throw new PluginPathError(`drive-rooted plugin path not allowed: ${rel}`);
  }
  if (norm.startsWith('~')) {
    throw new PluginPathError(`home-relative plugin path not allowed: ${rel}`);
  }
  const segments = splitSegments(norm);
  if (segments.includes('..')) {
    throw new PluginPathError(`path traversal ('..') not allowed: ${rel}`);
  }
  return segments.join('/');
}

/**
 * Validate `rel` then join it under `root`, additionally asserting the
 * result stays within `root` after normalization (catches edge cases the
 * segment check might miss, e.g. odd separators).
 */
export function safeJoinUnderRoot(root: string, rel: string): string {
  const cleanRel = assertSafeRelPath(rel);
  const cleanRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const joined = cleanRel.length > 0 ? `${cleanRoot}/${cleanRel}` : cleanRoot;
  // Defense in depth: normalized join must remain under the root.
  const rootPrefix = `${cleanRoot}/`;
  if (joined !== cleanRoot && !joined.startsWith(rootPrefix)) {
    throw new PluginPathError(
      `resolved path escapes plugin root: ${rel} -> ${joined}`,
    );
  }
  return joined;
}

/** True if a path is safe (no throw). Convenience for filter/skip flows. */
export function isSafeRelPath(rel: string): boolean {
  try {
    assertSafeRelPath(rel);
    return true;
  } catch {
    return false;
  }
}
