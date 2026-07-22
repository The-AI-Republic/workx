/**
 * Server Agent Bootstrap
 *
 * Main orchestrator for server mode. Creates SessionManager with
 * session-aware agent management, ServerChannel, ChannelManager,
 * connector loader, and maintenance timers.
 *
 * Pattern follows the extension service worker: no singleton agent,
 * all operations routed through SessionManager by sessionId.
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
import { createMutableAuthContext } from '@/core/auth/AuthContext';
import { FileConfigStorageProvider } from '../storage/FileConfigStorageProvider';
import { normalizeAgentMode, type RuntimeContext } from '@/prompts/PromptComposer';
import { ServerAgentAssembler } from './ServerAgentAssembler';
import {
  ThreadIndexStore,
  loadModelContextSnapshot,
  loadRolloutRevision,
  loadRolloutSnapshot,
  refreshRolloutSnapshot,
} from '@/core/thread';
import { SessionDeletionCoordinator } from '@/core/thread/SessionDeletionCoordinator';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';
import { deriveInputOrigin } from '@/core/input/types';
import type { EventMsg } from '@/core/protocol/events';
import { A2AServer, type A2AAgentBridge, type A2ATurnResult } from '@/core/a2a/A2AServer';
import { A2AEventTap, interpretTurnEvent } from '@/core/a2a/A2AEventTap';
import type { ToolDefinition } from '@/tools/BaseTool';

import {
  getServerConfig,
  loadServerConfig,
  watchConfig,
  stopWatchingConfig,
  onConfigReload,
} from '../config/server-config';
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
import { schedulePeriodicSweep } from '../maintenance/toolResultCleanup';
import { loadHistoryPage, RolloutRecorder } from '@/storage/rollout';
import { createSessionServices } from '@/core/session/state/SessionServices';
import { registerUseSkillTool } from '@/core/skills/registerUseSkillTool';
import { RuntimeStateController } from '@/core/services/runtime-state';
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
import { registerModelHandlers } from '../handlers/models';
import { emitLog } from '../handlers/logs';

// Scheduler
import { ServerScheduleStorage } from '../scheduler/ServerScheduleStorage';
import { ServerExecutionStorage } from '../scheduler/ServerExecutionStorage';
import { ServerSchedulerAlarms } from '../scheduler/ServerSchedulerAlarms';
import { Scheduler } from '@/core/scheduler/Scheduler';
import { ScheduleManager } from '@/core/scheduler/ScheduleManager';
import { JobExecutor } from '@/core/scheduler/JobExecutor';

// Session isolation
import { SessionManager } from '@/core/registry/SessionManager';

// ─────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────

let _instance: ServerAgentBootstrap | null = null;

export interface ServerAgentBootstrapOptions {
  profile?: 'server' | 'desktop-runtime';
  dataDir?: string;
  /** Primary channel (UI/runtime transport). Kept for backward compatibility. */
  channel?: ChannelAdapter;
  /** Additional channels to register at initialize() time (e.g. app-server). */
  channels?: ChannelAdapter[];
}

// ─────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────

export class ServerAgentBootstrap {
  private registry: SessionManager | null = null;
  // Track 10: set in registerServices; read lazily by agentFactory to bind
  // per-session hook/agent plugin contributions. Null until services
  // register (the initial primary session, created before that, gets
  // global slots only — hooks/agents apply on the next session or
  // /plugin reload, matching claudy's asymmetric enable semantics).
  private pluginRegistry: import('@/core/plugins/PluginRegistry').PluginRegistry | null = null;
  private channel: ChannelAdapter | null = null;
  /** All registered channels by channelId (multi-channel support). */
  private channels = new Map<string, ChannelAdapter>();
  /** The primary channel id — events for unowned sessions route here. */
  private primaryChannelId: string | null = null;
  /** sessionId → owning channelId, so events route to the originating channel. */
  private sessionOwners = new Map<string, string>();
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
  private readonly authContext = createMutableAuthContext(null);
  private runtimeState: RuntimeStateController | null = null;
  private appsAccess: import('@/core/apps/AppsAccessController').AppsAccessController | null = null;
  private dataSourceRuntimeHandle: import('@/core/data-sources').DataSourceRuntimeHandle | null =
    null;
  private componentRuntimeHandle: import('@/core/components').ComponentRuntimeHandle | null = null;
  private componentRuntime: import('@/desktop-runtime/components').DesktopComponentRuntime | null =
    null;
  // FR-6 (server decoupling): headless A2A delegation endpoint. The tap lets
  // the A2A bridge observe the agent event stream; turns are serialized via the
  // chain so concurrent delegations don't collide on the shared primary session.
  private readonly a2aEventTap = new A2AEventTap();
  private a2aServer: A2AServer | null = null;
  private a2aTurnChain: Promise<unknown> = Promise.resolve();
  private toolResultSweep: { stop: () => void } | null = null;
  private desktopHubMcpEventHooked = false;
  private desktopHubRegisteredToolsBySession = new Map<string, IMCPTool[]>();
  // Track 15: periodic rollout TTL cleanup (the server otherwise never prunes
  // expired/forked rollouts — only the extension had alarm-based cleanup).
  private rolloutTtlSweep: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private promptStaticContext: Readonly<Partial<RuntimeContext>> = Object.freeze({});
  private threadIndexStore: ThreadIndexStore | null = null;
  private deletionCoordinator: SessionDeletionCoordinator | null = null;
  /** Explicit owner for the headless transport's default-session alias. */
  private defaultSessionId: string | null = null;

  constructor(private readonly options: ServerAgentBootstrapOptions = {}) {}

  /**
   * Record the channel that owns a session so agent events for that session are
   * routed only to the originating channel. No-op when channelId is absent.
   */
  private recordSessionOwner(sessionId: string, channelId?: string): void {
    if (channelId && this.channels.has(channelId)) {
      this.sessionOwners.set(sessionId, channelId);
    }
  }

  /**
   * Register an additional channel after initialization (e.g. the app-server
   * channel started once config is read). Idempotent per channelId.
   */
  async registerChannel(channel: ChannelAdapter): Promise<void> {
    if (this.channels.has(channel.channelId)) return;
    const channelManager = getChannelManager();
    await channelManager.registerChannel(channel);
    this.channels.set(channel.channelId, channel);
    if (!this.primaryChannelId) this.primaryChannelId = channel.channelId;
  }

