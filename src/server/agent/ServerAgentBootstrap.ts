/**
 * Server Agent Bootstrap
 *
 * Main orchestrator for server mode. Creates AgentRegistry with
 * session-aware agent management, ServerChannel, ChannelManager,
 * connector loader, and maintenance timers.
 *
 * Pattern follows the extension service worker: no singleton agent,
 * all operations routed through AgentRegistry by sessionId.
 *
 * @module server/agent/ServerAgentBootstrap
 */

import { ServerChannel } from '../channels/ServerChannel';
import { getChannelManager, type AgentHandler } from '@/core/channels/ChannelManager';
import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import { RepublicAgent } from '@/core/RepublicAgent';
import { AgentConfig, CREDENTIAL_SECURED_MARKER } from '@/config/AgentConfig';
import { getConfigStorage, setConfigStorage } from '@/core/storage/ConfigStorageProvider';
import { getCredentialStore } from '@/core/storage';
import { AuthManager, type IAuthManager } from '@/core/models/types/Auth';
import { FileConfigStorageProvider } from '../storage/FileConfigStorageProvider';
import { configurePromptComposer } from '@/core/PromptLoader';
import type { RuntimeContext } from '@/prompts/PromptComposer';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';
import { deriveInputOrigin } from '@/core/input/types';
import type { EventMsg } from '@/core/protocol/events';

import { getServerConfig, loadServerConfig, watchConfig, stopWatchingConfig, onConfigReload } from '../config/server-config';
import {
  ManagedFileSource,
  ManagedDirSource,
  RemotePolicySource,
  registerPolicySources,
  resolveActivePolicy,
  onPolicyChanged,
  assessAndRecord,
  redactSecrets,
} from '@/core/config/policy';
import { SessionIndex } from '../persistence/SessionIndex';
import { TranscriptStore } from '../persistence/TranscriptStore';
import { BackupManager } from '../persistence/backup';
import { ApprovalManager } from '../exec/approval-manager';
import { ConnectorRegistry } from '../channel-connectors/connector-registry';
import { WorkXConnectorApi } from '../channel-connectors/workx-connector-api';
import { discoverConnectors } from '../channel-connectors/connector-loader';
import { ConnectorBridge } from '../channel-connectors/connector-bridge';
import { HealthMonitor } from '../health/health-monitor';
import { DiagnosticsMonitor } from '../health/diagnostics-monitor';
import type { DiagnosticContext } from '@/core/diagnostics';
import type { SkillRegistry as ISkillRegistry } from '@/core/skills/SkillRegistry';
import {
  setHealthAgentStatus,
  setHealthAgentTools,
  setHealthChannels,
  setHealthSessionCounts,
  resetHealthStartTime,
} from '../handlers/health';
import { setHandshakeSnapshotProviders } from '../connection/handshake';
import { registerServerTools } from '../tools/registerServerTools';
import { redactEventMsgSecrets } from '../security/eventRedaction';
import { schedulePeriodicSweep } from '../maintenance/toolResultCleanup';
import { RolloutRecorder } from '@/storage/rollout';
import { createSessionServices } from '@/core/session/state/SessionServices';
import { registerUseSkillTool } from '@/core/skills/registerUseSkillTool';
import { RuntimeStateController, accessStateFromReadyState } from '@/core/services/runtime-state';
import type { IMCPTool } from '@/core/mcp/types';

// Handler registrations
import { registerChatHandlers } from '../handlers/chat';
import { registerSessionHandlers } from '../handlers/sessions';
import { listUserTurns, computeRewindSlice, buildSummarizedFork } from '@/core/session/rewind';
import { CompactService } from '@/core/compact/CompactService';
import { registerConfigHandlers } from '../handlers/config';
import { registerHealthHandlers } from '../handlers/health';
import { registerToolsHandlers } from '../handlers/tools';
import { registerLogsHandlers } from '../handlers/logs';
import { installTelemetry, schedulerTelemetryTap } from '@/core/telemetry';
import { ServerLogSink } from '../telemetry/ServerLogSink';
import { registerExecHandlers } from '../handlers/exec';
import { registerSchedulerHandlers } from '../handlers/scheduler';
import { registerCredentialsHandlers } from '../handlers/credentials';
import { emitLog } from '../handlers/logs';

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

export interface ServerAgentBootstrapOptions {
  profile?: 'server' | 'desktop-runtime';
  dataDir?: string;
  channel?: ChannelAdapter;
}

// ─────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────

export class ServerAgentBootstrap {
  private registry: AgentRegistry | null = null;
  // Track 10: set in registerServices; read lazily by agentFactory to bind
  // per-session hook/agent plugin contributions. Null until services
  // register (the initial primary session, created before that, gets
  // global slots only — hooks/agents apply on the next session or
  // /plugin reload, matching claudy's asymmetric enable semantics).
  private pluginRegistry: import('@/core/plugins/PluginRegistry').PluginRegistry | null = null;
  private channel: ChannelAdapter | null = null;
  private sessionIndex: SessionIndex | null = null;
  private transcriptStore: TranscriptStore | null = null;
  private backupManager: BackupManager | null = null;
  private approvalManager: ApprovalManager | null = null;
  private connectorRegistry: ConnectorRegistry | null = null;
  private healthMonitor: HealthMonitor | null = null;
  private diagnosticsMonitor: DiagnosticsMonitor | null = null;
  private skillRegistry: ISkillRegistry | null = null;
  private scheduler: Scheduler | null = null;
  private scheduleEventStorage: any | null = null;
  private executionRecordStorage: any | null = null;
  private schedulerAlarms: ServerSchedulerAlarms | null = null;
  private runningSchedulerJobId: string | null = null;
  private runningJobStartTime: number = 0;
  private currentAuthManager: IAuthManager | null = null;
  private runtimeState: RuntimeStateController | null = null;
  private toolResultSweep: { stop: () => void } | null = null;
  private desktopHubMcpEventHooked = false;
  private desktopHubRegisteredToolsBySession = new Map<string, IMCPTool[]>();
  // Track 15: periodic rollout TTL cleanup (the server otherwise never prunes
  // expired/forked rollouts — only the extension had alarm-based cleanup).
  private rolloutTtlSweep: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(private readonly options: ServerAgentBootstrapOptions = {}) {}

