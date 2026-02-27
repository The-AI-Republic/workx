<script lang="ts">
  import { onDestroy } from 'svelte';
  import { push, location } from 'svelte-spa-router';
  import UserLoginStatus from '../common/UserLoginStatus.svelte';
  import { userStore } from '../../stores/userStore';
  import Tooltip from '../common/Tooltip.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import ApprovalModeIndicator from '../common/ApprovalModeIndicator.svelte';
  import { isWideMode, NAV_ITEMS, isNavActive } from '../../stores/layoutStore';
  import NavTab from './NavTab.svelte';

  let currentTheme: UITheme = 'terminal';

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onDestroy(unsubTheme);

  function handleNavigate(event: CustomEvent<{ route: string }>) {
    push(event.detail.route);
  }

  function handleOpenSettings() {
    push('/settings');
  }
</script>

{#if $isWideMode}
  <!-- Wide mode: minimal footer with just ApprovalModeIndicator -->
  <div class="flex items-center p-4
    {currentTheme === 'modern'
      ? 'gap-2 py-2 px-4 border-t border-chat-border dark:border-chat-border-dark'
      : 'gap-3 border-t border-term-dim-green/30'}">
    <ApprovalModeIndicator />
    <div class="grow"></div>
  </div>
{:else}
  <!-- Narrow mode: full footer with nav icons -->
  <div class="flex items-center p-4
    {currentTheme === 'modern'
      ? 'gap-2 py-2 px-4 border-t border-chat-border dark:border-chat-border-dark'
      : 'gap-3 border-t border-term-dim-green/30'}">
    <UserLoginStatus />

    <div class="flex flex-row gap-1 items-center">
      {#each NAV_ITEMS as item (item.id)}
        <NavTab
          {item}
          active={isNavActive(item.route, $location)}
          compact={true}
          on:navigate={handleNavigate}
        />
      {/each}
    </div>

    <ApprovalModeIndicator />

    <div class="grow"></div>

    {#if !$userStore.isLoggedIn}
      <Tooltip content={$_t("Settings")}>
        <button
          class="relative p-2 rounded-full flex items-center justify-center cursor-pointer transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-transparent border-none rounded-lg text-chat-text-muted dark:text-chat-text-muted-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark'
              : 'bg-term-bg border border-term-dim-green text-term-dim-green hover:scale-110 hover:bg-term-dim-green/10 active:scale-95'}"
          on:click={handleOpenSettings}
          aria-label={$_t("Settings")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </Tooltip>
    {/if}
  </div>
{/if}
