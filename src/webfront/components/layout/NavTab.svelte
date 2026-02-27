<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { NavItem } from '../../stores/layoutStore';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';

  export let item: NavItem;
  export let active: boolean;
  export let compact: boolean = false;

  let currentTheme: UITheme = 'terminal';

  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onDestroy(unsubTheme);

  const dispatch = createEventDispatcher();

  function handleClick() {
    dispatch('navigate', { route: item.route });
  }
</script>

<button
  class="nav-tab {currentTheme}"
  class:active
  class:compact
  on:click={handleClick}
  aria-current={active ? 'page' : undefined}
>
  <span class="icon">{@html item.icon}</span>
  {#if !compact}
    <span class="label">{$_t(item.label)}</span>
  {/if}
</button>

<style>
  /* Base layout */
  .nav-tab {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    cursor: pointer;
    border-radius: 6px;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    font-size: 14px;
    font-family: inherit;
    transition: background-color 0.15s ease;
  }

  .nav-tab.compact {
    justify-content: center;
    padding: 8px;
    width: auto;
  }

  /* Terminal theme (default) */
  .nav-tab {
    color: var(--color-term-dim-green, #00cc00);
  }

  .nav-tab.active {
    color: var(--color-term-green, #00ff00);
    background: rgba(0, 255, 0, 0.05);
  }

  .nav-tab:hover {
    background: rgba(0, 255, 0, 0.1);
  }

  .icon {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .icon :global(svg) {
    width: 20px;
    height: 20px;
    stroke: currentColor;
  }

  /* ============================================
     Modern Theme Overrides
     ============================================ */

  .nav-tab.modern {
    color: var(--chat-text-secondary, #6e6e80);
  }

  .nav-tab.modern.active {
    color: var(--chat-text, #0d0d0d);
    background: rgba(96, 165, 250, 0.1);
  }

  .nav-tab.modern:hover {
    background: var(--chat-button-hover, #ececec);
  }
</style>
