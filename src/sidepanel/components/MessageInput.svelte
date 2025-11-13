<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import TabContext from './TabContext.svelte';

  export let value: string = '';
  export let placeholder: string = '>> Enter command...';
  export let onSubmit: (value: string) => void = () => {};
  export let tabId: number = -1;

  const dispatch = createEventDispatcher();

  function handleKeyDown(event: KeyboardEvent) {
    // Submit on Enter (without Shift)
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (value.trim()) {
        onSubmit(value);
      }
    }
    // Allow Shift+Enter for new line (default textarea behavior)
  }

  function handleTabSelected(event: CustomEvent<{ tabId: number }>) {
    // Forward the event to parent component
    dispatch('tabSelected', event.detail);
  }
</script>

<div class="message-input-container">
  <!-- Tab Context Display -->
  <div class="tab-context-wrapper mb-2">
    <TabContext {tabId} on:tabSelected={handleTabSelected} />
  </div>

  <!-- Message Input -->
  <div class="terminal-input-wrapper">
    <textarea
      bind:value
      {placeholder}
      on:keydown={handleKeyDown}
      class="terminal-input"
      rows="2"
      aria-label="Message input"
    />
  </div>
</div>

<style>
  .message-input-container {
    width: 100%;
  }

  .tab-context-wrapper {
    margin-bottom: 0.5rem;
  }

  .terminal-input-wrapper {
    width: 100%;
  }

  .terminal-input {
    width: 100%;
    background-color: transparent;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 2px;
    color: var(--term-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 14px;
    outline: none;
    resize: vertical;
    overflow-y: auto;
    min-height: calc(1.5em * 2 + 8px); /* 2 lines of text + padding */
    max-height: 200px;
    padding: 4px 8px;
    line-height: 1.5;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .terminal-input::placeholder {
    color: var(--term-dim-green, #00aa00);
    opacity: 0.6;
  }

  .terminal-input:focus {
    outline: none;
    border-color: var(--color-term-bright-green, #33ff00);
    box-shadow: 0 0 0 1px var(--color-term-bright-green, #33ff00);
  }

</style>
