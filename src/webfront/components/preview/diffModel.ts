import { parsePatch } from 'diff';

export interface DiffRow {
  key: string;
  oldLine: number | null;
  newLine: number | null;
  kind: 'addition' | 'deletion' | 'context' | 'header' | 'note';
  text: string;
}

export interface ParsedPreviewDiff {
  rows: DiffRow[];
  rawFallback: string | null;
  error: string | null;
}

export function rowsForUnifiedDiff(diff: string): ParsedPreviewDiff {
  if (!diff) {
    return { rows: [], rawFallback: null, error: 'No diff is available for this change.' };
  }
  try {
    const rows: DiffRow[] = [];
    let rowIndex = 0;
    for (const file of parsePatch(diff)) {
      for (const hunk of file.hunks) {
        rows.push({
          key: `h-${rowIndex++}`,
          oldLine: null,
          newLine: null,
          kind: 'header',
          text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        });
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const line of hunk.lines) {
          const marker = line.charAt(0);
          if (marker === '+') {
            rows.push({ key: `r-${rowIndex++}`, oldLine: null, newLine, kind: 'addition', text: line.slice(1) });
            newLine++;
          } else if (marker === '-') {
            rows.push({ key: `r-${rowIndex++}`, oldLine, newLine: null, kind: 'deletion', text: line.slice(1) });
            oldLine++;
          } else if (marker === ' ') {
            rows.push({ key: `r-${rowIndex++}`, oldLine, newLine, kind: 'context', text: line.slice(1) });
            oldLine++;
            newLine++;
          } else if (marker === '\\') {
            rows.push({ key: `r-${rowIndex++}`, oldLine: null, newLine: null, kind: 'note', text: line.slice(1).trimStart() });
          }
        }
      }
    }
    return rows.length
      ? { rows, rawFallback: null, error: null }
      : { rows: [], rawFallback: diff, error: 'The patch was malformed; showing raw text.' };
  } catch {
    return { rows: [], rawFallback: diff, error: 'The patch was malformed; showing raw text.' };
  }
}
