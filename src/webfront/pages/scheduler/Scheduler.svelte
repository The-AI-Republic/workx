<script lang="ts">
  import { onDestroy } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { isWideMode } from '../../stores/layoutStore';
  import { _t } from '../../lib/i18n';
  import ActiveJobsModule from '../../components/scheduler/ActiveJobsModule.svelte';
  import NewJobModule from '../../components/scheduler/NewJobModule.svelte';
  import JobHistoryModule from '../../components/scheduler/JobHistoryModule.svelte';

  let currentTheme: UITheme = 'terminal';
  let wide = false;

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  const unsubWide = isWideMode.subscribe((value) => {
    wide = value;
  });

  onDestroy(() => {
    unsubTheme();
    unsubWide();
  });
</script>

<div class="h-screen overflow-y-auto {currentTheme}
  {currentTheme === 'modern'
    ? 'bg-chat-bg dark:bg-chat-bg-dark'
    : 'bg-term-bg'}">

  <!-- Page Header -->
  <div class="px-4 py-3 flex items-center gap-2
    {currentTheme === 'modern'
      ? 'border-b border-chat-border dark:border-chat-border-dark'
      : 'border-b border-term-dim-green'}">
    <svg class="w-5 h-5 {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
    <h1 class="m-0 text-base font-semibold
      {currentTheme === 'modern'
        ? 'text-chat-text dark:text-chat-text-dark font-chat'
        : 'text-term-green font-terminal'}">{$_t('Scheduler')}</h1>
  </div>

  <!-- Modules Layout -->
  {#if wide}
    <!-- Wide mode: 3-column grid -->
    <div class="grid grid-cols-3 gap-4 p-4 h-[calc(100vh-52px)]">
      <div class="overflow-y-auto">
        <ActiveJobsModule collapsible={false} initialExpanded={true} />
      </div>
      <div class="overflow-y-auto">
        <NewJobModule collapsible={false} initialExpanded={true} />
      </div>
      <div class="overflow-y-auto">
        <JobHistoryModule collapsible={false} initialExpanded={true} />
      </div>
    </div>
  {:else}
    <!-- Narrow mode: vertical stack with collapsible sections -->
    <div class="flex flex-col gap-3 p-3">
      <NewJobModule collapsible={true} initialExpanded={true} />
      <ActiveJobsModule collapsible={true} initialExpanded={true} />
      <JobHistoryModule collapsible={true} initialExpanded={false} />
    </div>
  {/if}
</div>
