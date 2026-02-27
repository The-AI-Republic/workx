<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { MessageType } from '@/core/MessageRouter';
  import { messageService, connectionState, getMessageService, type IMessageService } from '@/core/messaging';
  import type { TaskStatusChangedEvent } from '@/core/models/types/SchedulerContracts';
  import type { Event } from '@/core/protocol/types';
  import type { ProcessedEvent } from '@/types/ui';
  import { STYLE_PRESETS } from '@/types/ui';
  import TerminalContainer from '../../components/TerminalContainer.svelte';
  import TerminalMessage from '../../components/TerminalMessage.svelte';
  import MessageInput from '../../components/MessageInput.svelte';
  import EventDisplay from '../../components/event_display/EventDisplay.svelte';
  import { EventProcessor } from '../../components/event_display/EventProcessor';
  import { welcomeAsciiLines } from '../../constants/welcomeAscii';
  // Platform store
  import { platform } from '../../stores/platformStore';
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
  // Scheduler store (for scheduling result feedback)
  import { schedulerStore } from '../../stores/schedulerStore';
  // i18n
  import { t, _t } from '../../lib/i18n';
  // Scheduler components
  import ScheduleTaskModal from '../../components/scheduler/ScheduleTaskModal.svelte';
  // Multi-chat support
  import { get } from 'svelte/store';
  import ChatBar from '../../components/chats/ChatBar.svelte';
  import { chatStore, type SidePanelChat } from '../../stores/chatStore';

  // Message service (platform-agnostic)
  let service: IMessageService | null = null;
  let unsubscribers: Array<() => void> = [];
  let eventProcessor: EventProcessor;
  let messages: Array<{ type: 'user' | 'agent'; content: string; timestamp: number }> = [];
  let processedEvents: ProcessedEvent[] = [];
  let inputText = '';
  let isConnected = false;
  let isProcessing = false;
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
  // Scheduled task execution state (US3)
  let scheduledTaskId: string | null = null;
  let scheduledSessionId: string | null = null;
  let isScheduledTaskMode = false;

  // Multi-chat state
  interface ChatConversationState {
    messages: Array<{ type: 'user' | 'agent'; content: string; timestamp: number }>;
    processedEvents: ProcessedEvent[];
    inputText: string;
    isProcessing: boolean;
    currentTabId: number;
    eventProcessor: EventProcessor;
  }
  let chatStates: Map<string, ChatConversationState> = new Map();
  let activeSessionId: string | null = null;
  let canCreateChat: boolean = true;
  let maxSessionsReached: boolean = false;

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

    // Check if returning from a successful scheduling
    const scheduledResult = schedulerStore.getAndClearResult();
    if (scheduledResult) {
      const scheduledDate = new Date(scheduledResult.scheduledTime);
      const dateDisplay = scheduledDate.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const confirmEvent: ProcessedEvent = {
        id: `scheduled_confirm_${Date.now()}`,
        category: 'system',
        timestamp: new Date(),
        title: 'system',
        content: t('Task scheduled for $1$', { substitutions: [dateDisplay] }),
        style: { textColor: 'text-green-400', icon: 'success' },
        streaming: false,
        collapsible: false,
      };
      processedEvents = [confirmEvent];
    }

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

    // Get the message service (initialized by entry point)
    try {
      service = getMessageService();
      console.log('[App] Using message service');
    } catch (error) {
      console.error('[App] Message service not initialized:', error);
      // Service not available - UI will show disconnected state
    }

    // Setup event handlers if service is available
    if (service) {
      // Listen for events from backend
      unsubscribers.push(
        service.on(MessageType.EVENT, (payload) => {
          const eventPayload = payload as Event & { sessionId?: string };
          const event: Event = { id: eventPayload.id, msg: eventPayload.msg };
          const eventSessionId = eventPayload.sessionId;

          if (eventSessionId && activeSessionId && eventSessionId !== activeSessionId) {
            handleEventForSession(event, eventSessionId);
          } else {
            handleEvent(event);
          }
        })
      );

      // Listen for state updates (only apply if for the active session)
      unsubscribers.push(
        service.on(MessageType.STATE_UPDATE, (payload) => {
          const state = payload as { tabId?: number; sessionId?: string };
          // Only update if this is for the active session or has no sessionId (backward compat)
          if (state && 'tabId' in state) {
            if (!state.sessionId || state.sessionId === activeSessionId) {
              currentTabId = state.tabId!;
            }
          }
        })
      );

      // Listen for session events (termination, etc.)
      unsubscribers.push(
        service.on(MessageType.SESSION_EVENT, (payload) => {
          const sessionEvent = payload as { type?: string; sessionId?: string };
          if (sessionEvent?.type === 'session:terminated') {
            handleSessionTerminated(sessionEvent.sessionId!);
          }
        })
      );

      // Handle agent re-initialization (e.g., when model is changed)
      unsubscribers.push(
        service.on(MessageType.AGENT_REINITIALIZED, () => {
          // Clear active chat state
          messages = [];
          processedEvents = [];
          isProcessing = false;
          eventProcessor.reset();

          // Also clear all background chat states (model change affects all sessions)
          chatStates.clear();

          // Re-check connection/auth status since agent was reinitialized
          checkConnection();
        })
      );

      // Listen for scheduler events (for task cancellation)
      unsubscribers.push(
        service.on(MessageType.SCHEDULER_EVENT, (payload) => {
          handleSchedulerEvent(payload as TaskStatusChangedEvent);
        })
      );
    }

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

    // Initialize multi-chat system
    await initializeChats();

    // Fetch current session's tabId from storage
    await fetchCurrentTabId();

    // Save active chat state after history restoration so it persists across tab switches
    const activeChatAfterInit = chatStore.getActiveChat();
    if (activeChatAfterInit) {
      saveChatState(activeChatAfterInit.id);
    }

    // ========================================================================
    // KEEP-ALIVE: Send periodic pings to prevent service worker termination
    // ========================================================================
    // Keep-alive ping for Chrome extension (service worker stays awake)
    // Only needed for extension mode - Tauri doesn't have this limitation
    let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
    if (platform.platformName === 'extension' && service) {
      keepAliveInterval = setInterval(async () => {
        try {
          await service!.send(MessageType.PING);
          console.log('[App] Keep-alive ping sent');
        } catch (error) {
          console.warn('[App] Keep-alive ping failed:', error);
        }
      }, 25000); // Every 25 seconds
    }

    return () => {
      // Clean up keep-alive interval
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
      }
      // Clean up event subscriptions
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers = [];
    };
  });

  // T035: Handle scheduled task cancellation events
  function handleSchedulerEvent(event: TaskStatusChangedEvent) {
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
        content: t('Task cancelled by user'),
        style: { textColor: 'text-yellow-400' },
        streaming: false,
        collapsible: false,
      };
      processedEvents = [...processedEvents, cancelNotice];

      // Request agent to abort via message service (pass sessionId to target correct session)
      if (service) {
        service.send(MessageType.INTERRUPT, {
          sessionId: activeSessionId ?? scheduledSessionId ?? undefined,
        }).catch((err) => {
          console.warn('[App] Failed to send interrupt on cancel:', err);
        });
      }
    }
  }

  onDestroy(() => {
    // Cleanup is handled by the onMount return function
  });

  /**
   * Fetch the current session's tabId and conversation history from BrowserAgent session
   * US3: Get tabId from session on mount
   * If tabId is -1, automatically bind to the current active tab (extension only)
   * Also restores conversation history to sync UI with backend state
   */
  async function fetchCurrentTabId() {
    if (!service) {
      console.warn('[App] Service not available for fetchCurrentTabId');
      currentTabId = -1;
      return;
    }

    try {
      // Request current session state from backend (pass sessionId to route to correct agent)
      const response = await service.send<{ tabId?: number; history?: unknown[] }>(MessageType.GET_STATE, {
        sessionId: activeSessionId ?? undefined,
      });
      console.log('[App] Fetched session state:', response);

      const stateData = response || {};

      if (stateData && typeof stateData.tabId === 'number') {
        const fetchedTabId = stateData.tabId;
        console.log(`[App] Fetched session tabId: ${fetchedTabId}`);

        // If no tab is bound (tabId === -1), get the current active tab ID
        // Only applicable for extension mode - desktop doesn't have tabs
        if (fetchedTabId === -1 && platform.hasTabSelection) {
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const activeTab = tabs[0];
            if (activeTab?.id) {
              console.log(`[App] Session has no tab, will suggest active tab ${activeTab.id} to agent`);
              currentTabId = activeTab.id;
            } else {
              console.warn('[App] No active tab found');
              currentTabId = -1;
            }
          } catch (tabError) {
            console.warn('[App] Failed to query tabs:', tabError);
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
      console.error('[App] Failed to fetch current tabId from session:', error);

      // Fallback: get current active tab to send as suggestion (extension only)
      if (platform.hasTabSelection) {
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
      } else {
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
          const processedEvent: ProcessedEvent = {
            id: `restored_${i}_${Date.now()}`,
            category: 'message',
            timestamp: new Date(),
            title: isUser ? 'user' : 'browserx',
            content: text,
            style: isUser ? { textColor: 'text-cyan-400' } : STYLE_PRESETS.agent_message,
            streaming: false,
            collapsible: false,
          };

          // Carry modelKey from assistant messages for model indicator display
          if (!isUser && item.modelKey) {
            processedEvent.modelKey = item.modelKey;
          }

          restoredEvents.push(processedEvent);
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
   * Only applicable for extension mode - desktop doesn't have tabs
   */
  async function bindToActiveTab() {
    // Desktop mode doesn't have tabs
    if (!platform.hasTabSelection) {
      currentTabId = -1;
      return;
    }

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
      if (!service) {
        isConnected = false;
        agentReady = false;
        healthStatus = { ready: false, message: t('Message service not available'), authMode: 'none' };
        return;
      }

      const response = await service.send<{
        type?: string;
        ready?: boolean;
        message?: string;
        provider?: string;
        model?: string;
        authMode?: 'login' | 'api_key' | 'none';
      }>(MessageType.HEALTH_CHECK);

      isConnected = response?.type === MessageType.HEALTH_STATUS || response?.ready !== undefined;

      if (response?.ready !== undefined) {
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
        healthStatus = { ready: false, message: t('Unable to check agent status'), authMode: 'none' };
        agentStore.setNoAccess(t('Unable to check agent status'));
      }
    } catch (error) {
      console.error('[App] Health check failed:', error);

      isConnected = false;
      agentReady = false;
      healthStatus = { ready: false, message: t('Connection error'), authMode: 'none' };
      agentStore.setNoAccess(t('Connection error'));
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
        content: t('Error: Not connected to agent. Please refresh the page.'),
        timestamp: Date.now(),
      }];
      return;
    }

    // Check if agent is ready (has API key)
    if (!agentReady) {
      const providerName = healthStatus.provider || 'the selected provider';
      messages = [...messages, {
        type: 'agent',
        content: t('Cannot send message: No API key configured for $1$. Please click the Settings button and configure your API key.', { substitutions: [providerName] }),
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

    // Update chat title from first message
    updateChatTitleFromMessage(text);

    // Send to agent with browser tab context and session ID
    try {
      if (!service) throw new Error('Message service not available');
      await service.send(MessageType.SUBMISSION, {
        id: `user_${Date.now()}`,
        op: {
          type: 'UserInput',
          items: [{ type: 'text', text }],
        },
        context: {
          tabId: currentTabId, // Include current tab selection in context
          sessionId: activeSessionId ?? undefined, // Route to correct session
        },
      });

    } catch (error) {
      console.error('Failed to send message:', error);

      let errorMessage = t('Failed to send message. Please try again.');
      if (error instanceof Error && error.message.includes('not available')) {
        errorMessage = t('Backend not available. Please wait a moment and try again.');
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

  /**
   * Handle command output from slash commands (e.g., /help)
   * Creates a system ProcessedEvent and appends it to the chat
   */
  function handleCommandOutput(event: CustomEvent<{ title: string; content: string }>) {
    const { title, content } = event.detail;
    const cmdEvent: ProcessedEvent = {
      id: `cmd_${Date.now()}`,
      category: 'system',
      timestamp: new Date(),
      title,
      content,
      style: STYLE_PRESETS.system,
      streaming: false,
      collapsible: false,
    };
    processedEvents = [...processedEvents, cmdEvent];
  }

  async function startNewConversation() {
    // Clear UI state
    messages = [];
    processedEvents = [];
    inputText = '';
    isProcessing = false;

    // Reset tab context
    currentTabId = -1;

    // Re-initialize event processor to prevent aliasing
    eventProcessor = new EventProcessor();

    // Request session reset from backend (pass sessionId to reset the correct session)
    try {
      if (!service) throw new Error('Message service not available');
      await service.send(MessageType.SESSION_RESET, {
        sessionId: activeSessionId ?? undefined,
      });

      // After session reset, auto-bind to the active tab
      // This ensures the new conversation starts with the current tab
      await bindToActiveTab();
    } catch (error) {
      console.error('Failed to reset session:', error);

      let errorMessage = t('Failed to start new conversation. Please try again.');

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
      if (!service) throw new Error('Message service not available');
      // Send stop message to backend (pass sessionId to stop the correct session)
      await service.send(MessageType.INTERRUPT, {
        sessionId: activeSessionId ?? undefined,
      });
      isProcessing = false;
      console.log('[App] Agent session stopped');
    } catch (error) {
      console.error('[App] Failed to stop agent:', error);

      messages = [...messages, {
        type: 'agent',
        content: t('Failed to stop the task. Please try again.'),
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
      if (!service) throw new Error('Message service not available');
      // Request session resume from backend
      const response = await service.send<{ history?: unknown[] }>(MessageType.RESUME_SESSION, { conversationId });

      const historyItems = response?.history;
      console.log('[App] Conversation resumed:', conversationId, 'with', historyItems?.length || 0, 'items');

      // Restore history to UI using shared helper
      if (historyItems && Array.isArray(historyItems)) {
        restoreConversationHistory(historyItems);
      }
    } catch (error) {
      console.error('[App] Failed to resume conversation:', error);

      messages = [...messages, {
        type: 'agent',
        content: t('Failed to load conversation. Please try again.'),
        timestamp: Date.now(),
      }];
    }
  }

  /**
   * Notify scheduler of task completion (US3)
   * Called when a scheduled task finishes executing
   */
  async function notifySchedulerTaskCompletion(success: boolean, msg: any) {
    if (!scheduledTaskId || !service) return;

    try {
      if (success) {
        // Extract result summary from the processed events
        const lastAgentEvent = processedEvents.filter(e => e.title === 'browserx').pop();
        const resultSummary = lastAgentEvent?.content?.slice(0, 500) || 'Task completed';

        await service.send(MessageType.SCHEDULER_COMPLETE_TASK, {
          taskId: scheduledTaskId,
          result: {
            summary: resultSummary,
            completedAt: Date.now(),
          },
        });
        console.log('[App] Notified scheduler of task completion:', scheduledTaskId);
      } else {
        const errorMessage = msg?.data?.message || 'Task failed';
        await service.send(MessageType.SCHEDULER_FAIL_TASK, {
          taskId: scheduledTaskId,
          error: errorMessage,
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
      if (!service) throw new Error('Message service not available');
      // Fetch task details from scheduler
      const response = await service.send<{ task?: { input: string; scheduledTime?: number } }>(
        MessageType.SCHEDULER_GET_TASK_DETAILS,
        { taskId }
      );

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
      await service.send(MessageType.SUBMISSION, {
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
        if (service) {
          await service.send(MessageType.SCHEDULER_FAIL_TASK, {
            taskId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
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

  // ============================================================================
  // Multi-Chat Management Functions
  // ============================================================================

  /**
   * Initialize the multi-chat system
   * Restores persisted chats and validates against active sessions
   */
  async function initializeChats() {
    try {
      // Restore chats from storage
      const restoredState = await chatStore.restoreChats();

      // Get list of active primary sessions from backend
      const response = await service!.send(MessageType.SIDEPANEL_LIST_SESSIONS);
      const activeSessions = response?.sessions || [];
      const maxConcurrent = response?.maxConcurrent || 5;
      const activeCount = response?.activeCount || 0;

      canCreateChat = response?.canCreateSession ?? true;
      maxSessionsReached = activeCount >= maxConcurrent;

      // Match chats to sessions, remove orphaned chats
      const validChats: SidePanelChat[] = [];
      for (const chat of restoredState.chats) {
        const session = activeSessions.find((s: any) => s.sessionId === chat.sessionId);
        if (session) {
          validChats.push(chat);
        } else {
          console.log(`[App] Removing orphaned chat: ${chat.id} (session ${chat.sessionId} not found)`);
        }
      }

      // If no valid chats, clear stale persisted state and create a default one
      if (validChats.length === 0) {
        chatStore.clear();
        await createNewChat();
      } else {
        // Update store with valid chats only
        chatStore.setState({
          chats: validChats,
          activeChatId: validChats.some(c => c.id === restoredState.activeChatId)
            ? restoredState.activeChatId
            : validChats[0]?.id || null,
        });

        // Load state for the active chat
        const activeChat = chatStore.getActiveChat();
        if (activeChat) {
          activeSessionId = activeChat.sessionId;
          loadChatState(activeChat.id);
        }
      }

      console.log(`[App] Initialized ${validChats.length} chats, can create: ${canCreateChat}`);
    } catch (error) {
      console.error('[App] Failed to initialize chats:', error);
      // Fallback: clear any stale state and create a default chat
      chatStore.clear();
      await createNewChat();
    }
  }

  /**
   * Create a new chat with a new session
   */
  async function createNewChat() {
    try {
      // Request new session from backend
      const response = await service!.send(MessageType.SIDEPANEL_CREATE_SESSION);

      if (!response?.success) {
        console.error('[App] Failed to create session:', response?.error);
        maxSessionsReached = response?.error?.includes('Maximum') ?? false;
        return;
      }

      const { sessionId } = response;

      // Create chat in store
      const newChat = chatStore.createChat(sessionId, 'New Chat');

      // Initialize state for new chat
      const newState: ChatConversationState = {
        messages: [],
        processedEvents: [],
        inputText: '',
        isProcessing: false,
        currentTabId: -1,
        eventProcessor: new EventProcessor(),
      };
      chatStates.set(newChat.id, newState);

      // Switch to the new chat
      activeSessionId = sessionId;
      loadChatState(newChat.id);

      // Update session limits
      await updateSessionLimits();

      // Auto-bind to active browser tab
      await bindToActiveTab();

      console.log(`[App] Created new chat: ${newChat.id} with session: ${sessionId}`);
    } catch (error) {
      console.error('[App] Failed to create new chat:', error);
    }
  }

  /**
   * Handle chat selection from ChatBar
   */
  function handleChatSelect(event: CustomEvent<{ chatId: string }>) {
    const { chatId } = event.detail;
    switchToChat(chatId);
  }

  /**
   * Switch to a specific chat
   */
  function switchToChat(chatId: string) {
    const currentActiveChat = chatStore.getActiveChat();

    // Save current chat state before switching
    if (currentActiveChat) {
      saveChatState(currentActiveChat.id);
    }

    // Set new active chat
    chatStore.setActiveChat(chatId);

    // Update active session ID BEFORE loading state so that events arriving
    // during the transition are routed to the correct chat
    const newChat = chatStore.getActiveChat();
    if (newChat) {
      activeSessionId = newChat.sessionId;
    }

    // Load state for new chat
    loadChatState(chatId);
  }

  /**
   * Save current UI state to chat state map
   */
  function saveChatState(chatId: string) {
    const state: ChatConversationState = {
      messages: [...messages],
      processedEvents: [...processedEvents],
      inputText,
      isProcessing,
      currentTabId,
      eventProcessor: eventProcessor,
    };
    chatStates.set(chatId, state);
  }

  /**
   * Load chat state from map to UI
   */
  function loadChatState(chatId: string) {
    const state = chatStates.get(chatId);
    if (state) {
      messages = [...state.messages];
      processedEvents = [...state.processedEvents];
      inputText = state.inputText;
      isProcessing = state.isProcessing;
      currentTabId = state.currentTabId;
      eventProcessor = state.eventProcessor;
    } else {
      // Initialize fresh state
      messages = [];
      processedEvents = [];
      inputText = '';
      isProcessing = false;
      currentTabId = -1;
      eventProcessor = new EventProcessor();
    }

    // Reset scroll position after loading new chat state
    // Use setTimeout to ensure DOM has updated with new content
    if (scrollContainer) {
      setTimeout(() => {
        if (messages.length === 0 && processedEvents.length === 0) {
          // New/empty chat: scroll to top to reveal welcome screen
          scrollContainer.scrollTop = 0;
        } else {
          // Chat with history: scroll to bottom to show latest messages
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }, 0);
    }
  }

  /**
   * Handle chat close from ChatBar
   */
  async function handleChatClose(event: CustomEvent<{ chatId: string }>) {
    const { chatId } = event.detail;
    await closeChat(chatId);
  }

  /**
   * Close a chat and terminate its session
   */
  async function closeChat(chatId: string) {
    // Find the chat to close
    const state = get(chatStore);
    const chatToClose = state.chats.find(c => c.id === chatId);

    if (!chatToClose) return;

    // If this is the last chat, create a new one first
    if (state.chats.length <= 1) {
      const countBefore = get(chatStore).chats.length;
      await createNewChat();
      const countAfter = get(chatStore).chats.length;
      if (countAfter <= countBefore) {
        console.error('[App] Failed to create replacement chat, aborting close');
        return;
      }
    }

    // Terminate the session in backend
    try {
      await service!.send(MessageType.SIDEPANEL_CLOSE_SESSION, {
        sessionId: chatToClose.sessionId,
      });
    } catch (error) {
      console.error(`[App] Failed to close session ${chatToClose.sessionId}:`, error);
    }

    // Remove chat state
    chatStates.delete(chatId);

    // Close chat in store (this handles switching to another chat)
    chatStore.closeChat(chatId);

    // Update active session
    const newActiveChat = chatStore.getActiveChat();
    if (newActiveChat) {
      activeSessionId = newActiveChat.sessionId;
      loadChatState(newActiveChat.id);
    }

    // Update session limits
    await updateSessionLimits();

    console.log(`[App] Closed chat: ${chatId}`);
  }

  /**
   * Handle new chat button click from ChatBar
   */
  async function handleNewChat() {
    // Save current chat state before creating a new one
    const currentChat = chatStore.getActiveChat();
    if (currentChat) {
      saveChatState(currentChat.id);
    }
    await createNewChat();
  }

  /**
   * Handle event for a specific session (background chat)
   */
  function handleEventForSession(event: Event, sessionId: string) {
    // Find the chat with this session
    const chat = chatStore.getChatBySessionId(sessionId);
    if (!chat) return;

    // Get or create state for this chat
    let state = chatStates.get(chat.id);
    if (!state) {
      state = {
        messages: [],
        processedEvents: [],
        inputText: '',
        isProcessing: false,
        currentTabId: -1,
        eventProcessor: new EventProcessor(),
      };
      chatStates.set(chat.id, state);
    }

    // Process event for this chat's state
    const processed = state.eventProcessor.processEvent(event);
    if (processed) {
      state.processedEvents = [...state.processedEvents, processed];
    }

    // Update processing state
    const msg = event.msg;
    if (msg.type === 'TaskStarted') {
      state.isProcessing = true;
    } else if (msg.type === 'TaskComplete' || msg.type === 'TaskFailed') {
      state.isProcessing = false;
    }

    chatStates.set(chat.id, state);
  }

  /**
   * Handle session terminated event
   */
  function handleSessionTerminated(sessionId: string) {
    const chat = chatStore.getChatBySessionId(sessionId);
    if (chat) {
      console.log(`[App] Session ${sessionId} terminated, removing chat ${chat.id}`);

      // Remove chat state
      chatStates.delete(chat.id);

      // Close chat in store
      chatStore.closeChat(chat.id);

      // If this was the active chat, load state for the new active chat
      const newActiveChat = chatStore.getActiveChat();
      if (newActiveChat) {
        activeSessionId = newActiveChat.sessionId;
        loadChatState(newActiveChat.id);
      } else {
        // No chats left, create a new one
        createNewChat();
      }
    }

    // Update session limits
    updateSessionLimits();
  }

  /**
   * Update session limit state
   */
  async function updateSessionLimits() {
    try {
      const response = await service!.send(MessageType.SESSION_GET_ACTIVE_COUNT);
      canCreateChat = response?.canCreateSession ?? true;
      maxSessionsReached = !canCreateChat;
    } catch (error) {
      console.error('[App] Failed to update session limits:', error);
    }
  }

  /**
   * Update chat title based on first user message
   */
  function updateChatTitleFromMessage(message: string) {
    const activeChat = chatStore.getActiveChat();
    if (activeChat && activeChat.title === 'New Chat') {
      // Use first 30 chars of message as title
      const title = message.length > 30 ? message.substring(0, 30) + '...' : message;
      chatStore.updateChatTitle(activeChat.id, title);
    }
  }
</script>

<!-- Single UI with theme-aware styling -->
<div class="main-layout {currentTheme}">
  <TerminalContainer theme={currentTheme}>
    <div class="content-container">
        <!-- Multi-Chat Bar -->
        {#if !isScheduledTaskMode}
          <ChatBar
            {canCreateChat}
            {maxSessionsReached}
            on:chatSelect={handleChatSelect}
            on:chatClose={handleChatClose}
            on:newChat={handleNewChat}
          />
        {/if}

        <!-- Status Line -->
        <div class="status-line flex justify-between mb-2">
          <TerminalMessage type="system" content={platform.platformName === 'extension' ? $_t("Browserx (Alpha)") : $_t("Apple Pi: Your personal AI (Alpha)")} />
          <div class="flex items-center space-x-2">
            {#if isProcessing}
              <TerminalMessage type="warning" content={$_t("[PROCESSING]")} />
            {/if}
            {#if !isConnected}
              <TerminalMessage type="error" content={$_t("[DISCONNECTED]")} />
            {:else if !agentReady && $agentStore.authMode === 'none'}
              <TerminalMessage type="warning" content={$_t("[NO ACCESS]")} />
            {:else if !agentReady}
              <TerminalMessage type="warning" content={$_t("[NO API KEY - CLICK SETTINGS]") + " ⚙️"} />
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
              {$_t("Context compacted: saved ~$1$k tokens", { substitutions: [Math.round(compactionNotification.tokensSaved / 1000)] })}
              {#if compactionNotification.isWarning}
                <span class="warning-text">
                  {$_t("(#$1$ - accuracy may be reduced)", { substitutions: [compactionNotification.compactionCount] })}
                </span>
              {/if}
            </span>
            <button
              class="notification-close"
              on:click={() => compactionNotification = { ...compactionNotification, show: false }}
              aria-label={t("Dismiss notification")}
            >×</button>
          </div>
        {/if}

        <!-- No Access Warning Banner -->
        {#if !agentReady && $agentStore.authMode === 'none' && isConnected}
          <div class="no-access-warning">
            <div class="warning-header">
              <span class="warning-icon">⚠️</span>
              <span class="warning-title">{$_t("No Access Configured")}</span>
            </div>
            <p class="warning-message">
              {$_t("To use the AI agent, please either:")}
            </p>
            <ul class="warning-options">
              <li>
                <a href={getLoginPageUrl()} target="_blank" rel="noopener noreferrer" class="warning-link">
                  {$_t("Log in to your account")}
                </a>
              </li>
              <li>
                <button on:click={() => push('/settings')} class="warning-link-button">
                  {$_t("Configure an API key in Settings")}
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
                {platform.platformName === 'extension' ? $_t("General in-browser AI agent for work tasks") : $_t("Your personal AI assistant")}
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
              placeholder={$_t(">> Enter command...")}
              on:tabSelected={handleTabSelected}
              on:commandOutput={handleCommandOutput}
            />
          </div>

          <!-- Footer Bar -->
          <FooterBar />
        </div>
      </div>
    </TerminalContainer>
  </div>

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
    max-width: 1200px;
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
    /* Note: position: relative and z-index removed to avoid creating a stacking context
       that would trap fixed-positioned popups (PopupCard, SchedulerPopup, etc.)
       The flex layout handles stacking order naturally. */
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
</style>
