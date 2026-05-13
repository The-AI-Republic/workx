/**
 * Desktop Agent Bootstrap
 *
 * Initializes and wires up the RepublicAgent with the channel system for desktop mode.
 * In desktop mode, the agent runs directly in the WebView (same process as UI).
 *
 * Flow:
 * 1. Create ChannelManager (routes submissions to agent, events to channels)
 * 2. Create TauriChannel (receives submissions from UI, sends events to UI)
 * 3. Create AgentRegistry with agentFactory and eventDispatcherFactory
 * 4. Create initial session via registry.createSession()
 * 5. Wire them together
 *
 * The registry is the single source of truth — there is no primary agent concept.
 * All per-session operations require a sessionId. Global operations iterate all sessions.
 *
 * @module desktop/agent/DesktopAgentBootstrap
 */

import { TauriChannel } from '../channels/TauriChannel';
import { getChannelManager, type AgentHandler } from '@/core/channels/ChannelManager';
import { RepublicAgent } from '@/core/RepublicAgent';
import { UserNotifier } from '@/core/UserNotifier';
import { ApprovalGate } from '@/core/approval/ApprovalGate';
import { PolicyRulesEngine } from '@/core/approval/PolicyRulesEngine';
import { getDefaultRules } from '@/core/approval/defaultRules';
import { DomainSensitivityEnhancer } from '@/core/approval/enhancers/DomainSensitivityEnhancer';
import { SensitivePathEnhancer } from '@/core/approval/enhancers/SensitivePathEnhancer';
import { ApprovalConfigStorage } from '@/core/approval/ApprovalConfigStorage';
import { getConfigStorage } from '@/core/storage/ConfigStorageProvider';
import { AgentConfig } from '@/config/AgentConfig';
import { configurePromptComposer, registerPromptExtension } from '@/core/PromptLoader';
import type { RuntimeContext } from '@/prompts/PromptComposer';
import { SkillRegistry } from '@/core/skills/SkillRegistry';
import { FilesystemSkillProvider } from '../storage/FilesystemSkillProvider';
import { AuthManager, type IAuthManager } from '@/core/models/types/Auth';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';
import { t } from '@/webfront/lib/i18n';
import { StaticRiskAssessor } from '@/core/approval/assessors/StaticRiskAssessor';
import { Scheduler } from '@/core/scheduler/Scheduler';
import { DesktopSchedulerAlarms } from '../scheduler/DesktopSchedulerAlarms';
import { DesktopSchedulerDeepLinkHandler } from '../scheduler/DesktopSchedulerDeepLinkHandler';
import { AgentRegistry } from '@/core/registry/AgentRegistry';
import { DEFAULT_MAX_CONCURRENT } from '@/core/registry/types';
import type { ToolRegistry } from '@/tools/ToolRegistry';

/**
 * Singleton instance
 */
let _instance: DesktopAgentBootstrap | null = null;

/**
 * Desktop Agent Bootstrap
 *
 * Manages the lifecycle of the agent and channel system in desktop mode.
 * The AgentRegistry is the single source of truth for all agent sessions.
 */
export class DesktopAgentBootstrap {
  private registry: AgentRegistry | null = null;
  private channel: TauriChannel | null = null;
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
      // 1. Get agent config
      const config = await AgentConfig.getInstance();

      // 2. Configure PromptComposer with platform context BEFORE any agent.initialize()
      // This must happen first so RepublicAgent.configurePromptComposition() sees
      // the composer is already configured and skips re-configuration.
      await this.configurePromptWithPlatformInfo();

      // 3. Initialize StorageProvider before agent — PlanningTool requires it
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

      // 4. Create TauriChannel
      this.channel = new TauriChannel();
      const channelManager = getChannelManager();