  /**
   * Initialize the server agent system.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('[ServerAgentBootstrap] Already initialized');
      return;
    }

    console.log('[ServerAgentBootstrap] Initializing...');
    // NOTE: getServerConfig() is intentionally deferred until AFTER the
    // Track 20 policy block below. The first call memoizes the pinned config,
    // so calling it here would cache a config with NO admin policy applied.
    const profile = this.options.profile ?? 'server';
    const dataDir = this.options.dataDir ?? process.env.WORKX_DATA_DIR ??
      `${process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'}/.workx-server/data`;

    try {
      // 0. Initialize StorageProvider (used by subsystems)
      const { isStorageProviderInitialized, initializeStorageProvider, isCredentialStoreInitialized, initializeCredentialStore } = await import('@/core/storage');
      if (!isStorageProviderInitialized()) {
        await initializeStorageProvider();
        console.log('[ServerAgentBootstrap] StorageProvider initialized (SQLite)');
      }

      // 0a. Initialize TokenUsageStore with NodeSQLiteAdapter
      try {
        const { NodeSQLiteAdapter } = profile === 'desktop-runtime'
          ? await import('@/desktop-runtime/storage/DesktopRuntimeSQLiteAdapter').then((m) => ({ NodeSQLiteAdapter: m.DesktopRuntimeSQLiteAdapter }))
          : await import('@/server/storage/NodeSQLiteAdapter');
        const { TokenUsageStore } = await import('@/storage/TokenUsageStore');
        const tokenAdapter = profile === 'desktop-runtime'
          ? new NodeSQLiteAdapter((await import('@/desktop-runtime/host')).getDesktopRuntimeHost().storageDbPath)
          : new NodeSQLiteAdapter(dataDir);
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
      if (profile === 'desktop-runtime') {
        const { getDesktopRuntimeHost } = await import('@/desktop-runtime/host');
        const { DesktopRuntimeConfigStorageProvider } = await import('@/desktop-runtime/storage/DesktopRuntimeConfigStorageProvider');
        setConfigStorage(new DesktopRuntimeConfigStorageProvider(getDesktopRuntimeHost().configJsonPath));
      } else {
        setConfigStorage(new FileConfigStorageProvider(dataDir));
      }

      // 1b. Track 20: register the managed-file policy source (fleet policy is
      // mounted via ConfigMap/Secret at WORKX_POLICY_PATH) and resolve it
      // BEFORE the first getServerConfig() / AgentConfig.getInstance() so both
      // config systems' first hydration already sees admin policy. Fail-open.
      try {
        registerPolicySources([
          // Fleet remote path is highest precedence (first-wins), then the
          // ConfigMap/Secret-mounted managed file.
          new RemotePolicySource(),
          new ManagedFileSource(process.env.WORKX_POLICY_PATH),
          new ManagedDirSource(),
        ]);
        await resolveActivePolicy();
        console.log('[ServerAgentBootstrap] Managed policy resolved');
      } catch (error) {
        console.warn('[ServerAgentBootstrap] Managed policy resolution failed (non-fatal):', error);
      }

      // 1c. First server-config read — now memoizes the policy-pinned config
      // (server.* tier). Must come after the policy block above.
      const config = getServerConfig();

      // 2. Get agent config
      const agentConfig = await AgentConfig.getInstance();

      // 2b. Centralized telemetry: live privacy gate + the server sink
      // (existing emitLog → stdout + logs.tail; zero new transport).
      // No-op unless preferences.telemetryEnabled is true (read live).
      installTelemetry({
        getTelemetryEnabled: () =>
          agentConfig.getConfig().preferences?.telemetryEnabled,
        sink: ServerLogSink,
      });

      // 3. Configure PromptComposer with server platform context
      // (must happen before agent.initialize() inside agentFactory)
      await this.configurePrompt();

      // 4. Create ServerChannel and wire up
      this.channel = this.options.channel ?? new ServerChannel();
      const channelManager = getChannelManager();

      // 5. Create AgentRegistry with factories
      const { join } = await import('node:path');
      const serverRootDir = join(dataDir, 'sessions');
      this.registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory: async (cfg, initialHistory) => {
          const platformAdapter = profile === 'desktop-runtime'
            ? new (await import('@/desktop-runtime/platform/DesktopRuntimePlatformAdapter')).DesktopRuntimePlatformAdapter()
            : new (await import('../platform/ServerPlatformAdapter')).ServerPlatformAdapter();
          const services = await createSessionServices({
            serverRootDir,
          }, false);
          const agent = new RepublicAgent(cfg, platformAdapter, initialHistory, undefined, undefined, services);
          await agent.initialize();
          if (this.currentAuthManager) {
            agent.getModelClientFactory().setAuthManager(this.currentAuthManager);
            await agent.refreshModelClient();
          }

          if (profile === 'desktop-runtime') {
            await this.ensureDesktopRuntimeHubMcpConnected();
          }

          if (profile === 'server') {
            // Register server-mode tools on each new agent. Pass `dataDir` so
            // the track-09 read_persisted_result tool can be rooted at the
            // same directory that FileToolResultStore writes into.
            try {
              const toolRegistry = agent.getToolRegistry();
              await registerServerTools(toolRegistry as any, dataDir);
              console.log('[ServerAgentBootstrap] Server tools registered on new session agent');
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.warn('[ServerAgentBootstrap] Tool registration failed (non-fatal):', err);
              agent.getEngine()?.pushEvent({
                id: crypto.randomUUID(),
                msg: { type: 'BackgroundEvent', data: { message: `Server tool registration failed: ${errMsg}`, level: 'error' } },
              });
            }
          }

          await this.registerSkillsToolOnAgent(agent);

          // Register sub-agent tool
          const engine = agent.getEngine();
          if (engine) {
            try {
              const { registerSubAgentTool } = await import('@/tools/AgentTool/register');
              const subAgentRunner = await registerSubAgentTool(engine);
              if (this.skillRegistry) {
                this.skillRegistry.setValidationContextProvider(() => ({
                  knownAgents: subAgentRunner.getTypes().map((t) => t.id),
                }));
              }
              console.log('[ServerAgentBootstrap] sub_agent tool registered');

              // Track 10: bind this session's hook + sub-agent registries to
              // currently-enabled plugins. Skills + MCP are global (handled
              // by the global PluginRegistry's slot loaders); hooks + agents
              // are per-session and bound here.
              if (this.pluginRegistry) {
                try {
                  const { PluginSessionBinder } = await import('@/core/plugins/PluginSessionBinder');
                  const { nodeReadFile, nodeListDirs } = await import('@/server/storage/nodePluginFs');
                  const binder = new PluginSessionBinder({
                    hookRegistry: agent.getHookRegistry(),
                    subAgentRunner,
                    readFile: nodeReadFile,
                    listDirs: nodeListDirs,
                  });
                  const enabled = this.pluginRegistry
                    .getPlugins()
                    .filter((p) => p.state.status === 'enabled');
                  await binder.applyEnabledPlugins(enabled);
                  // Register so a later /plugin disable prunes this session
                  // immediately (claudy gh-36995). Teardown on session end is
                  // a documented follow-up; a stale binder for an ended
                  // session is a harmless no-op on prune.
                  this.pluginRegistry.registerSessionBinder(binder);
                } catch (bindErr) {
                  console.warn('[ServerAgentBootstrap] plugin session bind failed (non-fatal):', bindErr);
                }
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.warn('[ServerAgentBootstrap] sub_agent tool registration failed (non-fatal):', err);
              engine.pushEvent({
                id: crypto.randomUUID(),
                msg: { type: 'BackgroundEvent', data: { message: `Sub-agent tool registration failed: ${errMsg}`, level: 'error' } },
              });
            }
          }

          // Track 23: x402 capability — headless server FAILS CLOSED.
          // ApprovalGate is NOT constructed on the server (verified), so
          // safety is an EXPLICIT default-deny allowlist policy from
          // server.x402 — never an approval timeout. No policy / not
          // allowlisted / over cap ⇒ deny + audit. Real signing is Phase-4
          // gated (coinbase/x402 SDK).
          try {
            const toolRegistry = agent.getToolRegistry();
            const {
              createPaymentCapability,
              CoinbaseX402Signer,
              PaymentKeyStore,
              evaluateServerPolicy,
            } = await import('@/core/payments/x402');
            const { getServerConfig } = await import('../config/server-config');
            const { emitLog } = await import('../handlers/logs');

            const keyStore = new PaymentKeyStore();
            const signer = new CoinbaseX402Signer(
              () => keyStore.getPrivateKey(),
              async () => {
                throw new Error('x402 address derivation is Phase-4 gated (coinbase/x402 SDK)');
              },
            );

            const x402 = () => getServerConfig().server.x402;

            toolRegistry.setPaymentCapability(
              createPaymentCapability({
                platform: 'server',
                isEnabled: async () => x402().enabled === true,
                getCaps: async () => {
                  const cfg = x402();
                  return {
                    network: cfg.network,
                    // Per-request cap is owned by the allowlist policy below
                    // (per payee domain); the generic limit is not the gate.
                    maxPaymentPerRequestUSD: Number.POSITIVE_INFINITY,
                    maxSessionSpendUSD: cfg.maxSessionSpendUSD,
                  };
                },
                signer,
                // Explicit default-deny allowlist (Track 20 stand-in) — pure,
                // unit-tested evaluateServerPolicy. sessionSpentUSD is the
                // per-day approximation pending Phase 4.
                serverPolicy: (amountUSD, resourceUrl, sessionSpentUSD) => {
                  const cfg = x402();
                  return evaluateServerPolicy(
                    { allowlist: cfg.allowlist, maxPerDayUSD: cfg.maxPerDayUSD },
                    amountUSD,
                    resourceUrl,
                    sessionSpentUSD,
                  );
                },
                audit: (level, message, data) =>
                  emitLog(level, `[x402] ${message}`, data),
              }),
            );
            console.log('[ServerAgentBootstrap] x402 capability wired (default-deny)');
          } catch (err) {
            console.warn('[ServerAgentBootstrap] x402 capability wiring failed (non-fatal):', err);
          }

          return agent;
        },
        eventDispatcherFactory: (sessionId) => (event) => {
          // Dispatch to ServerChannel -> WebSocket clients with sessionId
          channelManager.dispatchEvent({ msg: event.msg, sessionId }, this.channel!.channelId).catch((error) => {
            console.error('[ServerAgentBootstrap] Failed to dispatch event:', error);
          });

          // Also log to transcript store (Track 24.5: secret-redacted at rest —
          // non-blocking, the entry is kept, only detected secrets become ***).
          if (this.transcriptStore) {
            const redactedMsg = redactEventMsgSecrets(event.msg);
            this.transcriptStore.append('__active__', {
              ts: Date.now(),
              type: redactedMsg.type,
              data: redactedMsg,
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
        // Track 13: thread channel origin so the input funnel can apply the
        // bridge-safe slash gate (connector input must not leak raw /config).
        await targetSession.agent.submitOperation(op, {
          tabId: context.tabId,
          origin: deriveInputOrigin(context),
        });
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
      if (profile === 'server') {
        this.backupManager = new BackupManager(dataDir, config.server.backup.retention);
        this.backupManager.start();
      }

      // 9b. Schedule TTL sweep for persisted tool results (track 09).
      // Removes orphaned tool-result files from crashed sessions.
      this.toolResultSweep = schedulePeriodicSweep(dataDir);
      console.log('[ServerAgentBootstrap] Tool-result TTL sweep scheduled');

      // 9c. Track 15: periodic rollout TTL cleanup. Without this the server
      // never prunes expired/forked rollouts (every rewind makes a new one).
      const ROLLOUT_TTL_SWEEP_MS = 6 * 60 * 60 * 1000; // 6h
      const sweepRollouts = () =>
        RolloutRecorder.cleanupExpired()
          .then((n) => {
            if (n > 0) console.log(`[ServerAgentBootstrap] Pruned ${n} expired rollout(s)`);
          })
          .catch((e) => console.error('[ServerAgentBootstrap] Rollout TTL cleanup failed:', e));
      void sweepRollouts();
      this.rolloutTtlSweep = setInterval(sweepRollouts, ROLLOUT_TTL_SWEEP_MS);
      // Don't keep the process alive solely for the sweep.
      (this.rolloutTtlSweep as { unref?: () => void }).unref?.();
      console.log('[ServerAgentBootstrap] Rollout TTL sweep scheduled');

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

      // 12b. Initialize connectors
      if (profile === 'server') {
        await this.initializeConnectors(channelManager);
      }

      // 13. Start health monitoring
      if (profile === 'server') {
        this.healthMonitor = new HealthMonitor();
        this.healthMonitor.start();
        resetHealthStartTime();
      }

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
      if (profile === 'server') {
        watchConfig();
        onConfigReload((_newConfig) => {
          console.log('[ServerAgentBootstrap] Config reloaded');
          // Hot-reload: iterate all sessions for refreshModelClient
          this.handleConfigUpdate().catch((err) => {
            console.error('[ServerAgentBootstrap] Failed to handle config update:', err);
          });
        });
      }

      // Track 20: a remote/managed-file policy change re-resolves the policy.
      // Headless server has no interactive user — auto-apply, but emit a
      // REDACTED audit (warn if it weakens security) so operators see it in
      // the logs.tail stream they already watch. Then re-hydrate so the pin
      // re-applies fleet-wide without a restart.
      onPolicyChanged((p) => {
        const a = assessAndRecord(p);
        emitLog(
          a.weakened ? 'warn' : 'info',
          'managed policy applied',
          redactSecrets({
            origin: p?.origin ?? null,
            lockedKeys: p?.lockedKeys ?? [],
            changedKeys: a.changedKeys,
            weakened: a.weakened,
            reasons: a.reasons,
          })
        );
        // Re-pin the server.* tier: AgentConfig.reload() (in handleConfigUpdate)
        // only re-hydrates the agent.* config. Without this, a post-boot policy
        // change would never reach the memoized server config.
        try {
          loadServerConfig();
        } catch (err) {
          console.error('[ServerAgentBootstrap] Failed to re-pin server config on policy change:', err);
        }
        this.handleConfigUpdate().catch((err) => {
          console.error('[ServerAgentBootstrap] Failed to apply policy change:', err);
        });
      });

      // 15. Register service handlers on ChannelManager (message_routing_v2)
      await this.registerServices(channelManager);

      // 15b. Start diagnostics monitoring so GET /health reports a truthful
      // status for K8s/Docker probes (Track 17). Started after registerServices
      // so the first report sees the fully-wired context.
      if (profile === 'server') {
        this.diagnosticsMonitor = new DiagnosticsMonitor(() =>
          this.buildDiagnosticContext(),
        );
        this.diagnosticsMonitor.start();
      }

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

  private async registerSkillsToolOnAgent(agent: RepublicAgent): Promise<void> {
    if (!this.skillRegistry) return;
    await registerUseSkillTool({
      toolRegistry: agent.getToolRegistry(),
      hookRegistry: agent.getHookRegistry(),
      skillRegistry: this.skillRegistry,
      getTurnContext: () => agent.getSession().getTurnContext(),
    });
  }

  /**
   * Register service handlers on ChannelManager (message_routing_v2).
   * Gives server mode full service parity with the extension.
   */
  private async registerServices(channelManager: ReturnType<typeof getChannelManager>): Promise<void> {
    const { registerAllServices } = await import('@/core/services');
    const serviceRegistry = channelManager.getServiceRegistry();
    const profile = this.options.profile ?? 'server';
    const platformScope = profile === 'desktop-runtime' ? 'desktop' : 'server';
    const agentConfigForSnapshot = await AgentConfig.getInstance();
    const runtimeState = profile === 'desktop-runtime'
      ? this.getOrCreateRuntimeState(channelManager, agentConfigForSnapshot)
      : undefined;

    // Get MCPManager instance
    let mcpDeps: import('@/core/services').MCPServiceDeps | undefined;
    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const mcpManager = await MCPManager.getInstance(platformScope);
      if (profile === 'desktop-runtime') {
        mcpManager.setSessionTokenProvider(async () => getCredentialStore().get('auth', 'access_token'));
      }
      mcpDeps = { mcpManager: mcpManager as any };
    } catch (error) {
      console.warn('[ServerAgentBootstrap] MCPManager not available for service registration:', error);
    }

