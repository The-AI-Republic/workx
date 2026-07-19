<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { ThreadListItem } from '@/core/registry/types';
  import { documentSurfaceId, threadStore } from '../../stores/threadStore';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import LeftPanelSection from './LeftPanelSection.svelte';

  const PAGE_SIZE = 10;
  const MS_PER_HOUR = 60 * 60 * 1000;
  let error: string | null = $state(null);
  let search = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let listRequestId = 0;
  let undo: { sessionId: string; title: string } | null = $state(null);
  let currentTheme = $derived($uiTheme);
  let attentionThreads = $derived($threadStore.threads.filter((thread) =>
    thread.runtime.awaitingInputCount > 0 || thread.attentionRequest,
  ));

  onMount(() => {
    if ($threadStore.threads.length === 0) void loadPage(true);
    return () => {
      listRequestId += 1;
      if (searchTimer) clearTimeout(searchTimer);
    };
  });

  async function loadPage(reset: boolean): Promise<void> {
    // Pagination remains single-flight, but a reset from a newer search must
    // be allowed to supersede the request currently in flight.
    if ($threadStore.loading && !reset) return;
    const requestId = ++listRequestId;
    const query = search.trim();
    threadStore.setLoading(true);
    error = null;
    try {
      const client = await getInitializedUIClient();
      const response = await client.serviceRequest<{
        entries: ThreadListItem[];
        nextCursor: string | null;
      }>('session.list', {
        limit: PAGE_SIZE,
        query: query || undefined,
        cursor: reset ? undefined : $threadStore.nextCursor ?? undefined,
      });
      if (requestId !== listRequestId) return;
      threadStore.mergePage(response.entries ?? [], response.nextCursor ?? null, {
        reset,
        query,
      });
    } catch (cause) {
      if (requestId !== listRequestId) return;
      error = cause instanceof Error ? cause.message : 'Failed to load conversations';
      threadStore.setLoading(false);
    }
  }

  function searchChanged(): void {
    // Invalidate the old query immediately; do not let it commit during the
    // debounce window for the new query.
    listRequestId += 1;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadPage(true), 250);
  }

  function selectConversation(sessionId: string): void {
    threadStore.setActiveThread(sessionId);
    void push('/');
  }

  function navigateHistory(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-thread-history-select]')];
    if (buttons.length === 0) return;
    const current = buttons.indexOf(event.currentTarget as HTMLButtonElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  }

  function openAttention(thread: (typeof attentionThreads)[number]): void {
    if (thread.attentionRequest) {
      void resolveAttention(thread.sessionId, thread.attentionRequest.requestId);
    } else {
      selectConversation(thread.sessionId);
    }
  }

  async function togglePin(sessionId: string, pinned: boolean): Promise<void> {
    const client = await getInitializedUIClient();
    const entry = await client.serviceRequest<ThreadListItem>('session.pin', { sessionId, pinned });
    threadStore.mergeThread(entry);
  }

  async function rename(sessionId: string, current: string): Promise<void> {
    const title = window.prompt($_t('Rename conversation'), current)?.trim();
    if (!title || title === current) return;
    const client = await getInitializedUIClient();
    const entry = await client.serviceRequest<ThreadListItem>('session.rename', { sessionId, title });
    threadStore.mergeThread(entry);
  }

  async function remove(sessionId: string, title: string): Promise<void> {
    const client = await getInitializedUIClient();
    const result = await client.serviceRequest<{ status: 'deleted' | 'requires-confirmation' }>(
      'session.delete', { sessionId },
    );
    if (result.status === 'requires-confirmation') {
      error = $_t('Stop the running conversation before deleting it.');
      return;
    }
    threadStore.closeThread(sessionId);
    undo = { sessionId, title };
    if ($threadStore.activeSessionId === null && $threadStore.threads[0]) {
      selectConversation($threadStore.threads[0].sessionId);
    }
  }

  async function undoDelete(): Promise<void> {
    if (!undo) return;
    const target = undo;
    undo = null;
    const client = await getInitializedUIClient();
    const response = await client.serviceRequest<{ entry: ThreadListItem }>('session.undelete', {
      sessionId: target.sessionId,
    });
    threadStore.mergeThread(response.entry);
    selectConversation(target.sessionId);
  }

  async function resolveAttention(sessionId: string, requestId: string): Promise<void> {
    selectConversation(sessionId);
    const client = await getInitializedUIClient();
    await client.serviceRequest('session.setViewed', {
      surfaceId: documentSurfaceId,
      sessionId,
    });
    const response = await client.serviceRequest<{ status: string }>('session.resolveAttention', {
      surfaceId: documentSurfaceId,
      requestId,
    });
    if (response.status === 'granted') threadStore.setAttention(sessionId, undefined);
  }

  function formatTimeAgo(timestamp: number): string {
    const hours = Math.floor((Date.now() - timestamp) / MS_PER_HOUR);
    if (hours < 1) return $_t('now');
    if (hours < 24) return `${hours}h`;
    const date = new Date(timestamp);
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
</script>

<LeftPanelSection title="Chat History">
  <div class="px-2 pb-2">
    <input
      class="w-full min-w-0 rounded px-2 py-1 text-xs bg-transparent border
        {currentTheme === 'modern'
          ? 'border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark placeholder:text-chat-text-muted dark:placeholder:text-chat-text-muted-dark'
          : 'border-term-dim-green text-term-green placeholder:text-term-dim-green'}"
      bind:value={search}
      oninput={searchChanged}
      placeholder={$_t('Search chats')}
      aria-label={$_t('Search chats')}
    />
  </div>

  {#if attentionThreads.length > 0}
    <button
      class="mx-2 mb-2 w-[calc(100%-1rem)] rounded px-2 py-1.5 text-left text-xs border-none cursor-pointer bg-amber-500/15 text-amber-700 dark:text-amber-300"
      onclick={() => openAttention(attentionThreads[0])}
      aria-label={$_t('Open a conversation waiting for your attention')}
    >
      <span aria-hidden="true">!</span>
      {attentionThreads.length === 1
        ? $_t('One conversation needs your attention')
        : `${attentionThreads.length} ${$_t('conversations need your attention')}`}
      <span aria-hidden="true"> →</span>
    </button>
  {/if}

  {#if error}
    <div class="px-2 py-1.5 text-xs text-chat-error dark:text-chat-error-dark" role="alert">{error}</div>
  {:else if $threadStore.loading && $threadStore.threads.length === 0}
    <div class="px-2 py-1.5 text-xs opacity-70">{$_t('Loading history...')}</div>
  {:else if $threadStore.threads.length === 0}
    <div class="px-2 py-1.5 text-xs opacity-70">{$_t('No chat history yet')}</div>
  {:else}
    <div
      class="flex flex-col gap-0.5"
      data-thread-history-list
      aria-label={$_t('Chat History')}
    >
      {#each $threadStore.threads as item (item.sessionId)}
        {@const isActive = $threadStore.activeSessionId === item.sessionId}
        <div class="group relative flex items-center rounded-md transition-colors
          {currentTheme === 'modern'
            ? (isActive
                ? 'bg-chat-button-hover dark:bg-chat-button-hover-dark text-chat-text dark:text-chat-text-dark'
                : 'text-chat-text-secondary dark:text-chat-text-secondary-dark hover:bg-chat-button-hover/60 dark:hover:bg-chat-button-hover-dark/60')
            : (isActive
                ? 'bg-term-green/10 text-term-green'
                : 'text-term-dim-green hover:bg-term-green/5 hover:text-term-green')}">
          <button
            data-thread-history-select
            class="min-w-0 flex-1 flex items-center gap-2 border-none bg-transparent px-2 py-1.5 text-left text-sm text-inherit cursor-pointer"
            onclick={() => selectConversation(item.sessionId)}
            onkeydown={navigateHistory}
            title={item.title || $_t('Untitled conversation')}
          >
            {#if item.runtime.awaitingInputCount > 0}
              <span class="w-4 h-4 rounded-full shrink-0 inline-flex items-center justify-center bg-amber-400 text-black text-[10px] font-bold"
                title={$_t('Waiting for your input')} aria-label={$_t('Waiting for your input')}>!</span>
            {:else}
              <span class="w-2 h-2 rounded-full shrink-0
                {item.runtime.state === 'running' ? 'bg-emerald-400 animate-pulse'
                  : item.runtime.lastFailure ? 'bg-red-400' : 'bg-slate-400/40'}"
                title={item.runtime.state === 'running' ? $_t('Running') : undefined}></span>
            {/if}
            <span class="flex-1 truncate">{item.title || $_t('Untitled conversation')}</span>
            {#if item.runtime.durability === 'degraded'}<span class="shrink-0" title={$_t('Durability degraded')}>⚠</span>{/if}
            {#if item.pinned}
              <!-- Persistent pin marker so pinned rows read as pinned at rest;
                   the hover overlay's pin toggle fades in over it on hover. -->
              <span class="shrink-0 text-xs opacity-70 group-hover:opacity-0 transition-opacity"
                title={$_t('Pinned')} aria-hidden="true">★</span>
            {/if}
          </button>

          <!-- Hover overlay: floats above the row's right edge so the title text
               can use the full width at rest. The row's controls (time, pin,
               rename, delete) reveal only on hover or keyboard focus. -->
          <div class="absolute inset-y-0 right-0 flex items-center gap-0.5 pl-8 pr-1 rounded-r-md
            opacity-0 pointer-events-none transition-opacity
            group-hover:opacity-100 group-hover:pointer-events-auto
            group-focus-within:opacity-100 group-focus-within:pointer-events-auto
            {currentTheme === 'modern'
              ? 'bg-gradient-to-l from-chat-button-hover dark:from-chat-button-hover-dark via-chat-button-hover dark:via-chat-button-hover-dark via-60% to-transparent'
              : 'bg-gradient-to-l from-term-bg via-term-bg via-60% to-transparent'}">
            <span class="shrink-0 text-xs opacity-60">{formatTimeAgo(item.lastActiveAt)}</span>
            {#if item.attentionRequest}
              <button class="px-1 border-none bg-transparent text-inherit cursor-pointer opacity-70 hover:opacity-100"
                title={$_t('Continue browser action')}
                onclick={() => void resolveAttention(item.sessionId, item.attentionRequest!.requestId)}>↗</button>
            {/if}
            <button class="px-1 border-none bg-transparent text-inherit cursor-pointer opacity-70 hover:opacity-100"
              title={item.pinned ? $_t('Unpin') : $_t('Pin')}
              onclick={() => void togglePin(item.sessionId, !item.pinned)}>{item.pinned ? '★' : '☆'}</button>
            <button class="px-1 border-none bg-transparent text-inherit cursor-pointer opacity-70 hover:opacity-100"
              title={$_t('Rename')} onclick={() => void rename(item.sessionId, item.title)}>✎</button>
            <button class="px-1 border-none bg-transparent text-inherit cursor-pointer opacity-70 hover:opacity-100"
              title={$_t('Delete')} onclick={() => void remove(item.sessionId, item.title)}>×</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if $threadStore.nextCursor}
    <button class="w-full px-2 py-1.5 text-center text-xs border-none bg-transparent cursor-pointer opacity-70 hover:opacity-100
      {currentTheme === 'modern'
        ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark hover:text-chat-text dark:hover:text-chat-text-dark'
        : 'text-term-dim-green hover:text-term-green'}"
      onclick={() => void loadPage(false)} disabled={$threadStore.loading}>
      {$threadStore.loading ? $_t('Loading history...') : $_t('Load More')}
    </button>
  {/if}

  {#if undo}
    <div class="mx-2 mt-2 rounded px-2 py-1.5 text-xs flex justify-between bg-black/10" role="status">
      <span>{$_t('Conversation deleted')}</span>
      <button class="border-none bg-transparent underline cursor-pointer" onclick={() => void undoDelete()}>{$_t('Undo')}</button>
    </div>
  {/if}
</LeftPanelSection>
