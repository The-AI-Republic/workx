<script lang="ts">
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { usageStore } from '../../stores/usageStore';
  import UsageList from '../../components/usage/UsageList.svelte';
  import UsageChart from '../../components/usage/UsageChart.svelte';
  import { formatCost } from '@/core/models/cost/cost';

  let currentTheme = $derived($uiTheme);
  let loading = $derived($usageStore.loading);
  let error = $derived($usageStore.error);
  let sessionSummaries = $derived($usageStore.sessionSummaries);
  let dailySummaries = $derived($usageStore.dailySummaries);
  let modelSummaries = $derived($usageStore.modelSummaries);
  let groupByModel = $derived($usageStore.groupByModel);

  // Track 18: total USD across all loaded sessions, for the /cost surface.
  let totalCostUSD = $derived(sessionSummaries.reduce((s, x) => s + (x.costUSD ?? 0), 0));
  let anyCostEstimated = $derived(sessionSummaries.some((x) => x.costEstimated));

  $effect(() => {
    usageStore.loadAll();
  });
</script>

<div class="h-full overflow-y-auto {currentTheme}
  {currentTheme === 'modern'
    ? 'bg-chat-bg dark:bg-chat-bg-dark'
    : 'bg-term-bg'}">

  <!-- Page Header -->
  <div class="px-4 py-3 flex items-center gap-2
    {currentTheme === 'modern'
      ? 'border-b border-chat-border dark:border-chat-border-dark'
      : 'border-b border-term-dim-green'}">
    <svg class="w-5 h-5 {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="12" width="4" height="9" rx="1"></rect>
      <rect x="10" y="7" width="4" height="14" rx="1"></rect>
      <rect x="17" y="3" width="4" height="18" rx="1"></rect>
    </svg>
    <h1 class="m-0 text-base font-semibold
      {currentTheme === 'modern'
        ? 'text-chat-text dark:text-chat-text-dark font-chat'
        : 'text-term-green font-terminal'}">{$_t('Token Usage')}</h1>
    <div class="ml-auto flex items-center gap-2">
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded cursor-pointer transition-all duration-200
          {currentTheme === 'modern'
            ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'bg-transparent border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}
          {groupByModel ? 'ring-1 ring-current' : ''}"
        onclick={() => usageStore.toggleGroupByModel()}
      >
        {$_t('By Model')}
      </button>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded cursor-pointer transition-all duration-200
          {currentTheme === 'modern'
            ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'bg-transparent border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
        onclick={() => usageStore.refresh()}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 4v6h6"></path>
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
        </svg>
        {$_t('Refresh')}
      </button>
    </div>
  </div>

  <!-- Content -->
  <div class="p-4 flex flex-col gap-4">
    {#if loading}
      <div class="py-8 text-center text-sm
        {currentTheme === 'modern'
          ? 'text-chat-muted dark:text-chat-muted-dark font-chat'
          : 'text-term-dim-green font-terminal'}">
        {$_t('Loading...')}
      </div>
    {:else if error}
      <div class="py-4 text-center text-sm
        {currentTheme === 'modern'
          ? 'text-red-500 font-chat'
          : 'text-red-400 font-terminal'}">
        {error}
      </div>
    {:else if sessionSummaries.length === 0}
      <div class="py-12 text-center
        {currentTheme === 'modern'
          ? 'text-chat-muted dark:text-chat-muted-dark font-chat'
          : 'text-term-dim-green font-terminal'}">
        <svg class="w-10 h-10 mx-auto mb-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="12" width="4" height="9" rx="1"></rect>
          <rect x="10" y="7" width="4" height="14" rx="1"></rect>
          <rect x="17" y="3" width="4" height="18" rx="1"></rect>
        </svg>
        <p class="text-sm font-medium mb-1">{$_t('No usage data yet')}</p>
        <p class="text-xs opacity-70">{$_t('Token usage will appear here after running tasks')}</p>
      </div>
    {:else}
      <!-- Track 18: total cost summary -->
      <div class="px-3 py-2.5 rounded flex items-baseline justify-between
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark'
          : 'border border-term-dim-green bg-[rgba(0,255,0,0.03)]'}">
        <span class="text-xs uppercase tracking-wide
          {currentTheme === 'modern'
            ? 'text-chat-muted dark:text-chat-muted-dark font-chat'
            : 'text-term-dim-green font-terminal'}">{$_t('Total cost')}</span>
        <span class="text-lg font-semibold
          {currentTheme === 'modern'
            ? 'text-chat-text dark:text-chat-text-dark font-chat'
            : 'text-term-green font-terminal'}">{formatCost(totalCostUSD)}{#if anyCostEstimated}<span class="text-xs font-normal opacity-70"> &middot; {$_t('≈ estimated')}</span>{/if}</span>
      </div>

      <!-- Daily Chart -->
      {#if dailySummaries.length > 0}
        <div class="h-[300px]">
          <UsageChart {dailySummaries} theme={currentTheme} />
        </div>
      {/if}

      <!-- Session / Model List -->
      <UsageList
        summaries={sessionSummaries}
        {modelSummaries}
        {groupByModel}
        theme={currentTheme}
      />
    {/if}
  </div>
</div>
