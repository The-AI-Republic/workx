/**
 * Chrome extension background service worker
 * Central coordinator for the WorkX agent
 *
 * Feature 015: Multi-agent instances
 * - Replaced singleton agent with SessionManager
 * - Supports parallel session execution
 * - Session-aware message routing
 */

import { RepublicAgent } from '../../core/RepublicAgent';
import { UserNotifier } from '../../core/UserNotifier';
import { installTelemetry, schedulerTelemetryTap } from '../../core/telemetry';
import { RingSink } from '../telemetry/RingSink';
import { getConfigStorage } from '../../core/storage/ConfigStorageProvider';
import { AuthManager } from '../../core/models/types/Auth';
import { CacheManager } from '../../storage/CacheManager';
import { StorageQuotaManager } from '../../storage/StorageQuotaManager';
import type { TieredEvictor, EvictionTier } from '../../storage/StorageQuotaManager';
import { SessionCacheManager } from '../../storage/SessionCacheManager';
import { RolloutRecorder } from '../../storage/rollout';
import { IndexedDBRolloutStorageProvider } from '../../storage/rollout/provider/IndexedDBRolloutStorageProvider';
import { AgentConfig } from '../../config/AgentConfig';
import { normalizeAgentMode } from '../../prompts/PromptComposer';
import { STORAGE_KEYS } from '../../config/defaults';
import { DEFAULT_APPROVAL_CONFIG } from '../../core/approval/types';
import { LLM_API_URL } from '../../config/constants';
import { resolveRuntimeUrls } from '../../config/runtimeUrls';
import {
  getSessionAccessToken,
  refreshSessionAccessToken,
  peekSessionAccessToken,
} from '../auth/extensionSessionToken';
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

// Scheduler imports
import {
  Scheduler,
  ScheduleManager,
  JobExecutor,
  ScheduleEventStorage,
  ExecutionStorage,
} from '../../core/scheduler';
import { SchedulerAlarms } from './scheduler-alarms';
import { parseAlarmName } from '../../core/models/types/SchedulerContracts';

// Static imports required because dynamic import() is banned in Chrome
// extension service workers by the HTML specification.
// See: https://github.com/w3c/ServiceWorker/issues/1356
import { setConfigStorage } from '../../core/storage/ConfigStorageProvider';
import { getCredentialStore, setCredentialStore } from '../../core/storage/CredentialStore';
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
import { TaskOutputStore } from '../../core/tasks/TaskOutputStore';
import { TaskOutputManager } from '../../core/tasks/TaskOutputManager';
import { getChannelManager } from '../../core/channels/ChannelManager';
import { registerAllServices } from '../../core/services';
import { CompactService } from '../../core/compact/CompactService';
import type { ResponseItem } from '../../core/protocol/types';
import { SidePanelChannel } from '../../extension/channels/SidePanelChannel';
import { ChatGPTOAuthExtensionStorage } from '../auth/ChatGPTOAuthExtensionStorage';
import { ChatGPTOAuthService } from '../../core/auth/ChatGPTOAuthService';
import { createMutableAuthContext } from '../../core/auth/AuthContext';
import { createAppsRuntime } from '../../core/apps/createAppsRuntime';
import type { AppsAccessController } from '../../core/apps/AppsAccessController';
// Multi-agent registry imports (Feature 015)
import { SessionManager, SessionStorage } from '../../core/registry';
import { getTabGroupRegistry } from '../platform/TabGroupRegistry';
import type { SessionConfig } from '../../core/registry/types';
import { DEFAULT_MAX_CONCURRENT } from '../../core/registry/types';
import { PRIMARY_SESSION_ALIAS } from '../../core/models/types/SessionContracts';
import { t } from '../../webfront/lib/i18n';
import { getActionForExtensionCommand, type ShortcutAction } from '../../core/shortcuts';
// Desktop browser bridge (static: dynamic import() is banned in SW, and the
// keepalive alarm listener must be registered at module top level so the
// alarm can wake a slept service worker).
import { initializeBridge, getBridgeClient } from '../bridge/BridgeClient';
import { BRIDGE_KEEPALIVE_ALARM } from '../bridge/bridgeSettings';
// Static: the extension-default SessionManager path needs this adapter, and
// dynamic import() is banned in the service worker. Injected via
// RegistryConfig.platformAdapterFactory so shared core never imports it.
import { ExtensionPlatformAdapter } from '../platform/ExtensionPlatformAdapter';
import { ExtensionAgentAssembler } from '../agent/ExtensionAgentAssembler';
import { createSessionServices } from '../../core/session/state/SessionServices';
import {
  ThreadIndexStore,
  loadModelContextSnapshot,
  loadRolloutRevision,
  loadRolloutSnapshot,
  refreshRolloutSnapshot,
} from '../../core/thread';
import { SessionDeletionCoordinator } from '../../core/thread/SessionDeletionCoordinator';

