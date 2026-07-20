import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { LocalFilePreviewItem } from '@/types/ui';

const mocks = vi.hoisted(() => ({
  serviceRequest: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(async () => ({ serviceRequest: mocks.serviceRequest })),
}));

vi.mock('@/webfront/lib/gatewayCatalog', () => ({
  openExternalUrl: mocks.openExternalUrl,
}));

import MarkdownPreview from '../MarkdownPreview.svelte';

const item: LocalFilePreviewItem = {
  id: 'markdown-1',
  sessionId: 's1',
  resource: { type: 'local-text-file', path: 'README.md' },
  operation: 'modified',
  size: 10,
  mtimeMs: 1,
  availableViews: ['rendered', 'source'],
  createdAt: 1,
};

describe('MarkdownPreview', () => {
  it('suppresses images and routes only safe links through the external opener', async () => {
    mocks.serviceRequest.mockResolvedValue({
      path: 'README.md',
      contentLf: [
        '[Docs](https://example.com/docs)',
        '[Local](./local.md)',
        '![Tracker](https://example.com/tracker.png)',
        '<b>Raw HTML stays text</b>',
        '<form action="https://example.com"><button>Submit</button></form>',
        '<script>alert(1)</script>',
      ].join('\n\n'),
      size: 100,
      mtimeMs: 1,
      encoding: 'utf8',
    });

    const { container } = render(MarkdownPreview, { props: { item } });
    const docs = await screen.findByRole('link', { name: 'Docs' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<b>Raw HTML stays text</b>')).toBeTruthy();
    await fireEvent.click(docs);
    expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://example.com/docs');

    const local = screen.getByText('Local');
    expect(local.getAttribute('href')).toBeNull();
    await fireEvent.click(local);
    expect(mocks.openExternalUrl).toHaveBeenCalledTimes(1);
  });
});