      // 5. Create AgentRegistry with factories that encapsulate per-session setup
      const maxConcurrentSessions = config.getConfig().preferences?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT;
      this.registry = AgentRegistry.getInstance({
        maxConcurrent: maxConcurrentSessions,
        agentFactory: async (agentConfig, initialHistory) => {
          const { DesktopPlatformAdapter } = await import('../platform/DesktopPlatformAdapter');
          const platformAdapter = new DesktopPlatformAdapter();
          const agent = new RepublicAgent(agentConfig, platformAdapter, initialHistory, undefined, new UserNotifier());

          // Copy auth manager from an existing session for consistency
          const existingAuth = this.getFirstAuthManager();
          if (existingAuth) {
            agent.getModelClientFactory().setAuthManager(existingAuth);
          }

          await agent.initialize();

          // Configure desktop-specific approval gate
          await this.configureDesktopPlatformForAgent(agent);

          // Register skills tool
          await this.registerSkillsToolOnAgent(agent);

          // Register sub-agent tool
          await this.registerSubAgentToolOnAgent(agent);

          return agent;
        },
        eventDispatcherFactory: (sessionId) => (event) => {
          channelManager.dispatchEvent({ msg: event.msg, sessionId }, this.channel!.channelId).catch((error) => {
            console.error('[DesktopAgentBootstrap] Failed to dispatch event:', error);
          });

          // Intercept completion events for scheduler
          this.handleSchedulerEventCompletion(event.msg);
        },
      });
      this.registry.initialize(config);

      // 6. Set up the agent handler on ChannelManager
      // This routes submissions from channels to the correct session in the registry
      const agentHandler: AgentHandler = async (op: Op, context: SubmissionContext) => {
        if (!context.sessionId) {
          throw new Error('No sessionId in submission context — cannot route operation');
        }
        if (!this.registry) {
          throw new Error('AgentRegistry not initialized');
        }
        const targetSession = this.registry.getSession(context.sessionId);
        if (!targetSession?.agent) {
          throw new Error(`Session not found: ${context.sessionId}`);
        }

        console.log('[DesktopAgentBootstrap] Processing submission:', op.type, 'for session:', context.sessionId);
        await targetSession.agent.submitOperation(op, { tabId: context.tabId });
      };

      channelManager.setAgentHandler(agentHandler);

      // Register the TauriChannel with ChannelManager
      await channelManager.registerChannel(this.channel);
      console.log('[DesktopAgentBootstrap] Channel registered');

      // 7. Initialize skills registry (prompt extension + discovery)
      await this.initializeSkills();

      // 8. Create the initial session via registry
      await this.registry.createSession({ type: 'primary' });
      console.log('[DesktopAgentBootstrap] Initial session created via registry');

      // 9. Restore auth mode from keychain and listen for changes
      // Same business logic as extension: logged in → backend routing, not logged in → api_key
      const { getDesktopAuthService } = await import('../auth/DesktopAuthService');
      const { HOME_PAGE_BASE_URL } = await import('@/webfront/lib/constants');
      const authService = getDesktopAuthService(HOME_PAGE_BASE_URL);

      // Listen for auth changes (implicit login via deep link)
      // This allows the agent to switch to backend routing automatically when user logs in
      authService.onAuthChange(async () => {
        console.log('[DesktopAgentBootstrap] Auth state changed, reloading auth mode...');
        await this.restoreAuthFromKeychain(config);

        // Notify the UI that auth has changed so it re-runs health check
        if (this.registry && this.registry.listSessions().length > 0 && this.channel) {
          channelManager.dispatchEvent(
            { msg: { type: 'BackgroundEvent', data: { message: 'Agent reinitialized after auth change', level: 'info' } } as any },
            this.channel.channelId
          ).catch(() => {});
        }
      });

      await this.restoreAuthFromKeychain(config);

      // 10. Set up MCP tool registration events
      await this.setupMCPToolRegistration();

      // 11. Initialize scheduler
      await this.initializeScheduler();

      // 12. Register service handlers on ChannelManager (message_routing_v2)
      await this.registerServices(channelManager);

