<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { UIChannelClient } from '@/core/messaging';
  import type { ChannelEvent } from '@/core/channels/types';
  import type { JobStatusChangedEvent } from '@/core/models/types/SchedulerContracts';
  import type { Event, InputItem } from '@/core/protocol/types';
  import type { HistoryPage } from '@/storage/rollout';
  import type { AgentAccessState } from '@/core/services/runtime-state';
  import type { SessionRuntimeView, SubmitAck, ThreadListItem } from '@/core/registry/types';
  import type { ThreadIndexEntry } from '@/core/thread/ThreadIndexStore';
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
  import BackgroundTasksBadge from '../../components/BackgroundTasksBadge.svelte';
  import {
    threadStore,
    activeThread,
    documentSurfaceId,
    type ThreadConversationState,
  } from '../../stores/threadStore';
  import { ThreadEventRouter } from '../../routing/ThreadEventRouter';
  import { handleBackgroundTaskEvent, startBackgroundTaskPolling, stopBackgroundTaskPolling } from '../../stores/backgroundTaskStore';
  import { projectReplay } from '../../lib/rolloutProjection';
  import {
    consumeAttachMessageDuplicate,
    createAttachMessageDedupeBudget,
    emptyTimeline,
    historyPageToEvents,
    noteDelivery,
    prependHistoryPage,
    reconcileAttachedTimeline,
    timelineEvents,
    upsertTimelineEvent,
    type ConversationTimeline,
    type MessageDedupeBudget,
    type TimelineSource,
  } from '../../lib/conversationTimeline';
  import { LatestViewedSession } from '../../lib/latestViewedSession';
  // UI channel client (platform-agnostic)
  let client: UIChannelClient | null = $state(null);
  let unsubscribers: Array<() => void> = $state([]);
  let eventProcessor: EventProcessor;
  let timeline: ConversationTimeline = $state(emptyTimeline());
  let processedEvents = $derived(timelineEvents(timeline));
  let inputText: string = $state('');
  // Track 24.3: predicted next user message (bound into MessageInput).
  let nextSuggestion: string | null = $state(null);
  // Track 15: rewind turn-selector overlay visibility.
  let showRewindSelector: boolean = $state(false);
  let isConnected: boolean = $state(false);
  let isProcessing: boolean = $state(false);
  let showWelcome = $derived(!isProcessing && processedEvents.length === 0);
  let scrollContainer: HTMLDivElement;
  let currentTabId: number = $state(-1); // Track current session's bound tab
  let currentWorkingDirectory: string | undefined = $state(undefined);
  let workingDirectoryError: string | null = $state(null);
  let workingDirectoryErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let agentReady: boolean = $state(false);
  let healthStatus: {
    ready: boolean;
    message?: string;
    provider?: string;
    model?: string;
    authMode?: 'login' | 'api_key' | 'none';
  } = $state({ ready: false, authMode: 'none' });
  let zoomLevel: number = $state(parseInt(document.documentElement.style.fontSize) || 100);
  let loadingOlderHistory = $state(false);

  // Guards the auto-relogin so an expired desktop session opens the login flow
  // exactly once per expiry (reset when access returns to ready), rather than
  // popping the browser on every subsequent access-state emission.
  let sessionReloginPrompted = false;

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

    // Auto-relogin: when the runtime reports the desktop session expired
    // (refresh token revoked/expired), re-open the login flow instead of
    // leaving the user on a dead "Invalid JWT" error. The `session_expired`
    // reason is the runtime's stable sentinel for "must re-login" (as opposed
    // to a fresh logout or a transient failure, which must not auto-pop login).
    if (access.status === 'needs_login' && access.reason === 'session_expired') {
      if (!sessionReloginPrompted) {
        sessionReloginPrompted = true;
        requestLogin();
      }
    } else if (access.ready) {
      sessionReloginPrompted = false;
    }
  }

  function onZoomChanged(e: Event) {
    zoomLevel = (e as CustomEvent<number>).detail;
  }

  function resetZoom() {
    document.documentElement.style.fontSize = '100%';
    zoomLevel = 100;
    window.dispatchEvent(new CustomEvent('zoom-changed', { detail: 100 }));
    AgentConfig.getInstance()
      .then((config) => {
        const agentConfig = config.getConfig();
        config.updateConfig({ preferences: { ...agentConfig.preferences, zoomLevel: 100 } });
      })
      .catch(() => {});
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
  let compactionNotification: {
    show: boolean;
    tokensSaved: number;
    compactionCount: number;
    isWarning: boolean;
  } = $state({
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

  let activeSessionId: string | null = $state(null);
  const threadRouter = new ThreadEventRouter();
  const surfaceId = documentSurfaceId;
  let surfaceLease: { leaseId: string; sessionId: string } | null = null;
  let surfaceHeartbeat: ReturnType<typeof setInterval> | null = null;
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  const unknownThreadFlights = new Map<string, Promise<void>>();
  const attachFlights = new Map<string, Promise<void>>();
  const attachBuffers = new Map<string, ChannelEvent[]>();
  const attachBufferOverflow = new Set<string>();
  const MAX_ATTACH_BUFFER_EVENTS = 1024;
  const viewedSession = new LatestViewedSession({
    acquireLease: async (sessionId) => {
      const c = await getInitializedUIClient();
      const response = await c.serviceRequest<{
        lease: { leaseId: string; sessionId: string };
      }>('session.setViewed', { surfaceId, sessionId });
      return { leaseId: response.lease.leaseId, sessionId };
    },
    releaseLease: async (lease) => {
      if (!client) return;
      await client.serviceRequest('session.releaseSurface', {
        surfaceId,
        leaseId: lease.leaseId,
      });
    },
    attachSession: (sessionId) => restoreConversationHistory(sessionId),
    onLeaseChange: (lease) => {
      surfaceLease = lease;
      if (lease) startSurfaceHeartbeat();
      else stopSurfaceHeartbeat();
    },
  });

  function appendProcessedEvent(
    event: ProcessedEvent,
    source: TimelineSource = 'live',
  ): void {
    timeline = upsertTimelineEvent(timeline, event, source);
  }

  function createStatusMessage(content: string): ProcessedEvent {
    return {
      id: `local_${crypto.randomUUID()}`,
      category: 'message',
      timestamp: new Date(),
      title: 'workx',
      content,
      style: content.toLowerCase().startsWith('error:')
        ? STYLE_PRESETS.error
        : STYLE_PRESETS.agent_message,
      streaming: false,
      collapsible: false,
    };
  }

  function appendStatusMessage(content: string): void {
    appendProcessedEvent(createStatusMessage(content), 'local');
  }

  function appendStatusMessageForSession(sessionId: string, content: string): void {
    const event = createStatusMessage(content);
    if (sessionId === activeSessionId) {
      appendProcessedEvent(event, 'local');
      return;
    }
    const thread = threadStore.getThread(sessionId);
    if (!thread) return;
    threadStore.patchConversation(sessionId, {
      timeline: upsertTimelineEvent(thread.conversation.timeline, event, 'local'),
    });
  }

  // The left history list is the only navigation control. React to its
  // selection without a second resume-request bridge.
  $effect(() => {
    const selected = $activeThread?.sessionId;
    if (client && selected && selected !== activeSessionId) void switchToThread(selected);
  });

  onMount(async () => {
    // Listen for zoom level changes
    window.addEventListener('zoom-changed', onZoomChanged);

    // Start with one normalized visible timeline for this surface.
    timeline = emptyTimeline();

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
      appendProcessedEvent(confirmEvent, 'local');
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

      threadRouter.onActiveThread(processThreadChannelEvent);
      threadRouter.onBackgroundThread(processThreadChannelEvent);

      threadRouter.onChannel((channelEvent) => {
        const { msg } = channelEvent;
        if (msg.type === 'StateUpdate' && 'data' in msg) {
          const data = msg.data;
          if (
            data?.scope === 'desktop-runtime' &&
            data.kind === 'agent.accessChanged' &&
            data.access
          ) {
            applyAccessState(data.access as AgentAccessState);
          } else if (data && 'tabId' in data) {
            currentTabId = data.tabId!;
          }
        } else if (msg.type === 'session_index_changed' && 'data' in msg) {
          handleIndexChanged(msg.data);
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
      unsubscribers.push(client.onEvent('*', (channelEvent) => threadRouter.route(channelEvent)));
      startBackgroundTaskPolling(() => {
        if (!client || !activeSessionId) return null;
        return {
          async listTaskStates() {
            const response = await client!.serviceRequest<{
              tasks?: import('@/core/tasks/types').TaskState[];
            }>('session.listTaskStates', { sessionId: activeSessionId });
            return response.tasks ?? [];
          },
          async getTaskOutput(taskId: string, fromSeq = 0) {
            const response = await client!.serviceRequest<{
              chunks?: import('@/core/tasks/TaskOutputStore').TaskOutputChunk[];
            }>('session.getTaskOutput', { sessionId: activeSessionId, taskId, fromSeq });
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

    await threadStore.restoreThreads();

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

    // Load only the first index page and attach the selected conversation.
    await syncThreadsWithSessions();

    // Check connection (after sync so activeSessionId is set)
    checkConnection();

    await fetchCurrentTabId();
    document.addEventListener('visibilitychange', handleSurfaceVisibility);

    // ========================================================================
    // KEEP-ALIVE: Send periodic pings to prevent service worker termination
    // ========================================================================
    // Keep-alive ping for Chrome extension (service worker stays awake)
    // Only needed for extension mode - Tauri doesn't have this limitation
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
      appendProcessedEvent(cancelNotice, 'local');

      // Request agent to abort via message service
      if (client && activeSessionId) {
        getInitializedUIClient()
          .then((c) => c.serviceRequest('agent.interrupt', { sessionId: activeSessionId }))
          .catch((err) => {
            console.warn('[App] Failed to send interrupt on cancel:', err);
          });
      }
    }
  }

  onDestroy(() => {
    if (activeSessionId) {
      saveThreadState(activeSessionId);
    }
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (workingDirectoryErrorTimer) clearTimeout(workingDirectoryErrorTimer);
    stopSurfaceHeartbeat();
    void releaseSurface();
    document.removeEventListener('visibilitychange', handleSurfaceVisibility);
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    stopBackgroundTaskPolling();
    window.removeEventListener('zoom-changed', onZoomChanged);
  });

  /** The browser selector is surface-local; it must not hydrate a session. */
  async function fetchCurrentTabId() {
    if (!platform.hasTabSelection) {
      currentTabId = -1;
      return;
    }
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTabId = activeTab?.id ?? -1;
    } catch {
      currentTabId = -1;
    }
  }

  /** Attach one thread from its immutable snapshot plus bounded live replay. */
  function restoreConversationHistory(sessionId: string): Promise<void> {
    const existingFlight = attachFlights.get(sessionId);
    if (existingFlight) return existingFlight;
    const flight = restoreConversationHistoryOnce(sessionId);
    attachFlights.set(sessionId, flight);
    const clearFlight = () => {
      if (attachFlights.get(sessionId) !== flight) return;
      attachFlights.delete(sessionId);
      const thread = threadStore.getThread(sessionId);
      // A terminal runtime event can arrive in the attach buffer. Wait until
      // this single-flight is gone, then fetch the freshly committed snapshot
      // that clears a truncation warning.
      if (thread?.runtime.state === 'idle' && thread.attach.replayTruncated) {
        void restoreConversationHistory(sessionId).catch((error) => {
          console.warn('[App] Committed snapshot refresh failed:', error);
        });
      }
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  async function restoreConversationHistoryOnce(sessionId: string): Promise<void> {
    const c = await getInitializedUIClient();
    const existing = threadStore.getThread(sessionId);
    attachBuffers.set(sessionId, []);
    attachBufferOverflow.delete(sessionId);
    threadStore.setAttach(sessionId, { attaching: true, error: null, historyError: null });
    try {
      const response = await c.serviceRequest<{
        entry: ThreadIndexEntry;
        historyPage: HistoryPage;
        snapshot: { revision: number; items: unknown[] };
        runtime: SessionRuntimeView;
        replay: {
          runtimeEpoch: string;
          baseRolloutRevision: number;
          throughSeq: number;
          truncated: boolean;
          events: Array<{ runtimeEpoch: string; eventSeq: number; event: Event }>;
        } | null;
      }>('session.attach', {
        sessionId,
        after: existing?.attach.cursor ?? undefined,
      });
      const buffered = attachBuffers.get(sessionId) ?? [];
      const bufferTruncated = attachBufferOverflow.has(sessionId);
      threadStore.mergeThread({ ...response.entry, runtime: response.runtime });
      if (
        response.replay
        && response.historyPage.revision < response.replay.baseRolloutRevision
      ) {
        throw new Error('History changed across the attach boundary; retrying is required');
      }
      const processor = existing?.conversation.eventProcessor ?? new EventProcessor(sessionId);
      const replay = projectReplay({
        previousCursor: existing?.attach.cursor,
        replay: response.replay,
        observedEventIds: new Set(existing?.conversation.timeline.observedDeliveryIds ?? []),
      });
      const replayEvents = replay.events
        .map((event) => processor.processEvent(event))
        .filter((event): event is ProcessedEvent => event !== null);
      const pendingIds = new Set(
        existing?.pendingSubmissions
          .filter((item) => item.status !== 'failed')
          .map((item) => item.clientMessageId) ?? [],
      );
      const persistedEvents = historyPageToEvents(response.historyPage);
      let attachedTimeline = reconcileAttachedTimeline(
        existing?.conversation.timeline ?? emptyTimeline(),
        persistedEvents,
        replayEvents,
        pendingIds,
      );
      const attachDedupeBudget = createAttachMessageDedupeBudget(
        persistedEvents,
        replayEvents,
      );
      for (const event of replay.events) attachedTimeline = noteDelivery(attachedTimeline, event.id);
      threadStore.setConversation(sessionId, {
        timeline: attachedTimeline,
        inputText: existing?.conversation.inputText ?? '',
        isProcessing: response.runtime.state === 'running',
        currentTabId: existing?.conversation.currentTabId ?? -1,
        eventProcessor: processor,
      });
      threadStore.setAttach(sessionId, {
        attaching: false,
        cursor: replay.cursor,
        snapshotRevision: response.historyPage.revision,
        historyCursor: response.historyPage.nextCursor,
        replayTruncated: replay.truncated || bufferTruncated,
        error: null,
        historyError: null,
      });
      threadStore.reconcileSubmissions(
        sessionId,
        new Set(response.historyPage.turns.flatMap((turn) => turn.clientMessageId ?? [])),
        new Set(response.historyPage.turns.flatMap((turn) =>
          turn.clientMessageId && turn.status !== 'in_progress' ? [turn.clientMessageId] : [])),
        replay.epochChanged,
      );
      attachBuffers.delete(sessionId);
      attachBufferOverflow.delete(sessionId);
      if (sessionId === activeSessionId) loadThreadState(sessionId);
      const replayEpoch = response.replay?.runtimeEpoch;
      const throughSeq = response.replay?.throughSeq ?? -1;
      for (const event of buffered) {
        if (
          replayEpoch
          && event.runtimeEpoch === replayEpoch
          && event.eventSeq !== undefined
          && event.eventSeq <= throughSeq
        ) continue;
        processThreadChannelEvent(event, attachDedupeBudget);
      }
    } catch (error) {
      const buffered = attachBuffers.get(sessionId) ?? [];
      const bufferTruncated = attachBufferOverflow.has(sessionId);
      attachBuffers.delete(sessionId);
      attachBufferOverflow.delete(sessionId);
      threadStore.setAttach(sessionId, {
        attaching: false,
        replayTruncated: bufferTruncated
          || threadStore.getThread(sessionId)?.attach.replayTruncated
          || false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to attach conversation',
          retryable: true,
        },
      });
      for (const event of buffered) processThreadChannelEvent(event);
      throw error;
    }
  }

  async function loadOlderHistory(): Promise<void> {
    if (!client || !activeSessionId || loadingOlderHistory) return;
    const sessionId = activeSessionId;
    const thread = threadStore.getThread(sessionId);
    const beforeSequence = thread?.attach.historyCursor;
    if (beforeSequence == null) return;
    loadingOlderHistory = true;
    threadStore.setAttach(sessionId, { historyError: null });
    try {
      const page = await client.serviceRequest<HistoryPage>('session.history', {
        sessionId,
        limit: 10,
        beforeSequence,
      });
      const current = threadStore.getThread(sessionId);
      if (!current) return;
      const nextTimeline = prependHistoryPage(
        current.conversation.timeline,
        historyPageToEvents(page),
      );
      threadStore.patchConversation(sessionId, { timeline: nextTimeline });
      threadStore.setAttach(sessionId, {
        historyCursor: page.nextCursor,
        snapshotRevision: Math.max(current.attach.snapshotRevision, page.revision),
      });
      if (sessionId === activeSessionId) timeline = nextTimeline;
    } catch (error) {
      console.error('[App] Failed to load earlier history:', error);
      threadStore.setAttach(sessionId, {
        historyError: {
          message: error instanceof Error ? error.message : 'Failed to load earlier history',
          retryable: true,
        },
      });
    } finally {
      loadingOlderHistory = false;
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
        healthStatus = {
          ready: false,
          message: t('Message service not available'),
          authMode: 'none',
        };
        return;
      }

      const access = await (await getInitializedUIClient()).serviceRequest<AgentAccessState>('agent.getAccessState');
      applyAccessState(access);
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

  function handleEvent(event: Event, attachDedupeBudget?: MessageDedupeBudget) {
    const msg = event.msg;

    // Process event through EventProcessor
    const processed = eventProcessor.processEvent(event);

    if (processed) {
      if (!consumeAttachMessageDuplicate(attachDedupeBudget, processed)) {
        appendProcessedEvent(processed);
      }
      timeline = noteDelivery(timeline, event.id);

      // Auto-scroll to bottom if user is at bottom
      if (scrollContainer) {
        const isAtBottom =
          scrollContainer.scrollHeight - scrollContainer.scrollTop <=
          scrollContainer.clientHeight + 100;

        if (isAtBottom) {
          setTimeout(() => {
            scrollContainer.scrollTo({
              top: scrollContainer.scrollHeight,
              behavior: 'smooth',
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
          appendStatusMessage(`Error: ${msg.data.message}`);
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
    if (!activeSessionId) return;
    const sessionId = activeSessionId;

    // Check if connected
    if (!isConnected) {
      appendStatusMessage(t('Error: Not connected to agent. Please refresh the page.'));
      return;
    }

    // Check if agent is ready (has API key)
    if (!agentReady) {
      const providerName = healthStatus.provider || 'the selected provider';
      appendStatusMessage(t('Cannot send message: No API key configured for $1$. Please click the Settings button and configure your API key.', { substitutions: [providerName] }));
      return;
    }

    inputText = '';

    // Add user message to processedEvents for chronological ordering
    const clientMessageId = crypto.randomUUID();
    const responseLatencyStartedAtMs = Date.now();
    const userEvent: ProcessedEvent = {
      id: `user:${clientMessageId}`,
      category: 'message',
      timestamp: new Date(),
      title: 'user',
      content:
        text || (attachments && attachments.length ? `[${attachments.length} image(s)]` : ''),
      style: { textColor: 'text-cyan-400' },
      streaming: false,
      collapsible: false,
    };
    appendProcessedEvent(userEvent, 'optimistic');
    threadStore.beginSubmission(sessionId, {
      clientMessageId,
      status: 'sending',
      text,
      createdAt: responseLatencyStartedAtMs,
    });
    saveThreadState(sessionId);

    // Send to agent with tab context
    try {
      if (!client) throw new Error('Message service not available');
      const items: InputItem[] = [];
      if (text) items.push({ type: 'text', text });
      if (attachments && attachments.length) items.push(...attachments);
      const ack = await client.serviceRequest<SubmitAck>('session.submit', {
        sessionId,
        clientMessageId,
        items,
        tabId: currentTabId,
        responseLatencyStartedAtMs,
      });
      threadStore.applySubmitAck(sessionId, ack);
      if (ack.status === 'rejected') {
        throw new Error(ack.reason === 'queue-full'
          ? 'The send queue is full. Retry when another conversation finishes.'
          : `Message rejected: ${ack.reason}`);
      }

    } catch (error) {
      console.error('Failed to send message:', error);
      threadStore.settleSubmission(sessionId, clientMessageId, 'failed', undefined,
        error instanceof Error ? error.message : 'submit-failed');

      let errorMessage = t('Failed to send message. Please try again.');
      if (error instanceof Error && error.message.includes('not available')) {
        errorMessage = t('Backend not available. Please wait a moment and try again.');
      }

      appendStatusMessageForSession(sessionId, errorMessage);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
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
    appendProcessedEvent(cmdEvent, 'local');
  }

  async function startNewConversation() {
    try {
      if (!client) throw new Error('Message service not available');
      if (activeSessionId) saveThreadState(activeSessionId);
      await createNewThread();
    } catch (error) {
      console.error('Failed to open conversation:', error);

      let errorMessage = t('Failed to start new conversation. Please try again.');

      appendStatusMessage(errorMessage);
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
      await (
        await getInitializedUIClient()
      ).serviceRequest('agent.interrupt', { sessionId: activeSessionId });
      isProcessing = false;
      console.log('[App] Agent session stopped');
    } catch (error) {
      console.error('[App] Failed to stop agent:', error);

      appendStatusMessage(t('Failed to stop the task. Please try again.'));
    }
  }

  /**
   * Resume a conversation from chat history
   * Loads the selected conversation and restores its state
   */
  async function resumeConversation(sessionId: string) {
    try {
      if (!client) throw new Error('Message service not available');
      if (!threadStore.getThread(sessionId)) {
        const response = await client.serviceRequest<{ entry: ThreadIndexEntry }>('session.get', { sessionId });
        threadStore.mergeThread(response.entry);
      }
      await switchToThread(sessionId);
    } catch (error) {
      console.error('[App] Failed to resume conversation:', error);

      appendStatusMessage(t('Failed to load conversation. Please try again.'));
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

    // Id swap: register a thread for the forked conversation and switch to it
    // (the source conversation remains in history, untouched).
    if (!threadStore.getThread(newId)) {
      threadStore.createThread(newId, 'New Thread');
    }
    threadStore.setConversation(newId, {
      timeline: emptyTimeline(),
      inputText: '',
      isProcessing: false,
      currentTabId: -1,
      eventProcessor: new EventProcessor(newId),
    });
    activeSessionId = newId;
    threadStore.setActiveThread(newId);
    threadRouter.setActiveSession(newId);

    try {
      await setViewedAndAttach(newId);
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
        const lastAgentEvent = processedEvents.filter((e) => e.title === 'workx').pop();
        const resultSummary = lastAgentEvent?.content?.slice(0, 500) || 'Job completed';

        await (
          await getInitializedUIClient()
        ).serviceRequest('scheduler.complete', {
          jobId: scheduledJobId,
          result: {
            summary: resultSummary,
            completedAt: Date.now(),
          },
        });
        console.log('[App] Notified scheduler of job completion:', scheduledJobId);
      } else {
        const errorMessage = msg?.data?.message || 'Job failed';
        await (
          await getInitializedUIClient()
        ).serviceRequest('scheduler.fail', {
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
      const response = await (
        await getInitializedUIClient()
      ).serviceRequest<{ job?: { input: string; scheduledTime?: number } }>(
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
      timeline = upsertTimelineEvent(emptyTimeline(), userEvent, 'optimistic');

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
      appendProcessedEvent(scheduleNotification, 'local');

      // Wait for agent to be ready
      await checkConnection();
      if (!agentReady) {
        throw new Error('Agent is not ready. Please configure your API key.');
      }

      // Scheduled jobs use the same correlated lifecycle path as foreground
      // chat so they cannot bypass admission, dedupe, or recovery markers.
      isProcessing = true;
      const ack = await client!.serviceRequest<SubmitAck>('session.submit', {
        sessionId,
        clientMessageId: crypto.randomUUID(),
        items: [{ type: 'text', text: job.input }],
        tabId: currentTabId,
      });
      if (ack.status === 'rejected') {
        throw new Error(`Scheduled job submission rejected: ${ack.reason}`);
      }

    } catch (error) {
      console.error('[App] Failed to execute scheduled job:', error);

      // Notify scheduler of failure
      try {
        if (client) {
          await (
            await getInitializedUIClient()
          ).serviceRequest('scheduler.fail', {
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
      appendProcessedEvent(errorEvent, 'local');
      isProcessing = false;
    }
  }

  // =========================================================================
  // Multi-thread functions
  // =========================================================================

  /** Load one bounded index page, then attach only the selected conversation. */
  async function syncThreadsWithSessions() {
    try {
      const c = await getInitializedUIClient();
      const listResponse = await c.serviceRequest<{
        entries: ThreadListItem[];
        nextCursor: string | null;
      }>('session.list', { limit: 10 });
      const persistedSelection = get(threadStore).activeSessionId;
      threadStore.mergePage(listResponse?.entries ?? [], listResponse?.nextCursor ?? null, { reset: true });

      let selected = persistedSelection;
      if (selected && !threadStore.getThread(selected)) {
        try {
          const response = await c.serviceRequest<{ entry: ThreadIndexEntry }>('session.get', { sessionId: selected });
          threadStore.mergeThread(response.entry);
        } catch {
          selected = null;
        }
      }
      selected ??= get(threadStore).threads[0]?.sessionId ?? null;
      if (!selected) {
        await createNewThread();
        return;
      }
      await switchToThread(selected);
    } catch (error) {
      console.error('[App] Failed to sync threads with sessions:', error);
    }
  }

  /** Create an index-only chat. No agent graph is assembled here. */
  async function createNewThread() {
    try {
      const c = await getInitializedUIClient();
      const response = await c.serviceRequest<{
        sessionId: string;
        state: 'SUSPENDED' | 'IDLE';
        entry?: ThreadIndexEntry;
      }>('session.open', {});
      const { sessionId } = response;
      if (response.entry) threadStore.mergeThread(response.entry);
      else threadStore.createThread(sessionId);
      const newState: ThreadConversationState = {
        timeline: emptyTimeline(),
        inputText: '',
        isProcessing: false,
        currentTabId: -1,
        eventProcessor: new EventProcessor(sessionId),
      };
      threadStore.setConversation(sessionId, newState);
      await switchToThread(sessionId);
      await fetchCurrentTabId();
    } catch (error) {
      console.error('[App] Failed to create new thread:', error);
      throw error;
    }
  }

  async function switchToThread(sessionId: string) {
    if (sessionId === activeSessionId && surfaceLease?.sessionId === sessionId) return;
    if (activeSessionId) {
      saveThreadState(activeSessionId);
    }
    threadStore.setActiveThread(sessionId);
    activeSessionId = sessionId;
    threadRouter.setActiveSession(sessionId);
    loadThreadState(sessionId);
    await setViewedAndAttach(sessionId);
  }

  function saveThreadState(sessionId: string) {
    const state: ThreadConversationState = {
      timeline,
      inputText,
      isProcessing,
      currentTabId,
      eventProcessor: eventProcessor,
    };
    threadStore.setConversation(sessionId, state);
  }

  function loadThreadState(sessionId: string) {
    const thread = threadStore.getThread(sessionId);
    const state = thread?.conversation;
    currentWorkingDirectory = thread?.workspace?.workingDirectory;
    if (state) {
      timeline = state.timeline;
      inputText = state.inputText;
      isProcessing = state.isProcessing;
      currentTabId = state.currentTabId;
      eventProcessor = state.eventProcessor ?? new EventProcessor(sessionId);
    } else {
      // Initialize fresh state
      timeline = emptyTimeline();
      inputText = '';
      isProcessing = false;
      currentTabId = -1;
      eventProcessor = new EventProcessor(sessionId);
    }

    // Reset scroll position after loading new thread state
    if (scrollContainer) {
      setTimeout(() => {
        if (processedEvents.length === 0) {
          scrollContainer.scrollTop = 0;
        } else {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }, 0);
    }
  }

  async function chooseWorkingDirectory(): Promise<void> {
    if (platform.platformName !== 'desktop' || !activeSessionId || isProcessing) return;
    const targetSessionId = activeSessionId;
    workingDirectoryError = null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: currentWorkingDirectory,
      });
      if (typeof selected !== 'string' || !selected) return;

      const c = await getInitializedUIClient();
      const response = await c.serviceRequest<{
        success: boolean;
        workingDirectory?: string;
        entry?: ThreadIndexEntry;
      }>('session.setWorkingDirectory', {
        sessionId: targetSessionId,
        workingDirectory: selected,
      });
      if (response.entry) threadStore.mergeThread(response.entry);
      if (response.workingDirectory && activeSessionId === targetSessionId) {
        currentWorkingDirectory = response.workingDirectory;
      }
    } catch (error) {
      console.error('[App] Failed to change working folder:', error);
      const detail = error instanceof Error ? error.message : String(error);
      workingDirectoryError = `${t('Failed to change working folder')}: ${detail}`;
      if (workingDirectoryErrorTimer) clearTimeout(workingDirectoryErrorTimer);
      workingDirectoryErrorTimer = setTimeout(() => {
        workingDirectoryError = null;
        workingDirectoryErrorTimer = null;
      }, 5000);
    }
  }

  /** Soft-delete a thread and retain its durable history for Undo. */
  async function closeThread(sessionId: string) {
    const c = await getInitializedUIClient();
    const result = await c.serviceRequest<{ status: 'deleted' | 'requires-confirmation' }>(
      'session.delete', { sessionId },
    );
    if (result.status === 'requires-confirmation') {
      throw new Error('This conversation is running. Stop it before deleting.');
    }
    threadStore.closeThread(sessionId);
    const next = threadStore.getActiveThread();
    if (next) await switchToThread(next.sessionId);
    else await createNewThread();
  }

  function handleEventForSession(
    event: Event,
    sessionId: string,
    attachDedupeBudget?: MessageDedupeBudget,
  ) {
    const thread = threadStore.getThread(sessionId);
    if (!thread) return;

    const state = thread.conversation;
    const processor = state.eventProcessor ?? new EventProcessor(sessionId);

    const processed = processor.processEvent(event);
    if (processed) {
      if (!consumeAttachMessageDuplicate(attachDedupeBudget, processed)) {
        state.timeline = upsertTimelineEvent(state.timeline, processed, 'live');
      }
      state.timeline = noteDelivery(state.timeline, event.id);
    }

    // Update processing state
    const msg = event.msg;
    if (msg.type === 'TaskStarted') {
      state.isProcessing = true;
    } else if (msg.type === 'TaskComplete' || msg.type === 'TaskFailed') {
      state.isProcessing = false;
    }

    threadStore.setConversation(sessionId, { ...state, eventProcessor: processor });
  }

  function handleSessionTerminated(sessionId: string) {
    const thread = threadStore.getThread(sessionId);
    if (thread) threadStore.setRuntime(sessionId, { ...thread.runtime, state: 'suspended' });
  }

  async function setViewedAndAttach(sessionId: string): Promise<void> {
    await viewedSession.select(sessionId);
  }

  async function retryHydration(): Promise<void> {
    if (!activeSessionId) return;
    const c = await getInitializedUIClient();
    try {
      await c.serviceRequest('session.hydrate', { sessionId: activeSessionId });
      await setViewedAndAttach(activeSessionId);
    } catch (error) {
      console.error('[App] Hydration retry failed:', error);
    }
  }

  function resendUnknown(clientMessageId: string, text: string): void {
    if (!activeSessionId) return;
    threadStore.dismissSubmission(activeSessionId, clientMessageId);
    void sendMessage(text);
  }

  function startSurfaceHeartbeat(): void {
    stopSurfaceHeartbeat();
    if (document.visibilityState !== 'visible') return;
    surfaceHeartbeat = setInterval(() => {
      if (!surfaceLease || !client) return;
      void client.serviceRequest('session.heartbeat', {
        surfaceId,
        leaseId: surfaceLease.leaseId,
      }).catch(() => stopSurfaceHeartbeat());
    }, 20_000);
  }

  function stopSurfaceHeartbeat(): void {
    if (surfaceHeartbeat) clearInterval(surfaceHeartbeat);
    surfaceHeartbeat = null;
  }

  async function releaseSurface(): Promise<void> {
    await viewedSession.clear();
  }

  function handleSurfaceVisibility(): void {
    if (document.visibilityState === 'visible' && activeSessionId) {
      void setViewedAndAttach(activeSessionId);
    } else {
      void releaseSurface();
    }
  }

  /**
   * Preserve every thread event that arrives across the attach request's
   * snapshot/replay boundary. Once attach commits, replay-covered events are
   * discarded by cursor and the remaining live tail is applied in arrival
   * order. This is deliberately the one path used for active and background
   * conversations.
   */
  function processThreadChannelEvent(
    channelEvent: ChannelEvent,
    attachDedupeBudget?: MessageDedupeBudget,
  ): void {
    const sessionId = channelEvent.sessionId;
    if (!sessionId) return;
    const buffer = attachBuffers.get(sessionId);
    if (buffer) {
      if (buffer.length >= MAX_ATTACH_BUFFER_EVENTS) {
        buffer.shift();
        attachBufferOverflow.add(sessionId);
      }
      buffer.push(channelEvent);
      return;
    }
    if (handleThreadLifecycleEvent(channelEvent)) return;
    if (channelEvent.msg.type.startsWith('BackgroundTask')) {
      handleBackgroundTaskEvent(channelEvent.msg);
      return;
    }
    const event: Event = {
      id: `evt_${channelEvent.runtimeEpoch ?? 'live'}_${channelEvent.eventSeq ?? Date.now()}`,
      msg: channelEvent.msg,
      runtimeEpoch: channelEvent.runtimeEpoch,
      eventSeq: channelEvent.eventSeq,
    };
    if (sessionId === activeSessionId) handleEvent(event, attachDedupeBudget);
    else handleEventForSession(event, sessionId, attachDedupeBudget);
    updateAttachCursor(channelEvent);
  }

  function updateAttachCursor(event: ChannelEvent): void {
    if (!event.sessionId || !event.runtimeEpoch || event.eventSeq === undefined) return;
    threadStore.setAttach(event.sessionId, {
      cursor: { runtimeEpoch: event.runtimeEpoch, eventSeq: event.eventSeq },
    });
  }

  function handleThreadLifecycleEvent(event: ChannelEvent): boolean {
    const sessionId = event.sessionId;
    if (!sessionId) return false;
    if (event.msg.type === 'session_runtime_state') {
      const data = event.msg.data;
      const current = threadStore.getThread(sessionId);
      const runtime: SessionRuntimeView = {
        state: data.state,
        awaitingInputCount: data.awaitingInputCount,
        awaitingInputKinds: data.awaitingInputKinds,
        durability: data.durability,
        durabilityReason: data.durabilityReason,
        lastFailure: data.lastFailure,
      };
      if (current) {
        threadStore.setRuntime(sessionId, runtime);
      } else {
        void loadUnknownThread(sessionId, runtime);
      }
      if (sessionId === activeSessionId) isProcessing = data.state === 'running';
      if (data.state === 'idle' && threadStore.getThread(sessionId)?.attach.replayTruncated) {
        void restoreConversationHistory(sessionId);
      }
      updateAttachCursor(event);
      return true;
    }
    if (event.msg.type === 'session_submission_state') {
      const data = event.msg.data;
      threadStore.settleSubmission(sessionId, data.clientMessageId, data.state,
        data.submissionId, data.reason);
      updateAttachCursor(event);
      return true;
    }
    if (event.msg.type === 'browser_attention_required') {
      if (threadStore.getThread(sessionId)) {
        threadStore.setAttention(sessionId, event.msg.data);
      } else {
        void loadUnknownThread(sessionId).then(() => threadStore.setAttention(sessionId, event.msg.data));
      }
      updateAttachCursor(event);
      return true;
    }
    return false;
  }

  function loadUnknownThread(sessionId: string, runtime?: SessionRuntimeView): Promise<void> {
    const existing = unknownThreadFlights.get(sessionId);
    if (existing) return existing;
    const flight = (async () => {
      if (!client) return;
      try {
        const response = await client.serviceRequest<{ entry: ThreadIndexEntry }>(
          'session.get', { sessionId },
        );
        threadStore.mergeThread({ ...response.entry, ...(runtime ? { runtime } : {}) });
      } catch {
        threadStore.closeThread(sessionId);
      }
    })();
    unknownThreadFlights.set(sessionId, flight);
    void flight.finally(() => {
      if (unknownThreadFlights.get(sessionId) === flight) unknownThreadFlights.delete(sessionId);
    });
    return flight;
  }

  function handleIndexChanged(data: Extract<import('@/core/protocol/events').EventMsg,
    { type: 'session_index_changed' }>['data']): void {
    if (data.change === 'soft-deleted' || data.change === 'purged') {
      threadStore.closeThread(data.sessionId);
      return;
    }
    if (data.entry) {
      const known = threadStore.getThread(data.sessionId);
      if (known || data.entry.pinned || data.sessionId === activeSessionId) {
        threadStore.mergeThread(data.entry);
        if (data.sessionId === activeSessionId) {
          currentWorkingDirectory = data.entry.workspace?.workingDirectory;
        }
      } else {
        threadStore.markPageDirty();
      }
      return;
    }
    if (!threadStore.getThread(data.sessionId)) void loadUnknownThread(data.sessionId);
  }
</script>

<!-- Single UI with theme-aware styling -->
<div
  class="flex flex-col overflow-hidden p-4 {currentTheme}
    {currentTheme === 'modern'
    ? 'font-chat bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
    : 'font-terminal bg-term-bg text-term-green'}"
  role="log"
  aria-label="Terminal output"
>
    <div class="flex flex-col flex-1 min-h-0 max-w-[1500px] mx-auto w-full">
        <!-- Status Line -->
        <div class="shrink-0 flex justify-between mb-2">
          <div class="flex items-center space-x-2">
            <TerminalMessage type="system" content={platform.platformName === 'extension' ? $_t("WorkX (Alpha)") : $_t("WorkX: Your personal AI (Alpha)")} />
            {#if zoomLevel !== 100}
              <button onclick={resetZoom} class="text-sm leading-ui font-[inherit] opacity-70 hover:opacity-100 cursor-pointer {currentTheme === 'modern' ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}" title="Reset zoom to 100%">
                [{zoomLevel}%] ✕
              </button>
            {/if}
          </div>
          <div class="flex items-center space-x-2">
            <BackgroundTasksBadge />
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

        {#if $activeThread?.runtime.lastFailure?.kind === 'hydration'}
          <div class="mb-2 rounded px-3 py-2 text-sm flex items-center justify-between gap-3 bg-red-500/10 text-red-600 dark:text-red-300" role="alert">
            <span>{$_t("This conversation could not be started. Its saved history is unchanged.")}</span>
            <button class="shrink-0 underline border-none bg-transparent text-inherit cursor-pointer" onclick={() => void retryHydration()}>
              {$_t("Retry")}
            </button>
          </div>
        {/if}

        {#if $activeThread?.attach.error}
          <div class="mb-2 rounded px-3 py-2 text-sm flex items-center justify-between gap-3 bg-red-500/10 text-red-600 dark:text-red-300" role="alert">
            <span>{$activeThread.attach.error.message}</span>
            {#if $activeThread.attach.error.retryable}
              <button class="shrink-0 underline border-none bg-transparent text-inherit cursor-pointer" onclick={() => activeSessionId && void setViewedAndAttach(activeSessionId)}>
                {$_t("Retry")}
              </button>
            {/if}
          </div>
        {/if}

        {#if $activeThread?.attach.replayTruncated}
          <div class="mb-2 rounded px-3 py-2 text-sm flex items-center justify-between gap-3 bg-amber-500/10 text-amber-700 dark:text-amber-300" role="status">
            <span>{$_t("Some live updates were too old to replay. Reload from the saved conversation snapshot.")}</span>
            <button class="shrink-0 underline border-none bg-transparent text-inherit cursor-pointer" onclick={() => activeSessionId && void restoreConversationHistory(activeSessionId)}>
              {$_t("Reload")}
            </button>
          </div>
        {/if}

        {#if $activeThread?.runtime.durability === 'degraded'}
          <div class="mb-2 rounded px-3 py-2 text-sm bg-amber-500/10 text-amber-700 dark:text-amber-300" role="status">
            {$_t("The task result is available, but its final recovery marker could not be saved. Check storage before restarting.")}
          </div>
        {/if}

        {#each $activeThread?.pendingSubmissions ?? [] as pending (pending.clientMessageId)}
          {#if pending.status === 'queued'}
            <div class="mb-2 rounded px-3 py-2 text-sm bg-blue-500/10 text-blue-700 dark:text-blue-300" role="status">
              {pending.phase === 'capacity'
                ? $_t("Waiting for another conversation to release runtime capacity…")
                : $_t("Message queued while this conversation starts…")}
              {#if pending.position} <span class="opacity-70">#{pending.position}</span>{/if}
            </div>
          {:else if pending.status === 'delivery-unknown'}
            <div class="mb-2 rounded px-3 py-2 text-sm flex items-center justify-between gap-3 bg-amber-500/10 text-amber-700 dark:text-amber-300" role="alert">
              <span>{$_t("Delivery is uncertain after reconnecting. Resending may run the request twice.")}</span>
              {#if pending.text}
                <button class="shrink-0 underline border-none bg-transparent text-inherit cursor-pointer" onclick={() => resendUnknown(pending.clientMessageId, pending.text)}>
                  {$_t("Resend anyway")}
                </button>
              {/if}
            </div>
          {:else if pending.status === 'failed'}
            <div class="mb-2 rounded px-3 py-2 text-sm flex items-center justify-between gap-3 bg-red-500/10 text-red-600 dark:text-red-300" role="alert">
              <span>{pending.reason ?? $_t("Message failed before it was accepted.")}</span>
              {#if pending.text}
                <button class="shrink-0 underline border-none bg-transparent text-inherit cursor-pointer" onclick={() => resendUnknown(pending.clientMessageId, pending.text)}>
                  {$_t("Retry")}
                </button>
              {/if}
            </div>
          {/if}
        {/each}

        <!-- Messages - scrollable area -->
        <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-4" bind:this={scrollContainer}>
          {#if $activeThread?.attach.historyError}
            <div class="mx-3 mt-2 rounded px-3 py-2 text-sm flex items-center justify-between gap-3 bg-red-500/10 text-red-600 dark:text-red-300" role="alert">
              <span>{$activeThread.attach.historyError.message}</span>
              {#if $activeThread.attach.historyError.retryable}
                <button class="shrink-0 underline border-none bg-transparent text-inherit cursor-pointer" onclick={loadOlderHistory}>
                  {$_t("Retry")}
                </button>
              {/if}
            </div>
          {/if}
          {#if activeSessionId && $activeThread?.attach.historyCursor != null}
            <div class="flex justify-center py-2">
              <button
                type="button"
                class="text-xs opacity-70 hover:opacity-100 underline"
                disabled={loadingOlderHistory}
                onclick={loadOlderHistory}
              >
                {loadingOlderHistory ? $_t('Loading history...') : $_t('Load earlier messages')}
              </button>
            </div>
          {/if}
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
              <p class="m-0 text-base text-term-blue">
                {platform.platformName === 'extension' ? $_t("General in-browser AI agent for work tasks") : $_t("Your personal AI assistant")}
              </p>
              <p class="m-0 text-base text-term-dim-green">
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

          {#each processedEvents as event (event.id)}
            <EventDisplay {event} />
          {/each}
        </div>

        <!-- Fixed bottom controls container -->
        <div class="shrink-0 border-t {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
          <!-- Input area -->
          <div class="pr-2 py-2 pl-0">
            {#if workingDirectoryError}
              <div
                class="mb-2 ml-2 rounded-lg border px-3 py-2 text-sm
                  {currentTheme === 'modern'
                    ? 'border-chat-status-error/30 bg-chat-status-error/10 text-chat-status-error dark:border-chat-status-error-dark/30 dark:bg-chat-status-error-dark/10 dark:text-chat-status-error-dark'
                    : 'border-term-red bg-[rgba(40,0,0,0.95)] text-term-red'}"
                role="alert"
              >{workingDirectoryError}</div>
            {/if}
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
              workingDirectory={currentWorkingDirectory}
              onChooseWorkingDirectory={platform.platformName === 'desktop'
                ? chooseWorkingDirectory
                : undefined}
            />
          </div>

        </div>
      </div>
    </div>

  <!-- Track 15: rewind turn-selector overlay (command-invoked) -->
  <MessageSelector
    show={showRewindSelector}
    sessionId={activeSessionId ?? ''}
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