// Desktop bridge keepalive: alarms fire even when the SW was terminated —
// Chrome starts the worker to deliver them. Top-level registration is the
// MV3 requirement for that wake path.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return;
  void getBridgeClient()
    .reconcile()
    .catch((err) => console.warn('[ServiceWorker] bridge keepalive reconcile failed:', err));
});

// Global instances
let registry: SessionManager | null = null;
let cacheManager: CacheManager | null = null;
let storageQuotaManager: StorageQuotaManager | null = null;
let sessionCacheManager: SessionCacheManager | null = null;
let taskOutputStore: TaskOutputStore | null = null;
let taskOutputManager: TaskOutputManager | null = null;
let agentConfig: AgentConfig | null = null;
let mcpManager: MCPManagerT | null = null; // MCP server connection manager
let appsAccess: AppsAccessController | null = null;
let a2aManager: A2AManagerT | null = null; // A2A agent connection manager
let currentAuthManager: AuthManager | null = null; // Bootstrap-owned current auth identity
const authContext = createMutableAuthContext(null);
const threadIndexStore = new ThreadIndexStore(new IndexedDBAdapter());
let scheduler: Scheduler | null = null; // Job scheduler
let schedulerAlarms: SchedulerAlarms | null = null;
let sessionStorage: SessionStorage | null = null; // Feature 015: Session persistence
let deletionCoordinator: SessionDeletionCoordinator | null = null;
let skillRegistry: SkillRegistry | null = null; // Agent skills
// Track 10: global plugin catalog; the assembler binds enabled hook/agent
// contributions into each isolated session graph.
let pluginRegistry: import('@/core/plugins/PluginRegistry').PluginRegistry | null = null;
// Track 10: IDB provider's virtual-path resolvers, for per-session binding.
let pluginFsResolvers: {
  readFile: (p: string) => Promise<string | null>;
  listDirs: (p: string) => Promise<string[]>;
} | null = null;
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;

function findTaskState(taskId: string): import('../../core/tasks/types').TaskState | undefined {
  if (!registry) return undefined;
  for (const meta of registry.listSessions()) {
    const agent = registry.getSession(meta.sessionId)?.agent;
    const state = agent?.getSession().getTask(taskId)?.taskState;
    if (state) return state;
  }
  return undefined;
}

