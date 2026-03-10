/**
 * Chrome extension background service worker
 * Central coordinator for the Browserx agent
 *
 * Feature 015: Multi-agent instances
 * - Replaced singleton agent with AgentRegistry
 * - Supports parallel session execution
 * - Session-aware message routing
 */

import { RepublicAgent } from '../../core/RepublicAgent';
import { UserNotifier } from '../../core/UserNotifier';
import type { Submission } from '../../core/protocol/types';
import { ApprovalGate } from '../../core/approval/ApprovalGate';
import { PolicyRulesEngine } from '../../core/approval/PolicyRulesEngine';
import { getDefaultRules } from '../../core/approval/defaultRules';
import { DomainSensitivityEnhancer } from '../../core/approval/enhancers/DomainSensitivityEnhancer';
import { SemanticElementEnhancer } from '../../core/approval/enhancers/SemanticElementEnhancer';
import { ApprovalConfigStorage } from '../../core/approval/ApprovalConfigStorage';
import { getConfigStorage } from '../../core/storage/ConfigStorageProvider';
import { AuthManager } from '../../core/models/types/Auth';
import { CacheManager } from '../../storage/CacheManager';
import { StorageQuotaManager } from '../../storage/StorageQuotaManager';
import { RolloutRecorder } from '../../storage/rollout';
import { AgentConfig } from '../../config/AgentConfig';
import { STORAGE_KEYS } from '../../config/defaults';
import { DEFAULT_APPROVAL_CONFIG } from '../../core/approval/types';
import { TabManager } from '../../core/TabManager';
import { LLM_API_URL } from '../../config/constants';
import { MCPManager } from '../../core/mcp/MCPManager';
import { registerMCPTools, unregisterMCPTools } from '../../core/mcp/MCPToolAdapter';
import type { MCPManagerEvent } from '../../core/mcp/types';
import { A2AManager } from '../../core/a2a/A2AManager';
import { registerA2ASkills, unregisterA2ASkills } from '../../core/a2a/A2AToolAdapter';
import type { A2AManagerEvent } from '../../core/a2a/types';

// Skills imports
import { SkillRegistry } from '../../core/skills';
import { IndexedDBSkillProvider } from '../../extension/storage/IndexedDBSkillProvider';
import { IndexedDBStorageProvider } from '../../extension/storage/IndexedDBStorageProvider';
import { registerPromptExtension } from '../../core/PromptLoader';

// Scheduler imports
import { Scheduler, ScheduleManager, JobExecutor, ScheduleEventStorage, ExecutionStorage } from '../../core/scheduler';
import { SchedulerAlarms } from './scheduler-alarms';
import { createStorageAdapter } from '../../storage/createStorageAdapter';
import { parseAlarmName } from '../../core/models/types/SchedulerContracts';

// Storage initialization — static imports required because dynamic import()
// is banned in Chrome extension service workers by the HTML specification.
import { setConfigStorage } from '../../core/storage/ConfigStorageProvider';
import { setCredentialStore } from '../../core/storage/CredentialStore';
import { setStorageProvider, isStorageProviderInitialized } from '../../core/storage';
import { ChromeConfigStorage } from '../../extension/storage/ChromeConfigStorage';
import { ChromeCredentialStore } from '../../extension/storage/ChromeCredentialStore';
import * as VaultManager from '../../core/crypto/VaultManager';
// Multi-agent registry imports (Feature 015)
import { AgentRegistry, SessionStorage } from '../../core/registry';
import type { SessionConfig } from '../../core/registry/types';
import { PRIMARY_SESSION_ALIAS } from '../../core/models/types/SessionContracts';
import { t } from '../../webfront/lib/i18n';

// Global instances
/**
 * @deprecated Feature 015: Use registry.getPrimarySession().agent instead.
 * This variable is kept only for backward compatibility during migration.
 * All new code should use AgentRegistry to access agent instances.
 */
let agent: RepublicAgent | null = null;
let registry: AgentRegistry | null = null; // Feature 015: Multi-agent registry
let cacheManager: CacheManager | null = null;
let storageQuotaManager: StorageQuotaManager | null = null;
let agentConfig: AgentConfig | null = null;
let mcpManager: MCPManager | null = null; // MCP server connection manager
let a2aManager: A2AManager | null = null; // A2A agent connection manager
let currentAuthManager: AuthManager | null = null; // Preserve auth state across agent recreation
let scheduler: Scheduler | null = null; // Job scheduler
let schedulerAlarms: SchedulerAlarms | null = null;
let sessionStorage: SessionStorage | null = null; // Feature 015: Session persistence
let skillRegistry: SkillRegistry | null = null; // Agent skills
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;

/**
 * Configure platform-specific approval gate and tab closure handler for extension mode.
 * Called after agent.initialize() to set up approval policies, enhancers, and config storage.
 */
async function configureExtensionPlatform(targetAgent: RepublicAgent): Promise<void> {
  const approvalManager = targetAgent.getApprovalManager();
  const toolRegistry = targetAgent.getToolRegistry();

  // Approval gate with extension-specific enhancers
  const policyEngine = new PolicyRulesEngine(getDefaultRules('extension'));
  const approvalGate = new ApprovalGate(approvalManager, policyEngine);
  approvalGate.addEnhancer(new DomainSensitivityEnhancer());
  approvalGate.addEnhancer(new SemanticElementEnhancer());

  // Extension mode uses ConfigStorageProvider for approval config
  const configStorage = new ApprovalConfigStorage(() => getConfigStorage());
  approvalGate.setConfigStorage(configStorage);

  try {
    const storedConfig = await configStorage.loadConfig();
    approvalGate.setMode(storedConfig.mode);
    approvalGate.setTrustedDomains(storedConfig.trustedDomains || []);
    approvalGate.setBlockedDomains(storedConfig.blockedDomains || []);
  } catch (error) {
    console.warn('[ServiceWorker] Failed to load approval config, using defaults:', error);
  }

  toolRegistry.setApprovalGate(approvalGate);

  // Tab closure handler
  const tabManager = TabManager.getInstance();
  const session = targetAgent.getSession();
  const notifier = targetAgent.getUserNotifier();

  tabManager.onTabClosure(async (closedTabId: number) => {
    if (session.getTabId() === closedTabId) {
      session.setTabId(-1);
      await session.abortAllTasks('TabClosed');
      await notifier.notifyWarning(
        'Tab Closed',
        'The tab was closed or crashed. All tasks have been stopped.'
      );
    }
  });
}

