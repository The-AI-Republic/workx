<script lang="ts">
  import PopupCard from '../common/PopupCard.svelte';
  import ChatHistoryList from './ChatHistoryList.svelte';
  import Tooltip from '../common/Tooltip.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';

  export let onSelectConversation: (conversationId: string) => void = () => {};

  let showPopup = false;
  let currentTheme: UITheme = 'terminal';

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  function togglePopup() {
    showPopup = !showPopup;
  }

  function closePopup() {
    showPopup = false;
  }

  function handleSelectConversation(conversationId: string) {
    onSelectConversation(conversationId);
    closePopup();
  }
</script>

<PopupCard
  title={$_t("Chat History")}
  show={showPopup}
  onClose={closePopup}
>
  <div slot="trigger">
    <Tooltip content={$_t("Chat History")}>
      <button
        class="flex items-center justify-center p-1 cursor-pointer transition-all duration-200 active:scale-95
          {currentTheme === 'modern'
            ? 'bg-transparent border-none rounded-md text-chat-text-muted dark:text-chat-text-muted-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark'
            : 'bg-transparent border border-gray-500/50 text-gray-500/80 rounded hover:border-gray-500/80 hover:text-gray-400 hover:bg-gray-500/10'}"
        on:click|stopPropagation={togglePopup}
        aria-label={$_t("View Chat History")}
        aria-expanded={showPopup}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="w-5 h-5"
          fill="none"
          viewBox="0 0 24 24"
        >
          <path d="M5.63606 18.3639C9.15077 21.8786 14.8493 21.8786 18.364 18.3639C21.8787 14.8492 21.8787 9.1507 18.364 5.63598C14.8493 2.12126 9.15077 2.12126 5.63606 5.63598C3.87757 7.39447 2.99889 9.6996 3.00002 12.0044L3 13.9999" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M1 11.9999L3 13.9999L5 11.9999" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M11 7.99994L11 12.9999L16 12.9999" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </Tooltip>
  </div>

  <div slot="content">
    <ChatHistoryList
      onSelectConversation={handleSelectConversation}
      onClose={closePopup}
    />
  </div>
</PopupCard>
