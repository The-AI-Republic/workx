<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { MessageRouter, MessageType } from '@/core/MessageRouter';
  import type { TaskStatusChangedEvent } from '@/models/types/SchedulerContracts';
  import type { Event } from '@/protocol/types';
  import type { ProcessedEvent } from '@/types/ui';
  import { STYLE_PRESETS } from '@/types/ui';
  import TerminalContainer from '../../components/TerminalContainer.svelte';
  import TerminalMessage from '../../components/TerminalMessage.svelte';
  import MessageInput from '../../components/MessageInput.svelte';
  import Settings from '../../Settings.svelte';
  import EventDisplay from '../../components/event_display/EventDisplay.svelte';
  import { EventProcessor } from '../../components/event_display/EventProcessor';
  import { welcomeAsciiLines } from '../../constants/welcomeAscii';
  // Theme store
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  // Token usage visibility store
  import { showTokenUsage } from '../../stores/tokenUsageStore';
  import { AgentConfig } from '@/config/AgentConfig';
  // User components and store
  import { getLoginPageUrl, userStore } from '../../stores/userStore';
  import FooterBar from '../../components/layout/FooterBar.svelte';
  // Agent store for auth mode tracking
  import { agentStore } from '../../stores/agentStore';
  // i18n
  import { _t } from '../../lib/i18n';
  // Scheduler components
  import ScheduleTaskModal from '../../components/scheduler/ScheduleTaskModal.svelte';

  let router: MessageRouter;
  let eventProcessor: EventProcessor;
  let messages: Array<{ type: 'user' | 'agent'; content: string; timestamp: number }> = [];
  let processedEvents: ProcessedEvent[] = [];
  let inputText = '';
  let isConnected = false;
  let isProcessing = false;
  let showSettings = false;
  let showWelcome = false;
  let scrollContainer: HTMLDivElement;
  let currentTabId: number = -1; // Track current session's bound tab
  let agentReady = false;
  let healthStatus: { ready: boolean; message?: string; provider?: string; model?: string; authMode?: 'login' | 'api_key' | 'none' } = { ready: false, authMode: 'none' };
  let compactionNotification: { show: boolean; tokensSaved: number; compactionCount: number; isWarning: boolean } = {
    show: false,
    tokensSaved: 0,
    compactionCount: 0,
    isWarning: false,
  };
  // Current UI theme (reactive from store)
  let currentTheme: UITheme = 'terminal';
  // Scheduler modal state
  let showScheduleModal = false;
  let scheduleTaskInput = '';
  // Scheduled task execution state (US3)
  let scheduledTaskId: string | null = null;
  let scheduledSessionId: string | null = null;
  let isScheduledTaskMode = false;
  $: showWelcome =
    !isProcessing && processedEvents.length === 0 && messages.length === 0;

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onMount(async () => {
    // Clear messages from previous session
    messages = [];
    processedEvents = [];

    // Initialize EventProcessor
    eventProcessor = new EventProcessor();

    // Load UI preferences from config
    try {
      const config = await AgentConfig.getInstance();
      const preferences = config.getConfig().preferences;
      if (preferences?.uiTheme) {
        uiTheme.initialize(preferences.uiTheme);
      }
      // Initialize token usage visibility (defaults to false/hidden)
      showTokenUsage.initialize(preferences?.showTokenUsage);
    } catch (error) {
      console.warn('[App] Failed to load UI preferences:', error);
    }

    // Initialize router
    router = new MessageRouter('sidepanel');

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

    // Check if this is a scheduled task execution (US3: T022)
    const urlParams = new URLSearchParams(window.location.search);
    const taskIdParam = urlParams.get('scheduledTask');
    const sessionIdParam = urlParams.get('sessionId');

    if (taskIdParam && sessionIdParam) {
      console.log('[App] Scheduled task mode detected:', taskIdParam);
      scheduledTaskId = taskIdParam;
      scheduledSessionId = sessionIdParam;
      isScheduledTaskMode = true;

      // Load and execute the scheduled task
      await loadAndExecuteSchedulerTask(taskIdParam, sessionIdParam);
      return; // Skip normal initialization for scheduled task mode
    }

    // Fetch current session's tabId from storage
    await fetchCurrentTabId();

    // ========================================================================
    // KEEP-ALIVE: Send periodic pings to prevent service worker termination
    // ========================================================================
    // Chrome terminates service workers after ~30 seconds of inactivity.
    // While the side panel is open, send pings every 20 seconds to keep it alive.
    // This ensures responsive UI and prevents state loss.
    // ========================================================================
    const keepAliveInterval = setInterval(async () => {
      try {
        await router.send(MessageType.PING);
        console.log('[App] Keep-alive ping sent');
      } catch (error) {
        console.warn('[App] Keep-alive ping failed:', error);
      }
    }, 25000); // Every 25 seconds

    return () => {
      // Clean up keep-alive interval when panel closes
      clearInterval(keepAliveInterval);
      router?.cleanup();
    };
  });

  // T035: Listen for scheduled task cancellation events
  function handleSchedulerCancelEvent(message: { type: string; payload?: unknown }) {
    if (message.type !== MessageType.SCHEDULER_EVENT) return;

    const event = message.payload as TaskStatusChangedEvent;
    // Check if this is a cancellation for our running task
    if (
      isScheduledTaskMode &&
      scheduledTaskId &&
      event?.taskId === scheduledTaskId &&
      event?.newStatus === 'cancelled'
    ) {
      console.log('[App] Scheduled task cancelled, aborting execution:', scheduledTaskId);

      // Stop processing
      isProcessing = false;

      // Add cancellation notice to UI
      const cancelNotice: ProcessedEvent = {
        id: `scheduled_cancel_${Date.now()}`,
        category: 'system',
        timestamp: new Date(),
        title: 'system',
        content: 'Task cancelled by user',
        style: { textColor: 'text-yellow-400' },
        streaming: false,
        collapsible: false,
      };
      processedEvents = [...processedEvents, cancelNotice];

      // Request agent to abort via message to service worker
      chrome.runtime.sendMessage({
        type: MessageType.INTERRUPT,
      }).catch((err) => {
        console.warn('[App] Failed to send interrupt on cancel:', err);
      });
    }
  }

  // Add listener on component initialization
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(handleSchedulerCancelEvent);
  }

  onDestroy(() => {
    // Clean up cancel event listener
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(handleSchedulerCancelEvent);
    }
  });

  /**
   * Fetch the current session's tabId and conversation history from BrowserAgent session
   * US3: Get tabId from session on mount
   * If tabId is -1, automatically bind to the current active tab
   * Also restores conversation history to sync UI with backend state
   */
  async function fetchCurrentTabId() {
    try {
      // Request current session state from service worker
      // Use chrome.runtime.sendMessage directly (same pattern as resumeConversation)
      const response = await chrome.runtime.sendMessage({
        type: MessageType.GET_STATE,
      });
      console.log('[App] Fetched session state:', response);

      // Response is wrapped by MessageRouter: { success: true, data: { tabId, history, ... } }
      const stateData = response?.data || response;

      if (stateData && typeof stateData.tabId === 'number') {
        const fetchedTabId = stateData.tabId;
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

      // Restore conversation history from backend to sync UI state
      const historyItems = stateData?.history;
      if (historyItems && Array.isArray(historyItems) && historyItems.length > 0) {
        console.log('[App] Restoring conversation history:', historyItems.length, 'items');
        restoreConversationHistory(historyItems);
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
   * Restore conversation history from backend to UI
   * Converts history items to ProcessedEvent objects for display
   */
  function restoreConversationHistory(historyItems: any[]) {
    const restoredEvents: ProcessedEvent[] = [];

    for (let i = 0; i < historyItems.length; i++) {
      const item = historyItems[i];
      if (item.type === 'message') {
        const isUser = item.role === 'user';
        let text = '';

        // Extract text from content
        if (Array.isArray(item.content)) {
          for (const content of item.content) {
            if (content.type === 'input_text' || content.type === 'output_text' || content.type === 'text') {
              let contentText = content.text || '';

              // Handle JSON-stringified input items (e.g., '{"type":"text","text":"actual message"}')
              if (contentText.startsWith('{') && contentText.includes('"text"')) {
                try {
                  const parsed = JSON.parse(contentText);
                  if (parsed.text) {
                    contentText = parsed.text;
                  }
                } catch {
                  // Not valid JSON, use as-is
                }
              }

              text += contentText;
            }
          }
        } else if (typeof item.content === 'string') {
          text = item.content;
        }

        if (text.trim()) {
          // Create ProcessedEvent with proper styling
          restoredEvents.push({
            id: `restored_${i}_${Date.now()}`,
            category: 'message',
            timestamp: new Date(),
            title: isUser ? 'user' : 'browserx',
            content: text,
            style: isUser ? { textColor: 'text-cyan-400' } : STYLE_PRESETS.agent_message,
            streaming: false,
            collapsible: false,
          });
        }
      }
    }

    if (restoredEvents.length > 0) {
      processedEvents = restoredEvents;
      console.log('[App] Restored', processedEvents.length, 'events to UI');
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
          authMode: response.authMode || 'none',
        };

        // Update agent store with health status
        agentStore.updateFromHealthCheck({
          ready: response.ready === true,
          message: response.message,
          provider: response.provider,
          model: response.model,
          authMode: response.authMode || 'none',
        });
      } else {
        agentReady = false;
        healthStatus = { ready: false, message: 'Unable to check agent status', authMode: 'none' };
        agentStore.setNoAccess('Unable to check agent status');
      }
    } catch (error) {
      const isPortClosed = error instanceof Error &&
        (error.message.includes('message port closed') ||
         error.message.includes('Extension context invalidated'));

      isConnected = false;
      agentReady = false;

      if (isPortClosed) {
        console.warn('[App] Service worker unavailable during health check');
        healthStatus = { ready: false, message: 'Service worker starting...', authMode: 'none' };
        agentStore.setLoading();
      } else {
        console.error('[App] Health check failed:', error);
        healthStatus = { ready: false, message: 'Connection error', authMode: 'none' };
        agentStore.setNoAccess('Connection error');
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

      // If this is a scheduled task execution, notify the scheduler (US3)
      if (isScheduledTaskMode && scheduledTaskId) {
        notifySchedulerTaskCompletion(msg.type === 'TaskComplete', msg);
      }
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

      // Handle compaction completed notification (T032, T033)
      case 'CompactionCompleted':
        if ('data' in msg && msg.data) {
          const data = msg.data as {
            success: boolean;
            tokensBefore: number;
            tokensAfter: number;
            compactionCount: number;
            error?: string;
          };

          if (data.success) {
            const tokensSaved = data.tokensBefore - data.tokensAfter;
            const isWarning = data.compactionCount > 1; // Multi-compaction warning (FR-008)

            compactionNotification = {
              show: true,
              tokensSaved,
              compactionCount: data.compactionCount,
              isWarning,
            };

            // Auto-hide notification after 5 seconds
            setTimeout(() => {
              compactionNotification = { ...compactionNotification, show: false };
            }, 5000);
          }
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

  /**
   * Handle long-press on send button to show schedule modal
   */
  function handleShowScheduleModal(event: CustomEvent<{ input: string }>) {
    scheduleTaskInput = event.detail.input;
    showScheduleModal = true;
  }

  /**
   * Handle schedule task from modal
   */
  async function handleScheduleTask(event: CustomEvent<{ input: string; scheduledTime: number }>) {
    const { input, scheduledTime } = event.detail;
    showScheduleModal = false;

    try {
      const response = await router.send(MessageType.SCHEDULER_SCHEDULE_TASK, {
        input,
        scheduledTime,
      });

      if (response?.success) {
        // Clear the input since task was scheduled
        inputText = '';

        // Show confirmation notification
        const scheduledDate = new Date(scheduledTime);
        const formattedTime = scheduledDate.toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

        // Add system message to show task was scheduled
        const scheduledEvent: ProcessedEvent = {
          id: `scheduled_${Date.now()}`,
          category: 'system',
          timestamp: new Date(),
          title: 'system',
          content: `Task scheduled for ${formattedTime}`,
          style: { textColor: 'text-green-400' },
          streaming: false,
          collapsible: false,
        };
        processedEvents = [...processedEvents, scheduledEvent];
      } else {
        throw new Error(response?.error || 'Failed to schedule task');
      }
    } catch (error) {
      console.error('[App] Failed to schedule task:', error);
      messages = [...messages, {
        type: 'agent',
        content: `Failed to schedule task: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: Date.now(),
      }];
    }
  }

  function handleCloseScheduleModal() {
    showScheduleModal = false;
    scheduleTaskInput = '';
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

  /**
   * Stop the current agent session
   * Aborts all running tasks and resets processing state
   */
  async function stopAgent() {
    if (!isProcessing) return;

    try {
      // Send stop message to service worker
      await chrome.runtime.sendMessage({ type: 'STOP_AGENT_SESSION' });
      isProcessing = false;
      console.log('[App] Agent session stopped');
    } catch (error) {
      console.error('[App] Failed to stop agent:', error);

      const isPortClosed = error instanceof Error &&
        (error.message.includes('message port closed') ||
         error.message.includes('Extension context invalidated'));

      let errorMessage = 'Failed to stop the task. Please try again.';
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

  /**
   * Resume a conversation from chat history
   * Loads the selected conversation and restores its state
   */
  async function resumeConversation(conversationId: string) {
    console.log('[App] Resuming conversation:', conversationId);

    // Clear current UI state
    messages = [];
    processedEvents = [];
    inputText = '';
    isProcessing = false;

    // Reset event processor
    eventProcessor.reset();

    try {
      // Request session resume from service worker
      const response = await chrome.runtime.sendMessage({
        type: 'RESUME_SESSION',
        payload: { conversationId },
      });

      // Response is wrapped by MessageRouter: { success: true, data: { history: [...] } }
      const historyItems = response?.data?.history || response?.history;
      console.log('[App] Conversation resumed:', conversationId, 'with', historyItems?.length || 0, 'items');

      // Restore history to UI using shared helper
      if (historyItems && Array.isArray(historyItems)) {
        restoreConversationHistory(historyItems);
      }
    } catch (error) {
      console.error('[App] Failed to resume conversation:', error);

      const isPortClosed = error instanceof Error &&
        (error.message.includes('message port closed') ||
         error.message.includes('Extension context invalidated'));

      let errorMessage = 'Failed to load conversation. Please try again.';
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

  /**
   * Notify scheduler of task completion (US3)
   * Called when a scheduled task finishes executing
   */
  async function notifySchedulerTaskCompletion(success: boolean, msg: any) {
    if (!scheduledTaskId) return;

    try {
      if (success) {
        // Extract result summary from the processed events
        const lastAgentEvent = processedEvents.filter(e => e.title === 'browserx').pop();
        const resultSummary = lastAgentEvent?.content?.slice(0, 500) || 'Task completed';

        await chrome.runtime.sendMessage({
          type: MessageType.SCHEDULER_COMPLETE_TASK,
          payload: {
            taskId: scheduledTaskId,
            result: {
              summary: resultSummary,
              completedAt: Date.now(),
            },
          },
        });
        console.log('[App] Notified scheduler of task completion:', scheduledTaskId);
      } else {
        const errorMessage = msg?.data?.message || 'Task failed';
        await chrome.runtime.sendMessage({
          type: MessageType.SCHEDULER_FAIL_TASK,
          payload: {
            taskId: scheduledTaskId,
            error: errorMessage,
          },
        });
        console.log('[App] Notified scheduler of task failure:', scheduledTaskId);
      }
    } catch (error) {
      console.error('[App] Failed to notify scheduler of task completion:', error);
    }
  }

  /**
   * Load and execute a scheduled task (US3: T023)
   * Called when the page is opened with scheduledTask URL parameter
   */
  async function loadAndExecuteSchedulerTask(taskId: string, sessionId: string) {
    console.log('[App] Loading scheduled task:', taskId, 'with session:', sessionId);

    try {
      // Fetch task details from scheduler
      const response = await chrome.runtime.sendMessage({
        type: MessageType.SCHEDULER_GET_TASK_DETAILS,
        payload: { taskId },
      });

      const taskData = response?.data || response;
      if (!taskData || !taskData.task) {
        throw new Error('Task not found or invalid response');
      }

      const task = taskData.task;
      console.log('[App] Scheduled task loaded:', task);

      // Display task input as user message
      const userEvent: ProcessedEvent = {
        id: `scheduled_user_${Date.now()}`,
        category: 'message',
        timestamp: new Date(),
        title: 'user',
        content: task.input,
        style: { textColor: 'text-cyan-400' },
        streaming: false,
        collapsible: false,
      };
      processedEvents = [userEvent];

      // Add a system notification showing this is a scheduled task
      const scheduleNotification: ProcessedEvent = {
        id: `scheduled_notice_${Date.now()}`,
        category: 'system',
        timestamp: new Date(),
        title: 'system',
        content: `Executing scheduled task (${task.scheduledTime ? new Date(task.scheduledTime).toLocaleString() : 'manual trigger'})`,
        style: { textColor: 'text-yellow-400' },
        streaming: false,
        collapsible: false,
      };
      processedEvents = [...processedEvents, scheduleNotification];

      // Wait for agent to be ready
      await checkConnection();
      if (!agentReady) {
        throw new Error('Agent is not ready. Please configure your API key.');
      }

      // Execute the task via the agent
      // Feature 015: Include sessionId in context for multi-agent routing
      isProcessing = true;
      await router.sendSubmission({
        id: `scheduled_${taskId}_${Date.now()}`,
        op: {
          type: 'UserInput',
          items: [{ type: 'text', text: task.input }],
        },
        context: {
          tabId: currentTabId,
          sessionId: sessionId, // Feature 015: Route to correct agent session
          scheduledTaskId: taskId,
        },
      });

    } catch (error) {
      console.error('[App] Failed to execute scheduled task:', error);

      // Notify scheduler of failure
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.SCHEDULER_FAIL_TASK,
          payload: {
            taskId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      } catch (notifyError) {
        console.error('[App] Failed to notify scheduler of task failure:', notifyError);
      }

      // Show error in UI
      const errorEvent: ProcessedEvent = {
        id: `scheduled_error_${Date.now()}`,
        category: 'message',
        timestamp: new Date(),
        title: 'browserx',
        content: `Failed to execute scheduled task: ${error instanceof Error ? error.message : 'Unknown error'}`,
        style: STYLE_PRESETS.error,
        streaming: false,
        collapsible: false,
      };
      processedEvents = [...processedEvents, errorEvent];
      isProcessing = false;
    }
  }
</script>

<!-- Single UI with theme-aware styling -->
<div class="main-layout {currentTheme}">
  <TerminalContainer theme={currentTheme}>
    <div class="content-container">
        <!-- Status Line -->
        <div class="status-line flex justify-between mb-2">
          <TerminalMessage type="system" content="Browserx (Alpha)" />
          <div class="flex items-center space-x-2">
            {#if isProcessing}
              <TerminalMessage type="warning" content="[PROCESSING]" />
            {/if}
            {#if !isConnected}
              <TerminalMessage type="error" content="[DISCONNECTED]" />
            {:else if !agentReady && $agentStore.authMode === 'none'}
              <TerminalMessage type="warning" content="[NO ACCESS]" />
            {:else if !agentReady}
              <TerminalMessage type="warning" content="[NO API KEY - CLICK SETTINGS ⚙️]" />
            {/if}
          </div>
        </div>

        <!-- Compaction Notification (T032, T033) -->
        {#if compactionNotification.show}
          <div class="compaction-notification {compactionNotification.isWarning ? 'warning' : 'success'}">
            <span class="notification-icon">
              {#if compactionNotification.isWarning}⚠️{:else}✓{/if}
            </span>
            <span class="notification-text">
              Context compacted: saved ~{Math.round(compactionNotification.tokensSaved / 1000)}k tokens
              {#if compactionNotification.isWarning}
                <span class="warning-text">
                  (#{compactionNotification.compactionCount} - accuracy may be reduced)
                </span>
              {/if}
            </span>
            <button
              class="notification-close"
              on:click={() => compactionNotification = { ...compactionNotification, show: false }}
              aria-label="Dismiss notification"
            >×</button>
          </div>
        {/if}

        <!-- No Access Warning Banner -->
        {#if !agentReady && $agentStore.authMode === 'none' && isConnected}
          <div class="no-access-warning">
            <div class="warning-header">
              <span class="warning-icon">⚠️</span>
              <span class="warning-title">No Access Configured</span>
            </div>
            <p class="warning-message">
              To use the AI agent, please either:
            </p>
            <ul class="warning-options">
              <li>
                <a href={getLoginPageUrl()} target="_blank" rel="noopener noreferrer" class="warning-link">
                  Log in to your account
                </a>
              </li>
              <li>
                <button on:click={toggleSettings} class="warning-link-button">
                  Configure an API key in Settings
                </button>
              </li>
            </ul>
          </div>
        {/if}

        <!-- Messages - scrollable area -->
        <div class="messages-container" bind:this={scrollContainer}>
          {#if showWelcome}
            <div class="welcome-screen" role="presentation">
              {#if $userStore.isLoggedIn && ($userStore.userName || $userStore.userEmail)}
                <p class="welcome-greeting text-term-bright-green">{$_t("Hello $NAME$", { substitutions: [$userStore.userName || $userStore.userEmail] })}</p>
              {/if}
              <pre class="welcome-ascii">
                {#each welcomeAsciiLines as line, index (index)}
                  <span class={line.color}>{line.text}</span>
                {/each}
              </pre>
              <p class="welcome-subtitle text-term-blue">
                {$_t("General in-browser AI agent for work tasks")}
              </p>
              <p class="welcome-subtitle text-term-dim-green">
                {$_t("Developed and supported by AI Republic")}
              </p>
              <a
                class="welcome-link"
                href="https://airepublic.com"
                target="_blank"
                rel="noreferrer noopener"
              >
                {$_t("Learn more")}
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
              onStop={stopAgent}
              onSelectConversation={resumeConversation}
              onNewConversation={startNewConversation}
              tabId={currentTabId}
              {isProcessing}
              placeholder=">> Enter command..."
              on:tabSelected={handleTabSelected}
              on:showScheduleModal={handleShowScheduleModal}
            />
          </div>

          <!-- Footer Bar -->
          <FooterBar on:openSettings={toggleSettings} />
        </div>
      </div>
    </TerminalContainer>
  </div>

<!-- Settings Modal -->
{#if showSettings}
  <div class="settings-modal-overlay">
    <div class="settings-modal-container" class:chatgpt={currentTheme === 'chatgpt'}>
      <Settings
        on:authUpdated={handleAuthUpdated}
        on:close={handleSettingsClose}
      />
    </div>
  </div>
{/if}

<!-- Schedule Task Modal -->
<ScheduleTaskModal
  show={showScheduleModal}
  input={scheduleTaskInput}
  on:close={handleCloseScheduleModal}
  on:schedule={handleScheduleTask}
/>

<style>
  /* ============================================
     Main Layout - Theme-aware styles
     ============================================ */

  .main-layout {
    height: 100vh;
    overflow: hidden;
  }

  .content-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0; /* Important for nested flex overflow */
    max-width: 900px;
    margin: 0 auto;
    width: 100%;
  }

  .status-line {
    flex-shrink: 0;
  }

  .messages-container {
    flex: 1;
    min-height: 0; /* Important for flex overflow to work properly */
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 1rem;
  }

  /* Parent container for input area and function menu */
  .bottom-controls {
    flex-shrink: 0;
    background: var(--color-term-bg);
    border-top: 1px solid var(--color-term-border);
    position: relative;
    z-index: 10;
  }

  .input-area {
    padding: 0.5rem 0.5rem 0.5rem 0;
  }

  /* ============================================
     Welcome Screen - Base styles (Terminal theme)
     ============================================ */

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

  .welcome-greeting {
    margin: 0 0 0.5rem 0;
    font-size: 1.1rem;
    font-weight: 600;
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

  /* ============================================
     ChatGPT Theme Overrides for Welcome Screen
     ============================================ */

  .main-layout.chatgpt .welcome-screen {
    align-items: center;
    justify-content: center;
    text-align: center;
    border: none;
    background: transparent;
    min-height: 50vh;
  }

  .main-layout.chatgpt .welcome-greeting {
    color: var(--chat-text, #0d0d0d);
    font-size: 1.25rem;
  }

  .main-layout.chatgpt .welcome-link {
    color: var(--chat-primary, #60a5fa);
  }

  .main-layout.chatgpt .welcome-link:hover,
  .main-layout.chatgpt .welcome-link:focus {
    color: var(--chat-text, #0d0d0d);
  }

  /* ============================================
     ChatGPT Theme Overrides for Bottom Controls
     ============================================ */

  .main-layout.chatgpt .bottom-controls {
    background: var(--chat-bg, #ffffff);
    border-top: 1px solid var(--chat-border, #e5e5e5);
  }

  /* ============================================
     Compaction Notification - Base styles
     ============================================ */

  .compaction-notification {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    margin-bottom: 0.5rem;
    animation: slideIn 0.3s ease;
    font-size: 0.85rem;
  }

  .compaction-notification.success {
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid var(--color-term-dim-green);
    color: var(--color-term-bright-green);
  }

  .compaction-notification.warning {
    background: rgba(234, 179, 8, 0.15);
    border: 1px solid var(--color-term-yellow);
    color: var(--color-term-yellow);
  }

  .notification-icon {
    flex-shrink: 0;
  }

  .notification-text {
    flex: 1;
  }

  .warning-text {
    opacity: 0.8;
    font-size: 0.8rem;
  }

  .notification-close {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0 0.25rem;
    font-size: 1.1rem;
    opacity: 0.7;
  }

  .notification-close:hover {
    opacity: 1;
  }

  /* ChatGPT Theme Overrides for Compaction Notification */
  .main-layout.chatgpt .compaction-notification {
    margin: 0.5rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    padding: 0.75rem 1rem;
  }

  .main-layout.chatgpt .compaction-notification.success {
    background: var(--chat-status-success-bg, rgba(16, 185, 129, 0.1));
    border: none;
    color: var(--chat-status-success, #10b981);
  }

  .main-layout.chatgpt .compaction-notification.warning {
    background: var(--chat-status-warning-bg, rgba(245, 158, 11, 0.1));
    border: none;
    color: var(--chat-status-warning, #f59e0b);
  }

  /* ============================================
     No Access Warning Banner - Terminal theme
     ============================================ */

  .no-access-warning {
    padding: 1rem;
    margin-bottom: 0.75rem;
    border: 1px solid var(--color-term-yellow, #ffff00);
    border-radius: 4px;
    background: rgba(255, 255, 0, 0.05);
    animation: slideIn 0.3s ease;
  }

  .warning-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .warning-icon {
    font-size: 1.1rem;
  }

  .warning-title {
    font-weight: 600;
    color: var(--color-term-yellow, #ffff00);
  }

  .warning-message {
    margin: 0 0 0.5rem 0;
    color: var(--color-term-dim-green, #00cc00);
    font-size: 0.9rem;
  }

  .warning-options {
    margin: 0;
    padding-left: 1.5rem;
    list-style: disc;
  }

  .warning-options li {
    margin-bottom: 0.25rem;
  }

  .warning-link {
    color: var(--color-term-bright-green, #00ff00);
    text-decoration: underline;
  }

  .warning-link:hover {
    color: var(--color-term-yellow, #ffff00);
  }

  .warning-link-button {
    background: none;
    border: none;
    padding: 0;
    color: var(--color-term-bright-green, #00ff00);
    text-decoration: underline;
    cursor: pointer;
    font-size: inherit;
  }

  .warning-link-button:hover {
    color: var(--color-term-yellow, #ffff00);
  }

  /* ChatGPT Theme Overrides for No Access Warning */
  .main-layout.chatgpt .no-access-warning {
    border: none;
    border-radius: 0.75rem;
    background: var(--chat-status-warning-bg, rgba(245, 158, 11, 0.1));
    padding: 1.25rem;
  }

  .main-layout.chatgpt .warning-title {
    color: var(--chat-status-warning, #f59e0b);
  }

  .main-layout.chatgpt .warning-message {
    color: var(--chat-text, #0d0d0d);
  }

  .main-layout.chatgpt .warning-link {
    color: var(--chat-primary, #60a5fa);
  }

  .main-layout.chatgpt .warning-link:hover {
    color: var(--chat-text, #0d0d0d);
  }

  .main-layout.chatgpt .warning-link-button {
    color: var(--chat-primary, #60a5fa);
  }

  .main-layout.chatgpt .warning-link-button:hover {
    color: var(--chat-text, #0d0d0d);
  }

  /* ============================================
     Animations
     ============================================ */

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

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* ============================================
     Disabled button state
     ============================================ */

  .function-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .function-button:disabled:hover {
    transform: none;
  }

  /* ============================================
     Settings Modal Styles
     ============================================ */

  .settings-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .settings-modal-container {
    max-width: 42rem;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
    border-radius: 0.5rem;
    /* Terminal theme (default) - use terminal-styled browserx colors */
    --browserx-primary: #00ff00;
    --browserx-secondary: #00cc00;
    --browserx-background: #000000;
    --browserx-surface: #0a0a0a;
    --browserx-text: #00ff00;
    --browserx-text-secondary: #00cc00;
    --browserx-border: #00cc00;
    --browserx-error: #ff0000;
    --browserx-success: #00ff00;
    --browserx-warning: #ffff00;
    background: var(--browserx-background);
    border: 1px solid var(--browserx-border);
  }

  /* ChatGPT theme for settings modal - use modern light/dark colors */
  .settings-modal-container.chatgpt {
    --browserx-primary: var(--chat-primary, #60a5fa);
    --browserx-secondary: var(--chat-primary, #60a5fa);
    --browserx-background: var(--chat-bg, #ffffff);
    --browserx-surface: var(--chat-card-bg, #f7f7f8);
    --browserx-text: var(--chat-text, #0d0d0d);
    --browserx-text-secondary: var(--chat-text-secondary, #6e6e80);
    --browserx-border: var(--chat-border, #e5e5e5);
    --browserx-error: var(--chat-error, #ef4444);
    --browserx-success: #10b981;
    --browserx-warning: #f59e0b;
    background: var(--browserx-background);
    border: 1px solid var(--browserx-border);
    border-radius: 1rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }
</style>