/**
 * Initialize the service worker
 */
async function initialize(): Promise<void> {
  // If already initialized, return immediately
  if (isInitialized) {
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization
  initializationPromise = doInitialize();

  try {
    await initializationPromise;
    isInitialized = true;
  } finally {
    initializationPromise = null;
  }
}

/**
 * Actual initialization logic
 */
async function doInitialize(): Promise<void> {
  // Initialize TabManager at service worker level (before agent)
  const tabManager = TabManager.getInstance();
  await tabManager.initialize();

  // Initialize configuration singleton first
  agentConfig = await AgentConfig.getInstance();

  // Initialize ONLY StorageProvider early — PlanningTool requires it via getTaskStore()
  // during tool registration in registry.createSession().
  // The rest of storage init (ConfigStorage, CredentialStore, CacheManager, etc.)
  // stays at the end of doInitialize() to preserve the original initialization order.
  try {
    const storageProvider = new IndexedDBStorageProvider();
    await storageProvider.initialize();
    setStorageProvider(storageProvider);
    console.log('[ServiceWorker] StorageProvider initialized (early — for PlanningTool)');
  } catch (error) {
    console.error('[ServiceWorker] Failed to initialize StorageProvider:', error);
    console.error('[ServiceWorker] PlanningTool will be unavailable this session');
  }

  // Feature 015: Initialize AgentRegistry instead of singleton agent
  // Load max concurrent sessions from user preferences
  const config = agentConfig!.getConfig();
  const maxConcurrentSessions = config.preferences?.maxConcurrentSessions ?? 3;
  registry = AgentRegistry.getInstance({ maxConcurrent: maxConcurrentSessions });
  registry.initialize(agentConfig!);

  // Feature 015 (T039): Initialize session persistence
  await initializeSessionPersistence();

  // Create primary session (replaces singleton agent creation)
  // This maintains backward compatibility - agent variable points to primary session's agent
  const primarySession = await registry.createSession({ type: 'primary' });
  agent = primarySession.agent;

  console.log(`[ServiceWorker] Primary session created: ${primarySession.sessionId}`);

  // Initialize auth manager from stored config preferences
  // This ensures backend routing is set up correctly on service worker startup
  await initializeAuthFromConfig();

  // Initialize MCP manager
  mcpManager = await MCPManager.getInstance();

  // Subscribe to MCP events for tool registration/unregistration
  setupMCPToolRegistration();

  // Auto-connect enabled MCP servers (T064: service worker lifecycle handling)
  await autoConnectEnabledMCPServers();

  // Setup message handlers
  setupMessageHandlers();

  // Initialize A2A manager
  a2aManager = await A2AManager.getInstance();

  // Subscribe to A2A events for tool registration/unregistration
  setupA2AToolRegistration();

  // Auto-connect enabled A2A agents
  await autoConnectEnabledA2AAgents();

  // Initialize Skills
  await initializeSkills();

  // Initialize Scheduler
  await initializeScheduler();

  // Register service handlers on ChannelManager (message_routing_v2)
  await registerServiceHandlers();

  // Setup Chrome event listeners
  setupChromeListeners();

  // Setup periodic tasks
  setupPeriodicTasks();

  // Initialize storage layer (ConfigStorage, CredentialStore, CacheManager, etc.)
  // StorageProvider is already initialized above (early init for PlanningTool).
  await initializeStorage();
}

/**
 * Initialize AuthManager from stored config preferences
 * This ensures useOwnApiKey setting is respected on service worker startup
 */
async function initializeAuthFromConfig(): Promise<void> {
  if (!agentConfig || !agent) return;

  try {
    const config = agentConfig.getConfig();

    // Default useOwnApiKey=false (backend mode) if not explicitly set
    const useOwnApiKey = config.preferences?.useOwnApiKey ?? true;

    // useOwnApiKey=false means use backend routing
    const shouldUseBackend = useOwnApiKey === false;
    const backendBaseUrl = shouldUseBackend ? LLM_API_URL : null;

    console.log('[ServiceWorker] Initializing auth from config:', {
      useOwnApiKey,
      shouldUseBackend,
      backendBaseUrl
    });

    const authManager = new AuthManager(shouldUseBackend, backendBaseUrl);
    currentAuthManager = authManager;

    const factory = agent.getModelClientFactory();
    factory.setAuthManager(authManager);

    console.log('[ServiceWorker] Auth initialized, isBackendRouting:', factory.isBackendRouting());

    // Check for ChatGPT OAuth tokens and configure token getter
    try {
      const { ChatGPTOAuthExtensionStorage } = await import('../auth/ChatGPTOAuthExtensionStorage');
      const { ChatGPTOAuthService } = await import('@/core/auth/ChatGPTOAuthService');

      const oauthStorage = new ChatGPTOAuthExtensionStorage();
      const oauthService = new ChatGPTOAuthService(oauthStorage);

      if (await oauthService.isAuthenticated()) {
        authManager.setChatGPTOAuth(() => oauthService.getValidAccessToken());
        factory.setAuthManager(authManager);
        console.log('[ServiceWorker] ChatGPT OAuth restored from storage');
      }
    } catch (oauthError) {
      console.warn('[ServiceWorker] ChatGPT OAuth check failed:', oauthError);
    }
  } catch (error) {
    console.error('[ServiceWorker] Failed to initialize auth from config:', error);
    // Continue without backend routing - will use direct API key mode
  }
}

/**
 * Feature 015 (T039): Initialize session persistence
 * Sets up IndexedDB storage for session persistence and loads any persisted sessions
 */
async function initializeSessionPersistence(): Promise<void> {
  if (!registry) {
    console.warn('[ServiceWorker] Cannot initialize session persistence - registry not ready');
    return;
  }

  try {
    // Initialize storage adapter (IndexedDB on extension, SQLite on desktop/server)
    const storageAdapter = await createStorageAdapter();
    await storageAdapter.initialize();

    // Create session storage
    sessionStorage = new SessionStorage(storageAdapter);

    // Wire storage to registry
    registry.setStorage(sessionStorage);

    // Clean up orphaned sessions (older than 24 hours)
    await registry.cleanupOrphanedSessions(24 * 60 * 60 * 1000);

    // Load and resume persisted scheduled task sessions
    // Note: We only resume 'scheduled' type sessions, not 'primary' (which gets recreated)
    const persistedSessions = await registry.loadPersistedSessions();
    const scheduledSessions = persistedSessions.filter(s => s.type === 'scheduled');

    if (scheduledSessions.length > 0) {
      console.log(`[ServiceWorker] Found ${scheduledSessions.length} persisted scheduled sessions to resume`);

      for (const persisted of scheduledSessions) {
        // Only resume if the session was active (not terminated)
        if (persisted.state !== 'terminated') {
          const resumed = await registry.resumeSession(persisted);
          if (resumed) {
            console.log(`[ServiceWorker] Resumed session: ${persisted.sessionId}`);
          }
        }
      }
    }

    console.log('[ServiceWorker] Session persistence initialized');
  } catch (error) {
    console.error('[ServiceWorker] Failed to initialize session persistence:', error);
    // Continue without persistence - sessions will work but won't survive restarts
  }
}

/**
 * Helper function to get agent for a message (Feature 015: session-aware routing)
 * @param message The incoming message with optional sessionId
 * @returns The agent to use for this message
 */
function getAgentForMessage(message: { payload?: { sessionId?: string; context?: { sessionId?: string } } }): RepublicAgent | null {
  // Feature 015: Route by sessionId if provided, otherwise use primary session
  // Check both payload.sessionId (direct) and payload.context.sessionId (from Submission)
  const sessionId = message.payload?.sessionId ?? message.payload?.context?.sessionId;

  if (sessionId && registry) {
    const agentSession = registry.getSession(sessionId);
    if (agentSession?.agent) {
      return agentSession.agent;
    }
    // If specific session not found, fall back to primary
    console.warn(`[ServiceWorker] Session ${sessionId} not found, using primary`);
  }

  // Default to primary session (backward compatibility)
  if (registry) {
    const primarySession = registry.getPrimarySession();
    return primarySession?.agent ?? null;
  }

  // Legacy fallback to global agent variable
  return agent;
}

/**
 * Setup message handlers
 */
/**
 * Register service handlers on ChannelManager (message_routing_v2).
 * Uses the SidePanelChannel + ChannelManager path for ServiceRequest Ops.
 */
async function registerServiceHandlers(): Promise<void> {
  try {
    const { getChannelManager } = await import('@/core/channels/ChannelManager');
    const { registerAllServices } = await import('@/core/services');
    const { SidePanelChannel } = await import('@/extension/channels/SidePanelChannel');

    const channelManager = getChannelManager();

    // Register SidePanelChannel if not already registered
    if (!channelManager.getChannel('sidepanel-main')) {
      const sidePanelChannel = new SidePanelChannel();

      // Set the agent handler to route non-ServiceRequest Ops to the agent
      channelManager.setAgentHandler(async (op, context) => {
        const targetAgent = agent ?? registry?.getPrimarySession()?.agent;
        if (!targetAgent) throw new Error('No agent available');
        await targetAgent.submitOperation(op, { tabId: context.tabId });
      });

      await channelManager.registerChannel(sidePanelChannel);

      // Wire event forwarding from agent to channel
      const primaryAgent = registry?.getPrimarySession()?.agent ?? agent;
      if (primaryAgent) {
        primaryAgent.setEventDispatcher((event) => {
          channelManager.dispatchEvent({ msg: event.msg }, 'sidepanel-main').catch(() => {});
        });
      }
    }

    const serviceRegistry = channelManager.getServiceRegistry();

    // Wrap chrome.storage for the storage service
    const chromeStorageAdapter = {
      get: async (key: string) => {
        const result = await chrome.storage.local.get(key);
        return result[key];
      },
      set: async (key: string, value: unknown) => {
        await chrome.storage.local.set({ [key]: value });
      },
    };

    // Wire scheduler events to ChannelManager (unified dispatch)
    if (scheduler) {
      scheduler.connectToChannel(() => channelManager, 'sidepanel-main');
    }

    const count = registerAllServices(serviceRegistry, {
      mcp: mcpManager ? { mcpManager } : undefined,
      scheduler: scheduler ? { scheduler } : undefined,
      skills: skillRegistry ? { skillRegistry } : undefined,
      vault: {
        vaultManager: (await import('@/core/crypto/VaultManager')) as any,
      },
      a2a: a2aManager ? { a2aManager } : undefined,
      session: {
        getAgent: () => {
          const targetAgent = registry?.getPrimarySession()?.agent ?? agent;
          return targetAgent;
        },
        registry: registry ?? undefined,
        resetTabs: async () => {
          const tabManager = TabManager.getInstance();
          await tabManager.reset();
        },
      },
      agent: {
        getAgent: () => registry?.getPrimarySession()?.agent ?? agent,
        updateApprovalConfig: async (config: Record<string, unknown>) => {
          const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
          const storedConfig = (result[STORAGE_KEYS.CONFIG] || {}) as Record<string, any>;
          const existing = storedConfig.approval || { ...DEFAULT_APPROVAL_CONFIG };
          storedConfig.approval = { ...existing, ...config };
          await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: storedConfig });
        },
      },
      storage: { storageProvider: chromeStorageAdapter },
    });

    // Extension-specific overrides: session.resume and agent.configUpdate
    // These need access to service-worker closures (agent, registry, currentAuthManager, etc.)
    serviceRegistry.register('session.resume', async (params) => {
      if (!agent) throw new Error('Agent not initialized');

      const { sessionId } = params as { sessionId: string };
      console.log('[ServiceWorker] Resuming session:', sessionId);

      const currentSession = agent.getSession();
      await currentSession.abortAllTasks('UserInterrupt');

      const tabManager = TabManager.getInstance();
      await tabManager.reset();
      await currentSession.close();

      const initialHistory = await RolloutRecorder.getRolloutHistory(sessionId);
      if (initialHistory.type !== 'resumed' || !initialHistory.payload?.history) {
        throw new Error('Conversation not found or has no history');
      }

      agent = new RepublicAgent(agentConfig!, {
        mode: 'resumed' as const,
        sessionId,
        rolloutItems: initialHistory.payload.history,
      }, undefined, new UserNotifier());

      // Wire event dispatch through channel
      agent.setEventDispatcher((event) => {
        channelManager.dispatchEvent({ msg: event.msg }, 'sidepanel-main').catch(() => {});
      });

      if (currentAuthManager) {
        const factory = agent.getModelClientFactory();
        factory.setAuthManager(currentAuthManager);
      }

      await agent.initialize();
      await configureExtensionPlatform(agent);

      const session = agent.getSession();
      await session.initialize();
      const history = session.getConversationHistory();

      console.log('[ServiceWorker] Session resumed with', history.items.length, 'items');
      return { sessionId, history: history.items };
    });

    serviceRegistry.register('agent.configUpdate', async () => {
      try {
        if (agentConfig) {
          await agentConfig.reload();
        } else {
          agentConfig = await AgentConfig.getInstance();
        }

        if (registry) {
          await registry.cleanup();
          registry.initialize(agentConfig);

          const primarySession = await registry.createSession({ type: 'primary' });
          agent = primarySession.agent;

          // Wire event dispatch through channel
          agent!.setEventDispatcher((event) => {
            channelManager.dispatchEvent({ msg: event.msg }, 'sidepanel-main').catch(() => {});
          });

          if (currentAuthManager && agent) {
            const factory = agent.getModelClientFactory();
            factory.setAuthManager(currentAuthManager);
            await agent.refreshModelClient();
          } else if (!currentAuthManager) {
            await initializeAuthFromConfig();
          }
        } else {
          if (agent) {
            const session = agent.getSession();
            await session.close();
            await agent.cleanup();
          }

          agent = new RepublicAgent(agentConfig, undefined, undefined, new UserNotifier());
          agent.setEventDispatcher((event) => {
            channelManager.dispatchEvent({ msg: event.msg }, 'sidepanel-main').catch(() => {});
          });

          if (currentAuthManager) {
            const factory = agent.getModelClientFactory();
            factory.setAuthManager(currentAuthManager);
          }
          await agent.initialize();
          await configureExtensionPlatform(agent);
          if (!currentAuthManager) {
            await initializeAuthFromConfig();
          } else {
            await agent.refreshModelClient();
          }
        }

        // Notify UI via channel
        channelManager.dispatchEvent(
          { msg: { type: 'BackgroundEvent', data: { message: 'Agent reinitialized', level: 'info' } } },
          'sidepanel-main'
        ).catch(() => {});

        return { success: true, message: 'Configuration reloaded and agent recreated' };
      } catch (error) {
        console.error('Failed to reload configuration:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    serviceRegistry.register('agent.initAuth', async (params) => {
      const { backendBaseUrl, useOwnApiKey } = params as {
        backendBaseUrl?: string | null;
        useOwnApiKey?: boolean;
      };

      const shouldUseBackend = useOwnApiKey === false;
      const authManager = new AuthManager(shouldUseBackend, shouldUseBackend ? (backendBaseUrl ?? null) : null);
      currentAuthManager = authManager;

      const primaryAgent = registry?.getPrimarySession()?.agent ?? agent;
      if (primaryAgent) {
        const factory = primaryAgent.getModelClientFactory();
        factory.setAuthManager(authManager);
        await primaryAgent.refreshModelClient();
      }

      return { success: true, isBackendRouting: shouldUseBackend };
    });

    serviceRegistry.register('session.setMaxConcurrent', async (params) => {
      const { maxConcurrent } = params as { maxConcurrent: number };
      if (registry && typeof maxConcurrent === 'number') {
        registry.setMaxConcurrent(maxConcurrent);
        return { success: true };
      }
      throw new Error('Invalid request or registry not initialized');
    });

    console.log(`[ServiceWorker] Registered ${count} service handlers on ChannelManager (+ extension overrides)`);
  } catch (error) {
    console.error('[ServiceWorker] Failed to register service handlers:', error);
  }
}

function setupMessageHandlers(): void {
  if (!registry) return;

  // Handle inline chrome.runtime messages for extension-specific operations
  // that don't go through ServiceRegistry (e.g., content script messages)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Stop agent session (from visual effects Stop Agent button)
    if (message.type === 'STOP_AGENT_SESSION') {
      (async () => {
        try {
          const targetAgent = getAgentForMessage(message);
          if (targetAgent) {
            const session = targetAgent.getSession();
            await session.abortAllTasks('UserInterrupt');
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'Agent not initialized' });
          }
        } catch (error) {
          console.error('[ServiceWorker] Failed to stop agent session:', error);
          sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      })();
      return true;
    }

  });
}