    // Get A2AManager instance
    let a2aDeps: import('@/core/services').A2AServiceDeps | undefined;
    try {
      const { A2AManager } = await import('@/core/a2a/A2AManager');
      const a2aManager = await A2AManager.getInstance(platformScope);
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
      this.skillRegistry = skillRegistry;
      if (this.registry) {
        for (const meta of this.registry.listSessions()) {
          const agent = this.registry.getSession(meta.sessionId)?.agent;
          if (agent) {
            await this.registerSkillsToolOnAgent(agent);
          }
        }
      }

      console.log(`[ServerAgentBootstrap] Skills initialized, found ${skillRegistry.getSkillMetas().length} skills`);
    } catch (error) {
      console.warn('[ServerAgentBootstrap] SkillRegistry not available for service registration:', error);
    }

    // Track 10: plugin registry. Server v1 wires the globally-reachable
    // slots — skills (the same SkillRegistry the skills service uses) and
    // MCP (the singleton MCPManager). Hooks / agents / commands are
    // per-session (created in agentFactory) and propagate via a documented
    // follow-up; PluginRegistry surfaces them as capability gaps for now.
    let pluginsDeps: import('@/core/services').PluginsServiceDeps | undefined;
    try {
      const os = await import('node:os');
      const path = await import('node:path');
      const { NodePluginProvider } = await import('@/server/storage/NodePluginProvider');
      const { nodeReadFile, nodeListDirs } = await import('@/server/storage/nodePluginFs');
      const { PluginRegistry } = await import('@/core/plugins/PluginRegistry');
      const { SkillSlotLoader } = await import('@/core/plugins/loaders/SkillSlotLoader');
      const { McpSlotLoader } = await import('@/core/plugins/loaders/McpSlotLoader');
      const { AgentConfig } = await import('@/config/AgentConfig');

      const pluginsRoot = path.join(os.homedir(), '.workx', 'plugins');
      const provider = new NodePluginProvider(pluginsRoot);
      await provider.initialize();

      const agentConfig = await AgentConfig.getInstance();

      // Phase 10c: admin policy (read once, cached). /etc/workx/policy.json
      // (Linux/Mac) or %ProgramData%\WorkX\policy.json (Windows). Missing/
      // corrupt → empty policy. Built HERE (before bootstrapEnabledPlugins +
      // MarketplaceRegistry) so block / force-enable / source guards apply.
      const {
        PolicyLoader,
        PluginPolicy,
        isSourceAllowedByPolicy,
        isBlockedOfficialName,
        validateOfficialNameSource,
      } = await import('@/core/plugins/policy');
      const policyPath =
        process.platform === 'win32'
          ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'WorkX', 'policy.json')
          : '/etc/workx/policy.json';
      const policyLoader = new PolicyLoader({
        readPolicyText: async () => {
          try {
            const fsmod = await import('node:fs');
            return await fsmod.promises.readFile(policyPath, 'utf-8');
          } catch {
            return null;
          }
        },
      });
      const pluginPolicy = new PluginPolicy(policyLoader);

