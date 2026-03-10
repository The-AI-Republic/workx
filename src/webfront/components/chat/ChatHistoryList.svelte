<script lang="ts">
  import { onMount } from 'svelte';
  import { RolloutRecorder, type ConversationItem, type Cursor } from '@/storage/rollout';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';

  // Props
  export let onSelectConversation: (sessionId: string) => void = () => {};
  export let onClose: () => void = () => {};

  // State
  let conversations: ConversationItem[] = [];
  let isLoading = true;
  let error: string | null = null;
  let nextCursor: Cursor | undefined;
  let hasMoreOlder = false;
  let isLoadingMore = false;
  let currentTheme: UITheme = 'terminal';

  // Time category constants
  const MS_PER_HOUR = 1000 * 60 * 60;
  const MS_PER_DAY = MS_PER_HOUR * 24;

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Categorized conversations
  interface CategorizedConversations {
    today: ConversationItem[];
    yesterday: ConversationItem[];
    pastWeek: ConversationItem[];
    pastMonth: ConversationItem[];
    older: ConversationItem[];
  }

  $: categorized = categorizeConversations(conversations);

  onMount(async () => {
    await loadConversations();
  });

  async function loadConversations() {
    isLoading = true;
    error = null;

    try {
      console.log('[ChatHistoryList] Starting to load conversations...');

      // Add timeout to prevent infinite loading
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout loading conversations')), 5000);
      });

      // Load conversations with timeout
      const page = await Promise.race([
        RolloutRecorder.listConversations(50),
        timeoutPromise,
      ]);

      conversations = page.items || [];
      nextCursor = page.nextCursor;

      // Check if there are potentially more older conversations
      const thirtyDaysAgo = Date.now() - (30 * MS_PER_DAY);
      const hasOlderConversations = conversations.some(c => c.updated < thirtyDaysAgo);
      hasMoreOlder = page.nextCursor !== undefined || hasOlderConversations;

      console.log('[ChatHistoryList] Loaded', conversations.length, 'conversations');
    } catch (err) {
      console.error('[ChatHistoryList] Failed to load conversations:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Timeout')) {
        error = 'Loading timed out';
      } else if (errMsg.includes('provider') || errMsg.includes('tauri') || errMsg.includes('invoke')) {
        error = 'Storage not available';
      } else if (errMsg.includes('database') || errMsg.includes('Database') || errMsg.includes('IDB') || errMsg.includes('SQL')) {
        error = 'Database error';
      } else {
        error = 'Failed to load';
      }
      conversations = [];
    } finally {
      isLoading = false;
    }
  }

  async function loadMoreOlder() {
    if (isLoadingMore || !nextCursor) return;

    isLoadingMore = true;

    try {
      const page = await RolloutRecorder.listConversations(10, nextCursor);
      conversations = [...conversations, ...page.items];
      nextCursor = page.nextCursor;
      hasMoreOlder = page.nextCursor !== undefined;
    } catch (err) {
      console.error('[ChatHistoryList] Failed to load more conversations:', err);
    } finally {
      isLoadingMore = false;
    }
  }

  function categorizeConversations(items: ConversationItem[]): CategorizedConversations {
    const now = Date.now();
    const todayStart = getStartOfDay(now);
    const yesterdayStart = todayStart - MS_PER_DAY;
    const weekStart = todayStart - (7 * MS_PER_DAY);
    const monthStart = todayStart - (30 * MS_PER_DAY);

    const result: CategorizedConversations = {
      today: [],
      yesterday: [],
      pastWeek: [],
      pastMonth: [],
      older: [],
    };

    for (const item of items) {
      const updated = item.updated;

      if (updated >= todayStart) {
        result.today.push(item);
      } else if (updated >= yesterdayStart) {
        result.yesterday.push(item);
      } else if (updated >= weekStart) {
        result.pastWeek.push(item);
      } else if (updated >= monthStart) {
        result.pastMonth.push(item);
      } else {
        result.older.push(item);
      }
    }

    return result;
  }

  function getStartOfDay(timestamp: number): number {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function getDisplayTitle(item: ConversationItem): string {
    // Use title from sessionMeta if available
    if (item.sessionMeta?.title) {
      return item.sessionMeta.title;
    }

    // Fallback: generate random 3-letter suffix
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const randomSuffix = Array.from({ length: 3 }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join('');

    return `conversation_${randomSuffix}`;
  }

  function formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const hours = Math.floor(diff / MS_PER_HOUR);

    if (hours < 1) {
      return 'now';
    } else if (hours < 24) {
      return `${hours}h`;
    } else {
      // For older items, show date in MM-DD format
      const date = new Date(timestamp);
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${month}-${day}`;
    }
  }

  function handleSelectConversation(sessionId: string) {
    onSelectConversation(sessionId);
    onClose();
  }
</script>

<div class="max-h-[400px] overflow-y-auto min-w-[250px]
  {currentTheme === 'modern' ? 'bg-chat-tooltip dark:bg-chat-tooltip-dark' : ''}">
  {#if isLoading}
    <div class="flex items-center justify-center gap-2 p-6 text-sm
      {currentTheme === 'modern'
        ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
        : 'text-term-dim-green'}">
      <span class="loading-spinner"></span>
      <span>{$_t("Loading history...")}</span>
    </div>
  {:else if error}
    <div class="flex items-center justify-center gap-2 p-6 text-sm
      {currentTheme === 'modern'
        ? 'text-chat-error dark:text-chat-error-dark'
        : 'text-term-red'}">
      <span class="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border border-current text-sm font-bold">!</span>
      <span>{error}</span>
    </div>
  {:else if conversations.length === 0}
    <div class="flex items-center justify-center gap-2 p-6 text-sm
      {currentTheme === 'modern'
        ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
        : 'text-term-dim-green'}">
      <span>{$_t("No chat history yet")}</span>
    </div>
  {:else}
    <div class="flex flex-col">
      <!-- Today -->
      {#if categorized.today.length > 0}
        <div class="flex flex-col">
          <div class="py-2 px-3 text-sm font-semibold uppercase tracking-wide opacity-70
            {currentTheme === 'modern'
              ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark bg-white/[0.03] border-b border-white/10'
              : 'text-term-dim-green bg-term-dim-green/5 border-b border-term-dim-green/20'}">{$_t("Today")}</div>
          {#each categorized.today as item (item.id)}
            <button
              class="flex items-center justify-between gap-3 py-2.5 px-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150
                {currentTheme === 'modern'
                  ? 'border-b border-white/5 hover:bg-white/[0.08] active:bg-white/[0.12]'
                  : 'border-b border-term-dim-green/10 hover:bg-term-green/[0.08] active:bg-term-green/[0.12]'}"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="flex-1 text-sm whitespace-nowrap overflow-hidden text-ellipsis
                {currentTheme === 'modern'
                  ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat'
                  : 'text-term-bright-green font-terminal'}">{getDisplayTitle(item)}</span>
              <span class="shrink-0 text-sm opacity-70
                {currentTheme === 'modern'
                  ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark font-chat'
                  : 'text-term-dim-green font-terminal'}">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Yesterday -->
      {#if categorized.yesterday.length > 0}
        <div class="flex flex-col">
          <div class="py-2 px-3 text-sm font-semibold uppercase tracking-wide opacity-70
            {currentTheme === 'modern'
              ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark bg-white/[0.03] border-b border-white/10'
              : 'text-term-dim-green bg-term-dim-green/5 border-b border-term-dim-green/20'}">{$_t("Yesterday")}</div>
          {#each categorized.yesterday as item (item.id)}
            <button
              class="flex items-center justify-between gap-3 py-2.5 px-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150
                {currentTheme === 'modern'
                  ? 'border-b border-white/5 hover:bg-white/[0.08] active:bg-white/[0.12]'
                  : 'border-b border-term-dim-green/10 hover:bg-term-green/[0.08] active:bg-term-green/[0.12]'}"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="flex-1 text-sm whitespace-nowrap overflow-hidden text-ellipsis
                {currentTheme === 'modern'
                  ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat'
                  : 'text-term-bright-green font-terminal'}">{getDisplayTitle(item)}</span>
              <span class="shrink-0 text-sm opacity-70
                {currentTheme === 'modern'
                  ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark font-chat'
                  : 'text-term-dim-green font-terminal'}">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Past Week -->
      {#if categorized.pastWeek.length > 0}
        <div class="flex flex-col">
          <div class="py-2 px-3 text-sm font-semibold uppercase tracking-wide opacity-70
            {currentTheme === 'modern'
              ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark bg-white/[0.03] border-b border-white/10'
              : 'text-term-dim-green bg-term-dim-green/5 border-b border-term-dim-green/20'}">{$_t("Past Week")}</div>
          {#each categorized.pastWeek as item (item.id)}
            <button
              class="flex items-center justify-between gap-3 py-2.5 px-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150
                {currentTheme === 'modern'
                  ? 'border-b border-white/5 hover:bg-white/[0.08] active:bg-white/[0.12]'
                  : 'border-b border-term-dim-green/10 hover:bg-term-green/[0.08] active:bg-term-green/[0.12]'}"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="flex-1 text-sm whitespace-nowrap overflow-hidden text-ellipsis
                {currentTheme === 'modern'
                  ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat'
                  : 'text-term-bright-green font-terminal'}">{getDisplayTitle(item)}</span>
              <span class="shrink-0 text-sm opacity-70
                {currentTheme === 'modern'
                  ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark font-chat'
                  : 'text-term-dim-green font-terminal'}">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Past Month -->
      {#if categorized.pastMonth.length > 0}
        <div class="flex flex-col">
          <div class="py-2 px-3 text-sm font-semibold uppercase tracking-wide opacity-70
            {currentTheme === 'modern'
              ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark bg-white/[0.03] border-b border-white/10'
              : 'text-term-dim-green bg-term-dim-green/5 border-b border-term-dim-green/20'}">{$_t("Past Month")}</div>
          {#each categorized.pastMonth as item (item.id)}
            <button
              class="flex items-center justify-between gap-3 py-2.5 px-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150
                {currentTheme === 'modern'
                  ? 'border-b border-white/5 hover:bg-white/[0.08] active:bg-white/[0.12]'
                  : 'border-b border-term-dim-green/10 hover:bg-term-green/[0.08] active:bg-term-green/[0.12]'}"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="flex-1 text-sm whitespace-nowrap overflow-hidden text-ellipsis
                {currentTheme === 'modern'
                  ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat'
                  : 'text-term-bright-green font-terminal'}">{getDisplayTitle(item)}</span>
              <span class="shrink-0 text-sm opacity-70
                {currentTheme === 'modern'
                  ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark font-chat'
                  : 'text-term-dim-green font-terminal'}">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Older -->
      {#if categorized.older.length > 0 || hasMoreOlder}
        <div class="flex flex-col">
          <div class="py-2 px-3 text-sm font-semibold uppercase tracking-wide opacity-70
            {currentTheme === 'modern'
              ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark bg-white/[0.03] border-b border-white/10'
              : 'text-term-dim-green bg-term-dim-green/5 border-b border-term-dim-green/20'}">{$_t("Older")}</div>
          {#each categorized.older as item (item.id)}
            <button
              class="flex items-center justify-between gap-3 py-2.5 px-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150
                {currentTheme === 'modern'
                  ? 'border-b border-white/5 hover:bg-white/[0.08] active:bg-white/[0.12]'
                  : 'border-b border-term-dim-green/10 hover:bg-term-green/[0.08] active:bg-term-green/[0.12]'}"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="flex-1 text-sm whitespace-nowrap overflow-hidden text-ellipsis
                {currentTheme === 'modern'
                  ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat'
                  : 'text-term-bright-green font-terminal'}">{getDisplayTitle(item)}</span>
              <span class="shrink-0 text-sm opacity-70
                {currentTheme === 'modern'
                  ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark font-chat'
                  : 'text-term-dim-green font-terminal'}">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}

          {#if hasMoreOlder}
            <button
              class="flex items-center justify-center gap-2 w-full py-3 bg-transparent cursor-pointer mt-2 text-sm transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed
                {currentTheme === 'modern'
                  ? 'border border-dashed border-white/20 rounded-lg text-chat-text-secondary dark:text-chat-text-secondary-dark font-chat hover:bg-white/[0.08] hover:border-white/30 hover:text-chat-tooltip-text dark:hover:text-chat-tooltip-text-dark'
                  : 'border border-dashed border-term-dim-green rounded text-term-dim-green font-terminal hover:bg-term-green/[0.08] hover:border-term-bright-green hover:text-term-bright-green'}"
              on:click={loadMoreOlder}
              disabled={isLoadingMore}
            >
              {#if isLoadingMore}
                <span class="loading-spinner small"></span>
                {$_t("Loading...")}
              {:else}
                {$_t("Load more")}
              {/if}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .loading-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .loading-spinner.small {
    width: 12px;
    height: 12px;
    border-width: 1.5px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
