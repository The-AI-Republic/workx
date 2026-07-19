<script lang="ts">
  import { NAV_ITEMS, isNavActive, type NavItem } from '../../stores/layoutStore';
  import { location, push } from 'svelte-spa-router';
  import { uiTheme } from '../../stores/themeStore';
  import { userStore } from '../../stores/userStore';
  import UserLoginStatus from '../common/UserLoginStatus.svelte';
  import NavTab from './NavTab.svelte';
  import LeftPanelSection from './LeftPanelSection.svelte';
  import ChatHistorySection from './ChatHistorySection.svelte';
  import SessionModeSwitch from './SessionModeSwitch.svelte';

  // Settings is normally reached from UserLoginStatus's logged-in avatar menu.
  // Logged-out users have no avatar menu, so surface a dedicated Settings entry
  // for them (theme/language live there) — restoring the access the removed
  // narrow-mode FooterBar used to provide.
  const SETTINGS_ITEM: NavItem = {
    id: 'settings',
    label: 'Settings',
    route: '/settings',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>',
  };

  // Usage lives in UserLoginStatus's logged-in avatar menu. Logged-out users
  // have no avatar menu, so surface a dedicated Usage entry for them — same
  // fallback the Settings entry above uses.
  const USAGE_ITEM: NavItem = {
    id: 'usage',
    label: 'Usage',
    route: '/usage',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="9" rx="1"></rect><rect x="10" y="7" width="4" height="14" rx="1"></rect><rect x="17" y="3" width="4" height="18" rx="1"></rect></svg>',
  };

  let {
    /**
     * Invoked after the user activates a navigation item. Lets a host (e.g. the
     * narrow-mode slide-in drawer in AppShell) close itself on navigation. No-op
     * by default so the docked wide-mode panel is unaffected.
     */
    onNavigate,
  }: {
    onNavigate?: () => void;
  } = $props();

  let currentTheme = $derived($uiTheme);

  function handleNavigate(data: { route: string }) {
    push(data.route);
    onNavigate?.();
  }
</script>

<div class="flex flex-col h-full w-full p-3 gap-2 overflow-y-auto
  {currentTheme === 'modern'
    ? 'bg-chat-surface dark:bg-chat-surface-dark'
    : 'bg-term-bg'}">
  <SessionModeSwitch />

  <LeftPanelSection>
    {#each NAV_ITEMS as item (item.id)}
      <NavTab
        {item}
        active={isNavActive(item.route, $location)}
        onNavigate={handleNavigate}
      />
    {/each}
  </LeftPanelSection>

  <ChatHistorySection />

  <div class="grow"></div>
  <div class="pt-3
    {currentTheme === 'modern'
      ? 'border-t border-chat-border dark:border-chat-border-dark'
      : 'border-t border-term-dim-green/30'}">
    {#if !$userStore.isLoggedIn}
      <NavTab
        item={USAGE_ITEM}
        active={isNavActive(USAGE_ITEM.route, $location)}
        onNavigate={handleNavigate}
      />
      <NavTab
        item={SETTINGS_ITEM}
        active={isNavActive(SETTINGS_ITEM.route, $location)}
        onNavigate={handleNavigate}
      />
    {/if}
    <UserLoginStatus />
  </div>
</div>