      this.initialized = true;
      console.log('[DesktopAgentBootstrap] Initialization complete');
    } catch (error) {
      console.error('[DesktopAgentBootstrap] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Configure desktop-specific approval gate on a specific agent.
   * Called by the agentFactory for every new session.
   */
  private async configureDesktopPlatformForAgent(agent: RepublicAgent): Promise<void> {
    const approvalManager = agent.getApprovalManager();
    const toolRegistry = agent.getToolRegistry();

    // Approval gate with desktop-specific enhancers
    const policyEngine = new PolicyRulesEngine(getDefaultRules('desktop'));
    const approvalGate = new ApprovalGate(approvalManager, policyEngine);
    approvalGate.addEnhancer(new DomainSensitivityEnhancer());
    approvalGate.addEnhancer(new SensitivePathEnhancer());

    // Desktop mode uses ConfigStorageProvider (TauriConfigStorage already initialized)
    const configStorage = new ApprovalConfigStorage(() => getConfigStorage());
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
   * Register service handlers on ChannelManager (message_routing_v2).
   * Gives desktop mode full service parity with the extension.
   */
  private async registerServices(channelManager: ReturnType<typeof getChannelManager>): Promise<void> {
    const { registerAllServices } = await import('@/core/services');
    const registry = channelManager.getServiceRegistry();

    // Get MCPManager instance (already created during setupMCPToolRegistration)
    let mcpDeps: import('@/core/services').MCPServiceDeps | undefined;
    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const mcpManager = await MCPManager.getInstance('desktop');
      mcpDeps = { mcpManager: mcpManager as any };
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] MCPManager not available for service registration:', error);
    }

    // Get A2AManager instance
    let a2aDeps: import('@/core/services').A2AServiceDeps | undefined;
    try {
      const { A2AManager } = await import('@/core/a2a/A2AManager');
      const a2aManager = await A2AManager.getInstance('desktop');
      a2aDeps = { a2aManager: a2aManager as any };
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] A2AManager not available for service registration:', error);
    }

    const count = registerAllServices(registry, {
      mcp: mcpDeps,
      a2a: a2aDeps,
      skills: this.skillRegistry ? { skillRegistry: this.skillRegistry } : undefined,
      scheduler: this.scheduler ? { scheduler: this.scheduler } : undefined,
      session: this.registry ? {
        registry: this.registry,
        loadRolloutHistory: async (sessionId: string) => {
          const { RolloutRecorder } = await import('@/storage/rollout/RolloutRecorder');
          const history = await RolloutRecorder.getRolloutHistory(sessionId);
          if (history.type !== 'resumed' || !history.payload?.history) return null;
          return { sessionId, rolloutItems: history.payload.history };
        },
      } : undefined,
      agent: this.registry ? {
        registry: this.registry,
        handleConfigUpdate: () => this.handleConfigUpdate(),
        updateApprovalConfig: async (config: Record<string, unknown>) => {
          const { TauriConfigStorage } = await import('@/desktop/storage/TauriConfigStorage');
          const tauriStorage = new TauriConfigStorage();
          const storedConfig = (await tauriStorage.get<Record<string, any>>('agent_config')) || {};
          storedConfig.approval = { ...(storedConfig.approval || {}), ...config };
          await tauriStorage.set('agent_config', storedConfig);
        },
      } : undefined,
    });

    console.log(`[DesktopAgentBootstrap] Registered ${count} service handlers`);
  }

  /**
   * Get all tool registries from all active sessions in the registry.
   */
  private getAllToolRegistries(): ToolRegistry[] {
    if (!this.registry) return [];
    const registries: ToolRegistry[] = [];
    for (const sessionMeta of this.registry.listSessions()) {
      const session = this.registry.getSession(sessionMeta.sessionId);
      if (session?.agent) {
        registries.push(session.agent.getToolRegistry());
      }
    }
    return registries;
  }

  /**
   * Set up MCP tool registration events for desktop.
   * Subscribes to MCPManager 'tools-updated' events so tools are
   * auto-registered/unregistered when MCP servers connect/disconnect.
   * Registers/unregisters on ALL active sessions' tool registries.
   */
  private async setupMCPToolRegistration(): Promise<void> {
    if (!this.registry) {
      return;
    }

    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const { registerMCPTools, unregisterMCPTools } = await import('@/core/mcp/MCPToolAdapter');
      const mcpManager = await MCPManager.getInstance('desktop');

      // Track registered tools per server so we can unregister them on disconnect.
      // MCPManager clears connection.tools before emitting the event, so we
      // can't read them from the connection at unregister time.
      const registeredToolsByServer = new Map<string, import('@/core/mcp/types').IMCPTool[]>();

      mcpManager.on('event', (event) => {
        if (event.type !== 'tools-updated') return;

        const config = mcpManager.getServer(event.configId);
        if (!config) return;

        const allRegistries = this.getAllToolRegistries();

        // Unregister previously registered tools first (handles both disconnect and reconnect)
        const previousTools = registeredToolsByServer.get(event.configId);
        if (previousTools && previousTools.length > 0) {
          for (const registry of allRegistries) {
            unregisterMCPTools(config.name, previousTools, registry).catch((error) => {
              console.error('[DesktopAgentBootstrap] Failed to unregister MCP tools:', error);
            });
          }
          registeredToolsByServer.delete(event.configId);
        }

        if (event.tools.length > 0) {
          // Tools discovered — register them on all sessions and track for later unregistration
          for (const registry of allRegistries) {
            registerMCPTools(mcpManager, config.name, event.tools, registry).catch((error) => {
              console.error('[DesktopAgentBootstrap] Failed to register MCP tools:', error);
            });
          }
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
   * Note: The use_skill tool is registered per-session via registerSkillsToolOnAgent(),
   * called from the agentFactory.
   */
  private async initializeSkills(): Promise<void> {
    try {
      const provider = new FilesystemSkillProvider();
      await provider.initialize();

      this.skillRegistry = new SkillRegistry(provider);
      await this.skillRegistry.discover();

      registerPromptExtension(() => this.skillRegistry!.buildSkillsSystemPrompt());

      console.log('[DesktopAgentBootstrap] Skills initialized, found', this.skillRegistry.getSkillMetas().length, 'skills');
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not initialize skills:', error);
    }
  }

  /**
   * Register the use_skill tool on a specific agent's tool registry.
   * Called by the agentFactory for every new session.
   */
  private async registerSkillsToolOnAgent(agent: RepublicAgent): Promise<void> {
    if (!this.skillRegistry) return;

    const allSkills = this.skillRegistry.getSkillMetas();
    if (allSkills.length === 0) return;

    const registry = agent.getToolRegistry();

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

  /**
   * Register the sub_agent tool on a specific agent's engine.
   * Called by the agentFactory for every new session.
   */
  private async registerSubAgentToolOnAgent(agent: RepublicAgent): Promise<void> {
    const engine = agent.getEngine();
    if (!engine) {
      console.warn('[DesktopAgentBootstrap] Cannot register sub_agent tool: engine not initialized');
      return;
    }

    try {
      const { registerSubAgentTool } = await import('@/tools/AgentTool/register');
      await registerSubAgentTool(engine);
      console.log('[DesktopAgentBootstrap] sub_agent tool registered');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn('[DesktopAgentBootstrap] Could not register sub_agent tool:', error);
      engine.pushEvent({
        id: crypto.randomUUID(),
        msg: { type: 'BackgroundEvent', data: { message: `Sub-agent tool registration failed: ${errMsg}`, level: 'error' } },
      });
    }
  }

  /**
   * Initialize the scheduler for desktop mode.
   * Uses platform-aware StorageAdapter + hybrid DesktopSchedulerAlarms.
   * Uses the same this.registry for session isolation (no duplicate registry).
   */
  private async initializeScheduler(): Promise<void> {
    try {
      // Directly instantiate TauriSQLiteAdapter — desktop always uses SQLite via Tauri
      const { TauriSQLiteAdapter } = await import('@/desktop/storage/TauriSQLiteAdapter');
      const { ScheduleEventStorage } = await import('@/core/scheduler/ScheduleEventStorage');
      const { ExecutionStorage } = await import('@/core/scheduler/ExecutionStorage');
      const { ScheduleManager } = await import('@/core/scheduler/ScheduleManager');
      const { JobExecutor } = await import('@/core/scheduler/JobExecutor');

      const storageAdapter = new TauriSQLiteAdapter();
      await storageAdapter.initialize();

      // Share adapter with TokenUsageStore
      const { TokenUsageStore } = await import('@/storage/TokenUsageStore');
      TokenUsageStore.setAdapter(storageAdapter);

      const scheduleEventStorage = new ScheduleEventStorage(storageAdapter);
      const executionStorage = new ExecutionStorage(storageAdapter);

      // Create hybrid alarms (in-process timers + OS-level jobs)
      this.schedulerAlarms = new DesktopSchedulerAlarms();

      // Create new model components directly
      const scheduleManager = new ScheduleManager(scheduleEventStorage, executionStorage, this.schedulerAlarms);
      const jobExecutor = new JobExecutor(executionStorage);

      // Create scheduler with new constructor
      this.scheduler = new Scheduler(scheduleManager, jobExecutor, this.schedulerAlarms);

      // Wire alarm handler
      this.schedulerAlarms.setAlarmHandler(async (alarmName) => {
        await this.scheduler!.handleAlarm(alarmName);
      });

      // Wire event emitter → unified channel dispatch
      this.scheduler.connectToChannel(() => getChannelManager(), this.channel!.channelId);

      // Wire job launcher — show window and submit directly to agent
      this.scheduler.setJobLauncher(async (executionId, sessionId, registryAgent) => {
        console.log(`[DesktopAgentBootstrap] Scheduled job ${executionId} launched (session: ${sessionId})`);
        // Show the main window
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        } catch {
          // Non-fatal — window may already be visible
        }
        // Look up execution record for the input text
        const execution = await executionStorage.getExecution(executionId);
        if (!execution) throw new Error(`Execution not found: ${executionId}`);
        if (!registryAgent) throw new Error('No agent provided for scheduled job');
        // submitOperation is fire-and-forget: it queues the operation, may abort
        // a previous task (emitting TurnAborted), and returns before the new task
        // completes. We set runningSchedulerJobId AFTER to avoid false-triggering
        // handleSchedulerEventCompletion on the previous task's TurnAborted event.
        await registryAgent.submitOperation(
          { type: 'UserInput', items: [{ type: 'text', text: execution.input }] },
          {}
        );
        this.runningSchedulerJobId = executionId;
        this.runningJobStartTime = Date.now();
      });

      // Wire notification handler via Tauri notification plugin
      this.scheduler.setNotificationHandler(async (info) => {
        try {
          const { sendNotification } = await import('@tauri-apps/plugin-notification');
          const inputPreview = info.input.length > 50
            ? info.input.slice(0, 50) + '...'
            : info.input;
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
        const hasActiveSessions = this.registry !== null && this.registry.listSessions().length > 0;
        return online && hasActiveSessions && this.initialized;
      });

      // Use the same registry for session isolation (no duplicate registry)
      if (this.registry) {
        this.scheduler.setRegistry(this.registry);
        console.log('[DesktopAgentBootstrap] Scheduler using shared AgentRegistry for session isolation');
      }

      // Set up deep link handler for OS-level job triggers
      this.schedulerDeepLinkHandler = new DesktopSchedulerDeepLinkHandler(this.scheduler);
      await this.schedulerDeepLinkHandler.initialize();

      // Reconcile OS jobs with in-process timers using ScheduleManager
      await this.schedulerAlarms.reconcileOnStartup(async () => {
        const events = await scheduleManager.getScheduledEvents();
        return events.map(e => ({ id: e.id, scheduledTime: e.scheduledTime }));
      });

      // Recover stale running jobs from previous app session
      await this.scheduler.recoverStaleRunningJob();

      // Detect missed jobs and start queue processor
      const missed = await this.scheduler.detectMissedJobs();
      if (missed.length > 0) {
        console.log(`[DesktopAgentBootstrap] Detected ${missed.length} missed scheduler instances`);
      }
      await this.schedulerAlarms.startJobQueueProcessor();

      // Restore alarms for ScheduleEvents
      await this.scheduler.restoreScheduleAlarms();

      console.log('[DesktopAgentBootstrap] Scheduler initialized');
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not initialize scheduler:', error);
    }
  }

  /**
   * Intercept task lifecycle events from the agent to complete/fail
   * the currently running scheduled job at the bootstrap level.
   *
   * Handles: TaskComplete (normal), TurnAborted (abort/interrupt),
   * Error (task errors), TaskFailed (protocol-defined, currently unused).
   */
  private handleSchedulerEventCompletion(msg: EventMsg): void {
    if (!this.runningSchedulerJobId || !this.scheduler) return;
    const jobId = this.runningSchedulerJobId;
    const duration = this.runningJobStartTime > 0 ? Date.now() - this.runningJobStartTime : 0;

    if (msg.type === 'TaskComplete') {
      this.runningSchedulerJobId = null;
      this.runningJobStartTime = 0;
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
    } else if (msg.type === 'TaskFailed' || msg.type === 'TurnAborted' || msg.type === 'Error') {
      // TaskFailed: protocol-defined failure (currently not emitted by TaskRunner)
      // TurnAborted: task aborted (user interrupt, automatic_abort after MAX_TURNS)
      // Error: task execution error (API error, model error, submission error)
      this.runningSchedulerJobId = null;
      this.runningJobStartTime = 0;
      const data = (msg as EventMsg & { data?: Record<string, any> }).data;
      const error = data?.error || data?.reason || data?.message || 'Job failed';
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
   * Get the active registry (for multi-session support)
   */
  getRegistry(): AgentRegistry | null {
    return this.registry;
  }

  /**
   * Handle config update notification
   * Called when settings are changed in the UI.
   *
   * The Settings page uses an isolated AgentConfig instance (not the agent's
   * singleton) so changes are persisted to storage but the agent's in-memory
   * config is stale.  We must reload from storage before refreshing.
   *
   * Uses hot-swap to update the model client in-place on ALL sessions,
   * preserving conversation history and agent run state.
   */
  async handleConfigUpdate(): Promise<void> {
    if (!this.registry || this.registry.listSessions().length === 0) {
      console.warn('[DesktopAgentBootstrap] Cannot handle config update: no active sessions');
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

      // Hot-swap the model client in-place on ALL sessions
      for (const sessionMeta of this.registry.listSessions()) {
        const session = this.registry.getSession(sessionMeta.sessionId);
        if (session?.agent) {
          await session.agent.hotSwapModelClient();
        }
      }

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
   * on ALL active sessions.
   */
  private async restoreChatGPTOAuth(): Promise<void> {
    try {
      const { ChatGPTOAuthDesktopStorage } = await import('../auth/ChatGPTOAuthDesktopStorage');
      const { ChatGPTOAuthService } = await import('@/core/auth/ChatGPTOAuthService');

      const storage = new ChatGPTOAuthDesktopStorage();
      const oauthService = new ChatGPTOAuthService(storage);

      if (await oauthService.isAuthenticated()) {
        if (!this.registry) return;

        for (const sessionMeta of this.registry.listSessions()) {
          const session = this.registry.getSession(sessionMeta.sessionId);
          const factory = session?.agent?.getModelClientFactory();
          if (factory) {
            const currentAuthManager = factory.getAuthManager?.() ?? null;
            const shouldUseBackend = currentAuthManager?.shouldUseBackend() ?? false;
            const backendBaseUrl = currentAuthManager?.getBackendBaseUrl() ?? null;
            const tokenGetter = currentAuthManager ? (() => currentAuthManager.getAccessToken()) : undefined;

            const authManager = new AuthManager(shouldUseBackend, backendBaseUrl, tokenGetter);
            authManager.setChatGPTOAuth(() => oauthService.getValidAccessToken());

            factory.setAuthManager(authManager);
          }
        }
        console.log('[DesktopAgentBootstrap] ChatGPT OAuth restored from keychain');
      }
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not restore ChatGPT OAuth:', error);
    }
  }

  /**
   * Set the authentication mode on ALL sessions' ModelClientFactory.
   * Called directly by UI code after login or on startup.
   * @param tokenGetter - Optional async function to retrieve access token (desktop keychain)
   */
  async setAuthMode(useOwnApiKey: boolean, backendBaseUrl: string | null, tokenGetter?: () => Promise<string | null>): Promise<void> {
    if (!this.registry || this.registry.listSessions().length === 0) {
      console.warn('[DesktopAgentBootstrap] Cannot set auth mode: no active sessions');
      return;
    }

    const shouldUseBackend = !useOwnApiKey;

    for (const sessionMeta of this.registry.listSessions()) {
      const session = this.registry.getSession(sessionMeta.sessionId);
      if (session?.agent) {
        const authManager = new AuthManager(shouldUseBackend, shouldUseBackend ? backendBaseUrl : null, tokenGetter);
        const factory = session.agent.getModelClientFactory();
        factory.setAuthManager(authManager);

        console.log('[DesktopAgentBootstrap] Auth mode set on session', sessionMeta.sessionId, ', isBackendRouting:', factory.isBackendRouting());

        await session.agent.refreshModelClient();
      }
    }
  }

  /**
   * Get the channel instance
   */
  getChannel(): TauriChannel | null {
    return this.channel;
  }

  /**
   * Check if the agent system is ready (any active session is ready)
   */
  async isReady(): Promise<boolean> {
    if (!this.registry) return false;
    for (const sessionMeta of this.registry.listSessions()) {
      const session = this.registry.getSession(sessionMeta.sessionId);
      if (session?.agent) {
        const readyState = await session.agent.isReady();
        if (readyState.ready) return true;
      }
    }
    return false;
  }

  /**
   * Get agent ready state with details (from the first active session)
   */
  async getReadyState() {
    if (!this.registry) {
      return {
        ready: false,
        message: t('Agent not initialized'),
        authMode: 'none' as const,
      };
    }
    for (const sessionMeta of this.registry.listSessions()) {
      const session = this.registry.getSession(sessionMeta.sessionId);
      if (session?.agent) {
        return await session.agent.isReady();
      }
    }
    return {
      ready: false,
      message: t('Agent not initialized'),
      authMode: 'none' as const,
    };
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

    // Cleanup all sessions via registry
    if (this.registry) {
      await this.registry.cleanup();
      this.registry = null;
    }

    this.channel = null;
    this.initialized = false;

    console.log('[DesktopAgentBootstrap] Shutdown complete');
  }

  /**
   * Get the auth manager from the first active session (for copying to new sessions).
   * Returns null if no sessions exist or none have an auth manager.
   */
  private getFirstAuthManager(): IAuthManager | null {
    if (!this.registry) return null;
    for (const sessionMeta of this.registry.listSessions()) {
      const session = this.registry.getSession(sessionMeta.sessionId);
      const authManager = session?.agent?.getModelClientFactory().getAuthManager();
      if (authManager) return authManager;
    }
    return null;
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
