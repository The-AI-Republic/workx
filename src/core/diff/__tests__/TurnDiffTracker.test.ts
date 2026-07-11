import { describe, it, expect } from 'vitest';
import { TurnDiffTracker } from '../TurnDiffTracker';
import { parseUnifiedDiff } from '../../../webfront/lib/diffParse';

describe('TurnDiffTracker', () => {
  it('starts empty', () => {
    const t = new TurnDiffTracker();
    expect(t.isEmpty()).toBe(true);
    expect(t.computeDiff()).toEqual({ diff: '', filesChanged: 0 });
  });

  it('records a single created file', () => {
    const t = new TurnDiffTracker();
    t.record('/ws/notes.md', 'notes.md', '', '# Notes\n');
    expect(t.isEmpty()).toBe(false);
    const { diff, filesChanged } = t.computeDiff();
    expect(filesChanged).toBe(1);
    const files = parseUnifiedDiff(diff);
    expect(files[0].path).toBe('notes.md');
    expect(files[0].isNew).toBe(true);
  });

  it('keeps the FIRST before and the LATEST after across multiple writes', () => {
    const t = new TurnDiffTracker();
    // baseline B0 -> A1 -> A2 in one turn: net diff should be B0 -> A2.
    t.record('/ws/f.ts', 'f.ts', 'v0\n', 'v1\n');
    t.record('/ws/f.ts', 'f.ts', 'v1\n', 'v2\n');
    const { diff, filesChanged } = t.computeDiff();
    expect(filesChanged).toBe(1);
    const files = parseUnifiedDiff(diff);
    const del = files[0].hunks[0].lines.find((l) => l.type === 'del');
    const add = files[0].hunks[0].lines.find((l) => l.type === 'add');
    expect(del?.text).toBe('v0'); // original baseline, not the intermediate v1
    expect(add?.text).toBe('v2');
  });

  it('drops a file that is edited back to its baseline (no net change)', () => {
    const t = new TurnDiffTracker();
    t.record('/ws/f.ts', 'f.ts', 'orig\n', 'changed\n');
    t.record('/ws/f.ts', 'f.ts', 'changed\n', 'orig\n');
    const { diff, filesChanged } = t.computeDiff();
    expect(filesChanged).toBe(0);
    expect(diff).toBe('');
  });

  it('collapses different path spellings of the same file to one baseline', () => {
    const t = new TurnDiffTracker();
    t.record('/ws/Dir/File.ts', 'Dir/File.ts', 'a\n', 'b\n');
    // Same file, different case (case-insensitive dedup, matching FileStateCache).
    t.record('/ws/dir/file.ts', 'dir/file.ts', 'b\n', 'c\n');
    const { filesChanged } = t.computeDiff();
    expect(filesChanged).toBe(1);
  });

  it('accumulates multiple files, path-sorted, and counts them', () => {
    const t = new TurnDiffTracker();
    t.record('/ws/z.ts', 'z.ts', 'z0\n', 'z1\n');
    t.record('/ws/a.ts', 'a.ts', '', 'a-new\n');
    const { diff, filesChanged } = t.computeDiff();
    expect(filesChanged).toBe(2);
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'z.ts']);
  });

  it('reset() clears all tracked changes', () => {
    const t = new TurnDiffTracker();
    t.record('/ws/f.ts', 'f.ts', 'a\n', 'b\n');
    t.reset();
    expect(t.isEmpty()).toBe(true);
    expect(t.computeDiff()).toEqual({ diff: '', filesChanged: 0 });
  });
});