/**
 * Initialize Scheduler
 */
async function initializeScheduler(): Promise<void> {
  try {
    // Initialize storage adapter (IndexedDB on extension, SQLite on desktop/server)
    const storageAdapter = await createStorageAdapter();
    await storageAdapter.initialize();

    // Create new model components
    schedulerAlarms = new SchedulerAlarms();
    const scheduleEventStorage = new ScheduleEventStorage(storageAdapter);
    const executionStorage = new ExecutionStorage(storageAdapter);
    const scheduleManager = new ScheduleManager(scheduleEventStorage, executionStorage, schedulerAlarms);
    const jobExecutor = new JobExecutor(executionStorage);

    // Create scheduler with new constructor
    scheduler = new Scheduler(scheduleManager, jobExecutor, schedulerAlarms);

    // Feature 015: Connect scheduler to AgentRegistry for isolated session creation
    if (registry) {
      scheduler.setRegistry(registry);
      console.log('[ServiceWorker] Scheduler connected to AgentRegistry');
    }

    // Wire platform-specific callbacks for Chrome extension
    scheduler.setNotificationHandler(async (info) => {
      const inputPreview = info.input.length > 50
        ? info.input.slice(0, 50) + '...'
        : info.input;
      await chrome.notifications.create(`scheduler-job-${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Scheduled Job Starting',
        message: inputPreview,
        priority: 2,
        requireInteraction: false,
      });
    });

    scheduler.setJobLauncher(async (executionId, sessionId) => {
      const extensionUrl = chrome.runtime.getURL(
        `sidepanel/index.html?scheduledJob=${executionId}&sessionId=${sessionId}`
      );
      await chrome.tabs.create({ url: extensionUrl, active: true });
    });

    scheduler.setConnectivityCheck(() => navigator.onLine);

    // Event emitter is wired in registerServiceHandlers() where ChannelManager is available

    // Recover stale running jobs from previous app session
    await scheduler.recoverStaleRunningJob();

    // Start the job queue processor
    await schedulerAlarms.startJobQueueProcessor();

    // Detect missed jobs on startup
    const missed = await scheduler.detectMissedJobs();
    if (missed.length > 0) {
      console.log(`[ServiceWorker] Detected ${missed.length} missed scheduler instances`);
      // Show notification for missed jobs
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: t('Missed Scheduled Jobs'),
        message: t(`${missed.length} job(s) missed their scheduled time while the browser was closed.`),
        priority: 2,
      });
    }

    // Restore alarms for ScheduleEvents
    await scheduler.restoreScheduleAlarms();

    // T042: Resume job processing when connectivity is restored
    self.addEventListener('online', async () => {
      console.log('[ServiceWorker] Online - resuming scheduler job processing');
      if (scheduler) {
        await scheduler.processJobQueue();
      }
    });

    console.log('[ServiceWorker] Scheduler initialized');
  } catch (error) {
    console.error('[ServiceWorker] Failed to initialize scheduler:', error);
  }
}



/**
 * Auto-connect enabled MCP servers on service worker startup (T064)
 * Attempts to connect to all servers with enabled: true
 */
async function autoConnectEnabledMCPServers(): Promise<void> {
  if (!mcpManager) {
    console.warn('[ServiceWorker] Cannot auto-connect MCP servers - manager not ready');
    return;
  }

  const servers = mcpManager.getServers();
  const enabledServers = servers.filter((s) => s.enabled);

  if (enabledServers.length === 0) {
    console.log('[ServiceWorker] No enabled MCP servers to auto-connect');
    return;
  }

  console.log(`[ServiceWorker] Auto-connecting ${enabledServers.length} enabled MCP server(s)...`);

  // Connect to each enabled server with exponential backoff on failure
  for (const server of enabledServers) {
    try {
      console.log(`[ServiceWorker] Auto-connecting to MCP server: ${server.name}`);
      await mcpManager.connect(server.id);
      console.log(`[ServiceWorker] Auto-connected to MCP server: ${server.name}`);
    } catch (error) {
      // Log error but don't fail - other servers may still connect
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ServiceWorker] Failed to auto-connect MCP server ${server.name}: ${errorMsg}`);
    }
  }
}

/**
 * Setup MCP tool registration event handling
 * Registers/unregisters MCP tools with ToolRegistry when connections change
 * Feature 015: Uses primary session's tool registry
 */
function setupMCPToolRegistration(): void {
  // Feature 015: Get tool registry from primary session
  const primaryAgent = registry?.getPrimarySession()?.agent ?? agent;
  if (!mcpManager || !primaryAgent) {
    console.warn('[ServiceWorker] Cannot setup MCP tool registration - manager or agent not ready');
    return;
  }

  const toolRegistry = primaryAgent.getToolRegistry();

  // Track registered tools per server for cleanup
  const registeredServerTools = new Map<string, string[]>();

  mcpManager.on('event', async (event: MCPManagerEvent) => {
    if (event.type === 'tools-updated') {
      const { configId, tools } = event;
      const server = mcpManager!.getServer(configId);
      if (!server) return;

      const serverName = server.name;
      const connection = mcpManager!.getConnection(configId);

      // If connected and tools available, register them
      if (connection?.status === 'connected' && tools.length > 0) {
        // First unregister any previously registered tools for this server
        const previousTools = registeredServerTools.get(serverName);
        if (previousTools) {
          for (const toolName of previousTools) {
            try {
              await toolRegistry.unregister(toolName);
            } catch (e) {
              // Ignore - tool might not be registered
            }
          }
        }

        // Register new tools
        try {
          await registerMCPTools(mcpManager!, serverName, tools, toolRegistry);
          // Track registered tool names
          registeredServerTools.set(
            serverName,
            tools.map((t) => `${serverName}:${t.name}`)
          );
          console.log(`[ServiceWorker] Registered ${tools.length} MCP tools from ${serverName}`);
        } catch (error) {
          console.error(`[ServiceWorker] Failed to register MCP tools from ${serverName}:`, error);
        }
      }
    } else if (event.type === 'connection-status-changed') {
      const { configId, status } = event;
      const server = mcpManager!.getServer(configId);
      if (!server) return;

      const serverName = server.name;

      // If disconnecting or error, unregister tools
      if (status === 'disconnected' || status === 'error') {
        const previousTools = registeredServerTools.get(serverName);
        if (previousTools) {
          for (const toolName of previousTools) {
            try {
              await toolRegistry.unregister(toolName);
            } catch (e) {
              // Ignore - tool might not be registered
            }
          }
          registeredServerTools.delete(serverName);
          console.log(`[ServiceWorker] Unregistered MCP tools from ${serverName}`);
        }
      }
    }
  });

  console.log('[ServiceWorker] MCP tool registration handler setup complete');
}


// ==========================================================================
// A2A Integration (Feature 021)
// ==========================================================================

/**
 * Setup A2A tool registration event handling.
 * Registers/unregisters A2A skills with ToolRegistry when connections change.
 * Mirrors the setupMCPToolRegistration() pattern.
 */
function setupA2AToolRegistration(): void {
  const primaryAgent = registry?.getPrimarySession()?.agent ?? agent;
  if (!a2aManager || !primaryAgent) {
    console.warn('[ServiceWorker] Cannot setup A2A tool registration - manager or agent not ready');
    return;
  }

  const toolRegistry = primaryAgent.getToolRegistry();

  // Track registered skill names per agent for cleanup
  const registeredAgentSkills = new Map<string, string[]>();

  a2aManager.on('event', async (event: A2AManagerEvent) => {
    if (event.type === 'skills-updated') {
      const { configId, skills } = event;
      const agentConfig = a2aManager!.getAgent(configId);
      if (!agentConfig) return;

      const agentName = agentConfig.name;
      const connection = a2aManager!.getConnection(configId);

      // If connected and skills available, register them
      if (connection?.status === 'connected' && skills.length > 0) {
        // First unregister any previously registered skills for this agent
        const previousSkills = registeredAgentSkills.get(agentName);
        if (previousSkills) {
          for (const toolName of previousSkills) {
            try {
              await toolRegistry.unregister(toolName);
            } catch {
              // Ignore - tool might not be registered
            }
          }
        }

        // Register new skills
        try {
          await registerA2ASkills(a2aManager!, agentName, skills, toolRegistry, agentConfig.trusted);
          // Track registered tool names
          registeredAgentSkills.set(
            agentName,
            skills.map((s) => `${agentName}__${s.id}`)
          );
          console.log(`[ServiceWorker] Registered ${skills.length} A2A skills from ${agentName}`);
        } catch (error) {
          console.error(`[ServiceWorker] Failed to register A2A skills from ${agentName}:`, error);
        }
      }
    } else if (event.type === 'connection-status-changed') {
      const { configId, status } = event;
      const agentConfig = a2aManager!.getAgent(configId);
      if (!agentConfig) return;

      const agentName = agentConfig.name;

      // If disconnecting or error, unregister skills
      if (status === 'disconnected' || status === 'error') {
        const previousSkills = registeredAgentSkills.get(agentName);
        if (previousSkills) {
          for (const toolName of previousSkills) {
            try {
              await toolRegistry.unregister(toolName);
            } catch {
              // Ignore - tool might not be registered
            }
          }
          registeredAgentSkills.delete(agentName);
          console.log(`[ServiceWorker] Unregistered A2A skills from ${agentName}`);
        }
      }
    }
  });

  console.log('[ServiceWorker] A2A tool registration handler setup complete');
}

/**
 * Auto-connect enabled A2A agents on service worker startup
 * Attempts to connect to all agents with enabled: true
 */
async function autoConnectEnabledA2AAgents(): Promise<void> {
  if (!a2aManager) {
    console.warn('[ServiceWorker] Cannot auto-connect A2A agents - manager not ready');
    return;
  }

  const agents = a2aManager.getAgents();
  const enabledAgents = agents.filter((a) => a.enabled);

  if (enabledAgents.length === 0) {
    console.log('[ServiceWorker] No enabled A2A agents to auto-connect');
    return;
  }

  console.log(`[ServiceWorker] Auto-connecting ${enabledAgents.length} enabled A2A agent(s)...`);

  for (const agent of enabledAgents) {
    try {
      console.log(`[ServiceWorker] Auto-connecting to A2A agent: ${agent.name}`);
      await a2aManager.connect(agent.id);
      console.log(`[ServiceWorker] Auto-connected to A2A agent: ${agent.name}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ServiceWorker] Failed to auto-connect A2A agent ${agent.name}: ${errorMsg}`);
    }
  }
}


// ── Skills ────────────────────────────────────────────────────────────────

/**
 * Initialize Skills subsystem
 */
async function initializeSkills(): Promise<void> {
  try {
    const storageProvider = new IndexedDBStorageProvider();
    await storageProvider.initialize();

    const skillProvider = new IndexedDBSkillProvider(storageProvider);
    skillRegistry = new SkillRegistry(skillProvider);
    await skillRegistry.discover();

    // Register dynamic prompt extension for auto-invocable skills
    registerPromptExtension(() => skillRegistry?.buildSkillsSystemPrompt() ?? '');

    console.log('[ServiceWorker] Skills initialized');
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize skills:', error);
    // Non-fatal — skills are optional
  }
}


/**
 * Setup Chrome API event listeners
 */
function setupChromeListeners(): void {
  // Handle extension installation
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      // Open welcome page on first install
      chrome.tabs.create({
        url: chrome.runtime.getURL('welcome.html'),
      });
    }

    // Setup context menus
    setupContextMenus();
  });

  // Handle side panel opening
  if (chrome.sidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  // Handle commands (keyboard shortcuts)
  chrome.commands.onCommand.addListener((command) => {
    handleCommand(command);
  });

  // Handle context menu clicks
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab);
  });
}

