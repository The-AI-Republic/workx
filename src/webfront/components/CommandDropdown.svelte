<script lang="ts">
  import { createEventDispatcher, afterUpdate } from 'svelte';
  import type { FilteredCommand } from '../commands';
  import { uiTheme } from '../stores/themeStore';

  export let commands: FilteredCommand[] = [];
  export let selectedIndex: number = 0;
  export let visible: boolean = false;

  const dispatch = createEventDispatcher<{
    hover: number;
    select: FilteredCommand;
  }>();

  let dropdownEl: HTMLDivElement;
  let renderAbove = true;

  $: currentTheme = $uiTheme;

  // Scroll selected item into view when selectedIndex changes
  afterUpdate(() => {
    if (!visible || !dropdownEl) return;
    const items = dropdownEl.querySelectorAll('[role="option"]');
    const selected = items[selectedIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  });

  // Adaptive positioning: check space above vs below
  function updatePosition(): void {
    if (!dropdownEl?.parentElement) return;
    const parentRect = dropdownEl.parentElement.getBoundingClientRect();
    const spaceAbove = parentRect.top;
    const spaceBelow = window.innerHeight - parentRect.bottom;
    renderAbove = spaceAbove >= 200 || spaceAbove > spaceBelow;
  }

  $: if (visible) {
    setTimeout(updatePosition, 0);
  }
</script>

{#if visible && commands.length > 0}
  <div
    class="absolute inset-x-0 z-50 max-h-[200px] overflow-y-auto
      {currentTheme === 'chatgpt'
        ? 'chatgpt-dropdown bg-chat-card dark:bg-chat-card-dark border border-chat-border dark:border-chat-border-dark rounded-xl shadow-lg'
        : 'rounded border border-term-dim-green bg-black/95'}"
    class:bottom-full={renderAbove}
    class:mb-1={renderAbove}
    class:top-full={!renderAbove}
    class:mt-1={!renderAbove}
    bind:this={dropdownEl}
    role="listbox"
    aria-label="Available commands"
  >
    {#each commands as item, i}
      <div
        class="flex items-baseline gap-2 px-3 py-1.5 cursor-pointer transition-colors duration-100 text-sm
          {currentTheme === 'chatgpt'
            ? (i === selectedIndex ? 'bg-chat-card-hover dark:bg-chat-card-hover-dark' : '')
            : (i === selectedIndex ? 'bg-green-500/15' : '')}"
        role="option"
        aria-selected={i === selectedIndex}
        on:mouseenter={() => dispatch('hover', i)}
        on:click={() => dispatch('select', item)}
      >
        <span class="font-semibold text-sm shrink-0
          {currentTheme === 'chatgpt'
            ? 'font-chat text-chat-text dark:text-chat-text-dark'
            : 'font-mono text-term-green'}">/{item.command.name}</span>
        {#if item.command.argumentHint}
          <span class="text-sm shrink-0
            {currentTheme === 'chatgpt'
              ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
              : 'text-term-dim-green opacity-70'}">{item.command.argumentHint}</span>
        {/if}
        <span class="text-sm truncate
          {currentTheme === 'chatgpt'
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'text-green-500/60'}">{item.command.description}</span>
      </div>
    {/each}
  </div>
{:else if visible && commands.length === 0}
  <div
    class="absolute inset-x-0 z-50 max-h-[200px] overflow-y-auto
      {currentTheme === 'chatgpt'
        ? 'chatgpt-dropdown bg-chat-card dark:bg-chat-card-dark border border-chat-border dark:border-chat-border-dark rounded-xl shadow-lg'
        : 'rounded border border-term-dim-green bg-black/95'}"
    class:bottom-full={renderAbove}
    class:mb-1={renderAbove}
    class:top-full={!renderAbove}
    class:mt-1={!renderAbove}
    role="listbox"
  >
    <div class="flex items-baseline gap-2 px-3 py-1.5 cursor-default opacity-50 italic text-sm">No matching commands</div>
  </div>
{/if}

<style>
  /* ChatGPT theme :global() styles for hover on child options */
  .chatgpt-dropdown :global(div[role="option"]):hover {
    background-color: var(--color-chat-card-hover);
  }

  @media (prefers-color-scheme: dark) {
    .chatgpt-dropdown :global(div[role="option"]):hover {
      background-color: var(--color-chat-card-hover-dark);
    }
  }
</style>
