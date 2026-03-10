<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { SidePanelThread } from '../../stores/threadStore';
  import { uiTheme, type UITheme } from '../../stores/themeStore';

  export let thread: SidePanelThread;
  export let isActive: boolean = false;
  export let showClose: boolean = true;

  let currentTheme: UITheme = 'terminal';

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onDestroy(unsubTheme);

  const dispatch = createEventDispatcher<{
    select: { sessionId: string };
    close: { sessionId: string };
  }>();

  $: displayTitle = thread.title.length > 20 ? thread.title.substring(0, 20) + '...' : thread.title;

  function handleSelect() {
    dispatch('select', { sessionId: thread.sessionId });
  }

  function handleClose(event: MouseEvent) {
    event.stopPropagation();
    dispatch('close', { sessionId: thread.sessionId });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSelect();
    }
  }

  function handleCloseKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      dispatch('close', { sessionId: thread.sessionId });
    }
  }
</script>

<div
  class="flex items-center gap-1 min-w-[80px] max-w-[180px] h-10 text-xs cursor-pointer select-none
    border border-b-0 border-transparent rounded-t bg-transparent transition-colors duration-150
    {currentTheme === 'modern'
      ? isActive
        ? 'font-chat px-3 py-2 rounded-t-lg border-chat-border dark:border-chat-border-dark bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark border-b border-b-chat-bg dark:border-b-chat-bg-dark -mb-px'
        : 'font-chat px-3 py-2 rounded-t-lg text-chat-text-secondary dark:text-chat-text-secondary-dark hover:bg-chat-surface dark:hover:bg-chat-surface-dark hover:border-chat-border dark:hover:border-chat-border-dark'
      : isActive
        ? 'font-terminal px-2 py-1.5 border-term-dim-green bg-term-bg text-term-bright-green border-b border-b-term-bg -mb-px'
        : 'font-terminal px-2 py-1.5 text-term-dim-green hover:bg-term-green/5 hover:border-term-dim-green'}"
  role="tab"
  tabindex="0"
  aria-selected={isActive}
  title={thread.title}
  on:click={handleSelect}
  on:keydown={handleKeydown}
>
  <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{displayTitle}</span>
  {#if showClose}
    <button
      class="flex items-center justify-center w-4 h-4 p-0 border-none bg-transparent cursor-pointer rounded-sm transition-opacity duration-150
        {isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'}
        {currentTheme === 'modern'
          ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark hover:!opacity-100 hover:bg-chat-error/10 dark:hover:bg-chat-error-dark/10 hover:text-chat-error dark:hover:text-chat-error-dark'
          : 'text-term-dim-green hover:!opacity-100 hover:bg-term-red/20 hover:text-term-red'}"
      aria-label="Close thread"
      on:click={handleClose}
      on:keydown={handleCloseKeydown}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  {/if}
</div>

<style>
  /* Show close button on tab hover */
  div:hover button {
    opacity: 0.7;
  }
</style>
