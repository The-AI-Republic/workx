/**
 * Server Agent Bootstrap
 *
 * Main orchestrator for server mode. Creates RepublicAgent,
 * ServerChannel, ChannelManager, plugin loader, and maintenance timers.
 *
 * Pattern follows DesktopAgentBootstrap.
 *
 * @module server/agent/ServerAgentBootstrap
 */

import { ServerChannel } from '../channels/ServerChannel';
import { getChannelManager, type AgentHandler } from '@/core/channels/ChannelManager';
import { RepublicAgent } from '@/core/RepublicAgent';
import { AgentConfig } from '@/config/AgentConfig';
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
  private agent: RepublicAgent | null = null;
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

      // 3. Create RepublicAgent
      this.agent = new RepublicAgent(agentConfig);

      // 4. Configure PromptComposer with server platform context
      await this.configurePrompt();

      // 5. Create ServerChannel and wire up
      this.channel = new ServerChannel();
      const channelManager = getChannelManager();

      // Set agent handler
      const agentHandler: AgentHandler = async (op: Op, context: SubmissionContext) => {
        if (!this.agent) throw new Error('Agent not initialized');
        console.log('[ServerAgentBootstrap] Processing submission:', op.type);
        await this.agent.submitOperation(op, { tabId: context.tabId });
      };

      channelManager.setAgentHandler(agentHandler);
      await channelManager.registerChannel(this.channel);
      console.log('[ServerAgentBootstrap] Channel registered');

      // Wire event forwarding
      this.setupEventForwarding(channelManager);

      // 6. Initialize the agent
      await this.agent.initialize();
      console.log('[ServerAgentBootstrap] Agent initialized');

      // 6b. Register server-mode tools (browser MCP, planning, web search)
      try {
        const toolRegistry = this.agent.getToolRegistry();
        await registerServerTools(toolRegistry as any);
        console.log('[ServerAgentBootstrap] Server tools registered');
      } catch (err) {
        console.warn('[ServerAgentBootstrap] Tool registration failed (non-fatal):', err);
      }

      // 7. Initialize persistence
      this.sessionIndex = new SessionIndex(dataDir);
      await this.sessionIndex.initialize();
      console.log('[ServerAgentBootstrap] Session index initialized');

      this.transcriptStore = new TranscriptStore(dataDir);
      await this.transcriptStore.initialize();
      console.log('[ServerAgentBootstrap] Transcript store initialized');

      // 8. Initialize backup manager
      this.backupManager = new BackupManager(dataDir, config.server.backup.retention);
      this.backupManager.start();

      // 9. Initialize approval manager
      this.approvalManager = new ApprovalManager();

      // 9b. Initialize scheduler
      await this.initializeScheduler(dataDir, channelManager);

      // 10. Wire handshake snapshot providers
      setHandshakeSnapshotProviders({
        getSessionSummaries: async () => {
          if (!this.sessionIndex) return [];
          return this.sessionIndex.list({});
        },
      });

      // 11. Register method handlers
      this.registerHandlers();

      // 11. Initialize plugins
      await this.initializePlugins(channelManager);

      // 12. Start health monitoring
      this.healthMonitor = new HealthMonitor();
      this.healthMonitor.start();
      resetHealthStartTime();

      // Update health status
      const readyState = await this.agent.isReady();
      setHealthAgentStatus(readyState.ready);

      // Populate tool names for health endpoint
      try {
        const registry = this.agent.getToolRegistry();
        const tools = registry.listTools().map((t: any) => t.function?.name ?? t.name ?? 'unknown');
        setHealthAgentTools(tools);
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

      // 13. Start config file watcher
      watchConfig();
      onConfigReload((newConfig) => {
        console.log('[ServerAgentBootstrap] Config reloaded');
        // Hot-reload non-sensitive settings
        if (this.agent) {
          this.agent.refreshModelClient().catch((err) => {
            console.error('[ServerAgentBootstrap] Failed to refresh model client:', err);
          });
        }
      });

      // 14. Register service handlers on ChannelManager (message_routing_v2)
      await this.registerServices(channelManager);

      this.initialized = true;
      console.log('[ServerAgentBootstrap] Initialization complete');
    } catch (error) {
      console.error('[ServerAgentBootstrap] Initialization failed:', error);
      throw error;
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
      session: {
        getAgent: () => this.agent,
      },
      agent: {
        getAgent: () => this.agent,
      },
    });

    console.log(`[ServerAgentBootstrap] Registered ${count} service handlers`);
  }

  /**
   * Set up event forwarding from agent to channel.
   */
  private setupEventForwarding(channelManager: ReturnType<typeof getChannelManager>): void {
    if (!this.agent || !this.channel) return;

    this.agent.setEventDispatcher((event) => {
      // Dispatch to ServerChannel → WebSocket clients
      channelManager.dispatchEvent(event.msg, this.channel!.channelId).catch((error) => {
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
    });

    console.log('[ServerAgentBootstrap] Event forwarding configured');
  }

  /**
   * Register all method handlers.
   */
  private registerHandlers(): void {
    registerChatHandlers({
      submitOp: async (op, context) => {
        if (!this.agent) throw new Error('Agent not initialized');
        await this.agent.submitOperation(op, { tabId: context.tabId });
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
        // Trigger compaction on the agent
        if (this.agent) {
          await this.agent.submitOperation({ type: 'ManualCompact' }, {});
        }
        return { status: 'compacted' };
      },
    });

    registerConfigHandlers();
    registerHealthHandlers();
    registerLogsHandlers();

    registerToolsHandlers({
      getToolCatalog: async () => {
        if (!this.agent) return [];
        const registry = this.agent.getToolRegistry();
        return registry.listTools().map((t: any) => ({
          name: t.function?.name ?? t.name ?? 'unknown',
          description: t.function?.description ?? t.description ?? '',
        }));
      },
    });

    registerExecHandlers({
      resolveApproval: async (id, decision, reason) => {
        return this.approvalManager?.resolveApproval(id, decision, reason) ?? false;
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

    configurePromptComposer('applepi', staticContext);
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

      // 5. Wire alarm handler → scheduler.handleAlarm()
      this.schedulerAlarms.setAlarmHandler(async (alarmName) => {
        await this.scheduler!.handleAlarm(alarmName);
      });

      // 6. Wire event emitter → broadcast to WebSocket clients
      this.scheduler.setEventEmitter((event) => {
        if (this.channel) {
          channelManager.dispatchEvent(
            { type: 'scheduler.event', ...event } as any,
            this.channel.channelId
          ).catch((error) => {
            console.error('[ServerAgentBootstrap] Failed to dispatch scheduler event:', error);
          });
        }
      });

      // 7. Wire job launcher → submit job input to agent
      this.scheduler.setJobLauncher(async (executionId, sessionId, registryAgent) => {
        this.runningSchedulerJobId = executionId;
        this.runningJobStartTime = Date.now();
        console.log(`[ServerAgentBootstrap] Scheduled job ${executionId} launched (session: ${sessionId})`);
        const execution = await executionStorage.getExecution(executionId);
        if (!execution) {
          throw new Error(`Execution not found: ${executionId}`);
        }

        const targetAgent = registryAgent ?? this.agent;
        if (!targetAgent) {
          throw new Error('Agent not initialized — cannot execute scheduled job');
        }

        await targetAgent.submitOperation(
          {
            type: 'UserInput',
            items: [{ type: 'text', text: execution.input }],
          },
          {}
        );
      });

      // 7a. Connectivity check — ensure agent is initialized before executing jobs
      this.scheduler.setConnectivityCheck(() => this.agent !== null && this.initialized);

      // 7b. Initialize AgentRegistry for session isolation
      try {
        const agentConfig = await AgentConfig.getInstance();
        const registry = new AgentRegistry({
          maxConcurrent: 1,
          agentFactory: async (config) => {
            const agent = new RepublicAgent(config);
            await agent.initialize();
            return agent;
          },
          eventDispatcherFactory: (sessionId) => (event) => {
            // Forward events to WebSocket clients AND intercept completions
            channelManager.dispatchEvent(event.msg, this.channel!.channelId).catch(() => {});
            this.handleSchedulerEventCompletion(event.msg);
          },
        });
        registry.initialize(agentConfig);
        this.scheduler.setRegistry(registry);
        console.log('[ServerAgentBootstrap] AgentRegistry initialized for session isolation');
      } catch (error) {
        console.warn('[ServerAgentBootstrap] AgentRegistry init failed (non-fatal, using legacy sessions):', error);
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
        console.error(`[ServerAgentBootstrap] Failed to complete scheduler job ${jobId}:`, error);
      });
    } else if (msg.type === 'TaskFailed') {
      this.runningSchedulerJobId = null;
      this.runningJobStartTime = 0;
      const data = (msg as EventMsg & { data?: Record<string, any> }).data;
      const error = data?.error || data?.reason || 'Job failed';
      this.scheduler.failJob(jobId, error).catch((err) => {
        console.error(`[ServerAgentBootstrap] Failed to fail scheduler job ${jobId}:`, err);
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────

  getAgent(): RepublicAgent | null {
    return this.agent;
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

    // Cleanup agent
    if (this.agent) {
      await this.agent.cleanup();
      this.agent = null;
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
