<script lang="ts">
  import { Marked } from 'marked';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { PreviewReadTextResult } from '@/core/services/preview-services';
  import type { LocalFilePreviewItem } from '@/types/ui';
  import { openExternalUrl } from '../../lib/gatewayCatalog';
  import {
    isSafeExternalPreviewHref,
    sanitizePreviewMarkdownHtml,
  } from './markdownSecurity';

  let { item }: { item: LocalFilePreviewItem } = $props();
  let loading = $state(false);
  let html = $state('');
  let mtimeMs: number | null = $state(null);
  let size: number | null = $state(null);
  let error: string | null = $state(null);
  let requestVersion = 0;

  function escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    })[character] ?? character);
  }

  const previewMarkdown = new Marked({
    renderer: {
      html: ({ text }) => escapeHtml(text),
      image: ({ text }) => escapeHtml(text),
    },
  });

  async function load(expectedItem: LocalFilePreviewItem): Promise<void> {
    const version = ++requestVersion;
    loading = true;
    html = '';
    mtimeMs = null;
    size = null;
    error = null;
    try {
      const client = await getInitializedUIClient();
      const result = await client.serviceRequest<PreviewReadTextResult>('preview.readLocalText', {
        sessionId: expectedItem.sessionId,
        path: expectedItem.resource.path,
      });
      const rawHtml = await previewMarkdown.parse(result.contentLf);
      if (version !== requestVersion || item.id !== expectedItem.id) return;
      html = sanitizePreviewMarkdownHtml(rawHtml);
      mtimeMs = result.mtimeMs;
      size = result.size;
    } catch (cause) {
      if (version !== requestVersion || item.id !== expectedItem.id) return;
      error = cause instanceof Error ? cause.message : 'The document could not be rendered.';
    } finally {
      if (version === requestVersion && item.id === expectedItem.id) loading = false;
    }
  }

  function handleContentClick(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (!href || !isSafeExternalPreviewHref(href)) return;
    event.preventDefault();
    void openExternalUrl(href);
  }

  $effect(() => {
    const expectedItem = item;
    void load(expectedItem);
    return () => { requestVersion++; };
  });

  function interceptLinks(node: HTMLElement): { destroy: () => void } {
    node.addEventListener('click', handleContentClick);
    return { destroy: () => node.removeEventListener('click', handleContentClick) };
  }
</script>

{#if loading}
  <div class="p-4 text-sm opacity-70" role="status">Rendering current document…</div>
{:else if error}
  <div class="p-4 text-sm" role="alert">
    <p class="m-0 mb-3 text-red-500">{error}</p>
    <button class="rounded border px-3 py-1.5 hover:bg-black/5 dark:hover:bg-white/10" onclick={() => void load(item)}>Retry</button>
  </div>
{:else}
  {#if mtimeMs !== null && size !== null && (mtimeMs !== item.mtimeMs || size !== item.size)}
    <div class="px-4 py-2 bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">Current file has changed since this diff.</div>
  {/if}
  <article class="preview-markdown max-w-none overflow-auto p-6" use:interceptLinks>{@html html}</article>
{/if}

<style>
  .preview-markdown :global(h1), .preview-markdown :global(h2), .preview-markdown :global(h3) { font-weight: var(--font-weight-semibold); margin: 1.2em 0 0.5em; }
  .preview-markdown :global(h1) { font-size: var(--text-3xl); }
  .preview-markdown :global(h2) { font-size: var(--text-2xl); }
  .preview-markdown :global(h3) { font-size: var(--text-xl); }
  .preview-markdown :global(p), .preview-markdown :global(ul), .preview-markdown :global(ol) { margin: 0.75em 0; }
  .preview-markdown :global(ul), .preview-markdown :global(ol) { padding-left: 1.5rem; }
  .preview-markdown :global(pre) { overflow: auto; border-radius: 0.4rem; background: rgba(127, 127, 127, 0.14); padding: 0.8rem; }
  .preview-markdown :global(blockquote) { border-left: 3px solid currentColor; margin-left: 0; padding-left: 1rem; opacity: 0.8; }
  .preview-markdown :global(a) { text-decoration: underline; cursor: pointer; }
  .preview-markdown :global(table) { border-collapse: collapse; }
  .preview-markdown :global(th), .preview-markdown :global(td) { border: 1px solid rgba(127, 127, 127, 0.35); padding: 0.4rem; }
</style>