/**
 * Setup context menus
 */
function setupContextMenus(): void {
  chrome.contextMenus.create({
    id: 'browserx-explain',
    title: t('Explain with Browserx'),
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'browserx-improve',
    title: t('Improve with Browserx'),
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'browserx-extract',
    title: t('Extract data with Browserx'),
    contexts: ['page', 'frame'],
  });
}

/**
 * Handle keyboard commands
 */
function handleCommand(command: string): void {
  switch (command) {
    case 'toggle-sidepanel':
      // Toggle side panel
      chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      break;

    case 'quick-action':
      // Trigger quick action on current tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          executeQuickAction(tabs[0].id);
        }
      });
      break;
  }
}

/**
 * Handle context menu clicks
 * Feature 015: Uses primary session
 */
async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  // Feature 015: Get primary agent
  const primaryAgent = registry?.getPrimarySession()?.agent ?? agent;
  if (!tab?.id || !primaryAgent) return;

  const submission: Partial<Submission> = {
    id: `ctx_${Date.now()}`,
    op: {
      type: 'UserInput',
      items: [],
    },
  };

  switch (info.menuItemId) {
    case 'browserx-explain':
      if (info.selectionText) {
        submission.op = {
          type: 'UserInput',
          items: [
            {
              type: 'text',
              text: t(`Explain this: ${info.selectionText}`),
            },
          ],
        };
      }
      break;

    case 'browserx-improve':
      if (info.selectionText) {
        submission.op = {
          type: 'UserInput',
          items: [
            {
              type: 'text',
              text: t(`Improve this text: ${info.selectionText}`),
            },
          ],
        };
      }
      break;

    case 'browserx-extract':
      submission.op = {
        type: 'UserInput',
        items: [
          {
            type: 'text',
            text: t(`Extract structured data from this page`),
          },
          {
            type: 'context',
            path: info.pageUrl,
          },
        ],
      };
      break;
  }

  // Submit to agent (Feature 015: uses primary agent from above)
  if (submission.op) {
    await primaryAgent.submitOperation(submission.op);

    // Open side panel to show results
    chrome.sidePanel.open({ tabId: tab.id });
  }
}

