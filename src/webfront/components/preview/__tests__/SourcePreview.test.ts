import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import type { PreviewReadTextResult } from '@/core/services/preview-services';
import type { LocalFilePreviewItem } from '@/types/ui';

const mocks = vi.hoisted(() => ({ serviceRequest: vi.fn() }));

vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(async () => ({ serviceRequest: mocks.serviceRequest })),
}));

import SourcePreview from '../SourcePreview.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function item(id: string): LocalFilePreviewItem {
  return {
    id,
    sessionId: 's1',
    resource: { type: 'local-text-file', path: `${id}.txt` },
    operation: 'modified',
    size: 10,
    mtimeMs: 1,
    availableViews: ['source'],
    createdAt: 1,
  };
}

function response(path: string, contentLf: string): PreviewReadTextResult {
  return { path, contentLf, size: contentLf.length, mtimeMs: 1, encoding: 'utf8' };
}

describe('SourcePreview', () => {
  it('ignores a late response after the selected preview item changes', async () => {
    const oldRead = deferred<PreviewReadTextResult>();
    const newRead = deferred<PreviewReadTextResult>();
    mocks.serviceRequest.mockImplementation(
      (_service: string, params: { path: string }) => params.path === 'old.txt'
        ? oldRead.promise
        : newRead.promise,
    );

    const { rerender } = render(SourcePreview, { props: { item: item('old') } });
    await waitFor(() => expect(mocks.serviceRequest).toHaveBeenCalledWith(
      'preview.readLocalText',
      { sessionId: 's1', path: 'old.txt' },
    ));

    await rerender({ item: item('new') });
    await waitFor(() => expect(mocks.serviceRequest).toHaveBeenCalledWith(
      'preview.readLocalText',
      { sessionId: 's1', path: 'new.txt' },
    ));
    newRead.resolve(response('new.txt', 'new-content'));
    await screen.findByText('new-content');

    oldRead.resolve(response('old.txt', 'stale-old-content'));
    await Promise.resolve();
    expect(screen.queryByText('stale-old-content')).toBeNull();
    expect(screen.getByText('new-content')).toBeTruthy();
  });

  it('shows read errors and retries the same thread-relative path', async () => {
    mocks.serviceRequest
      .mockRejectedValueOnce(new Error('The preview file no longer exists'))
      .mockResolvedValueOnce(response('missing.txt', 'restored'));

    render(SourcePreview, { props: { item: item('missing') } });
    await screen.findByText('The preview file no longer exists');
    screen.getByRole('button', { name: 'Retry' }).click();
    await screen.findByText('restored');
    expect(mocks.serviceRequest).toHaveBeenCalledTimes(2);
  });

  it('uses one low-DOM preformatted block for files over 10,000 lines', async () => {
    const contentLf = Array.from({ length: 10_001 }, (_, index) => `line ${index + 1}`).join('\n');
    mocks.serviceRequest.mockResolvedValueOnce(response('large.txt', contentLf));

    const { container } = render(SourcePreview, { props: { item: item('large') } });
    await screen.findByText('Line numbers are hidden because this file exceeds 10,000 lines.');

    expect(container.querySelector('pre')?.textContent).toBe(contentLf);
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(`${contentLf.length.toLocaleString()} bytes`)).toBeTruthy();
  });
});
