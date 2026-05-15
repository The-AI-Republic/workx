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

const WS = '/ws';

function ctx(over: Record<string, any> = {}): ToolContext {
  return {
    sessionId: 's', turnId: 't', toolName: 'x',
    metadata: { workspaceRoot: WS, agentMode: 'code', ...over },
  } as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FileAccessTool gating', () => {
  it('disabled outside code mode', async () => {
    const out = await new ReadFileTool().createHandler()({ path: 'a.ts' }, ctx({ agentMode: 'general' }));
    expect(out).toMatch(/Code mode only/i);
  });
  it('disabled with no workspace', async () => {
    const out = await new ReadFileTool().createHandler()({ path: 'a.ts' }, ctx({ workspaceRoot: undefined }));
    expect(out).toMatch(/project folder/i);
  });
  it('rejects a path outside the workspace', async () => {
    const out = await new ReadFileTool().createHandler()({ path: '../etc/passwd' }, ctx());
    expect(out).toMatch(/outside_workspace|rejected/i);
  });
  it('undefined agentMode (session-less) is NOT mode-blocked', async () => {
    mockFs.stat.mockResolvedValue({ exists: true, mtimeMs: 1, size: 3 });
    mockFs.readFile.mockResolvedValue({ contentLf: 'a\nb', mtimeMs: 1, size: 3, endings: 'LF', encoding: 'utf8', bom: false });
    const out = await new ReadFileTool().createHandler()({ path: 'a.ts' }, ctx({ agentMode: undefined }));
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
});

describe('edit_file', () => {
  it('refuses when file not read (non-empty old_string)', async () => {
    const cache = new FileStateCache();
    const out = await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'a', new_string: 'b' }, ctx({ fileStateCache: cache }));
    expect(out).toMatch(/read the file first/i);
    expect(mockFs.applyEdit).not.toHaveBeenCalled();
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
    mockFs.applyEdit.mockResolvedValue({ ok: 'true', newContentLf: 'b', mtimeMs: 9, size: 1, endings: 'LF', encoding: 'utf8', bom: false });
    const out = await new EditFileTool().createHandler()(
      { path: 'a.ts', old_string: 'a', new_string: 'b' }, ctx({ fileStateCache: cache }));
    expect(out).toMatch(/Edited a\.ts/);
    const e = cache.get(`${WS}/a.ts`);
    expect(e?.offset).toBeUndefined();
    expect(e?.content).toBe('b');
  });
  it('empty old_string (create) skips the read-before-edit gate', async () => {
    mockFs.applyEdit.mockResolvedValue({ ok: 'true', newContentLf: 'new', mtimeMs: 1, size: 3, endings: 'LF', encoding: 'utf8', bom: false });
    const out = await new EditFileTool().createHandler()(
      { path: 'new.ts', old_string: '', new_string: 'new' }, ctx()); // no cache, no prior read
    expect(out).toMatch(/Edited new\.ts/);
    expect(mockFs.applyEdit).toHaveBeenCalled();
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
    mockFs.writeIfUnchanged.mockResolvedValue({ written: 'true', mtimeMs: 1, size: 1, endings: 'LF', encoding: 'utf8', bom: false });
    const out = await new WriteFileTool().createHandler()({ path: 'n.ts', content: 'x' }, ctx());
    expect(out).toMatch(/Created n\.ts/);
  });
});
