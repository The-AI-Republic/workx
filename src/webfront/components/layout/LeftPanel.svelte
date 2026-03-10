<script lang="ts">
  import { NAV_ITEMS, isNavActive } from '../../stores/layoutStore';
  import { location, push } from 'svelte-spa-router';
  import { uiTheme } from '../../stores/themeStore';
  import UserLoginStatus from '../common/UserLoginStatus.svelte';
  import NavTab from './NavTab.svelte';

  let currentTheme = $derived($uiTheme);

  function handleNavigate(data: { route: string }) {
    push(data.route);
  }
</script>

<div class="flex flex-col h-full w-full p-3
  {currentTheme === 'modern'
    ? 'bg-chat-surface dark:bg-chat-surface-dark'
    : 'bg-term-bg'}">
  <div class="flex flex-col gap-1">
    {#each NAV_ITEMS as item (item.id)}
      <NavTab
        {item}
        active={isNavActive(item.route, $location)}
        onNavigate={handleNavigate}
      />
    {/each}
  </div>
  <div class="grow"></div>
  <div class="pt-3
    {currentTheme === 'modern'
      ? 'border-t border-chat-border dark:border-chat-border-dark'
      : 'border-t border-term-dim-green/30'}">
    <UserLoginStatus />
  </div>
</div>
