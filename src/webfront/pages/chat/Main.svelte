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
  import { uiTheme, themePreference, type UITheme } from '../../stores/themeStore';
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
  let zoomLevel = parseInt(document.documentElement.style.fontSize) || 100;

  function onZoomChanged(e: Event) {
    zoomLevel = (e as CustomEvent<number>).detail;
  }

  function resetZoom() {
    document.documentElement.style.fontSize = '100%';
    zoomLevel = 100;
    window.dispatchEvent(new CustomEvent('zoom-changed', { detail: 100 }));
    AgentConfig.getInstance().then((config) => {
      const agentConfig = config.getConfig();
      config.updateConfig({ preferences: { ...agentConfig.preferences, zoomLevel: 100 } });
    }).catch(() => {});
  }
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
  $: showWelcome =
    !isProcessing && processedEvents.length === 0 && messages.length === 0;

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onMount(async () => {
    // Listen for zoom level changes
    window.addEventListener('zoom-changed', onZoomChanged);

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
        themePreference.initialize(preferences.uiTheme);
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
          const event = payload as Event;
          handleEvent(event);
        })
      );

      // Listen for state updates
      unsubscribers.push(
        service.on(MessageType.STATE_UPDATE, (payload) => {
          const state = payload as { tabId?: number };
          if (state && 'tabId' in state) {
            currentTabId = state.tabId!;
          }
        })
      );

      // Handle agent re-initialization (e.g., when model is changed)
      unsubscribers.push(
        service.on(MessageType.AGENT_REINITIALIZED, () => {
          // Clear all messages and events for fresh start with new agent
          messages = [];
          processedEvents = [];
          isProcessing = false;
          eventProcessor.reset();

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

    // Fetch current session's tabId from storage
    await fetchCurrentTabId();

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

      // Request agent to abort via message service
      if (service) {
        service.send(MessageType.INTERRUPT).catch((err) => {
          console.warn('[App] Failed to send interrupt on cancel:', err);
        });
      }
    }
  }

  onDestroy(() => {
    window.removeEventListener('zoom-changed', onZoomChanged);
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
      // Request current session state from backend
      const response = await service.send<{ tabId?: number; history?: unknown[] }>(MessageType.GET_STATE);
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

  async function sendMessage(overrideText?: string) {
    const text = overrideText ?? inputText.trim();
    if (!text) return;

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
      if (!service) throw new Error('Message service not available');
      await service.send(MessageType.SUBMISSION, {
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

    // Reset event processor
    eventProcessor.reset();

    // Request session reset from backend
    try {
      if (!service) throw new Error('Message service not available');
      await service.send(MessageType.SESSION_RESET);

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
      // Send stop message to backend
      await service.send(MessageType.INTERRUPT);
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
</script>

<!-- Single UI with theme-aware styling -->
<div class="h-screen overflow-hidden {currentTheme}">
  <TerminalContainer theme={currentTheme}>
    <div class="flex flex-col h-full min-h-0 max-w-[1200px] mx-auto w-full">
        <!-- Status Line -->
        <div class="shrink-0 flex justify-between mb-2">
          <div class="flex items-center space-x-2">
            <TerminalMessage type="system" content={platform.platformName === 'extension' ? $_t("Browserx (Alpha)") : $_t("Apple Pi: Your personal AI (Alpha)")} />
            {#if zoomLevel !== 100}
              <button on:click={resetZoom} class="text-xs opacity-70 hover:opacity-100 cursor-pointer" title="Reset zoom to 100%">
                [{zoomLevel}%] ✕
              </button>
            {/if}
          </div>
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
          <div class="flex items-center gap-2 rounded text-sm animate-slide-in mb-2
            {currentTheme === 'modern'
              ? (compactionNotification.isWarning
                  ? 'mx-4 rounded-lg text-sm px-4 py-3 bg-[rgba(245,158,11,0.1)] text-chat-status-warning dark:text-chat-status-warning-dark'
                  : 'mx-4 rounded-lg text-sm px-4 py-3 bg-[rgba(16,185,129,0.1)] text-chat-status-success dark:text-chat-status-success-dark')
              : (compactionNotification.isWarning
                  ? 'px-3 py-2 bg-[rgba(234,179,8,0.15)] border border-term-yellow text-term-yellow'
                  : 'px-3 py-2 bg-[rgba(34,197,94,0.15)] border border-term-dim-green text-term-bright-green')}">
            <span class="shrink-0">
              {#if compactionNotification.isWarning}⚠️{:else}✓{/if}
            </span>
            <span class="flex-1">
              {$_t("Context compacted: saved ~$1$k tokens", { substitutions: [Math.round(compactionNotification.tokensSaved / 1000)] })}
              {#if compactionNotification.isWarning}
                <span class="opacity-80 text-sm">
                  {$_t("(#$1$ - accuracy may be reduced)", { substitutions: [compactionNotification.compactionCount] })}
                </span>
              {/if}
            </span>
            <button
              class="shrink-0 bg-transparent border-none text-inherit cursor-pointer px-1 text-lg opacity-70 hover:opacity-100"
              on:click={() => compactionNotification = { ...compactionNotification, show: false }}
              aria-label={t("Dismiss notification")}
            >×</button>
          </div>
        {/if}

        <!-- No Access Warning Banner -->
        {#if !agentReady && $agentStore.authMode === 'none' && isConnected}
          <div class="animate-slide-in mb-3
            {currentTheme === 'modern'
              ? 'rounded-xl bg-[rgba(245,158,11,0.1)] p-5 border-none'
              : 'rounded border border-term-yellow bg-[rgba(255,255,0,0.05)] p-4'}">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-lg">⚠️</span>
              <span class="font-semibold {currentTheme === 'modern' ? 'text-chat-status-warning dark:text-chat-status-warning-dark' : 'text-term-yellow'}">{$_t("No Access Configured")}</span>
            </div>
            <p class="m-0 mb-2 text-sm {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-dim-green'}">
              {$_t("To use the AI agent, please either:")}
            </p>
            <ul class="m-0 pl-6 list-disc">
              <li class="mb-1">
                <a href={getLoginPageUrl()} target="_blank" rel="noopener noreferrer"
                  class="underline {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark hover:text-chat-text dark:hover:text-chat-text-dark' : 'text-term-bright-green hover:text-term-yellow'}">
                  {$_t("Log in to your account")}
                </a>
              </li>
              <li class="mb-1">
                <button on:click={() => push('/settings')}
                  class="bg-none border-none p-0 underline cursor-pointer text-[inherit] {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark hover:text-chat-text dark:hover:text-chat-text-dark' : 'text-term-bright-green hover:text-term-yellow'}">
                  {$_t("Configure an API key in Settings")}
                </button>
              </li>
            </ul>
          </div>
        {/if}

        <!-- Messages - scrollable area -->
        <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-4" bind:this={scrollContainer}>
          {#if showWelcome}
            <div class="welcome-screen mb-6 max-w-full
              {currentTheme === 'modern'
                ? 'flex flex-col items-center justify-center text-center border-none bg-transparent min-h-[50vh] gap-3 p-6'
                : 'flex flex-col items-start gap-3 p-6 border border-term-dim-green rounded bg-[rgba(0,0,0,0.6)]'}"
              role="presentation"
            >
              {#if $userStore.isLoggedIn && ($userStore.userName || $userStore.userEmail)}
                <p class="m-0 mb-2 font-semibold text-lg
                  {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark text-xl' : 'text-term-bright-green'}">{$_t("Hello $NAME$", { substitutions: [$userStore.userName || $userStore.userEmail] })}</p>
              {/if}
              <pre class="welcome-ascii m-0 font-terminal text-[0.4rem] leading-none whitespace-pre">{#each welcomeAsciiLines as line, index (index)}<span class={line.color}>{line.text}</span>{/each}</pre>
              <p class="m-0 text-[0.95rem] text-term-blue">
                {platform.platformName === 'extension' ? $_t("General in-browser AI agent for work tasks") : $_t("Your personal AI assistant")}
              </p>
              <p class="m-0 text-[0.95rem] text-term-dim-green">
                {$_t("Developed and supported by AI Republic")}
              </p>
              <a
                class="underline {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark hover:text-chat-text dark:hover:text-chat-text-dark' : 'text-term-bright-green hover:text-term-yellow'}"
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
        <div class="shrink-0 border-t {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
          <!-- Input area -->
          <div class="pr-2 py-2 pl-0">
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
  /* Animations - kept as they use @keyframes */
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

  .animate-slide-in {
    animation: slideIn 0.3s ease;
  }

  /* Welcome ASCII art - needs block display for spans */
  .welcome-ascii :global(span) {
    display: block;
  }
</style>
