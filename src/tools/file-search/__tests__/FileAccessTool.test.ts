import { describe, it, expect, beforeEach, vi } from 'vitest';

// Controllable fsExecutor mock. vi.hoisted so it exists in the hoisted
// vi.mock factory (the Rust transport itself is not exercised in unit tests).
const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    stat: vi.fn(),
    readFile: vi.fn(),
    applyEdit: vi.fn(),
    writeIfUnchanged: vi.fn(),
  },
}));
vi.mock('../fsExecutor', () => ({
  fsExecutor: mockFs,
  FsUnsupportedPlatformError: class extends Error {},
}));

import { ReadFileTool, EditFileTool, WriteFileTool } from '../FileAccessTool';
import { FileStateCache } from '../../../core/files/FileStateCache';
import type { ToolContext } from '../../BaseTool';
import type { EditOutcome, WriteOutcome } from '../fsExecutor';

const WS = '/ws';

function ctx(over: Record<string, any> = {}): ToolContext {
  const hasWorkingDirectory = Object.prototype.hasOwnProperty.call(over, 'workingDirectory');
  const workingDirectory = hasWorkingDirectory ? over.workingDirectory : WS;
  const {
    workingDirectory: _workingDirectory,
    mode = 'code',
    onProgress,
    callId = 'call-1',
    ...metadata
  } = over;
  return {
    sessionId: 's', turnId: 't', toolName: 'x', callId, onProgress,
    executionContext: {
      sessionId: 's', turnId: 't', mode,
      ...(workingDirectory ? { workspace: { workingDirectory } } : {}),
    },
    metadata,
  } as ToolContext;
}

function successfulEdit(
  previousContentLf: string,
  newContentLf: string,
  operation: 'created' | 'modified' = 'modified',
  mtimeMs = 1,
  size = newContentLf.length,
): Extract<EditOutcome, { ok: 'true' }> {
  return { ok: 'true', operation, previousContentLf, newContentLf, mtimeMs, size, endings: 'LF', encoding: 'utf8', bom: false };
}

function successfulWrite(
  previousContentLf: string,
  newContentLf: string,
  operation: 'created' | 'modified' = 'modified',
  mtimeMs = 1,
  size = newContentLf.length,
): Extract<WriteOutcome, { written: 'true' }> {
  return { written: 'true', operation, previousContentLf, newContentLf, mtimeMs, size, endings: 'LF', encoding: 'utf8', bom: false };
}

function changedDiffLines(unifiedDiff: string): string[] {
  return unifiedDiff.split('\n').filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 1 });
});

describe('FileAccessTool gating', () => {
  it('is available in general mode', async () => {
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 3 });
    mockFs.readFile.mockResolvedValue({ contentLf: 'a\nb', mtimeMs: 1, size: 3, endings: 'LF', encoding: 'utf8', bom: false });
    const out = await new ReadFileTool().createHandler()({ path: 'a.ts' }, ctx({ mode: 'general' }));
    expect(out).toContain('1\ta');
  });
  it('disabled with no workspace', async () => {
    const out = await new ReadFileTool().createHandler()({ path: 'a.ts' }, ctx({ workingDirectory: undefined }));
    expect(out).toMatch(/working folder/i);
  });
  it('rejects a path outside the workspace', async () => {
    const out = await new ReadFileTool().createHandler()({ path: '../etc/passwd' }, ctx());
    expect(out).toMatch(/outside_workspace|rejected/i);
  });
  it('mode does not affect access when a workspace is present', async () => {
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 3 });
    mockFs.readFile.mockResolvedValue({ contentLf: 'a\nb', mtimeMs: 1, size: 3, endings: 'LF', encoding: 'utf8', bom: false });
    const out = await new ReadFileTool().createHandler()({ path: 'a.ts' }, ctx({ mode: 'general' }));
    expect(out).toContain('1\ta');
  });
});

