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
import { MessageRouter, MessageType } from '../../core/MessageRouter';
import { ApprovalGate } from '../../core/approval/ApprovalGate';
import { PolicyRulesEngine } from '../../core/approval/PolicyRulesEngine';
import { getDefaultRules } from '../../core/approval/defaultRules';
import { DomainSensitivityEnhancer } from '../../core/approval/enhancers/DomainSensitivityEnhancer';
import { SemanticElementEnhancer } from '../../core/approval/enhancers/SemanticElementEnhancer';
import { ApprovalConfigStorage } from '../../core/approval/ApprovalConfigStorage';
import { AuthManager } from '../../core/models/types/Auth';
import type { Submission } from '../../core/protocol/types';
import { validateSubmission } from '../../core/protocol/schemas';
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
import type {
  IMCPServerConfigCreate,
  IMCPServerConfigUpdate,
  MCPManagerEvent,
} from '../../core/mcp/types';
import { A2AManager } from '../../core/a2a/A2AManager';
import { registerA2ASkills, unregisterA2ASkills } from '../../core/a2a/A2AToolAdapter';
import type {
  IA2AAgentConfigCreate,
  IA2AAgentConfigUpdate,
  A2AManagerEvent,
} from '../../core/a2a/types';

// Skills imports
import { SkillRegistry } from '../../core/skills';
import { IndexedDBSkillProvider } from '../../extension/storage/IndexedDBSkillProvider';
import { IndexedDBStorageProvider } from '../../extension/storage/IndexedDBStorageProvider';
import type { Skill, InvocationMode } from '../../core/skills/types';
import { registerPromptExtension } from '../../core/PromptLoader';

