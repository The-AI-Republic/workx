/**
 * Server Agent Bootstrap
 *
 * Main orchestrator for server mode. Creates AgentRegistry with
 * session-aware agent management, ServerChannel, ChannelManager,
 * plugin loader, and maintenance timers.
 *
 * Pattern follows the extension service worker: no singleton agent,
 * all operations routed through AgentRegistry by sessionId.
 *
 * @module server/agent/ServerAgentBootstrap
 */

import { ServerChannel } from '../channels/ServerChannel';
import { getChannelManager, type AgentHandler } from '@/core/channels/ChannelManager';
import { RepublicAgent } from '@/core/RepublicAgent';
import { AgentConfig, CREDENTIAL_SECURED_MARKER } from '@/config/AgentConfig';
import { setConfigStorage } from '@/core/storage/ConfigStorageProvider';
import { FileConfigStorageProvider } from '../storage/FileConfigStorageProvider';
import { configurePromptComposer } from '@/core/PromptLoader';
import type { RuntimeContext } from '@/prompts/PromptComposer';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';

import { getServerConfig, watchConfig, stopWatchingConfig, onConfigReload } from '../config/server-config';
import { SessionIndex } from '../persistence/SessionIndex';
import { TranscriptStore } from '../persistence/TranscriptStore';
import { BackupManager } from '../persistence/backup';
import { ApprovalManager } from '../exec/approval-manager';
import { PluginRegistry } from '../plugins/plugin-registry';
import { ApplePiPluginApi } from '../plugins/applepi-plugin-api';
import { discoverPlugins } from '../plugins/plugin-loader';
import { ChannelPluginBridge } from '../plugins/channel-bridge';
import { HealthMonitor } from '../health/health-monitor';
import {
  setHealthAgentStatus,
  setHealthAgentTools,
  setHealthChannels,
  setHealthSessionCounts,
  resetHealthStartTime,
} from '../handlers/health';
import { setHandshakeSnapshotProviders } from '../connection/handshake';
import { registerServerTools } from '../tools/registerServerTools';

// Handler registrations
import { registerChatHandlers } from '../handlers/chat';
import { registerSessionHandlers } from '../handlers/sessions';
import { registerConfigHandlers } from '../handlers/config';
import { registerHealthHandlers } from '../handlers/health';
import { registerToolsHandlers } from '../handlers/tools';
import { registerLogsHandlers } from '../handlers/logs';
import { registerExecHandlers } from '../handlers/exec';
import { registerSchedulerHandlers } from '../handlers/scheduler';
import { registerCredentialsHandlers } from '../handlers/credentials';

// Scheduler
import { ServerScheduleStorage } from '../scheduler/ServerScheduleStorage';
import { ServerExecutionStorage } from '../scheduler/ServerExecutionStorage';
import { ServerSchedulerAlarms } from '../scheduler/ServerSchedulerAlarms';
import { Scheduler } from '@/core/scheduler/Scheduler';
import { ScheduleManager } from '@/core/scheduler/ScheduleManager';
import { JobExecutor } from '@/core/scheduler/JobExecutor';

// Session isolation
import { AgentRegistry } from '@/core/registry/AgentRegistry';

// ─────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────

let _instance: ServerAgentBootstrap | null = null;

// ─────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────

export class ServerAgentBootstrap {
  private registry: AgentRegistry | null = null;
  private channel: ServerChannel | null = null;
  private sessionIndex: SessionIndex | null = null;
  private transcriptStore: TranscriptStore | null = null;
  private backupManager: BackupManager | null = null;
  private approvalManager: ApprovalManager | null = null;
  private pluginRegistry: PluginRegistry | null = null;
  private healthMonitor: HealthMonitor | null = null;
  private scheduler: Scheduler | null = null;
  private scheduleEventStorage: ServerScheduleStorage | null = null;
  private executionRecordStorage: ServerExecutionStorage | null = null;
  private schedulerAlarms: ServerSchedulerAlarms | null = null;
  private runningSchedulerJobId: string | null = null;
  private runningJobStartTime: number = 0;
  private initialized = false;

