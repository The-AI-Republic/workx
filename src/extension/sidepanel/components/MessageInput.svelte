<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import TabContext from './common/TabContext.svelte';
  import ModelSelection from './chat/ModelSelection.svelte';
  import Tooltip from './common/Tooltip.svelte';
  import ChatHistoryPopup from './chat/ChatHistoryPopup.svelte';
  import CommandDropdown from './CommandDropdown.svelte';
  import CommandError from './CommandError.svelte';
  import { uiTheme, type UITheme } from '../stores/themeStore';
  import { platform } from '../stores/platformStore';
  import { _t } from '../lib/i18n';
  import { commandRegistry, parseCommandInput } from '../commands';
  import type { FilteredCommand } from '../commands';
  import { initBuiltinCommands } from '../commands/builtinCommands';

  export let value: string = '';
  export let placeholder: string = '>> Enter command...';
  export let onSubmit: (value: string) => void = () => {};
  export let onStop: () => void = () => {};
  export let onSelectConversation: (conversationId: string) => void = () => {};
  export let onNewConversation: () => void = () => {};
  export let tabId: number = -1;
  export let isProcessing: boolean = false;

  const dispatch = createEventDispatcher<{
    modelChanged: { modelId: string; modelName: string };
    tabSelected: { tabId: number };
    showScheduleModal: { input: string };
    commandOutput: { title: string; content: string };
    openSettings: void;
  }>();

  let isFocused = false;
  let currentTheme: UITheme = 'terminal';

  // Long-press detection for scheduling
  const LONG_PRESS_DURATION = 500; // milliseconds
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let isLongPress = false;

  // Command mode state
  let isCommandMode = false;
  let filterText = '';
  let showDropdown = false;
  let selectedIndex = 0;
  let filteredCommands: FilteredCommand[] = [];
  let errorMessage: string | null = null;
  let errorTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastExecuted = new Map<string, number>();
  let builtinsInitialized = false;

  const DEBOUNCE_MS = 500;

  // Initialize built-in commands once
  function ensureBuiltins(): void {
    if (builtinsInitialized) return;
    builtinsInitialized = true;
    initBuiltinCommands({
      onNewConversation,
      onCommandOutput: (title: string, content: string) => {
        dispatch('commandOutput', { title, content });
      },
      onOpenSettings: () => {
        dispatch('openSettings');
      },
    });
  }

  // Reactive tooltip content based on state
  $: buttonTooltipContent = isProcessing
    ? $_t('Stop the current task run')
    : !value.trim()
      ? $_t('Please type a valid command')
      : $_t('Long press to schedule task');

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  function handleModelChanged(event: CustomEvent<{ modelId: string; modelName: string }>) {
    dispatch('modelChanged', event.detail);
  }

  function resetCommandMode(): void {
    isCommandMode = false;
    filterText = '';
    showDropdown = false;
    selectedIndex = 0;
    filteredCommands = [];
  }

  function clearError(): void {
    errorMessage = null;
    if (errorTimeout) {
      clearTimeout(errorTimeout);
      errorTimeout = null;
    }
  }

  function showError(message: string): void {
    clearError();
    errorMessage = message;
    errorTimeout = setTimeout(() => {
      errorMessage = null;
      errorTimeout = null;
    }, 60000);
  }

  function updateFilter(): void {
    const query = filterText;
    filteredCommands = commandRegistry.filter(query);
    selectedIndex = 0;
  }

  function executeCommand(commandName: string, args?: string): void {
    const now = Date.now();
    const lastTime = lastExecuted.get(commandName);
    if (lastTime && now - lastTime < DEBOUNCE_MS) {
      return; // debounced
    }

    const command = commandRegistry.get(commandName);
    if (!command) {
      showError(`Unknown command: /${commandName}. Type / to see available commands.`);
      resetCommandMode();
      value = '';
      return;
    }

    lastExecuted.set(commandName, now);
    resetCommandMode();
    value = '';

    try {
      command.action(args);
    } catch (err) {
      showError(`Command /${commandName} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    ensureBuiltins();

    // Clear error on any typing
    if (errorMessage && event.key.length === 1) {
      clearError();
    }

    // Command mode keyboard handling
    if (isCommandMode) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (filteredCommands.length > 0) {
          selectedIndex = (selectedIndex + 1) % filteredCommands.length;
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (filteredCommands.length > 0) {
          selectedIndex = (selectedIndex - 1 + filteredCommands.length) % filteredCommands.length;
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        resetCommandMode();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (filteredCommands.length > 0 && selectedIndex < filteredCommands.length) {
          // Execute selected command from dropdown
          const selected = filteredCommands[selectedIndex];
          executeCommand(selected.command.name);
        } else {
          // Try to parse and execute directly
          const parsed = parseCommandInput(value);
          if (parsed) {
            executeCommand(parsed.commandName, parsed.args);
          }
        }
        return;
      }
    }

    // Normal mode: Submit on Enter (without Shift)
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (value.trim()) {
        // Check if it looks like a command
        if (value.trim().startsWith('/')) {
          const parsed = parseCommandInput(value);
          if (parsed) {
            ensureBuiltins();
            executeCommand(parsed.commandName, parsed.args);
            return;
          }
        }
        onSubmit(value);
      }
    }
    // Allow Shift+Enter for new line (default textarea behavior)
  }

  function handleInput(): void {
    ensureBuiltins();

    // Clear error on input
    if (errorMessage) {
      clearError();
    }

    // Check for command mode activation: "/" as first char in field
    if (value === '/') {
      isCommandMode = true;
      showDropdown = true;
      filterText = '';
      updateFilter();
      return;
    }

    // Update filter if in command mode
    if (isCommandMode && value.startsWith('/')) {
      filterText = value.slice(1).split(' ')[0]; // filter by command name only
      updateFilter();
      return;
    }

    // Exit command mode if "/" was deleted or text doesn't start with /
    if (isCommandMode && !value.startsWith('/')) {
      resetCommandMode();
    }
  }

  function handleBlur(): void {
    isFocused = false;
    // Delay closing to allow click events on dropdown to fire
    setTimeout(() => {
      if (!isFocused) {
        resetCommandMode();
      }
    }, 150);
  }

  function handlePaste(event: ClipboardEvent): void {
    ensureBuiltins();
    // If field is empty and pasted text starts with "/", enter command mode after paste
    if (value === '' || value === undefined) {
      const pastedText = event.clipboardData?.getData('text') || '';
      if (pastedText.startsWith('/')) {
        // Let the paste happen, then check in next tick
        setTimeout(() => {
          if (value.startsWith('/')) {
            isCommandMode = true;
            showDropdown = true;
            filterText = value.slice(1).split(' ')[0];
            updateFilter();
          }
        }, 0);
      }
    }
  }

  function handleDropdownHover(index: number): void {
    selectedIndex = index;
  }

  function handleDropdownSelect(command: FilteredCommand): void {
    executeCommand(command.command.name);
  }

  function handleTabSelected(event: CustomEvent<{ tabId: number }>) {
    // Forward the event to parent component
    dispatch('tabSelected', event.detail);
  }

  function handleButtonClick() {
    // If this was a long press, don't trigger normal click
    if (isLongPress) {
      isLongPress = false;
      return;
    }

    if (isProcessing) {
      onStop();
    } else if (value.trim()) {
      // Check if it looks like a command
      if (value.trim().startsWith('/')) {
        ensureBuiltins();
        const parsed = parseCommandInput(value);
        if (parsed) {
          executeCommand(parsed.commandName, parsed.args);
          return;
        }
      }
      onSubmit(value);
    }
  }

  function handlePointerDown(e: PointerEvent) {
    // Only handle long press for send action (not stop)
    if (isProcessing || !value.trim()) return;

    isLongPress = false;
    pressTimer = setTimeout(() => {
      isLongPress = true;
      // Dispatch event to show schedule modal
      dispatch('showScheduleModal', { input: value });
    }, LONG_PRESS_DURATION);
  }

  function handlePointerUp() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function handlePointerLeave() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  onDestroy(() => {
    if (errorTimeout) {
      clearTimeout(errorTimeout);
    }
  });
</script>

<div class="message-input-container {currentTheme}">
  <!-- Tab Context Display -->
  <div class="tab-context-wrapper mb-2">
    {#if platform.hasTabSelection}
      <!-- Only apply mousedown preventDefault to TabContext area for drag behavior -->
      <div class="tab-context-area" on:mousedown|preventDefault>
        <TabContext {tabId} on:tabSelected={handleTabSelected} />
      </div>
    {/if}
    <div class="tab-context-spacer"></div>
    <!-- Top Right Button Group - NOT inside mousedown preventDefault area -->
    <div class="top-right-buttons">
      <ChatHistoryPopup onSelectConversation={onSelectConversation} />
      <Tooltip content={$_t("New Conversation")} placement="left">
        <button
          class="new-conv-button"
          on:click={onNewConversation}
          aria-label="Start New Conversation"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="new-conv-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 5C5.34315 5 4 6.34315 4 8V16C4 17.6569 5.34315 19 7 19H17C18.6569 19 20 17.6569 20 16V12.5C20 11.9477 20.4477 11.5 21 11.5C21.5523 11.5 22 11.9477 22 12.5V16C22 18.7614 19.7614 21 17 21H7C4.23858 21 2 18.7614 2 16V8C2 5.23858 4.23858 3 7 3H10.5C11.0523 3 11.5 3.44772 11.5 4C11.5 4.55228 11.0523 5 10.5 5H7Z"/>
            <path fill-rule="evenodd" clip-rule="evenodd" d="M18.8431 3.58579C18.0621 2.80474 16.7957 2.80474 16.0147 3.58579L11.6806 7.91992L11.0148 11.9455C10.8917 12.6897 11.537 13.3342 12.281 13.21L16.3011 12.5394L20.6347 8.20582C21.4158 7.42477 21.4158 6.15844 20.6347 5.37739L18.8431 3.58579ZM13.1933 11.0302L13.5489 8.87995L17.4289 5L19.2205 6.7916L15.34 10.6721L13.1933 11.0302Z"/>
          </svg>
        </button>
      </Tooltip>
    </div>
  </div>

  <!-- Message Input -->
  <div class="terminal-input-wrapper">
    <!-- Command Error (above input) -->
    <CommandError message={errorMessage} visible={errorMessage !== null} />

    <!-- Command Dropdown (above input) -->
    <CommandDropdown
      commands={filteredCommands}
      {selectedIndex}
      visible={showDropdown}
      on:hover={(e) => handleDropdownHover(e.detail)}
      on:select={(e) => handleDropdownSelect(e.detail)}
    />

    <div class="terminal-input-shell">
      <textarea
        bind:value
        {placeholder}
        on:keydown={handleKeyDown}
        on:input={handleInput}
        on:paste={handlePaste}
        on:focus={() => isFocused = true}
        on:blur={handleBlur}
        class="terminal-input"
        class:expanded={isFocused}
        aria-label="Message input"
      />
      <div class="input-action-bar">
        <!-- Model Selection - Left aligned -->
        <div class="model-selection-wrapper">
          <ModelSelection on:modelChanged={handleModelChanged} />
        </div>

        <!-- Spacer to push button to the right -->
        <div class="action-bar-spacer"></div>

        <!-- Send/Stop Button -->
        <div class="action-button-wrapper">
          <Tooltip content={buttonTooltipContent}>
            <button
              class="action-button"
              class:stop={isProcessing}
              class:disabled={!isProcessing && !value.trim()}
              on:click={handleButtonClick}
              on:pointerdown={handlePointerDown}
              on:pointerup={handlePointerUp}
              on:pointerleave={handlePointerLeave}
              disabled={!isProcessing && !value.trim()}
              aria-label={isProcessing ? 'Stop the current task' : 'Long press to schedule task'}
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
          </Tooltip>
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
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* Wrapper for TabContext with mousedown prevention for drag behavior */
  .tab-context-area {
    display: contents;
  }

  .tab-context-spacer {
    flex: 1;
  }

  .terminal-input-wrapper {
    width: 100%;
    position: relative;
  }

  /* Top Right Button Group - flexbox container for new conv and chat history */
  .top-right-buttons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* New Conversation Button - Top Right of input box */
  .new-conv-button {
    padding: 0.25rem;
    border-radius: 4px;
    background: transparent;
    border: 1px solid rgba(128, 128, 128, 0.5);
    color: rgba(128, 128, 128, 0.8);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .new-conv-button:hover {
    border-color: rgba(128, 128, 128, 0.8);
    color: rgba(160, 160, 160, 1);
    background: rgba(128, 128, 128, 0.1);
  }

  .new-conv-button:active {
    transform: scale(0.95);
  }

  .new-conv-icon {
    width: 17px;
    height: 17px;
  }

  .terminal-input-shell {
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    overflow: hidden;
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
    height: 37px;
    transition: height 0.2s ease;
  }

  .terminal-input.expanded {
    height: 142px;
    overflow-y: auto;
  }

  .terminal-input::placeholder {
    color: var(--term-dim-green, #00aa00);
    opacity: 0.6;
  }

  .input-action-bar {
    border-top: 1px solid rgba(0, 255, 0, 0.25);
    padding: 6px 8px;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    background-color: rgba(0, 0, 0, 0.85);
  }

  .model-selection-wrapper {
    flex-shrink: 0;
  }

  .action-bar-spacer {
    flex: 1;
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


  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .message-input-container.chatgpt .terminal-input-shell {
    border: 1px solid var(--chat-input-border, #e5e5e5);
    border-radius: 1.5rem;
    background-color: var(--chat-input-bg, #f4f4f4);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }

  .message-input-container.chatgpt .terminal-input-shell:focus-within {
    border-color: var(--chat-input-focus-border, #60a5fa);
    box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.2);
  }

  .message-input-container.chatgpt .terminal-input {
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    padding: 12px 16px;
    caret-color: var(--chat-text, #0d0d0d);
  }

  /* Dark mode cursor should be light */
  @media (prefers-color-scheme: dark) {
    .message-input-container.chatgpt .terminal-input {
      caret-color: #ffffff;
    }
  }

  .message-input-container.chatgpt .terminal-input::placeholder {
    color: var(--chat-text-muted, #8e8ea0);
    opacity: 1;
  }

  .message-input-container.chatgpt .input-action-bar {
    border-top: 1px solid var(--chat-border, #e5e5e5);
    padding: 8px 12px;
    background-color: transparent;
  }

  .message-input-container.chatgpt .action-button {
    width: 36px;
    height: 36px;
    padding: 6px;
    border: none;
    border-radius: 50%;
    background-color: var(--chat-send-button-bg, #0d0d0d);
    color: var(--chat-send-button-text, #ffffff);
    transition: background-color 0.15s, transform 0.15s;
  }

  .message-input-container.chatgpt .action-button:hover:not(:disabled) {
    background-color: var(--chat-send-button-hover, #2d2d2d);
    transform: none;
  }

  .message-input-container.chatgpt .action-button:disabled {
    background-color: var(--chat-send-button-disabled, #e5e5e5);
    color: var(--chat-text-muted, #8e8ea0);
    border: none;
  }

  .message-input-container.chatgpt .action-button.stop {
    background-color: var(--chat-stop-button-bg, #ef4444);
    color: #ffffff;
    border: none;
  }

  .message-input-container.chatgpt .action-button.stop:hover:not(:disabled) {
    background-color: var(--chat-stop-button-hover, #dc2626);
  }


  .message-input-container.chatgpt .action-icon {
    width: 18px;
    height: 18px;
  }

  /* ChatGPT Theme - New Conversation Button */
  .message-input-container.chatgpt .new-conv-button {
    border: none;
    border-radius: 0.375rem;
    color: var(--chat-text-muted, #8e8ea0);
  }

  .message-input-container.chatgpt .new-conv-button:hover {
    background: var(--chat-button-hover, #ececec);
    color: var(--chat-text, #0d0d0d);
  }

</style>
