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
import { registerPlanReviewTools } from '../../tools/planReview/PlanReviewTools';
import { setDynamicRuntimeContext } from '../../core/PromptLoader';
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
import { IndexedDBRolloutStorageProvider } from '../../storage/rollout/provider/IndexedDBRolloutStorageProvider';
import { AgentConfig } from '../../config/AgentConfig';
import { STORAGE_KEYS } from '../../config/defaults';
import { DEFAULT_APPROVAL_CONFIG } from '../../core/approval/types';
import { TabManager } from '../../core/TabManager';
import { LLM_API_URL } from '../../config/constants';
// Track 22: MCP/A2A are gated behind compile-time feature flags. Manager
// classes and tool-adapter helpers load via dynamic import() inside the
// feature-gated init blocks, so an OFF build tree-shakes core/mcp +
// core/a2a out of the extension bundle entirely. Only type-only imports
// remain at top level (erased at compile time — zero bundle cost).
import type { MCPManager as MCPManagerT } from '../../core/mcp/MCPManager';
import type { MCPManagerEvent } from '../../core/mcp/types';
import type { A2AManager as A2AManagerT } from '../../core/a2a/A2AManager';
import type { A2AManagerEvent } from '../../core/a2a/types';
import { MCP, A2A } from '../../core/features/feature';

// Skills imports
import { SkillRegistry } from '../../core/skills';
import { IndexedDBSkillProvider } from '../../extension/storage/IndexedDBSkillProvider';
import { IndexedDBStorageProvider } from '../../extension/storage/IndexedDBStorageProvider';
import { registerPromptExtension } from '../../core/PromptLoader';

// Scheduler imports
import { Scheduler, ScheduleManager, JobExecutor, ScheduleEventStorage, ExecutionStorage } from '../../core/scheduler';
import { SchedulerAlarms } from './scheduler-alarms';
import { parseAlarmName } from '../../core/models/types/SchedulerContracts';

// Static imports required because dynamic import() is banned in Chrome
// extension service workers by the HTML specification.
// See: https://github.com/w3c/ServiceWorker/issues/1356
import { setConfigStorage } from '../../core/storage/ConfigStorageProvider';
import { setCredentialStore } from '../../core/storage/CredentialStore';
import { setStorageProvider, isStorageProviderInitialized } from '../../core/storage';
import { ChromeConfigStorage } from '../../extension/storage/ChromeConfigStorage';
import { ChromeManagedConfigSource } from '../../extension/storage/ChromeManagedConfigSource';
import {
  registerPolicySources,
  resolveActivePolicy,
  onPolicyChanged,
  assessAndRecord,
} from '../../core/config/policy';
import { ChromeCredentialStore } from '../../extension/storage/ChromeCredentialStore';
import * as VaultManager from '../../core/crypto/VaultManager';
// Modules previously loaded via dynamic import() — must be static in service workers
import { IndexedDBAdapter } from '../../storage/IndexedDBAdapter';
import type { StorageAdapter } from '../../storage/StorageAdapter';
import { TokenUsageStore } from '../../storage/TokenUsageStore';
import { getChannelManager } from '../../core/channels/ChannelManager';
import { registerAllServices } from '../../core/services';
import { CompactService } from '../../core/compact/CompactService';
import type { ResponseItem } from '../../core/protocol/types';
import { SidePanelChannel } from '../../extension/channels/SidePanelChannel';
import { ChatGPTOAuthExtensionStorage } from '../auth/ChatGPTOAuthExtensionStorage';
import { ChatGPTOAuthService } from '../../core/auth/ChatGPTOAuthService';
// Multi-agent registry imports (Feature 015)
import { AgentRegistry, SessionStorage } from '../../core/registry';
import type { SessionConfig } from '../../core/registry/types';
import { DEFAULT_MAX_CONCURRENT } from '../../core/registry/types';
import { PRIMARY_SESSION_ALIAS } from '../../core/models/types/SessionContracts';
import { t } from '../../webfront/lib/i18n';

