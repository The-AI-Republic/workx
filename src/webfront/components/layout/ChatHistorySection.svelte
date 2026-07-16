<script lang="ts">
  /**
   * Left-panel "Chat History" section (Codex-desktop style).
   *
   * Lists the 5 most recent conversations plus a "more…" button. Selecting an
   * item loads that conversation into the chat page (via the resume-request
   * store + navigation to the chat route). "more…" opens {@link ChatHistoryModal},
   * a paginated (20 at a time) full-history dialog.
   */
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { RolloutRecorder, type ConversationItem } from '@/storage/rollout';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { requestResumeConversation } from '../../stores/chatHistoryStore';
  import LeftPanelSection from './LeftPanelSection.svelte';
  import ChatHistoryModal from '../chat/ChatHistoryModal.svelte';

  const TOP_COUNT = 5;
  const MS_PER_HOUR = 1000 * 60 * 60;

  let conversations: ConversationItem[] = $state([]);
  let isLoading = $state(true);
  let error: string | null = $state(null);
  let showModal = $state(false);

  let currentTheme = $derived($uiTheme);

  onMount(() => {
    void loadTop();
  });

  async function loadTop() {
    isLoading = true;
    error = null;
    try {
      const page = await RolloutRecorder.listConversations(TOP_COUNT);
      conversations = page.items || [];
    } catch (err) {
      console.error('[ChatHistorySection] Failed to load conversations:', err);
      error = 'Failed to load';
      conversations = [];
    } finally {
      isLoading = false;
    }
  }

  function getDisplayTitle(item: ConversationItem): string {
    if (item.sessionMeta?.title) return item.sessionMeta.title;
    return $_t('Untitled conversation');
  }

  function formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const hours = Math.floor(diff / MS_PER_HOUR);
    if (hours < 1) return $_t('now');
    if (hours < 24) return `${hours}h`;
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day}`;
  }

  function selectConversation(sessionId: string) {
    requestResumeConversation(sessionId);
    // Ensure the chat page is mounted to receive the resume request.
    push('/');
  }

  function openModal() {
    showModal = true;
  }

  function closeModal() {
    showModal = false;
    // Refresh the top list in case titles/order changed while browsing.
    void loadTop();
  }
</script>

<LeftPanelSection title="Chat History">
  {#if isLoading}
    <div class="px-2 py-1.5 text-xs
      {currentTheme === 'modern'
        ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
        : 'text-term-dim-green'}">
      {$_t('Loading history...')}
    </div>
  {:else if error}
    <div class="px-2 py-1.5 text-xs
      {currentTheme === 'modern' ? 'text-chat-error dark:text-chat-error-dark' : 'text-term-red'}">
      {$_t(error)}
    </div>
  {:else if conversations.length === 0}
    <div class="px-2 py-1.5 text-xs
      {currentTheme === 'modern'
        ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
        : 'text-term-dim-green'}">
      {$_t('No chat history yet')}
    </div>
  {:else}
    {#each conversations as item (item.id)}
      <button
        class="flex items-center justify-between gap-2 w-full rounded-md border-none bg-transparent px-2 py-1.5 text-left text-sm cursor-pointer transition-colors duration-150
          {currentTheme === 'modern'
            ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark'
            : 'text-term-dim-green hover:bg-term-green/10 hover:text-term-bright-green'}"
        onclick={() => selectConversation(item.id)}
        title={getDisplayTitle(item)}
      >
        <span class="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{getDisplayTitle(item)}</span>
        <span class="shrink-0 text-xs opacity-70">{formatTimeAgo(item.updated)}</span>
      </button>
    {/each}
  {/if}

  <button
    class="flex items-center gap-2 w-full rounded-md border-none bg-transparent px-2 py-1.5 text-left text-sm cursor-pointer transition-colors duration-150
      {currentTheme === 'modern'
        ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark'
        : 'text-term-dim-green hover:bg-term-green/10 hover:text-term-bright-green'}"
    onclick={openModal}
  >
    {$_t('more…')}
  </button>
</LeftPanelSection>

<ChatHistoryModal
  show={showModal}
  onClose={closeModal}
  onSelectConversation={selectConversation}
/>