describe('read_file', () => {
  it('size-gates before reading', async () => {
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 99 * 1024 * 1024 });
    const out = await new ReadFileTool().createHandler()({ path: 'big.bin' }, ctx());
    expect(out).toMatch(/too large/i);
    expect(mockFs.readFile).not.toHaveBeenCalled();
  });
  it('not-found message', async () => {
    mockFs.stat.mockResolvedValue({ exists: false, mtimeMs: 0, size: 0 });
    expect(await new ReadFileTool().createHandler()({ path: 'x' }, ctx())).toMatch(/not found/i);
  });
  it('cat -n output + populates a Read entry (offset set)', async () => {
    const cache = new FileStateCache();
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 42, size: 3 });
    mockFs.readFile.mockResolvedValue({ contentLf: 'x\ny', mtimeMs: 42, size: 3, endings: 'LF', encoding: 'utf8', bom: false });
    const out = await new ReadFileTool().createHandler()({ path: 'a.ts' }, ctx({ fileStateCache: cache }));
    expect(out).toBe('1\tx\n2\ty');
    const e = cache.get(`${WS}/a.ts`);
    expect(e?.offset).toBe(1);
    expect(e?.mtimeFloorMs).toBe(42);
  });

  it('range read: offset-based line numbers + caches a slice (not full)', async () => {
    const cache = new FileStateCache();
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 7, size: 9 });
    mockFs.readFile.mockResolvedValue({ contentLf: 'l1\nl2\nl3\nl4\nl5', mtimeMs: 7, size: 14, endings: 'LF', encoding: 'utf8', bom: false });
    const out = await new ReadFileTool().createHandler()(
      { path: 'a.ts', offset: 2, limit: 2 }, ctx({ fileStateCache: cache }));
    expect(out).toBe('2\tl2\n3\tl3'); // real (offset-based) line numbers
    const e = cache.get(`${WS}/a.ts`);
    expect(e?.content).toBe('l2\nl3'); // slice cached (SC-14: never jitter-eligible)
    expect(e?.offset).toBe(2);
    expect(e?.limit).toBe(2);
  });

  // Contract guard: a range read followed by an edit of an UNCHANGED file
  // must succeed. The slice is cached, but the executor freshness check is
  // `stale ⟺ (mtime changed) AND (full content ≠ cached)`. Unchanged ⇒ mtime
  // matches ⇒ first conjunct false ⇒ NOT stale. (The slice-vs-full mismatch
  // only matters under mtime jitter — the intended SC-14 trade-off, not a
  // bug.) Regression for the PR #228 review "always-stale" concern.
  it('range read → edit of an unchanged file succeeds (not spuriously stale)', async () => {
    const cache = new FileStateCache();
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 7, size: 14 });
    mockFs.readFile.mockResolvedValue({ contentLf: 'l1\nl2\nl3\nl4\nl5', mtimeMs: 7, size: 14, endings: 'LF', encoding: 'utf8', bom: false });
    await new ReadFileTool().createHandler()(
      { path: 'a.ts', offset: 2, limit: 2 }, ctx({ fileStateCache: cache }));

    mockFs.applyEdit.mockResolvedValue(successfulEdit(
      'l1\nl2\nl3\nl4\nl5', 'l1\nl2\nL3\nl4\nl5', 'modified', 7, 14,
    ));
    const onProgress = vi.fn();
    const out = await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'l3', new_string: 'L3' }, ctx({ fileStateCache: cache, onProgress }));

    expect(out).toMatch(/Edited a\.ts/);
    expect(mockFs.applyEdit).toHaveBeenCalledTimes(1);
    const sent = mockFs.applyEdit.mock.calls[0][0];
    expect(sent.expectedMtimeMs).toBe(7);   // the range-read mtime is forwarded
    expect(sent.expectedContentLf).toBe('l2\nl3'); // the cached slice, unchanged mtime ⇒ executor won't flag stale
    expect(cache.get(`${WS}/a.ts`)?.content).toBe('l1\nl2\nL3\nl4\nl5');
    expect(changedDiffLines(onProgress.mock.calls[0][0].data.unifiedDiff)).toEqual(['-l3', '+L3']);
  });
});

