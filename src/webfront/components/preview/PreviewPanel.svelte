<script lang="ts">
  /**
   * PreviewPanel (WORKXOS-7) — the chat's right-hand artifact preview surface.
   *
   * Lists every file the agent changed this session (auto-populated by
   * `previewStore`) and renders the selected one with a type-appropriate viewer:
   * rendered markdown (reusing `marked`, as `MessageDisplay` does), a themed
   * diff (`DiffView`), or plain text/code — with a metadata fallback when only a
   * path is known. Read-only by design (Phase 1); the webview/image/history
   * viewers are future phases.
   *
   * Layout-agnostic: fills its container (`h-full`). The chat page decides
   * whether that container is a docked wide-mode column or a narrow-mode
   * slide-in overlay.
   */
  import { marked } from 'marked';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import {
    previewStore,
    activeArtifacts,
    selectedArtifact,
  } from '../../stores/previewStore';
  import type { ArtifactRecord } from '@/types/ui';
  import DiffView from './DiffView.svelte';

  let { onClose = () => previewStore.close() }: { onClose?: () => void } = $props();

  let currentTheme = $derived($uiTheme);

  // Markdown docs default to the rendered view with a raw-source toggle.
  let showSource = $state(false);
  let copied = $state(false);

  function basename(path: string): string {
    return path.split('/').pop() || path;
  }
  function dirname(path: string): string {
    const i = path.lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : '';
  }

  function badge(change: ArtifactRecord['change']): { label: string; cls: string } {
    switch (change) {
      case 'added': return { label: 'A', cls: 'text-green-500' };
      case 'deleted': return { label: 'D', cls: 'text-red-500' };
      case 'read': return { label: 'R', cls: 'opacity-60' };
      default: return { label: 'M', cls: 'text-amber-500' };
    }
  }

  function icon(kind: ArtifactRecord['kind']): string {
    switch (kind) {
      case 'markdown': return '📄';
      case 'code': return '📝';
      case 'diff': return '±';
      case 'image': return '🖼️';
      case 'csv': return '▦';
      case 'text': return '📃';
      default: return '📎';
    }
  }

  // Which viewer to use for the selected artifact.
  type ViewMode = 'markdown' | 'diff' | 'code' | 'empty';
  let viewMode = $derived.by<ViewMode>(() => {
    const a = $selectedArtifact;
    if (!a) return 'empty';
    if (a.kind === 'markdown' && a.content && !showSource) return 'markdown';
    if (a.diff) return 'diff';
    if (a.content) return 'code';
    if (a.kind === 'markdown' && a.content) return 'code'; // source view
    return 'empty';
  });

  function renderMarkdown(text: string): string {
    return marked.parse(text, {
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false,
    }) as string;
  }

  async function copyPath() {
    const a = $selectedArtifact;
    if (!a) return;
    try {
      await navigator.clipboard.writeText(a.path);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  }

  // Reset the source toggle whenever the selected file changes.
  let lastId = $state('');
  $effect(() => {
    const a = $selectedArtifact;
    if (a && a.id !== lastId) {
      lastId = a.id;
      showSource = false;
    }
  });
</script>

<div class="h-full flex flex-col min-h-0 overflow-hidden
  {currentTheme === 'modern'
    ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
    : 'bg-term-bg text-term-green'}">
  <!-- Header -->
  <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b
    {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
    <span class="font-semibold text-sm">{$_t('Preview')}</span>
    <button
      class="p-1 rounded cursor-pointer text-lg leading-none opacity-70 hover:opacity-100
        {currentTheme === 'modern' ? 'hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark' : 'hover:bg-term-green/10'}"
      onclick={onClose}
      aria-label={$_t('Close preview')}
      title={$_t('Close preview')}
    >×</button>
  </div>

  <!-- Artifact list -->
  <div class="shrink-0 max-h-40 overflow-y-auto border-b
    {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
    {#each $activeArtifacts as art (art.id)}
      {@const b = badge(art.change)}
      <button
        class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm cursor-pointer transition-colors
          {$selectedArtifact?.id === art.id
            ? (currentTheme === 'modern' ? 'bg-chat-surface dark:bg-chat-surface-dark' : 'bg-term-green/10')
            : (currentTheme === 'modern' ? 'hover:bg-chat-surface/60 dark:hover:bg-chat-surface-dark/60' : 'hover:bg-term-green/5')}"
        onclick={() => previewStore.select(art.path)}
        title={art.path}
      >
        <span class="shrink-0">{icon(art.kind)}</span>
        <span class="shrink-0 font-mono font-bold text-xs {b.cls}">{b.label}</span>
        <span class="truncate flex-1">{basename(art.path)}</span>
        {#if art.summary}
          <span class="shrink-0 text-xs font-mono opacity-60">{art.summary}</span>
        {/if}
      </button>
    {/each}
  </div>

  <!-- Viewer toolbar -->
  {#if $selectedArtifact}
    <div class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs border-b
      {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark text-chat-text-muted dark:text-chat-text-muted-dark' : 'border-term-dim-green text-term-dim-green'}">
      <span class="truncate flex-1 font-mono" title={$selectedArtifact.path}>
        {dirname($selectedArtifact.path)}{dirname($selectedArtifact.path) ? '/' : ''}<span class="font-semibold {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}">{basename($selectedArtifact.path)}</span>
      </span>
      {#if $selectedArtifact.kind === 'markdown' && $selectedArtifact.content}
        <button
          class="shrink-0 px-1.5 py-0.5 rounded cursor-pointer hover:opacity-100 opacity-80
            {currentTheme === 'modern' ? 'hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark' : 'hover:bg-term-green/10'}"
          onclick={() => (showSource = !showSource)}
        >{showSource ? $_t('Rendered') : $_t('Source')}</button>
      {/if}
      <button
        class="shrink-0 px-1.5 py-0.5 rounded cursor-pointer hover:opacity-100 opacity-80
          {currentTheme === 'modern' ? 'hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark' : 'hover:bg-term-green/10'}"
        onclick={copyPath}
      >{copied ? $_t('Copied') : $_t('Copy path')}</button>
    </div>
  {/if}

  <!-- Viewer body -->
  <div class="flex-1 min-h-0 overflow-auto">
    {#if viewMode === 'markdown'}
      <div class="preview-markdown px-4 py-3 text-sm leading-relaxed">
        {@html renderMarkdown($selectedArtifact!.content!)}
      </div>
    {:else if viewMode === 'diff'}
      <DiffView diff={$selectedArtifact!.diff!} />
    {:else if viewMode === 'code'}
      <pre class="px-4 py-3 text-xs font-mono whitespace-pre-wrap break-words">{$selectedArtifact!.content}</pre>
    {:else}
      <div class="flex flex-col items-center justify-center h-full gap-2 p-6 text-center text-sm
        {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
        {#if $selectedArtifact}
          <span class="text-2xl">{icon($selectedArtifact.kind)}</span>
          <span class="font-mono">{basename($selectedArtifact.path)}</span>
          <span>{$_t('No inline preview available for this file yet.')}</span>
        {:else}
          <span>{$_t('The agent hasn\'t changed any files yet.')}</span>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Lightweight, theme-neutral markdown styling for the preview viewer. */
  .preview-markdown :global(h1),
  .preview-markdown :global(h2),
  .preview-markdown :global(h3) {
    font-weight: 600;
    margin: 0.6em 0 0.3em;
    line-height: 1.25;
  }
  .preview-markdown :global(h1) { font-size: 1.35em; }
  .preview-markdown :global(h2) { font-size: 1.2em; }
  .preview-markdown :global(h3) { font-size: 1.08em; }
  .preview-markdown :global(p) { margin: 0.5em 0; }
  .preview-markdown :global(ul),
  .preview-markdown :global(ol) { margin: 0.5em 0; padding-left: 1.4em; }
  .preview-markdown :global(li) { margin: 0.2em 0; }
  .preview-markdown :global(code) {
    font-family: monospace;
    font-size: 0.9em;
    padding: 0.1em 0.3em;
    border-radius: 3px;
    background: rgba(127, 127, 127, 0.15);
  }
  .preview-markdown :global(pre) {
    padding: 0.7em;
    border-radius: 6px;
    overflow-x: auto;
    background: rgba(127, 127, 127, 0.12);
  }
  .preview-markdown :global(pre code) { background: transparent; padding: 0; }
  .preview-markdown :global(a) { text-decoration: underline; }
  .preview-markdown :global(table) { border-collapse: collapse; margin: 0.5em 0; }
  .preview-markdown :global(th),
  .preview-markdown :global(td) {
    border: 1px solid rgba(127, 127, 127, 0.3);
    padding: 0.3em 0.6em;
  }
  .preview-markdown :global(blockquote) {
    border-left: 3px solid rgba(127, 127, 127, 0.4);
    margin: 0.5em 0;
    padding-left: 0.8em;
    opacity: 0.85;
  }
</style>
