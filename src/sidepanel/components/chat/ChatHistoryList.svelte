<script lang="ts">
  import { onMount } from 'svelte';
  import { RolloutRecorder, type ConversationItem, type Cursor } from '../../../../open_source/src/storage/rollout';
  import { uiTheme, type UITheme } from '../../stores/themeStore';

  // Props
  export let onSelectConversation: (conversationId: string) => void = () => {};
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
      } else if (errMsg.includes('database')) {
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

  function handleSelectConversation(conversationId: string) {
    onSelectConversation(conversationId);
    onClose();
  }
</script>

<div class="chat-history-list {currentTheme}">
  {#if isLoading}
    <div class="loading-state">
      <span class="loading-spinner"></span>
      <span>Loading history...</span>
    </div>
  {:else if error}
    <div class="error-state">
      <span class="error-icon">!</span>
      <span>{error}</span>
    </div>
  {:else if conversations.length === 0}
    <div class="empty-state">
      <span>No chat history yet</span>
    </div>
  {:else}
    <div class="categories-container">
      <!-- Today -->
      {#if categorized.today.length > 0}
        <div class="category">
          <div class="category-header">Today</div>
          {#each categorized.today as item (item.id)}
            <button
              class="history-item"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="item-title">{getDisplayTitle(item)}</span>
              <span class="item-time">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Yesterday -->
      {#if categorized.yesterday.length > 0}
        <div class="category">
          <div class="category-header">Yesterday</div>
          {#each categorized.yesterday as item (item.id)}
            <button
              class="history-item"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="item-title">{getDisplayTitle(item)}</span>
              <span class="item-time">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Past Week -->
      {#if categorized.pastWeek.length > 0}
        <div class="category">
          <div class="category-header">Past Week</div>
          {#each categorized.pastWeek as item (item.id)}
            <button
              class="history-item"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="item-title">{getDisplayTitle(item)}</span>
              <span class="item-time">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Past Month -->
      {#if categorized.pastMonth.length > 0}
        <div class="category">
          <div class="category-header">Past Month</div>
          {#each categorized.pastMonth as item (item.id)}
            <button
              class="history-item"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="item-title">{getDisplayTitle(item)}</span>
              <span class="item-time">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Older -->
      {#if categorized.older.length > 0 || hasMoreOlder}
        <div class="category">
          <div class="category-header">Older</div>
          {#each categorized.older as item (item.id)}
            <button
              class="history-item"
              on:click={() => handleSelectConversation(item.id)}
            >
              <span class="item-title">{getDisplayTitle(item)}</span>
              <span class="item-time">{formatTimeAgo(item.updated)}</span>
            </button>
          {/each}

          {#if hasMoreOlder}
            <button
              class="load-more-button"
              on:click={loadMoreOlder}
              disabled={isLoadingMore}
            >
              {#if isLoadingMore}
                <span class="loading-spinner small"></span>
                Loading...
              {:else}
                Load more
              {/if}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .chat-history-list {
    max-height: 400px;
    overflow-y: auto;
    min-width: 250px;
  }

  /* Loading state */
  .loading-state,
  .error-state,
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 1.5rem;
    color: var(--color-term-dim-green, #00cc00);
    font-size: 0.875rem;
  }

  .error-state {
    color: var(--color-term-red, #ff0000);
  }

  .error-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid currentColor;
    font-size: 0.75rem;
    font-weight: bold;
  }

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

  /* Categories */
  .categories-container {
    display: flex;
    flex-direction: column;
  }

  .category {
    display: flex;
    flex-direction: column;
  }

  .category-header {
    padding: 0.5rem 0.75rem;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-term-dim-green, #00cc00);
    opacity: 0.7;
    background: rgba(0, 204, 0, 0.05);
    border-bottom: 1px solid rgba(0, 204, 0, 0.2);
  }

  /* History items */
  .history-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    background: transparent;
    border: none;
    border-bottom: 1px solid rgba(0, 204, 0, 0.1);
    cursor: pointer;
    text-align: left;
    width: 100%;
    transition: background 0.15s ease;
  }

  .history-item:hover {
    background: rgba(0, 255, 0, 0.08);
  }

  .history-item:active {
    background: rgba(0, 255, 0, 0.12);
  }

  .item-title {
    flex: 1;
    font-size: 0.85rem;
    color: var(--color-term-bright-green, #00ff00);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .item-time {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-term-dim-green, #00cc00);
    opacity: 0.7;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  /* Load more button */
  .load-more-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.75rem;
    background: transparent;
    border: 1px dashed var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    color: var(--color-term-dim-green, #00cc00);
    font-size: 0.85rem;
    cursor: pointer;
    margin-top: 0.5rem;
    transition: all 0.15s ease;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .load-more-button:hover:not(:disabled) {
    background: rgba(0, 255, 0, 0.08);
    border-color: var(--color-term-bright-green, #00ff00);
    color: var(--color-term-bright-green, #00ff00);
  }

  .load-more-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .chat-history-list.chatgpt {
    background: var(--chat-tooltip-bg, #0d0d0d);
  }

  .chat-history-list.chatgpt .loading-state,
  .chat-history-list.chatgpt .empty-state {
    color: var(--chat-text-secondary, #8e8ea0);
  }

  .chat-history-list.chatgpt .error-state {
    color: var(--chat-error, #ef4444);
  }

  .chat-history-list.chatgpt .category-header {
    color: var(--chat-text-secondary, #8e8ea0);
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .chat-history-list.chatgpt .history-item {
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .chat-history-list.chatgpt .history-item:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .chat-history-list.chatgpt .history-item:active {
    background: rgba(255, 255, 255, 0.12);
  }

  .chat-history-list.chatgpt .item-title {
    color: var(--chat-tooltip-text, #ffffff);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .chat-history-list.chatgpt .item-time {
    color: var(--chat-text-secondary, #8e8ea0);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .chat-history-list.chatgpt .load-more-button {
    border: 1px dashed rgba(255, 255, 255, 0.2);
    color: var(--chat-text-secondary, #8e8ea0);
    border-radius: 0.5rem;
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .chat-history-list.chatgpt .load-more-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.3);
    color: var(--chat-tooltip-text, #ffffff);
  }
</style>
