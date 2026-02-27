<script lang="ts">
  import { onDestroy } from 'svelte';
  import { NAV_ITEMS, isNavActive } from '../../stores/layoutStore';
  import { location, push } from 'svelte-spa-router';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import UserLoginStatus from '../common/UserLoginStatus.svelte';
  import NavTab from './NavTab.svelte';

  let currentTheme: UITheme = 'terminal';

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onDestroy(unsubTheme);

  function handleNavigate(event: CustomEvent<{ route: string }>) {
    push(event.detail.route);
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
        on:navigate={handleNavigate}
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