/**
 * Execute tab command
 */
async function executeTabCommand(
  tabId: number,
  command: string,
  args?: any
): Promise<any> {
  switch (command) {
    case 'evaluate':
      return chrome.scripting.executeScript({
        target: { tabId },
        func: (code: string) => eval(code),
        args: [args.code],
      });

    case 'screenshot':
      return chrome.tabs.captureVisibleTab({ format: 'png' });

    case 'get-html':
      return chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.documentElement.outerHTML,
      });

    case 'get-text':
      return chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.body.innerText,
      });

    case 'navigate':
      return chrome.tabs.update(tabId, { url: args.url });

    case 'reload':
      return chrome.tabs.reload(tabId);

    case 'close':
      return chrome.tabs.remove(tabId);

    default:
      throw new Error(`Unknown tab command: ${command}`);
  }
}

/**
 * Initialize storage layer
 */
async function initializeStorage(): Promise<void> {
  // Initialize config storage provider
  // NOTE: Static imports used — dynamic import() is banned in service workers.
  try {
    setConfigStorage(new ChromeConfigStorage());
    console.log('[ServiceWorker] Config storage initialized');
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize config storage:', error);
    // Continue - will fall back to chrome.storage.local directly
  }

  // Initialize credential store (for secure API key storage)
  try {
    setCredentialStore(new ChromeCredentialStore());
    console.log('[ServiceWorker] Credential store initialized');
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize credential store:', error);
  }

  // Initialize vault encryption (Feature 034: Credential Security)
  try {
    const vaultStatus = await VaultManager.initialize();
    console.log('[ServiceWorker] Vault initialized:', vaultStatus);
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize vault:', error);
  }

  // StorageProvider is initialized early in doInitialize() (before agent creation)
  // so that PlanningTool can access it during tool registration.
  // Skip here if already initialized.
  if (!isStorageProviderInitialized()) {
    try {
      const storageProvider = new IndexedDBStorageProvider();
      await storageProvider.initialize();
      setStorageProvider(storageProvider);
      console.log('[ServiceWorker] StorageProvider initialized');
    } catch (error) {
      console.error('[ServiceWorker] Failed to initialize StorageProvider:', error);
      console.error('[ServiceWorker] PlanningTool will be unavailable this session');
    }
  }

  // Initialize cache manager
  cacheManager = new CacheManager({
    maxSize: 50 * 1024 * 1024, // 50MB
    defaultTTL: 3600000, // 1 hour
    evictionPolicy: 'lru'
  });

  // Initialize storage quota manager
  storageQuotaManager = new StorageQuotaManager(cacheManager);
  await storageQuotaManager.initialize();

  // Check storage quota
  const quota = await storageQuotaManager.getQuota();

  // Request persistent storage if not already granted
  if (!quota.persistent) {
    await storageQuotaManager.requestPersistentStorage();
  }
}

