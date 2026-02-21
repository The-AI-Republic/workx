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
    // Prefer rendering above; only render below if insufficient space above
    renderAbove = spaceAbove >= 200 || spaceAbove > spaceBelow;
  }

  // Recalculate position when dropdown becomes visible
  $: if (visible) {
    // Use setTimeout to ensure DOM is rendered before measuring
    setTimeout(updatePosition, 0);
  }
</script>

{#if visible && commands.length > 0}
  <div
    class="absolute inset-x-0 z-50 max-h-[200px] overflow-y-auto rounded border border-[var(--color-term-dim-green,#00cc00)] bg-black/95 {currentTheme === 'chatgpt' ? 'chatgpt-dropdown' : ''}"
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
        class="flex items-baseline gap-2 px-3 py-1.5 cursor-pointer transition-colors duration-100 text-base
          {i === selectedIndex ? 'bg-green-500/15' : ''}"
        role="option"
        aria-selected={i === selectedIndex}
        on:mouseenter={() => dispatch('hover', i)}
        on:click={() => dispatch('select', item)}
      >
        <span class="font-semibold font-mono text-base text-[var(--color-term-green,#00ff00)] shrink-0">/{item.command.name}</span>
        {#if item.command.argumentHint}
          <span class="text-base text-[var(--color-term-dim-green,#00cc00)] opacity-70 shrink-0">{item.command.argumentHint}</span>
        {/if}
        <span class="text-base text-green-500/60 truncate">{item.command.description}</span>
      </div>
    {/each}
  </div>
{:else if visible && commands.length === 0}
  <div
    class="absolute inset-x-0 z-50 max-h-[200px] overflow-y-auto rounded border border-[var(--color-term-dim-green,#00cc00)] bg-black/95 {currentTheme === 'chatgpt' ? 'chatgpt-dropdown' : ''}"
    class:bottom-full={renderAbove}
    class:mb-1={renderAbove}
    class:top-full={!renderAbove}
    class:mt-1={!renderAbove}
    role="listbox"
  >
    <div class="flex items-baseline gap-2 px-3 py-1.5 cursor-default opacity-50 italic text-base">No matching commands</div>
  </div>
{/if}

<style>
  /* ChatGPT theme overrides */
  .chatgpt-dropdown {
    background-color: var(--chat-dropdown-bg, #ffffff);
    border: 1px solid var(--chat-border, #e5e5e5);
    border-radius: 0.75rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }

  .chatgpt-dropdown :global(div[role="option"].bg-green-500\/15),
  .chatgpt-dropdown :global(div[role="option"]):hover {
    background-color: var(--chat-hover-bg, #f5f5f5);
  }

  .chatgpt-dropdown :global(span.font-mono) {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .chatgpt-dropdown :global(span.text-green-500\/60),
  .chatgpt-dropdown :global(span.opacity-70) {
    color: var(--chat-text-muted, #8e8ea0);
  }

  @media (prefers-color-scheme: dark) {
    .chatgpt-dropdown {
      background-color: var(--chat-dropdown-bg-dark, #2d2d2d);
      border-color: var(--chat-border-dark, #444444);
    }

    .chatgpt-dropdown :global(div[role="option"].bg-green-500\/15),
    .chatgpt-dropdown :global(div[role="option"]):hover {
      background-color: rgba(255, 255, 255, 0.1);
    }

    .chatgpt-dropdown :global(span.font-mono) {
      color: var(--chat-text-dark, #ececec);
    }
  }
</style>
