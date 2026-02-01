<script lang="ts">
  import PopupCard from '../common/PopupCard.svelte';
  import ChatHistoryList from './ChatHistoryList.svelte';
  import Tooltip from '../common/Tooltip.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';

  // Props
  export let onSelectConversation: (conversationId: string) => void = () => {};

  // State
  let showPopup = false;
  let currentTheme: UITheme = 'terminal';

  // Subscribe to theme store
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
        class="history-button {currentTheme}"
        on:click|stopPropagation={togglePopup}
        aria-label={$_t("View Chat History")}
        aria-expanded={showPopup}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="history-icon"
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

<style>
  /* History button - base (Terminal theme) */
  .history-button {
    padding: 0.25rem;
    border-radius: 4px;
    background: transparent;
    border: 1px solid rgba(128, 128, 128, 0.5);
    color: rgba(128, 128, 128, 0.8);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .history-button:hover {
    border-color: rgba(128, 128, 128, 0.8);
    color: rgba(160, 160, 160, 1);
    background: rgba(128, 128, 128, 0.1);
  }

  .history-button:active {
    transform: scale(0.95);
  }

  .history-icon {
    width: 17px;
    height: 17px;
  }

  /* ChatGPT Theme */
  .history-button.chatgpt {
    border: none;
    border-radius: 0.375rem;
    color: var(--chat-text-muted, #8e8ea0);
  }

  .history-button.chatgpt:hover {
    background: var(--chat-button-hover, #ececec);
    color: var(--chat-text, #0d0d0d);
  }
</style>