  /**
   * Initialize the server agent system.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('[ServerAgentBootstrap] Already initialized');
      return;
    }

    console.log('[ServerAgentBootstrap] Initializing...');
    const config = getServerConfig();
    const dataDir = process.env.APPLEPI_DATA_DIR ??
      `${process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'}/.applepi-server/data`;

    try {
      // 0. Initialize StorageProvider (used by subsystems)
      const { isStorageProviderInitialized, initializeStorageProvider, isCredentialStoreInitialized, initializeCredentialStore } = await import('@/core/storage');
      if (!isStorageProviderInitialized()) {
        await initializeStorageProvider();
        console.log('[ServerAgentBootstrap] StorageProvider initialized (SQLite)');
      }

      // 0a. Initialize TokenUsageStore with NodeSQLiteAdapter
      try {
        const { NodeSQLiteAdapter } = await import('@/server/storage/NodeSQLiteAdapter');
        const { TokenUsageStore } = await import('@/storage/TokenUsageStore');
        const tokenAdapter = new NodeSQLiteAdapter(dataDir);
        await tokenAdapter.initialize();
        TokenUsageStore.setAdapter(tokenAdapter);
      } catch (error) {
        console.warn('[ServerAgentBootstrap] TokenUsageStore initialization failed (non-fatal):', error);
      }

      // 0b. Initialize credential store (for secure API key storage)
      if (!isCredentialStoreInitialized()) {
        try {
          await initializeCredentialStore();
          console.log('[ServerAgentBootstrap] CredentialStore initialized (FileCredentialStore)');
        } catch (error) {
          console.warn('[ServerAgentBootstrap] CredentialStore initialization failed (non-fatal):', error);
        }
      }

      // 1. Initialize config storage (must happen before AgentConfig)
      setConfigStorage(new FileConfigStorageProvider(dataDir));

      // 2. Get agent config
      const agentConfig = await AgentConfig.getInstance();

      // 3. Configure PromptComposer with server platform context
      // (must happen before agent.initialize() inside agentFactory)
      await this.configurePrompt();

      // 4. Create ServerChannel and wire up
      this.channel = new ServerChannel();
      const channelManager = getChannelManager();

      // 5. Create AgentRegistry with factories
      this.registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory: async (cfg, initialHistory) => {
          const { ServerPlatformAdapter } = await import('../platform/ServerPlatformAdapter');
          const platformAdapter = new ServerPlatformAdapter();
          const agent = new RepublicAgent(cfg, platformAdapter, initialHistory);
          await agent.initialize();

          // Register server-mode tools on each new agent
          try {
            const toolRegistry = agent.getToolRegistry();
            await registerServerTools(toolRegistry as any);
            console.log('[ServerAgentBootstrap] Server tools registered on new session agent');
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn('[ServerAgentBootstrap] Tool registration failed (non-fatal):', err);
            agent.getEngine()?.pushEvent({
              id: crypto.randomUUID(),
              msg: { type: 'BackgroundEvent', data: { message: `Server tool registration failed: ${errMsg}`, level: 'error' } },
            });
          }

          // Register sub-agent tool
          const engine = agent.getEngine();
          if (engine) {
            try {
              const { registerSubAgentTool } = await import('@/core/subagent/register');
              await registerSubAgentTool(engine);
              console.log('[ServerAgentBootstrap] sub_agent tool registered');
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.warn('[ServerAgentBootstrap] sub_agent tool registration failed (non-fatal):', err);
              engine.pushEvent({
                id: crypto.randomUUID(),
                msg: { type: 'BackgroundEvent', data: { message: `Sub-agent tool registration failed: ${errMsg}`, level: 'error' } },
              });
            }
          }

          return agent;
        },
        eventDispatcherFactory: (sessionId) => (event) => {
          // Dispatch to ServerChannel -> WebSocket clients with sessionId
          channelManager.dispatchEvent({ msg: event.msg, sessionId }, this.channel!.channelId).catch((error) => {
            console.error('[ServerAgentBootstrap] Failed to dispatch event:', error);
          });

          // Also log to transcript store
          if (this.transcriptStore) {
            this.transcriptStore.append('__active__', {
              ts: Date.now(),
              type: event.msg.type,
              data: event.msg,
            });
          }

          // Intercept completion events for scheduler
          this.handleSchedulerEventCompletion(event.msg);
        },
      });
      this.registry.initialize(agentConfig);

      // 6. Create initial primary session
      const initialSession = await this.registry.createSession({ type: 'primary' });
      console.log(`[ServerAgentBootstrap] Initial session created: ${initialSession.sessionId}`);

      // 7. Set agent handler — requires sessionId, no fallback
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
        console.log('[ServerAgentBootstrap] Processing submission:', op.type, 'session:', context.sessionId);
        await targetSession.agent.submitOperation(op, { tabId: context.tabId });
      };

      channelManager.setAgentHandler(agentHandler);
      await channelManager.registerChannel(this.channel);
      console.log('[ServerAgentBootstrap] Channel registered');

      // 8. Initialize persistence
      this.sessionIndex = new SessionIndex(dataDir);
      await this.sessionIndex.initialize();
      console.log('[ServerAgentBootstrap] Session index initialized');

      this.transcriptStore = new TranscriptStore(dataDir);
      await this.transcriptStore.initialize();
      console.log('[ServerAgentBootstrap] Transcript store initialized');

      // 9. Initialize backup manager
      this.backupManager = new BackupManager(dataDir, config.server.backup.retention);
      this.backupManager.start();

      // 10. Initialize approval manager
      this.approvalManager = new ApprovalManager();

      // 10b. Initialize scheduler
      await this.initializeScheduler(dataDir, channelManager);

      // 11. Wire handshake snapshot providers
      setHandshakeSnapshotProviders({
        getSessionSummaries: async () => {
          if (!this.sessionIndex) return [];
          return this.sessionIndex.list({});
        },
      });

      // 12. Register method handlers
      this.registerHandlers();

      // 12b. Initialize plugins
      await this.initializePlugins(channelManager);

      // 13. Start health monitoring
      this.healthMonitor = new HealthMonitor();
      this.healthMonitor.start();
      resetHealthStartTime();

      // Update health status via first session in registry
      const primarySession = this.registry.getPrimarySession();
      if (primarySession?.agent) {
        const readyState = await primarySession.agent.isReady();
        setHealthAgentStatus(readyState.ready);
      }

      // Populate tool names for health endpoint (aggregate from all sessions)
      try {
        const allTools: string[] = [];
        const sessions = this.registry.listSessions();
        for (const s of sessions) {
          const agentSession = this.registry.getSession(s.sessionId);
          if (agentSession?.agent) {
            const registry = agentSession.agent.getToolRegistry();
            const tools = registry.listTools().map((t: any) => t.function?.name ?? t.name ?? 'unknown');
            allTools.push(...tools);
          }
        }
        // Deduplicate
        setHealthAgentTools([...new Set(allTools)]);
      } catch {
        // Non-fatal
      }

      // Populate session counts
      if (this.sessionIndex) {
        try {
          const count = this.sessionIndex.count();
          setHealthSessionCounts(count, count);
        } catch {
          // Non-fatal
        }
      }

      // 14. Start config file watcher
      watchConfig();
      onConfigReload((_newConfig) => {
        console.log('[ServerAgentBootstrap] Config reloaded');
        // Hot-reload: iterate all sessions for refreshModelClient
        this.handleConfigUpdate().catch((err) => {
          console.error('[ServerAgentBootstrap] Failed to handle config update:', err);
        });
      });

      // 15. Register service handlers on ChannelManager (message_routing_v2)
      await this.registerServices(channelManager);

      this.initialized = true;
      console.log('[ServerAgentBootstrap] Initialization complete');
    } catch (error) {
      console.error('[ServerAgentBootstrap] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Handle configuration updates by iterating all sessions and hot-swapping
   * their model clients.
   */
  private async handleConfigUpdate(): Promise<void> {
    if (!this.registry) return;
    const config = await AgentConfig.getInstance();
    await config.reload();
    const sessions = this.registry.listSessions();
    for (const s of sessions) {
      if (s.state === 'terminated') continue;
      const agentSession = this.registry.getSession(s.sessionId);
      if (agentSession?.agent) {
        await agentSession.agent.hotSwapModelClient();
      }
    }
  }