  /**
   * Unregister a previously registered channel and drop any session ownership
   * routed to it. The primary channel cannot be unregistered.
   */
  async unregisterChannel(channelId: string): Promise<void> {
    if (channelId === this.primaryChannelId) {
      throw new Error('Cannot unregister the primary channel');
    }
    if (!this.channels.has(channelId)) return;
    const channelManager = getChannelManager();
    await channelManager.unregisterChannel(channelId);
    this.channels.delete(channelId);
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner === channelId) this.sessionOwners.delete(sessionId);
    }
  }

  /**
   * Create a fresh agent session and return its id. Used by callers such as the
   * app-server that need a dedicated session per external connection.
   *
   * Created as `type: 'api'` + `internal: true`: never the registry's primary
   * session (so external connections can't hijack the UI's primary-session
   * pointer) and outside the user concurrency budget (the app-server transport
   * bounds connection count itself).
   */
  async createSession(): Promise<string> {
    if (!this.registry) throw new Error('SessionManager not initialized');
    const session = await this.registry.createSession({ type: 'api', internal: true });
    return session.sessionId;
  }

  /**
   * Tear down a session created via {@link createSession} and drop its event
   * routing. Called when an app-server connection closes so dedicated sessions
   * don't accumulate for the life of the runtime.
   */
  async releaseSession(sessionId: string): Promise<void> {
    this.sessionOwners.delete(sessionId);
    if (this.registry) {
      await this.registry.removeSession(sessionId);
    }
  }

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
    const dataDir =
      this.options.dataDir ??
      process.env.WORKX_DATA_DIR ??
      `${process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'}/.workx-server/data`;
    try {
      // 0. Initialize StorageProvider (used by subsystems)
      const {
        isStorageProviderInitialized,
        initializeStorageProvider,
        isCredentialStoreInitialized,
        initializeCredentialStore,
      } = await import('@/core/storage');
      if (!isStorageProviderInitialized()) {
        await initializeStorageProvider();
        console.log('[ServerAgentBootstrap] StorageProvider initialized (SQLite)');
      }

      // 0a. Initialize TokenUsageStore with NodeSQLiteAdapter
      try {
        const { NodeSQLiteAdapter } =
          profile === 'desktop-runtime'
            ? await import('@/desktop-runtime/storage/DesktopRuntimeSQLiteAdapter').then((m) => ({
                NodeSQLiteAdapter: m.DesktopRuntimeSQLiteAdapter,
              }))
            : await import('@/server/storage/NodeSQLiteAdapter');
        const { TokenUsageStore } = await import('@/storage/TokenUsageStore');
        const tokenAdapter =
          profile === 'desktop-runtime'
            ? new NodeSQLiteAdapter(
                (await import('@/desktop-runtime/host')).getDesktopRuntimeHost().storageDbPath
              )
            : new NodeSQLiteAdapter(dataDir);
        await tokenAdapter.initialize();
        TokenUsageStore.setAdapter(tokenAdapter);
        this.threadIndexStore = new ThreadIndexStore(tokenAdapter);
      } catch (error) {
        console.warn(
          '[ServerAgentBootstrap] TokenUsageStore initialization failed (non-fatal):',
          error
        );
      }

      // 0b. Initialize credential store (for secure API key storage)
      if (!isCredentialStoreInitialized()) {
        try {
          await initializeCredentialStore();
          console.log('[ServerAgentBootstrap] CredentialStore initialized (FileCredentialStore)');
        } catch (error) {
          console.warn(
            '[ServerAgentBootstrap] CredentialStore initialization failed (non-fatal):',
            error
          );
        }
      }

      // 1. Initialize config storage (must happen before AgentConfig)
      if (profile === 'desktop-runtime') {
        const { getDesktopRuntimeHost } = await import('@/desktop-runtime/host');
        const { DesktopRuntimeConfigStorageProvider } =
          await import('@/desktop-runtime/storage/DesktopRuntimeConfigStorageProvider');
        setConfigStorage(
          new DesktopRuntimeConfigStorageProvider(getDesktopRuntimeHost().configJsonPath)
        );
      } else {
        setConfigStorage(new FileConfigStorageProvider(dataDir));
      }

      if (profile === 'desktop-runtime') {
        const { ComponentRuntimeHandle } = await import('@/core/components');
        this.componentRuntimeHandle = new ComponentRuntimeHandle();
        try {
          const { createDesktopComponentRuntime } =
            await import('@/desktop-runtime/components/createDesktopComponentRuntime');
          this.componentRuntime = await createDesktopComponentRuntime();
          this.componentRuntimeHandle.setReady(this.componentRuntime.manager);
        } catch (error) {
          console.warn(
            '[ServerAgentBootstrap] Component runtime initialization failed (non-fatal):',
            error instanceof Error ? error.message : String(error)
          );
          this.componentRuntimeHandle.setUnavailable('COMPONENTS_UNAVAILABLE');
        }

        const { DataSourceRuntimeHandle, DataSourceError } = await import('@/core/data-sources');
        this.dataSourceRuntimeHandle = new DataSourceRuntimeHandle();
        try {
          const { createDesktopDataSourceRuntime } =
            await import('@/desktop-runtime/data-sources/createDesktopDataSourceRuntime');
          const { getStorageProvider } = await import('@/core/storage');
          const dataRuntime = await createDesktopDataSourceRuntime({
            storage: getStorageProvider(),
            credentials: getCredentialStore(),
            authorizePrincipal: (principal) => {
              const session = this.registry?.getSession(principal.sessionId);
              return Boolean(
                session &&
                !session.internal &&
                session.metadata.type === 'primary' &&
                this.sessionOwners.get(principal.sessionId) === 'desktop-runtime-main'
              );
            },
          });
          this.dataSourceRuntimeHandle.setReady(dataRuntime, true);
        } catch (error) {
          console.warn(
            '[ServerAgentBootstrap] Data-source initialization failed (non-fatal):',
            error instanceof Error ? error.message : String(error)
          );
          this.dataSourceRuntimeHandle.setUnavailable(
            error instanceof DataSourceError ? error.code : 'DATA_SOURCES_UNAVAILABLE'
          );
        }
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
      const agentType = profile === 'desktop-runtime' ? 'workx-desktop' : 'workx-server';
      await this.threadIndexStore?.backfill({
        rollouts: await (await RolloutRecorder.getProvider()).getAllMetadata(),
        defaultMode: normalizeAgentMode(
          agentType,
          agentConfig.getConfig().preferences?.defaultMode
        ),
      });
      if (profile === 'desktop-runtime' && this.dataSourceRuntimeHandle?.getRuntime()) {
        this.dataSourceRuntimeHandle.setReady(
          this.dataSourceRuntimeHandle.getRuntime()!,
          agentConfig.getConfig().tools?.dataSources === true
        );
      }

      // 2b. Centralized telemetry: live privacy gate + the server sink
      // (existing emitLog → stdout + logs.tail; zero new transport).
      // No-op unless preferences.telemetryEnabled is true (read live).
      installTelemetry({
        getTelemetryEnabled: () => agentConfig.getConfig().preferences?.telemetryEnabled,
        sink: ServerLogSink,
      });

      // 3. Configure PromptComposer with server platform context
      // (must happen before agent.initialize() inside agentFactory)
      await this.configurePrompt();

      // 4. Create ServerChannel and wire up
      this.channel = this.options.channel ?? new ServerChannel();
      const channelManager = getChannelManager();

      // 5. Create SessionManager with factories
      const { join } = await import('node:path');
      const serverRootDir = join(dataDir, 'sessions');
      this.registry = new SessionManager({
        maxConcurrent: 3,
        authContext: this.authContext,
        lifecycleMode: profile === 'desktop-runtime' ? 'client' : 'eager',
        threadIndexStore: this.threadIndexStore ?? undefined,
        reconcileThreadIndex: async () => {
          await this.threadIndexStore?.backfill({
            rollouts: await (await RolloutRecorder.getProvider()).getAllMetadata(),
            defaultMode: normalizeAgentMode(
              agentType,
              agentConfig.getConfig().preferences?.defaultMode
            ),
          });
        },
        loadRolloutSnapshot,
        loadModelContextSnapshot,
        loadRolloutRevision,
        refreshRolloutSnapshot,
        agentAssembler: new ServerAgentAssembler({
          createPlatformAdapter: async (sessionId) =>
            profile === 'desktop-runtime'
              ? new (
                  await import('@/desktop-runtime/platform/DesktopRuntimePlatformAdapter')
                ).DesktopRuntimePlatformAdapter(
                  sessionId,
                  this.dataSourceRuntimeHandle?.getRuntime() ?? undefined,
                  this.componentRuntimeHandle?.getManager() ?? undefined
                )
              : new (await import('../platform/ServerPlatformAdapter')).ServerPlatformAdapter(),
          agentType,
          promptStaticContext: this.promptStaticContext,
          wireAgent: async (agent, input) => {
            const cfg = input.config;
            let subAgentRunner: import('@/tools/AgentTool/SubAgentRunner').SubAgentRunner | null =
              null;
            const cleanupSteps: import('@/core/assembly/AgentAssembler').CleanupStep[] = [];

            if (profile === 'desktop-runtime') {
              // Approval gate — desktop parity with the extension wiring in
              // SessionManager. The webview already renders ApprovalRequested
              // through the shared EventProcessor and returns ExecApproval ops
              // over the stdio channel; constructing the gate here is what
              // starts that round-trip. Deliberately NOT wrapped in try/catch:
              // if the gate cannot be built, agent creation must fail loudly
              // rather than run desktop tools ungated.
              const { configureDesktopApprovalGate } =
                await import('@/desktop-runtime/approvalGate');
              await configureDesktopApprovalGate(agent, cfg.getConfig().approval);

              // The registry does not publish this agent until agentFactory
              // returns, so register already-connected gateway tools directly
              // on it as part of construction.
              await this.ensureDesktopRuntimeHubMcpConnected(agent);

              // Browser bridge: mirror the connected extension node's tool
              // catalog onto this new session (sessions created before the
              // node connected are handled by the manager's nodes-changed sync).
              try {
                const { getBrowserBridgeHandle } = await import('@/tools/browserBridgeHandle');
                const bridge = getBrowserBridgeHandle();
                if (bridge?.hasActiveNode()) {
                  await bridge.applyToRegistry(
                    agent.getSession().sessionId,
                    agent.getToolRegistry()
                  );
                }
              } catch (err) {
                console.warn(
                  '[ServerAgentBootstrap] browser bridge tool registration failed (non-fatal):',
                  err
                );
              }
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
                  msg: {
                    type: 'BackgroundEvent',
                    data: {
                      message: `Server tool registration failed: ${errMsg}`,
                      level: 'error',
                    },
                  },
                });
              }
            }

            await this.registerSkillsToolOnAgent(agent);

            // Register sub-agent tool
            const engine = agent.getEngine();
            if (engine) {
              try {
                const { registerSubAgentTool } = await import('@/tools/AgentTool/register');
                subAgentRunner = await registerSubAgentTool(engine);
                if (this.skillRegistry) {
                  const runner = subAgentRunner;
                  this.skillRegistry.setValidationContextProvider(() => ({
                    knownAgents: runner.getTypes().map((t) => t.id),
                  }));
                }
                console.log('[ServerAgentBootstrap] sub_agent tool registered');

                // Track 10: bind this session's hook + sub-agent registries to
                // currently-enabled plugins. Skills + MCP are global (handled
                // by the global PluginRegistry's slot loaders); hooks + agents
                // are per-session and bound here.
                if (this.pluginRegistry) {
                  try {
                    const { PluginSessionBinder } =
                      await import('@/core/plugins/PluginSessionBinder');
                    const { nodeReadFile, nodeListDirs } =
                      await import('@/server/storage/nodePluginFs');
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
                    const unregister = this.pluginRegistry.registerSessionBinder(binder);
                    cleanupSteps.push({
                      id: 'plugin-binder',
                      run: async () => {
                        unregister();
                        await binder.dispose();
                      },
                    });
                  } catch (bindErr) {
                    console.warn(
                      '[ServerAgentBootstrap] plugin session bind failed (non-fatal):',
                      bindErr
                    );
                  }
                }
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn(
                  '[ServerAgentBootstrap] sub_agent tool registration failed (non-fatal):',
                  err
                );
                engine.pushEvent({
                  id: crypto.randomUUID(),
                  msg: {
                    type: 'BackgroundEvent',
                    data: {
                      message: `Sub-agent tool registration failed: ${errMsg}`,
                      level: 'error',
                    },
                  },
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
                }
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
                      {
                        allowlist: cfg.allowlist,
                        maxPerDayUSD: cfg.maxPerDayUSD,
                      },
                      amountUSD,
                      resourceUrl,
                      sessionSpentUSD
                    );
                  },
                  audit: (level, message, data) => emitLog(level, `[x402] ${message}`, data),
                })
              );
              console.log('[ServerAgentBootstrap] x402 capability wired (default-deny)');
            } catch (err) {
              console.warn(
                '[ServerAgentBootstrap] x402 capability wiring failed (non-fatal):',
                err
              );
            }

            return { subAgentRunner, cleanupSteps };
          },
        }),
        assemblyServicesFactory: async () =>
          createSessionServices(
            {
              serverRootDir,
              commitGeneratedTitle: (sessionId, title) =>
                this.registry?.commitGeneratedTitle(sessionId, title) ?? Promise.resolve(false),
            },
            false
          ),
        eventDispatcherFactory: (sessionId) => (event) => {
          // Route to the channel that owns this session (UI vs app-server
          // isolation). Falls back to the primary channel for sessions with no
          // recorded owner (e.g. the initial primary session before any turn).
          const targetChannelId =
            this.sessionOwners.get(sessionId) ?? this.primaryChannelId ?? this.channel?.channelId;
          const delivery = targetChannelId
            ? channelManager
                .dispatchEvent(
                  {
                    msg: event.msg,
                    sessionId,
                    runtimeEpoch: event.runtimeEpoch,
                    eventSeq: event.eventSeq,
                  },
                  targetChannelId
                )
                .catch((error) => {
                  console.error('[ServerAgentBootstrap] Failed to dispatch event:', error);
                })
            : Promise.resolve();

          // FR-6: forward to the A2A bridge when a delegated turn is in flight.
          if (this.a2aEventTap.active) {
            this.a2aEventTap.emit(sessionId, event.msg);
          }

          // Intercept completion events for scheduler
          this.handleSchedulerEventCompletion(event.msg);
          return delivery;
        },
      });
      this.registry.initialize(agentConfig);
      if (this.threadIndexStore) {
        this.deletionCoordinator = new SessionDeletionCoordinator({
          index: this.threadIndexStore,
          ensureNotLive: async (sessionId) => {
            if (this.registry?.getSession(sessionId)) await this.registry.suspendSession(sessionId);
          },
          deleteRollout: (sessionId) => RolloutRecorder.deleteSession(sessionId),
          deleteTokenUsage: async (sessionId) => {
            const { TokenUsageStore } = await import('@/storage/TokenUsageStore');
            await TokenUsageStore.getInstance().deleteSession(sessionId);
          },
          deleteLegacySession: async (sessionId) => {
            this.sessionIndex?.delete(sessionId);
            this.transcriptStore?.delete(sessionId);
          },
          deleteToolResults: async (sessionId) => {
            const { rm } = await import('node:fs/promises');
            const { join } = await import('node:path');
            await rm(join(serverRootDir, sessionId, 'tool-results'), {
              recursive: true,
              force: true,
            });
          },
          onPurged: (sessionId) => this.registry?.notifyThreadPurged(sessionId),
        });
        await this.deletionCoordinator.purgeDue();
      }
      await this.registry.recoverInterruptedTurns();

      // 6. Create initial primary session
      const initialSession =
        profile === 'desktop-runtime'
          ? { sessionId: await this.registry.resolveSurfaceLessTarget() }
          : await this.registry.createSession({ type: 'primary' });
      this.defaultSessionId = initialSession.sessionId;
      console.log(`[ServerAgentBootstrap] Initial session opened: ${initialSession.sessionId}`);

      // 7. Set agent handler — requires sessionId, no fallback
      const agentHandler: AgentHandler = async (op: Op, context: SubmissionContext) => {
        if (!context.sessionId) {
          throw new Error('No sessionId in submission context — cannot route operation');
        }
        if (!this.registry) {
          throw new Error('SessionManager not initialized');
        }
        // Record channel ownership so agent events route to the originating
        // channel only (UI vs app-server isolation).
        this.recordSessionOwner(context.sessionId, context.channelId);
        console.log(
          '[ServerAgentBootstrap] Processing submission:',
          op.type,
          'session:',
          context.sessionId
        );
        // Track 13: thread channel origin so the input funnel can apply the
        // bridge-safe slash gate (connector input must not leak raw /config).
        if (op.type === 'UserInput') {
          if (profile === 'desktop-runtime') {
            throw new Error('UserInput must use the correlated session.submit service');
          }
          const targetSession = this.registry.getSession(context.sessionId);
          if (!targetSession?.agent) throw new Error(`Session not found: ${context.sessionId}`);
          await targetSession.agent.submitOperation(op, {
            tabId: context.tabId,
            origin: deriveInputOrigin(context),
          });
        } else if (op.type === 'ServiceRequest') {
          throw new Error('ServiceRequest must use the service registry');
        } else {
          await this.registry.dispatchControl(context.sessionId, op, {
            tabId: context.tabId,
            origin: deriveInputOrigin(context),
          });
        }
      };

      channelManager.setAgentHandler(agentHandler);

      // Register the primary channel plus any additional channels (multi-channel
      // support — e.g. the desktop app-server channel alongside the UI channel).
      const extraChannels = this.options.channels ?? [];
      this.primaryChannelId = this.channel.channelId;
      for (const ch of [this.channel, ...extraChannels]) {
        await channelManager.registerChannel(ch);
        this.channels.set(ch.channelId, ch);
      }
      console.log(
        `[ServerAgentBootstrap] Channel(s) registered: ${[...this.channels.keys()].join(', ')}`
      );

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
      const ROLLOUT_TTL_SWEEP_MS = 2 * 60 * 60 * 1000;
      const sweepRollouts = () =>
        Promise.all([
          RolloutRecorder.cleanupExpired(),
          this.deletionCoordinator?.purgeDue() ?? Promise.resolve(0),
        ])
          .then(([n]) => {
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
      const primarySession = this.defaultSessionId
        ? this.registry.getSession(this.defaultSessionId)
        : undefined;
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
            const tools = registry
              .listTools()
              .map((t: any) => t.function?.name ?? t.name ?? 'unknown');
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
          // Reload once; SessionManager owns the all-settled live-graph sweep.
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
          console.error(
            '[ServerAgentBootstrap] Failed to re-pin server config on policy change:',
            err
          );
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
        this.diagnosticsMonitor = new DiagnosticsMonitor(() => this.buildDiagnosticContext());
        this.diagnosticsMonitor.start();
      }

      // 15c. FR-6 (server decoupling): optionally expose the headless A2A
      // delegation endpoint. Opt-in via WORKX_SERVER_A2A_ENABLED — the endpoint
      // is not yet behind the WS auth handshake, so it should only be enabled on
      // trusted binds (loopback/tailnet) until per-request auth lands.
      if (profile === 'server' && isA2AEnabled()) {
        this.a2aServer = new A2AServer({
          bridge: this.buildA2ABridge(),
          identity: buildA2AIdentity(),
        });
        console.log('[ServerAgentBootstrap] A2A delegation endpoint enabled');
      }

      this.initialized = true;
      console.log('[ServerAgentBootstrap] Initialization complete');
    } catch (error) {
      console.error('[ServerAgentBootstrap] Initialization failed:', error);
      throw error;
    }
  }

  /** Reload configuration; SessionManager is the sole live-graph subscriber. */
  private async handleConfigUpdate(): Promise<void> {
    if (!this.registry) return;
    const config = await AgentConfig.getInstance();
    await config.reload();
    // SessionManager is the sole config subscriber and performs the allSettled sweep.
  }

  private async registerSkillsToolOnAgent(agent: RepublicAgent): Promise<void> {
    if (!this.skillRegistry) return;
    // Desktop/server prompt composition must not contact the browser. Domain
    // constraints are advertised statically and enforced when use_skill runs.
    agent
      .getPromptLoader()
      .registerExtension('skills', () => this.skillRegistry!.buildSkillsSystemPrompt());
    await registerUseSkillTool({
      toolRegistry: agent.getToolRegistry(),
      hookRegistry: agent.getHookRegistry(),
      skillRegistry: this.skillRegistry,
      getTurnContext: () => agent.getSession().getTurnContext(),
      getCurrentDomain: async () => {
        const context = await agent.getPlatformAdapter().getCurrentPageContext?.();
        return context?.currentDomain ?? null;
      },
    });
  }

  /**
   * Register service handlers on ChannelManager (message_routing_v2).
   * Gives server mode full service parity with the extension.
   */
  private async registerServices(
    channelManager: ReturnType<typeof getChannelManager>
  ): Promise<void> {
    const { registerAllServices } = await import('@/core/services');
    const { createRuntimeModelCatalogLoader } = await import('@/config/modelCatalog');
    const serviceRegistry = channelManager.getServiceRegistry();
    const profile = this.options.profile ?? 'server';
    const platformScope = profile === 'desktop-runtime' ? 'desktop' : 'server';
    const agentConfigForSnapshot = await AgentConfig.getInstance();
    const runtimeState =
      profile === 'desktop-runtime'
        ? this.getOrCreateRuntimeState(channelManager, agentConfigForSnapshot)
        : undefined;

    // Get MCPManager instance
    let mcpDeps: import('@/core/services').MCPServiceDeps | undefined;
    let runtimeMcpManager: import('@/core/mcp/MCPManager').MCPManager | null = null;
    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const mcpManager = await MCPManager.getInstance(platformScope);
      runtimeMcpManager = mcpManager;
      mcpDeps = { mcpManager: mcpManager as any };
    } catch (error) {
      console.warn(
        '[ServerAgentBootstrap] MCPManager not available for service registration:',
        error
      );
    }

    let appsRuntime:
      | ReturnType<typeof import('@/core/apps/createAppsRuntime').createAppsRuntime>
      | undefined;
    if (profile === 'desktop-runtime' && runtimeState) {
      const { createAppsRuntime } = await import('@/core/apps/createAppsRuntime');
      const urls = runtimeState.getUrls();
      appsRuntime = createAppsRuntime({
        urls,
        credentialStore: getCredentialStore(),
        reconnectMcp: async () => {
          await this.disconnectDesktopRuntimeHubMcp();
          await this.ensureDesktopRuntimeHubMcpConnected();
        },
        disconnectMcp: () => this.disconnectDesktopRuntimeHubMcp(),
        oauthReturnUrl: null,
        emitState: (state) =>
          channelManager.broadcastEvent({
            msg: {
              type: 'StateUpdate',
              data: { scope: 'apps-runtime', kind: 'apps.stateChanged', apps: state },
            },
          }),
      });
      this.appsAccess = appsRuntime.access;
      this.authContext.setGatewayCredentialProvider({
        getCredential: appsRuntime.getGatewayCredential,
        handleUnauthorized: appsRuntime.handleGatewayUnauthorized,
      });
      runtimeMcpManager?.setGatewayCredentialProvider(
        appsRuntime.getMcpCredential,
        appsRuntime.handleMcpUnauthorized
      );
    }

    // Get A2AManager instance
    let a2aDeps: import('@/core/services').A2AServiceDeps | undefined;
    try {
      const { A2AManager } = await import('@/core/a2a/A2AManager');
      const a2aManager = await A2AManager.getInstance(platformScope);
      a2aDeps = { a2aManager: a2aManager as any };
    } catch (error) {
      console.warn(
        '[ServerAgentBootstrap] A2AManager not available for service registration:',
        error
      );
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

      console.log(
        `[ServerAgentBootstrap] Skills initialized, found ${skillRegistry.getSkillMetas().length} skills`
      );
    } catch (error) {
      console.warn(
        '[ServerAgentBootstrap] SkillRegistry not available for service registration:',
        error
      );
    }

    // Track 10: plugin registry. Server v1 wires the globally-reachable
    // slots — skills (the same SkillRegistry the skills service uses) and
    // MCP (the singleton MCPManager). Hooks / agents / commands are
    // per-session (created in agentFactory) and propagate via a documented
    // follow-up; PluginRegistry surfaces them as capability gaps for now.
    let pluginsDeps: import('@/core/services').PluginsServiceDeps | undefined;
    try {
      const path = await import('node:path');
      const { NodePluginProvider } = await import('@/server/storage/NodePluginProvider');
      const { nodeReadFile, nodeListDirs } = await import('@/server/storage/nodePluginFs');
      const { PluginRegistry } = await import('@/core/plugins/PluginRegistry');
      const { SkillSlotLoader } = await import('@/core/plugins/loaders/SkillSlotLoader');
      const { McpSlotLoader } = await import('@/core/plugins/loaders/McpSlotLoader');
      const { AgentConfig } = await import('@/config/AgentConfig');
      const { resolveWorkXHome } = await import('@/runtime/workxHome');
      const workxHome = resolveWorkXHome();

      const pluginsRoot = path.join(workxHome, 'plugins');
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
        mcpSlot: mcpDeps ? new McpSlotLoader(mcpDeps.mcpManager as never) : undefined,
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
            const active = agentSession?.agent?.getSession?.()?.listActiveTasks?.() ?? [];
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
        nodeGitRunner,
        nodeMkTempDir,
        nodeWalkFiles,
        nodeReadBytes,
        nodeRemoveDir,
        nodeResolveHeadSha,
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
        filePath: nodePath.join(workxHome, 'installed_plugins_v2.json'),
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
        (id) => marketplaces.lookup(id)?.entry ?? null
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
              .map(([k]) => k)
          ),
      });

      // review B2/B3: uninstall must orphan-mark (not hard-delete); the
      // 7-day GC sweep removes dirs later. Wire a PluginCache over Node fs.
      const { PluginCache } = await import('@/core/plugins/PluginCache');
      const fsmod = await import('node:fs');
      const pluginCache = new PluginCache(workxHome, {
        readText: async (p: string) => {
          try {
            return await fsmod.promises.readFile(p, 'utf-8');
          } catch {
            return null;
          }
        },
        writeText: async (p: string, c: string) => {
          await fsmod.promises.mkdir(nodePath.dirname(p), {
            recursive: true,
          });
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
      });

      const uninstaller = new PluginUninstaller({
        provider,
        installed: installedStore,
        registry,
        markOrphaned: (installPath: string) => pluginCache.markOrphaned(installPath),
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
                `[ServerAgentBootstrap] autoupdate: ${r.updated.length} updated, ${r.delisted.length} delisted`
              );
            }
          },
          (e) => console.warn('[ServerAgentBootstrap] autoupdate failed:', e)
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
        `[ServerAgentBootstrap] PluginRegistry initialized (${metas.length} plugin(s) discovered)`
      );
    } catch (error) {
      console.warn('[ServerAgentBootstrap] PluginRegistry not available:', error);
    }

    // Track 43: ChatGPT OAuth lives in the runtime after the cutover. The
    // 127.0.0.1:1455 callback HTTP server, the token storage, and the PKCE
    // exchange all happen here; the UI just calls `auth.chatgpt.*` services.
    let chatgptFlow:
      | InstanceType<
          typeof import('@/desktop-runtime/auth/RuntimeChatGPTOAuthFlow').RuntimeChatGPTOAuthFlow
        >
      | undefined;
    let chatgptStorage:
      | InstanceType<
          typeof import('@/desktop-runtime/auth/RuntimeChatGPTOAuthStorage').RuntimeChatGPTOAuthStorage
        >
      | undefined;
    if (profile === 'desktop-runtime') {
      try {
        const { RuntimeChatGPTOAuthFlow } =
          await import('@/desktop-runtime/auth/RuntimeChatGPTOAuthFlow');
        const { RuntimeChatGPTOAuthStorage } =
          await import('@/desktop-runtime/auth/RuntimeChatGPTOAuthStorage');
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
      session: this.registry
        ? {
            registry: this.registry,
            // Resume-from-history support (parity with the extension service
            // worker): without this dep, `session.resume` rejects with
            // "Session resume not supported on this platform" on desktop/server.
            loadRolloutHistory: async (sessionId: string) => {
              const initialHistory = await RolloutRecorder.getRolloutHistory(sessionId);
              if (initialHistory.type !== 'resumed' || !initialHistory.payload?.history)
                return null;
              return { sessionId, rolloutItems: initialHistory.payload.history };
            },
          }
        : undefined,
      agent: this.registry
        ? {
            registry: this.registry,
            handleConfigUpdate: () => this.handleConfigUpdate(),
            runtimeState,
            // Desktop runtime: persist approval config from the Settings picker
            // (approval.updateConfig service) into the runtime's config storage,
            // parity with the extension service worker. Live-session gates are
            // updated by the shared handler in agent-services.
            updateApprovalConfig:
              profile === 'desktop-runtime'
                ? async (config: Record<string, unknown>) => {
                    const { STORAGE_KEYS } = await import('@/config/defaults');
                    const { DEFAULT_APPROVAL_CONFIG } = await import('@/core/approval/types');
                    const storage = getConfigStorage();
                    const agentConfig =
                      (await storage.get<Record<string, any>>(STORAGE_KEYS.CONFIG)) ?? {};
                    const existing = agentConfig.approval ?? { ...DEFAULT_APPROVAL_CONFIG };
                    agentConfig.approval = { ...existing, ...config };
                    await storage.set(STORAGE_KEYS.CONFIG, agentConfig);
                  }
                : undefined,
          }
        : undefined,
      // ChatGPT provider OAuth remains available in OSS. Product-account
      // login is supplied only by private compositions.
      auth:
        profile === 'desktop-runtime' && this.registry
          ? {
              chatgptFlow,
              getChatGPTStorage: chatgptStorage ? () => chatgptStorage! : undefined,
            }
          : undefined,
      diagnostics: {
        buildCtx: () => this.buildDiagnosticContext(),
        heapdump: async () => {
          const { performHeapDump } = await import('../diagnostics/heapdump');
          return performHeapDump();
        },
      },
      memory: this.registry ? { registry: this.registry } : undefined,
      runtime: runtimeState ? { runtimeState } : undefined,
      // Stateless BYOK connection probe plus an optional product catalog seam.
      // OSS returns no catalog loader; product overlays may provide one for the
      // desktop runtime without putting deployment-specific logic here.
      models: {
        getCatalog: profile === 'desktop-runtime'
          ? createRuntimeModelCatalogLoader()
          : undefined,
      },
      // Expose the runtime credential store (OS keychain) to the desktop
      // webview, which cannot reach it directly. Without this, webview-side
      // BYOK API key saves are silently dropped.
      credentials: {},
      apps: appsRuntime
        ? {
            access: appsRuntime.access,
            client: appsRuntime.client,
            authorizeContext: (context) =>
              context.channelType === 'tauri' && context.channelId === 'desktop-runtime-main',
          }
        : undefined,
      dataSources:
        profile === 'desktop-runtime' && this.dataSourceRuntimeHandle
          ? { handle: this.dataSourceRuntimeHandle }
          : undefined,
      components:
        profile === 'desktop-runtime' && this.componentRuntimeHandle
          ? { handle: this.componentRuntimeHandle }
          : undefined,
      preview:
        profile === 'desktop-runtime' && this.registry
          ? {
              registry: this.registry,
              stat: async (workspaceRoot: string, path: string) => {
                const fsExecutor = await import('@/server/tools/fs/NodeFsExecutor');
                return fsExecutor.stat(workspaceRoot, path);
              },
              readFile: async (workspaceRoot: string, path: string) => {
                const fsExecutor = await import('@/server/tools/fs/NodeFsExecutor');
                return fsExecutor.readFile(workspaceRoot, path);
              },
            }
          : undefined,
    });

    console.log(`[ServerAgentBootstrap] Registered ${count} service handlers`);

    await appsRuntime?.access.initialize();

    if (profile === 'desktop-runtime') {
      await this.refreshDesktopRuntimeAccessState();
    }
  }

  private getOrCreateRuntimeState(
    channelManager: ReturnType<typeof getChannelManager>,
    agentConfig: AgentConfig
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

  private async refreshDesktopRuntimeAccessState() {
    if (!this.runtimeState) {
      return undefined;
    }
    const config = await AgentConfig.getInstance();
    const selectedModelKey = config.getConfig().selectedModelKey;
    const selected = config.getModelByKey(selectedModelKey);
    const provider = selected?.provider.name;
    const model = selected?.model.name;
    if (!selected) {
      return this.runtimeState.setAccessState({
        status: 'error',
        mode: 'api_key',
        ready: false,
        reason: `Selected model is unavailable: ${selectedModelKey}`,
      });
    }
    const apiKey = await config.getProviderApiKey(selected.provider.id).catch(() => null);
    return this.runtimeState.setAccessState(
      apiKey
        ? { status: 'ready', mode: 'api_key', ready: true, provider, model }
        : {
            status: 'needs_api_key',
            mode: 'api_key',
            ready: false,
            provider,
            model,
            reason: 'Configure an API key in Settings.',
          }
    );
  }

  private async ensureDesktopRuntimeHubMcpConnected(targetAgent?: RepublicAgent): Promise<void> {
    if ((this.options.profile ?? 'server') !== 'desktop-runtime' || !this.registry) return;

    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const mcpManager = await MCPManager.getInstance('desktop');
      const serverName = this.runtimeState?.getUrls().gatewayMcpName ?? 'gateway';
      const hubServer = mcpManager.getServerByName(serverName);
      if (!hubServer) return;

      if (!this.desktopHubMcpEventHooked) {
        this.desktopHubMcpEventHooked = true;
        mcpManager.on('event', (event) => {
          if (event.type !== 'tools-updated' || event.configId !== hubServer.id) return;
          const config = mcpManager.getServer(event.configId);
          if (!config || config.name !== serverName) return;
          this.registerDesktopHubMcpTools(mcpManager, config.name, event.tools).catch((error) => {
            console.warn('[ServerAgentBootstrap] Failed to update gateway MCP tools:', error);
          });
        });
      }

      const connection = mcpManager.getConnection(hubServer.id);
      if (connection?.status !== 'connected') {
        // MCPManager coalesces concurrent connect calls, so this awaits an
        // existing attempt instead of publishing targetAgent without tools.
        await mcpManager.connect(hubServer.id);
      }

      const connected = mcpManager.getConnection(hubServer.id);
      if (connected?.status === 'connected') {
        await this.registerDesktopHubMcpTools(
          mcpManager,
          hubServer.name,
          connected.tools,
          targetAgent
        );
      }
    } catch (error) {
      console.warn('[ServerAgentBootstrap] Gateway MCP connection unavailable:', error);
    }
  }

  private async registerDesktopHubMcpTools(
    mcpManager: any,
    serverName: string,
    tools: IMCPTool[],
    targetAgent?: RepublicAgent
  ): Promise<void> {
    if (!this.registry) return;
    const { registerMCPTools, unregisterMCPTools } = await import('@/core/mcp/MCPToolAdapter');
    // Hub tools are gateway/browser actions (click, type, navigate…); give
    // them the MCP browser assessor so the approval gate scores them instead
    // of falling back to the unassessed default (20 = silent auto-approve).
    const { McpBrowserRiskAssessor } =
      await import('@/core/approval/assessors/McpBrowserRiskAssessor');
    const hubRiskAssessor = new McpBrowserRiskAssessor();

    const targets: Array<{ sessionId: string; agent: RepublicAgent }> = [];
    for (const meta of this.registry.listSessions()) {
      if (meta.state === 'terminated') continue;
      const agentSession = this.registry.getSession(meta.sessionId);
      if (agentSession?.agent) {
        targets.push({ sessionId: meta.sessionId, agent: agentSession.agent });
      }
    }
    if (targetAgent) {
      const sessionId = targetAgent.getSession().sessionId;
      if (!targets.some((target) => target.sessionId === sessionId)) {
        targets.push({ sessionId, agent: targetAgent });
      }
    }

    for (const target of targets) {
      const toolRegistry = target.agent.getToolRegistry();

      const previousTools = this.desktopHubRegisteredToolsBySession.get(target.sessionId);
      if (previousTools && previousTools.length > 0) {
        await unregisterMCPTools(serverName, previousTools, toolRegistry);
      }

      if (tools.length > 0) {
        await registerMCPTools(mcpManager, serverName, tools, toolRegistry, hubRiskAssessor);
        this.desktopHubRegisteredToolsBySession.set(target.sessionId, tools);
      } else {
        this.desktopHubRegisteredToolsBySession.delete(target.sessionId);
      }
    }
  }

  private async disconnectDesktopRuntimeHubMcp(): Promise<void> {
    if ((this.options.profile ?? 'server') !== 'desktop-runtime' || !this.registry) return;

    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const mcpManager = await MCPManager.getInstance('desktop');
      const serverName = this.runtimeState?.getUrls().gatewayMcpName ?? 'gateway';
      const hubServer = mcpManager.getServerByName(serverName);
      if (!hubServer) return;
      await this.registerDesktopHubMcpTools(mcpManager, hubServer.name, []);
      await mcpManager.disconnect(hubServer.id);
    } catch (error) {
      console.warn('[ServerAgentBootstrap] Failed to disconnect gateway MCP:', error);
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
        (this.options.profile ?? 'server') === 'desktop-runtime' ? 'desktop' : 'server'
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
      lifecycle: this.registry ?? undefined,
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
        if (!this.registry) throw new Error('SessionManager not initialized');
        // A dedicated channel (e.g. the desktop app-server) submits against a
        // real, per-connection session id and owns its own event stream. The
        // primary chat surface instead submits under a connection alias
        // (`ws:main:<connId>`) that is not itself a registry key and maps to the
        // server's primary session.
        const isDedicatedChannel =
          !!context.channelId &&
          context.channelId !== this.primaryChannelId &&
          this.channels.has(context.channelId);
        // Only the aliased primary surface falls back to the primary session.
        // For a dedicated channel an unresolved session must fail loudly rather
        // than silently execute the request against the UI's live conversation.
        const targetSession =
          this.registry.getSession(context.sessionId) ??
          (isDedicatedChannel || !this.defaultSessionId
            ? undefined
            : this.registry.getSession(this.defaultSessionId));
        if (!targetSession?.agent) throw new Error(`Session not found: ${context.sessionId}`);
        // Route this session's agent events back to the originating channel so a
        // dedicated connection receives its own stream (and the UI does not).
        // recordSessionOwner no-ops unless channelId is a registered channel, so
        // the primary-surface alias keeps default primary-channel routing.
        this.recordSessionOwner(context.sessionId, context.channelId);
        // Track 13: derive origin from the chat channel (on-host WS chat maps
        // to `local` and skips the gate; remote/relay maps to `remote`).
        // Return the submission id so callers can surface it as a stable runId.
        return await targetSession.agent.submitOperation(op, {
          tabId: context.tabId,
          origin: deriveInputOrigin(context),
        });
      },
      getHistory: async (sessionKey, options) => {
        if (!this.registry) throw new Error('SessionManager not initialized');
        let targetSessionId: string | null = sessionKey;
        try {
          await this.registry.getThread(sessionKey);
        } catch {
          targetSessionId = this.defaultSessionId;
        }
        if (!targetSessionId) throw new Error(`Session not found: ${sessionKey}`);
        const provider = await RolloutRecorder.getProvider();
        const page = await loadHistoryPage(provider, targetSessionId, options);
        return {
          revision: page.revision,
          items: page.items,
          turns: page.turns,
          nextCursor: page.nextCursor,
        };
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
                    { sessionId: sourceConvId }
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
    registerModelHandlers();

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
  private async initializeConnectors(
    channelManager: ReturnType<typeof getChannelManager>
  ): Promise<void> {
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
            console.log(
              `[ServerAgentBootstrap] Connector bridge registered: ${connector.id}:${accountId}`
            );
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
    const { resolveWorkXHome } = await import('@/runtime/workxHome');
    const workxHome = resolveWorkXHome();

    // Track 24.2: register filesystem persona overrides (user dir lowest,
    // project dir highest precedence; both overlay built-ins), then pin the
    // operator-selected persona from config.json.
    try {
      const { join } = await import('node:path');
      const { scanDiskPersonas } = await import('@/prompts/diskPersonas');
      const { registerExternalPersonas } = await import('@/prompts/PersonaLoader');
      registerExternalPersonas(
        scanDiskPersonas([join(workxHome, 'styles'), join(process.cwd(), '.workx', 'styles')])
      );
    } catch (e) {
      console.warn('[ServerAgentBootstrap] Persona disk scan skipped:', e);
    }

    const isDesktopRuntime = (this.options.profile ?? 'server') === 'desktop-runtime';
    const staticContext: Partial<RuntimeContext> = {
      // Desktop browser access is the WorkX-extension bridge (local_browser_tool),
      // not the parked chrome-devtools-mcp path. The 'bridge' label spells out
      // that the tool exists only while the extension is connected.
      browserConnection: isDesktopRuntime ? 'bridge' : 'none',
      os: process.platform,
      arch: process.arch,
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      homeDir,
      // TODO(track-20): allow a managed-policy key to override this.
      personaName: isDesktopRuntime ? undefined : getServerConfig().server.persona,
    };

    this.promptStaticContext = Object.freeze({ ...staticContext });
    console.log(
      `[ServerAgentBootstrap] Prompt context configured for ${isDesktopRuntime ? 'desktop runtime' : 'server'} mode`
    );
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
        const { DesktopRuntimeSQLiteAdapter } =
          await import('@/desktop-runtime/storage/DesktopRuntimeSQLiteAdapter');
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
        const { RuntimeSchedulerAlarms } =
          await import('@/desktop-runtime/scheduler/RuntimeSchedulerAlarms');
        const { getDesktopRuntimeControlBridge } =
          await import('@/desktop-runtime/protocol/controlBridge');
        this.schedulerAlarms = new RuntimeSchedulerAlarms(
          getDesktopRuntimeControlBridge().scheduler
        ) as unknown as ServerSchedulerAlarms;
      } else {
        this.schedulerAlarms = new ServerSchedulerAlarms();
      }

      // 3. Create new model components directly
      const scheduleManager = new ScheduleManager(
        this.scheduleEventStorage,
        executionStorage,
        this.schedulerAlarms
      );
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
        schedulerTelemetryTap
      );

      // 7. Wire job launcher -> submit job input to agent via registry
      this.scheduler.setJobLauncher(async (executionId, sessionId, registryAgent) => {
        console.log(
          `[ServerAgentBootstrap] Scheduled job ${executionId} launched (session: ${sessionId})`
        );
        const execution = await executionStorage.getExecution(executionId);
        if (!execution) {
          throw new Error(`Execution not found: ${executionId}`);
        }

        if (!registryAgent || !this.registry) {
          throw new Error('No agent available — cannot execute scheduled job');
        }

        const ack = await this.registry.enqueueSubmission({
          sessionId,
          clientMessageId: `scheduler:${executionId}`,
          op: {
            type: 'UserInput',
            items: [{ type: 'text', text: execution.input }],
          },
          // Scheduled jobs are unattended on two orthogonal axes:
          //  - Track 13 origin `scheduler`: a failed mention/capability
          //    degrades via systemNote, never aborts the turn.
          //  - Track 12 unattended: wait out 429/529 instead of
          //    hard-failing into scheduler.failJob() with no human.
          context: { origin: { channel: 'scheduler' }, unattended: true },
        });
        if (ack.status === 'rejected') {
          throw new Error(`Scheduled job submission rejected: ${ack.reason}`);
        }
        this.runningSchedulerJobId = executionId;
        this.runningJobStartTime = Date.now();
      });

      // 7a. Connectivity check — ensure registry is initialized before executing jobs
      this.scheduler.setConnectivityCheck(() => this.registry !== null && this.initialized);

      // 7b. Wire registry for session isolation in scheduled jobs
      if (this.registry) {
        this.scheduler.setRegistry(this.registry);
        console.log('[ServerAgentBootstrap] SessionManager wired for scheduler session isolation');
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
      this.scheduler
        .completeJob(jobId, {
          summary,
          tokenUsage: {
            inputTokens: tokenData?.input_tokens ?? 0,
            outputTokens: tokenData?.output_tokens ?? 0,
            totalTokens: tokenData?.total_tokens ?? 0,
          },
          duration,
          costUSD: jobCostUSD,
          costEstimated: jobCostEstimated,
        })
        .then(() => {
          // Track 18: post-hoc budget enforcement (blocks subsequent jobs;
          // never throws into a running turn).
          return this.enforceBudgetCaps(jobId, jobCostUSD, jobCostEstimated);
        })
        .catch((error) => {
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
    jobCostEstimated: boolean
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
        const todays = await this.executionRecordStorage.getExecutionsInRange(startOfDayUTC, now);
        const dayTotalUSD = (todays as Array<{ result?: { costUSD?: number } }>).reduce(
          (sum: number, e) => sum + (e.result?.costUSD ?? 0),
          0
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

  getRegistry(): SessionManager | null {
    return this.registry;
  }

  /** The headless A2A server, if enabled (FR-6). Null when disabled. */
  getA2AServer(): A2AServer | null {
    return this.a2aServer;
  }

  // ─────────────────────────────────────────────────────────────────────
  // A2A delegation bridge (FR-6)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Build the bridge that routes A2A `message/send` requests into the local
   * agent's turn loop. Turns run on the primary session (single-tenant
   * appliance, D4) and are serialized so concurrent delegations don't collide.
   */
  private buildA2ABridge(): A2AAgentBridge {
    return {
      runTurn: (params) => {
        // Serialize: chain each turn after the previous one settles.
        const run = this.a2aTurnChain.then(
          () => this.runA2ATurn(params),
          () => this.runA2ATurn(params)
        );
        this.a2aTurnChain = run.catch(() => undefined);
        return run;
      },
      listToolNames: () => {
        const registry =
          this.registry && this.defaultSessionId
            ? this.registry.getSession(this.defaultSessionId)?.agent?.getToolRegistry()
            : undefined;
        if (!registry) return [];
        try {
          return registry
            .listTools()
            .map(toolDefinitionName)
            .filter((name): name is string => !!name);
        } catch {
          return [];
        }
      },
    };
  }

  /** Run a single delegated turn and resolve with the final assistant text. */
  private async runA2ATurn(params: {
    text: string;
    contextId: string;
    taskId: string;
    signal: AbortSignal;
  }): Promise<A2ATurnResult> {
    const { text, signal } = params;
    if (!this.registry) {
      return {
        text: '',
        success: false,
        error: 'Agent registry not initialized',
      };
    }

    let session = this.defaultSessionId
      ? this.registry.getSession(this.defaultSessionId)
      : undefined;
    if (!session || session.state === 'terminated') {
      session = await this.registry.createSession({ type: 'primary' });
      this.defaultSessionId = session.sessionId;
    }
    const sessionId = session.sessionId;

    const op: Op = {
      type: 'UserTurn',
      items: [{ type: 'text', text }],
      tabId: 0,
      // Headless delegation has no human to answer approval prompts, so the
      // turn must run non-interactively. Single-tenant appliance only (D4).
      approval_policy: 'never',
      sandbox_policy: { mode: 'danger-full-access' },
      model: 'default',
      summary: { enabled: true },
    };

    return await new Promise<A2ATurnResult>((resolve) => {
      let settled = false;
      let submissionId: string | undefined;

      const finish = (result: A2ATurnResult): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(result);
      };

      const unsubscribe = this.a2aEventTap.on(sessionId, (msg) => {
        // Wait until our submission id is known before matching terminal events.
        // Real turns take far longer to complete than submit() takes to resolve,
        // so nothing is missed by ignoring events in that brief window.
        if (submissionId === undefined) return;
        // Resolve on TaskComplete (success) or TurnAborted (cancel / abort /
        // error-reason), both correlated by submission_id. See interpretTurnEvent.
        const outcome = interpretTurnEvent(msg, submissionId);
        if (outcome) finish(outcome);
      });

      if (signal.aborted) {
        finish({ text: '', success: false, error: 'aborted' });
        return;
      }
      signal.addEventListener('abort', () => {
        session.agent?.submitOperation({ type: 'Interrupt' }, {}).catch(() => undefined);
      });

      const timer = setTimeout(() => {
        finish({ text: '', success: false, error: 'A2A turn timed out' });
      }, A2A_TURN_TIMEOUT_MS);

      session.submit(op).then(
        (id) => {
          submissionId = id;
        },
        (err) =>
          finish({
            text: '',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          })
      );
    });
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

    if (this.dataSourceRuntimeHandle) {
      this.dataSourceRuntimeHandle.markStopping();
      await this.dataSourceRuntimeHandle
        .getRuntime()
        ?.dispose()
        .catch((error) => {
          console.warn('[ServerAgentBootstrap] Data-source shutdown failed:', error);
        });
      this.dataSourceRuntimeHandle = null;
    }

    if (this.componentRuntimeHandle) {
      this.componentRuntimeHandle.markStopping();
      await this.componentRuntime?.dispose().catch((error) => {
        console.warn('[ServerAgentBootstrap] Component runtime shutdown failed:', error);
      });
      this.componentRuntime = null;
      this.componentRuntimeHandle = null;
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
    this.defaultSessionId = null;
    this.initialized = false;
    console.log('[ServerAgentBootstrap] Shutdown complete');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// A2A helpers (FR-6)
// ─────────────────────────────────────────────────────────────────────────

/** Max wall-clock for a single delegated A2A turn before it is failed. */
const A2A_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** Whether the headless A2A endpoint is opt-in enabled. */
function isA2AEnabled(): boolean {
  const flag = process.env.WORKX_SERVER_A2A_ENABLED;
  return flag === '1' || flag === 'true';
}

/** Build the agent-card identity from env, defaulting to the local server. */
function buildA2AIdentity(): {
  name: string;
  description: string;
  version: string;
  url: string;
} {
  const port = process.env.WORKX_SERVER_PORT ?? '18100';
  const base = (process.env.WORKX_SERVER_PUBLIC_URL ?? `http://localhost:${port}`).replace(
    /\/$/,
    ''
  );
  return {
    name: process.env.WORKX_SERVER_A2A_NAME ?? 'WorkX Agent',
    description:
      process.env.WORKX_SERVER_A2A_DESCRIPTION ??
      'Headless WorkX agent. Delegate natural-language tasks via A2A message/send.',
    version: process.env.WORKX_SERVER_A2A_VERSION ?? '1.0.0',
    // The agent card is served at /.well-known/agent-card.json; this is the
    // JSON-RPC endpoint the client POSTs to (see A2A_RPC_PATH in server/index).
    url: `${base}${A2A_RPC_PATH}`,
  };
}

/** Path of the A2A JSON-RPC endpoint (also referenced by server/index.ts). */
export const A2A_RPC_PATH = '/a2a';
/** Path of the A2A agent-card discovery document. */
export const A2A_CARD_PATH = '/.well-known/agent-card.json';

/** Extract a tool's name from the ToolDefinition union, if it has one. */
function toolDefinitionName(def: ToolDefinition): string | null {
  switch (def.type) {
    case 'function':
      return def.function?.name ?? null;
    case 'custom':
      return def.custom?.name ?? null;
    case 'local_shell':
      return 'local_shell';
    case 'web_search':
      return 'web_search';
    default:
      return null;
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
