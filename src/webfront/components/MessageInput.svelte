<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import TabContext from './common/TabContext.svelte';
  import ModelSelection from './chat/ModelSelection.svelte';
  import Tooltip from './common/Tooltip.svelte';
  import ChatHistoryPopup from './chat/ChatHistoryPopup.svelte';
  import CommandDropdown from './CommandDropdown.svelte';
  import CommandError from './CommandError.svelte';
  import ApprovalModeIndicator from './common/ApprovalModeIndicator.svelte';
  import { uiTheme } from '../stores/themeStore';
  import { platform } from '../stores/platformStore';
  import { schedulerStore } from '../stores/schedulerStore';
  import { t, _t } from '../lib/i18n';
  import { commandRegistry, parseCommandInput } from '../commands';
  import type { FilteredCommand } from '../commands';
  import { initBuiltinCommands, registerSkillCommands } from '../commands/builtinCommands';

  export let value: string = '';
  export let placeholder: string = t('>> Enter command...');
  export let onSubmit: (value: string) => void = () => {};
  export let onStop: () => void = () => {};
  export let onSelectConversation: (conversationId: string) => void = () => {};
  export let onNewConversation: () => void = () => {};
  export let tabId: number = -1;
  export let isProcessing: boolean = false;

  const dispatch = createEventDispatcher<{
    modelChanged: { modelId: string; modelName: string };
    tabSelected: { tabId: number };
    commandOutput: { title: string; content: string };
  }>();

  let isFocused = false;

  $: currentTheme = $uiTheme;

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
      onNewConversation: () => onNewConversation(),
      onCommandOutput: (title: string, content: string) => {
        dispatch('commandOutput', { title, content });
      },
      onOpenSettings: () => {
        push('/settings');
      },
    });

    // Load skill commands asynchronously (non-blocking)
    registerSkillCommands((text) => {
      onSubmit(text);
    });
  }

  // Reactive tooltip content based on state
  $: buttonTooltipContent = isProcessing
    ? $_t('Stop the current task run')
    : !value.trim()
      ? $_t('Please type a valid command')
      : $_t('Long press to schedule task');

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

  async function executeCommand(commandName: string, args?: string): Promise<void> {
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
      await command.action(args);
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
      // Set pending input and navigate to scheduler page
      schedulerStore.setPendingInput(value);
      push('/scheduler');
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

<div class="w-full">
  <!-- Tab Context Display -->
  <div class="mb-2 flex items-center gap-2">
    {#if platform.hasTabSelection}
      <!-- Only apply mousedown preventDefault to TabContext area for drag behavior -->
      <div class="contents" on:mousedown|preventDefault>
        <TabContext {tabId} on:tabSelected={handleTabSelected} />
      </div>
    {/if}
    <ApprovalModeIndicator />
    <div class="flex-1"></div>
    <!-- Top Right Button Group - NOT inside mousedown preventDefault area -->
    <div class="flex items-center gap-2">
      <ChatHistoryPopup onSelectConversation={onSelectConversation} />
      <Tooltip content={$_t("New Conversation")} placement="left">
        <button
          class="p-1 bg-transparent cursor-pointer flex items-center justify-center transition-all duration-200 active:scale-95
            {currentTheme === 'modern'
              ? 'border-none rounded-md text-chat-text-muted dark:text-chat-text-muted-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark'
              : 'border border-gray-500/50 rounded text-gray-500/80 hover:border-gray-500/80 hover:text-gray-400 hover:bg-gray-500/10'}"
          on:click={onNewConversation}
          aria-label={$_t("Start New Conversation")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 5C5.34315 5 4 6.34315 4 8V16C4 17.6569 5.34315 19 7 19H17C18.6569 19 20 17.6569 20 16V12.5C20 11.9477 20.4477 11.5 21 11.5C21.5523 11.5 22 11.9477 22 12.5V16C22 18.7614 19.7614 21 17 21H7C4.23858 21 2 18.7614 2 16V8C2 5.23858 4.23858 3 7 3H10.5C11.0523 3 11.5 3.44772 11.5 4C11.5 4.55228 11.0523 5 10.5 5H7Z"/>
            <path fill-rule="evenodd" clip-rule="evenodd" d="M18.8431 3.58579C18.0621 2.80474 16.7957 2.80474 16.0147 3.58579L11.6806 7.91992L11.0148 11.9455C10.8917 12.6897 11.537 13.3342 12.281 13.21L16.3011 12.5394L20.6347 8.20582C21.4158 7.42477 21.4158 6.15844 20.6347 5.37739L18.8431 3.58579ZM13.1933 11.0302L13.5489 8.87995L17.4289 5L19.2205 6.7916L15.34 10.6721L13.1933 11.0302Z"/>
          </svg>
        </button>
      </Tooltip>
    </div>
  </div>

  <!-- Message Input -->
  <div class="w-full relative">
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

    <div
      class="input-shell flex flex-col overflow-hidden transition-all duration-200
        {currentTheme === 'modern'
          ? 'border border-chat-input-border dark:border-chat-input-border-dark rounded-3xl bg-chat-input dark:bg-chat-input-dark shadow-sm focus-within:border-chat-input-focus dark:focus-within:border-chat-input-focus-dark focus-within:shadow-[0_0_0_2px_rgba(96,165,250,0.2)]'
          : 'border border-term-dim-green rounded bg-black/70 focus-within:border-term-bright-green focus-within:shadow-[0_0_0_1px_var(--color-term-bright-green)]'}"
    >
      <textarea
        bind:value
        {placeholder}
        on:keydown={handleKeyDown}
        on:input={handleInput}
        on:paste={handlePaste}
        on:focus={() => isFocused = true}
        on:blur={handleBlur}
        style="--textarea-py: {currentTheme === 'modern' ? '0.75rem' : '0.5rem'}"
        class="terminal-textarea w-full bg-transparent border-none outline-none resize-none overflow-y-auto leading-relaxed text-sm
          {currentTheme === 'modern'
            ? 'text-chat-text dark:text-chat-text-dark font-chat px-4 py-3 caret-chat-text dark:caret-white'
            : 'text-term-green font-terminal px-3 py-2'}"
        aria-label="Message input"
      />
      <div
        class="flex items-center justify-start gap-2
          {currentTheme === 'modern'
            ? 'border-t border-chat-border dark:border-chat-border-dark px-3 py-2 bg-transparent'
            : 'border-t border-green-500/25 px-2 py-1.5 bg-black/85'}"
      >
        <!-- Model Selection - Left aligned -->
        <div class="shrink-0">
          <ModelSelection on:modelChanged={handleModelChanged} />
        </div>

        <!-- Spacer to push button to the right -->
        <div class="flex-1"></div>

        <!-- Send/Stop Button -->
        <div class="relative inline-flex">
          <Tooltip content={buttonTooltipContent}>
            <button
              class="flex items-center justify-center cursor-pointer transition-all duration-200
                {currentTheme === 'modern'
                  ? 'w-9 h-9 p-1.5 border-none rounded-full'
                    + (isProcessing
                      ? ' bg-chat-stop dark:bg-chat-stop-dark text-white hover:bg-chat-stop-hover dark:hover:bg-chat-stop-hover-dark'
                      : (!value.trim()
                        ? ' bg-chat-send-disabled dark:bg-chat-send-disabled-dark text-chat-text-muted dark:text-chat-text-muted-dark cursor-not-allowed'
                        : ' bg-chat-send dark:bg-chat-send-dark text-chat-send-text dark:text-chat-send-text-dark hover:bg-chat-send-hover dark:hover:bg-chat-send-hover-dark'))
                  : 'w-11 h-11 p-2 border rounded'
                    + (isProcessing
                      ? ' border-term-red text-term-red hover:scale-110 active:scale-95'
                      : (!value.trim()
                        ? ' cursor-not-allowed text-term-bright-green/40 border-term-bright-green/25'
                        : ' border-term-green bg-term-bg text-term-green hover:scale-110 active:scale-95'))}"
              on:click={handleButtonClick}
              on:pointerdown={handlePointerDown}
              on:pointerup={handlePointerUp}
              on:pointerleave={handlePointerLeave}
              disabled={!isProcessing && !value.trim()}
              aria-label={isProcessing ? $_t('Stop the current task') : $_t('Long press to schedule task')}
            >
              {#if isProcessing}
                <!-- Stop Icon (Square) -->
                <svg xmlns="http://www.w3.org/2000/svg" class="{currentTheme === 'modern' ? 'w-[18px] h-[18px]' : 'w-6 h-6'}" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              {:else}
                <!-- Send Icon (Arrow) -->
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="{currentTheme === 'modern' ? 'w-[18px] h-[18px]' : 'w-6 h-6'}"
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
  /* Fixed height: 3 lines of text + vertical padding */
  .terminal-textarea {
    height: calc(3lh + 2 * var(--textarea-py, 0.5rem));
  }

  /* Placeholder styles - terminal theme */
  .terminal-textarea::placeholder {
    color: var(--color-term-dim-green);
    opacity: 0.6;
  }

  /* Placeholder styles - modern theme (detected via font-family) */
  :global(.modern) .terminal-textarea::placeholder {
    color: var(--color-chat-text-muted);
    opacity: 1;
  }

  :global(.dark) :global(.modern) .terminal-textarea::placeholder {
    color: var(--color-chat-text-muted-dark);
  }
</style>