  /**
   * Register service handlers on ChannelManager (message_routing_v2).
   * Gives server mode full service parity with the extension.
   */
  private async registerServices(channelManager: ReturnType<typeof getChannelManager>): Promise<void> {
    const { registerAllServices } = await import('@/core/services');
    const serviceRegistry = channelManager.getServiceRegistry();

    // Get MCPManager instance
    let mcpDeps: import('@/core/services').MCPServiceDeps | undefined;
    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const mcpManager = await MCPManager.getInstance('server');
      mcpDeps = { mcpManager: mcpManager as any };
    } catch (error) {
      console.warn('[ServerAgentBootstrap] MCPManager not available for service registration:', error);
    }

    // Get A2AManager instance
    let a2aDeps: import('@/core/services').A2AServiceDeps | undefined;
    try {
      const { A2AManager } = await import('@/core/a2a/A2AManager');
      const a2aManager = await A2AManager.getInstance('server');
      a2aDeps = { a2aManager: a2aManager as any };
    } catch (error) {
      console.warn('[ServerAgentBootstrap] A2AManager not available for service registration:', error);
    }

    // Get SkillRegistry with StorageProvider-backed skill provider
    let skillsDeps: import('@/core/services').SkillsServiceDeps | undefined;
    try {
      const { getStorageProvider } = await import('@/core/storage');
      const { IndexedDBSkillProvider } = await import('@/extension/storage/IndexedDBSkillProvider');
      const { SkillRegistry } = await import('@/core/skills/SkillRegistry');

      const storageProvider = getStorageProvider();
      const skillProvider = new IndexedDBSkillProvider(storageProvider);
      await skillProvider.initialize();

      const skillRegistry = new SkillRegistry(skillProvider);
      await skillRegistry.discover();
      skillsDeps = { skillRegistry };

      console.log(`[ServerAgentBootstrap] Skills initialized, found ${skillRegistry.getSkillMetas().length} skills`);
    } catch (error) {
      console.warn('[ServerAgentBootstrap] SkillRegistry not available for service registration:', error);
    }

