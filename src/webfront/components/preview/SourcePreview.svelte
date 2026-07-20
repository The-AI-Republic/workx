<script lang="ts">
  import { getInitializedUIClient } from '@/core/messaging';
  import type { PreviewReadTextResult } from '@/core/services/preview-services';
  import type { LocalFilePreviewItem } from '@/types/ui';

  const MAX_SOURCE_LINES = 10_000;
  let { item }: { item: LocalFilePreviewItem } = $props();
  let loading = $state(false);
  let result: PreviewReadTextResult | null = $state(null);
  let error: string | null = $state(null);
  let requestVersion = 0;

  async function load(expectedItem: LocalFilePreviewItem): Promise<void> {
    const version = ++requestVersion;
    loading = true;
    result = null;
    error = null;
    try {
      const client = await getInitializedUIClient();
      const next = await client.serviceRequest<PreviewReadTextResult>('preview.readLocalText', {
        sessionId: expectedItem.sessionId,
        path: expectedItem.resource.path,
      });
      if (version !== requestVersion || item.id !== expectedItem.id) return;
      result = next;
    } catch (cause) {
      if (version !== requestVersion || item.id !== expectedItem.id) return;
      error = cause instanceof Error ? cause.message : 'The file could not be loaded.';
    } finally {
      if (version === requestVersion && item.id === expectedItem.id) loading = false;
    }
  }

  $effect(() => {
    const expectedItem = item;
    void load(expectedItem);
    return () => { requestVersion++; };
  });

  let lines = $derived((result?.contentLf ?? '').split('\n'));
  let largeSource = $derived(lines.length > MAX_SOURCE_LINES);
</script>

{#if loading}
  <div class="p-4 text-sm opacity-70" role="status">Loading current file…</div>
{:else if error}
  <div class="p-4 text-sm" role="alert">
    <p class="m-0 mb-3 text-red-500">{error}</p>
    <button class="rounded border px-3 py-1.5 hover:bg-black/5 dark:hover:bg-white/10" onclick={() => void load(item)}>Retry</button>
  </div>
{:else if result}
  <div class="flex h-full min-h-0 flex-col bg-[#0d1117] text-[#c9d1d9] font-mono text-xs" aria-label={`Source for ${item.resource.path}`}>
    <div class="flex shrink-0 items-center justify-between gap-3 border-b border-[#30363d] px-3 py-2">
      <span class="truncate" title={item.resource.path}>{item.resource.path}</span>
      <span class="shrink-0 text-[#8b949e]">{result.size.toLocaleString()} bytes</span>
    </div>
    {#if result.mtimeMs !== item.mtimeMs || result.size !== item.size}
      <div class="shrink-0 px-3 py-2 bg-amber-950 text-amber-200" role="status">Current file has changed since this diff.</div>
    {/if}
    <div class="min-h-0 flex-1 overflow-auto">
      {#if largeSource}
        <div class="sticky top-0 z-10 bg-amber-950 px-3 py-2 text-amber-200" role="status">
          Line numbers are hidden because this file exceeds {MAX_SOURCE_LINES.toLocaleString()} lines.
        </div>
        <pre class="m-0 whitespace-pre-wrap break-all p-3">{result.contentLf}</pre>
      {:else}
        <table class="min-w-full border-collapse">
          <tbody>
            {#each lines as line, index (index)}
              <tr>
                <td class="select-none w-12 px-2 text-right align-top text-[#6e7681] border-r border-[#30363d]">{index + 1}</td>
                <td class="max-w-0 px-3 whitespace-pre-wrap break-all align-top">{line || ' '}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </div>
{/if}