describe('edit_file', () => {
  it('refuses when file not read (non-empty old_string)', async () => {
    const cache = new FileStateCache();
    const out = await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'a', new_string: 'b' }, ctx({ fileStateCache: cache }));
    expect(out).toMatch(/read the file first/i);
    expect(mockFs.applyEdit).not.toHaveBeenCalled();
  });
  it('surfaces no_op (identical old/new) without writing', async () => {
    const cache = new FileStateCache();
    cache.set(`${WS}/a.ts`, { content: 'a', mtimeFloorMs: 1, offset: 1 });
    mockFs.applyEdit.mockResolvedValue({ ok: 'false', reason: 'no_op', message: 'identical; nothing to change.' });
    const out = await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'a', new_string: 'a' }, ctx({ fileStateCache: cache }));
    expect(out).toMatch(/no_op/);
  });
  it('surfaces the actionable reason+message on failure', async () => {
    const cache = new FileStateCache();
    cache.set(`${WS}/a.ts`, { content: 'a', mtimeFloorMs: 1, offset: 1 });
    mockFs.applyEdit.mockResolvedValue({ ok: 'false', reason: 'stale', message: 'Re-read it.' });
    const out = await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'a', new_string: 'b' }, ctx({ fileStateCache: cache }));
    expect(out).toBe('Edit not applied (stale): Re-read it.');
  });
  it('on success stores an Edit entry (offset undefined)', async () => {
    const cache = new FileStateCache();
    cache.set(`${WS}/a.ts`, { content: 'a', mtimeFloorMs: 1, offset: 1 });
    mockFs.applyEdit.mockResolvedValue(successfulEdit('a', 'b', 'modified', 9, 1));
    const onProgress = vi.fn();
    const out = await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'a', new_string: 'b' }, ctx({ fileStateCache: cache, onProgress }));
    expect(out).toMatch(/Edited a\.ts/);
    const e = cache.get(`${WS}/a.ts`);
    expect(e?.offset).toBeUndefined();
    expect(e?.content).toBe('b');
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress.mock.calls[0][0].data).toMatchObject({
      type: 'local_file_change',
      status: 'completed',
      operation: 'modified',
      path: 'a.ts',
      size: 1,
      mtimeMs: 9,
    });
    expect(onProgress.mock.calls[0][0].data.unifiedDiff).toContain('-a');
    expect(onProgress.mock.calls[0][0].data.unifiedDiff).toContain('+b');
  });
  it('empty old_string (create) skips the read-before-edit gate', async () => {
    mockFs.stat.mockResolvedValue({ exists: false, mtimeMs: 0, size: 0 });
    mockFs.applyEdit.mockResolvedValue(successfulEdit('', 'new', 'created', 1, 3));
    const onProgress = vi.fn();
    const out = await new EditFileTool().createHandler()(
      { path: 'new.ts', old_string: '', new_string: 'new' }, ctx({ onProgress })); // no cache, no prior read
    expect(out).toMatch(/Edited new\.ts/);
    expect(mockFs.applyEdit).toHaveBeenCalled();
    expect(onProgress.mock.calls[0][0].data).toMatchObject({ operation: 'created', path: 'new.ts' });
  });
  it('classifies an existing empty file as modified rather than created', async () => {
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 0 });
    mockFs.applyEdit.mockResolvedValue(successfulEdit('', 'new', 'modified', 2, 3));
    const onProgress = vi.fn();
    await new EditFileTool().createHandler()(
      { path: 'empty.txt', old_string: '', new_string: 'new' }, ctx({ onProgress }));
    expect(onProgress.mock.calls[0][0].data).toMatchObject({
      operation: 'modified',
      path: 'empty.txt',
    });
  });
  it('does not emit when the executor rejects the edit', async () => {
    const cache = new FileStateCache();
    cache.set(`${WS}/a.ts`, { content: 'a', mtimeFloorMs: 1, offset: 1 });
    mockFs.applyEdit.mockResolvedValue({ ok: 'false', reason: 'stale', message: 'Re-read it.' });
    const onProgress = vi.fn();
    await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'a', new_string: 'b' }, ctx({ fileStateCache: cache, onProgress }));
    expect(onProgress).not.toHaveBeenCalled();
  });
  it('keeps a successful tool result when the progress callback throws', async () => {
    const cache = new FileStateCache();
    cache.set(`${WS}/a.ts`, { content: 'a', mtimeFloorMs: 1, offset: 1 });
    mockFs.applyEdit.mockResolvedValue(successfulEdit('a', 'b', 'modified', 2, 1));
    const out = await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'a', new_string: 'b' },
      ctx({ fileStateCache: cache, onProgress: () => { throw new Error('UI unavailable'); } }),
    );
    expect(out).toMatch(/Edited a\.ts/);
  });
});

