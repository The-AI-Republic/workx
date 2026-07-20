<script lang="ts">
  import type {
    LocalFilePreviewView,
    ThreadPreviewState,
  } from '@/types/ui';
  import { resolvePreviewRenderer } from './renderers';

  let {
    state,
    theme = 'modern',
    onClose,
    onSelectItem,
    onSelectView,
  }: {
    state: ThreadPreviewState;
    theme?: 'modern' | 'terminal';
    onClose: () => void;
    onSelectItem: (itemId: string) => void;
    onSelectView: (view: LocalFilePreviewView) => void;
  } = $props();

  let selectedItem = $derived(
    state.items.find((item) => item.id === state.selectedItemId) ?? state.items[0] ?? null,
  );
  let selectedView = $derived(state.selectedView ?? selectedItem?.availableViews[0] ?? null);
  let renderer = $derived(
    selectedItem && selectedView ? resolvePreviewRenderer(selectedItem, selectedView) : null,
  );

  const viewLabels: Record<LocalFilePreviewView, string> = {
    diff: 'Diff',
    rendered: 'Rendered',
    source: 'Source',
  };

  const omissionLabels = {
    input_too_large: 'Diff omitted because the changed file was too large to compare.',
    diff_too_large: 'Diff omitted because the generated patch exceeded the preview limit.',
    generation_failed: 'Diff generation failed; the current source is still available.',
  } as const;

  function operationTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<section
  class="flex h-full min-h-0 flex-col
    {theme === 'terminal'
      ? 'bg-black text-term-green'
      : 'bg-white text-gray-900 dark:bg-[#111318] dark:text-gray-100'}"
  aria-label="Local file preview"
>
  <header class="shrink-0 border-b px-3 py-3 {theme === 'terminal' ? 'border-term-dim-green' : 'border-gray-200 dark:border-gray-700'}">
    <div class="flex items-center justify-between gap-3">
      <h2 class="m-0 text-sm font-semibold">Preview</h2>
      <button data-preview-close type="button" class="rounded px-2 py-1 text-lg leading-none opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" onclick={onClose} aria-label="Close preview">×</button>
    </div>
    {#if state.items.length}
      <label class="mt-2 block">
        <span class="sr-only">Previewed file change</span>
        <select
          class="w-full truncate rounded border bg-transparent px-2 py-1.5 text-sm {theme === 'terminal' ? 'border-term-dim-green' : 'border-gray-300 dark:border-gray-600'}"
          value={selectedItem?.id ?? ''}
          onchange={(event) => onSelectItem(event.currentTarget.value)}
        >
          {#each state.items as item (item.id)}
            <option value={item.id}>{item.operation === 'created' ? 'Created' : 'Modified'} · {item.resource.path} · {operationTime(item.createdAt)}</option>
          {/each}
        </select>
      </label>
    {/if}
  </header>

  {#if selectedItem}
    <div class="shrink-0 border-b px-3 pt-2 {theme === 'terminal' ? 'border-term-dim-green' : 'border-gray-200 dark:border-gray-700'}">
      <div class="flex items-center justify-between gap-3 pb-2 text-xs opacity-70">
        <span class="truncate" title={selectedItem.resource.path}>{selectedItem.resource.path}</span>
        <span class="shrink-0">{operationTime(selectedItem.createdAt)}</span>
      </div>
      {#if selectedItem.diffOmittedReason}
        <div class="mb-2 rounded px-2 py-1.5 text-xs {theme === 'terminal' ? 'bg-term-yellow/10 text-term-yellow' : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'}" role="status">
          {omissionLabels[selectedItem.diffOmittedReason]}
        </div>
      {/if}
      <div class="flex gap-1" role="tablist" aria-label="Preview view">
        {#each selectedItem.availableViews as view (view)}
          <button
            type="button"
            role="tab"
            aria-selected={selectedView === view}
            class="border-b-2 px-3 py-2 text-sm {selectedView === view
              ? (theme === 'terminal' ? 'border-term-bright-green text-term-bright-green' : 'border-blue-500 text-blue-600 dark:text-blue-300')
              : 'border-transparent opacity-65 hover:opacity-100'}"
            onclick={() => onSelectView(view)}
          >{viewLabels[view]}</button>
        {/each}
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      {#if renderer}
        {@const Renderer = renderer.component}
        <Renderer item={selectedItem} />
      {:else}
        <div class="p-4 text-sm opacity-70">This preview view is unavailable.</div>
      {/if}
    </div>
  {:else}
    <div class="flex flex-1 items-center justify-center p-6 text-center text-sm opacity-65">Local file changes will appear here.</div>
  {/if}
</section>