/**
 * Execute quick action on tab
 * Feature 015: Uses primary session
 */
async function executeQuickAction(tabId: number): Promise<void> {
  // Get current page context
  const tab = await chrome.tabs.get(tabId);

  // Feature 015: Get primary agent
  const primaryAgent = registry?.getPrimarySession()?.agent ?? agent;
  if (!primaryAgent) return;

  // Submit quick analysis request
  await primaryAgent.submitOperation({
    type: 'UserInput',
    items: [
      {
        type: 'text',
        text: 'Analyze this page and provide key insights',
      },
      {
        type: 'context',
        path: tab.url,
      },
    ],
  });

  // Open side panel
  chrome.sidePanel.open({ tabId });
}

/**
 * Setup periodic tasks
 */
function setupPeriodicTasks(): void {
  // NOTE: Keep-alive mechanism intentionally NOT implemented here
  // The service worker will be woken up on-demand when messages arrive
  // UI (App.svelte) handles retries with exponential backoff if service worker is asleep
  // See App.svelte lines 54-87 for wake-up retry logic
  // TODO: Implement sophisticated keep-alive mechanism in the future

  // Process event queue periodically (Feature 015: process all sessions)
  setInterval(async () => {
    // Feature 015: Process events from all sessions
    if (registry) {
      let channelManager: import('@/core/channels/ChannelManager').ChannelManager | null = null;
      try {
        const { getChannelManager } = await import('@/core/channels/ChannelManager');
        channelManager = getChannelManager();
      } catch { /* channel not ready */ }

      for (const sessionMeta of registry.listSessions()) {
        const session = registry.getSession(sessionMeta.sessionId);
        if (session?.agent) {
          const event = await session.agent.getNextEvent();
          if (event && channelManager) {
            await channelManager.broadcastEvent({ msg: event.msg, sessionId: sessionMeta.sessionId });
          }
        }
      }
    } else if (agent) {
      // Legacy fallback
      const event = await agent.getNextEvent();
      if (event) {
        try {
          const { getChannelManager } = await import('@/core/channels/ChannelManager');
          await getChannelManager().broadcastEvent({ msg: event.msg });
        } catch { /* channel not ready */ }
      }
    }
  }, 100); // Check every 100ms

  // Cleanup old data and manage storage periodically
  // Wrap in try-catch to handle any chrome API issues
  try {
    // Check if chrome.alarms API is available
    if (typeof chrome !== 'undefined' && chrome?.alarms?.create) {
      chrome.alarms.create('rollout-cleanup', { periodInMinutes: 60 });
      chrome.alarms.create('cache-cleanup', { periodInMinutes: 30 });
      chrome.alarms.create('quota-check', { periodInMinutes: 10 });
      chrome.alarms.create('session-cleanup', { periodInMinutes: 120 }); // Feature 015: Clean orphaned sessions every 2 hours

      // Handle alarms
      chrome.alarms.onAlarm?.addListener(async (alarm) => {
        // Handle scheduler alarms first (job alarms and queue processor)
        const schedulerEvent = parseAlarmName(alarm.name);
        if (schedulerEvent && scheduler) {
          await scheduler.handleAlarm(alarm.name);
          return;
        }

        switch (alarm.name) {
          case 'rollout-cleanup':
            await performRolloutCleanup();
            break;
          case 'cache-cleanup':
            if (cacheManager) {
              await cacheManager.cleanup();
            }
            break;
          case 'quota-check':
            if (storageQuotaManager) {
              const shouldCleanup = await storageQuotaManager.shouldCleanup();
              if (shouldCleanup) {
                await storageQuotaManager.cleanup(70);
              }
            }
            break;
          case 'session-cleanup':
            // Feature 015: Clean up orphaned sessions
            if (registry) {
              await registry.cleanupOrphanedSessions(24 * 60 * 60 * 1000);
            }
            break;
        }
      });
    } else {
      console.warn('chrome.alarms API not available, periodic cleanup disabled');
      // Fallback: Use setInterval for cleanup tasks if alarms API is not available
      setInterval(async () => {
        await performRolloutCleanup();
      }, 60 * 60 * 1000); // Every hour

      setInterval(async () => {
        if (cacheManager) {
          await cacheManager.cleanup();
        }
      }, 30 * 60 * 1000); // Every 30 minutes

      setInterval(async () => {
        if (storageQuotaManager) {
          const shouldCleanup = await storageQuotaManager.shouldCleanup();
          if (shouldCleanup) {
            await storageQuotaManager.cleanup(70);
          }
        }
      }, 10 * 60 * 1000); // Every 10 minutes

      // Feature 015: Fallback session cleanup
      setInterval(async () => {
        if (registry) {
          await registry.cleanupOrphanedSessions(24 * 60 * 60 * 1000);
        }
      }, 2 * 60 * 60 * 1000); // Every 2 hours
    }
  } catch (error) {
    console.error('Failed to setup Chrome alarms:', error);
    console.warn('Falling back to setInterval for periodic cleanup');

    // Fallback: Use setInterval for cleanup tasks if alarms API fails
    setInterval(async () => {
      await performRolloutCleanup();
    }, 60 * 60 * 1000); // Every hour

    setInterval(async () => {
      if (cacheManager) {
        await cacheManager.cleanup();
      }
    }, 30 * 60 * 1000); // Every 30 minutes

    setInterval(async () => {
      if (storageQuotaManager) {
        const shouldCleanup = await storageQuotaManager.shouldCleanup();
        if (shouldCleanup) {
          await storageQuotaManager.cleanup(70);
        }
      }
    }, 10 * 60 * 1000); // Every 10 minutes

    // Feature 015: Fallback session cleanup (in catch block)
    setInterval(async () => {
      if (registry) {
        await registry.cleanupOrphanedSessions(24 * 60 * 60 * 1000);
      }
    }, 2 * 60 * 60 * 1000); // Every 2 hours
  }
}

