<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import UserLoginStatus from '../common/UserLoginStatus.svelte';
  import { userStore } from '../../stores/userStore';
  import Tooltip from '../common/Tooltip.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import SchedulerButton from '../scheduler/SchedulerButton.svelte';
  import SchedulerPopup from '../scheduler/SchedulerPopup.svelte';

  const dispatch = createEventDispatcher();

  let currentTheme: UITheme = 'terminal';
  let showSchedulerPopup = false;

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  function handleOpenSettings() {
    dispatch('openSettings');
  }

  function handleSchedulerClick() {
    showSchedulerPopup = !showSchedulerPopup;
  }

  function handleCloseSchedulerPopup() {
    showSchedulerPopup = false;
  }
</script>

<div class="footer-bar {currentTheme}">
  <!-- User Login Status (includes Settings in menu when logged in) -->
  <UserLoginStatus on:openSettings={handleOpenSettings} />

  <!-- Scheduler Button -->
  <SchedulerButton on:click={handleSchedulerClick} />

  <!-- Spacer to push other buttons to the right -->
  <div class="flex-grow"></div>

  <!-- Settings Button (shown when not logged in) -->
  {#if !$userStore.isLoggedIn}
    <Tooltip content={$_t("Settings")}>
      <button
        class="function-button"
        on:click={handleOpenSettings}
        aria-label={$_t("Settings")}
      >
        <!-- Gear Icon SVG -->
        <svg xmlns="http://www.w3.org/2000/svg" class="button-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
    </Tooltip>
  {/if}
</div>

<!-- Scheduler Popup -->
<SchedulerPopup show={showSchedulerPopup} onClose={handleCloseSchedulerPopup} />

<style>
  .footer-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    border-top: 1px solid var(--color-term-border);
  }

  .flex-grow {
    flex-grow: 1;
  }

  /* Function button - Terminal theme (default) */
  .function-button {
    position: relative;
    padding: 0.5rem;
    border-radius: 9999px;
    background: #000000;
    border: 1px solid #00cc00;
    color: #00cc00;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .function-button:hover {
    transform: scale(1.1);
    background: rgba(0, 204, 0, 0.1);
  }

  .function-button:active {
    transform: scale(0.95);
  }

  .button-icon {
    width: 1.25rem;
    height: 1.25rem;
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .footer-bar.chatgpt {
    border-top: 1px solid var(--chat-border, #e5e5e5);
    gap: 0.5rem;
    padding: 0.5rem 1rem;
  }

  .footer-bar.chatgpt .function-button {
    background: transparent;
    border: none;
    border-radius: 0.5rem;
    color: var(--chat-text-muted, #8e8ea0);
  }

  .footer-bar.chatgpt .function-button:hover {
    background: var(--chat-button-hover, #ececec);
    color: var(--chat-text, #0d0d0d);
    transform: none;
  }
</style>
