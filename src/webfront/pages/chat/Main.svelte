<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { UIChannelClient } from '@/core/messaging';
  import type { JobStatusChangedEvent } from '@/core/models/types/SchedulerContracts';
  import type { Event, InputItem } from '@/core/protocol/types';
  import type { AgentAccessState } from '@/core/services/runtime-state';
  import type { ProcessedEvent } from '@/types/ui';
  import { STYLE_PRESETS } from '@/types/ui';

  import TerminalMessage from '../../components/TerminalMessage.svelte';
  import MessageInput from '../../components/MessageInput.svelte';
  import MessageSelector from '../../components/chat/MessageSelector.svelte';
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
  // Agent store for auth mode tracking
  import { agentStore } from '../../stores/agentStore';
  // Scheduler store (for scheduling result feedback)
  import { schedulerStore } from '../../stores/schedulerStore';
  // i18n
  import { t, _t } from '../../lib/i18n';
  // Multi-thread support
  import { get } from 'svelte/store';
  import ThreadBar from '../../components/threads/ThreadBar.svelte';
  import BackgroundTasksBadge from '../../components/BackgroundTasksBadge.svelte';
  import { threadStore, activeThread } from '../../stores/threadStore';
  import { MODES, DEFAULT_MODE, type AgentMode } from '@/prompts/PromptComposer';
  import { ThreadEventRouter } from '../../routing/ThreadEventRouter';
  import { handleBackgroundTaskEvent, startBackgroundTaskPolling, stopBackgroundTaskPolling } from '../../stores/backgroundTaskStore';
  // Resume-request bridge from the left-panel Chat History section.
  import { resumeRequest, clearResumeRequest } from '../../stores/chatHistoryStore';
  // UI channel client (platform-agnostic)
  let client: UIChannelClient | null = $state(null);
  let unsubscribers: Array<() => void> = $state([]);
  let eventProcessor: EventProcessor;
  let messages: Array<{ type: 'user' | 'agent'; content: string; timestamp: number }> = $state([]);
  let processedEvents: ProcessedEvent[] = $state([]);
  let inputText: string = $state('');
  // Track 24.3: predicted next user message (bound into MessageInput).
  let nextSuggestion: string | null = $state(null);
  // Track 15: rewind turn-selector overlay visibility.
  let showRewindSelector: boolean = $state(false);
  let isConnected: boolean = $state(false);
  let isProcessing: boolean = $state(false);
  let showWelcome = $derived(!isProcessing && processedEvents.length === 0 && messages.length === 0);
  let scrollContainer: HTMLDivElement;
  let currentTabId: number = $state(-1); // Track current session's bound tab
  let agentReady: boolean = $state(false);
  let healthStatus: { ready: boolean; message?: string; provider?: string; model?: string; authMode?: 'login' | 'api_key' | 'none' } = $state({ ready: false, authMode: 'none' });
  let zoomLevel: number = $state(parseInt(document.documentElement.style.fontSize) || 100);

  // Handle "resume this conversation" requests published by the left-panel
  // Chat History section. The section can't call resumeConversation directly
  // (separate component), so it sets a request in the store; we act on it once
  // the client is ready. Tracking the nonce (and clearing the request) avoids
  // re-resuming a stale conversation when this page remounts.
  let lastResumeNonce = 0;
  $effect(() => {
    const req = $resumeRequest;
    if (!req || req.nonce === lastResumeNonce) return;
    // `client` is a dependency: when it becomes ready this effect re-runs and
    // processes a request that arrived before initialization finished.
    if (!client) return;
    lastResumeNonce = req.nonce;
    clearResumeRequest();

    // Switch the active thread to the requested session *before* resuming, the
    // same way handleRewound does for a session swap. resumeConversation ->
    // restoreConversationHistory only renders into the UI when the restored
    // session is the active one, so without this the resumed conversation would
    // load into threadStates but never appear on screen.
    if (!threadStore.getThread(req.sessionId)) {
      threadStore.createThread(req.sessionId, 'New Thread');
    }
    activeSessionId = req.sessionId;
    threadStore.setActiveThread(req.sessionId);
    threadRouter.setActiveSession(req.sessionId);

    void resumeConversation(req.sessionId);
  });

  function applyAccessState(access: AgentAccessState): void {
    isConnected = true;
    agentReady = access.ready;
    healthStatus = {
      ready: access.ready,
      message: access.reason,
      provider: access.provider,
      model: access.model,
      authMode: access.mode,
    };
    agentStore.updateFromAccessState(access);
  }

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

  function requestLogin() {
    if (platform.platformName === 'desktop') {
      window.dispatchEvent(new CustomEvent('workx:request-login'));
      return;
    }
    const loginUrl = getLoginPageUrl();
    if (loginUrl) {
      window.open(loginUrl, '_blank', 'noopener,noreferrer');
    }
  }
  let compactionNotification: { show: boolean; tokensSaved: number; compactionCount: number; isWarning: boolean } = $state({
    show: false,
    tokensSaved: 0,
    compactionCount: 0,
    isWarning: false,
  });
  // Current UI theme (reactive from store)
  let currentTheme = $derived($uiTheme);
  // Scheduled job execution state (US3)
  let scheduledJobId: string | null = $state(null);
  let scheduledSessionId: string | null = $state(null);
  let isScheduledJobMode: boolean = $state(false);

  // Multi-thread state
  interface ThreadConversationState {
    messages: Array<{ type: 'user' | 'agent'; content: string; timestamp: number }>;
    processedEvents: ProcessedEvent[];
    inputText: string;
    isProcessing: boolean;
    currentTabId: number;
    eventProcessor: EventProcessor;
  }
  let threadStates: Map<string, ThreadConversationState> = new Map();
  let activeSessionId: string | null = null;
  const threadRouter = new ThreadEventRouter();
  let canCreateThread: boolean = true;
  let maxSessionsReached: boolean = false;


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

    // Initialize UIChannelClient for event listening
    try {
      client = await getInitializedUIClient();
      console.log('[App] UIChannelClient initialized');

      // Configure thread event router
      threadRouter.setActiveSession(activeSessionId);

      threadRouter.onActiveThread((channelEvent) => {
        if (channelEvent.msg.type.startsWith('BackgroundTask')) {
          handleBackgroundTaskEvent(channelEvent.msg);
          return;
        }
        const event: Event = { id: `evt_${Date.now()}`, msg: channelEvent.msg };
        handleEvent(event);
      });

      threadRouter.onBackgroundThread((channelEvent) => {
        if (channelEvent.msg.type.startsWith('BackgroundTask')) {
          handleBackgroundTaskEvent(channelEvent.msg);
          return;
        }
        const event: Event = { id: `evt_${Date.now()}`, msg: channelEvent.msg };
        handleEventForSession(event, channelEvent.sessionId!);
      });

      threadRouter.onChannel((channelEvent) => {
        const { msg } = channelEvent;
        if (msg.type === 'StateUpdate' && 'data' in msg) {
          const data = msg.data;
          if (data?.scope === 'desktop-runtime' && data.kind === 'agent.accessChanged' && data.access) {
            applyAccessState(data.access as AgentAccessState);
          } else if (data && 'tabId' in data) {
            currentTabId = data.tabId!;
          }
        } else if (msg.type === 'ModeChanged' && 'data' in msg) {
          // Backend is the source of truth — commit on applied, show pending
          // otherwise. Never flip optimistically on click.
          const { sessionId, mode, applied } = (msg as any).data;
          if (applied) {
            threadStore.setThreadMode(sessionId, mode);
            const event: Event = { id: `evt_${Date.now()}`, msg };
            if (sessionId === activeSessionId) {
              handleEvent(event);
            } else {
              handleEventForSession(event, sessionId);
            }
          } else {
            threadStore.setThreadPendingMode(sessionId, mode);
          }
        } else if (msg.type === 'BackgroundEvent' && 'data' in msg) {
          const data = (msg as any).data;
          if (data?.message?.startsWith('Agent reinitialized') && activeSessionId) {
            checkConnection();
          } else if (data?.message === 'scheduler_job_status' && data?.schedulerEvent) {
            handleSchedulerEvent(data.schedulerEvent as JobStatusChangedEvent);
          }
        }
      });

      // Single wildcard handler feeds the router
      unsubscribers.push(
        client.onEvent('*', (channelEvent) => threadRouter.route(channelEvent))
      );
      startBackgroundTaskPolling(() => {
        if (!client || !activeSessionId) return null;
        return {
          async listTaskStates() {
            const response = await client!.serviceRequest<{ tasks?: import('@/core/tasks/types').TaskState[] }>(
              'session.listTaskStates',
              { sessionId: activeSessionId },
            );
            return response.tasks ?? [];
          },
          async getTaskOutput(taskId: string, fromSeq = 0) {
            const response = await client!.serviceRequest<{ chunks?: import('@/core/tasks/TaskOutputStore').TaskOutputChunk[] }>(
              'session.getTaskOutput',
              { sessionId: activeSessionId, taskId, fromSeq },
            );
            return response.chunks ?? [];
          },
          retainTask(taskId: string, retain: boolean) {
            void client!.serviceRequest('session.retainTask', {
              sessionId: activeSessionId,
              taskId,
              retain,
            });
          },
        };
      });
    } catch (error) {
      console.error('[App] UIChannelClient initialization failed:', error);
    }

    // Check if this is a scheduled job execution (US3: T022)
    // Extension: detected via URL params from chrome.tabs.create
    // Desktop: detected via DOM event from the runtime job launcher
    const urlParams = new URLSearchParams(window.location.search);
    const jobIdParam = urlParams.get('scheduledJob');
    const sessionIdParam = urlParams.get('sessionId');

    if (jobIdParam && sessionIdParam) {
      console.log('[App] Scheduled job mode detected:', jobIdParam);
      scheduledJobId = jobIdParam;
      scheduledSessionId = sessionIdParam;
      isScheduledJobMode = true;

      // Load and execute the scheduled job
      await loadAndExecuteSchedulerJob(jobIdParam, sessionIdParam);
      return; // Skip normal initialization for scheduled job mode
    }

    // Sync thread store with backend sessions (also restores history per thread)
    await syncThreadsWithSessions();

    // Check connection (after sync so activeSessionId is set)
    checkConnection();

    // Fetch current session's tabId (after sync so activeSessionId is set)
    await fetchCurrentTabId();

    // ========================================================================
    // KEEP-ALIVE: Send periodic pings to prevent service worker termination
    // ========================================================================
    // Keep-alive ping for Chrome extension (service worker stays awake)
    // Only needed for extension mode - Tauri doesn't have this limitation
    let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
    if (platform.platformName === 'extension' && client) {
      keepAliveInterval = setInterval(async () => {
        try {
          await (await getInitializedUIClient()).serviceRequest('agent.ping');
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
      stopBackgroundTaskPolling();
    };
  });

  // T035: Handle scheduled job cancellation events
  function handleSchedulerEvent(event: JobStatusChangedEvent) {
    // Check if this is a cancellation for our running job
    if (
      isScheduledJobMode &&
      scheduledJobId &&
      event?.jobId === scheduledJobId &&
      event?.newStatus === 'cancelled'
    ) {
      console.log('[App] Scheduled job cancelled, aborting execution:', scheduledJobId);

      // Stop processing
      isProcessing = false;

      // Add cancellation notice to UI
      const cancelNotice: ProcessedEvent = {
        id: `scheduled_cancel_${Date.now()}`,
        category: 'system',
        timestamp: new Date(),
        title: 'system',
        content: t('Job cancelled by user'),
        style: { textColor: 'text-yellow-400' },
        streaming: false,
        collapsible: false,
      };
      processedEvents = [...processedEvents, cancelNotice];

      // Request agent to abort via message service
      if (client && activeSessionId) {
        getInitializedUIClient().then(c => c.serviceRequest('agent.interrupt', { sessionId: activeSessionId })).catch((err) => {
          console.warn('[App] Failed to send interrupt on cancel:', err);
        });
      }
    }
  }

  onDestroy(() => {
    // Save active thread state so it can be restored if component remounts
    // (Note: threadStates is in-memory and won't survive remount, but the backend
    // is the source of truth — restoreAllThreadHistories() handles remount recovery)
    if (activeSessionId) {
      saveThreadState(activeSessionId);
    }
    window.removeEventListener('zoom-changed', onZoomChanged);
  });

  /**
   * Fetch the current session's tabId from BrowserAgent session
   * US3: Get tabId from session on mount
   * If tabId is -1, automatically bind to the current active tab (extension only)
   * Note: Conversation history restoration is handled by restoreAllThreadHistories()
   */
  async function fetchCurrentTabId() {
    if (!client) {
      console.warn('[App] Service not available for fetchCurrentTabId');
      currentTabId = -1;
      return;
    }

    try {
      // Request current session state from backend (uses active session if available)
      const response = await (await getInitializedUIClient()).serviceRequest<{ tabId?: number }>(
        'session.getState',
        activeSessionId ? { sessionId: activeSessionId } : undefined
      );

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
   * Parse history items into processedEvents and messages for display.
   * Shared by restoreConversationHistory (single-thread) and
   * restoreAllThreadHistories (multi-thread).
   */
  function parseHistoryItems(historyItems: any[], idPrefix: string = 'restored'): {
    events: ProcessedEvent[];
    firstUserMessage: string | null;
  } {
    const events: ProcessedEvent[] = [];
    let firstUserMessage: string | null = null;

    for (let i = 0; i < historyItems.length; i++) {
      const item = historyItems[i];
      if (item.type !== 'message') continue;

      const isUser = item.role === 'user';
      let text = '';

      // Extract text from content items
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

      if (!text.trim()) continue;

      const event: ProcessedEvent = {
        id: `${idPrefix}_${i}_${Date.now()}`,
        category: 'message',
        timestamp: new Date(),
        title: isUser ? 'user' : 'workx',
        content: text,
        style: isUser ? { textColor: 'text-cyan-400' } : STYLE_PRESETS.agent_message,
        streaming: false,
        collapsible: false,
      };

      // Carry modelKey from assistant messages for model indicator display
      if (!isUser && item.modelKey) {
        event.modelKey = item.modelKey;
      }

      events.push(event);

      if (isUser && firstUserMessage === null) {
        firstUserMessage = text;
      }
    }

    return { events, firstUserMessage };
  }

  /**
   * Fetch and restore conversation history for a single session.
   * Stores the result in threadStates and optionally loads it into the active UI.
   */
  async function restoreConversationHistory(sessionId: string): Promise<void> {
    const c = await getInitializedUIClient();
    const response = await c.serviceRequest<{
      sessionId?: string;
      tabId?: number;
      history?: unknown[];
    }>('session.getState', { sessionId });
    const historyItems = response?.history as any[] | undefined;
    const tabId = response?.tabId ?? -1;

    const { events, firstUserMessage } = historyItems && Array.isArray(historyItems)
      ? parseHistoryItems(historyItems, `restored_${sessionId}`)
      : { events: [], firstUserMessage: null };

    // Update thread title from first user message if still default
    const thread = get(threadStore).threads.find(t => t.sessionId === sessionId);
    if (thread?.title === 'New Thread' && firstUserMessage) {
      const title = firstUserMessage.length > 30 ? firstUserMessage.substring(0, 30) + '...' : firstUserMessage;
      threadStore.updateThreadTitle(sessionId, title);
    }

    threadStates.set(sessionId, {
      messages: [],
      processedEvents: events,
      inputText: '',
      isProcessing: false,
      currentTabId: tabId,
      eventProcessor: new EventProcessor(),
    });

    // If this is the active thread, load into the UI
    if (sessionId === activeSessionId) {
      loadThreadState(sessionId);
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
    console.log('[App] checkConnection called, client:', !!client);
    try {
      if (!client) {
        console.warn('[App] checkConnection: no client available');
        isConnected = false;
        agentReady = false;
        healthStatus = { ready: false, message: t('Message service not available'), authMode: 'none' };
        return;
      }

      if (platform.platformName === 'desktop') {
        console.log('[App] Sending agent.getAccessState serviceRequest...');
        const access = await (await getInitializedUIClient()).serviceRequest<AgentAccessState>('agent.getAccessState');
        applyAccessState(access);
        return;
      }

      console.log('[App] Sending agent.healthCheck serviceRequest...');
      const response = await (await getInitializedUIClient()).serviceRequest<{
        type?: string;
        ready?: boolean;
        message?: string;
        provider?: string;
        model?: string;
        authMode?: 'login' | 'api_key' | 'none';
      }>('agent.healthCheck', activeSessionId ? { sessionId: activeSessionId } : undefined);

      console.log('[App] healthCheck response:', JSON.stringify(response));
      isConnected = response?.ready !== undefined;

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
  async function handleTabSelected(value: { tabId: number }) {
    const newTabId = value.tabId;
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
      nextSuggestion = null; // Track 24.3: a new turn invalidates the prediction.
      // Note: We don't clear history here - user wants to see full conversation
      // History is only cleared when user explicitly clicks "New Conversation"
    } else if (msg.type === 'TaskComplete' || msg.type === 'TaskFailed') {
      isProcessing = false;

      // If this is a scheduled job execution, notify the scheduler (US3)
      // Desktop/server: completion is handled at the bootstrap level (event interception)
      // Extension: still relies on UI-level notification via message service
      if (isScheduledJobMode && scheduledJobId && platform.platformName === 'extension') {
        notifySchedulerJobCompletion(msg.type === 'TaskComplete', msg);
      }
    }

    // Keep legacy Error message handling for backward compatibility
    // Note: AgentMessage case removed - agent messages are now handled by EventProcessor
    switch (msg.type) {
      case 'PromptSuggestion':
        if ('data' in msg && msg.data?.suggestion) {
          nextSuggestion = msg.data.suggestion;
        }
        break;
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

  async function sendMessage(overrideText?: string, attachments?: InputItem[]) {
    const text = overrideText ?? inputText.trim();
    // Track 13: allow image-only submissions (text may be empty when the
    // user pastes a screenshot and sends without typing).
    if (!text && !(attachments && attachments.length)) return;

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
      content: text || (attachments && attachments.length ? `[${attachments.length} image(s)]` : ''),
      style: { textColor: 'text-cyan-400' },
      streaming: false,
      collapsible: false,
    };
    processedEvents = [...processedEvents, userEvent];

    // Send to agent with tab context
    try {
      if (!client) throw new Error('Message service not available');
      const items: InputItem[] = [];
      if (text) items.push({ type: 'text', text });
      if (attachments && attachments.length) items.push(...attachments);
      await client.submitOp(
        {
          type: 'UserInput',
          items,
        },
        {
          tabId: currentTabId, // Include current tab selection in context
          sessionId: activeSessionId, // Route to correct agent session
        },
      );

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
  function handleCommandOutput(value: { title: string; content: string }) {
    const { title, content } = value;
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
      if (!client) throw new Error('Message service not available');
      await (await getInitializedUIClient()).serviceRequest('session.reset', { sessionId: activeSessionId });

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
      if (!client) throw new Error('Message service not available');
      // Send stop message to backend
      await (await getInitializedUIClient()).serviceRequest('agent.interrupt', { sessionId: activeSessionId });
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
  async function resumeConversation(sessionId: string) {
    console.log('[App] Resuming conversation:', sessionId);

    // Clear current UI state
    messages = [];
    processedEvents = [];
    inputText = '';
    isProcessing = false;

    // Reset event processor
    eventProcessor.reset();

    try {
      if (!client) throw new Error('Message service not available');
      // Request session resume from backend
      const response = await (await getInitializedUIClient()).serviceRequest<{ history?: unknown[] }>('session.resume', { sessionId });

      console.log('[App] Conversation resumed:', sessionId);

      // Restore history to UI
      await restoreConversationHistory(sessionId);
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
   * Track 15: handle a completed rewind. The backend forked a NEW conversation
   * (source untouched) and returned its id + history. Swap the UI to it,
   * render the sliced history, and (for a plain `conversation` rewind)
   * repopulate the input with the rewound-to user turn's text (D8).
   */
  async function handleRewound(result: {
    sessionId: string;
    history?: unknown[];
    rewoundText?: string;
  }) {
    showRewindSelector = false;
    const newId = result?.sessionId;
    if (!newId) return;

    // Clear current UI state.
    messages = [];
    processedEvents = [];
    inputText = '';
    isProcessing = false;
    eventProcessor.reset();

    // Id swap: register a thread for the forked conversation and switch to it
    // (the source conversation remains in history, untouched).
    if (!threadStore.getThread(newId)) {
      threadStore.createThread(newId, 'New Thread');
    }
    threadStates.set(newId, {
      messages: [],
      processedEvents: [],
      inputText: '',
      isProcessing: false,
      currentTabId: -1,
      eventProcessor: new EventProcessor(),
    });
    activeSessionId = newId;
    threadStore.setActiveThread(newId);
    threadRouter.setActiveSession(newId);

    try {
      await restoreConversationHistory(newId);
    } catch (error) {
      console.error('[App] Failed to restore rewound conversation:', error);
    }

    // D8: repopulate input AFTER restore (restore/loadThreadState clobbers it).
    if (result.rewoundText) {
      inputText = result.rewoundText;
    }
  }

  /**
   * Notify scheduler of job completion (US3)
   * Called when a scheduled job finishes executing
   */
  async function notifySchedulerJobCompletion(success: boolean, msg: any) {
    if (!scheduledJobId || !client) return;

    try {
      if (success) {
        // Extract result summary from the processed events
        const lastAgentEvent = processedEvents.filter(e => e.title === 'workx').pop();
        const resultSummary = lastAgentEvent?.content?.slice(0, 500) || 'Job completed';

        await (await getInitializedUIClient()).serviceRequest('scheduler.complete', {
          jobId: scheduledJobId,
          result: {
            summary: resultSummary,
            completedAt: Date.now(),
          },
        });
        console.log('[App] Notified scheduler of job completion:', scheduledJobId);
      } else {
        const errorMessage = msg?.data?.message || 'Job failed';
        await (await getInitializedUIClient()).serviceRequest('scheduler.fail', {
          jobId: scheduledJobId,
          error: errorMessage,
        });
        console.log('[App] Notified scheduler of job failure:', scheduledJobId);
      }
    } catch (error) {
      console.error('[App] Failed to notify scheduler of job completion:', error);
    }
  }

  /**
   * Load and execute a scheduled job (US3: T023)
   * Called when the page is opened with scheduledJob URL parameter
   */
  async function loadAndExecuteSchedulerJob(jobId: string, sessionId: string) {
    console.log('[App] Loading scheduled job:', jobId, 'with session:', sessionId);

    try {
      if (!client) throw new Error('Message service not available');
      // Fetch job details from scheduler
      const response = await (await getInitializedUIClient()).serviceRequest<{ job?: { input: string; scheduledTime?: number } }>(
        'scheduler.getJobDetails',
        { jobId }
      );

      const jobData = response?.data || response;
      if (!jobData || !jobData.job) {
        throw new Error('Job not found or invalid response');
      }

      const job = jobData.job;
      console.log('[App] Scheduled job loaded:', job);

      // Display job input as user message
      const userEvent: ProcessedEvent = {
        id: `scheduled_user_${Date.now()}`,
        category: 'message',
        timestamp: new Date(),
        title: 'user',
        content: job.input,
        style: { textColor: 'text-cyan-400' },
        streaming: false,
        collapsible: false,
      };
      processedEvents = [userEvent];

      // Add a system notification showing this is a scheduled job
      const scheduleNotification: ProcessedEvent = {
        id: `scheduled_notice_${Date.now()}`,
        category: 'system',
        timestamp: new Date(),
        title: 'system',
        content: `Executing scheduled job (${job.scheduledTime ? new Date(job.scheduledTime).toLocaleString() : 'manual trigger'})`,
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

      // Execute the job via the agent
      // Feature 015: Include sessionId in context for multi-agent routing
      isProcessing = true;
      await client!.submitOp(
        {
          type: 'UserInput',
          items: [{ type: 'text', text: job.input }],
        },
        {
          tabId: currentTabId,
          sessionId: sessionId, // Feature 015: Route to correct agent session
        },
      );

    } catch (error) {
      console.error('[App] Failed to execute scheduled job:', error);

      // Notify scheduler of failure
      try {
        if (client) {
          await (await getInitializedUIClient()).serviceRequest('scheduler.fail', {
            jobId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      } catch (notifyError) {
        console.error('[App] Failed to notify scheduler of job failure:', notifyError);
      }

      // Show error in UI
      const errorEvent: ProcessedEvent = {
        id: `scheduled_error_${Date.now()}`,
        category: 'message',
        timestamp: new Date(),
        title: 'workx',
        content: `Failed to execute scheduled task: ${error instanceof Error ? error.message : 'Unknown error'}`,
        style: STYLE_PRESETS.error,
        streaming: false,
        collapsible: false,
      };
      processedEvents = [...processedEvents, errorEvent];
      isProcessing = false;
    }
  }

  // =========================================================================
  // Multi-thread functions
  // =========================================================================

  /**
   * Sync thread store with backend sessions on startup.
   * Ensures every backend session has a corresponding thread,
   * and the primary session always has a thread entry.
   */
  async function syncThreadsWithSessions() {
    try {
      const c = await getInitializedUIClient();

      // Try to get session list from registry
      const listResponse = await c.serviceRequest<{
        sessions: Array<{ sessionId: string; type: string; state: string }>;
        maxConcurrent: number;
        activeCount: number;
      }>('session.list');

      const backendSessions = listResponse?.sessions?.filter(s => s.state !== 'terminated' && s.type !== 'scheduled') ?? [];

      if (backendSessions.length > 0) {
        // Create threads for backend sessions that don't have one
        const currentState = get(threadStore);
        const existingSessionIds = new Set(currentState.threads.map(t => t.sessionId));

        // Also remove threads whose sessions no longer exist in the backend
        const backendSessionIds = new Set(backendSessions.map(s => s.sessionId));
        for (const thread of currentState.threads) {
          if (!backendSessionIds.has(thread.sessionId)) {
            threadStore.closeThread(thread.sessionId);
          }
        }

        for (const session of backendSessions) {
          if (!existingSessionIds.has(session.sessionId)) {
            threadStore.createThread(session.sessionId, 'New Thread');
          }
        }
      } else {
        // No active sessions — create one
        console.log('[App] No active sessions found, creating initial session');
        await createNewThread();
      }

      // Ensure we have an active thread
      const finalState = get(threadStore);
      if (finalState.threads.length > 0 && !finalState.activeSessionId) {
        threadStore.setActiveThread(finalState.threads[0].sessionId);
      }

      // Set active session ID for event routing
      const activeThread = threadStore.getActiveThread();
      if (activeThread) {
        activeSessionId = activeThread.sessionId;
        threadRouter.setActiveSession(activeSessionId);
      }

      // Restore conversation history for each thread from backend
      await restoreAllThreadHistories();

      // Update session limits
      await updateSessionLimits();

      console.log(`[App] Thread sync complete: ${get(threadStore).threads.length} thread(s)`);
    } catch (error) {
      console.error('[App] Failed to sync threads with sessions:', error);
    }
  }

  /**
   * Fetch and restore conversation history for all threads from the backend.
   */
  async function restoreAllThreadHistories() {
    const allThreads = get(threadStore).threads;

    await Promise.all(
      allThreads.map(async (thread) => {
        try {
          await restoreConversationHistory(thread.sessionId);
        } catch (error) {
          console.warn(`[App] Failed to restore history for thread ${thread.sessionId}:`, error);
        }
      })
    );
  }

  /**
   * Create a new thread with a new session
   */
  async function createNewThread() {
    try {
      const c = await getInitializedUIClient();
      const response = await c.serviceRequest<{ success: boolean; sessionId?: string; error?: string }>('session.create');

      if (!response?.success) {
        console.error('[App] Failed to create session:', response?.error);
        maxSessionsReached = response?.error?.includes('Maximum') ?? false;
        return;
      }

      const { sessionId } = response;
      if (!sessionId) return;

      // Create thread in store
      const newThread = threadStore.createThread(sessionId, 'New Thread');

      // Initialize state for new thread
      const newState: ThreadConversationState = {
        messages: [],
        processedEvents: [],
        inputText: '',
        isProcessing: false,
        currentTabId: -1,
        eventProcessor: new EventProcessor(),
      };
      threadStates.set(sessionId, newState);

      // Switch to the new thread
      activeSessionId = sessionId;
      threadRouter.setActiveSession(sessionId);
      loadThreadState(sessionId);

      // Update session limits
      await updateSessionLimits();

      // Auto-bind to active browser tab
      await bindToActiveTab();

      console.log(`[App] Created new thread with session: ${sessionId}`);
    } catch (error) {
      console.error('[App] Failed to create new thread:', error);
    }
  }

  /**
   * Handle thread selection from ThreadBar
   */
  function handleThreadSelect(event: CustomEvent<{ sessionId: string }>) {
    const { sessionId } = event.detail;
    switchToThread(sessionId);
  }

  /**
   * Switch to a specific thread by sessionId
   */
  function switchToThread(sessionId: string) {
    // Save current thread state before switching
    if (activeSessionId) {
      saveThreadState(activeSessionId);
    }

    // Set new active thread
    threadStore.setActiveThread(sessionId);

    // Update active session ID and router BEFORE loading state so that events
    // arriving during the transition are routed to the correct thread
    activeSessionId = sessionId;
    threadRouter.setActiveSession(sessionId);

    // Load state for new thread
    loadThreadState(sessionId);
  }

  /**
   * Save current UI state to thread state map
   */
  function saveThreadState(sessionId: string) {
    const state: ThreadConversationState = {
      messages: [...messages],
      processedEvents: [...processedEvents],
      inputText,
      isProcessing,
      currentTabId,
      eventProcessor: eventProcessor,
    };
    threadStates.set(sessionId, state);
  }

  /**
   * Load thread state from map to UI
   */
  function loadThreadState(sessionId: string) {
    const state = threadStates.get(sessionId);
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

    // Reset scroll position after loading new thread state
    if (scrollContainer) {
      setTimeout(() => {
        if (messages.length === 0 && processedEvents.length === 0) {
          scrollContainer.scrollTop = 0;
        } else {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }, 0);
    }
  }

  /**
   * Handle thread close from ThreadBar
   */
  async function handleThreadClose(event: CustomEvent<{ sessionId: string }>) {
    const { sessionId } = event.detail;
    await closeThread(sessionId);
  }

  /**
   * Close a thread and terminate its session
   */
  async function closeThread(sessionId: string) {
    const state = get(threadStore);
    const threadToClose = state.threads.find(t => t.sessionId === sessionId);

    if (!threadToClose) return;

    // If this is the last thread, create a new one first
    if (state.threads.length <= 1) {
      const countBefore = get(threadStore).threads.length;
      await createNewThread();
      const countAfter = get(threadStore).threads.length;
      if (countAfter <= countBefore) {
        console.error('[App] Failed to create replacement thread, aborting close');
        return;
      }
    }

    // Terminate the session in backend
    try {
      const c = await getInitializedUIClient();
      await c.serviceRequest('session.close', { sessionId });
    } catch (error) {
      console.error(`[App] Failed to close session ${sessionId}:`, error);
    }

    // Remove thread state
    threadStates.delete(sessionId);

    // Close thread in store (this handles switching to another thread)
    threadStore.closeThread(sessionId);

    // Update active session
    const newActiveThread = threadStore.getActiveThread();
    if (newActiveThread) {
      activeSessionId = newActiveThread.sessionId;
      threadRouter.setActiveSession(activeSessionId);
      loadThreadState(newActiveThread.sessionId);
    }

    // Update session limits
    await updateSessionLimits();

    console.log(`[App] Closed thread: ${sessionId}`);
  }

  /**
   * Request a per-session persona mode switch for the active thread.
   * Backend is the source of truth — we do NOT flip the UI optimistically.
   * The tab commits its mode only when a ModeChanged{applied:true} event
   * arrives (see threadRouter.onChannel). Deferred switches surface as a
   * pending state until the running task completes.
   */
  async function setSessionMode(mode: AgentMode) {
    if (!activeSessionId || !client) return;
    if (($activeThread?.mode ?? DEFAULT_MODE) === mode && !$activeThread?.pendingMode) return;
    try {
      await client.submitOp(
        { type: 'SetSessionMode', mode },
        { sessionId: activeSessionId },
      );
    } catch (error) {
      console.error('Failed to set session mode:', error);
    }
  }

  /**
   * Handle new thread button click from ThreadBar
   */
  async function handleNewThread() {
    if (activeSessionId) {
      saveThreadState(activeSessionId);
    }
    await createNewThread();
  }

  /**
   * Handle event for a specific session (background thread)
   */
  function handleEventForSession(event: Event, sessionId: string) {
    const thread = threadStore.getThread(sessionId);
    if (!thread) return;

    let state = threadStates.get(sessionId);
    if (!state) {
      state = {
        messages: [],
        processedEvents: [],
        inputText: '',
        isProcessing: false,
        currentTabId: -1,
        eventProcessor: new EventProcessor(),
      };
      threadStates.set(sessionId, state);
    }

    // Process event for this thread's state
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

    threadStates.set(sessionId, state);
  }

  /**
   * Handle session terminated event
   */
  function handleSessionTerminated(sessionId: string) {
    const thread = threadStore.getThread(sessionId);
    if (thread) {
      console.log(`[App] Session ${sessionId} terminated, removing thread`);
      threadStates.delete(sessionId);
      threadStore.closeThread(sessionId);

      const newActiveThread = threadStore.getActiveThread();
      if (newActiveThread) {
        activeSessionId = newActiveThread.sessionId;
        threadRouter.setActiveSession(activeSessionId);
        loadThreadState(newActiveThread.sessionId);
      } else {
        createNewThread();
      }
    }

    updateSessionLimits();
  }

  /**
   * Update session limit state
   */
  async function updateSessionLimits() {
    try {
      const c = await getInitializedUIClient();
      const response = await c.serviceRequest<{ canCreateSession?: boolean }>('session.getActiveCount');
      canCreateThread = response?.canCreateSession ?? true;
      maxSessionsReached = !canCreateThread;
    } catch (error) {
      console.error('[App] Failed to update session limits:', error);
    }
  }

  /**
   * Update thread title based on first user message
   */
  function updateThreadTitleFromMessage(message: string) {
    const activeThread = threadStore.getActiveThread();
    if (activeThread && activeThread.title === 'New Thread') {
      const title = message.length > 30 ? message.substring(0, 30) + '...' : message;
      threadStore.updateThreadTitle(activeThread.sessionId, title);
    }
  }
</script>

<!-- Single UI with theme-aware styling -->
<div class="flex flex-col overflow-hidden p-4 {currentTheme}
    {currentTheme === 'modern'
      ? 'font-chat bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
      : 'font-terminal bg-term-bg text-term-green'}"
  role="log"
  aria-label="Terminal output"
>
        <!-- Multi-Thread Bar -->
        {#if !isScheduledJobMode}
          <ThreadBar
            {canCreateThread}
            {maxSessionsReached}
            on:threadSelect={handleThreadSelect}
            on:threadClose={handleThreadClose}
            on:newThread={handleNewThread}
          />
        {/if}

    <div class="flex flex-col flex-1 min-h-0 max-w-[1500px] mx-auto w-full">
        <!-- Status Line -->
        <div class="shrink-0 flex justify-between mb-2">
          <div class="flex items-center space-x-2">
            <TerminalMessage type="system" content={platform.platformName === 'extension' ? $_t("WorkX (Alpha)") : $_t("WorkX: Your personal AI (Alpha)")} />
            {#if zoomLevel !== 100}
              <button onclick={resetZoom} class="text-sm leading-relaxed font-[inherit] opacity-70 hover:opacity-100 cursor-pointer {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}" title="Reset zoom to 100%">
                [{zoomLevel}%] ✕
              </button>
            {/if}
          </div>
          <div class="flex items-center space-x-2">
            <BackgroundTasksBadge />
            {#if platform.platformName !== 'extension' && activeSessionId}
              {@const activeMode = $activeThread?.mode ?? DEFAULT_MODE}
              {@const pendingMode = $activeThread?.pendingMode ?? null}
              <div class="flex items-center gap-1" role="group" aria-label={$_t("Agent mode")}>
                {#each Object.values(MODES).filter((m) => !m.agentTypes || m.agentTypes.includes('workx') || m.agentTypes.includes('workx-server')) as modeSpec (modeSpec.id)}
                  {@const isActive = activeMode === modeSpec.id && !pendingMode}
                  {@const isPending = pendingMode === modeSpec.id}
                  <button
                    type="button"
                    onclick={() => setSessionMode(modeSpec.id)}
                    title={isPending ? $_t("Switching after current task…") : $_t("Switch agent mode")}
                    aria-pressed={isActive}
                    class="text-xs px-2 py-0.5 rounded font-[inherit] cursor-pointer transition-opacity
                      {isActive
                        ? (currentTheme === 'modern'
                            ? 'bg-chat-accent/15 text-chat-accent dark:text-chat-accent-dark font-semibold'
                            : 'bg-[rgba(34,197,94,0.15)] border border-term-dim-green text-term-bright-green')
                        : (currentTheme === 'modern'
                            ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:opacity-100 opacity-70'
                            : 'text-term-dim-green hover:text-term-green opacity-70 hover:opacity-100')}
                      {isPending ? 'animate-pulse' : ''}"
                  >
                    {modeSpec.label}{#if isPending}…{/if}
                  </button>
                {/each}
              </div>
            {/if}
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
              onclick={() => compactionNotification = { ...compactionNotification, show: false }}
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
                <button onclick={requestLogin}
                  class="bg-none border-none p-0 underline cursor-pointer text-left text-[inherit] {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark hover:text-chat-text dark:hover:text-chat-text-dark' : 'text-term-bright-green hover:text-term-yellow'}">
                  {$_t("Log in to your account")}
                </button>
              </li>
              <li class="mb-1">
                <button onclick={() => push('/settings')}
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
              bind:suggestion={nextSuggestion}
              onSubmit={sendMessage}
              onStop={stopAgent}
              onSelectConversation={resumeConversation}
              onNewConversation={startNewConversation}
              tabId={currentTabId}
              {isProcessing}
              placeholder={$_t(">> Enter command...")}
              onTabSelected={handleTabSelected}
              onCommandOutput={handleCommandOutput}
              onOpenRewindSelector={() => showRewindSelector = true}
            />
          </div>

        </div>
      </div>
  </div>

  <!-- Track 15: rewind turn-selector overlay (command-invoked) -->
  <MessageSelector
    show={showRewindSelector}
    onClose={() => showRewindSelector = false}
    onRewound={handleRewound}
  />

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
