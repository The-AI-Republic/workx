<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import ChatTab from './ChatTab.svelte';
  import { chatStore, type SidePanelChat } from '../../stores/chatStore';
  import { uiTheme } from '../../stores/themeStore';
  import Tooltip from '../common/Tooltip.svelte';

  /**
   * ChatBar Component
   *
   * Horizontal chat bar at top of side panel:
   * - Row of chat tabs
   * - Each chat: title (truncated), close button
   * - "+" button to create new chat
   * - Active chat highlighted
   * - Theme-aware (terminal/chatgpt styles)
   * - Disabled "+" when max sessions reached
   */

  export let canCreateChat: boolean = true;
  export let maxSessionsReached: boolean = false;

  const dispatch = createEventDispatcher<{
    chatSelect: { chatId: string };
    chatClose: { chatId: string };
    newChat: void;
  }>();

  // Current theme (auto-subscription via $store syntax)
  $: currentTheme = $uiTheme;

  // Chat store (auto-subscription via $store syntax)
  $: chats = $chatStore.chats;
  $: activeChatId = $chatStore.activeChatId;

  function handleChatSelect(event: CustomEvent<{ chatId: string }>) {
    dispatch('chatSelect', { chatId: event.detail.chatId });
  }

  function handleChatClose(event: CustomEvent<{ chatId: string }>) {
    dispatch('chatClose', { chatId: event.detail.chatId });
  }

  function handleNewChat() {
    if (canCreateChat && !maxSessionsReached) {
      dispatch('newChat');
    }
  }

  function handleNewChatKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleNewChat();
    }
  }
</script>

<div class="chat-bar {currentTheme}" role="tablist" aria-label="Conversation chats">
  <div class="chats-container">
    {#each chats as chat (chat.id)}
      <ChatTab
        {chat}
        isActive={chat.id === activeChatId}
        on:select={handleChatSelect}
        on:close={handleChatClose}
      />
    {/each}
  </div>

  <Tooltip
    content={maxSessionsReached ? 'Maximum sessions reached' : 'New conversation'}
    disabled={false}
  >
    <button
      class="new-chat-button"
      class:disabled={!canCreateChat || maxSessionsReached}
      aria-label="New chat"
      on:click={handleNewChat}
      on:keydown={handleNewChatKeydown}
      disabled={!canCreateChat || maxSessionsReached}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  </Tooltip>
</div>

<style>
  /* ============================================
     Terminal Theme (default)
     ============================================ */

  .chat-bar {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding: 4px 8px 0;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid var(--color-term-dim-green, #00cc00);
    min-height: 40px;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .chat-bar::-webkit-scrollbar {
    height: 4px;
  }

  .chat-bar::-webkit-scrollbar-track {
    background: transparent;
  }

  .chat-bar::-webkit-scrollbar-thumb {
    background: var(--color-term-dim-green, #00cc00);
    border-radius: 2px;
  }

  .chats-container {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .new-chat-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    margin-bottom: 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .new-chat-button:hover:not(.disabled) {
    background: rgba(0, 255, 0, 0.1);
    border-color: var(--color-term-dim-green, #00cc00);
    color: var(--color-term-bright-green, #00ff00);
  }

  .new-chat-button.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ============================================
     ChatGPT Theme
     ============================================ */

  .chat-bar.chatgpt {
    background: var(--chat-card-bg, #f7f7f8);
    border-bottom: 1px solid var(--chat-border, #e5e5e5);
    padding: 6px 12px 0;
  }

  .chat-bar.chatgpt::-webkit-scrollbar-thumb {
    background: var(--chat-text-secondary, #6e6e80);
  }

  .chat-bar.chatgpt .new-chat-button {
    color: var(--chat-text-secondary, #6e6e80);
    border-radius: 6px;
  }

  .chat-bar.chatgpt .new-chat-button:hover:not(.disabled) {
    background: var(--chat-card-hover, rgba(0, 0, 0, 0.05));
    border-color: var(--chat-border, #e5e5e5);
    color: var(--chat-text, #0d0d0d);
  }
</style>
