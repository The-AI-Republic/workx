<script lang="ts">
  import { uiTheme, themePreference, type UITheme } from '../../stores/themeStore';
  import { isWideMode } from '../../stores/layoutStore';
  import { push } from 'svelte-spa-router';
  import { AgentConfig } from '@/config/AgentConfig';
  import { _t } from '../../lib/i18n';
  import ActiveJobsModule from '../../components/scheduler/ActiveJobsModule.svelte';
  import NewJobModule from '../../components/scheduler/NewJobModule.svelte';
  import JobHistoryModule from '../../components/scheduler/JobHistoryModule.svelte';

  let currentTheme = $state<UITheme>('terminal');
  let wide = $state(false);

  $effect(() => {
    const unsub = uiTheme.subscribe((theme) => {
      currentTheme = theme;
    });
    return unsub;
  });

  $effect(() => {
    const unsub = isWideMode.subscribe((value) => {
      wide = value;
    });
    return unsub;
  });

  // Initialize theme from saved config (same as chat page)
  $effect(() => {
    AgentConfig.getInstance().then((config) => {
      const preferences = config.getConfig().preferences;
      if (preferences?.uiTheme) {
        themePreference.initialize(preferences.uiTheme);
      }
    });
  });
</script>

<div class="h-screen overflow-y-auto {currentTheme}
  {currentTheme === 'modern'
    ? 'font-chat bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
    : 'font-terminal bg-term-bg text-term-green'}">

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
    <div class="ml-auto">
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded cursor-pointer transition-all duration-200
          {currentTheme === 'modern'
            ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'bg-transparent border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
        on:click={() => push('/scheduler/calendar')}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
        {$_t('Calendar View')}
      </button>
    </div>
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
