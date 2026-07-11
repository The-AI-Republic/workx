<script lang="ts">
  /**
   * DiffView (WORKXOS-7) — read-only themed renderer for a unified diff.
   *
   * Parsing lives in `lib/diffParse.ts` (unit-tested, DOM-free); this component
   * only styles the parsed hunks with the app's `terminal`/`modern` theme
   * tokens so the diff matches the rest of the chat UI. No stage/revert — the
   * first cut is preview-only, per the design (Phase 1).
   */
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { parseUnifiedDiff } from '../../lib/diffParse';

  let { diff }: { diff: string } = $props();

  let currentTheme = $derived($uiTheme);
  let files = $derived(parseUnifiedDiff(diff));
</script>

{#if files.length === 0}
  <div class="p-3 text-sm {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
    {$_t('No changes to display')}
  </div>
{:else}
  <div class="font-mono text-xs leading-relaxed">
    {#each files as file (file.path)}
      <div class="mb-4">
        <div class="px-3 py-1.5 font-semibold sticky top-0 z-1
          {currentTheme === 'modern'
            ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border-b border-chat-border dark:border-chat-border-dark'
            : 'bg-term-bg text-term-bright-green border-b border-term-dim-green'}">
          <span class="opacity-90">{file.path}</span>
          <span class="ml-2 font-normal
            {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
            <span class="text-green-500">+{file.additions}</span>
            <span class="text-red-500">−{file.deletions}</span>
          </span>
        </div>
        {#each file.hunks as hunk, hi (hi)}
          <div class="px-3 py-0.5 select-none
            {currentTheme === 'modern'
              ? 'text-chat-primary dark:text-chat-primary-dark bg-chat-surface/60 dark:bg-chat-surface-dark/60'
              : 'text-term-blue bg-[rgba(96,165,250,0.08)]'}">
            {hunk.header}
          </div>
          {#each hunk.lines as line, li (li)}
            {#if line.type === 'meta'}
              <div class="px-3 py-0.5 italic opacity-70
                {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                {line.text}
              </div>
            {:else}
              <div class="flex whitespace-pre-wrap break-all
                {line.type === 'add'
                  ? (currentTheme === 'modern' ? 'bg-green-500/10 text-green-700 dark:text-green-300' : 'bg-[rgba(34,197,94,0.12)] text-term-bright-green')
                  : line.type === 'del'
                    ? (currentTheme === 'modern' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-[rgba(239,68,68,0.12)] text-red-400')
                    : (currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green')}">
                <span class="w-4 shrink-0 text-center opacity-60 select-none">
                  {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}
                </span>
                <span class="flex-1">{line.text || ' '}</span>
              </div>
            {/if}
          {/each}
        {/each}
      </div>
    {/each}
  </div>
{/if}