// Scheduler imports
import { Scheduler, SchedulerStorage } from '../../core/scheduler';
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
import type {
  CreateDraftJobRequest,
  ScheduleJobRequest,
  TriggerJobRequest,
  CancelJobRequest,
  GetJobDetailsRequest,
  GetArchivedJobsRequest,
  RescheduleJobRequest,
  GetAllJobsInRangeRequest,
} from '../../core/models/types/SchedulerContracts';
import type { JobResultRecord } from '../../core/models/types/Scheduler';

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
let router: MessageRouter | null = null;
let cacheManager: CacheManager | null = null;
let storageQuotaManager: StorageQuotaManager | null = null;
let agentConfig: AgentConfig | null = null;
let mcpManager: MCPManager | null = null; // MCP server connection manager
let a2aManager: A2AManager | null = null; // A2A agent connection manager
let currentAuthManager: AuthManager | null = null; // Preserve auth state across agent recreation
let scheduler: Scheduler | null = null; // Job scheduler
let schedulerStorage: SchedulerStorage | null = null;
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

  // Extension mode uses chrome.storage.local for approval config
  const configStorage = new ApprovalConfigStorage(() => chrome.storage.local);
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

  // Create message router (must be created before agent)
  router = new MessageRouter('background');

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
  registry.initialize(agentConfig!, router);

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

  // Setup Vault message handlers (Feature 034: Credential Security)
  setupVaultMessageHandlers();

  // Setup MCP message handlers
  setupMCPMessageHandlers();

  // Initialize A2A manager
  a2aManager = await A2AManager.getInstance();

  // Subscribe to A2A events for tool registration/unregistration
  setupA2AToolRegistration();

  // Auto-connect enabled A2A agents
  await autoConnectEnabledA2AAgents();

  // Setup A2A message handlers
  setupA2AMessageHandlers();

  // Initialize Skills
  await initializeSkills();

  // Setup Skills message handlers
  setupSkillsMessageHandlers();

  // Initialize Scheduler
  await initializeScheduler();

  // Setup Scheduler message handlers
  setupSchedulerMessageHandlers();

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
function setupMessageHandlers(): void {
  if (!router || !registry) return;

  // Handle submissions from UI (Feature 015: session-aware routing)
  router.on(MessageType.SUBMISSION, async (message) => {
    const submission = message.payload as Submission & { sessionId?: string };

    if (!validateSubmission(submission)) {
      return;
    }

    // Feature 015: Route to correct agent based on sessionId
    const targetAgent = getAgentForMessage(message);
    if (!targetAgent) {
      throw new Error('No agent available for submission');
    }

    try {
      // Pass the submission context to the agent
      // The agent will handle tab binding/creation based on context.tabId
      const id = await targetAgent.submitOperation(submission.op, submission.context);

      return { submissionId: id };
    } catch (error) {
      throw error;
    }
  });

  // Handle state queries (Feature 015: session-aware routing)
  router.on(MessageType.GET_STATE, async (message) => {
    // Feature 015: Route to correct agent based on sessionId
    const targetAgent = getAgentForMessage(message);
    if (!targetAgent) return null;

    const session = targetAgent.getSession();

    // Get current tab ID from session (SessionState is the source of truth)
    const tabId = session.getTabId();

    // Get conversation history to sync UI with backend state
    const conversationHistory = session.getConversationHistory();

    return {
      sessionId: session.conversationId,
      isActiveTurn: session.isActiveTurn(), // Include active turn status
      tabId: tabId, // US3: Include current tab binding
      history: conversationHistory.items, // Include history for UI sync on sidepanel reopen
      // Feature 015: Include registry info
      activeSessionCount: registry?.getActiveCount() ?? 0,
      maxConcurrentSessions: registry?.getMaxConcurrent() ?? 3,
    };
  });

  // Handle ping/pong for connection testing
  router.on(MessageType.PING, async () => {
    return { type: MessageType.PONG, timestamp: Date.now() };
  });

  // Handle health check - validates agent is ready with API key
  router.on(MessageType.HEALTH_CHECK, async (message) => {
    // Feature 015: Route to correct agent based on sessionId
    const targetAgent = getAgentForMessage(message);
    if (!targetAgent) {
      return {
        type: MessageType.HEALTH_STATUS,
        ready: false,
        message: t('Agent not initialized'),
        timestamp: Date.now(),
      };
    }

    const status = await targetAgent.isReady();
    return {
      type: MessageType.HEALTH_STATUS,
      ...status,
      timestamp: Date.now(),
    };
  });

  // Handle session reset (Feature 015: session-aware routing)
  router.on(MessageType.SESSION_RESET, async (message) => {
    // Feature 015: Route to correct agent based on sessionId
    const targetAgent = getAgentForMessage(message);
    if (targetAgent) {
      // Get the current session
      const session = targetAgent.getSession();

      // Abort all running tasks before resetting
      await session.abortAllTasks('UserInterrupt');

      // Reset TabManager - close all browserx tab groups
      const tabManager = TabManager.getInstance();
      await tabManager.reset();

      // Reset the session (this will also reset tabId to -1 in session and turnContext)
      await session.reset();

      return { type: MessageType.SESSION_RESET_COMPLETE, timestamp: Date.now() };
    }
    throw new Error('Agent not initialized');
  });

  // Handle session resume from chat history
  router.on(MessageType.RESUME_SESSION, async (message) => {
    if (!agent) {
      throw new Error('Agent not initialized');
    }

    const { conversationId } = message.payload as { conversationId: string };
    console.log('[ServiceWorker] Resuming session:', conversationId);

    // Get current session and abort any running tasks
    const currentSession = agent.getSession();
    await currentSession.abortAllTasks('UserInterrupt');

    // Reset TabManager
    const tabManager = TabManager.getInstance();
    await tabManager.reset();

    // Close current session
    await currentSession.close();

    // Load history from rollout storage
    const initialHistory = await RolloutRecorder.getRolloutHistory(conversationId);

    if (initialHistory.type !== 'resumed' || !initialHistory.payload?.history) {
      throw new Error('Conversation not found or has no history');
    }

    // Recreate agent with resumed session
    agent = new RepublicAgent(agentConfig!, router!, {
      mode: 'resumed' as const,
      conversationId,
      rolloutItems: initialHistory.payload.history,
    }, undefined, new UserNotifier());

    // Set up event dispatcher for chrome extension mode
    agent.setEventDispatcher((event) => {
      chrome.runtime.sendMessage({
        type: 'EVENT',
        payload: event,
      }).catch(() => {});
    });

    // Restore auth manager before initialization
    if (currentAuthManager) {
      const factory = agent.getModelClientFactory();
      factory.setAuthManager(currentAuthManager);
    }

    await agent.initialize();
    await configureExtensionPlatform(agent);

    // Get the reconstructed history from the new session
    const session = agent.getSession();

    // Wait for session initialization to complete (history reconstruction is async)
    await session.initialize();

    const history = session.getConversationHistory();

    console.log('[ServiceWorker] Session resumed with', history.items.length, 'items');

    return {
      type: MessageType.RESUME_SESSION_COMPLETE,
      timestamp: Date.now(),
      conversationId,
      history: history.items,
    };
  });

  // Handle stop agent session (from visual effects Stop Agent button)
  // Feature 015: session-aware routing
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STOP_AGENT_SESSION') {
      (async () => {
        try {
          // Feature 015: Route to correct agent based on sessionId
          const targetAgent = getAgentForMessage(message);
          if (targetAgent) {
            const session = targetAgent.getSession();

            // Abort all running tasks
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

      return true; // Keep channel open for async response
    }

    // Feature 015: Handle max concurrent sessions update from settings
    if (message.type === 'SET_MAX_CONCURRENT_SESSIONS') {
      const { maxConcurrent } = message.payload || {};
      if (registry && typeof maxConcurrent === 'number') {
        registry.setMaxConcurrent(maxConcurrent);
        console.log(`[ServiceWorker] Max concurrent sessions updated to: ${maxConcurrent}`);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Invalid request or registry not initialized' });
      }
      return true;
    }

    // Handle approval config updates (UPDATE_APPROVAL_CONFIG)
    // Uses "double write" pattern: saves to storage AND updates ApprovalGate directly.
    // This avoids reliance on chrome.storage.onChanged which is not available in desktop mode.
    if (message.type === 'UPDATE_APPROVAL_CONFIG') {
      (async () => {
        try {
          const config = message.config;
          // 1. Save to storage (nested under agent_config.approval)
          const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
          const agentConfig = (result[STORAGE_KEYS.CONFIG] || {}) as Record<string, any>;
          const existing = agentConfig.approval || { ...DEFAULT_APPROVAL_CONFIG };
          const merged = { ...existing, ...config };
          agentConfig.approval = merged;
          await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: agentConfig });
          // 2. Update ApprovalGate directly
          const primaryAgent = registry?.getPrimarySession()?.agent ?? agent;
          if (primaryAgent) {
            const gate = primaryAgent.getToolRegistry().getApprovalGate();
            if (gate) {
              if (config.mode) gate.setMode(config.mode);
              if (config.trustedDomains) gate.setTrustedDomains(config.trustedDomains);
              if (config.blockedDomains) gate.setBlockedDomains(config.blockedDomains);
            }
          }
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      })();
      return true;
    }

    // Note: Approval decisions (EXEC_APPROVAL) are now handled through the unified
    // SUBMISSION pipeline. EventProcessor sends { type: 'SUBMISSION', payload: { op: { type: 'ExecApproval' } } }
    // which routes through MessageRouter → agent.submitOperation() → handleExecApproval()
    // on both extension and desktop platforms.
  });

  // Handle storage operations
  router.on(MessageType.STORAGE_GET, async (message) => {
    const { key } = message.payload;
    const result = await chrome.storage.local.get(key);
    return result[key];
  });

  router.on(MessageType.STORAGE_SET, async (message) => {
    const { key, value } = message.payload;
    await chrome.storage.local.set({ [key]: value });
    return { success: true };
  });

  // Handle tool execution messages (Feature 015: session-aware routing)
  router.on(MessageType.TOOL_EXECUTE, async (message) => {
    const targetAgent = getAgentForMessage(message);
    if (!targetAgent) throw new Error('Agent not initialized');

    const { toolName, args } = message.payload;
    const toolRegistry = targetAgent.getToolRegistry();
    const tool = toolRegistry.getTool(toolName);

    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // For now, just return a placeholder result
    return { success: true, message: `Tool ${toolName} executed` };
  });

  // Handle approval requests (Feature 015: session-aware routing)
  router.on(MessageType.APPROVAL_REQUEST, async (message) => {
    const targetAgent = getAgentForMessage(message);
    if (!targetAgent) throw new Error('Agent not initialized');

    const { approvalId, type, details } = message.payload;
    const approvalManager = targetAgent.getApprovalManager();

    // For now, just return a placeholder approval response
    return { approved: false, message: 'Approval system not fully integrated yet' };
  });

  // Handle configuration updates (Feature 015: registry-aware)
  router.on(MessageType.CONFIG_UPDATE, async () => {
    try {
      // Reload AgentConfig from storage
      if (agentConfig) {
        await agentConfig.reload();
      } else {
        // Initialize a new configuration singleton
        agentConfig = await AgentConfig.getInstance();
      }

      // Feature 015: Clean up all sessions and recreate primary
      if (registry) {
        await registry.cleanup();
        registry.initialize(agentConfig, router!);

        // Recreate primary session
        const primarySession = await registry.createSession({ type: 'primary' });
        agent = primarySession.agent;

        // Restore auth manager if preserved
        if (currentAuthManager && agent) {
          const factory = agent.getModelClientFactory();
          factory.setAuthManager(currentAuthManager);
          console.log('[ServiceWorker] Restored auth manager after CONFIG_UPDATE');
          await agent.refreshModelClient();
        } else if (!currentAuthManager) {
          await initializeAuthFromConfig();
        }
      } else {
        /**
         * @deprecated Legacy fallback for CONFIG_UPDATE - should rarely execute.
         * Feature 015: This path exists only for edge cases where registry
         * is not available. All normal operation goes through AgentRegistry.
         * TODO: Remove this fallback once Feature 015 is fully validated.
         */
        console.warn('[ServiceWorker] Using legacy agent recreation fallback - this path should be rare');
        if (agent) {
          const session = agent.getSession();
          await session.close();
          await agent.cleanup();
        }

        agent = new RepublicAgent(agentConfig, router!, undefined, undefined, new UserNotifier());

        // Set up event dispatcher for chrome extension mode
        agent.setEventDispatcher((event) => {
          chrome.runtime.sendMessage({
            type: 'EVENT',
            payload: event,
          }).catch(() => {});
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

      // Notify all clients (sidepanel, etc.) that agent was reinitialized
      chrome.runtime.sendMessage({
        type: MessageType.AGENT_REINITIALIZED,
        payload: {
          timestamp: Date.now()
        }
      }).catch(() => {
        // Ignore errors if no listeners (e.g., sidepanel not open)
      });

      return { success: true, message: 'Configuration reloaded and agent recreated' };
    } catch (error) {
      console.error('Failed to reload configuration:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Handle auth initialization from sidepanel
  router.on(MessageType.INIT_AUTH, async (message) => {
    const { backendBaseUrl, useOwnApiKey } = message.payload as {
      isLoggedIn?: boolean; // deprecated, kept for backwards compatibility
      backendBaseUrl: string | null;
      useOwnApiKey?: boolean;
    };

    // useOwnApiKey determines routing:
    // - false (or undefined) = use backend routing
    // - true = use direct API with user's own key
    const shouldUseBackend = useOwnApiKey === false;

    console.log('[ServiceWorker] Received INIT_AUTH:', { useOwnApiKey, shouldUseBackend, backendBaseUrl });

    // Create AuthManager based on useOwnApiKey setting
    const authManager = new AuthManager(shouldUseBackend, shouldUseBackend ? backendBaseUrl : null);

    // Preserve the auth manager for agent recreation (e.g., after CONFIG_UPDATE)
    currentAuthManager = authManager;

    // Feature 015: Update auth manager for all sessions via primary agent
    const primaryAgent = registry?.getPrimarySession()?.agent ?? agent;
    if (primaryAgent) {
      const factory = primaryAgent.getModelClientFactory();
      factory.setAuthManager(authManager);
      console.log('[ServiceWorker] Auth manager updated, isBackendRouting:', factory.isBackendRouting(), 'useOwnApiKey:', useOwnApiKey);

      // Refresh the model client to use the new auth routing
      await primaryAgent.refreshModelClient();
    }

    return { success: true, isBackendRouting: authManager.shouldUseBackend() };
  });

  // Handle diff events (Feature 015: session-aware routing)
  router.on(MessageType.DIFF_GENERATED, async (message) => {
    const targetAgent = getAgentForMessage(message);
    if (!targetAgent) throw new Error('Agent not initialized');

    // Broadcast diff to UI
    if (router) {
      await router.broadcast(MessageType.DIFF_GENERATED, message.payload);
    }
  });

  // Handle tab commands
  router.on(MessageType.TAB_COMMAND, async (message) => {
    const { command, args } = message.payload;
    const tabId = message.tabId;

    if (!tabId) {
      throw new Error('Tab ID required for tab command');
    }

    return executeTabCommand(tabId, command, args);
  });

  // NOTE: PageAction execution logic removed from here.
  // All PageAction tool execution now flows through:
  // TurnManager.executeBrowserTool() → ToolRegistry.execute() → PageActionTool.executeImpl()
  // See src/core/TurnManager.ts:774-822 for the execution entry point.
}

/**
 * Initialize Scheduler
 */
async function initializeScheduler(): Promise<void> {
  try {
    // Initialize storage adapter (IndexedDB on extension, SQLite on desktop/server)
    const storageAdapter = await createStorageAdapter();
    await storageAdapter.initialize();

    // Create scheduler components
    schedulerStorage = new SchedulerStorage(storageAdapter);
    schedulerAlarms = new SchedulerAlarms();
    scheduler = new Scheduler(schedulerStorage, schedulerAlarms);

    // Feature 015: Connect scheduler to AgentRegistry for isolated session creation
    if (registry) {
      scheduler.setRegistry(registry);
      console.log('[ServiceWorker] Scheduler connected to AgentRegistry');
    }

    // Wire platform-specific callbacks for Chrome extension
    scheduler.setNotificationHandler(async (job) => {
      const inputPreview = job.input.length > 50
        ? job.input.slice(0, 50) + '...'
        : job.input;
      await chrome.notifications.create(`scheduler-job-${job.id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Scheduled Job Starting',
        message: inputPreview,
        priority: 2,
        requireInteraction: false,
      });
    });

    scheduler.setJobLauncher(async (jobId, sessionId) => {
      const extensionUrl = chrome.runtime.getURL(
        `sidepanel/index.html?scheduledJob=${jobId}&sessionId=${sessionId}`
      );
      await chrome.tabs.create({ url: extensionUrl, active: true });
    });

    scheduler.setConnectivityCheck(() => navigator.onLine);

    // Set up event emitter to broadcast scheduler events to all clients (T020)
    scheduler.setEventEmitter((event) => {
      // Broadcast to all extension pages (sidepanel, popup, etc.)
      chrome.runtime.sendMessage({
        type: MessageType.SCHEDULER_EVENT,
        payload: event,
      }).catch(() => {
        // Ignore errors when no listeners (e.g., popup not open)
      });
    });

    // Start the job queue processor
    await schedulerAlarms.startJobQueueProcessor();

    // Detect missed jobs on startup
    const missedJobs = await scheduler.detectMissedJobs();
    if (missedJobs.length > 0) {
      console.log(`[ServiceWorker] Detected ${missedJobs.length} missed scheduler jobs`);
      // Show notification for missed jobs
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: t('Missed Scheduled Jobs'),
        message: t(`${missedJobs.length} job(s) missed their scheduled time while the browser was closed.`),
        priority: 2,
      });
    }

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
 * Setup Scheduler message handlers
 */
function setupSchedulerMessageHandlers(): void {
  if (!router || !scheduler) return;

  // Create draft job
  router.on(MessageType.SCHEDULER_CREATE_DRAFT_JOB, async (message) => {
    const { input } = message.payload as CreateDraftJobRequest;
    const jobId = await scheduler!.createDraftJob(input);
    return { success: true, jobId };
  });

  // Schedule a job
  router.on(MessageType.SCHEDULER_SCHEDULE_JOB, async (message) => {
    const { input, jobId, scheduledTime, recurrence } = message.payload as ScheduleJobRequest;

    if (jobId) {
      // Schedule existing draft
      await scheduler!.scheduleExistingJob(jobId, scheduledTime);
      return { success: true, jobId };
    } else if (input) {
      // Create new scheduled job
      const newJobId = await scheduler!.scheduleJob(input, scheduledTime, recurrence);
      return { success: true, jobId: newJobId };
    } else {
      return { success: false, error: 'Either input or jobId is required' };
    }
  });

  // Trigger a job manually
  router.on(MessageType.SCHEDULER_TRIGGER_JOB, async (message) => {
    const { jobId } = message.payload as TriggerJobRequest;
    await scheduler!.triggerJob(jobId);
    return { success: true };
  });

  // Cancel a job
  router.on(MessageType.SCHEDULER_CANCEL_JOB, async (message) => {
    const { jobId } = message.payload as CancelJobRequest;
    await scheduler!.cancelJob(jobId);
    return { success: true };
  });

  // Complete a job (called by executing tab)
  router.on(MessageType.SCHEDULER_COMPLETE_JOB, async (message) => {
    const { jobId, result } = message.payload as { jobId: string; result: JobResultRecord };
    await scheduler!.completeJob(jobId, result);
    return { success: true };
  });

  // Fail a job (called by executing tab)
  router.on(MessageType.SCHEDULER_FAIL_JOB, async (message) => {
    const { jobId, error } = message.payload as { jobId: string; error: string };
    await scheduler!.failJob(jobId, error);
    return { success: true };
  });

  // Pause job queue
  router.on(MessageType.SCHEDULER_PAUSE_QUEUE, async () => {
    await scheduler!.pauseJobQueue();
    return { success: true };
  });

  // Resume job queue
  router.on(MessageType.SCHEDULER_RESUME_QUEUE, async () => {
    await scheduler!.resumeJobQueue();
    return { success: true };
  });

  // Get draft jobs
  router.on(MessageType.SCHEDULER_GET_DRAFT_JOBS, async () => {
    const jobs = await schedulerStorage!.getDraftJobs();
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        input: j.input.slice(0, 100),
        scheduledTime: j.scheduledTime,
        status: j.status,
        createdAt: j.createdAt,
        recurrence: j.recurrence,
      })),
    };
  });

  // Get scheduled jobs
  router.on(MessageType.SCHEDULER_GET_SCHEDULED_JOBS, async () => {
    const jobs = await schedulerStorage!.getScheduledJobs();
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        input: j.input.slice(0, 100),
        scheduledTime: j.scheduledTime,
        status: j.status,
        createdAt: j.createdAt,
        recurrence: j.recurrence,
      })),
    };
  });

  // Get missed jobs
  router.on(MessageType.SCHEDULER_GET_MISSED_JOBS, async () => {
    const jobs = await schedulerStorage!.getMissedJobs();
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        input: j.input.slice(0, 100),
        scheduledTime: j.scheduledTime,
        status: j.status,
        createdAt: j.createdAt,
        recurrence: j.recurrence,
      })),
    };
  });

  // Get job queue
  router.on(MessageType.SCHEDULER_GET_QUEUE, async () => {
    const jobs = await schedulerStorage!.getJobQueueJobs();
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        input: j.input.slice(0, 100),
        scheduledTime: j.scheduledTime,
        status: j.status,
        createdAt: j.createdAt,
        recurrence: j.recurrence,
      })),
    };
  });

  // Get archived jobs
  router.on(MessageType.SCHEDULER_GET_ARCHIVED_JOBS, async (message) => {
    const { limit = 50, offset = 0, sortDirection, statusFilter } = (message.payload || {}) as GetArchivedJobsRequest;
    const jobs = await schedulerStorage!.getArchivedJobs(limit, offset, sortDirection, statusFilter);
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        input: j.input.slice(0, 100),
        scheduledTime: j.scheduledTime,
        completedAt: j.completedAt,
        status: j.status,
        sessionId: j.sessionId,
        error: j.error,
        recurrence: j.recurrence,
      })),
      total: jobs.length,
      hasMore: jobs.length === limit,
    };
  });

  // Get scheduler state
  router.on(MessageType.SCHEDULER_GET_STATE, async () => {
    return scheduler!.getSchedulerState();
  });

  // Get job details
  router.on(MessageType.SCHEDULER_GET_JOB_DETAILS, async (message) => {
    const { jobId } = message.payload as GetJobDetailsRequest;
    const job = await schedulerStorage!.getJob(jobId);
    return { job };
  });

  // Reschedule a job
  router.on(MessageType.SCHEDULER_RESCHEDULE_JOB, async (message) => {
    const { jobId, scheduledTime } = message.payload as RescheduleJobRequest;
    await scheduler!.rescheduleJob(jobId, scheduledTime);
    return { success: true };
  });

  // Get all jobs in a date range
  router.on(MessageType.SCHEDULER_GET_ALL_JOBS_IN_RANGE, async (message) => {
    const { startTime, endTime } = message.payload as GetAllJobsInRangeRequest;
    const jobs = await schedulerStorage!.getAllJobsInRange(startTime, endTime);
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        input: j.input.slice(0, 100),
        scheduledTime: j.scheduledTime,
        status: j.status,
        createdAt: j.createdAt,
        recurrence: j.recurrence,
      })),
    };
  });

  console.log('[ServiceWorker] Scheduler message handlers registered');

  // Feature 015: Session management message handlers (T048, T049)
  setupSessionMessageHandlers();
}

/**
 * Feature 034: Setup vault message handlers for credential security
 *
 * Handlers return raw data (MessageRouter adds the { success, data } envelope).
 * For errors, handlers throw (MessageRouter returns { success: false, error }).
 * Exception: VAULT_UNLOCK returns VaultUnlockResult directly (has its own success field
 * with structured error info like attemptsRemaining).
 */
function setupVaultMessageHandlers(): void {
  if (!router) return;

  // VAULT_STATUS: Get current vault state
  router.on(MessageType.VAULT_STATUS, async () => {
    return VaultManager.getStatus();
  });

  // VAULT_UNLOCK: Unlock vault with PIN
  // Returns VaultUnlockResult (always resolves — error info in the result object)
  router.on(MessageType.VAULT_UNLOCK, async (message) => {
    const { pin } = message.payload || {};
    if (!pin || typeof pin !== 'string') {
      throw new Error('PIN is required');
    }
    return await VaultManager.unlock(pin);
  });

  // VAULT_LOCK: Lock vault (clear session)
  router.on(MessageType.VAULT_LOCK, async () => {
    await VaultManager.lock();
  });

  // PIN_SET: Enable PIN protection
  router.on(MessageType.PIN_SET, async (message) => {
    const { pin, pinConfirm } = message.payload || {};
    if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      throw new Error('PIN must be exactly 6 digits');
    }
    if (pin !== pinConfirm) {
      throw new Error('PINs do not match');
    }
    await VaultManager.enablePin(pin);
  });

  // PIN_CHANGE: Change existing PIN (with lockout protection)
  router.on(MessageType.PIN_CHANGE, async (message) => {
    const { currentPin, newPin, newPinConfirm } = message.payload || {};
    if (!currentPin || typeof currentPin !== 'string') {
      throw new Error('Current PIN is required');
    }
    if (!newPin || !/^\d{6}$/.test(newPin)) {
      throw new Error('New PIN must be exactly 6 digits');
    }
    if (newPin !== newPinConfirm) {
      throw new Error('New PINs do not match');
    }
    // Use unlock() to verify current PIN with lockout protection,
    // then change the PIN. This prevents brute-force via PIN_CHANGE.
    const unlockResult = await VaultManager.unlock(currentPin);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error === 'locked_out'
        ? `Too many attempts. Try again in ${unlockResult.lockoutSecondsRemaining}s`
        : 'Current PIN is incorrect');
    }
    await VaultManager.changePin(currentPin, newPin);
  });

  // PIN_REMOVE: Remove PIN protection (with lockout protection)
  router.on(MessageType.PIN_REMOVE, async (message) => {
    const { pin } = message.payload || {};
    if (!pin || typeof pin !== 'string') {
      throw new Error('PIN is required');
    }
    // Use unlock() to verify PIN with lockout protection,
    // then remove the PIN. This prevents brute-force via PIN_REMOVE.
    const unlockResult = await VaultManager.unlock(pin);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error === 'locked_out'
        ? `Too many attempts. Try again in ${unlockResult.lockoutSecondsRemaining}s`
        : 'PIN is incorrect');
    }
    await VaultManager.removePin(pin);
  });

  // PIN_FORGOT: Reset vault (clear all credentials)
  router.on(MessageType.PIN_FORGOT, async (message) => {
    const { confirmReset } = message.payload || {};
    if (!confirmReset) {
      throw new Error('Confirmation required');
    }
    await VaultManager.reset();
  });

  console.log('[ServiceWorker] Vault message handlers registered');
}

/**
 * Feature 015 (T048, T049): Setup session management message handlers
 */
function setupSessionMessageHandlers(): void {
  if (!router || !registry) return;

  // T048: Get list of all sessions
  router.on(MessageType.SESSION_LIST, async () => {
    return {
      sessions: registry!.listSessions(),
      maxConcurrent: registry!.getMaxConcurrent(),
      activeCount: registry!.getActiveCount(),
    };
  });

  // T049: Get active session count
  router.on(MessageType.SESSION_GET_ACTIVE_COUNT, async () => {
    return {
      activeCount: registry!.getActiveCount(),
      maxConcurrent: registry!.getMaxConcurrent(),
      canCreateSession: registry!.canCreateSession(),
    };
  });

  console.log('[ServiceWorker] Session message handlers registered');
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

/**
 * Setup MCP server integration message handlers
 */
function setupMCPMessageHandlers(): void {
  if (!router || !mcpManager) return;

  // Get all MCP server configurations
  router.on(MessageType.MCP_GET_SERVERS, async () => {
    return mcpManager!.getServers();
  });

  // Add a new MCP server
  router.on(MessageType.MCP_ADD_SERVER, async (message) => {
    const config = message.payload as IMCPServerConfigCreate;
    return mcpManager!.addServer(config);
  });

  // Update an existing MCP server
  router.on(MessageType.MCP_UPDATE_SERVER, async (message) => {
    const { id, update } = message.payload as { id: string; update: IMCPServerConfigUpdate };
    return mcpManager!.updateServer(id, update);
  });

  // Remove an MCP server
  router.on(MessageType.MCP_REMOVE_SERVER, async (message) => {
    const { id } = message.payload as { id: string };
    await mcpManager!.removeServer(id);
    return { success: true };
  });

  // Connect to an MCP server
  router.on(MessageType.MCP_CONNECT, async (message) => {
    const { id } = message.payload as { id: string };
    await mcpManager!.connect(id);
    return { success: true };
  });

  // Disconnect from an MCP server
  router.on(MessageType.MCP_DISCONNECT, async (message) => {
    const { id } = message.payload as { id: string };
    await mcpManager!.disconnect(id);
    return { success: true };
  });

  // Get connection state for a specific server
  router.on(MessageType.MCP_GET_CONNECTION, async (message) => {
    const { id } = message.payload as { id: string };
    return mcpManager!.getConnection(id);
  });

  // Get all connections
  router.on(MessageType.MCP_GET_CONNECTIONS, async () => {
    return mcpManager!.getConnections();
  });

  // Get all available tools from all connected servers
  router.on(MessageType.MCP_GET_ALL_TOOLS, async () => {
    return mcpManager!.getAllTools();
  });

  // Execute an MCP tool
  router.on(MessageType.MCP_EXECUTE_TOOL, async (message) => {
    const { prefixedName, args } = message.payload as {
      prefixedName: string;
      args: Record<string, unknown>;
    };
    return mcpManager!.executeTool(prefixedName, args);
  });

  // Get all available resources from all connected servers
  router.on(MessageType.MCP_GET_ALL_RESOURCES, async () => {
    return mcpManager!.getAllResources();
  });

  // Read a resource from a server
  router.on(MessageType.MCP_READ_RESOURCE, async (message) => {
    const { serverName, uri } = message.payload as { serverName: string; uri: string };
    return mcpManager!.readResource(serverName, uri);
  });

  console.log('[ServiceWorker] MCP message handlers registered');
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

/**
 * Setup A2A agent integration message handlers
 */
function setupA2AMessageHandlers(): void {
  if (!router || !a2aManager) return;

  // Get all A2A agent configurations
  router.on(MessageType.A2A_GET_AGENTS, async () => {
    return a2aManager!.getAgents();
  });

  // Add a new A2A agent
  router.on(MessageType.A2A_ADD_AGENT, async (message) => {
    const config = message.payload as IA2AAgentConfigCreate;
    return a2aManager!.addAgent(config);
  });

  // Update an existing A2A agent
  router.on(MessageType.A2A_UPDATE_AGENT, async (message) => {
    const { id, update } = message.payload as { id: string; update: IA2AAgentConfigUpdate };
    return a2aManager!.updateAgent(id, update);
  });

  // Remove an A2A agent
  router.on(MessageType.A2A_REMOVE_AGENT, async (message) => {
    const { id } = message.payload as { id: string };
    await a2aManager!.removeAgent(id);
    return { success: true };
  });

  // Connect to an A2A agent
  router.on(MessageType.A2A_CONNECT, async (message) => {
    const { id } = message.payload as { id: string };
    await a2aManager!.connect(id);
    return { success: true };
  });

  // Disconnect from an A2A agent
  router.on(MessageType.A2A_DISCONNECT, async (message) => {
    const { id } = message.payload as { id: string };
    await a2aManager!.disconnect(id);
    return { success: true };
  });

  // Get connection state for a specific agent
  router.on(MessageType.A2A_GET_CONNECTION, async (message) => {
    const { id } = message.payload as { id: string };
    return a2aManager!.getConnection(id);
  });

  // Get all connections
  router.on(MessageType.A2A_GET_CONNECTIONS, async () => {
    return a2aManager!.getConnections();
  });

  // Get all available skills from all connected agents
  router.on(MessageType.A2A_GET_ALL_SKILLS, async () => {
    return a2aManager!.getAllSkills();
  });

  // Execute an A2A skill
  router.on(MessageType.A2A_EXECUTE_SKILL, async (message) => {
    const { prefixedName, args } = message.payload as {
      prefixedName: string;
      args: Record<string, unknown>;
    };
    return a2aManager!.executeSkill(prefixedName, args);
  });

  // Cancel an A2A task
  router.on(MessageType.A2A_CANCEL_TASK, async (message) => {
    const { agentName, taskId } = message.payload as { agentName: string; taskId: string };
    await a2aManager!.cancelTask(agentName, taskId);
    return { success: true };
  });

  console.log('[ServiceWorker] A2A message handlers registered');
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
 * Setup Skills message handlers
 */
function setupSkillsMessageHandlers(): void {
  if (!router || !skillRegistry) return;

  // List all skill metadata
  router.on(MessageType.SKILLS_LIST, async () => {
    return skillRegistry!.getSkillMetas();
  });

  // Load full skill content (with optional argument substitution)
  router.on(MessageType.SKILLS_LOAD, async (message) => {
    const { name, args } = message.payload as { name: string; args?: string };
    return skillRegistry!.invoke(name, args ? args.split(/\s+/) : []);
  });

  // Save a skill (create or update)
  router.on(MessageType.SKILLS_SAVE, async (message) => {
    const skill = message.payload as Skill;
    await skillRegistry!.save(skill);
    return { success: true };
  });

  // Delete a skill
  router.on(MessageType.SKILLS_DELETE, async (message) => {
    const { name } = message.payload as { name: string };
    await skillRegistry!.delete(name);
    return { success: true };
  });

  // Update invocation mode
  router.on(MessageType.SKILLS_UPDATE_MODE, async (message) => {
    const { name, mode } = message.payload as { name: string; mode: InvocationMode };
    await skillRegistry!.updateInvocationMode(name, mode);
    return { success: true };
  });

  // Import skill from URL
  router.on(MessageType.SKILLS_IMPORT, async (message) => {
    const { url } = message.payload as { url: string };

    // Validate URL scheme at the platform boundary
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only HTTP/HTTPS URLs are supported for skill import');
    }

    // Fetch is a transport concern — handled here, not in core SkillRegistry
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch skill from ${url}: ${response.statusText}`);
    }
    const content = await response.text();

    const skill = await skillRegistry!.importFromContent(content, url);
    return { success: true, skill };
  });

  // Export skill as SKILL.md
  router.on(MessageType.SKILLS_EXPORT, async (message) => {
    const { name } = message.payload as { name: string };
    const content = await skillRegistry!.export(name);
    return { success: true, content };
  });

  // Trust an imported skill
  router.on(MessageType.SKILLS_TRUST, async (message) => {
    const { name } = message.payload as { name: string };
    await skillRegistry!.trustSkill(name);
    return { success: true };
  });

  console.log('[ServiceWorker] Skills message handlers registered');
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
    if (!router) return;

    // Feature 015: Process events from all sessions
    if (registry) {
      for (const sessionMeta of registry.listSessions()) {
        const session = registry.getSession(sessionMeta.sessionId);
        if (session?.agent) {
          const event = await session.agent.getNextEvent();
          if (event) {
            await router.broadcast(MessageType.EVENT, event);
          }
        }
      }
    } else if (agent) {
      // Legacy fallback
      const event = await agent.getNextEvent();
      if (event) {
        await router.broadcast(MessageType.EVENT, event);
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

  if (router) {
    router.cleanup();
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
  // Don't return true - let MessageRouter handle the response
  return false;
});

// Initialize on script load
initialize();

// Export for testing (Feature 015: include registry and sessionStorage)
export { agent, router, registry, sessionStorage, initialize };
