<script lang="ts">
  import type { LocalFilePreviewItem } from '@/types/ui';
  import { rowsForUnifiedDiff } from './diffModel';

  let { item }: { item: LocalFilePreviewItem } = $props();

  let parsed = $derived(rowsForUnifiedDiff(item.unifiedDiff ?? ''));
</script>

{#if parsed.rawFallback}
  <div class="h-full overflow-auto bg-[#0d1117] p-4 text-[#c9d1d9] font-mono text-xs">
    <div class="mb-3 text-amber-300" role="status">{parsed.error}</div>
    <pre class="m-0 whitespace-pre">{parsed.rawFallback}</pre>
  </div>
{:else if parsed.error}
  <div class="p-4 text-sm opacity-70" role="status">{parsed.error}</div>
{:else}
  <div class="h-full overflow-auto bg-[#0d1117] text-[#c9d1d9] font-mono text-xs" aria-label={`Diff for ${item.resource.path}`}>
    <table class="min-w-full border-collapse">
      <tbody>
        {#each parsed.rows as row (row.key)}
          <tr class:diff-addition={row.kind === 'addition'} class:diff-deletion={row.kind === 'deletion'} class:diff-header={row.kind === 'header'}>
            <td class="select-none w-10 px-2 text-right align-top text-[#6e7681] border-r border-[#30363d]">{row.oldLine ?? ''}</td>
            <td class="select-none w-10 px-2 text-right align-top text-[#6e7681] border-r border-[#30363d]">{row.newLine ?? ''}</td>
            <td class="select-none w-5 pl-2 align-top">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : row.kind === 'note' ? '\\' : ''}</td>
            <td class="max-w-0 pr-4 whitespace-pre-wrap break-all align-top">{row.text || ' '}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .diff-addition { background: rgba(46, 160, 67, 0.22); }
  .diff-deletion { background: rgba(248, 81, 73, 0.22); }
  .diff-header { background: rgba(56, 139, 253, 0.18); color: #a5d6ff; }
</style>
