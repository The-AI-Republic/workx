/**
 * Desktop Agent Bootstrap
 *
 * Initializes and wires up the RepublicAgent with the channel system for desktop mode.
 * In desktop mode, the agent runs directly in the WebView (same process as UI).
 *
 * Flow:
 * 1. Create ChannelManager (routes submissions to agent, events to channels)
 * 2. Create TauriChannel (receives submissions from UI, sends events to UI)
 * 3. Create RepublicAgent (processes submissions, emits events)
 * 4. Wire them together
 *
 * @module desktop/agent/DesktopAgentBootstrap
 */

import { TauriChannel } from '../channels/TauriChannel';
import { DesktopMessageRouter } from '../channels/DesktopMessageRouter';
import { getChannelManager, type AgentHandler } from '@/core/channels/ChannelManager';
import { RepublicAgent } from '@/core/RepublicAgent';
import { UserNotifier } from '@/core/UserNotifier';
import { MessageType } from '@/core/MessageRouter';
import { ApprovalGate } from '@/core/approval/ApprovalGate';
import { PolicyRulesEngine } from '@/core/approval/PolicyRulesEngine';
import { getDefaultRules } from '@/core/approval/defaultRules';
import { DomainSensitivityEnhancer } from '@/core/approval/enhancers/DomainSensitivityEnhancer';
import { SensitivePathEnhancer } from '@/core/approval/enhancers/SensitivePathEnhancer';
import { ApprovalConfigStorage } from '@/core/approval/ApprovalConfigStorage';
import { AgentConfig } from '@/config/AgentConfig';
import { configurePromptComposer, registerPromptExtension } from '@/core/PromptLoader';
import type { RuntimeContext } from '@/prompts/PromptComposer';
import { SkillRegistry } from '@/core/skills/SkillRegistry';
import { FilesystemSkillProvider } from '../storage/FilesystemSkillProvider';
import { AuthManager } from '@/core/models/types/Auth';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';
import { t } from '@/webfront/lib/i18n';
import { StaticRiskAssessor } from '@/core/approval/assessors/StaticRiskAssessor';
import { Scheduler } from '@/core/scheduler/Scheduler';
import { DesktopSchedulerAlarms } from '../scheduler/DesktopSchedulerAlarms';
import { DesktopSchedulerDeepLinkHandler } from '../scheduler/DesktopSchedulerDeepLinkHandler';
import { AgentRegistry } from '@/core/registry/AgentRegistry';

/**
 * Singleton instance
 */
let _instance: DesktopAgentBootstrap | null = null;

/**
 * Desktop Agent Bootstrap
 *
 * Manages the lifecycle of the agent and channel system in desktop mode.
 */
export class DesktopAgentBootstrap {
  private agent: RepublicAgent | null = null;
  private channel: TauriChannel | null = null;
  private messageRouter: DesktopMessageRouter | null = null;
  private skillRegistry: SkillRegistry | null = null;
  private scheduler: Scheduler | null = null;
  private schedulerAlarms: DesktopSchedulerAlarms | null = null;
  private schedulerDeepLinkHandler: DesktopSchedulerDeepLinkHandler | null = null;
  private runningSchedulerJobId: string | null = null;
  private runningJobStartTime: number = 0;
  private initialized = false;
  private isUpdatingConfig = false;

