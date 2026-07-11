/**
 * Minimal unified-diff parser for the artifact preview panel (WORKXOS-7).
 *
 * The preview panel only needs to *render* diffs read-only, so we parse the
 * standard unified-diff format the agent's `apply_patch` / `TurnDiff` events
 * emit — per-file `diff --git` / `---` / `+++` headers plus `@@` hunks — into a
 * small structured shape and let `DiffView.svelte` theme it. Parsing (not
 * rendering) is deliberately kept here so it is unit-testable without a DOM.
 *
 * This is intentionally dependency-free (no jsdiff): our scope is display of
 * well-formed unified diffs, not diff computation, and a small vetted parser
 * avoids adding a bundled dependency to the desktop build. If richer parsing is
 * ever needed (renames, binary markers, word-diff), swapping in jsdiff's
 * `parsePatch` behind this same interface is a localized change.
 */

export type DiffLineType = 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  /** Line text without the leading +/-/space marker. */
  text: string;
  /** 1-based line number in the old file, when applicable. */
  oldLine?: number;
  /** 1-based line number in the new file, when applicable. */
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedFileDiff {
  /** Best-effort path for this file (new path preferred, else old path). */
  path: string;
  oldPath?: string;
  newPath?: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** True for a newly-created file (---/dev/null). */
  isNew: boolean;
  /** True for a deleted file (+++/dev/null). */
  isDeleted: boolean;
}

const NULL_PATH = /^\/dev\/null$/;

/** Strip a `a/` or `b/` git prefix from a header path. */
function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

/** Parse the `@@ -oldStart,oldLen +newStart,newLen @@` hunk header. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: parseInt(m[1], 10), newStart: parseInt(m[2], 10) };
}

/**
 * Parse a unified diff (possibly spanning multiple files) into per-file diffs.
 * Robust to leading `diff --git` lines and missing headers; unknown lines
 * outside a hunk are ignored.
 */
export function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
  if (!diff) return [];
  const lines = diff.split('\n');
  const files: ParsedFileDiff[] = [];
  let current: ParsedFileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const startFile = (): ParsedFileDiff => {
    const f: ParsedFileDiff = {
      path: '',
      hunks: [],
      additions: 0,
      deletions: 0,
      isNew: false,
      isDeleted: false,
    };
    files.push(f);
    return f;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('diff --git')) {
      // Begin a new file block. Seed path from the `a/… b/…` header.
      current = startFile();
      hunk = null;
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      if (m) {
        current.oldPath = m[1];
        current.newPath = m[2];
        current.path = m[2];
      }
      continue;
    }

    // A `--- ` line is a file header only when it is the old-path half of a
    // `---`/`+++` pair AND either we're between files (no open hunk — always the
    // case for git diffs, where `diff --git` resets the hunk) or the pair is
    // immediately followed by an `@@` hunk (the boundary signal in plain
    // unified diffs that lack `diff --git`). Inside a hunk a deleted line whose
    // content starts with `-- ` (SQL/Lua/Ada comment, `++`-increment, etc.)
    // renders as `--- …`/`+++ …`; these guards keep it as content, not a header.
    if (
      raw.startsWith('--- ') &&
      lines[i + 1]?.startsWith('+++ ') &&
      (hunk === null || lines[i + 2]?.startsWith('@@'))
    ) {
      if (!current || current.hunks.length > 0) current = startFile();
      hunk = null;
      const p = raw.slice(4).trim();
      if (NULL_PATH.test(p)) {
        current.isNew = true;
      } else {
        current.oldPath = stripPrefix(p);
        if (!current.path) current.path = current.oldPath;
      }
      // Consume the paired `+++ ` new-path header in lockstep so an added line
      // whose content starts with `++ ` is never mistaken for a header.
      const nxt = lines[i + 1];
      const np = nxt.slice(4).trim();
      if (NULL_PATH.test(np)) {
        current.isDeleted = true;
      } else {
        current.newPath = stripPrefix(np);
        current.path = current.newPath;
      }
      i += 1;
      continue;
    }

    if (raw.startsWith('@@')) {
      if (!current) current = startFile();
      const parsed = parseHunkHeader(raw);
      hunk = { header: raw, lines: [] };
      current.hunks.push(hunk);
      oldLine = parsed?.oldStart ?? 0;
      newLine = parsed?.newStart ?? 0;
      continue;
    }

    if (!current || !hunk) continue;

    // A bare empty line is the trailing-newline split artifact / hunk
    // terminator, not a content line (real context/added blank lines carry a
    // leading ' ' or '+'). Skipping it avoids a spurious trailing newline.
    if (raw === '') continue;

    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — attach as meta, no line numbers.
      hunk.lines.push({ type: 'meta', text: raw.slice(1).trim() });
      continue;
    }

    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      hunk.lines.push({ type: 'add', text, newLine });
      newLine += 1;
      current.additions += 1;
    } else if (marker === '-') {
      hunk.lines.push({ type: 'del', text, oldLine });
      oldLine += 1;
      current.deletions += 1;
    } else {
      // Context line (leading space) or an empty line inside a hunk.
      hunk.lines.push({ type: 'context', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files.filter((f) => f.hunks.length > 0 || f.isNew || f.isDeleted);
}

/**
 * Extract the full body of a newly-added file from a unified diff, when the
 * diff creates it from `/dev/null` (every content line is an addition). Returns
 * null when the diff isn't a pure file creation, so callers can fall back to a
 * diff view. Used to preview freshly-written docs (e.g. a new `.md` design doc)
 * as rendered content rather than a green-only diff.
 */
export function extractAddedFileContent(diff: string, path?: string): string | null {
  const files = parseUnifiedDiff(diff);
  const file =
    (path && files.find((f) => f.path === path || f.newPath === path)) ||
    (files.length === 1 ? files[0] : null);
  if (!file || !file.isNew || file.deletions > 0) return null;
  const body: string[] = [];
  for (const h of file.hunks) {
    for (const ln of h.lines) {
      if (ln.type === 'add') body.push(ln.text);
      else if (ln.type === 'context') body.push(ln.text);
    }
  }
  return body.join('\n');
}

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);
const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'svelte', 'vue', 'py', 'rs', 'go',
  'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'rb', 'php', 'swift',
  'sh', 'bash', 'zsh', 'sql', 'json', 'yaml', 'yml', 'toml', 'xml', 'html',
  'css', 'scss', 'less',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const TEXT_EXT = new Set(['txt', 'log', 'env', 'ini', 'conf', 'cfg']);

/** Infer how to render a file from its extension. */
export function inferArtifactKind(path: string): import('@/types/ui').ArtifactKind {
  const base = path.split('/').pop() || path;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (ext === 'csv') return 'csv';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (CODE_EXT.has(ext)) return 'code';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'unknown';
}
