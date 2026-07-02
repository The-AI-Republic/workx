<script lang="ts">
  import { location, push } from 'svelte-spa-router';
  import { MORE_ITEMS, isNavActive } from '../../stores/layoutStore';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import PopupCard from '../common/PopupCard.svelte';

  let currentTheme = $derived($uiTheme);
  let showMenu = $state(false);

  function toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    showMenu = !showMenu;
  }

  function closeMenu() {
    showMenu = false;
  }

  function handleSelect(route: string) {
    showMenu = false;
    push(route);
  }

  function handleTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      showMenu = !showMenu;
    } else if (event.key === 'Escape') {
      showMenu = false;
    }
  }
</script>

<PopupCard title={$_t('More')} show={showMenu} onClose={closeMenu}>
  {#snippet trigger()}<div>
    <button
      class="flex flex-row items-center gap-2 w-full cursor-pointer rounded-md border-none bg-transparent p-2.5 px-4 text-sm font-[inherit] transition-colors duration-150
        {currentTheme === 'modern'
          ? showMenu
            ? 'text-chat-text dark:text-chat-text-dark bg-chat-button-hover dark:bg-chat-button-hover-dark'
            : 'text-chat-text-secondary dark:text-chat-text-secondary-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
          : showMenu
            ? 'text-term-green bg-term-green/10'
            : 'text-term-dim-green hover:bg-term-green/10'}"
      onclick={toggleMenu}
      onkeydown={handleTriggerKeydown}
      aria-haspopup="menu"
      aria-expanded={showMenu}
    >
      <span class="icon">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <circle cx="5" cy="12" r="1.5"></circle>
          <circle cx="12" cy="12" r="1.5"></circle>
          <circle cx="19" cy="12" r="1.5"></circle>
        </svg>
      </span>
      <span>{$_t('More')}</span>
    </button>
  </div>{/snippet}

  {#snippet content()}<div class="min-w-[180px]" role="menu">
    {#each MORE_ITEMS as item (item.id)}
      {@const active = isNavActive(item.route, $location)}
      <button
        class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none cursor-pointer text-sm text-left transition-colors duration-150
          {currentTheme === 'modern'
            ? active
              ? 'text-chat-text dark:text-chat-text-dark font-chat rounded-md m-1 w-[calc(100%-8px)] bg-chat-primary/10 dark:bg-chat-primary-dark/10'
              : 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat rounded-md m-1 w-[calc(100%-8px)] hover:bg-white/10'
            : active
              ? 'text-term-green font-terminal bg-term-green/10'
              : 'text-term-green font-terminal hover:bg-term-green/10'}"
        onclick={() => handleSelect(item.route)}
        role="menuitem"
        aria-current={active ? 'page' : undefined}
      >
        <span class="icon shrink-0">{@html item.icon}</span>
        <span>{$_t(item.label)}</span>
      </button>
    {/each}
  </div>{/snippet}
</PopupCard>

<style>
  .icon {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .icon :global(svg) {
    width: 18px;
    height: 18px;
    stroke: currentColor;
  }
</style>
