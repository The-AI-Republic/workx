<script lang="ts">
  import { NAV_ITEMS, isNavActive } from '../../stores/layoutStore';
  import { location, push } from 'svelte-spa-router';
  import { AUTH_ROUTE_PATHS, HOME_PAGE_BASE_URL } from '../../lib/constants';
  import { uiTheme } from '../../stores/themeStore';
  import { overlayScroll } from '../../lib/actions/overlayScroll';
  import UserLoginStatus from '../common/UserLoginStatus.svelte';
  import MoreMenu from './MoreMenu.svelte';
  import NavTab from './NavTab.svelte';
  import LeftPanelSection from './LeftPanelSection.svelte';
  import ChatHistorySection from './ChatHistorySection.svelte';
  import SessionModeSwitch from './SessionModeSwitch.svelte';

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
  const hasHostedAuth = Boolean(HOME_PAGE_BASE_URL && AUTH_ROUTE_PATHS.login);

  function handleNavigate(data: { route: string }) {
    push(data.route);
    onNavigate?.();
  }
</script>

<!-- Positioned, clipped host so the floating overlay scrollbar (see
     lib/actions/overlayScroll.ts) can anchor to it without scrolling away or
     reserving gutter width. The inner element is the sole scroll surface. -->
<div
  class="relative h-full w-full overflow-hidden
  {currentTheme === 'modern' ? 'bg-chat-surface dark:bg-chat-surface-dark' : 'bg-term-bg'}"
>
  <div
    use:overlayScroll
    class="flex flex-col h-full w-full p-3 gap-2 overflow-y-auto
    {currentTheme === 'modern' ? 'bg-chat-surface dark:bg-chat-surface-dark' : 'bg-term-bg'}"
  >
    <SessionModeSwitch />

    <LeftPanelSection>
      {#each NAV_ITEMS as item (item.id)}
        <NavTab {item} active={isNavActive(item.route, $location)} onNavigate={handleNavigate} />
      {/each}
    </LeftPanelSection>

    <ChatHistorySection />

    <div class="grow"></div>
    {#if hasHostedAuth}
      <div
        class="pt-3
      {currentTheme === 'modern'
          ? 'border-t border-chat-border dark:border-chat-border-dark'
          : 'border-t border-term-dim-green/30'}"
      >
        <UserLoginStatus {onNavigate} />
      </div>
    {:else}
      <div class="flex flex-col gap-1">
        <MoreMenu {onNavigate} />
      </div>
    {/if}
  </div>
</div>
