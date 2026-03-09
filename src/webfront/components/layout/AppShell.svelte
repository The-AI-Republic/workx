<script lang="ts">
  import { onDestroy } from 'svelte';
  import { isWideMode } from '../../stores/layoutStore';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import LeftPanel from './LeftPanel.svelte';
  import FooterBar from './FooterBar.svelte';

  let currentTheme: UITheme = 'terminal';

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onDestroy(unsubTheme);
</script>

<div class="flex flex-row h-screen overflow-hidden">
  {#if $isWideMode}
    <div class="shrink-0 overflow-visible relative z-1
      {currentTheme === 'modern'
        ? 'border-r border-chat-border dark:border-chat-border-dark'
        : 'border-r border-term-dim-green'}"
      style="width: var(--left-panel-width, 220px)"
    >
      <LeftPanel />
    </div>
  {/if}
  <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
    <div class="content-area flex-1 flex flex-col min-h-0 overflow-hidden">
      <slot />
    </div>
    <div class="shrink-0">
      <FooterBar />
    </div>
  </div>
</div>

<style>
  .content-area > :global(*) {
    flex: 1 1 0%;
    min-height: 0;
    overflow: hidden;
  }
</style>