      const registry = new PluginRegistry({
        provider,
        skillSlot: skillsDeps
          ? new SkillSlotLoader({
              skillRegistry: skillsDeps.skillRegistry as never,
              readFile: nodeReadFile,
              listDirs: nodeListDirs,
            })
          : undefined,
        mcpSlot: mcpDeps
          ? new McpSlotLoader(mcpDeps.mcpManager as never)
          : undefined,
        // hooks / agents / commands: per-session (agentFactory) — follow-up
        getEnabledFromConfig: () => agentConfig.getConfig().enabledPlugins ?? {},
        persistEnabled: async (id, enabled) => {
          const current = agentConfig.getConfig().enabledPlugins ?? {};
          agentConfig.updateConfig({
            enabledPlugins: { ...current, [id]: enabled },
          });
        },
        checkDestructiveOpAllowed: (op) => {
          // Refuse reload while any background sub-agent task is running
          // (design § Active-Session Semantics Rule 3).
          if (op !== 'reload' || !this.registry) return null;
          for (const s of this.registry.listSessions()) {
            const agentSession = this.registry.getSession(s.sessionId);
            const active =
              agentSession?.agent?.getSession?.()?.listActiveTasks?.() ?? [];
            if (active.length > 0) {
              return `Cannot reload: ${active.length} background task(s) running. /task stop <id> first.`;
            }
          }
          return null;
        },
      });

      // Discover + register from disk
      const metas = await provider.listMeta();
      for (const m of metas) {
        try {
          registry.register(await provider.load(`${m.name}@local`));
        } catch (e) {
          console.warn(`[ServerAgentBootstrap] plugin load ${m.name} failed:`, e);
        }
      }
      // Phase 10c: enforce admin policy on the enabled set BEFORE bootstrap
      // — `enabledPlugins[id] === false` blocks, `=== true` force-enables
      // (and locks; the runtime enable guard + reconcile keep it pinned).
      try {
        const pol = await policyLoader.load();
        const pinned = pol.enabledPlugins ?? {};
        if (Object.keys(pinned).length > 0) {
          const cur = agentConfig.getConfig().enabledPlugins ?? {};
          const next = { ...cur };
          let changed = false;
          for (const [pid, want] of Object.entries(pinned)) {
            if (next[pid] !== want) {
              next[pid] = want;
              changed = true;
            }
          }
          if (changed) agentConfig.updateConfig({ enabledPlugins: next });
        }
      } catch (e) {
        console.warn('[ServerAgentBootstrap] policy enabled-set enforcement failed:', e);
      }
      await registry.bootstrapEnabledPlugins();

      // React to external enabledPlugins mutations (settings UI / policy)
      agentConfig.on('config-changed', (e: { section?: string }) => {
        if (e.section === 'enabledPlugins') {
          void registry.reconcileFromConfig();
        }
      });

      // Phase 10b: marketplace + git-based install/uninstall (server has
      // system git). Marketplace catalogue is fetched via a shallow clone
      // into a temp dir, then marketplace.json read out.
      const { MarketplaceRegistry } = await import('@/core/plugins/MarketplaceRegistry');
      const { PluginInstaller, PluginUninstaller } = await import('@/core/plugins/PluginInstaller');
      const { InstalledPluginsStore } = await import('@/core/plugins/installedPlugins');
      const { createGitFetchPlugin } = await import('@/core/plugins/pluginFetch');
      const {
        nodeGitRunner, nodeMkTempDir, nodeWalkFiles, nodeReadBytes,
        nodeRemoveDir, nodeResolveHeadSha,
      } = await import('@/server/storage/nodeGitRunner');
      const nodePath = await import('node:path');

      const marketplaces = new MarketplaceRegistry({
        fetchCatalogue: async (sourceRef: string) => {
          const tmp = await nodeMkTempDir();
          try {
            const { gitClone } = await import('@/core/plugins/git');
            await gitClone(nodeGitRunner, { url: sourceRef, targetPath: tmp });
            const raw = await nodeReadBytes(nodePath.join(tmp, 'marketplace.json'));
            return new TextDecoder().decode(raw);
          } finally {
            await nodeRemoveDir(tmp).catch(() => undefined);
          }
        },
        // Phase 10c: admin source allow/blocklist — refuses BEFORE the
        // network fetch above ever runs.
        checkSource: async (sourceRef: string) => {
          const pol = await policyLoader.load();
          return isSourceAllowedByPolicy(sourceRef, pol)
            ? null
            : `marketplace source blocked by org policy: ${sourceRef}`;
        },
        // Reserved-official-name / homograph impersonation guard (runs
        // after parse, on the catalogue's declared name).
        checkName: (name: string, sourceRef: string) => {
          if (isBlockedOfficialName(name)) {
            return `marketplace name "${name}" is reserved or uses a non-ASCII homograph (impersonation guard)`;
          }
          const v = validateOfficialNameSource(name, sourceRef);
          return v.ok
            ? null
            : `marketplace "${name}" must originate from the official org (${v.reason})`;
        },
      });

      const installedStore = new InstalledPluginsStore({
        readText: async (p: string) => {
          try {
            return new TextDecoder().decode(await nodeReadBytes(p));
          } catch {
            return null;
          }
        },
        writeText: async (p: string, c: string) => {
          const fsmod = await import('node:fs');
          await fsmod.promises.mkdir(nodePath.dirname(p), { recursive: true });
          await fsmod.promises.writeFile(p, c, 'utf-8');
        },
        filePath: nodePath.join(os.homedir(), '.workx', 'installed_plugins_v2.json'),
      });

      const fetchPlugin = createGitFetchPlugin(
        {
          run: nodeGitRunner,
          mkTempDir: nodeMkTempDir,
          walkFiles: nodeWalkFiles,
          readBytes: nodeReadBytes,
          removeDir: nodeRemoveDir,
          resolveHeadSha: nodeResolveHeadSha,
        },
        (id) => marketplaces.lookup(id)?.entry ?? null,
      );

      // (policyLoader / pluginPolicy were built earlier — before
      // bootstrapEnabledPlugins — so the same instance governs install,
      // marketplace add, autoupdate, and the boot-time enabled set.)
      const installer = new PluginInstaller({
        marketplaces,
        provider,
        installed: installedStore,
        registry,
        fetchPlugin,
        isBlockedByPolicy: (id) => pluginPolicy.isBlocked(id),
        setEnabled: async (ids, en) => {
          const cur = agentConfig.getConfig().enabledPlugins ?? {};
          const next = { ...cur };
          for (const i of ids) next[i] = en;
          agentConfig.updateConfig({ enabledPlugins: next });
        },
        getAlreadyEnabled: () =>
          new Set(
            Object.entries(agentConfig.getConfig().enabledPlugins ?? {})
              .filter(([, v]) => v === true)
              .map(([k]) => k),
          ),
      });

