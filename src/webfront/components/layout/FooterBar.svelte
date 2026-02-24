<script lang="ts">
  import { push, location } from 'svelte-spa-router';
  import UserLoginStatus from '../common/UserLoginStatus.svelte';
  import { userStore } from '../../stores/userStore';
  import Tooltip from '../common/Tooltip.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import ApprovalModeIndicator from '../common/ApprovalModeIndicator.svelte';
  import { isWideMode, NAV_ITEMS } from '../../stores/layoutStore';
  import NavTab from './NavTab.svelte';

  let currentTheme: UITheme = 'terminal';

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  function isActive(route: string, currentLocation: string): boolean {
    if (route === '/') {
      return currentLocation === '/' || (!currentLocation.startsWith('/settings') && !currentLocation.startsWith('/scheduler'));
    }
    return currentLocation === route;
  }

  function handleNavigate(event: CustomEvent<{ route: string }>) {
    push(event.detail.route);
  }
</script>

<div class="footer-bar {currentTheme}">
  {#if $isWideMode}
    <!-- Wide mode: minimal footer with just ApprovalModeIndicator -->
    <ApprovalModeIndicator />
    <div class="flex-grow"></div>
  {:else}
    <!-- Narrow mode: full footer with nav icons -->
    <UserLoginStatus />

    <div class="nav-icons">
      {#each NAV_ITEMS as item (item.id)}
        <NavTab
          {item}
          active={isActive(item.route, $location)}
          compact={true}
          on:navigate={handleNavigate}
        />
      {/each}
    </div>

    <div class="flex-grow"></div>

    <ApprovalModeIndicator />
  {/if}
</div>

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

  .nav-icons {
    display: flex;
    flex-direction: row;
    gap: 4px;
    align-items: center;
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .footer-bar.chatgpt {
    border-top: 1px solid var(--chat-border, #e5e5e5);
    gap: 0.5rem;
    padding: 0.5rem 1rem;
  }
</style>
