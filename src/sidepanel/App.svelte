<script lang="ts">
  import { onMount } from 'svelte';
  import { MessageRouter, MessageType } from '../core/MessageRouter';
  import type { Event } from '../protocol/types';
  import type { EventMsg } from '../protocol/events';
  import type { ProcessedEvent } from '../types/ui';
  import TerminalContainer from './components/TerminalContainer.svelte';
  import TerminalMessage from './components/TerminalMessage.svelte';
  import MessageInput from './components/MessageInput.svelte';
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
  let currentTabId: number = -1; // Track current session's bound tab
  let agentReady = false;
  let healthStatus: { ready: boolean; message?: string; provider?: string; model?: string } = { ready: false };
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
      // Reset tabId when session resets
      currentTabId = -1;
    } catch (error) {
      console.error('Failed to reset session:', error);
    }
    // ========================================================================
    // ON-DEMAND SERVICE WORKER WAKE-UP (UI Side)
    // ========================================================================
    // Chrome terminates service workers after 30 seconds of inactivity.
    // When the side panel opens, the service worker might be asleep.
    // We retry with exponential backoff to give it time to wake up.
    //
    // Retry schedule: 200ms → 400ms → 800ms → 1.6s → 3.2s (max 8 attempts)
    // Total max wait time: ~12.6 seconds
    //
    // The service worker will auto-initialize on the first message.
    // See service-worker.ts lines 842-896 for wake-up implementation.
    // ========================================================================

    let retries = 0;
    const maxRetries = 8;
    let retryDelay = 200; // Start with 200ms

    while (retries < maxRetries) {
      try {
        // Test connection with ping
        await router.send(MessageType.PING);
        console.log('[App] Successfully connected to service worker');
        break;
      } catch (error) {
        retries++;
        const isPortClosed = error instanceof Error &&
          (error.message.includes('message port closed') ||
           error.message.includes('Extension context invalidated'));

        if (isPortClosed) {
          console.log(`[App] Service worker unavailable (attempt ${retries}/${maxRetries}), waiting for initialization...`);
        } else {
          console.warn(`[App] Connection attempt ${retries}/${maxRetries} failed:`, error);
        }

        if (retries >= maxRetries) {
          console.error('[App] Failed to connect to service worker after', maxRetries, 'attempts');
          console.error('[App] This may indicate the service worker crashed. Try reloading the extension.');
          break;
        }

        // Exponential backoff: 200ms, 400ms, 800ms, 1600ms, 3200ms
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 3200); // Cap at 3.2 seconds
      }
    }

    // Request session reset when side panel opens (non-critical)
    if (retries < maxRetries) {
      try {
        await router.requestSessionReset();
      } catch (error) {
        // Non-critical error - log but don't block initialization
        const errorMessage = error instanceof Error
          ? error.message
          : (error && typeof error === 'object' && 'message' in error)
            ? error.message
            : String(error);
        console.warn('Session reset failed (non-critical):', errorMessage);
      }
    }

    // Setup event handlers
    router.on(MessageType.EVENT, (message) => {
      const event = message.payload as Event;
      handleEvent(event);
    });

    router.on(MessageType.STATE_UPDATE, (message) => {
      // Update tabId if available in state update
      if (message.payload && 'tabId' in message.payload) {
        const newTabId = message.payload.tabId;
        currentTabId = newTabId;
      }
    });

    // Handle agent re-initialization (e.g., when model is changed)
    router.on(MessageType.AGENT_REINITIALIZED, (message) => {
      // Clear all messages and events for fresh start with new agent
      messages = [];
      processedEvents = [];
      isProcessing = false;
      eventProcessor.reset();
    });

    // Check connection
    checkConnection();

    // Fetch current session's tabId from storage
    await fetchCurrentTabId();

    return () => {
      router?.cleanup();
    };
  });

  /**
   * Fetch the current session's tabId from BrowserAgent session
   * US3: Get tabId from session on mount
   * If tabId is -1, automatically bind to the current active tab
   */
  async function fetchCurrentTabId() {
    try {
      // Request current session state from service worker
      const response = await router?.send(MessageType.GET_STATE);
      console.log('[App] Fetched session state:', response);

      if (response && typeof response.tabId === 'number') {
        const fetchedTabId = response.tabId;
        console.log(`[App] Fetched session tabId: ${fetchedTabId}`);

        // If no tab is bound (tabId === -1), get the current active tab ID
        // but don't bind yet - just prepare to send it as context with the first message
        if (fetchedTabId === -1) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const activeTab = tabs[0];
          if (activeTab?.id) {
            console.log(`[App] Session has no tab, will suggest active tab ${activeTab.id} to agent`);
            currentTabId = activeTab.id;
          } else {
            console.warn('[App] No active tab found');
            currentTabId = -1;
          }
        } else {
          currentTabId = fetchedTabId;
        }
      }
    } catch (error) {
      const isPortClosed = error instanceof Error &&
        (error.message.includes('message port closed') ||
         error.message.includes('Extension context invalidated'));

      if (isPortClosed) {
        console.warn('[App] Service worker not ready when fetching tabId, will retry later');
      } else {
        console.error('[App] Failed to fetch current tabId from session:', error);
      }

      // Fallback: get current active tab to send as suggestion
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs[0];
        if (activeTab?.id) {
          console.log(`[App] Using active tab ${activeTab.id} as fallback`);
          currentTabId = activeTab.id;
        } else {
          currentTabId = -1;
        }
      } catch (tabError) {
        console.warn('[App] Failed to get active tab:', tabError);
        currentTabId = -1;
      }
    }
  }

  /**
   * Bind the session to the current active tab
   * Called when session has no tab binding (tabId === -1)
   */
  async function bindToActiveTab() {
    try {
      // Get the current active tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];

      if (activeTab?.id) {
        console.log(`[App] Auto-binding to active tab: ${activeTab.id}`);
        // Update local state
        currentTabId = activeTab.id;
      } else {
        console.warn('[App] No active tab found for auto-binding');
        currentTabId = -1;
      }
    } catch (error) {
      console.error('[App] Failed to bind to active tab:', error);
      currentTabId = -1;
    }
  }

  async function checkConnection() {
    try {
      const response = await router?.send(MessageType.HEALTH_CHECK);
      isConnected = response?.type === MessageType.HEALTH_STATUS;

      if (response?.type === MessageType.HEALTH_STATUS) {
        agentReady = response.ready === true;
        healthStatus = {
          ready: response.ready === true,
          message: response.message,
          provider: response.provider,
          model: response.model,
        };
      } else {
        agentReady = false;
        healthStatus = { ready: false, message: 'Unable to check agent status' };
      }
    } catch (error) {
      const isPortClosed = error instanceof Error &&
        (error.message.includes('message port closed') ||
         error.message.includes('Extension context invalidated'));

      isConnected = false;
      agentReady = false;

      if (isPortClosed) {
        console.warn('[App] Service worker unavailable during health check');
        healthStatus = { ready: false, message: 'Service worker starting...' };
      } else {
        console.error('[App] Health check failed:', error);
        healthStatus = { ready: false, message: 'Connection error' };
      }
    }
  }

  /**
   * Handle manual tab selection from TabContext dropdown
   * Updates local state only - actual binding happens when user sends a message
   */
  async function handleTabSelected(event: CustomEvent<{ tabId: number }>) {
    const newTabId = event.detail.tabId;
    console.log(`[App] Tab selected: ${newTabId} (will bind on next message)`);

    // Update local state immediately for responsiveness
    currentTabId = newTabId;

    // Note: We don't immediately bind the tab to the session here.
    // Instead, the tab binding will happen when the user sends their next message,
    // and the service-worker will detect the context.tabId change and rebind then.
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
      // Note: We don't clear history here - user wants to see full conversation
      // History is only cleared when user explicitly clicks "New Conversation"
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
    if (!inputText.trim()) return;

    // Check if connected
    if (!isConnected) {
      messages = [...messages, {
        type: 'agent',
        content: 'Error: Not connected to agent. Please refresh the page.',
        timestamp: Date.now(),
      }];
      return;
    }

    // Check if agent is ready (has API key)
    if (!agentReady) {
      const providerName = healthStatus.provider || 'the selected provider';
      messages = [...messages, {
        type: 'agent',
        content: `Cannot send message: No API key configured for ${providerName}.\n\nPlease click the Settings button (⚙️) at the top right and configure your API key.`,
        timestamp: Date.now(),
      }];
      return;
    }

    const text = inputText.trim();
    inputText = '';

    // Add user message to processedEvents for chronological ordering
    const userEvent: ProcessedEvent = {
      id: `user_${Date.now()}`,
      category: 'message',
      timestamp: new Date(),
      title: 'user',
      content: text,
      style: { textColor: 'text-cyan-400' },
      streaming: false,
      collapsible: false,
    };
    processedEvents = [...processedEvents, userEvent];

    // Send to agent with tab context
    try {

      await router.sendSubmission({
        id: `user_${Date.now()}`,
        op: {
          type: 'UserInput',
          items: [{ type: 'text', text }],
        },
        context: {
          tabId: currentTabId, // Include current tab selection in context
        },
      });

    } catch (error) {
      console.error('Failed to send message:', error);

      const isPortClosed = error instanceof Error &&
        (error.message.includes('message port closed') ||
         error.message.includes('Extension context invalidated'));

      let errorMessage = 'Failed to send message. Please try again.';
      if (isPortClosed) {
        errorMessage = 'Service worker unavailable. The extension may be restarting. Please wait a moment and try again.';
      }

      messages = [...messages, {
        type: 'agent',
        content: errorMessage,
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
    // Re-check health status in case API key was added
    checkConnection();
  }

  function handleAuthUpdated(event: CustomEvent) {
    // Handle auth updates if needed
  }

  async function startNewConversation() {
    // Clear UI state
    messages = [];
    processedEvents = [];
    inputText = '';
    isProcessing = false;

    // Reset tab context
    currentTabId = -1;

    // Reset event processor
    eventProcessor.reset();

    // Request session reset from backend
    try {
      await router.requestSessionReset();

      // After session reset, auto-bind to the active tab
      // This ensures the new conversation starts with the current tab
      await bindToActiveTab();
    } catch (error) {
      console.error('Failed to reset session:', error);

      const isPortClosed = error instanceof Error &&
        (error.message.includes('message port closed') ||
         error.message.includes('Extension context invalidated'));

      let errorMessage = 'Failed to start new conversation. Please try again.';
      if (isPortClosed) {
        errorMessage = 'Service worker unavailable. Please wait a moment and try again.';
      }

      messages = [...messages, {
        type: 'agent',
        content: errorMessage,
        timestamp: Date.now(),
      }];
    }
  }
</script>

<div class="terminal-layout">
  <TerminalContainer>
    <div class="terminal-content-container">
      <!-- Status Line -->
      <div class="status-line flex justify-between mb-2">
        <TerminalMessage type="system" content="Browserx (Alpha)" />
        <div class="flex items-center space-x-2">
          {#if isProcessing}
            <TerminalMessage type="warning" content="[PROCESSING]" />
          {/if}
          {#if !isConnected}
            <TerminalMessage type="error" content="[DISCONNECTED]" />
          {:else if !agentReady}
            <TerminalMessage type="warning" content="[NO API KEY - CLICK SETTINGS ⚙️]" />
          {/if}
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

      <!-- Fixed bottom controls container -->
      <div class="bottom-controls">
        <!-- Input area -->
        <div class="input-area">
          <MessageInput
            bind:value={inputText}
            onSubmit={sendMessage}
            tabId={currentTabId}
            placeholder=">> Enter command..."
            on:tabSelected={handleTabSelected}
          />
        </div>

        <!-- Function menu -->
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
      </div>
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
    height: 100vh;
    overflow: hidden;
  }

  .terminal-content-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    max-width: 900px;
    margin: 0 auto;
    width: 100%;
  }

  .status-line {
    flex-shrink: 0;
  }

  .messages-container {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 1rem;
    /* This container will automatically take up remaining space */
  }

  /* Parent container for input area and function menu */
  .bottom-controls {
    flex-shrink: 0;
    background: var(--color-term-bg);
    border-top: 1px solid var(--color-term-border);
  }

  .input-area {
    padding: 0.5rem 0.5rem 0.5rem 0;
  }

  .function-menu {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    border-top: 1px solid var(--color-term-border);
  }

  .function-button {
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
