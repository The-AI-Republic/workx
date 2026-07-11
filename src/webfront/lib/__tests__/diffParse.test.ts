import { describe, expect, it } from 'vitest';
import {
  parseUnifiedDiff,
  extractAddedFileContent,
  inferArtifactKind,
} from '../diffParse';

const NEW_FILE_DIFF = `diff --git a/docs/design.md b/docs/design.md
new file mode 100644
--- /dev/null
+++ b/docs/design.md
@@ -0,0 +1,3 @@
+# Title
+
+Body line
`;

const MODIFY_DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

const MULTI_FILE_DIFF = NEW_FILE_DIFF + MODIFY_DIFF;

describe('parseUnifiedDiff', () => {
  it('parses a new-file diff with additions and a resolved path', () => {
    const files = parseUnifiedDiff(NEW_FILE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('docs/design.md');
    expect(files[0].isNew).toBe(true);
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(0);
  });

  it('parses a modification with balanced add/del counts and line numbers', () => {
    const files = parseUnifiedDiff(MODIFY_DIFF);
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.path).toBe('src/app.ts');
    expect(f.isNew).toBe(false);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    const add = f.hunks[0].lines.find((l) => l.type === 'add');
    const del = f.hunks[0].lines.find((l) => l.type === 'del');
    expect(add?.text).toBe('const b = 3;');
    expect(add?.newLine).toBe(2);
    expect(del?.text).toBe('const b = 2;');
    expect(del?.oldLine).toBe(2);
  });

  it('splits a multi-file diff into one entry per file', () => {
    const files = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(files.map((f) => f.path)).toEqual(['docs/design.md', 'src/app.ts']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('extractAddedFileContent', () => {
  it('returns the full body of a newly-added file', () => {
    expect(extractAddedFileContent(NEW_FILE_DIFF)).toBe('# Title\n\nBody line');
  });

  it('returns null for a modification (not a pure creation)', () => {
    expect(extractAddedFileContent(MODIFY_DIFF)).toBeNull();
  });

  it('selects the right file by path in a multi-file diff', () => {
    expect(extractAddedFileContent(MULTI_FILE_DIFF, 'docs/design.md')).toBe(
      '# Title\n\nBody line',
    );
  });
});

describe('inferArtifactKind', () => {
  it('maps extensions to render kinds', () => {
    expect(inferArtifactKind('a/b/README.md')).toBe('markdown');
    expect(inferArtifactKind('src/app.ts')).toBe('code');
    expect(inferArtifactKind('src/App.svelte')).toBe('code');
    expect(inferArtifactKind('data.csv')).toBe('csv');
    expect(inferArtifactKind('logo.png')).toBe('image');
    expect(inferArtifactKind('notes.txt')).toBe('text');
    expect(inferArtifactKind('Makefile')).toBe('unknown');
  });
});
