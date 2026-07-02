<script lang="ts">
  /**
   * Full chat-history modal, opened from the "more…" button of the left-panel
   * Chat History section. A self-contained centered dialog (same shape as
   * MessageSelector) rather than a PopupCard, because it is not anchored to a
   * persistent trigger. Loads the history paginated 20 at a time via the shared
   * `ChatHistoryList` and its "Load more" button.
   */
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import ChatHistoryList from './ChatHistoryList.svelte';

  let {
    show = false,
    onClose = () => {},
    onSelectConversation = (_sessionId: string) => {},
  }: {
    show?: boolean;
    onClose?: () => void;
    onSelectConversation?: (sessionId: string) => void;
  } = $props();

  let currentTheme = $derived($uiTheme);

  const PAGE_SIZE = 20;

  function handleSelect(sessionId: string) {
    onSelectConversation(sessionId);
    onClose();
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

{#if show}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    onclick={handleBackdrop}
    onkeydown={handleKey}
    role="dialog"
    aria-modal="true"
    aria-label={$_t('Chat History')}
    tabindex="-1"
  >
    <div
      class="w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden rounded-lg shadow-xl
        {currentTheme === 'modern'
          ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark'
          : 'bg-black text-term-green border border-term-dim-green'}"
    >
      <div class="flex items-center justify-between px-4 py-3 border-b
        {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
        <h2 class="text-sm font-semibold">{$_t('Chat History')}</h2>
        <button
          class="text-lg leading-none px-2 cursor-pointer opacity-70 hover:opacity-100"
          onclick={onClose}
          aria-label={$_t('Close')}
        >×</button>
      </div>

      <div class="overflow-y-auto">
        <ChatHistoryList
          onSelectConversation={handleSelect}
          onClose={onClose}
          initialPageSize={PAGE_SIZE}
          morePageSize={PAGE_SIZE}
        />
      </div>
    </div>
  </div>
{/if}