    const count = registerAllServices(serviceRegistry, {
      mcp: mcpDeps,
      a2a: a2aDeps,
      skills: skillsDeps,
      scheduler: this.scheduler ? { scheduler: this.scheduler } : undefined,
      session: this.registry ? { registry: this.registry } : undefined,
      agent: this.registry ? {
        registry: this.registry,
        handleConfigUpdate: () => this.handleConfigUpdate(),
      } : undefined,
    });

    console.log(`[ServerAgentBootstrap] Registered ${count} service handlers`);
  }

  /**
   * Register all method handlers.
   */
  private registerHandlers(): void {
    registerChatHandlers({
      submitOp: async (op, context) => {
        if (!context.sessionId) {
          throw new Error('No sessionId — cannot route chat submission');
        }
        if (!this.registry) throw new Error('AgentRegistry not initialized');
        const targetSession = this.registry.getSession(context.sessionId);
        if (!targetSession?.agent) throw new Error(`Session not found: ${context.sessionId}`);
        await targetSession.agent.submitOperation(op, { tabId: context.tabId });
      },
      getHistory: async (sessionKey) => {
        if (!this.transcriptStore) return [];
        return this.transcriptStore.read(sessionKey);
      },
    });

    registerSessionHandlers({
      listSessions: async (filters) => {
        if (!this.sessionIndex) return [];
        return this.sessionIndex.list(filters);
      },
      getSession: async (key) => {
        if (!this.sessionIndex) return null;
        return this.sessionIndex.get(key);
      },
      patchSession: async (key, patch) => {
        this.sessionIndex?.patch(key, patch as any);
      },
      resetSession: async (key) => {
        this.transcriptStore?.clear(key);
      },
      deleteSession: async (key) => {
        this.sessionIndex?.delete(key);
        this.transcriptStore?.delete(key);
      },
      compactSession: async (key) => {
        if (!this.registry) {
          throw new Error('Registry not initialized');
        }
        const targetSession = this.registry.getSession(key);
        if (!targetSession?.agent) {
          throw new Error(`Session not found: ${key}`);
        }
        await targetSession.agent.submitOperation({ type: 'ManualCompact' }, {});
        return { status: 'compacted' };
      },
    });

    registerConfigHandlers();
    registerHealthHandlers();
    registerLogsHandlers();

    registerToolsHandlers({
      getToolCatalog: async () => {
        if (!this.registry) return [];
        // Aggregate tools from all sessions
        const allTools: Array<{ name: string; description: string }> = [];
        const seen = new Set<string>();
        const sessions = this.registry.listSessions();
        for (const s of sessions) {
          const agentSession = this.registry.getSession(s.sessionId);
          if (agentSession?.agent) {
            const registry = agentSession.agent.getToolRegistry();
            const tools = registry.listTools().map((t: any) => ({
              name: t.function?.name ?? t.name ?? 'unknown',
              description: t.function?.description ?? t.description ?? '',
            }));
            for (const tool of tools) {
              if (!seen.has(tool.name)) {
                seen.add(tool.name);
                allTools.push(tool);
              }
            }
          }
        }
        return allTools;
      },
    });

    registerExecHandlers({
      resolveApproval: async (id, decision, reason) => {
        return this.approvalManager?.resolveApproval(id, decision, reason) ?? false;
      },
    });

    registerCredentialsHandlers({
      setProviderApiKey: async (providerId, apiKey) => {
        const agentConfig = await AgentConfig.getInstance();
        return agentConfig.setProviderApiKey(providerId, apiKey);
      },
      deleteProviderApiKey: async (providerId) => {
        const agentConfig = await AgentConfig.getInstance();
        await agentConfig.deleteProviderApiKey(providerId);
      },
      listProviders: async () => {
        const agentConfig = await AgentConfig.getInstance();
        const providers = agentConfig.getProviders();
        return Object.entries(providers).map(([id, p]) => ({
          id,
          name: p.name,
          hasKey: p.apiKey === CREDENTIAL_SECURED_MARKER,
        }));
      },
    });

    console.log('[ServerAgentBootstrap] Method handlers registered');
  }

  /**
   * Initialize channel plugins.
   */
  private async initializePlugins(channelManager: ReturnType<typeof getChannelManager>): Promise<void> {
    this.pluginRegistry = new PluginRegistry();
    const config = getServerConfig();

    try {
      const definitions = await discoverPlugins();

      for (const definition of definitions) {
        const api = new ApplePiPluginApi();
        await definition.register(api);

        const registrations = api.getRegistrations();
        for (const reg of registrations) {
          const plugin = reg.plugin;
          this.pluginRegistry.register(definition, plugin);

          // Create a bridge per account
          const accountIds = plugin.config.listAccountIds(config.server.channels[plugin.id]);
          for (const accountId of accountIds) {
            const bridge = new ChannelPluginBridge(plugin, accountId);
            await channelManager.registerChannel(bridge);
            console.log(`[ServerAgentBootstrap] Plugin bridge registered: ${plugin.id}:${accountId}`);
          }
        }
      }

      console.log(`[ServerAgentBootstrap] ${this.pluginRegistry.size} plugin(s) initialized`);
    } catch (err) {
      console.warn('[ServerAgentBootstrap] Plugin initialization error:', err);
    }
  }

  /**
   * Configure PromptComposer for server mode.
   */
  private async configurePrompt(): Promise<void> {
    const os = await import('node:os');

    const staticContext: Partial<RuntimeContext> = {
      browserConnection: 'none',
      os: process.platform,
      arch: process.arch,
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      homeDir: os.homedir(),
    };

    configurePromptComposer('applepi-server', staticContext);
    console.log('[ServerAgentBootstrap] PromptComposer configured for server mode');
  }

  /**
   * Initialize the scheduler for server mode.
   */
  private async initializeScheduler(
    dataDir: string,
    channelManager: ReturnType<typeof getChannelManager>
  ): Promise<void> {
    try {
      // 1. Create new model storage (schedule events + executions)
      this.scheduleEventStorage = new ServerScheduleStorage(dataDir);
      await this.scheduleEventStorage.initialize();
      this.executionRecordStorage = new ServerExecutionStorage(dataDir);
      await this.executionRecordStorage.initialize();
      const executionStorage = this.executionRecordStorage;

      // 2. Create alarms (Node.js timers)
      this.schedulerAlarms = new ServerSchedulerAlarms();

      // 3. Create new model components directly
      const scheduleManager = new ScheduleManager(this.scheduleEventStorage, executionStorage, this.schedulerAlarms);
      const jobExecutor = new JobExecutor(executionStorage);

      // 4. Create scheduler with new constructor
      this.scheduler = new Scheduler(scheduleManager, jobExecutor, this.schedulerAlarms);

      // 5. Wire alarm handler -> scheduler.handleAlarm()
      this.schedulerAlarms.setAlarmHandler(async (alarmName) => {
        await this.scheduler!.handleAlarm(alarmName);
      });

      // 6. Wire event emitter -> unified channel dispatch
      this.scheduler.connectToChannel(() => channelManager, this.channel!.channelId);

      // 7. Wire job launcher -> submit job input to agent via registry
      this.scheduler.setJobLauncher(async (executionId, sessionId, registryAgent) => {
        console.log(`[ServerAgentBootstrap] Scheduled job ${executionId} launched (session: ${sessionId})`);
        const execution = await executionStorage.getExecution(executionId);
        if (!execution) {
          throw new Error(`Execution not found: ${executionId}`);
        }

        const targetAgent = registryAgent;
        if (!targetAgent) {
          throw new Error('No agent available — cannot execute scheduled job');
        }

        // submitOperation is fire-and-forget: it queues the operation, may abort
        // a previous task (emitting TurnAborted), and returns before the new task
        // completes. We set runningSchedulerJobId AFTER to avoid false-triggering
        // handleSchedulerEventCompletion on the previous task's TurnAborted event.
        await targetAgent.submitOperation(
          {
            type: 'UserInput',
            items: [{ type: 'text', text: execution.input }],
          },
          {}
        );
        this.runningSchedulerJobId = executionId;
        this.runningJobStartTime = Date.now();
      });

      // 7a. Connectivity check — ensure registry is initialized before executing jobs
      this.scheduler.setConnectivityCheck(() => this.registry !== null && this.initialized);

      // 7b. Wire registry for session isolation in scheduled jobs
      if (this.registry) {
        this.scheduler.setRegistry(this.registry);
        console.log('[ServerAgentBootstrap] AgentRegistry wired for scheduler session isolation');
      }

      // 8. Start queue processor
      await this.schedulerAlarms.startJobQueueProcessor();

      // 8b. Recover stale running jobs from previous server session
      await this.scheduler.recoverStaleRunningJob();

      // 9. Detect missed jobs
      const missed = await this.scheduler.detectMissedJobs();
      if (missed.length > 0) {
        console.log(`[ServerAgentBootstrap] Detected ${missed.length} missed scheduler instances`);
      }

      // 10. Restore alarms for ScheduleEvents
      await this.scheduler.restoreScheduleAlarms();

      // 11. Register handlers
      registerSchedulerHandlers({
        scheduler: this.scheduler,
      });

      console.log('[ServerAgentBootstrap] Scheduler initialized');
    } catch (error) {
      console.error('[ServerAgentBootstrap] Failed to initialize scheduler:', error);
      throw error;
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
        console.error(`[ServerAgentBootstrap] Failed to complete scheduler job ${jobId}:`, error);
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
        console.error(`[ServerAgentBootstrap] Failed to fail scheduler job ${jobId}:`, err);
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────

  getRegistry(): AgentRegistry | null {
    return this.registry;
  }

  getChannel(): ServerChannel | null {
    return this.channel;
  }

  getSessionIndex(): SessionIndex | null {
    return this.sessionIndex;
  }

  getTranscriptStore(): TranscriptStore | null {
    return this.transcriptStore;
  }

  getApprovalManager(): ApprovalManager | null {
    return this.approvalManager;
  }

  getPluginRegistry(): PluginRegistry | null {
    return this.pluginRegistry;
  }

  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Shutdown the server agent system.
   */
  async shutdown(): Promise<void> {
    console.log('[ServerAgentBootstrap] Shutting down...');

    // Stop config watcher
    stopWatchingConfig();

    // Stop health monitor
    this.healthMonitor?.stop();

    // Cancel pending approvals
    this.approvalManager?.cancelAll();

    // Shutdown scheduler
    this.schedulerAlarms?.shutdown();
    this.scheduleEventStorage?.close();
    this.executionRecordStorage?.close();

    // Stop backup manager
    this.backupManager?.stop();

    // Shutdown channel manager (shuts down all channels including plugin bridges)
    const channelManager = getChannelManager();
    await channelManager.shutdown();

    // Flush transcript store
    this.transcriptStore?.shutdown();

    // Close session index
    this.sessionIndex?.close();

    // Cleanup all sessions via registry
    if (this.registry) {
      await this.registry.cleanup();
      this.registry = null;
    }

    this.channel = null;
    this.initialized = false;
    console.log('[ServerAgentBootstrap] Shutdown complete');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Singleton access
// ─────────────────────────────────────────────────────────────────────────

export function getServerAgentBootstrap(): ServerAgentBootstrap {
  if (!_instance) {
    _instance = new ServerAgentBootstrap();
  }
  return _instance;
}

export async function initializeServerAgent(): Promise<ServerAgentBootstrap> {
  const bootstrap = getServerAgentBootstrap();
  await bootstrap.initialize();
  return bootstrap;
}