  /**
   * Initialize the desktop agent system
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('[DesktopAgentBootstrap] Already initialized');
      return;
    }

    console.log('[DesktopAgentBootstrap] Initializing...');

    try {
      // 1. Create the message router for RepublicAgent
      this.messageRouter = new DesktopMessageRouter('background');

      // 2. Get agent config
      const config = await AgentConfig.getInstance();

      // 3. Create RepublicAgent
      // RepublicAgent expects a MessageRouter with updateState method
      // DesktopMessageRouter provides this compatibility
      this.agent = new RepublicAgent(config, this.messageRouter as any, undefined, undefined, new UserNotifier());

      // 4. Configure PromptComposer with platform context BEFORE agent.initialize()
      // This must happen first so RepublicAgent.configurePromptComposition() sees
      // the composer is already configured and skips re-configuration.
      await this.configurePromptWithPlatformInfo();

      // 5. Create TauriChannel and wire up event forwarding BEFORE agent.initialize()
      // agent.initialize() may emit warning events (e.g. "No API key configured"),
      // so the event dispatcher must be set first to avoid losing those events.
      this.channel = new TauriChannel();

      const channelManager = getChannelManager();

      // Set up the agent handler on ChannelManager
      // This routes submissions from channels to the agent
      const agentHandler: AgentHandler = async (op: Op, context: SubmissionContext) => {
        if (!this.agent) {
          throw new Error(t('Agent not initialized'));
        }

        console.log('[DesktopAgentBootstrap] Processing submission:', op.type);

        // Submit the operation to the agent
        await this.agent.submitOperation(op, { tabId: context.tabId });
      };

      channelManager.setAgentHandler(agentHandler);

      // Register the TauriChannel with ChannelManager
      await channelManager.registerChannel(this.channel);
      console.log('[DesktopAgentBootstrap] Channel registered');

      // Wire up agent events to be dispatched through the channel
      this.setupEventForwarding(channelManager);

      // 5b. Initialize StorageProvider before agent — PlanningTool requires it
      // via getTaskStore() during tool registration in agent.initialize().
      // Uses SQLiteStorageProvider via the factory (routes through Tauri Rust commands).
      const { isStorageProviderInitialized, initializeStorageProvider } = await import('@/core/storage');
      if (!isStorageProviderInitialized()) {
        try {
          await initializeStorageProvider();
          console.log('[DesktopAgentBootstrap] StorageProvider initialized (SQLite)');
        } catch (error) {
          console.error('[DesktopAgentBootstrap] Failed to initialize StorageProvider:', error);
          console.error('[DesktopAgentBootstrap] PlanningTool will be unavailable this session');
        }
      }

      // 6. Initialize the agent (loads model client, tools, etc.)
      // Event dispatcher is already set, so any warning events reach the channel.
      await this.agent.initialize();
      console.log('[DesktopAgentBootstrap] Agent initialized');

      // 6a. Configure desktop-specific approval gate
      await this.configureDesktopPlatform();

      // 6b. Initialize skills (filesystem-backed, prompt extension)
      await this.initializeSkills();

      // 7. Restore auth mode from keychain and listen for changes
      // Same business logic as extension: logged in → backend routing, not logged in → api_key
      const { getDesktopAuthService } = await import('../auth/DesktopAuthService');
      const { HOME_PAGE_BASE_URL } = await import('@/webfront/lib/constants');
      const authService = getDesktopAuthService(HOME_PAGE_BASE_URL);

      // Listen for auth changes (implicit login via deep link)
      // This allows the agent to switch to backend routing automatically when user logs in
      authService.onAuthChange(async () => {
        console.log('[DesktopAgentBootstrap] Auth state changed, reloading auth mode...');
        await this.restoreAuthFromKeychain(config);

        // Also notify the UI that auth has changed so it re-runs health check
        if (this.messageRouter) {
          this.messageRouter.send(MessageType.AGENT_REINITIALIZED);
        }
      });

      await this.restoreAuthFromKeychain(config);

      // 8. Set up MCP tool registration events
      await this.setupMCPToolRegistration();

      // 9. Initialize scheduler
      await this.initializeScheduler();

      this.initialized = true;
      console.log('[DesktopAgentBootstrap] Initialization complete');
    } catch (error) {
      console.error('[DesktopAgentBootstrap] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Configure desktop-specific approval gate, MCP tools, and tab closure handler.
   */
  private async configureDesktopPlatform(): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');

    const approvalManager = this.agent.getApprovalManager();
    const toolRegistry = this.agent.getToolRegistry();

    // Approval gate with desktop-specific enhancers
    const policyEngine = new PolicyRulesEngine(getDefaultRules('desktop'));
    const approvalGate = new ApprovalGate(approvalManager, policyEngine);
    approvalGate.addEnhancer(new DomainSensitivityEnhancer());
    approvalGate.addEnhancer(new SensitivePathEnhancer());

