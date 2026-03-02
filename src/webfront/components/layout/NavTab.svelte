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
  class="flex flex-row items-center gap-2 cursor-pointer rounded-md border-none bg-transparent text-sm font-[inherit] transition-colors duration-150
    {compact ? 'justify-center p-2 w-auto' : 'p-2.5 px-4 w-full'}
    {currentTheme === 'modern'
      ? active
        ? 'text-chat-text dark:text-chat-text-dark bg-chat-primary/10 dark:bg-chat-primary-dark/10'
        : 'text-chat-text-secondary dark:text-chat-text-secondary-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
      : active
        ? 'text-term-green bg-term-green/5'
        : 'text-term-dim-green hover:bg-term-green/10'}"
  on:click={handleClick}
  aria-current={active ? 'page' : undefined}
>
  <span class="icon">{@html item.icon}</span>
  {#if !compact}
    <span>{$_t(item.label)}</span>
  {/if}
</button>

<style>
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
</style>
