<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import ThreadTab from './ThreadTab.svelte';
  import { threadStore } from '../../stores/threadStore';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import Tooltip from '../common/Tooltip.svelte';

  export let canCreateThread: boolean = true;
  export let maxSessionsReached: boolean = false;

  let currentTheme: UITheme = 'terminal';

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onDestroy(unsubTheme);

  const dispatch = createEventDispatcher<{
    threadSelect: { sessionId: string };
    threadClose: { sessionId: string };
    newThread: void;
  }>();

  $: threads = $threadStore.threads;
  $: activeSessionId = $threadStore.activeSessionId;

  function handleThreadSelect(event: CustomEvent<{ sessionId: string }>) {
    dispatch('threadSelect', { sessionId: event.detail.sessionId });
  }

  function handleThreadClose(event: CustomEvent<{ sessionId: string }>) {
    dispatch('threadClose', { sessionId: event.detail.sessionId });
  }

  function handleNewThread() {
    if (canCreateThread && !maxSessionsReached) {
      dispatch('newThread');
    }
  }

  function handleNewThreadKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleNewThread();
    }
  }
</script>

<div
  class="flex items-end gap-0.5 px-2 mb-1.5 bg-transparent min-h-[40px] overflow-x-auto overflow-y-hidden border-b
    {currentTheme === 'modern'
      ? 'px-3 border-chat-border dark:border-chat-border-dark'
      : 'border-term-dim-green'}"
  role="tablist"
  aria-label="Conversation threads"
>
  <div class="flex items-end gap-0.5 flex-1 min-w-0">
    {#each threads as thread (thread.sessionId)}
      <ThreadTab
        {thread}
        isActive={thread.sessionId === activeSessionId}
        showClose={threads.length > 1}
        on:select={handleThreadSelect}
        on:close={handleThreadClose}
      />
    {/each}
  </div>

  <Tooltip
    content={maxSessionsReached ? 'Maximum threads reached' : 'New Thread'}
    disabled={false}
  >
    <button
      class="flex items-center justify-center w-9 h-9 p-0 mb-1 border border-transparent bg-transparent cursor-pointer shrink-0 transition-colors duration-150
        {!canCreateThread || maxSessionsReached ? 'opacity-40 cursor-not-allowed' : ''}
        {currentTheme === 'modern'
          ? 'rounded-md text-chat-text-secondary dark:text-chat-text-secondary-dark hover:not-disabled:bg-chat-button-hover hover:not-disabled:dark:bg-chat-button-hover-dark hover:not-disabled:border-chat-border hover:not-disabled:dark:border-chat-border-dark hover:not-disabled:text-chat-text hover:not-disabled:dark:text-chat-text-dark'
          : 'rounded text-term-dim-green hover:not-disabled:bg-term-green/10 hover:not-disabled:border-term-dim-green hover:not-disabled:text-term-bright-green'}"
      aria-label="New thread"
      on:click={handleNewThread}
      on:keydown={handleNewThreadKeydown}
      disabled={!canCreateThread || maxSessionsReached}
    >
      <svg width="18" height="18" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  </Tooltip>
</div>
