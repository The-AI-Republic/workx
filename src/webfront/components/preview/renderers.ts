import type { Component } from 'svelte';
import type { LocalFilePreviewItem, LocalFilePreviewView } from '@/types/ui';
import DiffView from './DiffView.svelte';
import MarkdownPreview from './MarkdownPreview.svelte';
import SourcePreview from './SourcePreview.svelte';

export interface PreviewRenderer {
  id: string;
  supports(item: LocalFilePreviewItem, view: LocalFilePreviewView): boolean;
  component: Component<{ item: LocalFilePreviewItem }>;
}

export const previewRenderers: PreviewRenderer[] = [
  {
    id: 'local-file-diff',
    supports: (item, view) => view === 'diff' && item.availableViews.includes('diff'),
    component: DiffView,
  },
  {
    id: 'local-markdown',
    supports: (item, view) => view === 'rendered' && item.availableViews.includes('rendered'),
    component: MarkdownPreview,
  },
  {
    id: 'local-file-source',
    supports: (item, view) => view === 'source' && item.availableViews.includes('source'),
    component: SourcePreview,
  },
];

export function resolvePreviewRenderer(
  item: LocalFilePreviewItem,
  view: LocalFilePreviewView,
): PreviewRenderer | null {
  return previewRenderers.find((renderer) => renderer.supports(item, view)) ?? null;
}
