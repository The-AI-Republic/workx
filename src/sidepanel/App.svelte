<script lang="ts">
  import { onMount } from 'svelte';
  import { MessageRouter, MessageType } from '../core/MessageRouter';
  import type { Event } from '../protocol/types';
  import type { EventMsg } from '../protocol/events';
  import type { ProcessedEvent } from '../types/ui';
  import TerminalContainer from './components/TerminalContainer.svelte';
  import TerminalMessage from './components/TerminalMessage.svelte';
  import TerminalInput from './components/TerminalInput.svelte';
  import Settings from './Settings.svelte';
  import EventDisplay from './components/event_display/EventDisplay.svelte';
  import { EventProcessor } from './components/event_display/EventProcessor';
  import { welcomeAsciiLines } from './constants/welcomeAscii';

  let router: MessageRouter;
  let eventProcessor: EventProcessor;
  let messages: Array<{ type: 'user' | 'agent'; content: string; timestamp: number }> = [];
  let processedEvents: ProcessedEvent[] = [];
  let inputText = '';
  let isConnected = false;
  let isProcessing = false;
  let showSettings = false;
  let showTooltip = false;
  let showNewConvTooltip = false;
  let showWelcome = false;
  let scrollContainer: HTMLDivElement;
  $: showWelcome =
    !isProcessing && processedEvents.length === 0 && messages.length === 0;

  onMount(async () => {
    // Clear messages from previous session
    messages = [];
    processedEvents = [];

    // Initialize EventProcessor
    eventProcessor = new EventProcessor();

    // Initialize router
    router = new MessageRouter('sidepanel');

    // Request session reset when side panel opens
    try {
      await router.requestSessionReset();
      console.log('Session reset on side panel open');
    } catch (error) {
      console.error('Failed to reset session:', error);
    }

    // Setup event handlers
    router.on(MessageType.EVENT, (message) => {
      const event = message.payload as Event;
      handleEvent(event);
    });

    router.on(MessageType.STATE_UPDATE, (message) => {
      console.log('State update:', message.payload);
    });

    // Check connection
    checkConnection();

    // Periodic connection check
    const interval = setInterval(checkConnection, 5000);

    return () => {
      clearInterval(interval);
      router?.cleanup();
    };
  });

  async function checkConnection() {
    try {
      const response = await router?.send(MessageType.PING);
      isConnected = response?.type === MessageType.PONG;
    } catch {
      isConnected = false;
    }
  }

  function handleEvent(event: Event) {
    const msg = event.msg;

    // Process event through EventProcessor
    const processed = eventProcessor.processEvent(event);

    if (processed) {
      processedEvents = [...processedEvents, processed];

      // Auto-scroll to bottom if user is at bottom
      if (scrollContainer) {
        const isAtBottom =
          scrollContainer.scrollHeight - scrollContainer.scrollTop <=
          scrollContainer.clientHeight + 100;

        if (isAtBottom) {
          setTimeout(() => {
            scrollContainer.scrollTo({
              top: scrollContainer.scrollHeight,
              behavior: 'smooth'
            });
          }, 100);
        }
      }
    }

    // Update processing state
    if (msg.type === 'TaskStarted') {
      isProcessing = true;
      // Clear history on new task
      processedEvents = [];
      eventProcessor.reset();
    } else if (msg.type === 'TaskComplete' || msg.type === 'TaskFailed') {
      isProcessing = false;
    }

    // Keep legacy Error message handling for backward compatibility
    // Note: AgentMessage case removed - agent messages are now handled by EventProcessor
    switch (msg.type) {
      case 'Error':
        if ('data' in msg && msg.data && 'message' in msg.data) {
          messages = [...messages, {
            type: 'agent',
            content: `Error: ${msg.data.message}`,
            timestamp: Date.now(),
          }];
        }
        break;
    }
  }

  async function sendMessage() {
    if (!inputText.trim() || !isConnected) return;

    const text = inputText.trim();
    inputText = '';

    // Add user message
    messages = [...messages, {
      type: 'user',
      content: text,
      timestamp: Date.now(),
    }];

    // Send to agent
    try {
      await router.sendSubmission({
        id: `user_${Date.now()}`,
        op: {
          type: 'UserInput',
          items: [{ type: 'text', text }],
        },
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      messages = [...messages, {
        type: 'agent',
        content: 'Failed to send message. Please try again.',
        timestamp: Date.now(),
      }];
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getMessageType(message: { type: 'user' | 'agent'; content: string }): 'default' | 'warning' | 'error' | 'input' | 'system' {
    if (message.type === 'user') return 'input';
    if (message.content.toLowerCase().startsWith('error:')) return 'error';
    if (message.content.toLowerCase().includes('warning')) return 'warning';
    if (message.content.toLowerCase().includes('system')) return 'system';
    return 'default';
  }

  function toggleSettings() {
    showSettings = !showSettings;
  }

  function handleSettingsClose() {
    showSettings = false;
  }

  function handleAuthUpdated(event: CustomEvent) {
    // Handle auth updates if needed
    console.log('Auth updated:', event.detail);
  }

  async function startNewConversation() {
    // Clear UI state
    messages = [];
    processedEvents = [];
    inputText = '';
    isProcessing = false;

    // Reset event processor
    eventProcessor.reset();

    // Request session reset from backend
    try {
      await router.requestSessionReset();
      console.log('New conversation started - session reset');
    } catch (error) {
      console.error('Failed to reset session:', error);
      messages = [...messages, {
        type: 'agent',
        content: 'Failed to start new conversation. Please try again.',
        timestamp: Date.now(),
      }];
    }
  }
</script>

<div class="terminal-layout">
  <TerminalContainer>
    <!-- Status Line -->
    <div class="flex justify-between mb-2">
      <TerminalMessage type="system" content="Browserx For Chrome v0.0.1 (By AI Republic)" />
      <div class="flex items-center space-x-2">
        {#if isProcessing}
          <TerminalMessage type="warning" content="[PROCESSING]" />
        {/if}
        <TerminalMessage
          type={isConnected ? 'system' : 'error'}
          content={isConnected ? '[CONNECTED]' : '[DISCONNECTED]'}
        />
      </div>
    </div>

    <!-- Messages - scrollable area -->
    <div class="messages-container" bind:this={scrollContainer}>
      {#if showWelcome}
        <div class="welcome-screen" role="presentation">
          <pre class="welcome-ascii">
            {#each welcomeAsciiLines as line, index (index)}
              <span class={line.color}>{line.text}</span>
            {/each}
          </pre>
          <p class="welcome-subtitle text-term-bright-green">
            General in-browser AI agent for work tasks
          </p>
          <p class="welcome-subtitle text-term-dim-green">
            Developed and supported by AI Republic
          </p>
          <a
            class="welcome-link"
            href="https://airepublic.com"
            target="_blank"
            rel="noreferrer noopener"
          >
            Learn more
          </a>
        </div>
      {/if}

      {#each messages as message (message.timestamp)}
        <TerminalMessage type={message.type === 'user' ? 'input' : getMessageType(message)} content={message.content} />
      {/each}

      {#each processedEvents as event (event.id)}
        <EventDisplay {event} />
      {/each}
    </div>

    <!-- Input area -->
    <div class="input-area">
      <div class="terminal-prompt flex items-center">
        <span class="text-term-dim-green mr-2">&gt;</span>
        <TerminalInput
          bind:value={inputText}
          onSubmit={sendMessage}
          placeholder="Enter command..."
        />
      </div>
    </div>

    <!-- Fixed bottom function menu -->
    <div class="function-menu">
      <!-- New Conversation Button -->
      <button
        class="function-button p-2 rounded-full bg-term-bg border border-term-dim-green hover:bg-term-bg-hover transition-colors relative"
        on:click={startNewConversation}
        on:mouseenter={() => showNewConvTooltip = true}
        on:mouseleave={() => showNewConvTooltip = false}
        aria-label="Start New Conversation"
      >
        <!-- New Conversation Icon SVG (Plus/Refresh) -->
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-term-dim-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>

        <!-- Tooltip -->
        {#if showNewConvTooltip}
          <div class="tooltip absolute bottom-full mb-2 right-0 px-2 py-1 bg-term-bg border border-term-dim-green rounded text-xs text-term-dim-green whitespace-nowrap">
            New Conversation
          </div>
        {/if}
      </button>

      <!-- Settings Button -->
      <button
        class="function-button p-2 rounded-full bg-term-bg border border-term-dim-green hover:bg-term-bg-hover transition-colors relative"
        on:click={toggleSettings}
        on:mouseenter={() => showTooltip = true}
        on:mouseleave={() => showTooltip = false}
        aria-label="Settings"
      >
        <!-- Gear Icon SVG -->
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-term-dim-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>

        <!-- Tooltip -->
        {#if showTooltip}
          <div class="tooltip absolute bottom-full mb-2 right-0 px-2 py-1 bg-term-bg border border-term-dim-green rounded text-xs text-term-dim-green whitespace-nowrap">
            Settings
          </div>
        {/if}
      </button>
    </div>
  </TerminalContainer>
</div>

<!-- Settings Modal -->
{#if showSettings}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
    <div class="bg-term-bg-dark border border-term-border rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto">
      <Settings
        on:authUpdated={handleAuthUpdated}
        on:close={handleSettingsClose}
      />
    </div>
  </div>
{/if}

<style>
  /* Component-specific styles */

  .terminal-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    position: relative;
  }

  .messages-container {
    flex: 1;
    overflow-y: auto;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    /* Reserve space for input and function menu */
    max-height: calc(100vh - 200px);
  }

  .input-area {
    padding: 0.5rem 0;
    background: var(--color-term-bg);
    position: relative;
    z-index: 10;
  }

  .function-menu {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    background: var(--color-term-bg);
    z-index: 30;
  }

  .function-button {
    z-index: 40;
    transition: all 0.2s ease;
  }

  .function-button:hover {
    transform: scale(1.1);
  }

  .function-button:active {
    transform: scale(0.95);
  }

  .tooltip {
    animation: fadeIn 0.2s ease;
    z-index: 50;
  }

  .welcome-screen {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 1.5rem;
    border: 1px solid var(--color-term-dim-green);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.6);
    margin-bottom: 1.5rem;
    max-width: 100%;
  }

  .welcome-ascii {
    margin: 0;
    font-family: var(--font-terminal);
    font-size: 0.4rem;
    line-height: 1.0;
    white-space: pre;
  }

  .welcome-ascii span {
    display: block;
  }

  .welcome-subtitle {
    margin: 0;
    font-size: 0.95rem;
  }

  .welcome-link {
    color: var(--color-term-bright-green);
    text-decoration: underline;
  }

  .welcome-link:hover,
  .welcome-link:focus {
    color: var(--color-term-yellow);
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
