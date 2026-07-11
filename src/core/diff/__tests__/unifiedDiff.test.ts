import { describe, it, expect } from 'vitest';
import { computeUnifiedDiff } from '../unifiedDiff';
import { parseUnifiedDiff, getAddedFileContent } from '../../../webfront/lib/diffParse';

describe('computeUnifiedDiff', () => {
  it('returns empty string when content is unchanged', () => {
    expect(computeUnifiedDiff('a.txt', 'x\ny\n', 'x\ny\n')).toBe('');
    expect(computeUnifiedDiff('a.txt', '', '')).toBe('');
  });

  it('emits a git-style creation diff for a new file (--- /dev/null)', () => {
    const diff = computeUnifiedDiff('docs/new.md', '', '# Title\n\nBody\n');
    expect(diff).toContain('diff --git a/docs/new.md b/docs/new.md');
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/docs/new.md');
    expect(diff).toContain('@@ -0,0 +1,3 @@');
    expect(diff).toContain('+# Title');
  });

  it('round-trips a new file through the frontend parser', () => {
    const after = 'line one\nline two\nline three\n';
    const diff = computeUnifiedDiff('a/b/file.md', '', after);
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].isNew).toBe(true);
    expect(files[0].path).toBe('a/b/file.md');
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(0);
    // The panel reconstructs a freshly-written doc's body from the diff.
    expect(getAddedFileContent(files[0])).toBe('line one\nline two\nline three');
  });

  it('produces a minimal hunk with surrounding context for a small edit', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n') + '\n';
    const diff = computeUnifiedDiff('x.ts', before, after);
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
    // Only one hunk, and it does not span the whole file (context-bounded).
    expect(files[0].hunks).toHaveLength(1);
    const del = files[0].hunks[0].lines.find((l) => l.type === 'del');
    const add = files[0].hunks[0].lines.find((l) => l.type === 'add');
    expect(del?.text).toBe('d');
    expect(add?.text).toBe('D');
  });

  it('reports correct old/new line numbers via the parser', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    const after = 'one\ntwo\ninserted\nthree\nfour\nfive\n';
    const files = parseUnifiedDiff(computeUnifiedDiff('n.txt', before, after));
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(0);
    const added = files[0].hunks[0].lines.find((l) => l.type === 'add');
    expect(added?.text).toBe('inserted');
    expect(added?.newLine).toBe(3);
  });

  it('keeps distant changes in separate hunks', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`);
    const before = lines.join('\n') + '\n';
    const changed = [...lines];
    changed[2] = 'CHANGED2';
    changed[30] = 'CHANGED30';
    const after = changed.join('\n') + '\n';
    const files = parseUnifiedDiff(computeUnifiedDiff('big.ts', before, after));
    expect(files[0].hunks.length).toBe(2);
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(2);
  });

  it('handles content whose lines start with -- or ++ (parser boundary guard)', () => {
    const before = 'SELECT 1;\n-- old comment\nSELECT 2;\n';
    const after = 'SELECT 1;\n-- new comment\nSELECT 2;\n';
    const diff = computeUnifiedDiff('q.sql', before, after);
    const files = parseUnifiedDiff(diff);
    // Must be parsed as ONE file, not split on the `-- ` content line.
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('q.sql');
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
  });

  it('falls back to a full replace for very large files without throwing', () => {
    const before = Array.from({ length: 6000 }, (_, i) => `a${i}`).join('\n') + '\n';
    const after = Array.from({ length: 6000 }, (_, i) => `b${i}`).join('\n') + '\n';
    const diff = computeUnifiedDiff('huge.ts', before, after);
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].additions).toBe(6000);
    expect(files[0].deletions).toBe(6000);
  });
});