function createExtensionTieredEvictor(): TieredEvictor {
  return {
    async evictTier(tier: EvictionTier, targetBytes: number): Promise<number> {
      if (targetBytes <= 0) return 0;
      if (tier === 0) {
        return taskOutputManager?.evictOldestChunks(targetBytes) ?? 0;
      }
      if (tier === 1) {
        return sessionCacheManager?.evictOldestCacheItems(targetBytes) ?? 0;
      }
      return 0;
    },
  };
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

  // Centralized telemetry: live privacy gate + bounded in-memory ring
  // (best-effort/ephemeral — MV3 SW eviction; no remote egress). No-op
  // unless telemetryEnabled (read live).
  installTelemetry({
    getTelemetryEnabled: () => agentConfig?.getConfig().preferences?.telemetryEnabled,
    sink: RingSink,
  });

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
      .catch((err) => console.warn('[ServiceWorker] policy reload failed:', err));
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

  // Feature 015: Initialize SessionManager instead of singleton agent
  // Load max concurrent sessions from user preferences
  const config = agentConfig!.getConfig();
  const maxConcurrentSessions = config.preferences?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT;
  registry = SessionManager.getInstance({
    maxConcurrent: maxConcurrentSessions,
    authContext,
    lifecycleMode: 'client',
    threadIndexStore,
    reconcileThreadIndex: () => reconcileThreadIndex(),
    loadRolloutSnapshot,
    loadModelContextSnapshot,
    loadRolloutRevision,
    refreshRolloutSnapshot,
    assemblyServicesFactory: async () =>
      createSessionServices(
        {
          sessionCache: sessionCacheManager ?? new SessionCacheManager(new IndexedDBAdapter()),
          commitGeneratedTitle: (sessionId, title) =>
            registry?.commitGeneratedTitle(sessionId, title) ?? Promise.resolve(false),
        },
        false
      ),
    agentAssembler: new ExtensionAgentAssembler({
      platformAdapterFactory: (sessionId) =>
        new ExtensionPlatformAdapter(sessionId, undefined, (tabId, reason) => {
          if (!registry) throw new Error('Session manager is not initialized');
          return registry.requestForeground(sessionId, tabId, reason);
        }),
      // Track 10: bind enabled plugins' hooks + sub-agent types to each new
      // session. Reads module-level pluginRegistry/resolvers lazily — they're
      // set by initializePlugins() before real sessions are created.
      bindAgent: async (agent, { subAgentRunner }) => {
        if (taskOutputStore) {
          agent.getSession().setTaskOutputStore(taskOutputStore);
        }
        if (skillRegistry && subAgentRunner) {
          skillRegistry.setValidationContextProvider(() => ({
            knownAgents: subAgentRunner.getTypes().map((t) => t.id),
          }));
        }
        await registerSkillsToolOnAgent(agent);
        if (!pluginRegistry || !pluginFsResolvers || !subAgentRunner) return;
        try {
          const { PluginSessionBinder } = await import('@/core/plugins/PluginSessionBinder');
          const binder = new PluginSessionBinder({
            hookRegistry: agent.getHookRegistry(),
            subAgentRunner,
            readFile: pluginFsResolvers.readFile,
            listDirs: pluginFsResolvers.listDirs,
          });
          const enabled = pluginRegistry.getPlugins().filter((p) => p.state.status === 'enabled');
          await binder.applyEnabledPlugins(enabled);
          const unregister = pluginRegistry.registerSessionBinder(binder);
          return {
            dispose: async () => {
              unregister();
              await binder.dispose();
            },
            applyManagerActions: async (actions) => {
              if (!actions.has('rebind-plugins')) return;
              await binder.applyEnabledPlugins(
                pluginRegistry!.getPlugins().filter((p) => p.state.status === 'enabled')
              );
            },
          };
        } catch (e) {
          console.warn('[ServiceWorker] plugin session bind failed (non-fatal):', e);
        }
      },
    }),
  });
  registry.initialize(agentConfig!);

  // Initialize IndexedDB storage adapter early — shared by session persistence and TokenUsageStore.
  // Created here so TokenUsageStore works even if session persistence fails.
  try {
    const storageAdapter = new IndexedDBAdapter();
    await storageAdapter.initialize();
    TokenUsageStore.setAdapter(storageAdapter);
    sessionCacheManager = new SessionCacheManager(storageAdapter);
    taskOutputStore = new TaskOutputStore(storageAdapter);
    taskOutputManager = new TaskOutputManager({
      adapter: storageAdapter,
      store: taskOutputStore,
      getTaskState: (taskId) => findTaskState(taskId),
    });

    // Feature 015 (T039): Initialize session persistence (uses same adapter)
    await initializeSessionPersistence(storageAdapter);
  } catch (error) {
    console.error('[ServiceWorker] Failed to initialize IndexedDB adapter:', error);
  }

  // Reuse the newest durable row after worker restart; create one index-only
  // thread only for an empty installation. The first submit hydrates it.
  const initialSessionId = await registry.resolveSurfaceLessTarget();
  console.log(`[ServiceWorker] Initial session opened: ${initialSessionId}`);

  // Initialize auth manager from stored config preferences
  // This ensures backend routing is set up correctly on service worker startup
  await initializeAuthFromConfig();

  // Desktop browser bridge: serve as the WorkX desktop app's live-browser
  // executor (mode:'node' connection to the local app-server). Runs BEFORE the
  // dynamic-import-based subsystems below: MV3 service workers reject dynamic
  // import() (TypeError: import() is disallowed on ServiceWorkerGlobalScope),
  // and an uncaught rejection from one of those blocks used to abort
  // initialize() before the bridge ever started. The bridge's module graph is
  // fully static, so it must not be held hostage by them.
  try {
    await initializeBridge();
  } catch (err) {
    console.warn('[ServiceWorker] Desktop bridge initialization failed (non-fatal):', err);
  }

  // Track 22: MCP gated behind the MCP compile-time flag. When OFF this
  // whole block is dead-code-eliminated and the dynamic import() chunk is
  // never emitted, so core/mcp leaves the extension bundle.
  // Non-fatal: the dynamic import() below throws in an MV3 service worker
  // (disallowed by spec); until MCP is refactored to static imports it must
  // not take down the rest of service-worker init.
  if (MCP) {
    try {
      // Initialize MCP manager
      const { MCPManager } = await import('../../core/mcp/MCPManager');
      mcpManager = await MCPManager.getInstance();

      // Subscribe to MCP events for tool registration/unregistration
      // (sync — handler attaches immediately, before any auto-connect)
      setupMCPToolRegistration();

      // Auto-connect enabled MCP servers (T064: service worker lifecycle handling)
      await autoConnectEnabledMCPServers();
    } catch (err) {
      console.warn('[ServiceWorker] MCP initialization failed (non-fatal):', err);
    }
  }

  // Setup message handlers
  setupMessageHandlers();

  // Track 22: A2A gated behind the A2A compile-time flag (same DCE rationale,
  // same non-fatal rationale as MCP above).
  if (A2A) {
    try {
      // Initialize A2A manager
      const { A2AManager } = await import('../../core/a2a/A2AManager');
      a2aManager = await A2AManager.getInstance();

      // Subscribe to A2A events for tool registration/unregistration
      // (sync — handler attaches immediately, before any auto-connect)
      setupA2AToolRegistration();

      // Auto-connect enabled A2A agents
      await autoConnectEnabledA2AAgents();
    } catch (err) {
      console.warn('[ServiceWorker] A2A initialization failed (non-fatal):', err);
    }
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
 * Build an AuthManager for the extension service worker.
 *
 * In account-credits mode (`shouldUseBackend`), route account LLM through the AI Hub
 * gateway ONLY when routing mode is 'gateway', a gateway URL is configured, AND a
 * session token is actually obtainable — reading the session JWT from the auth cookie
 * via chrome.cookies (SW-safe) as a per-request bearer token. Routing config comes
 * from resolveRuntimeUrls() (the single source of truth also used by memory routing),
 * not a parallel constants copy, so chat and memory can't diverge.
 *
 * Otherwise (own-key mode, gateway unconfigured, or no session token) we fall back to
 * the prior behavior exactly: a plain AuthManager with no token getter/refresher, so
 * legacy /api/llm requests authenticate via cookies with the dummy 'backend-routed'
 * bearer — never sending a real session JWT to the legacy endpoint.
 */
async function buildExtensionAuthManager(
  shouldUseBackend: boolean,
  backendBaseUrl: string | null
): Promise<AuthManager> {
  if (shouldUseBackend) {
    const urls = resolveRuntimeUrls();
    if (urls.llmRoutingMode === 'gateway' && urls.gatewayLlmApiUrl) {
      // Gate on token PRESENCE (cheap cookie read, no network refresh at init time) so
      // createGatewayRoutedClient never throws for a logged-out user; without one, fall
      // through to the legacy cookie path. An expired-but-present cookie still selects the
      // gateway — the per-request getter refreshes it lazily.
      const token = await peekSessionAccessToken();
      if (token) {
        return new AuthManager(shouldUseBackend, backendBaseUrl, getSessionAccessToken, {
          gatewayLlmBaseUrl: urls.gatewayLlmApiUrl,
          refreshAccessToken: refreshSessionAccessToken,
        });
      }
    }
  }
  // Own-key mode OR legacy fallback: preserve prior cookie-only behavior.
  return new AuthManager(shouldUseBackend, backendBaseUrl);
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
      backendBaseUrl,
    });

    const authManager = await buildExtensionAuthManager(shouldUseBackend, backendBaseUrl);
    currentAuthManager = authManager;
    authContext.update(authManager, 'routing');

    console.log('[ServiceWorker] Auth initialized, shouldUseBackend:', shouldUseBackend);

    // Check for ChatGPT OAuth tokens and configure token getter
    try {
      const oauthStorage = new ChatGPTOAuthExtensionStorage();
      const oauthService = new ChatGPTOAuthService(oauthStorage);

      if (await oauthService.isAuthenticated()) {
        authManager.setChatGPTOAuth(() => oauthService.getValidAccessToken());
        authContext.update(authManager, 'routing');
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

    await reconcileThreadIndex();
    deletionCoordinator = new SessionDeletionCoordinator({
      index: threadIndexStore,
      ensureNotLive: async (sessionId) => {
        if (registry?.getSession(sessionId)) await registry.suspendSession(sessionId);
      },
      deleteRollout: (sessionId) => RolloutRecorder.deleteSession(sessionId),
      deleteTokenUsage: (sessionId) => TokenUsageStore.getInstance().deleteSession(sessionId),
      deleteTaskOutput: (sessionId) =>
        taskOutputStore?.deleteSession(sessionId) ?? Promise.resolve(),
      clearSessionCache: (sessionId) =>
        sessionCacheManager?.clearSession(sessionId) ?? Promise.resolve(),
      // Tool results share SessionCacheManager storage in the extension, so
      // clearSessionCache above is the hard-delete API for those records too.
      deleteToolResults: () => Promise.resolve(),
      deleteLegacySession: (sessionId) =>
        sessionStorage?.deleteSession(sessionId) ?? Promise.resolve(),
      onPurged: (sessionId) => registry?.notifyThreadPurged(sessionId),
    });
    await deletionCoordinator.purgeDue();
    await registry.recoverInterruptedTurns();

    // Clean up orphaned sessions (older than 24 hours)
    await registry.cleanupOrphanedSessions(24 * 60 * 60 * 1000);

    // Load and resume persisted scheduled task sessions
    // Note: We only resume 'scheduled' type sessions, not 'primary' (which gets recreated)
    const persistedSessions = await registry.loadPersistedSessions();
    const scheduledSessions = persistedSessions.filter((s) => s.type === 'scheduled');

    if (scheduledSessions.length > 0) {
      console.log(
        `[ServiceWorker] Found ${scheduledSessions.length} persisted scheduled sessions to resume`
      );

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

async function reconcileThreadIndex(): Promise<void> {
  await threadIndexStore.backfill({
    rollouts: await (await RolloutRecorder.getProvider()).getAllMetadata(),
    persistedSessions: (await sessionStorage?.loadAllSessions()) ?? [],
    defaultMode: normalizeAgentMode('workx', agentConfig?.getConfig().preferences?.defaultMode),
  });
}

/**
 * Helper function to get agent for a message (Feature 015: session-aware routing)
 * @param message The incoming message with optional sessionId
 * @returns The agent to use for this message
 */
function getAgentForMessage(message: {
  payload?: { sessionId?: string; context?: { sessionId?: string } };
}): RepublicAgent | null {
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
          throw new Error('SessionManager not initialized');
        }

        if (op.type === 'UserInput') {
          throw new Error('UserInput must use the correlated session.submit service');
        }
        if (op.type === 'ServiceRequest') {
          throw new Error('ServiceRequest must use the service registry');
        }
        await registry.dispatchControl(context.sessionId, op, { tabId: context.tabId });
      });

      await channelManager.registerChannel(sidePanelChannel);
      // Note: event dispatchers are wired per-session in SessionManager.createSession()
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

    // Wire scheduler events to ChannelManager (unified dispatch) + telemetry
    // tap (scheduler is a separate emitter family bypassing the chokepoint)
    if (scheduler) {
      scheduler.connectToChannel(() => channelManager, 'sidepanel-main', schedulerTelemetryTap);
    }

    if (!registry) throw new Error('SessionManager not initialized');

    const appsUrls = resolveRuntimeUrls();
    const connectGatewayMcp = async () => {
      if (!mcpManager) return;
      const server = mcpManager.getServerByName(appsUrls.gatewayMcpName);
      if (server && mcpManager.getConnection(server.id)?.status !== 'connected') {
        await mcpManager.connect(server.id);
      }
    };
    const disconnectGatewayMcp = async () => {
      if (!mcpManager) return;
      const server = mcpManager.getServerByName(appsUrls.gatewayMcpName);
      if (server) await mcpManager.disconnect(server.id);
    };
    const appsRuntime = createAppsRuntime({
      urls: appsUrls,
      credentialStore: getCredentialStore(),
      getSessionToken: getSessionAccessToken,
      refreshSessionToken: refreshSessionAccessToken,
      reconnectMcp: async () => {
        await disconnectGatewayMcp();
        await connectGatewayMcp();
      },
      disconnectMcp: disconnectGatewayMcp,
      emitState: (state) =>
        channelManager.broadcastEvent({
          msg: {
            type: 'StateUpdate',
            data: { scope: 'apps-runtime', kind: 'apps.stateChanged', apps: state },
          },
        }),
    });
    appsAccess = appsRuntime.access;
    mcpManager?.setGatewayCredentialProvider(
      appsRuntime.getMcpCredential,
      appsRuntime.handleMcpUnauthorized
    );
    await appsAccess.initialize();

    const count = registerAllServices(serviceRegistry, {
      mcp: mcpManager ? { mcpManager } : undefined,
      scheduler: scheduler ? { scheduler } : undefined,
      // Stateless BYOK connection probe — runs the real provider call from the
      // service worker (no CORS), matching desktop/server behavior.
      models: {},
      // Credential store relay (parity with desktop/server). The side panel uses
      // ChromeCredentialStore directly, so these are unused in practice here, but
      // registering keeps the service surface uniform across platforms.
      credentials: {},
      apps: {
        access: appsRuntime.access,
        client: appsRuntime.client,
        authorizeContext: (context) =>
          context.channelType === 'sidepanel' && context.channelId === 'sidepanel-main',
      },
      diagnostics: {
        buildCtx: () => ({
          platformId: 'extension',
          channelManager: getChannelManager(),
          mcpManager: mcpManager ?? undefined,
          skillRegistry: skillRegistry ?? undefined,
          scheduler: scheduler ?? undefined,
          lifecycle: registry ?? undefined,
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
        loadRolloutHistory: async (sessionId: string) => {
          const initialHistory = await RolloutRecorder.getRolloutHistory(sessionId);
          if (initialHistory.type !== 'resumed' || !initialHistory.payload?.history) return null;
          return { sessionId, rolloutItems: initialHistory.payload.history };
        },
        // Track 15 (D9): summarize_up_to summarizer, sourced from the live
        // primary agent's existing ModelClientFactory (no client built here).
        summarizeForRewind: async (sessionId: string, items: ResponseItem[]) => {
          const agent = registry?.getSession(sessionId)?.agent;
          if (!agent) return undefined;
          try {
            const modelClient = await agent.getModelClientFactory().createClientForCurrentModel();
            const result = await new CompactService().compact(
              items,
              'manual',
              modelClient,
              0,
              undefined,
              { sessionId: agent.getSession().getSessionId() }
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
        getGlobalAccessState: async () => {
          const config = agentConfig ?? (await AgentConfig.getInstance());
          const selected = config.getConfig().selectedModelKey;
          const modelData = config.getModelByKey(selected);
          if (!modelData) {
            return {
              status: 'error' as const,
              mode: 'none' as const,
              ready: false,
              reason: `Selected model ${selected} not found`,
              updatedAt: Date.now(),
            };
          }
          const auth = authContext.current();
          if (auth?.shouldUseBackend()) {
            return {
              status: 'ready' as const,
              mode: 'login' as const,
              ready: true,
              provider: modelData.provider.name,
              model: modelData.model.name,
              updatedAt: Date.now(),
            };
          }
          const apiKey = await config.getProviderApiKey(modelData.provider.id);
          return {
            status: apiKey?.trim() ? ('ready' as const) : ('needs_api_key' as const),
            mode: 'api_key' as const,
            ready: Boolean(apiKey?.trim()),
            provider: modelData.provider.name,
            model: modelData.model.name,
            reason: apiKey?.trim()
              ? undefined
              : `No API key configured for ${modelData.provider.name}`,
            updatedAt: Date.now(),
          };
        },
        updateApprovalConfig: async (config: Record<string, unknown>) => {
          const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
          const storedConfig = (result[STORAGE_KEYS.CONFIG] || {}) as Record<string, any>;
          const existing = storedConfig.approval || { ...DEFAULT_APPROVAL_CONFIG };
          storedConfig.approval = { ...existing, ...config };
          await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: storedConfig });
        },
      },
      storage: { storageProvider: chromeStorageAdapter },
      memory: registry ? { registry } : undefined,
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
          throw new Error('SessionManager not initialized');
        }

        // Registry is the single config subscriber; keep live graphs and let
        // the exhaustive impact map rebuild only what changed.
        registry.initialize(agentConfig);

        // Notify UI via channel
        channelManager
          .dispatchEvent(
            {
              msg: {
                type: 'BackgroundEvent',
                data: { message: 'Agent reinitialized', level: 'info' },
              },
            },
            'sidepanel-main'
          )
          .catch(() => {});

        return { success: true, message: 'Configuration reloaded' };
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
      const authManager = await buildExtensionAuthManager(
        shouldUseBackend,
        shouldUseBackend ? (backendBaseUrl ?? null) : null
      );
      currentAuthManager = authManager;
      authContext.update(authManager, 'routing');

      return { success: true, isBackendRouting: shouldUseBackend };
    });

    console.log(
      `[ServiceWorker] Registered ${count} service handlers on ChannelManager (+ extension overrides)`
    );
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
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
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
    const scheduleManager = new ScheduleManager(
      scheduleEventStorage,
      executionStorage,
      schedulerAlarms
    );
    const jobExecutor = new JobExecutor(executionStorage);

    // Create scheduler with new constructor
    scheduler = new Scheduler(scheduleManager, jobExecutor, schedulerAlarms);

    // Feature 015: Connect scheduler to SessionManager for isolated session creation
    if (registry) {
      scheduler.setRegistry(registry);
      console.log('[ServiceWorker] Scheduler connected to SessionManager');
    }

    // Wire platform-specific callbacks for Chrome extension
    scheduler.setNotificationHandler(async (info) => {
      const inputPreview = info.input.length > 50 ? info.input.slice(0, 50) + '...' : info.input;
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
        message: t(
          `${missed.length} job(s) missed their scheduled time while the browser was closed.`
        ),
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
  // The built-in OpenHub server is connected only after Apps credential
  // validation installs its runtime-owned credential provider.
  const enabledServers = servers.filter(
    (s) => s.enabled && !(s.builtin && s.transport === 'streamable-http')
  );

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
      console.error(
        `[ServiceWorker] Failed to auto-connect MCP server ${server.name}: ${errorMsg}`
      );
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
    console.warn(
      '[ServiceWorker] Cannot setup MCP tool registration - manager or registry not ready'
    );
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
              try {
                await tr.unregister(toolName);
              } catch {
                /* ignore */
              }
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
              try {
                await tr.unregister(toolName);
              } catch {
                /* ignore */
              }
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
    console.warn(
      '[ServiceWorker] Cannot setup A2A tool registration - manager or registry not ready'
    );
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
              try {
                await tr.unregister(toolName);
              } catch {
                /* ignore */
              }
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
              try {
                await tr.unregister(toolName);
              } catch {
                /* ignore */
              }
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

    await registerSkillsToolOnExistingSessions();

    console.log('[ServiceWorker] Skills initialized');
  } catch (error) {
    console.warn('[ServiceWorker] Failed to initialize skills:', error);
    // Non-fatal — skills are optional
  }
}

async function registerSkillsToolOnAgent(agent: RepublicAgent): Promise<void> {
  if (!skillRegistry) return;
  const { SessionSkillView } = await import('@/core/skills/SessionSkillView');
  const view = new SessionSkillView(skillRegistry, async () => {
    const context = await agent.getPlatformAdapter().getCurrentPageContext?.();
    return context?.currentDomain ?? null;
  });
  agent.getPromptLoader().registerExtension('skills', () => view.buildSystemPrompt());
  const { registerUseSkillTool } = await import('@/core/skills/registerUseSkillTool');
  await registerUseSkillTool({
    toolRegistry: agent.getToolRegistry(),
    hookRegistry: agent.getHookRegistry(),
    skillRegistry,
    getTurnContext: () => agent.getSession().getTurnContext(),
    getCurrentDomain: async () => {
      const context = await agent.getPlatformAdapter().getCurrentPageContext?.();
      return context?.currentDomain ?? null;
    },
  });
}

async function registerSkillsToolOnExistingSessions(): Promise<void> {
  if (!registry) return;
  for (const meta of registry.listSessions()) {
    const agent = registry.getSession(meta.sessionId)?.agent;
    if (agent) {
      await registerSkillsToolOnAgent(agent);
    }
  }
}

/**
 * Track 10: initialize the global plugin system for the extension.
 *
 * Wires the globally-reachable slots — skills (the same SkillRegistry the
 * skills service uses) + MCP (the singleton MCPManager). Hooks + sub-agent
 * types are bound per session by ExtensionAgentAssembler; commands are global
 * storage. Plugins live in an IDB-virtualized store.
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
      // Hooks and agent types are applied by the assembler's session binder.
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
    void handleContextMenuClick(info, tab).catch((error) => {
      console.error('[ServiceWorker] Context-menu submission failed:', error);
    });
  });
}

/**
 * Setup context menus
 */
function setupContextMenus(): void {
  chrome.contextMenus.create({
    id: 'workx-explain',
    title: t('Explain with WorkX'),
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'workx-improve',
    title: t('Improve with WorkX'),
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'workx-extract',
    title: t('Extract data with WorkX'),
    contexts: ['page', 'frame'],
  });
}

/**
 * Handle keyboard commands
 */
function handleCommand(command: string): void {
  const action = getActionForExtensionCommand(command);
  if (!action) {
    console.warn('[ServiceWorker] Unknown keyboard command:', command);
    return;
  }

  handleShortcutAction(action);
}

/**
 * Handle shared shortcut actions from extension commands.
 */
function handleShortcutAction(action: ShortcutAction): void {
  switch (action) {
    case 'app:toggleWindow':
      chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      break;

    case 'app:quickAction':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          void executeQuickAction(tabs[0].id).catch((error) => {
            console.error('[ServiceWorker] Quick action failed:', error);
          });
        }
      });
      break;

    default:
      console.warn('[ServiceWorker] No extension shortcut handler for action:', action);
  }
}

async function submitSurfaceLessUserInput(
  tabId: number,
  items: Extract<import('../../core/protocol/types').Op, { type: 'UserInput' }>['items']
): Promise<string> {
  if (!registry) throw new Error('Session manager is not initialized');
  const groups = getTabGroupRegistry();
  const owner = await groups.ownerOf(tabId);
  let sessionId: string | null = null;
  if (owner) {
    try {
      await registry.getThread(owner);
      sessionId = owner;
    } catch {
      sessionId = null;
    }
  }
  sessionId ??= await registry.resolveSurfaceLessTarget();
  // claimExisting is idempotent for the same owner and rejects contention;
  // it never reassigns a lease owned by another conversation.
  await groups.claimExisting(sessionId, tabId, 'user');
  await groups.setCurrent(sessionId, tabId);
  const clientMessageId = crypto.randomUUID();
  const ack = await registry.enqueueSubmission({
    sessionId,
    clientMessageId,
    op: { type: 'UserInput', items },
    tabId,
  });
  if (ack.status === 'rejected') {
    throw new Error(`Global action was rejected: ${ack.reason}`);
  }
  return sessionId;
}

/**
 * Handle context menu clicks
 * Resolves its target from tab ownership/view leases/index ordering.
 */
async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  if (!tab?.id) return;
  let items: Extract<import('../../core/protocol/types').Op, { type: 'UserInput' }>['items'] = [];

  switch (info.menuItemId) {
    case 'workx-explain':
      if (info.selectionText) {
        items = [
          {
            type: 'text',
            text: t(`Explain this: ${info.selectionText}`),
          },
        ];
      }
      break;

    case 'workx-improve':
      if (info.selectionText) {
        items = [
          {
            type: 'text',
            text: t(`Improve this text: ${info.selectionText}`),
          },
        ];
      }
      break;

    case 'workx-extract':
      items = [
        {
          type: 'text',
          text: t(`Extract structured data from this page`),
        },
        {
          type: 'context',
          path: info.pageUrl,
        },
      ];
      break;
  }

  if (items.length > 0) {
    await submitSurfaceLessUserInput(tab.id, items);
    // Open side panel to show results
    chrome.sidePanel.open({ tabId: tab.id });
  }
}

