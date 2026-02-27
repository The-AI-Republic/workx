<script lang="ts">
  import { onDestroy } from 'svelte';
  import { isWideMode } from '../../stores/layoutStore';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import LeftPanel from './LeftPanel.svelte';

  let currentTheme: UITheme = 'terminal';

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onDestroy(unsubTheme);
</script>

<div class="app-shell {currentTheme}">
  {#if $isWideMode}
    <div class="left-panel-container">
      <LeftPanel />
    </div>
  {/if}
  <div class="main-content">
    <slot />
  </div>
</div>

<style>
  .app-shell {
    display: flex;
    flex-direction: row;
    height: 100vh;
    overflow: hidden;
  }

  .left-panel-container {
    width: var(--left-panel-width, 220px);
    flex-shrink: 0;
    overflow: visible;
    border-right: 1px solid var(--color-term-dim-green, #00cc00);
    position: relative;
    z-index: 1;
  }

  .main-content {
    flex: 1;
    overflow: hidden;
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .app-shell.chatgpt .left-panel-container {
    border-right: 1px solid var(--chat-border, #e5e5e5);
  }
</style>
