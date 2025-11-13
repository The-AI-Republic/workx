<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import TabContext from './TabContext.svelte';

  export let value: string = '';
  export let placeholder: string = 'Enter command...';
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

  <!-- Message Input with Prompt -->
  <div class="terminal-prompt flex items-start">
    <span class="text-term-dim-green mr-2 mt-1">&gt;</span>
    <textarea
      bind:value
      {placeholder}
      on:keydown={handleKeyDown}
      class="terminal-input flex-1"
      rows="1"
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

  .terminal-prompt {
    display: flex;
    align-items: flex-start;
  }

  .terminal-input {
    flex: 1;
    background-color: transparent;
    border: none;
    color: var(--term-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 14px;
    outline: none;
    resize: none;
    overflow-y: hidden;
    min-height: 20px;
    max-height: 200px;
    padding: 0;
    line-height: 1.5;
  }

  .terminal-input::placeholder {
    color: var(--term-dim-green, #00aa00);
    opacity: 0.6;
  }

  .terminal-input:focus {
    outline: none;
  }

  /* Auto-grow textarea based on content */
  .terminal-input {
    field-sizing: content;
  }
</style>