/**
 * Execute tab command
 */
async function executeTabCommand(tabId: number, command: string, args?: any): Promise<any> {
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
    evictionPolicy: 'lru',
  });

  // Initialize storage quota manager
  storageQuotaManager = new StorageQuotaManager({
    cacheManager,
    tieredEvictor: createExtensionTieredEvictor(),
  });
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
 * The tab's existing lease owner wins; otherwise viewed/index ordering is used.
 */
async function executeQuickAction(tabId: number): Promise<void> {
  // Get current page context
  const tab = await chrome.tabs.get(tabId);

  await submitSurfaceLessUserInput(tabId, [
    {
      type: 'text',
      text: 'Analyze this page and provide key insights',
    },
    {
      type: 'context',
      path: tab.url,
    },
  ]);

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
            await deletionCoordinator?.purgeDue();
            break;
        }
      });
    } else {
      console.warn('chrome.alarms API not available, periodic cleanup disabled');
      // Fallback: Use setInterval for cleanup tasks if alarms API is not available
      setInterval(
        async () => {
          await performRolloutCleanup();
        },
        60 * 60 * 1000
      ); // Every hour

      setInterval(
        async () => {
          if (cacheManager) {
            await cacheManager.cleanup();
          }
        },
        30 * 60 * 1000
      ); // Every 30 minutes

      setInterval(
        async () => {
          if (storageQuotaManager) {
            const shouldCleanup = await storageQuotaManager.shouldCleanup();
            if (shouldCleanup) {
              await storageQuotaManager.cleanup(70);
            }
          }
        },
        10 * 60 * 1000
      ); // Every 10 minutes

      // Feature 015: Fallback session cleanup
      setInterval(
        async () => {
          await deletionCoordinator?.purgeDue();
        },
        2 * 60 * 60 * 1000
      ); // Every 2 hours
    }
  } catch (error) {
    console.error('Failed to setup Chrome alarms:', error);
    console.warn('Falling back to setInterval for periodic cleanup');

    // Fallback: Use setInterval for cleanup tasks if alarms API fails
    setInterval(
      async () => {
        await performRolloutCleanup();
      },
      60 * 60 * 1000
    ); // Every hour

    setInterval(
      async () => {
        if (cacheManager) {
          await cacheManager.cleanup();
        }
      },
      30 * 60 * 1000
    ); // Every 30 minutes

    setInterval(
      async () => {
        if (storageQuotaManager) {
          const shouldCleanup = await storageQuotaManager.shouldCleanup();
          if (shouldCleanup) {
            await storageQuotaManager.cleanup(70);
          }
        }
      },
      10 * 60 * 1000
    ); // Every 10 minutes

    // Feature 015: Fallback session cleanup (in catch block)
    setInterval(
      async () => {
        await deletionCoordinator?.purgeDue();
      },
      2 * 60 * 60 * 1000
    ); // Every 2 hours
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
  void getTabGroupRegistry()
    .gcStale()
    .catch(() => {});
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
      .catch((err) => {
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
      .catch((err) => {
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
