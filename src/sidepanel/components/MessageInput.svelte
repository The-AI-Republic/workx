<script lang="ts">
  import { createEventDispatcher, onMount, afterUpdate } from 'svelte';
  import TabContext from './TabContext.svelte';

  export let value: string = '';
  export let placeholder: string = '>> Enter command...';
  export let onSubmit: (value: string) => void = () => {};
  export let onStop: () => void = () => {};
  export let tabId: number = -1;
  export let isProcessing: boolean = false;

  const dispatch = createEventDispatcher();

  let showButtonTooltip = false;
  let textareaEl: HTMLTextAreaElement;
  const minVisibleLines = 3;
  const maxVisibleLines = 6;
  const lineHeightPx = 21; // matches 14px font with 1.5 line-height
  const verticalPaddingPx = 16; // padding-top + padding-bottom (8px each)
  const minHeightPx = lineHeightPx * minVisibleLines + verticalPaddingPx;
  const maxHeightPx = lineHeightPx * maxVisibleLines + verticalPaddingPx;

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

  function handleButtonClick() {
    if (isProcessing) {
      onStop();
    } else if (value.trim()) {
      onSubmit(value);
    }
  }

  function autoResize() {
    if (!textareaEl) return;

    textareaEl.style.height = 'auto';

    const rawHeight = textareaEl.scrollHeight;
    const usableHeight = Math.max(rawHeight - verticalPaddingPx, 0);
    const contentLines = Math.ceil(usableHeight / lineHeightPx);
    const clampedLines = Math.max(minVisibleLines, Math.min(contentLines, maxVisibleLines));
    const nextHeight = clampedLines * lineHeightPx + verticalPaddingPx;

    textareaEl.style.height = `${nextHeight}px`;
    textareaEl.style.overflowY = contentLines > maxVisibleLines ? 'auto' : 'hidden';
  }

  onMount(() => {
    if (textareaEl) {
      textareaEl.style.height = `${minHeightPx}px`;
    }
    autoResize();
  });

  afterUpdate(() => {
    autoResize();
  });
</script>

<div class="message-input-container">
  <!-- Tab Context Display -->
  <div class="tab-context-wrapper mb-2">
    <TabContext {tabId} on:tabSelected={handleTabSelected} />
  </div>

  <!-- Message Input -->
  <div class="terminal-input-wrapper">
    <div class="terminal-input-shell">
      <textarea
        bind:this={textareaEl}
        bind:value
        {placeholder}
        rows={minVisibleLines}
        on:keydown={handleKeyDown}
        on:input={autoResize}
        class="terminal-input"
        aria-label="Message input"
      />
      <div class="input-action-bar">
        <!-- Send/Stop Button -->
        <div
          class="action-button-wrapper"
          on:mouseenter={() => showButtonTooltip = true}
          on:mouseleave={() => showButtonTooltip = false}
        >
          <button
            class="action-button"
            class:stop={isProcessing}
            class:disabled={!isProcessing && !value.trim()}
            on:click={handleButtonClick}
            disabled={!isProcessing && !value.trim()}
            aria-label={isProcessing ? 'Stop the current task' : 'Send the message'}
          >
            {#if isProcessing}
              <!-- Stop Icon (Square) -->
              <svg xmlns="http://www.w3.org/2000/svg" class="action-icon" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
            {:else}
              <!-- Send Icon (Arrow) -->
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="action-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            {/if}
          </button>

          <!-- Tooltip -->
          {#if showButtonTooltip}
            <div class="button-tooltip">
              {#if isProcessing}
                Stop the current task run
              {:else if !value.trim()}
                Please type a valid command
              {:else}
                Send the message
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
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

  .terminal-input-shell {
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 79px;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .terminal-input-shell:focus-within {
    border-color: var(--color-term-bright-green, #33ff00);
    box-shadow: 0 0 0 1px var(--color-term-bright-green, #33ff00);
  }

  .terminal-input {
    width: 100%;
    background-color: transparent;
    border: none;
    color: var(--term-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 14px;
    outline: none;
    resize: none;
    overflow-y: hidden;
    padding: 8px 12px;
    line-height: 1.5;
    height: 79px;
    min-height: 79px;
    max-height: 142px;
  }

  .terminal-input::placeholder {
    color: var(--term-dim-green, #00aa00);
    opacity: 0.6;
  }

  .input-action-bar {
    border-top: 1px solid rgba(0, 255, 0, 0.25);
    padding: 6px 8px;
    display: flex;
    justify-content: flex-end;
    background-color: rgba(0, 0, 0, 0.85);
  }

  .action-button-wrapper {
    position: relative;
    display: inline-flex;
  }

  /* Send/Stop Button */
  .action-button {
    width: 44px;
    height: 44px;
    padding: 8px;
    border: 1px solid var(--color-term-green, #00ff00);
    border-radius: 4px;
    background-color: var(--color-term-bg, #000000); /* solid black */
    color: var(--color-term-green, #00ff00);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .action-button:hover:not(:disabled) {
    transform: scale(1.1);
  }

  .action-button:active:not(:disabled) {
    transform: scale(0.95);
  }

  .action-button:disabled {
    cursor: not-allowed;
    color: rgba(51, 255, 0, 0.4);
    border-color: rgba(51, 255, 0, 0.25);
  }

  .action-button:disabled:hover {
    transform: none;
  }

  .action-button.stop {
    border-color: var(--color-term-red, #ff0000);
    color: var(--color-term-red, #ff0000);
  }

  .action-icon {
    width: 24px;
    height: 24px;
  }

  /* Button Tooltip */
  .button-tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    padding: 4px 8px;
    background-color: var(--color-term-bg, #000000); /* solid black, NOT transparent */
    border: 1px solid var(--color-term-green, #00ff00);
    border-radius: 4px;
    color: var(--color-term-bright-green, #33ff00);
    font-size: 12px;
    white-space: nowrap;
    z-index: 100;
    animation: fadeIn 0.2s ease;
    pointer-events: none;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

</style>