      // review B2/B3: uninstall must orphan-mark (not hard-delete); the
      // 7-day GC sweep removes dirs later. Wire a PluginCache over Node fs.
      const { PluginCache } = await import('@/core/plugins/PluginCache');
      const fsmod = await import('node:fs');
      const pluginCache = new PluginCache(
        nodePath.join(os.homedir(), '.workx'),
        {
          readText: async (p: string) => {
            try {
              return await fsmod.promises.readFile(p, 'utf-8');
            } catch {
              return null;
            }
          },
          writeText: async (p: string, c: string) => {
            await fsmod.promises.mkdir(nodePath.dirname(p), { recursive: true });
            await fsmod.promises.writeFile(p, c, 'utf-8');
          },
          removeDir: nodeRemoveDir,
          removeFile: async (p: string) => {
            await fsmod.promises.rm(p, { force: true });
          },
          listEntries: async (p: string) => {
            try {
              return await fsmod.promises.readdir(p);
            } catch {
              return [];
            }
          },
          pathExists: async (p: string) => {
            try {
              await fsmod.promises.stat(p);
              return true;
            } catch {
              return false;
            }
          },
        },
      );

      const uninstaller = new PluginUninstaller({
        provider,
        installed: installedStore,
        registry,
        markOrphaned: (installPath: string) =>
          pluginCache.markOrphaned(installPath),
        setEnabled: async (ids, en) => {
          const cur = agentConfig.getConfig().enabledPlugins ?? {};
          const next = { ...cur };
          for (const i of ids) next[i] = en;
          agentConfig.updateConfig({ enabledPlugins: next });
        },
      });

      // Phase 10c: one-shot, fire-and-forget autoupdate + delisting sweep.
      // Re-checks policy before re-materializing; delisting routes through
      // the safe uninstaller (disable → orphan-mark, never a hard-delete).
      try {
        const { PluginAutoupdate } = await import('@/core/plugins/PluginAutoupdate');
        const autoupdate = new PluginAutoupdate({
          marketplaces,
          installed: installedStore,
          provider,
          fetchPlugin,
          autoUpdateMarketplaces: () => marketplaces.list().map((m) => m.name),
          refreshMarketplace: async (name: string) => {
            const m = marketplaces.list().find((x) => x.name === name);
            if (m) await marketplaces.add(m.sourceRef);
          },
          isBlockedByPolicy: (id) => pluginPolicy.isBlocked(id),
          uninstall: (id, scope) => uninstaller.uninstall(id, scope),
        });
        void autoupdate.run().then(
          (r) => {
            if (r.updated.length || r.delisted.length) {
              console.log(
                `[ServerAgentBootstrap] autoupdate: ${r.updated.length} updated, ${r.delisted.length} delisted`,
              );
            }
          },
          (e) => console.warn('[ServerAgentBootstrap] autoupdate failed:', e),
        );
      } catch (e) {
        console.warn('[ServerAgentBootstrap] autoupdate wiring failed:', e);
      }

