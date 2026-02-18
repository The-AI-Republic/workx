<script lang="ts">
  import { createEventDispatcher, afterUpdate, onMount } from 'svelte';
  import type { FilteredCommand } from '../commands';
  import { uiTheme, type UITheme } from '../stores/themeStore';

  export let commands: FilteredCommand[] = [];
  export let selectedIndex: number = 0;
  export let visible: boolean = false;

  const dispatch = createEventDispatcher<{
    hover: number;
    select: FilteredCommand;
  }>();

  let currentTheme: UITheme = 'terminal';
  let dropdownEl: HTMLDivElement;
  let renderAbove = true;

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

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
    class="command-dropdown {currentTheme}"
    class:above={renderAbove}
    class:below={!renderAbove}
    bind:this={dropdownEl}
    role="listbox"
    aria-label="Available commands"
  >
    {#each commands as item, i}
      <div
        class="command-item"
        class:selected={i === selectedIndex}
        role="option"
        aria-selected={i === selectedIndex}
        on:mouseenter={() => dispatch('hover', i)}
        on:click={() => dispatch('select', item)}
      >
        <span class="command-name">/{item.command.name}</span>
        {#if item.command.argumentHint}
          <span class="command-hint">{item.command.argumentHint}</span>
        {/if}
        <span class="command-desc">{item.command.description}</span>
      </div>
    {/each}
  </div>
{:else if visible && commands.length === 0}
  <div
    class="command-dropdown {currentTheme}"
    class:above={renderAbove}
    class:below={!renderAbove}
    role="listbox"
  >
    <div class="command-item empty">No matching commands</div>
  </div>
{/if}

<style>
  .command-dropdown {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 50;
    max-height: 200px;
    overflow-y: auto;
    border-radius: 4px;

    /* Terminal theme defaults */
    background-color: rgba(0, 0, 0, 0.95);
    border: 1px solid var(--color-term-dim-green, #00cc00);
  }

  /* Adaptive positioning */
  .command-dropdown.above {
    bottom: 100%;
    margin-bottom: 4px;
  }

  .command-dropdown.below {
    top: 100%;
    margin-top: 4px;
  }

  .command-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    transition: background-color 0.1s;
  }

  .command-item.selected {
    background-color: rgba(0, 255, 0, 0.15);
  }

  .command-item.empty {
    cursor: default;
    opacity: 0.5;
    font-style: italic;
  }

  .command-name {
    font-weight: 600;
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 13px;
    color: var(--color-term-green, #00ff00);
    flex-shrink: 0;
  }

  .command-hint {
    font-size: 12px;
    color: var(--color-term-dim-green, #00cc00);
    opacity: 0.7;
    flex-shrink: 0;
  }

  .command-desc {
    font-size: 12px;
    color: rgba(0, 255, 0, 0.6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ChatGPT theme */
  .command-dropdown.chatgpt {
    background-color: var(--chat-dropdown-bg, #ffffff);
    border: 1px solid var(--chat-border, #e5e5e5);
    border-radius: 0.75rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }

  .command-dropdown.chatgpt .command-item.selected {
    background-color: var(--chat-hover-bg, #f5f5f5);
  }

  .command-dropdown.chatgpt .command-name {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .command-dropdown.chatgpt .command-hint {
    color: var(--chat-text-muted, #8e8ea0);
  }

  .command-dropdown.chatgpt .command-desc {
    color: var(--chat-text-muted, #8e8ea0);
  }

  @media (prefers-color-scheme: dark) {
    .command-dropdown.chatgpt {
      background-color: var(--chat-dropdown-bg-dark, #2d2d2d);
      border-color: var(--chat-border-dark, #444444);
    }

    .command-dropdown.chatgpt .command-item.selected {
      background-color: rgba(255, 255, 255, 0.1);
    }

    .command-dropdown.chatgpt .command-name {
      color: var(--chat-text-dark, #ececec);
    }
  }
</style>
