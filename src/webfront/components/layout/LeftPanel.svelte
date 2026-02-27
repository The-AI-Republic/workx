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

<div class="left-panel {currentTheme}">
  <div class="nav-section">
    {#each NAV_ITEMS as item (item.id)}
      <NavTab
        {item}
        active={isNavActive(item.route, $location)}
        on:navigate={handleNavigate}
      />
    {/each}
  </div>
  <div class="spacer"></div>
  <div class="user-section">
    <UserLoginStatus />
  </div>
</div>

<style>
  .left-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    padding: 12px;
    background: var(--color-term-bg, #000000);
  }

  .nav-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .spacer {
    flex-grow: 1;
  }

  .user-section {
    border-top: 1px solid rgba(0, 204, 0, 0.3);
    padding-top: 12px;
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .left-panel.chatgpt {
    background: var(--chat-card-bg, #f7f7f8);
  }

  .left-panel.chatgpt .user-section {
    border-top: 1px solid var(--chat-border, #e5e5e5);
  }
</style>