      pluginsDeps = {
        pluginRegistry: registry,
        marketplaces,
        installer,
        uninstaller,
        isBlockedByPolicy: (id) => pluginPolicy.isBlocked(id),
      };
      // Expose to agentFactory so sessions created after this point bind
      // their per-session hook + sub-agent registries to enabled plugins.
      this.pluginRegistry = registry;
      console.log(
        `[ServerAgentBootstrap] PluginRegistry initialized (${metas.length} plugin(s) discovered)`,
      );
    } catch (error) {
      console.warn('[ServerAgentBootstrap] PluginRegistry not available:', error);
    }

    // Track 43: ChatGPT OAuth lives in the runtime after the cutover. The
    // 127.0.0.1:1455 callback HTTP server, the token storage, and the PKCE
    // exchange all happen here; the UI just calls `auth.chatgpt.*` services.
    let chatgptFlow:
      | InstanceType<typeof import('@/desktop-runtime/auth/RuntimeChatGPTOAuthFlow').RuntimeChatGPTOAuthFlow>
      | undefined;
    let chatgptStorage:
      | InstanceType<typeof import('@/desktop-runtime/auth/RuntimeChatGPTOAuthStorage').RuntimeChatGPTOAuthStorage>
      | undefined;
    if (profile === 'desktop-runtime') {
      try {
        const { RuntimeChatGPTOAuthFlow } = await import('@/desktop-runtime/auth/RuntimeChatGPTOAuthFlow');
        const { RuntimeChatGPTOAuthStorage } = await import('@/desktop-runtime/auth/RuntimeChatGPTOAuthStorage');
        chatgptStorage = new RuntimeChatGPTOAuthStorage(() => getCredentialStore());
        chatgptFlow = new RuntimeChatGPTOAuthFlow(chatgptStorage);
      } catch (e) {
        console.warn('[ServerAgentBootstrap] ChatGPT runtime auth wiring failed:', e);
      }
    }

    const count = registerAllServices(serviceRegistry, {
      mcp: mcpDeps,
      a2a: a2aDeps,
      skills: skillsDeps,
      plugins: pluginsDeps,
      scheduler: this.scheduler ? { scheduler: this.scheduler } : undefined,
      storage: { configStorage: getConfigStorage() },
      session: this.registry ? { registry: this.registry } : undefined,
      agent: this.registry ? {
        registry: this.registry,
        handleConfigUpdate: () => this.handleConfigUpdate(),
        createAuthManager: profile === 'desktop-runtime'
          ? (shouldUseBackend, backendBaseUrl) => {
              const tokenGetter = shouldUseBackend
                ? async () => getCredentialStore().get('auth', 'access_token')
                : undefined;
              const urls = runtimeState?.getUrls();
              const gatewayLlmBaseUrl = urls?.llmRoutingMode === 'ai-hub' ? urls.aiHubLlmApiUrl : null;
              return new AuthManager(shouldUseBackend, backendBaseUrl, tokenGetter, { gatewayLlmBaseUrl });
            }
          : undefined,
        setAuthManager: profile === 'desktop-runtime' ? (authManager) => {
          this.currentAuthManager = authManager;
        } : undefined,
        runtimeState,
      } : undefined,
      // Track 43: runtime-owned auth services (auth.completeLogin / getState /
      // logout + ChatGPT OAuth). Desktop runtime only — server mode handles
      // auth differently.
      auth: profile === 'desktop-runtime' && this.registry ? {
        registry: this.registry,
        createAuthManager: (shouldUseBackend, backendBaseUrl) => {
          const tokenGetter = shouldUseBackend
            ? async () => getCredentialStore().get('auth', 'access_token')
            : undefined;
          const urls = runtimeState?.getUrls();
          const gatewayLlmBaseUrl = urls?.llmRoutingMode === 'ai-hub' ? urls.aiHubLlmApiUrl : null;
          return new AuthManager(shouldUseBackend, backendBaseUrl, tokenGetter, { gatewayLlmBaseUrl });
        },
        setAuthManager: (authManager) => {
          this.currentAuthManager = authManager;
        },
        getCredentialStore: () => getCredentialStore(),
        runtimeState,
        refreshAccessState: () => this.refreshDesktopRuntimeAccessState(),
        afterLogin: () => this.ensureDesktopRuntimeHubMcpConnected(),
        afterLogout: () => this.disconnectDesktopRuntimeHubMcp(),
        // The runtime owns the access token after cutover; the UI must not
        // receive it. The runtime performs the profile fetch itself and
        // returns only the redacted profile shape the UI needs.
        fetchUserProfile: async (accessToken: string) => {
          try {
            const { fetchUserProfileServerSide } = await import('@/desktop-runtime/auth/runtimeProfileFetch');
            return await fetchUserProfileServerSide(accessToken);
          } catch (err) {
            console.warn('[ServerAgentBootstrap] runtime profile fetch failed:', err);
            return null;
          }
        },
        refreshAuthTokens: async (refreshToken: string) => {
          try {
            const { refreshDesktopAuthTokens } = await import('@/desktop-runtime/auth/runtimeProfileFetch');
            return await refreshDesktopAuthTokens(refreshToken);
          } catch (err) {
            console.warn('[ServerAgentBootstrap] runtime token refresh failed:', err);
            return null;
          }
        },
        // ChatGPT OAuth: runtime owns the 127.0.0.1:1455 callback server
        // (was Rust `start_oauth_callback_server`, now deleted) and the token
        // storage (was WebView `ChatGPTOAuthDesktopStorage` → keytar).
        chatgptFlow,
        getChatGPTStorage: chatgptStorage ? () => chatgptStorage! : undefined,
      } : undefined,
      diagnostics: {
        buildCtx: () => this.buildDiagnosticContext(),
        heapdump: async () => {
          const { performHeapDump } = await import('../diagnostics/heapdump');
          return performHeapDump();
        },
      },
      memory: this.registry ? { registry: this.registry } : undefined,
      runtime: runtimeState ? { runtimeState } : undefined,
    });

    console.log(`[ServerAgentBootstrap] Registered ${count} service handlers`);

    if (profile === 'desktop-runtime') {
      await this.hydrateDesktopRuntimeAuthState();
    }
  }

  private getOrCreateRuntimeState(
    channelManager: ReturnType<typeof getChannelManager>,
    agentConfig: AgentConfig,
  ): RuntimeStateController {
    if (this.runtimeState) return this.runtimeState;
    this.runtimeState = new RuntimeStateController({
      emitStateUpdate: (msg) => {
        channelManager.broadcastEvent({ msg }).catch((error) => {
          console.warn('[ServerAgentBootstrap] Failed to broadcast runtime state update:', error);
        });
      },
      getEffectiveConfig: () => {
        const config = agentConfig.getConfig();
        return {
          selectedModelKey: config.selectedModelKey,
          preferences: {
            useOwnApiKey: config.preferences?.useOwnApiKey,
          },
          policy: config.policy
            ? {
                lockedKeys: config.policy.lockedKeys,
              }
            : undefined,
        };
      },
      getRuntimeStatus: () => ({ status: 'ready', lastError: null }),
    });
    return this.runtimeState;
  }

  private async applyAuthManagerToSessions(authManager: IAuthManager | null): Promise<void> {
    if (!this.registry) return;
    for (const meta of this.registry.listSessions()) {
      if (meta.state === 'terminated') continue;
      const agentSession = this.registry.getSession(meta.sessionId);
      if (!agentSession?.agent) continue;
      agentSession.agent.getModelClientFactory().setAuthManager(authManager);
      await agentSession.agent.refreshModelClient();
    }
  }

  private async refreshDesktopRuntimeAccessState() {
    if (!this.runtimeState || !this.registry) {
      return this.runtimeState?.getAccessState();
    }
    const sessions = this.registry.listSessions();
    const primary = sessions.find((s) => s.type === 'primary' && s.state !== 'terminated')
      ?? sessions.find((s) => s.state !== 'terminated');
    if (!primary) {
      return this.runtimeState.setAccessState({
        status: 'initializing',
        mode: 'none',
        ready: false,
        reason: 'Agent session is initializing.',
      });
    }
    const agent = this.registry.getSession(primary.sessionId)?.agent;
    if (!agent) {
      return this.runtimeState.setAccessState({
        status: 'initializing',
        mode: 'none',
        ready: false,
        reason: 'Agent session is initializing.',
      });
    }
    const ready = await agent.isReady();
    return this.runtimeState.setAccessState(accessStateFromReadyState(ready));
  }

  private async ensureDesktopRuntimeHubMcpConnected(): Promise<void> {
    if ((this.options.profile ?? 'server') !== 'desktop-runtime' || !this.registry) return;

    try {
      const accessToken = await getCredentialStore().get('auth', 'access_token').catch(() => null);
      if (!accessToken) return;

      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const mcpManager = await MCPManager.getInstance('desktop');
      mcpManager.setSessionTokenProvider(async () => getCredentialStore().get('auth', 'access_token'));
      const hubServer = mcpManager.getServerByName('ai-hub');
      if (!hubServer) return;

      if (!this.desktopHubMcpEventHooked) {
        this.desktopHubMcpEventHooked = true;
        mcpManager.on('event', (event) => {
          if (event.type !== 'tools-updated' || event.configId !== hubServer.id) return;
          const config = mcpManager.getServer(event.configId);
          if (!config || config.name !== 'ai-hub') return;
          this.registerDesktopHubMcpTools(mcpManager, config.name, event.tools).catch((error) => {
            console.warn('[ServerAgentBootstrap] Failed to update AI Hub MCP tools:', error);
          });
        });
      }

      const connection = mcpManager.getConnection(hubServer.id);
      if (connection?.status !== 'connected' && connection?.status !== 'connecting') {
        await mcpManager.connect(hubServer.id);
      }

      const connected = mcpManager.getConnection(hubServer.id);
      if (connected?.status === 'connected') {
        await this.registerDesktopHubMcpTools(mcpManager, hubServer.name, connected.tools);
      }
    } catch (error) {
      console.warn('[ServerAgentBootstrap] AI Hub MCP connection unavailable:', error);
    }
  }

  private async registerDesktopHubMcpTools(
    mcpManager: any,
    serverName: string,
    tools: IMCPTool[],
  ): Promise<void> {
    if (!this.registry) return;
    const { registerMCPTools, unregisterMCPTools } = await import('@/core/mcp/MCPToolAdapter');

    for (const meta of this.registry.listSessions()) {
      if (meta.state === 'terminated') continue;
      const agentSession = this.registry.getSession(meta.sessionId);
      const registry = agentSession?.agent?.getToolRegistry?.();
      if (!registry) continue;

      const previousTools = this.desktopHubRegisteredToolsBySession.get(meta.sessionId);
      if (previousTools && previousTools.length > 0) {
        await unregisterMCPTools(serverName, previousTools, registry);
      }

      if (tools.length > 0) {
        await registerMCPTools(mcpManager, serverName, tools, registry);
        this.desktopHubRegisteredToolsBySession.set(meta.sessionId, tools);
      } else {
        this.desktopHubRegisteredToolsBySession.delete(meta.sessionId);
      }
    }
  }

  private async disconnectDesktopRuntimeHubMcp(): Promise<void> {
    if ((this.options.profile ?? 'server') !== 'desktop-runtime' || !this.registry) return;

    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const mcpManager = await MCPManager.getInstance('desktop');
      const hubServer = mcpManager.getServerByName('ai-hub');
      if (!hubServer) return;
      await this.registerDesktopHubMcpTools(mcpManager, hubServer.name, []);
      await mcpManager.disconnect(hubServer.id);
    } catch (error) {
      console.warn('[ServerAgentBootstrap] Failed to disconnect AI Hub MCP:', error);
    }
  }

  private async hydrateDesktopRuntimeAuthState(): Promise<void> {
    if (!this.runtimeState || !this.registry || (this.options.profile ?? 'server') !== 'desktop-runtime') return;
    const agentConfig = await AgentConfig.getInstance();
    const config = agentConfig.getConfig();
    const useOwnApiKey = config.preferences?.useOwnApiKey === true;
    const credentialStore = getCredentialStore();
    let accessToken = await credentialStore.get('auth', 'access_token').catch(() => null);
    const refreshToken = await credentialStore.get('auth', 'refresh_token').catch(() => null);
    const hadStoredAuth = Boolean(accessToken || refreshToken);
    let profile: Awaited<ReturnType<typeof import('@/desktop-runtime/auth/runtimeProfileFetch').fetchUserProfileServerSide>> = null;
    let profileError: string | undefined;

    if (hadStoredAuth) {
      await this.runtimeState.setAuthState({
        mode: useOwnApiKey ? 'own_api_key' : 'login',
        hasToken: true,
        profileStatus: 'loading',
        lastError: undefined,
      });
      try {
        const { fetchUserProfileServerSide, refreshDesktopAuthTokens } = await import('@/desktop-runtime/auth/runtimeProfileFetch');
        profile = accessToken ? await fetchUserProfileServerSide(accessToken) : null;
        if (!profile && refreshToken) {
          const refreshed = await refreshDesktopAuthTokens(refreshToken);
          if (refreshed?.accessToken && refreshed.refreshToken) {
            await Promise.all([
              credentialStore.set('auth', 'access_token', refreshed.accessToken),
              credentialStore.set('auth', 'refresh_token', refreshed.refreshToken),
            ]);
            accessToken = refreshed.accessToken;
            profile = await fetchUserProfileServerSide(accessToken);
          }
        }
      } catch (error) {
        profileError = error instanceof Error ? error.message : String(error);
      }
    }

    const hasUsableLogin = Boolean(accessToken && profile);
    const shouldUseBackend = Boolean(hasUsableLogin && !useOwnApiKey);
    const tokenGetter = shouldUseBackend
      ? async () => getCredentialStore().get('auth', 'access_token')
      : undefined;
    const authManager = new AuthManager(
      shouldUseBackend,
      shouldUseBackend ? this.runtimeState.getUrls().llmApiUrl : null,
      tokenGetter,
      {
        gatewayLlmBaseUrl: shouldUseBackend && this.runtimeState.getUrls().llmRoutingMode === 'ai-hub'
          ? this.runtimeState.getUrls().aiHubLlmApiUrl
          : null,
      },
    );
    this.currentAuthManager = authManager;
    await this.applyAuthManagerToSessions(authManager);

    if (hadStoredAuth) {
      await this.runtimeState.setAuthState({
        mode: hasUsableLogin
          ? useOwnApiKey ? 'own_api_key' : 'login'
          : useOwnApiKey ? 'own_api_key' : 'none',
        hasToken: hasUsableLogin,
        profile,
        profileStatus: hasUsableLogin ? 'ready' : 'failed',
        lastError: hasUsableLogin ? undefined : profileError ?? 'Stored desktop login expired or profile unavailable',
      });
    } else {
      await this.runtimeState.setAuthState({
        mode: useOwnApiKey ? 'own_api_key' : 'none',
        hasToken: false,
        profile: null,
        profileStatus: 'idle',
        lastError: undefined,
      });
    }

    await this.refreshDesktopRuntimeAccessState();
    if (hasUsableLogin && !useOwnApiKey) {
      await this.ensureDesktopRuntimeHubMcpConnected();
    }
  }

  /**
   * Assemble the server diagnostic context (Track 17). Resolves singletons
   * lazily so it is correct regardless of bootstrap ordering; absent
   * collaborators degrade their check gracefully.
   */
  private async buildDiagnosticContext(): Promise<DiagnosticContext> {
    let mcpManager: DiagnosticContext['mcpManager'];
    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      mcpManager = (await MCPManager.getInstance(
        (this.options.profile ?? 'server') === 'desktop-runtime' ? 'desktop' : 'server',
      )) as unknown as DiagnosticContext['mcpManager'];
    } catch {
      // MCP unavailable — the mcp-connected check degrades to "not in use".
    }
    return {
      platformId: (this.options.profile ?? 'server') === 'desktop-runtime' ? 'desktop' : 'server',
      channelManager: getChannelManager(),
      mcpManager,
      skillRegistry: this.skillRegistry ?? undefined,
      scheduler: this.scheduler ?? undefined,
    };
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
        // Track 13: derive origin from the chat channel (on-host WS chat maps
        // to `local` and skips the gate; remote/relay maps to `remote`).
        await targetSession.agent.submitOperation(op, {
          tabId: context.tabId,
          origin: deriveInputOrigin(context),
        });
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
      // Track 15: list the conversation's user turns (D13 flush first).
      listSessionTurns: async (key) => {
        if (!this.registry) throw new Error('Registry not initialized');
        const targetSession = this.registry.getSession(key);
        if (!targetSession?.agent) {
          throw new Error(`Session not found: ${key}`);
        }
        const convId = targetSession.agent.getSession().getSessionId();
        await targetSession.agent.getSession().flushRollout?.();
        return listUserTurns(convId);
      },
      // Track 15: fork the conversation to an earlier turn. The source
      // rollout is append-only and untouched; a NEW conversation is created
      // and its id returned so the operator re-targets it. Side effects
      // (exec'd commands, file writes, sent messages) are NOT rewound.
      rewindSession: async (key, targetSequence, mode) => {
        if (!this.registry) throw new Error('Registry not initialized');
        const registry = this.registry;
        const targetSession = registry.getSession(key);
        if (!targetSession?.agent) {
          throw new Error(`Session not found: ${key}`);
        }
        const sourceAgent = targetSession.agent;
        const sourceConvId = sourceAgent.getSession().getSessionId();

        // D13: flush the live source session before slicing.
        await sourceAgent.getSession().flushRollout?.();

        const forked =
          mode === 'summarize_up_to'
            ? await buildSummarizedFork(sourceConvId, targetSequence, async (items) => {
                try {
                  const modelClient = await sourceAgent
                    .getModelClientFactory()
                    .createClientForCurrentModel();
                  const result = await new CompactService().compact(
                    items,
                    'manual',
                    modelClient,
                    0,
                    undefined,
                    { sessionId: sourceConvId },
                  );
                  return result.success ? result.summaryText : undefined;
                } catch (err) {
                  console.warn('[ServerAgentBootstrap] summarizeForRewind failed:', err);
                  return undefined;
                }
              })
            : await computeRewindSlice(sourceConvId, targetSequence);

        const newSession = await registry.createSession({
          type: 'primary',
          fork: {
            sourceConversationId: forked.sourceConversationId,
            rolloutItems: forked.rolloutItems,
          },
        });
        return {
          sourceConversationId: sourceConvId,
          newConversationId: newSession.sessionId,
        };
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
   * Initialize channel connectors.
   */
  private async initializeConnectors(channelManager: ReturnType<typeof getChannelManager>): Promise<void> {
    this.connectorRegistry = new ConnectorRegistry();
    const config = getServerConfig();

    try {
      const definitions = await discoverConnectors();

      for (const definition of definitions) {
        const api = new WorkXConnectorApi();
        await definition.register(api);

        const registrations = api.getRegistrations();
        for (const reg of registrations) {
          const connector = reg.connector;
          this.connectorRegistry.register(definition, connector);

          // Create a bridge per account
          const accountIds = connector.config.listAccountIds(config.server.channels[connector.id]);
          for (const accountId of accountIds) {
            const bridge = new ConnectorBridge(connector, accountId);
            await channelManager.registerChannel(bridge);
            console.log(`[ServerAgentBootstrap] Connector bridge registered: ${connector.id}:${accountId}`);
          }
        }
      }

      console.log(`[ServerAgentBootstrap] ${this.connectorRegistry.size} connector(s) initialized`);
    } catch (err) {
      console.warn('[ServerAgentBootstrap] Connector initialization error:', err);
    }
  }

  /**
   * Configure PromptComposer for server mode.
   */
  private async configurePrompt(): Promise<void> {
    const os = await import('node:os');
    const homeDir = os.homedir();

    // Track 24.2: register filesystem persona overrides (user dir lowest,
    // project dir highest precedence; both overlay built-ins), then pin the
    // operator-selected persona from config.json.
    try {
      const { join } = await import('node:path');
      const { scanDiskPersonas } = await import('@/prompts/diskPersonas');
      const { registerExternalPersonas } = await import('@/prompts/PersonaLoader');
      registerExternalPersonas(
        scanDiskPersonas([
          join(homeDir, '.workx', 'styles'),
          join(process.cwd(), '.workx', 'styles'),
        ]),
      );
    } catch (e) {
      console.warn('[ServerAgentBootstrap] Persona disk scan skipped:', e);
    }

    const isDesktopRuntime = (this.options.profile ?? 'server') === 'desktop-runtime';
    const staticContext: Partial<RuntimeContext> = {
      browserConnection: isDesktopRuntime ? 'mcp' : 'none',
      os: process.platform,
      arch: process.arch,
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      homeDir,
      // TODO(track-20): allow a managed-policy key to override this.
      personaName: isDesktopRuntime ? undefined : getServerConfig().server.persona,
    };

    configurePromptComposer(isDesktopRuntime ? 'workx-desktop' : 'workx-server', staticContext);
    console.log(`[ServerAgentBootstrap] PromptComposer configured for ${isDesktopRuntime ? 'desktop runtime' : 'server'} mode`);
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
      if ((this.options.profile ?? 'server') === 'desktop-runtime') {
        const { getDesktopRuntimeHost } = await import('@/desktop-runtime/host');
        const { DesktopRuntimeSQLiteAdapter } = await import('@/desktop-runtime/storage/DesktopRuntimeSQLiteAdapter');
        const { ScheduleEventStorage } = await import('@/core/scheduler/ScheduleEventStorage');
        const { ExecutionStorage } = await import('@/core/scheduler/ExecutionStorage');
        const adapter = new DesktopRuntimeSQLiteAdapter(getDesktopRuntimeHost().storageDbPath);
        await adapter.initialize();
        this.scheduleEventStorage = new ScheduleEventStorage(adapter);
        this.executionRecordStorage = new ExecutionStorage(adapter);
      } else {
        this.scheduleEventStorage = new ServerScheduleStorage(dataDir);
        await this.scheduleEventStorage.initialize();
        this.executionRecordStorage = new ServerExecutionStorage(dataDir);
        await this.executionRecordStorage.initialize();
      }
      const executionStorage = this.executionRecordStorage;

      // 2. Create alarms. Server profile uses pure in-process Node timers;
      // desktop-runtime adds OS-level scheduled jobs via the Rust scheduler
      // control bridge (firing even when the whole app is quit).
      if ((this.options.profile ?? 'server') === 'desktop-runtime') {
        const { RuntimeSchedulerAlarms } = await import('@/desktop-runtime/scheduler/RuntimeSchedulerAlarms');
        const { getDesktopRuntimeControlBridge } = await import('@/desktop-runtime/protocol/controlBridge');
        this.schedulerAlarms = new RuntimeSchedulerAlarms(getDesktopRuntimeControlBridge().scheduler) as unknown as ServerSchedulerAlarms;
      } else {
        this.schedulerAlarms = new ServerSchedulerAlarms();
      }

      // 3. Create new model components directly
      const scheduleManager = new ScheduleManager(this.scheduleEventStorage, executionStorage, this.schedulerAlarms);
      const jobExecutor = new JobExecutor(executionStorage);

      // 4. Create scheduler with new constructor
      this.scheduler = new Scheduler(scheduleManager, jobExecutor, this.schedulerAlarms);

      // 5. Wire alarm handler -> scheduler.handleAlarm()
      this.schedulerAlarms.setAlarmHandler(async (alarmName) => {
        await this.scheduler!.handleAlarm(alarmName);
      });

      // 6. Wire event emitter -> unified channel dispatch (+ telemetry tap;
      // the scheduler is a separate emitter family that bypasses the agent
      // chokepoint, so it gets its own observation point — closes the
      // "why did a scheduled job abort" goal incl. pre-session failures).
      this.scheduler.connectToChannel(
        () => channelManager,
        this.channel!.channelId,
        schedulerTelemetryTap,
      );

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
          // Scheduled jobs are unattended on two orthogonal axes:
          //  - Track 13 origin `scheduler`: a failed mention/capability
          //    degrades via systemNote, never aborts the turn.
          //  - Track 12 unattended: wait out 429/529 instead of
          //    hard-failing into scheduler.failJob() with no human.
          { origin: { channel: 'scheduler' }, unattended: true }
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
      // Track 18: cost was computed once in core and rides the TaskComplete
      // event — read it, never recompute server-side (the server has only
      // prose pricing and no model context).
      const jobCostUSD = typeof data?.cost_usd === 'number' ? data.cost_usd : 0;
      const jobCostEstimated = data?.cost_estimated === true;
      this.scheduler.completeJob(jobId, {
        summary,
        tokenUsage: {
          inputTokens: tokenData?.input_tokens ?? 0,
          outputTokens: tokenData?.output_tokens ?? 0,
          totalTokens: tokenData?.total_tokens ?? 0,
        },
        duration,
        costUSD: jobCostUSD,
        costEstimated: jobCostEstimated,
      }).then(() => {
        // Track 18: post-hoc budget enforcement (blocks subsequent jobs;
        // never throws into a running turn).
        return this.enforceBudgetCaps(jobId, jobCostUSD, jobCostEstimated);
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

  /**
   * Track 18: post-hoc USD budget enforcement for unattended scheduler jobs.
   * MVP scope — runs after a job completes, so it blocks *subsequent* jobs
   * (a mid-run abort would need per-turn server-side cost and is a documented
   * follow-on). Never throws into a turn; on a per-day breach it pauses the
   * job queue cleanly and surfaces a logs.tail-visible warning.
   */
  private async enforceBudgetCaps(
    jobId: string,
    jobCostUSD: number,
    jobCostEstimated: boolean,
  ): Promise<void> {
    try {
      const limits = getServerConfig().server.limits;
      const maxPerJob = limits.maxUsdPerJob ?? 0;
      const maxPerDay = limits.maxUsdPerDay ?? 0;

      if (maxPerJob > 0 && jobCostUSD > maxPerJob) {
        emitLog('warn', 'Per-job USD budget exceeded', {
          event: 'budget_job_exceeded',
          jobId,
          jobCostUSD,
          capUSD: maxPerJob,
          estimated: jobCostEstimated,
        });
      }

      if (maxPerDay > 0 && this.executionRecordStorage) {
        const now = Date.now();
        // UTC start-of-day so the cap window and the logged date agree with
        // each other and with the dashboard's aggregateByDate, which buckets
        // on the ISO timestamp (UTC). A local-time window would disagree near
        // midnight in non-UTC zones.
        const d = new Date(now);
        const startOfDayUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const todays = await this.executionRecordStorage.getExecutionsInRange(
          startOfDayUTC,
          now,
        );
        const dayTotalUSD = (todays as Array<{ result?: { costUSD?: number } }>).reduce(
          (sum: number, e) => sum + (e.result?.costUSD ?? 0),
          0,
        );
        if (dayTotalUSD > maxPerDay) {
          emitLog('warn', 'Daily USD budget cap exceeded — pausing job queue', {
            event: 'budget_cap_exceeded',
            date: new Date(startOfDayUTC).toISOString().slice(0, 10),
            dayTotalUSD,
            capUSD: maxPerDay,
          });
          // Clean pause — stops future jobs; does not abort the (already
          // finished) one, never throws into a turn.
          await this.scheduler?.pauseJobQueue();
        }
      }
    } catch (err) {
      console.error('[ServerAgentBootstrap] Budget cap check failed:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────

  getRegistry(): AgentRegistry | null {
    return this.registry;
  }

  getChannel(): ChannelAdapter | null {
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

  getConnectorRegistry(): ConnectorRegistry | null {
    return this.connectorRegistry;
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

    // Stop health + diagnostics monitors
    this.healthMonitor?.stop();
    this.diagnosticsMonitor?.stop();

    // Cancel pending approvals
    this.approvalManager?.cancelAll();

    // Shutdown scheduler
    this.schedulerAlarms?.shutdown();
    this.scheduleEventStorage?.close?.();
    this.executionRecordStorage?.close?.();

    // Stop backup manager
    this.backupManager?.stop();

    // Stop tool-result TTL sweep
    this.toolResultSweep?.stop();
    this.toolResultSweep = null;

    // Stop rollout TTL sweep (Track 15)
    if (this.rolloutTtlSweep) {
      clearInterval(this.rolloutTtlSweep);
      this.rolloutTtlSweep = null;
    }

    // Shutdown channel manager (shuts down all channels including connector bridges)
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