// Global instances
let registry: AgentRegistry | null = null;
let cacheManager: CacheManager | null = null;
let storageQuotaManager: StorageQuotaManager | null = null;
let agentConfig: AgentConfig | null = null;
let mcpManager: MCPManagerT | null = null; // MCP server connection manager
let a2aManager: A2AManagerT | null = null; // A2A agent connection manager
let currentAuthManager: AuthManager | null = null; // Preserve auth state across agent recreation
let scheduler: Scheduler | null = null; // Job scheduler
let schedulerAlarms: SchedulerAlarms | null = null;
let sessionStorage: SessionStorage | null = null; // Feature 015: Session persistence
let skillRegistry: SkillRegistry | null = null; // Agent skills
// Track 10: global plugin registry (skills + MCP slots; per-session
// hooks/agents binding is a documented follow-up needing an
// AgentRegistry.onAgentCreated hook on the extension path).
let pluginRegistry: import('@/core/plugins/PluginRegistry').PluginRegistry | null = null;
// Track 10: IDB provider's virtual-path resolvers, for per-session binding.
let pluginFsResolvers: {
  readFile: (p: string) => Promise<string | null>;
  listDirs: (p: string) => Promise<string[]>;
} | null = null;
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
  // Wire hook dispatcher so PermissionRequest/PermissionDenied hooks fire
  approvalGate.setHookDispatcher(targetAgent.getHookDispatcher());

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

  // Plan Review (Track 14): register Begin/Submit closures here, where the
  // registry + core ApprovalManager are in scope (ToolContext exposes
  // neither). Feed the registry's freeze flag into the system prompt each
  // turn so the read-only-exploration guidance persists across the review.
  await registerPlanReviewTools({
    registry: toolRegistry,
    approvalManager,
    approvalGate,
    platformId: 'extension',
    recordPlanArtifact: (payload) =>
      targetAgent.getSession().persistRolloutItems([{ type: 'plan_artifact', payload }]),
  });
  setDynamicRuntimeContext(() => ({
    planReviewActive: toolRegistry.isPlanReviewActive(),
  }));

  // Tab closure handler
  const tabManager = TabManager.getInstance();
  const session = targetAgent.getSession();
  const notifier = targetAgent.getUserNotifier();

  tabManager.onTabClosure(async (closedTabId: number) => {
    // Track 04 / Q9: tab close has two cases:
    //
    // (a) The session's main tab closes -> hard shutdown of the session.
    //     Existing behavior, preserved.
    //
    // (b) A working tab (referenced by some background task's scopedTabIds
    //     but not the session's main tab) closes -> only abort tasks
    //     scoped to that tab. Background tasks NOT touching that tab keep
    //     running. This is what makes background sub-agents survive
    //     incidental working-tab closures.
    if (session.getTabId() === closedTabId) {
      session.setTabId(-1);
      await session.abortAllTasks('TabClosed');
      await notifier.notifyWarning(
        'Tab Closed',
        'The tab was closed or crashed. All tasks have been stopped.'
      );
    } else {
      // Working-tab close: selective abort. abortTasksForTab filters
      // internally and is a no-op when no tasks are scoped to the tab.
      await session.abortTasksForTab(closedTabId, 'TabClosed');
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

  // Initialize ConfigStorage and CredentialStore BEFORE any code that needs them.
  // AgentConfig, MCPManager, A2AManager, ApprovalConfigStorage all depend on ConfigStorage.
  try {
    setConfigStorage(new ChromeConfigStorage());
    console.log('[ServiceWorker] Config storage initialized (early)');
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize config storage:', error);
  }

  try {
    setCredentialStore(new ChromeCredentialStore());
    console.log('[ServiceWorker] Credential store initialized (early)');
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize credential store:', error);
  }

  // Track 20: register the Chrome-native managed-policy source and resolve it
  // BEFORE AgentConfig.getInstance() so the first buildRuntimeConfig already
  // sees admin policy. Fail-open: no managed storage → no policy.
  try {
    registerPolicySources([new ChromeManagedConfigSource()]);
    await resolveActivePolicy();
    console.log('[ServiceWorker] Managed policy resolved (early)');
  } catch (error) {
    console.warn('[ServiceWorker] Managed policy resolution failed:', error);
  }

  // Inject RolloutRecorder provider before any session creation triggers it.
  // Direct instantiation avoids dynamic import() which is banned in service workers.
  try {
    const rolloutProvider = new IndexedDBRolloutStorageProvider();
    await rolloutProvider.initialize();
    RolloutRecorder.setProvider(rolloutProvider);
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize rollout provider:', error);
  }

  // Initialize configuration singleton first
  agentConfig = await AgentConfig.getInstance();

  // Track 20: when admin pushes a managed-policy change (chrome.storage
  // managed area, auto-wired via the source's subscribe), re-hydrate so the
  // pin re-applies and the UI re-renders locked fields.
  onPolicyChanged((p) => {
    const a = assessAndRecord(p);
    if (a.weakened) {
      console.warn(
        '[ServiceWorker] Organization applied a managed policy that weakens security:',
        a.reasons.join('; ')
      );
    }
    AgentConfig.getInstance()
      .then((c) => c.reload())
      .catch((err) =>
        console.warn('[ServiceWorker] policy reload failed:', err)
      );
  });

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
  const maxConcurrentSessions = config.preferences?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT;
  registry = AgentRegistry.getInstance({
    maxConcurrent: maxConcurrentSessions,
    // Track 10: bind enabled plugins' hooks + sub-agent types to each new
    // session. Reads module-level pluginRegistry/resolvers lazily — they're
    // set by initializePlugins() before real sessions are created.
    onAgentCreated: async (agent, { subAgentRunner }) => {
      if (!pluginRegistry || !pluginFsResolvers || !subAgentRunner) return;
      try {
        const { PluginSessionBinder } = await import('@/core/plugins/PluginSessionBinder');
        const binder = new PluginSessionBinder({
          hookRegistry: agent.getHookRegistry(),
          subAgentRunner,
          readFile: pluginFsResolvers.readFile,
          listDirs: pluginFsResolvers.listDirs,
        });
        const enabled = pluginRegistry
          .getPlugins()
          .filter((p) => p.state.status === 'enabled');
        await binder.applyEnabledPlugins(enabled);
        pluginRegistry.registerSessionBinder(binder);
      } catch (e) {
        console.warn('[ServiceWorker] plugin session bind failed (non-fatal):', e);
      }
    },
  });
  registry.initialize(agentConfig!);

  // Initialize IndexedDB storage adapter early — shared by session persistence and TokenUsageStore.
  // Created here so TokenUsageStore works even if session persistence fails.
  try {
    const storageAdapter = new IndexedDBAdapter();
    await storageAdapter.initialize();
    TokenUsageStore.setAdapter(storageAdapter);

    // Feature 015 (T039): Initialize session persistence (uses same adapter)
    await initializeSessionPersistence(storageAdapter);
  } catch (error) {
    console.error('[ServiceWorker] Failed to initialize IndexedDB adapter:', error);
  }

  // Create initial session (always at least one)
  const initialSession = await registry.createSession({ type: 'primary' });

  console.log(`[ServiceWorker] Initial session created: ${initialSession.sessionId}`);

  // Initialize auth manager from stored config preferences
  // This ensures backend routing is set up correctly on service worker startup
  await initializeAuthFromConfig();

  // Track 22: MCP gated behind the MCP compile-time flag. When OFF this
  // whole block is dead-code-eliminated and the dynamic import() chunk is
  // never emitted, so core/mcp leaves the extension bundle.
  if (MCP) {
    // Initialize MCP manager
    const { MCPManager } = await import('../../core/mcp/MCPManager');
    mcpManager = await MCPManager.getInstance();

    // Subscribe to MCP events for tool registration/unregistration
    // (sync — handler attaches immediately, before any auto-connect)
    setupMCPToolRegistration();

    // Auto-connect enabled MCP servers (T064: service worker lifecycle handling)
    await autoConnectEnabledMCPServers();
  }

  // Setup message handlers
  setupMessageHandlers();

  // Track 22: A2A gated behind the A2A compile-time flag (same DCE rationale).
  if (A2A) {
    // Initialize A2A manager
    const { A2AManager } = await import('../../core/a2a/A2AManager');
    a2aManager = await A2AManager.getInstance();

    // Subscribe to A2A events for tool registration/unregistration
    // (sync — handler attaches immediately, before any auto-connect)
    setupA2AToolRegistration();

    // Auto-connect enabled A2A agents
    await autoConnectEnabledA2AAgents();
  }

  // Initialize Skills
  await initializeSkills();

  // Track 10: initialize the plugin system (after skills — the skill slot
  // loader targets the global skillRegistry).
  await initializePlugins();

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
  if (!agentConfig || !registry) return;

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

    // Apply auth to all active sessions
    const sessions = registry.listSessions() as Array<{ sessionId: string; state: string }>;
    for (const s of sessions) {
      if (s.state === 'terminated') continue;
      const agentSession = registry.getSession(s.sessionId);
      if (agentSession?.agent) {
        const factory = agentSession.agent.getModelClientFactory();
        factory.setAuthManager(authManager);
      }
    }

    console.log('[ServiceWorker] Auth initialized, shouldUseBackend:', shouldUseBackend);

    // Check for ChatGPT OAuth tokens and configure token getter
    try {
      const oauthStorage = new ChatGPTOAuthExtensionStorage();
      const oauthService = new ChatGPTOAuthService(oauthStorage);

      if (await oauthService.isAuthenticated()) {
        authManager.setChatGPTOAuth(() => oauthService.getValidAccessToken());
        // Re-apply auth with OAuth to all sessions
        for (const s of sessions) {
          if (s.state === 'terminated') continue;
          const agentSession = registry.getSession(s.sessionId);
          if (agentSession?.agent) {
            agentSession.agent.getModelClientFactory().setAuthManager(authManager);
          }
        }
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
async function initializeSessionPersistence(storageAdapter: StorageAdapter): Promise<void> {
  if (!registry) {
    console.warn('[ServiceWorker] Cannot initialize session persistence - registry not ready');
    return;
  }

  try {
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
  // Route by sessionId — no fallback to a "primary" session
  const sessionId = message.payload?.sessionId ?? message.payload?.context?.sessionId;

  if (!sessionId) {
    console.warn('[ServiceWorker] No sessionId in message, cannot route');
    return null;
  }

  if (!registry) {
    console.warn('[ServiceWorker] Registry not initialized');
    return null;
  }

  const agentSession = registry.getSession(sessionId);
  if (agentSession?.agent) {
    return agentSession.agent;
  }

  console.warn(`[ServiceWorker] Session ${sessionId} not found`);
  return null;
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
    const channelManager = getChannelManager();

    // Register SidePanelChannel if not already registered
    if (!channelManager.getChannel('sidepanel-main')) {
      const sidePanelChannel = new SidePanelChannel();

      // Set the agent handler to route non-ServiceRequest Ops to the correct session
      channelManager.setAgentHandler(async (op, context) => {
        if (!context.sessionId) {
          throw new Error('No sessionId in submission context — cannot route operation');
        }
        if (!registry) {
          throw new Error('AgentRegistry not initialized');
        }

        const targetSession = registry.getSession(context.sessionId);
        if (!targetSession?.agent) {
          throw new Error(`Session not found: ${context.sessionId}`);
        }

        await targetSession.agent.submitOperation(op, { tabId: context.tabId });
      });

      await channelManager.registerChannel(sidePanelChannel);
      // Note: event dispatchers are wired per-session in AgentRegistry.createSession()
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

    if (!registry) throw new Error('AgentRegistry not initialized');

    const count = registerAllServices(serviceRegistry, {
      mcp: mcpManager ? { mcpManager } : undefined,
      scheduler: scheduler ? { scheduler } : undefined,
      diagnostics: {
        buildCtx: () => ({
          platformId: 'extension',
          channelManager: getChannelManager(),
          mcpManager: mcpManager ?? undefined,
          skillRegistry: skillRegistry ?? undefined,
          scheduler: scheduler ?? undefined,
        }),
      },
      skills: skillRegistry ? { skillRegistry } : undefined,
      plugins: pluginRegistry ? { pluginRegistry } : undefined,
      vault: {
        vaultManager: VaultManager as any,
      },
      a2a: a2aManager ? { a2aManager } : undefined,
      session: {
        registry,
        resetTabs: async () => {
          const tabManager = TabManager.getInstance();
          await tabManager.reset();
        },
        loadRolloutHistory: async (sessionId: string) => {
          const initialHistory = await RolloutRecorder.getRolloutHistory(sessionId);
          if (initialHistory.type !== 'resumed' || !initialHistory.payload?.history) return null;
          return { sessionId, rolloutItems: initialHistory.payload.history };
        },
        // Track 15 (D9): summarize_up_to summarizer, sourced from the live
        // primary agent's existing ModelClientFactory (no client built here).
        summarizeForRewind: async (items: ResponseItem[]) => {
          const reg = registry;
          const primary = reg?.getPrimarySession();
          const agent = primary ? reg?.getSession(primary.sessionId)?.agent : null;
          if (!agent) return undefined;
          try {
            const modelClient = await agent.getModelClientFactory().createClientForCurrentModel();
            const result = await new CompactService().compact(
              items,
              'manual',
              modelClient,
              0,
              undefined,
              { sessionId: agent.getSession().getSessionId() },
            );
            return result.success ? result.summaryText : undefined;
          } catch (err) {
            console.warn('[service-worker] summarizeForRewind failed:', err);
            return undefined;
          }
        },
      },
      agent: {
        registry,
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

    // Extension-specific override: agent.configUpdate
    // Needs access to service-worker closures (registry, agentConfig, etc.)
    serviceRegistry.register('agent.configUpdate', async () => {
      try {
        if (agentConfig) {
          await agentConfig.reload();
        } else {
          agentConfig = await AgentConfig.getInstance();
        }

        if (!registry) {
          throw new Error('AgentRegistry not initialized');
        }

        // Cleanup all sessions and re-create them with new config
        await registry.cleanup();
        registry.initialize(agentConfig);

        const newSession = await registry.createSession({ type: 'primary' });

        if (currentAuthManager && newSession.agent) {
          const agentSession = registry.getSession(newSession.sessionId);
          if (agentSession?.agent) {
            const factory = agentSession.agent.getModelClientFactory();
            factory.setAuthManager(currentAuthManager);
            await agentSession.agent.refreshModelClient();
          }
        } else if (!currentAuthManager) {
          await initializeAuthFromConfig();
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

      // Apply auth to all active sessions
      if (registry) {
        const sessions = registry.listSessions() as Array<{ sessionId: string; state: string }>;
        for (const s of sessions) {
          if (s.state === 'terminated') continue;
          const agentSession = registry.getSession(s.sessionId);
          if (agentSession?.agent) {
            const factory = agentSession.agent.getModelClientFactory();
            factory.setAuthManager(authManager);
            await agentSession.agent.refreshModelClient();
          }
        }
      }

      return { success: true, isBackendRouting: shouldUseBackend };
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
    // Initialize storage adapter (IndexedDB — static import for service worker compatibility)
    const storageAdapter = new IndexedDBAdapter();
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
 * Applies to all active sessions' tool registries.
 */
function setupMCPToolRegistration(): void {
  if (!mcpManager || !registry) {
    console.warn('[ServiceWorker] Cannot setup MCP tool registration - manager or registry not ready');
    return;
  }

  /** Get tool registries from all active sessions */
  function getAllToolRegistries() {
    const registries: ReturnType<RepublicAgent['getToolRegistry']>[] = [];
    for (const meta of registry!.listSessions() as Array<{ sessionId: string; state: string }>) {
      if (meta.state === 'terminated') continue;
      const s = registry!.getSession(meta.sessionId);
      if (s?.agent) registries.push(s.agent.getToolRegistry());
    }
    return registries;
  }

  // Use the first active session's registry for the tracked-tools map
  // (tool names are the same across sessions)
  const getAnyToolRegistry = () => getAllToolRegistries()[0];

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
          for (const tr of getAllToolRegistries()) {
            for (const toolName of previousTools) {
              try { await tr.unregister(toolName); } catch { /* ignore */ }
            }
          }
        }

        // Register new tools on all sessions
        try {
          // Track 22: lazy adapter import — keeps core/mcp/MCPToolAdapter out
          // of OFF builds (this whole function is unreferenced when MCP is
          // off, so it tree-shakes), without delaying the .on() subscription
          // above. import() is cached after the first event.
          const { registerMCPTools } = await import('../../core/mcp/MCPToolAdapter');
          for (const tr of getAllToolRegistries()) {
            await registerMCPTools(mcpManager!, serverName, tools, tr);
          }
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

      // If disconnecting or error, unregister tools from all sessions
      if (status === 'disconnected' || status === 'error') {
        const previousTools = registeredServerTools.get(serverName);
        if (previousTools) {
          for (const tr of getAllToolRegistries()) {
            for (const toolName of previousTools) {
              try { await tr.unregister(toolName); } catch { /* ignore */ }
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
  if (!a2aManager || !registry) {
    console.warn('[ServiceWorker] Cannot setup A2A tool registration - manager or registry not ready');
    return;
  }

  /** Get tool registries from all active sessions */
  function getAllToolRegistries() {
    const registries: ReturnType<RepublicAgent['getToolRegistry']>[] = [];
    for (const meta of registry!.listSessions() as Array<{ sessionId: string; state: string }>) {
      if (meta.state === 'terminated') continue;
      const s = registry!.getSession(meta.sessionId);
      if (s?.agent) registries.push(s.agent.getToolRegistry());
    }
    return registries;
  }

  // Track registered skill names per a2a agent for cleanup
  const registeredAgentSkills = new Map<string, string[]>();

  a2aManager.on('event', async (event: A2AManagerEvent) => {
    if (event.type === 'skills-updated') {
      const { configId, skills } = event;
      const a2aAgentConfig = a2aManager!.getAgent(configId);
      if (!a2aAgentConfig) return;

      const agentName = a2aAgentConfig.name;
      const connection = a2aManager!.getConnection(configId);

      // If connected and skills available, register them
      if (connection?.status === 'connected' && skills.length > 0) {
        // First unregister any previously registered skills
        const previousSkills = registeredAgentSkills.get(agentName);
        if (previousSkills) {
          for (const tr of getAllToolRegistries()) {
            for (const toolName of previousSkills) {
              try { await tr.unregister(toolName); } catch { /* ignore */ }
            }
          }
        }

        // Register new skills on all sessions
        try {
          // Track 22: lazy adapter import — keeps core/a2a/A2AToolAdapter out
          // of OFF builds (this whole function is unreferenced when A2A is
          // off, so it tree-shakes), without delaying the .on() subscription
          // above. import() is cached after the first event.
          const { registerA2ASkills } = await import('../../core/a2a/A2AToolAdapter');
          for (const tr of getAllToolRegistries()) {
            await registerA2ASkills(a2aManager!, agentName, skills, tr, a2aAgentConfig.trusted);
          }
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
      const a2aAgentConfig = a2aManager!.getAgent(configId);
      if (!a2aAgentConfig) return;

      const agentName = a2aAgentConfig.name;

      // If disconnecting or error, unregister skills from all sessions
      if (status === 'disconnected' || status === 'error') {
        const previousSkills = registeredAgentSkills.get(agentName);
        if (previousSkills) {
          for (const tr of getAllToolRegistries()) {
            for (const toolName of previousSkills) {
              try { await tr.unregister(toolName); } catch { /* ignore */ }
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

    // Track 03 Phase 3 — wire domain-based conditional activation.
    const { SkillDomainFilter } = await import('@/core/skills/SkillDomainFilter');
    const { ActiveTabService } = await import('@/core/tabs/ActiveTabService');
    const { startChromeActiveTabAdapter } = await import('./ChromeActiveTabAdapter');

    const activeTabService = new ActiveTabService();
    const skillDomainFilter = new SkillDomainFilter();

    // Subscribe FIRST so the seed snapshot from the adapter reaches the filter
    // (adapter starts firing events immediately on startup).
    activeTabService.subscribe((snap) => {
      skillDomainFilter.onActiveTabChange(snap.hostname);
    });
    const stopAdapter = startChromeActiveTabAdapter(activeTabService);

    skillRegistry = new SkillRegistry(skillProvider, skillDomainFilter);
    await skillRegistry.discover();

    // Race fix (B3): the seed snapshot likely arrived between subscribe() and
    // discover(), so the filter handled it against empty maps. Replay it now
    // that init() has populated the conditional/active maps.
    const seedSnapshot = activeTabService.getCurrent();
    if (seedSnapshot) skillDomainFilter.onActiveTabChange(seedSnapshot.hostname);

    // Register dynamic prompt extension for auto-invocable skills
    registerPromptExtension('skills', () => skillRegistry?.buildSkillsSystemPrompt() ?? '');

    // Stash adapter cleanup on the registry handle so HMR/teardown can reach it.
    (skillRegistry as unknown as { __disposeTabAdapter?: () => void }).__disposeTabAdapter = stopAdapter;

    console.log('[ServiceWorker] Skills initialized');
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize skills:', error);
    // Non-fatal — skills are optional
  }
}

/**
 * Track 10: initialize the global plugin system for the extension.
 *
 * Wires the globally-reachable slots — skills (the same SkillRegistry the
 * skills service uses) + MCP (the singleton MCPManager). Hooks + sub-agent
 * types are per-session (created in AgentRegistry's extension path) and are
 * a documented follow-up needing an AgentRegistry.onAgentCreated hook;
 * commands are global storage. Plugins live in an IDB-virtualized store.
 */
async function initializePlugins(): Promise<void> {
  try {
    const { IndexedDBStorageProvider } = await import('../storage/IndexedDBStorageProvider');
    const { IndexedDBPluginProvider } = await import('../storage/IndexedDBPluginProvider');
    const { PluginRegistry } = await import('@/core/plugins/PluginRegistry');
    const { SkillSlotLoader } = await import('@/core/plugins/loaders/SkillSlotLoader');
    const { McpSlotLoader } = await import('@/core/plugins/loaders/McpSlotLoader');
    const { AgentConfig } = await import('@/config/AgentConfig');

    const storageProvider = new IndexedDBStorageProvider();
    await storageProvider.initialize();
    const provider = new IndexedDBPluginProvider(storageProvider);
    await provider.initialize();
    pluginFsResolvers = { readFile: provider.readFile, listDirs: provider.listDirs };

    const agentConfig = await AgentConfig.getInstance();

    pluginRegistry = new PluginRegistry({
      provider,
      // Virtual-path resolvers from the IDB provider keep the slot loaders
      // platform-agnostic.
      skillSlot: skillRegistry
        ? new SkillSlotLoader({
            skillRegistry,
            readFile: provider.readFile,
            listDirs: provider.listDirs,
          })
        : undefined,
      mcpSlot: mcpManager ? new McpSlotLoader(mcpManager) : undefined,
      // hooks / agents: per-session (AgentRegistry extension path) — follow-up
      getEnabledFromConfig: () => agentConfig.getConfig().enabledPlugins ?? {},
      persistEnabled: async (id, enabled) => {
        const current = agentConfig.getConfig().enabledPlugins ?? {};
        agentConfig.updateConfig({
          enabledPlugins: { ...current, [id]: enabled },
        });
      },
    });

    const metas = await provider.listMeta();
    for (const m of metas) {
      try {
        pluginRegistry.register(await provider.load(`${m.name}@local`));
      } catch (e) {
        console.warn(`[ServiceWorker] plugin load ${m.name} failed:`, e);
      }
    }
    await pluginRegistry.bootstrapEnabledPlugins();

    agentConfig.on('config-changed', (e: { section?: string }) => {
      if (e.section === 'enabledPlugins') {
        void pluginRegistry?.reconcileFromConfig();
      }
    });

    console.log(`[ServiceWorker] Plugins initialized (${metas.length} discovered)`);
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize plugins:', error);
    // Non-fatal — plugins are optional
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
 * Get the most recently active session's agent.
 * Used by context menu and quick action which don't have a UI-selected sessionId.
 */
function getMostRecentAgent(): RepublicAgent | null {
  if (!registry) return null;
  const sessions = registry.listSessions() as Array<{ sessionId: string; state: string; lastActivityAt: number }>;
  const active = sessions
    .filter(s => s.state !== 'terminated')
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  if (active.length === 0) return null;
  const session = registry.getSession(active[0].sessionId);
  return session?.agent ?? null;
}

/**
 * Handle context menu clicks
 * Routes to most recently active session.
 */
async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  const targetAgent = getMostRecentAgent();
  if (!tab?.id || !targetAgent) return;

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

  // Submit to agent
  if (submission.op) {
    await targetAgent.submitOperation(submission.op);

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
  // ConfigStorage and CredentialStore are initialized early in doInitialize()
  // (before AgentConfig.getInstance()) so they're available when needed.

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

  const targetAgent = getMostRecentAgent();
  if (!targetAgent) return;

  // Submit quick analysis request
  await targetAgent.submitOperation({
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
      let channelMgr: ReturnType<typeof getChannelManager> | null = null;
      try {
        channelMgr = getChannelManager();
      } catch { /* channel not ready */ }

      for (const sessionMeta of registry.listSessions()) {
        const session = registry.getSession(sessionMeta.sessionId);
        if (session?.agent) {
          const event = await session.agent.getNextEvent();
          if (event && channelMgr) {
            await channelMgr.broadcastEvent({ msg: event.msg, sessionId: sessionMeta.sessionId });
          }
        }
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
  // Cleanup registry (which cleans up all sessions)
  if (registry) {
    await registry.cleanup();
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
export { registry, sessionStorage, initialize };
