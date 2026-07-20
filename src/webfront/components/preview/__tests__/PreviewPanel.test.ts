import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { LocalFilePreviewItem, ThreadPreviewState } from '@/types/ui';
import PreviewPanel from '../PreviewPanel.svelte';

vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(() => new Promise(() => {})),
}));

function item(id: string, path: string): LocalFilePreviewItem {
  return {
    id,
    sessionId: 's1',
    resource: { type: 'local-text-file', path },
    operation: id === 'one' ? 'modified' : 'created',
    size: 10,
    mtimeMs: 1,
    unifiedDiff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    availableViews: path.endsWith('.md') ? ['diff', 'rendered', 'source'] : ['diff', 'source'],
    createdAt: 1,
  };
}

describe('PreviewPanel', () => {
  it('exposes labeled operation selection, tabs, and close controls', async () => {
    const onClose = vi.fn();
    const onSelectItem = vi.fn();
    const onSelectView = vi.fn();
    const state: ThreadPreviewState = {
      items: [item('one', 'README.md'), item('two', 'src/app.ts')],
      selectedItemId: 'one',
      selectedView: 'diff',
      open: true,
      unread: false,
      autoOpenSuppressed: false,
    };
    render(PreviewPanel, { props: { state, onClose, onSelectItem, onSelectView } });

    expect(screen.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Rendered' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Source' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(onSelectView).toHaveBeenCalledWith('source');

    await fireEvent.change(screen.getByRole('combobox', { name: 'Previewed file change' }), {
      target: { value: 'two' },
    });
    expect(onSelectItem).toHaveBeenCalledWith('two');

    await fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows omission metadata and uses terminal theme styling', () => {
    const omitted = item('one', 'README.md');
    delete omitted.unifiedDiff;
    omitted.availableViews = ['rendered', 'source'];
    omitted.diffOmittedReason = 'diff_too_large';
    const state: ThreadPreviewState = {
      items: [omitted],
      selectedItemId: omitted.id,
      selectedView: 'source',
      open: true,
      unread: false,
      autoOpenSuppressed: false,
    };

    const { container } = render(PreviewPanel, {
      props: {
        state,
        theme: 'terminal',
        onClose: vi.fn(),
        onSelectItem: vi.fn(),
        onSelectView: vi.fn(),
      },
    });

    expect(container.querySelector('section')?.className).toContain('bg-black');
    expect(screen.getByText(/generated patch exceeded/)).toBeTruthy();
    expect(container.querySelector('[data-preview-close]')).toBeTruthy();
  });
});
