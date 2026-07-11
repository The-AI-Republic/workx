/**
 * Pure unified-diff *generator* for whole-turn diffs (WORKXOS-7, Phase 0).
 *
 * The preview panel already ships a unified-diff *parser* (webfront/lib/diffParse.ts)
 * and the frontend `previewStore` ingests `TurnDiff` events — but core never
 * emitted a whole-turn diff, so the panel only ever got diff *bodies* on
 * approval-gated turns. This module is the missing producer: given a file's
 * before/after text it emits a git-style unified diff that `parseUnifiedDiff`
 * round-trips (see the round-trip tests). `TurnDiffTracker` accumulates these
 * across a turn and `TaskRunner` emits one `TurnDiff` per completed turn.
 *
 * Deliberately dependency-free (no jsdiff) to keep the desktop bundle lean —
 * matching the parser's stance. The algorithm is a classic line-level LCS with
 * an O(n·m) memory guard that falls back to a whole-file replace for very large
 * files (a preview aid, not a patch tool, so an unminimised diff is acceptable).
 *
 * Known, documented limitation: a change that only adds or removes the file's
 * final trailing newline is not represented (we normalise it away), because the
 * panel renders text and a "\ No newline at end of file" marker adds fragility
 * for no display value.
 */

export interface UnifiedDiffOptions {
  /** Lines of unchanged context around each change (git default: 3). */
  context?: number;
}

/** Above this line count on either side, skip LCS and emit a full replace. */
const MAX_LCS_LINES = 5000;

type EditTag = 'eq' | 'del' | 'add';
interface EditOp {
  tag: EditTag;
  line: string;
}

/**
 * Split file text into lines, dropping the artifact empty string a trailing
 * newline produces. `''` → `[]` (empty file); `'a\n'` → `['a']`; `'a\nb'` →
 * `['a','b']`. Trailing-newline presence is intentionally not preserved (see
 * the module's documented limitation).
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

/**
 * Line-level LCS diff → flat edit script. Falls back to a whole-file replace
 * (all old lines deleted, all new lines added) when either side is very large,
 * bounding memory to something safe for a preview feature.
 */
function diffLines(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;

  if (n > MAX_LCS_LINES || m > MAX_LCS_LINES) {
    return [
      ...a.map((line): EditOp => ({ tag: 'del', line })),
      ...b.map((line): EditOp => ({ tag: 'add', line })),
    ];
  }

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: 'eq', line: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ tag: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ tag: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ tag: 'del', line: a[i] }); i++; }
  while (j < m) { ops.push({ tag: 'add', line: b[j] }); j++; }
  return ops;
}

/** Render the `@@ -oldStart,oldLen +newStart,newLen @@` hunk bodies. */
function renderHunks(ops: EditOp[], context: number): string[] {
  const n = ops.length;
  const changed = ops.map((o) => o.tag !== 'eq');
  if (!changed.some(Boolean)) return [];

  // Mark every line within `context` of a change as visible; consecutive
  // visible runs become hunks (this naturally merges nearby changes).
  const visible = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    if (!changed[k]) continue;
    for (let t = Math.max(0, k - context); t <= Math.min(n - 1, k + context); t++) {
      visible[t] = true;
    }
  }

  // Prefix counts of old/new lines *before* each op index, for hunk starts.
  const oldBefore = new Array<number>(n + 1).fill(0);
  const newBefore = new Array<number>(n + 1).fill(0);
  for (let k = 0; k < n; k++) {
    const isOld = ops[k].tag === 'eq' || ops[k].tag === 'del';
    const isNew = ops[k].tag === 'eq' || ops[k].tag === 'add';
    oldBefore[k + 1] = oldBefore[k] + (isOld ? 1 : 0);
    newBefore[k + 1] = newBefore[k] + (isNew ? 1 : 0);
  }

  const hunks: string[] = [];
  let k = 0;
  while (k < n) {
    if (!visible[k]) { k++; continue; }
    const start = k;
    while (k < n && visible[k]) k++;
    const end = k; // exclusive

    const body: string[] = [];
    let oldLen = 0;
    let newLen = 0;
    for (let t = start; t < end; t++) {
      const op = ops[t];
      if (op.tag === 'eq') { body.push(' ' + op.line); oldLen++; newLen++; }
      else if (op.tag === 'del') { body.push('-' + op.line); oldLen++; }
      else { body.push('+' + op.line); newLen++; }
    }

    // GNU convention: an empty side starts at the count-before, not +1.
    const oldStart = oldLen > 0 ? oldBefore[start] + 1 : oldBefore[start];
    const newStart = newLen > 0 ? newBefore[start] + 1 : newBefore[start];
    hunks.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    hunks.push(...body);
  }
  return hunks;
}

/**
 * Produce a git-style unified diff for a single file's before → after change.
 * Returns `''` when the content is unchanged (so callers can skip it). A file
 * whose `before` is empty is emitted as a creation (`--- /dev/null`), matching
 * what the parser's `getAddedFileContent` expects for freshly-written docs.
 */
export function computeUnifiedDiff(
  path: string,
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  if (before === after) return '';
  const context = options.context ?? 3;

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const ops = diffLines(oldLines, newLines);
  const hunks = renderHunks(ops, context);
  if (hunks.length === 0) return '';

  const isNew = before === '';
  const isDeleted = after === '';
  const header = [
    `diff --git a/${path} b/${path}`,
    isNew ? '--- /dev/null' : `--- a/${path}`,
    isDeleted ? '+++ /dev/null' : `+++ b/${path}`,
  ];
  return header.concat(hunks).join('\n') + '\n';
}
