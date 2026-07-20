import { describe, expect, it } from 'vitest';
import { rowsForUnifiedDiff } from '../diffModel';

describe('preview diff model', () => {
  it('assigns old/new line numbers and row types across multiple hunks', () => {
    const parsed = rowsForUnifiedDiff(`--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,2 +10,3 @@
 ten
+inserted
 eleven
`);

    expect(parsed.error).toBeNull();
    expect(parsed.rows.filter((row) => row.kind === 'header')).toHaveLength(2);
    expect(parsed.rows.filter((row) => row.kind === 'deletion')[0]).toMatchObject({
      oldLine: 2,
      newLine: null,
      text: 'two',
    });
    expect(parsed.rows.filter((row) => row.kind === 'addition')).toEqual([
      expect.objectContaining({ oldLine: null, newLine: 2, text: 'TWO' }),
      expect.objectContaining({ oldLine: null, newLine: 11, text: 'inserted' }),
    ]);
    expect(parsed.rows[parsed.rows.length - 1]).toMatchObject({ oldLine: 11, newLine: 12, text: 'eleven' });
  });

  it('falls back to escaped raw text when the patch is malformed', () => {
    const raw = '<script>alert(1)</script> not a patch';
    expect(rowsForUnifiedDiff(raw)).toMatchObject({
      rows: [],
      rawFallback: raw,
      error: 'The patch was malformed; showing raw text.',
    });
  });

  it('preserves no-newline notes without advancing line numbers', () => {
    const parsed = rowsForUnifiedDiff(`--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`);
    expect(parsed.rows.filter((row) => row.kind === 'note')).toHaveLength(2);
    expect(parsed.rows.filter((row) => row.kind === 'addition')[0]?.newLine).toBe(1);
  });
});
