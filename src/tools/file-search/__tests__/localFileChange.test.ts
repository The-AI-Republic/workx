import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../BaseTool';
import {
  LOCAL_FILE_DIFF_INPUT_MAX_BYTES,
  LOCAL_FILE_DIFF_MAX_BYTES,
  type LocalFileChangeProgress,
} from '../../runtimeMetadata';
import {
  emitLocalFileChange,
  utf8Size,
  workspaceRelativeDisplayPath,
} from '../localFileChange';

function context(onProgress: ToolContext['onProgress']): ToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolName: 'edit_file',
    callId: 'call-1',
    onProgress,
  };
}

describe('workspaceRelativeDisplayPath', () => {
  it('normalizes relative and absolute accepted paths without leaking the root', () => {
    expect(workspaceRelativeDisplayPath('/workspace', './src\\app.ts')).toBe('src/app.ts');
    expect(workspaceRelativeDisplayPath('/workspace', '/workspace/docs/readme.md')).toBe('docs/readme.md');
  });

  it('rejects traversal and protected paths', () => {
    expect(workspaceRelativeDisplayPath('/workspace', '../secret.txt')).toBeNull();
    expect(workspaceRelativeDisplayPath('/workspace', '.git/config')).toBeNull();
  });
});

describe('emitLocalFileChange', () => {
  it('emits a complete bounded unified diff for a small modification', async () => {
    const onProgress = vi.fn();
    await emitLocalFileChange({
      context: context(onProgress),
      workspaceRoot: '/workspace',
      path: '/workspace/src/app.ts',
      before: 'const size = 12;\n',
      after: 'const size = 14;\n',
      operation: 'modified',
      size: 17,
      mtimeMs: 42,
    });

    expect(onProgress).toHaveBeenCalledOnce();
    const progress = onProgress.mock.calls[0][0].data as LocalFileChangeProgress;
    expect(progress).toMatchObject({
      type: 'local_file_change',
      status: 'completed',
      operation: 'modified',
      path: 'src/app.ts',
      size: 17,
      mtimeMs: 42,
      message: 'Modified src/app.ts',
    });
    expect(progress.unifiedDiff).toContain('-const size = 12;');
    expect(progress.unifiedDiff).toContain('+const size = 14;');
    expect(utf8Size(progress.unifiedDiff!)).toBeLessThanOrEqual(LOCAL_FILE_DIFF_MAX_BYTES);
  });

  it('normalizes CRLF before deciding whether content changed', async () => {
    const onProgress = vi.fn();
    await emitLocalFileChange({
      context: context(onProgress),
      workspaceRoot: '/workspace',
      path: 'same.txt',
      before: 'same\r\n',
      after: 'same\n',
      operation: 'modified',
      size: 5,
      mtimeMs: 1,
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('skips diff generation when combined input exceeds the CPU budget', async () => {
    const onProgress = vi.fn();
    const before = 'a'.repeat(LOCAL_FILE_DIFF_INPUT_MAX_BYTES);
    await emitLocalFileChange({
      context: context(onProgress),
      workspaceRoot: '/workspace',
      path: 'large.txt',
      before,
      after: `${before}b`,
      operation: 'modified',
      size: before.length + 1,
      mtimeMs: 2,
    });
    const progress = onProgress.mock.calls[0][0].data as LocalFileChangeProgress;
    expect(progress.diffOmittedReason).toBe('input_too_large');
    expect(progress.unifiedDiff).toBeUndefined();
  });

  it('omits a generated patch that exceeds the event payload budget', async () => {
    const onProgress = vi.fn();
    // One long replaced line produces a >32 KiB patch without triggering the
    // quadratic worst case of thousands of unrelated changed lines.
    const before = `${'a'.repeat(20_000)}\n`;
    const after = `${'b'.repeat(20_000)}\n`;
    expect(utf8Size(before) + utf8Size(after)).toBeLessThan(LOCAL_FILE_DIFF_INPUT_MAX_BYTES);

    await emitLocalFileChange({
      context: context(onProgress),
      workspaceRoot: '/workspace',
      path: 'large-patch.txt',
      before,
      after,
      operation: 'modified',
      size: utf8Size(after),
      mtimeMs: 3,
    });

    const progress = onProgress.mock.calls[0][0].data as LocalFileChangeProgress;
    expect(progress.diffOmittedReason).toBe('diff_too_large');
    expect(progress.unifiedDiff).toBeUndefined();
  });

  it('uses a deterministic correlation id when the tool call id is absent', async () => {
    const onProgress = vi.fn();
    const noCallId = { ...context(onProgress), callId: undefined };
    await emitLocalFileChange({
      context: noCallId,
      workspaceRoot: '/workspace',
      path: 'src/app.ts',
      before: 'a',
      after: 'b',
      operation: 'modified',
      size: 1,
      mtimeMs: 2,
    });
    expect(onProgress.mock.calls[0][0].toolUseID).toBe('turn-1:edit_file:src/app.ts');
  });

  it('swallows progress callback errors after a successful mutation', async () => {
    await expect(emitLocalFileChange({
      context: context(() => { throw new Error('closed'); }),
      workspaceRoot: '/workspace',
      path: 'a.txt',
      before: 'a',
      after: 'b',
      operation: 'modified',
      size: 1,
      mtimeMs: 2,
    })).resolves.toBeUndefined();
  });
});