    // Desktop mode uses TauriConfigStorage for approval config
    const { TauriConfigStorage } = await import('@/desktop/storage/TauriConfigStorage');
    const tauriStorage = new TauriConfigStorage();
    const configStorage = new ApprovalConfigStorage(() => ({
      get: (keys: string[]) => tauriStorage.getMany(keys),
      set: (items: Record<string, unknown>) => tauriStorage.setMany(items),
    }));
    approvalGate.setConfigStorage(configStorage);

    try {
      const storedConfig = await configStorage.loadConfig();
      approvalGate.setMode(storedConfig.mode);
      approvalGate.setTrustedDomains(storedConfig.trustedDomains || []);
      approvalGate.setBlockedDomains(storedConfig.blockedDomains || []);
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Failed to load approval config, using defaults:', error);
    }

    toolRegistry.setApprovalGate(approvalGate);

    // Desktop mode: browser tools come from MCP — enable mcpTools
    const agentConfig = await AgentConfig.getInstance();
    agentConfig.updateToolsConfig({ mcpTools: true });
  }

  /**
   * Set up event forwarding from agent to channel
   *
   * Uses RepublicAgent's setEventDispatcher to route events through
   * ChannelManager instead of chrome.runtime.sendMessage.
   */
  private setupEventForwarding(channelManager: ReturnType<typeof getChannelManager>): void {
    if (!this.agent || !this.channel) {
      console.warn('[DesktopAgentBootstrap] Cannot setup event forwarding: agent or channel not initialized');
      return;
    }

    // Set the event dispatcher on RepublicAgent
    // Events will be routed through ChannelManager to TauriChannel
    this.agent.setEventDispatcher((event) => {
      // Dispatch event to the Tauri channel
      channelManager.dispatchEvent(event.msg, this.channel!.channelId).catch((error) => {
        console.error('[DesktopAgentBootstrap] Failed to dispatch event:', error);
      });

      // Intercept completion events for scheduler
      this.handleSchedulerEventCompletion(event.msg);
    });

    console.log('[DesktopAgentBootstrap] Event forwarding configured via ChannelManager');
  }

  /**
   * Set up MCP tool registration events for desktop.
   * Subscribes to MCPManager 'tools-updated' events so tools are
   * auto-registered/unregistered when MCP servers connect/disconnect.
   */
  private async setupMCPToolRegistration(): Promise<void> {
    if (!this.agent) {
      return;
    }

    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const { registerMCPTools, unregisterMCPTools } = await import('@/core/mcp/MCPToolAdapter');
      const mcpManager = await MCPManager.getInstance('desktop');
      const registry = this.agent.getToolRegistry();

      // Track registered tools per server so we can unregister them on disconnect.
      // MCPManager clears connection.tools before emitting the event, so we
      // can't read them from the connection at unregister time.
      const registeredToolsByServer = new Map<string, import('@/core/mcp/types').IMCPTool[]>();

      mcpManager.on('event', (event) => {
        if (event.type !== 'tools-updated') return;

        const config = mcpManager.getServer(event.configId);
        if (!config) return;

        // Unregister previously registered tools first (handles both disconnect and reconnect)
        const previousTools = registeredToolsByServer.get(event.configId);
        if (previousTools && previousTools.length > 0) {
          unregisterMCPTools(config.name, previousTools, registry).catch((error) => {
            console.error('[DesktopAgentBootstrap] Failed to unregister MCP tools:', error);
          });
          registeredToolsByServer.delete(event.configId);
        }

        if (event.tools.length > 0) {
          // Tools discovered — register them and track for later unregistration
          registerMCPTools(mcpManager, config.name, event.tools, registry).catch((error) => {
            console.error('[DesktopAgentBootstrap] Failed to register MCP tools:', error);
          });
          registeredToolsByServer.set(event.configId, event.tools);
        }
      });
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not set up MCP tool registration:', error);
    }
  }

  /**
   * Initialize the skill registry with filesystem-backed provider.
   * Discovers existing skills and registers a prompt extension for auto-invocable skills.
   */
  private async initializeSkills(): Promise<void> {
    try {
      const provider = new FilesystemSkillProvider();
      await provider.initialize();

      this.skillRegistry = new SkillRegistry(provider);
      await this.skillRegistry.discover();

      registerPromptExtension(() => this.skillRegistry!.buildSkillsSystemPrompt());

      // Register use_skill tool if there are any skills
      const allSkills = this.skillRegistry.getSkillMetas();
      if (allSkills.length > 0 && this.agent) {
        const registry = this.agent.getToolRegistry();

        await registry.register(
          {
            type: 'function',
            function: {
              name: 'use_skill',
              description: 'Invoke a user-defined skill by name. When the user types /skill-name, call this tool with that name. Also use proactively when an auto-invocable skill is relevant. Returns the skill body with instructions to follow.',
              strict: false,
              parameters: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'The skill name to invoke' },
                  arguments: { type: 'string', description: 'Optional space-separated arguments for the skill' },
                },
                required: ['name'],
              },
            },
          },
          async (params) => {
            const skillName = params.name as string;
            const args = params.arguments as string | undefined;

            const knownNames = new Set(this.skillRegistry!.getSkillMetas().map((s) => s.name));
            if (!knownNames.has(skillName)) {
              return { error: `Skill "${skillName}" not found. Available skills: ${[...knownNames].join(', ')}` };
            }

            const body = await this.skillRegistry!.invoke(skillName, args ? args.split(/\s+/) : []);
            if (!body) {
              return { error: `Failed to load skill "${skillName}"` };
            }

            return body;
          },
          new StaticRiskAssessor(0)
        );

        console.log('[DesktopAgentBootstrap] use_skill tool registered for', allSkills.length, 'skills');
      }

      console.log('[DesktopAgentBootstrap] Skills initialized, found', this.skillRegistry.getSkillMetas().length, 'skills');
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not initialize skills:', error);
    }
  }

  /**
   * Initialize the scheduler for desktop mode.
   * Uses platform-aware StorageAdapter + hybrid DesktopSchedulerAlarms.
   */
  private async initializeScheduler(): Promise<void> {
    try {
      // Use platform-aware StorageAdapter factory (IndexedDB/SQLite/Node depending on build)
      const { createStorageAdapter } = await import('@/storage/createStorageAdapter');
      const { SchedulerStorage } = await import('@/core/scheduler/SchedulerStorage');

      const storageAdapter = await createStorageAdapter();
      await storageAdapter.initialize();

      const schedulerStorage = new SchedulerStorage(storageAdapter);

      // Create hybrid alarms (in-process timers + OS-level jobs)
      this.schedulerAlarms = new DesktopSchedulerAlarms();

      // Create scheduler
      this.scheduler = new Scheduler(schedulerStorage, this.schedulerAlarms);

      // Wire alarm handler
      this.schedulerAlarms.setAlarmHandler(async (alarmName) => {
        await this.scheduler!.handleAlarm(alarmName);
      });

      // Wire event emitter → dispatch via pi:message so TauriMessageService
      // routes it to SCHEDULER_EVENT handlers in the UI (Main.svelte)
      this.scheduler.setEventEmitter(async (event) => {
        try {
          const { emit } = await import('@tauri-apps/api/event');
          await emit('pi:message', {
            type: MessageType.SCHEDULER_EVENT,
            payload: event,
          });
        } catch (error) {
          console.error('[DesktopAgentBootstrap] Failed to emit scheduler event:', error);
        }
      });

      // Wire job launcher — show window and submit directly to agent
      // `registryAgent` is the isolated agent created by AgentRegistry for this job's session.
      // Falls back to the primary agent when registry is not available.
      this.scheduler.setJobLauncher(async (jobId, sessionId, registryAgent) => {
        this.runningSchedulerJobId = jobId;
        this.runningJobStartTime = Date.now();
        console.log(`[DesktopAgentBootstrap] Scheduled job ${jobId} launched (session: ${sessionId})`);
        // Show the main window
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        } catch {
          // Non-fatal — window may already be visible
        }
        // Submit to registry agent (isolated session) or fallback to primary agent
        const job = await schedulerStorage.getJob(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);
        const targetAgent = registryAgent ?? this.agent;
        if (!targetAgent) throw new Error('Agent not initialized');
        await targetAgent.submitOperation(
          { type: 'UserInput', items: [{ type: 'text', text: job.input }] },
          {}
        );
      });

      // Wire notification handler via Tauri notification plugin
      this.scheduler.setNotificationHandler(async (job) => {
        try {
          const { sendNotification } = await import('@tauri-apps/plugin-notification');
          const inputPreview = job.input.length > 50
            ? job.input.slice(0, 50) + '...'
            : job.input;
          sendNotification({
            title: 'Scheduled Job Starting',
            body: inputPreview,
          });
        } catch {
          // Notification permission may not be granted
        }
      });

      // Wire connectivity check — require both network and agent readiness
      this.scheduler.setConnectivityCheck(() => {
        const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
        return online && this.agent !== null && this.initialized;
      });

      // Initialize AgentRegistry for session isolation
      try {
        const agentConfig = await AgentConfig.getInstance();
        const channelManager = getChannelManager();
        const registry = new AgentRegistry({
          maxConcurrent: 1,
          agentFactory: async (config, router) => {
            const agent = new RepublicAgent(config, router, undefined, undefined, new UserNotifier());
            await agent.initialize();
            return agent;
          },
          eventDispatcherFactory: (sessionId) => (event) => {
            channelManager.dispatchEvent(event.msg, this.channel!.channelId).catch(() => {});
            this.handleSchedulerEventCompletion(event.msg);
          },
        });
        registry.initialize(agentConfig, this.messageRouter! as any);
        this.scheduler.setRegistry(registry);
        console.log('[DesktopAgentBootstrap] AgentRegistry initialized for session isolation');
      } catch (error) {
        console.warn('[DesktopAgentBootstrap] AgentRegistry init failed (non-fatal, using legacy sessions):', error);
      }

      // Set up deep link handler for OS-level job triggers
      this.schedulerDeepLinkHandler = new DesktopSchedulerDeepLinkHandler(this.scheduler);
      await this.schedulerDeepLinkHandler.initialize();

      // Reconcile OS jobs with in-process timers
      await this.schedulerAlarms.reconcileOnStartup(async () => {
        const jobs = await schedulerStorage.getScheduledJobs();
        return jobs.map(j => ({ id: j.id, scheduledTime: j.scheduledTime }));
      });

      // Recover stale running jobs from previous app session
      await this.scheduler.recoverStaleRunningJob();

      // Detect missed jobs and start queue processor
      const missedJobs = await this.scheduler.detectMissedJobs();
      if (missedJobs.length > 0) {
        console.log(`[DesktopAgentBootstrap] Detected ${missedJobs.length} missed scheduler jobs`);
      }
      await this.schedulerAlarms.startJobQueueProcessor();

      console.log('[DesktopAgentBootstrap] Scheduler initialized');
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not initialize scheduler:', error);
    }
  }

  /**
   * Intercept TaskComplete/TaskFailed events from the agent to complete/fail
   * the currently running scheduled job at the bootstrap level.
   */
  private handleSchedulerEventCompletion(msg: EventMsg): void {
    if (!this.runningSchedulerJobId || !this.scheduler) return;
    const jobId = this.runningSchedulerJobId;
    const duration = this.runningJobStartTime > 0 ? Date.now() - this.runningJobStartTime : 0;

    if (msg.type === 'TaskComplete') {
      this.runningSchedulerJobId = null;
      this.runningJobStartTime = 0;
      // EventMsg.data shape for TaskComplete: { last_agent_message?: string, token_usage?: { total?: { input_tokens, output_tokens, total_tokens } } }
      const data = (msg as EventMsg & { data?: Record<string, any> }).data;
      const summary = data?.last_agent_message?.slice(0, 500) || 'Job completed';
      const tokenData = data?.token_usage?.total;
      this.scheduler.completeJob(jobId, {
        summary,
        tokenUsage: {
          inputTokens: tokenData?.input_tokens ?? 0,
          outputTokens: tokenData?.output_tokens ?? 0,
          totalTokens: tokenData?.total_tokens ?? 0,
        },
        duration,
      }).catch((error) => {
        console.error(`[DesktopAgentBootstrap] Failed to complete scheduler job ${jobId}:`, error);
      });
    } else if (msg.type === 'TaskFailed') {
      this.runningSchedulerJobId = null;
      this.runningJobStartTime = 0;
      const data = (msg as EventMsg & { data?: Record<string, any> }).data;
      const error = data?.error || data?.reason || 'Job failed';
      this.scheduler.failJob(jobId, error).catch((err) => {
        console.error(`[DesktopAgentBootstrap] Failed to fail scheduler job ${jobId}:`, err);
      });
    }
  }

  /**
   * Get the skill registry instance (null if not yet initialized)
   */
  getSkillRegistry(): SkillRegistry | null {
    return this.skillRegistry;
  }

  /**
   * Collect platform info from Tauri and configure PromptComposer for ApplePi agent.
   * Called before agent.initialize() so the dynamic prompt includes OS/arch/shell.
   */
  private async configurePromptWithPlatformInfo(): Promise<void> {
    const staticContext: Partial<RuntimeContext> = {
      browserConnection: 'mcp',
    };

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const platformInfo = await invoke<{ os: string; arch: string; version: string }>('get_platform_info');
      staticContext.os = platformInfo.os;
      staticContext.arch = platformInfo.arch;
      staticContext.osVersion = platformInfo.version;
      // TODO: Heuristic-based shell detection — assumes default shell per OS.
      // Actual shell detection requires a Rust-side Tauri command (out of scope).
      staticContext.shell = platformInfo.os === 'macos' ? 'zsh'
        : platformInfo.os === 'windows' ? 'powershell' : 'bash';

      const { homeDir } = await import('@tauri-apps/api/path');
      staticContext.homeDir = await homeDir();
    } catch (e) {
      console.warn('[DesktopAgentBootstrap] Could not fetch platform info:', e);
    }

    configurePromptComposer('applepi', staticContext);
    console.log('[DesktopAgentBootstrap] PromptComposer configured for pi with platform context');
  }

  /**
   * Resume a previous conversation by its ID.
   *
   * Mirrors the service-worker's RESUME_SESSION logic:
   * aborts current tasks, tears down the old session, loads rollout history,
   * creates a fresh RepublicAgent with the resumed history, and returns the
   * reconstructed conversation items.
   */
  async resumeSession(conversationId: string): Promise<unknown[]> {
    if (!this.agent) {
      throw new Error('Agent not initialized');
    }

    console.log('[DesktopAgentBootstrap] Resuming session:', conversationId);

    // 1. Preserve auth manager from the current agent
    const authManager = this.agent.getModelClientFactory().getAuthManager();

    // 2. Abort any running tasks on the current session
    const currentSession = this.agent.getSession();
    await currentSession.abortAllTasks('UserInterrupt');

    // 3. Close the current session
    await currentSession.close();

    // 4. Load rollout history from storage
    const { RolloutRecorder } = await import('@/storage/rollout/RolloutRecorder');
    const initialHistory = await RolloutRecorder.getRolloutHistory(conversationId);

    if (initialHistory.type !== 'resumed' || !initialHistory.payload?.history) {
      throw new Error('Conversation not found or has no history');
    }

    // 5. Create a new RepublicAgent with the resumed initial history
    const config = await AgentConfig.getInstance();
    this.agent = new RepublicAgent(config, this.messageRouter as any, {
      mode: 'resumed' as const,
      conversationId,
      rolloutItems: initialHistory.payload.history,
    }, undefined, new UserNotifier());

    // 6. Re-wire event forwarding via ChannelManager
    const channelManager = getChannelManager();
    this.setupEventForwarding(channelManager);

    // 7. Restore auth manager on the new agent's ModelClientFactory
    if (authManager) {
      this.agent.getModelClientFactory().setAuthManager(authManager);
    }

    // 8. Initialize agent and session
    await this.agent.initialize();
    await this.configureDesktopPlatform();
    const session = this.agent.getSession();
    await session.initialize();

    // 9. Return the reconstructed conversation history
    const history = session.getConversationHistory();
    console.log('[DesktopAgentBootstrap] Session resumed with', history.items.length, 'items');
    return history.items;
  }

  /**
   * Get the agent instance
   */
  getAgent(): RepublicAgent | null {
    return this.agent;
  }

  /**
   * Handle config update notification
   * Called when settings are changed in the UI.
   *
   * The Settings page uses an isolated AgentConfig instance (not the agent's
   * singleton) so changes are persisted to storage but the agent's in-memory
   * config is stale.  We must reload from storage before refreshing.
   *
   * Uses hot-swap to update the model client in-place, preserving
   * conversation history and agent run state.
   */
  async handleConfigUpdate(): Promise<void> {
    if (!this.agent) {
      console.warn('[DesktopAgentBootstrap] Cannot handle config update: agent not initialized');
      return;
    }

    if (this.isUpdatingConfig) {
      console.log('[DesktopAgentBootstrap] Config update already in progress, skipping');
      return;
    }

    this.isUpdatingConfig = true;
    try {
      console.log('[DesktopAgentBootstrap] Handling config update...');

      // Reload the agent's AgentConfig singleton from storage so it picks up
      // changes written by the Settings page's isolated instance.
      const config = await AgentConfig.getInstance();
      await config.reload();

      // Hot-swap the model client in-place — preserves conversation and run state.
      // This handles model changes, API key changes, and routing mode changes
      // without reinitializing the agent.
      await this.agent.hotSwapModelClient();

      console.log('[DesktopAgentBootstrap] Config update handled successfully');
    } catch (error) {
      console.error('[DesktopAgentBootstrap] Failed to handle config update:', error);
    } finally {
      this.isUpdatingConfig = false;
    }
  }

  /**
   * Restore auth mode from keychain during initialization.
   * If the user has a valid token in keychain → backend routing.
   * Otherwise → api_key mode (user must configure their own key).
   */
  private async restoreAuthFromKeychain(config: AgentConfig): Promise<void> {
    try {
      const { getDesktopAuthService } = await import('../auth/DesktopAuthService');
      const { HOME_PAGE_BASE_URL, LLM_API_URL } = await import('@/webfront/lib/constants');
      // Note: do NOT call authService.initialize() here — this function only reads
      // tokens from the keychain and does not need the deep-link listener.
      // initialize() is called once by App.svelte and UserLoginStatus.svelte.
      const authService = getDesktopAuthService(HOME_PAGE_BASE_URL);

      const hasToken = await authService.hasValidToken();

      if (hasToken) {
        // User is logged in → backend routing (pass token getter for Bearer auth)
        const tokenGetter = () => authService.getAccessToken();
        await this.setAuthMode(false, LLM_API_URL, tokenGetter);

        // Persist preference if not already set
        const agentConfig = config.getConfig();
        if (agentConfig.preferences?.useOwnApiKey === undefined) {
          await config.updateConfig({
            preferences: { ...agentConfig.preferences, useOwnApiKey: false },
          });
        }

        console.log('[DesktopAgentBootstrap] Auth restored from keychain → backend routing');
      } else {
        console.log('[DesktopAgentBootstrap] No valid token in keychain → api_key mode');

        // Check for ChatGPT OAuth tokens
        await this.restoreChatGPTOAuth();
      }
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not restore auth from keychain:', error);
    }
  }

  /**
   * Restore ChatGPT OAuth session from keychain.
   * If valid ChatGPT OAuth tokens exist, configure the auth manager
   * with a token getter that auto-refreshes.
   */
  private async restoreChatGPTOAuth(): Promise<void> {
    try {
      const { ChatGPTOAuthDesktopStorage } = await import('../auth/ChatGPTOAuthDesktopStorage');
      const { ChatGPTOAuthService } = await import('@/core/auth/ChatGPTOAuthService');

      const storage = new ChatGPTOAuthDesktopStorage();
      const oauthService = new ChatGPTOAuthService(storage);

      if (await oauthService.isAuthenticated()) {
        // Create an AuthManager with ChatGPT OAuth token getter
        const factory = this.agent?.getModelClientFactory();
        if (factory) {
          const currentAuthManager = factory.getAuthManager?.() ?? null;
          const shouldUseBackend = currentAuthManager?.shouldUseBackend() ?? false;
          const backendBaseUrl = currentAuthManager?.getBackendBaseUrl() ?? null;
          const tokenGetter = currentAuthManager ? (() => currentAuthManager.getAccessToken()) : undefined;

          const authManager = new AuthManager(shouldUseBackend, backendBaseUrl, tokenGetter);
          authManager.setChatGPTOAuth(() => oauthService.getValidAccessToken());

          factory.setAuthManager(authManager);
          console.log('[DesktopAgentBootstrap] ChatGPT OAuth restored from keychain');
        }
      }
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not restore ChatGPT OAuth:', error);
    }
  }

  /**
   * Set the authentication mode on the agent's ModelClientFactory.
   * Called directly by UI code after login or on startup.
   * @param tokenGetter - Optional async function to retrieve access token (desktop keychain)
   */
  async setAuthMode(useOwnApiKey: boolean, backendBaseUrl: string | null, tokenGetter?: () => Promise<string | null>): Promise<void> {
    if (!this.agent) {
      console.warn('[DesktopAgentBootstrap] Cannot set auth mode: agent not initialized');
      return;
    }

    const shouldUseBackend = !useOwnApiKey;
    const authManager = new AuthManager(shouldUseBackend, shouldUseBackend ? backendBaseUrl : null, tokenGetter);

    const factory = this.agent.getModelClientFactory();
    factory.setAuthManager(authManager);

    console.log('[DesktopAgentBootstrap] Auth mode set, isBackendRouting:', factory.isBackendRouting());

    await this.agent.refreshModelClient();
  }

  /**
   * Get the channel instance
   */
  getChannel(): TauriChannel | null {
    return this.channel;
  }

  /**
   * Check if the agent is ready
   */
  async isReady(): Promise<boolean> {
    if (!this.agent) {
      return false;
    }
    const readyState = await this.agent.isReady();
    return readyState.ready;
  }

  /**
   * Get agent ready state with details
   */
  async getReadyState() {
    if (!this.agent) {
      return {
        ready: false,
        message: t('Agent not initialized'),
        authMode: 'none' as const,
      };
    }
    return await this.agent.isReady();
  }

  /**
   * Get the scheduler instance
   */
  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  /**
   * Shutdown the agent system
   */
  async shutdown(): Promise<void> {
    console.log('[DesktopAgentBootstrap] Shutting down...');

    // Dispose scheduler
    this.schedulerDeepLinkHandler?.dispose();
    this.schedulerAlarms?.dispose();

    // Shutdown channel manager (which shuts down all channels)
    const channelManager = getChannelManager();
    await channelManager.shutdown();

    // Cleanup agent
    if (this.agent) {
      await this.agent.cleanup();
      this.agent = null;
    }

    // Cleanup message router
    if (this.messageRouter) {
      this.messageRouter.destroy();
      this.messageRouter = null;
    }

    this.channel = null;
    this.initialized = false;

    console.log('[DesktopAgentBootstrap] Shutdown complete');
  }
}

/**
 * Get or create the singleton instance
 */
export function getDesktopAgentBootstrap(): DesktopAgentBootstrap {
  if (!_instance) {
    _instance = new DesktopAgentBootstrap();
  }
  return _instance;
}

/**
 * Initialize the desktop agent system
 * Convenience function that gets the singleton and initializes it
 */
export async function initializeDesktopAgent(): Promise<DesktopAgentBootstrap> {
  const bootstrap = getDesktopAgentBootstrap();
  await bootstrap.initialize();
  return bootstrap;
}