describe('write_file', () => {
  it('refuses overwrite of an existing unread file', async () => {
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 5 });
    const out = await new WriteFileTool().createHandler()(
      { path: 'a.ts', content: 'x' }, ctx({ fileStateCache: new FileStateCache() }));
    expect(out).toMatch(/read_file it before overwriting/i);
    expect(mockFs.writeIfUnchanged).not.toHaveBeenCalled();
  });
  it('creates a new file (no prior read needed)', async () => {
    mockFs.stat.mockResolvedValue({ exists: false, mtimeMs: 0, size: 0 });
    mockFs.writeIfUnchanged.mockResolvedValue(successfulWrite('', 'x', 'created', 1, 1));
    const onProgress = vi.fn();
    const out = await new WriteFileTool().createHandler()(
      { path: 'n.ts', content: 'x' }, ctx({ onProgress }));
    expect(out).toMatch(/Created n\.ts/);
    expect(onProgress.mock.calls[0][0].data).toMatchObject({ operation: 'created', path: 'n.ts' });
  });
  it('emits a modification diff for a successful overwrite', async () => {
    const cache = new FileStateCache();
    cache.set(`${WS}/a.ts`, { content: 'before', mtimeFloorMs: 1, offset: 1 });
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 6 });
    mockFs.writeIfUnchanged.mockResolvedValue(successfulWrite('before', 'after', 'modified', 2, 5));
    const onProgress = vi.fn();
    const out = await new WriteFileTool().createHandler()(
      { path: 'a.ts', content: 'after' }, ctx({ fileStateCache: cache, onProgress }));
    expect(out).toMatch(/Overwrote a\.ts/);
    expect(onProgress.mock.calls[0][0].data).toMatchObject({ operation: 'modified', path: 'a.ts' });
    expect(onProgress.mock.calls[0][0].data.unifiedDiff).toContain('-before');
    expect(onProgress.mock.calls[0][0].data.unifiedDiff).toContain('+after');
  });
  it('does not emit when an overwrite is rejected as stale', async () => {
    const cache = new FileStateCache();
    cache.set(`${WS}/a.ts`, { content: 'before', mtimeFloorMs: 1, offset: 1 });
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 6 });
    mockFs.writeIfUnchanged.mockResolvedValue({
      written: 'false',
      reason: 'stale',
      message: 'Re-read it.',
    });
    const onProgress = vi.fn();
    await new WriteFileTool().createHandler()(
      { path: 'a.ts', content: 'after' }, ctx({ fileStateCache: cache, onProgress }));
    expect(onProgress).not.toHaveBeenCalled();
  });
  it('range read → overwrite diffs against the complete executor preimage', async () => {
    const cache = new FileStateCache();
    const before = 'l1\nl2\nl3\nl4\nl5';
    const after = 'l1\nl2\nL3\nl4\nl5';
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 7, size: 14 });
    mockFs.readFile.mockResolvedValue({ contentLf: before, mtimeMs: 7, size: 14, endings: 'LF', encoding: 'utf8', bom: false });
    await new ReadFileTool().createHandler()(
      { path: 'a.ts', offset: 2, limit: 2 }, ctx({ fileStateCache: cache }));

    mockFs.writeIfUnchanged.mockResolvedValue(
      successfulWrite(before, after, 'modified', 8, 14),
    );
    const onProgress = vi.fn();
    const out = await new WriteFileTool().createHandler()(
      { path: 'a.ts', content: after }, ctx({ fileStateCache: cache, onProgress }));

    expect(out).toBe('Overwrote a.ts.');
    expect(mockFs.writeIfUnchanged.mock.calls[0][0].expectedMtimeMs).toBe(7);
    expect(cache.get(`${WS}/a.ts`)?.content).toBe(after);
    expect(changedDiffLines(onProgress.mock.calls[0][0].data.unifiedDiff)).toEqual(['-l3', '+L3']);
  });
  it('does not emit for an unchanged overwrite', async () => {
    const cache = new FileStateCache();
    cache.set(`${WS}/a.ts`, { content: 'same', mtimeFloorMs: 1, offset: 1 });
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 4 });
    mockFs.writeIfUnchanged.mockResolvedValue(successfulWrite('same', 'same', 'modified', 2, 4));
    const onProgress = vi.fn();
    const out = await new WriteFileTool().createHandler()(
      { path: 'a.ts', content: 'same' }, ctx({ fileStateCache: cache, onProgress }));
    expect(out).toMatch(/Overwrote a\.ts/);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
