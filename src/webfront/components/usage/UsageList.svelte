<script lang="ts">
  import type { SessionUsageSummary } from '@/storage/types';
  import { _t } from '../../lib/i18n';

  export let summaries: SessionUsageSummary[] = [];
  export let modelSummaries: Record<string, { total_tokens: number; taskCount: number }> = {};
  export let groupByModel: boolean = false;
  export let theme: string = 'modern';

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function fmt(n: number): string {
    return n.toLocaleString();
  }

  $: modelEntries = Object.entries(modelSummaries).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
</script>

{#if groupByModel && modelEntries.length > 0}
  <!-- Model grouping view -->
  <div class="flex flex-col gap-2">
    {#each modelEntries as [model, stats]}
      <div class="px-3 py-2.5 rounded
        {theme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark'
          : 'border border-term-dim-green bg-[rgba(0,255,0,0.03)]'}">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium
            {theme === 'modern'
              ? 'text-chat-text dark:text-chat-text-dark font-chat'
              : 'text-term-green font-terminal'}">{model}</span>
          <span class="text-xs
            {theme === 'modern'
              ? 'text-chat-muted dark:text-chat-muted-dark font-chat'
              : 'text-term-dim-green font-terminal'}">{fmt(stats.total_tokens)} tokens &middot; {stats.taskCount} {$_t('tasks')}</span>
        </div>
      </div>
    {/each}
  </div>
{:else if summaries.length === 0}
  <div class="py-8 text-center text-sm
    {theme === 'modern'
      ? 'text-chat-muted dark:text-chat-muted-dark font-chat'
      : 'text-term-dim-green font-terminal'}">
    {$_t('No usage data yet')}
  </div>
{:else}
  <!-- Session list view -->
  <div class="flex flex-col gap-2">
    {#each summaries as session}
      <div class="px-3 py-2.5 rounded
        {theme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark'
          : 'border border-term-dim-green bg-[rgba(0,255,0,0.03)]'}">
        <!-- Row 1: date/time, model, task count -->
        <div class="flex items-center justify-between mb-1">
          <span class="text-sm
            {theme === 'modern'
              ? 'text-chat-text dark:text-chat-text-dark font-chat'
              : 'text-term-green font-terminal'}">
            {formatDate(session.lastTimestamp)} {formatTime(session.lastTimestamp)}
          </span>
          <span class="text-xs
            {theme === 'modern'
              ? 'text-chat-muted dark:text-chat-muted-dark font-chat'
              : 'text-term-dim-green font-terminal'}">
            {session.models[0] || 'unknown'} &middot; {session.taskCount} {$_t('tasks')} &middot; {session.turn_count} {$_t('turns')}
          </span>
        </div>
        <!-- Row 2: token totals -->
        <div class="text-xs
          {theme === 'modern'
            ? 'text-chat-muted dark:text-chat-muted-dark font-chat'
            : 'text-term-dim-green font-terminal'}">
          <span class="font-medium
            {theme === 'modern'
              ? 'text-chat-text dark:text-chat-text-dark'
              : 'text-term-green'}">{fmt(session.total_tokens)}</span> total
          &middot; {fmt(session.input_tokens)} in
          &middot; {fmt(session.output_tokens)} out
          {#if session.cached_input_tokens > 0}
            &middot; {fmt(session.cached_input_tokens)} cached
          {/if}
          {#if session.reasoning_output_tokens > 0}
            &middot; {fmt(session.reasoning_output_tokens)} reasoning
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
