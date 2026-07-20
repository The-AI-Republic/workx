import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPreviewServices,
  PreviewServiceError,
  type PreviewServiceDeps,
} from '../preview-services';
import { LOCAL_FILE_SOURCE_MAX_BYTES } from '@/tools/runtimeMetadata';
import type { SubmissionContext } from '@/core/channels/types';

const context = { channelId: 'test', channelType: 'sidepanel' } as SubmissionContext;

function makeDeps(overrides: Partial<PreviewServiceDeps> = {}): PreviewServiceDeps {
  return {
    registry: {
      getThread: vi.fn().mockResolvedValue({
        workspace: { workingDirectory: '/workspace' },
      }),
    },
    stat: vi.fn().mockResolvedValue({ exists: true, size: 12, mtimeMs: 10 }),
    readFile: vi.fn().mockResolvedValue({
      contentLf: '# Hello\n',
      size: 8,
      mtimeMs: 11,
      encoding: 'utf8',
    }),
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'PreviewServiceError',
    code,
    errorCode: code,
    retryable: false,
  });
}

describe('preview-services', () => {
  let deps: PreviewServiceDeps;
  let readText: ReturnType<typeof createPreviewServices>['preview.readLocalText'];

  beforeEach(() => {
    deps = makeDeps();
    readText = createPreviewServices(deps)['preview.readLocalText'];
  });

  it('reads normalized workspace-relative UTF-8 text for the requested thread', async () => {
    const result = await readText({ sessionId: 'thread-1', path: './docs\\guide.md' }, context);

    expect(deps.registry.getThread).toHaveBeenCalledWith('thread-1');
    expect(deps.stat).toHaveBeenCalledWith('/workspace', 'docs/guide.md');
    expect(deps.readFile).toHaveBeenCalledWith('/workspace', 'docs/guide.md');
    expect(result).toEqual({
      path: 'docs/guide.md',
      contentLf: '# Hello\n',
      size: 8,
      mtimeMs: 11,
      encoding: 'utf8',
    });
  });

  it('preserves spaces that are part of an accepted file or workspace name', async () => {
    deps = makeDeps({
      registry: {
        getThread: vi.fn().mockResolvedValue({
          workspace: { workingDirectory: '/workspace with spaces ' },
        }),
      },
    });
    readText = createPreviewServices(deps)['preview.readLocalText'];

    const result = await readText({ sessionId: ' thread-1 ', path: ' docs/file .md ' }, context);

    expect(deps.registry.getThread).toHaveBeenCalledWith('thread-1');
    expect(deps.stat).toHaveBeenCalledWith('/workspace with spaces ', ' docs/file .md ');
    expect(result).toMatchObject({ path: ' docs/file .md ' });
  });

  it.each([
    [{ path: 'a.txt' }, 'INVALID_ARGUMENT'],
    [{ sessionId: 's1' }, 'INVALID_ARGUMENT'],
    [{ sessionId: 's1', path: '/etc/passwd' }, 'INVALID_ARGUMENT'],
    [{ sessionId: 's1', path: 'C:\\secret.txt' }, 'INVALID_ARGUMENT'],
    [{ sessionId: 's1', path: '..\\secret.txt' }, 'ACCESS_DENIED'],
    [{ sessionId: 's1', path: '.git/config' }, 'ACCESS_DENIED'],
  ])('rejects invalid or inaccessible request %# with %s', async (params, code) => {
    await expectCode(readText(params, context), code);
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('does not allow normalization to escape and re-enter the workspace', async () => {
    await expectCode(
      readText({ sessionId: 's1', path: 'docs/../../workspace/secret.txt' }, context),
      'ACCESS_DENIED',
    );
  });

  it('returns stable thread and workspace errors', async () => {
    deps = makeDeps({
      registry: { getThread: vi.fn().mockRejectedValue(new Error('SESSION_DELETED')) },
    });
    readText = createPreviewServices(deps)['preview.readLocalText'];
    await expectCode(readText({ sessionId: 'gone', path: 'a.txt' }, context), 'THREAD_NOT_FOUND');

    deps = makeDeps({ registry: { getThread: vi.fn().mockResolvedValue({}) } });
    readText = createPreviewServices(deps)['preview.readLocalText'];
    await expectCode(readText({ sessionId: 's1', path: 'a.txt' }, context), 'NO_WORKSPACE');
  });

  it('checks the stat size before reading', async () => {
    (deps.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      size: LOCAL_FILE_SOURCE_MAX_BYTES + 1,
      mtimeMs: 1,
    });

    await expectCode(readText({ sessionId: 's1', path: 'large.txt' }, context), 'TOO_LARGE');
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('rechecks both authoritative size and UTF-8 byte size after reading', async () => {
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      contentLf: 'x'.repeat(LOCAL_FILE_SOURCE_MAX_BYTES + 1),
      size: 1,
      mtimeMs: 2,
      encoding: 'utf8',
    });

    await expectCode(readText({ sessionId: 's1', path: 'changed.txt' }, context), 'TOO_LARGE');
  });

  it.each([
    ['missing', 'NOT_FOUND'],
    ['denied', 'ACCESS_DENIED'],
    ['gone-after-stat', 'NOT_FOUND'],
    ['unsupported', 'UNSUPPORTED_TEXT'],
    ['io', 'READ_FAILED'],
  ] as const)('maps filesystem failure %s to %s', async (failure, code) => {
    const overrides: Partial<PreviewServiceDeps> = {};
    if (failure === 'missing') {
      overrides.stat = vi.fn().mockResolvedValue({ exists: false, size: 0, mtimeMs: 0 });
    } else if (failure === 'denied') {
      overrides.stat = vi.fn().mockRejectedValue(
        new Error('Path is outside the workspace and cannot be accessed.'),
      );
    } else {
      const message = failure === 'gone-after-stat'
        ? 'not_found: ENOENT'
        : failure === 'unsupported'
          ? 'unsupported_encoding: binary'
          : 'EIO';
      overrides.readFile = vi.fn().mockRejectedValue(new Error(message));
    }
    deps = makeDeps(overrides);
    const handler = createPreviewServices(deps)['preview.readLocalText'];
    await expectCode(handler({ sessionId: 's1', path: 'a.txt' }, context), code);
  });

  it('exposes a typed service error class for callers', () => {
    expect(new PreviewServiceError('READ_FAILED', 'failed')).toMatchObject({
      name: 'PreviewServiceError',
      code: 'READ_FAILED',
    });
  });
});