/**
 * Perform rollout cleanup
 */
async function performRolloutCleanup(): Promise<void> {
  try {
    await RolloutRecorder.cleanupExpired();
  } catch (error) {
    console.error('[RolloutCleanup] Failed to cleanup expired rollouts:', error);
  }

  // Also clean up temporary chrome.storage items
  const storage = await chrome.storage.local.get(null);
  const now = Date.now();
  const keysToRemove: string[] = [];

  // Remove old temporary data (older than 24 hours)
  for (const key in storage) {
    if (key.startsWith('temp_')) {
      const data = storage[key] as Record<string, any>;
      if (data?.timestamp && now - data.timestamp > 24 * 60 * 60 * 1000) {
        keysToRemove.push(key);
      }
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

/**
 * Handle service worker activation
 */
chrome.runtime.onStartup.addListener(() => {
  initialize();
});

/**
 * Handle service worker installation
 */
chrome.runtime.onInstalled.addListener(async () => {
  // Continue with normal initialization
  initialize();
});

/**
 * Handle service worker shutdown
 * Feature 015: Clean up registry instead of singleton agent
 */
chrome.runtime.onSuspend.addListener(async () => {
  // Feature 015: Cleanup registry (which cleans up all sessions)
  if (registry) {
    await registry.cleanup();
  } else if (agent) {
    /**
     * @deprecated Legacy fallback for shutdown - should rarely execute.
     * Feature 015: This path exists only if registry failed to initialize.
     */
    console.warn('[ServiceWorker] Using legacy cleanup fallback - registry not available');
    const session = agent.getSession();
    await session.close();
    await agent.cleanup();
  }

  if (cacheManager) {
    cacheManager.destroy();
  }

  if (storageQuotaManager) {
    storageQuotaManager.destroy();
  }

  // Reset initialization flag so it can be re-initialized if the service worker restarts
  isInitialized = false;
  initializationPromise = null;
  registry = null;
  agent = null;
});

// ============================================================================
// ON-DEMAND SERVICE WORKER WAKE-UP STRATEGY
// ============================================================================
// Chrome terminates service workers after 30 seconds of inactivity.
// Instead of keeping the service worker alive with alarms, we use on-demand wake-up:
//
// 1. Service Worker: Auto-initializes when ANY message arrives (see below)
// 2. UI (App.svelte): Retries with exponential backoff if worker is asleep
//    - Initial retry: 200ms, then 400ms, 800ms, 1600ms, 3200ms
//    - Max retries: 8 attempts
//    - Detects "port closed" errors and shows helpful messages
//
// Benefits:
// - Simpler implementation (no keep-alive alarms)
// - Better battery life (worker sleeps when not needed)
// - Graceful degradation (UI handles wake-up transparently)
//
// Trade-offs:
// - First message after sleep takes longer (~200-400ms)
// - User sees brief "Service worker starting..." message
//
// Future: Implement sophisticated keep-alive for production use
// ============================================================================

// Ensure initialization happens when messages arrive
// This handles cases where the service worker wakes up from sleep
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Initialize if not already initialized
  if (!isInitialized && !initializationPromise) {
    // Start async initialization and keep port open
    initialize()
      .then(() => {
        console.log('[Service Worker] Initialization complete on message wake-up');
        sendResponse({ success: true, initialized: true });
      })
      .catch(err => {
        console.error('Failed to initialize on message:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message port open for async response
  }
  // If initialization is in progress, wait for it
  if (initializationPromise) {
    initializationPromise
      .then(() => {
        sendResponse({ success: true, initialized: true });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message port open
  }
  return false;
});

// Initialize on script load
initialize();

// Export for testing (Feature 015: include registry and sessionStorage)
export { agent, registry, sessionStorage, initialize };
